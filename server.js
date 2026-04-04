// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v4.4
// Account : Nick Verschoot — FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ───────────────────────────────────────────────────────────────
// SESSIES (Brussels — automatisch zomer/wintertijd):
//   asia      → 02:00–08:00
//   london    → 08:00–15:30
//   ny        → 15:30–20:00
//
// WIJZIGINGEN v4.4 (t.o.v. v4.3):
//  ✅ [FIX] Dashboard: volledige HTML met live data + navigatie-links
//           → /dashboard geeft nu echte UI ipv JSON stub
//  ✅ [FIX] FTMO dagelijkse verlies-limiet UITGESCHAKELD
//           → Alle trades worden doorgelaten, geen dagcap blokkering
//  ✅ [FIX] app.listen() toegevoegd — server bindt nu aan PORT
//           → Railway "Application failed to respond" opgelost
// WIJZIGINGEN v4.3 (t.o.v. v4.2):
//  ✅ [FIX] Min lot cap = baseRisk per type, niet vaste €60
//  ✅ [FIX] Restart recovery: openPositions her-initialiseren vanuit MT5
//  ✅ [FEAT] Forex consolidatie: half risk bij 1–2 open, blok bij ≥3
//  ✅ Spread guard: max 1/3 van SL-afstand (was 1/2)
//  ✅ Ghost tracker: prioriteit batching (recent 60s, oud >6u = 5min)
//  ✅ DB sessie fix: trades zonder sessie herberekend op openedAt
// ═══════════════════════════════════════════════════════════════

"use strict";

const express = require("express");
const cron    = require("node-cron");
const app     = express();
app.use(express.json());

const {
  initDB, saveTrade, loadAllTrades, saveSnapshot, loadSnapshots,
  loadTPConfig, saveTPConfig, logTPUpdate, loadTPUpdateLog,
  loadSLConfig, saveSLConfig, logSLUpdate, loadSLUpdateLog,
  logForexConsolidation,
} = require("./db");

const {
  getBrusselsComponents,
  getBrusselsDateStr,
  getSessionGMT1,
  isMarketOpen: isMarketOpenFn,
  SESSION_LABELS,
} = require("./session");

// ── CONFIG ────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "FtmoNV2025";
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || "10000");

const GHOST_DURATION_MS        = 24 * 3600 * 1000;
const GHOST_INTERVAL_RECENT_MS = 60 * 1000;
const GHOST_INTERVAL_OLD_MS    = 5 * 60 * 1000;
const GHOST_OLD_THRESHOLD_MS   = 6 * 3600 * 1000;

// ── RR / SL LEVELS ────────────────────────────────────────────
const RR_LEVELS    = [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25];
const SL_MULTIPLES = [0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

const SL_PROVEN_MULT            = 0.5;
const STOCK_SL_SPREAD_MULT      = 1.5;
const STOCK_MAX_SPREAD_FRACTION = 0.333;

const FOREX_MAX_SAME_DIR        = 3;
const FOREX_HALF_RISK_THRESHOLD = 1;

// ── RISICO PER TYPE ───────────────────────────────────────────
const RISK = {
  index:  parseFloat(process.env.RISK_INDEX  || "200"),
  forex:  parseFloat(process.env.RISK_FOREX  || "15"),
  gold:   parseFloat(process.env.RISK_GOLD   || "30"),
  brent:  parseFloat(process.env.RISK_BRENT  || "30"),
  wti:    parseFloat(process.env.RISK_WTI    || "30"),
  crypto: parseFloat(process.env.RISK_CRYPTO || "30"),
  stock:  parseFloat(process.env.RISK_STOCK  || "30"),
};

const RISK_MINLOT_CAP   = parseFloat(process.env.RISK_MINLOT_CAP || "60");
const TP_LOCK_RISK_MULT = 4;

// [v4.4] FTMO dagelijkse verlies-limiet UITGESCHAKELD
function resetDailyLossIfNewDay() {}
function ftmoSafetyCheck(_r) { return { ok: true }; }
function registerFtmoLoss(_r) {}

// ── IN-MEMORY STORES ──────────────────────────────────────────
const openTradeTracker = {};
const openPositions    = {};
const closedTrades     = [];
const accountSnapshots = [];
const webhookHistory   = [];
const ghostTrackers    = {};

// ── TP / SL LOCK CONFIG ───────────────────────────────────────
const TP_LOCK_THRESHOLD  = 10;
const TP_UPDATE_INTERVAL = 10;
const SL_LOCK_THRESHOLD  = 10;
const SL_UPDATE_INTERVAL = 10;

const tpLocks     = {};
const slLocks     = {};
const tpUpdateLog = [];
const slUpdateLog = [];
const MAX_TP_LOG  = 100;
const MAX_SL_LOG  = 100;

const MAX_SNAPSHOTS = 86400;
const MAX_HISTORY   = 200;

const TRADING_SESSIONS = ["asia", "london", "ny"];

function addWebhookHistory(entry) {
  webhookHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.length = MAX_HISTORY;
}

const learnedPatches = {};

// ══════════════════════════════════════════════════════════════
// SYMBOL MAP
// ══════════════════════════════════════════════════════════════
const SYMBOL_MAP = {
  // ── Indices ──────────────────────────────────────────────
  "DE30EUR":     { mt5: "GER40.cash",  type: "index" },
  "UK100GBP":    { mt5: "UK100.cash",  type: "index" },
  "NAS100USD":   { mt5: "US100.cash",  type: "index" },
  "US30USD":     { mt5: "US30.cash",   type: "index" },
  "SPX500USD":   { mt5: "US500.cash",  type: "index" },
  "JP225USD":    { mt5: "JP225.cash",  type: "index" },
  "AU200AUD":    { mt5: "AUS200.cash", type: "index" },
  "EU50EUR":     { mt5: "EU50.cash",   type: "index" },
  "FR40EUR":     { mt5: "FRA40.cash",  type: "index" },
  "HK33HKD":     { mt5: "HK50.cash",   type: "index" },
  "US2000USD":   { mt5: "US2000.cash", type: "index" },
  "ESPIXEUR":    { mt5: "SPN35.cash",  type: "index" },
  "NL25EUR":     { mt5: "NL25.cash",   type: "index" },
  "GER40":       { mt5: "GER40.cash",  type: "index" },
  "GER40.cash":  { mt5: "GER40.cash",  type: "index" },
  "UK100":       { mt5: "UK100.cash",  type: "index" },
  "UK100.cash":  { mt5: "UK100.cash",  type: "index" },
  "NAS100":      { mt5: "US100.cash",  type: "index" },
  "US100":       { mt5: "US100.cash",  type: "index" },
  "US100.cash":  { mt5: "US100.cash",  type: "index" },
  "US30":        { mt5: "US30.cash",   type: "index" },
  "US30.cash":   { mt5: "US30.cash",   type: "index" },
  "SPX500":      { mt5: "US500.cash",  type: "index" },
  "US500":       { mt5: "US500.cash",  type: "index" },
  "US500.cash":  { mt5: "US500.cash",  type: "index" },
  "JP225":       { mt5: "JP225.cash",  type: "index" },
  "JP225.cash":  { mt5: "JP225.cash",  type: "index" },
  "AU200":       { mt5: "AUS200.cash", type: "index" },
  "AUS200":      { mt5: "AUS200.cash", type: "index" },
  "AUS200.cash": { mt5: "AUS200.cash", type: "index" },
  "EU50":        { mt5: "EU50.cash",   type: "index" },
  "EU50.cash":   { mt5: "EU50.cash",   type: "index" },
  "FR40":        { mt5: "FRA40.cash",  type: "index" },
  "FRA40":       { mt5: "FRA40.cash",  type: "index" },
  "FRA40.cash":  { mt5: "FRA40.cash",  type: "index" },
  "HK50":        { mt5: "HK50.cash",   type: "index" },
  "HK50.cash":   { mt5: "HK50.cash",   type: "index" },
  "US2000":      { mt5: "US2000.cash", type: "index" },
  "US2000.cash": { mt5: "US2000.cash", type: "index" },
  "SPN35":       { mt5: "SPN35.cash",  type: "index" },
  "SPN35.cash":  { mt5: "SPN35.cash",  type: "index" },
  "NL25":        { mt5: "NL25.cash",   type: "index" },
  "NL25.cash":   { mt5: "NL25.cash",   type: "index" },

  // ── Grondstoffen / Crypto ─────────────────────────────────
  "XAUUSD":      { mt5: "XAUUSD",      type: "gold"   },
  "GOLD":        { mt5: "XAUUSD",      type: "gold"   },
  "UKOIL":       { mt5: "UKOIL.cash",  type: "brent"  },
  "UKOIL.cash":  { mt5: "UKOIL.cash",  type: "brent"  },
  "USOIL":       { mt5: "USOIL.cash",  type: "wti"    },
  "USOIL.cash":  { mt5: "USOIL.cash",  type: "wti"    },
  "BTCUSD":      { mt5: "BTCUSD",      type: "crypto" },
  "ETHUSD":      { mt5: "ETHUSD",      type: "crypto" },

  // ── Aandelen ──────────────────────────────────────────────
  "AAPL":  { mt5: "AAPL",  type: "stock" },
  "TSLA":  { mt5: "TSLA",  type: "stock" },
  "MSFT":  { mt5: "MSFT",  type: "stock" },
  "NVDA":  { mt5: "NVDA",  type: "stock" },
  "AMD":   { mt5: "AMD",   type: "stock" },
  "NFLX":  { mt5: "NFLX",  type: "stock" },
  "AMZN":  { mt5: "AMZN",  type: "stock" },
  "GOOGL": { mt5: "GOOG",  type: "stock" },
  "PLTR":  { mt5: "PLTR",  type: "stock" },
  "CVX":   { mt5: "CVX",   type: "stock" },
  "ASML":  { mt5: "ASML",  type: "stock" },
  "AVGO":  { mt5: "AVGO",  type: "stock" },
  "AZN":   { mt5: "AZN",   type: "stock" },
  "BA":    { mt5: "BA",    type: "stock" },
  "BABA":  { mt5: "BABA",  type: "stock" },
  "DIS":   { mt5: "DIS",   type: "stock" },
  "INTC":  { mt5: "INTC",  type: "stock" },
  "V":     { mt5: "V",     type: "stock" },
  "IBM":   { mt5: "IBM",   type: "stock" },
  "FDX":   { mt5: "FDX",   type: "stock" },
  "KO":    { mt5: "KO",    type: "stock" },
  "BAC":   { mt5: "BAC",   type: "stock" },
  "CSCO":  { mt5: "CSCO",  type: "stock" },
  "GE":    { mt5: "GE",    type: "stock" },
  "GM":    { mt5: "GM",    type: "stock" },
  "GME":   { mt5: "GME",   type: "stock" },
  "JNJ":   { mt5: "JNJ",   type: "stock" },
  "JPM":   { mt5: "JPM",   type: "stock" },
  "LMT":   { mt5: "LMT",   type: "stock" },
  "MCD":   { mt5: "MCD",   type: "stock" },
  "META":  { mt5: "META",  type: "stock" },
  "MSTR":  { mt5: "MSTR",  type: "stock" },
  "NIKE":  { mt5: "NKE",   type: "stock" },
  "PFE":   { mt5: "PFE",   type: "stock" },
  "QCOM":  { mt5: "QCOM",  type: "stock" },
  "RACE":  { mt5: "RACE",  type: "stock" },
  "SBUX":  { mt5: "SBUX",  type: "stock" },
  "SNOW":  { mt5: "SNOW",  type: "stock" },
  "T":     { mt5: "T",     type: "stock" },
  "WMT":   { mt5: "WMT",   type: "stock" },
  "XOM":   { mt5: "XOM",   type: "stock" },
  "ZM":    { mt5: "ZM",    type: "stock" },

  // ── Forex ─────────────────────────────────────────────────
  "EURUSD": { mt5: "EURUSD", type: "forex" },
  "GBPUSD": { mt5: "GBPUSD", type: "forex" },
  "USDJPY": { mt5: "USDJPY", type: "forex" },
  "USDCHF": { mt5: "USDCHF", type: "forex" },
  "USDCAD": { mt5: "USDCAD", type: "forex" },
  "AUDUSD": { mt5: "AUDUSD", type: "forex" },
  "NZDUSD": { mt5: "NZDUSD", type: "forex" },
  "EURGBP": { mt5: "EURGBP", type: "forex" },
  "EURJPY": { mt5: "EURJPY", type: "forex" },
  "EURCHF": { mt5: "EURCHF", type: "forex" },
  "EURAUD": { mt5: "EURAUD", type: "forex" },
  "EURCAD": { mt5: "EURCAD", type: "forex" },
  "GBPJPY": { mt5: "GBPJPY", type: "forex" },
  "GBPCHF": { mt5: "GBPCHF", type: "forex" },
  "GBPAUD": { mt5: "GBPAUD", type: "forex" },
  "GBPCAD": { mt5: "GBPCAD", type: "forex" },
  "AUDJPY": { mt5: "AUDJPY", type: "forex" },
  "AUDCAD": { mt5: "AUDCAD", type: "forex" },
  "AUDCHF": { mt5: "AUDCHF", type: "forex" },
  "AUDNZD": { mt5: "AUDNZD", type: "forex" },
  "CADJPY": { mt5: "CADJPY", type: "forex" },
  "CADCHF": { mt5: "CADCHF", type: "forex" },
  "NZDJPY": { mt5: "NZDJPY", type: "forex" },
  "NZDCAD": { mt5: "NZDCAD", type: "forex" },
  "NZDCHF": { mt5: "NZDCHF", type: "forex" },
  "CHFJPY": { mt5: "CHFJPY", type: "forex" },
};

// ── LOT / STOP CONFIG ─────────────────────────────────────────
const LOT_VALUE = { index:20, gold:100, brent:10, wti:10, crypto:1, stock:1, forex:10 };
const MAX_LOTS  = { index:10, gold:1,   brent:5,  wti:5,  crypto:1, stock:50, forex:0.25 };

const MIN_STOP_INDEX = {
  "GER40.cash":  10,
  "UK100.cash":   5,
  "US100.cash":  10,
  "US30.cash":   10,
  "US500.cash":   5,
  "JP225.cash":  10,
  "AUS200.cash":  5,
  "EU50.cash":    5,
  "FRA40.cash":   5,
  "HK50.cash":   10,
  "US2000.cash":  5,
  "SPN35.cash":   5,
  "NL25.cash":    5,
};

const MIN_STOP_COMMODITY = {
  "XAUUSD":      1.0,
  "UKOIL.cash":  0.05,
  "USOIL.cash":  0.05,
  "BTCUSD":    100.0,
  "ETHUSD":      5.0,
};

const MIN_STOP_FOREX = {
  "EURUSD": 0.0005, "GBPUSD": 0.0005, "AUDUSD": 0.0005,
  "NZDUSD": 0.0005, "USDCHF": 0.0005, "USDCAD": 0.0005,
  "EURGBP": 0.0005, "EURAUD": 0.0005, "EURCAD": 0.0005,
  "EURCHF": 0.0005, "GBPAUD": 0.0005, "GBPCAD": 0.0005,
  "GBPCHF": 0.0005, "AUDCAD": 0.0005, "AUDCHF": 0.0005,
  "AUDNZD": 0.0005, "CADCHF": 0.0005, "NZDCAD": 0.0005,
  "NZDCHF": 0.0005,
  "USDJPY": 0.05, "EURJPY": 0.05, "GBPJPY": 0.05,
  "AUDJPY": 0.05, "CADJPY": 0.05, "NZDJPY": 0.05, "CHFJPY": 0.05,
};

const MIN_STOP_STOCK_PCT = 0.001;

function getMinStop(mt5Symbol, type, entryPrice = 0) {
  if (type === "stock")  return Math.max(0.01, entryPrice * MIN_STOP_STOCK_PCT);
  if (type === "index")  return MIN_STOP_INDEX[mt5Symbol]     ?? 5;
  if (type === "gold")   return MIN_STOP_COMMODITY[mt5Symbol] ?? 1.0;
  if (type === "brent")  return MIN_STOP_COMMODITY[mt5Symbol] ?? 0.05;
  if (type === "wti")    return MIN_STOP_COMMODITY[mt5Symbol] ?? 0.05;
  if (type === "crypto") return MIN_STOP_COMMODITY[mt5Symbol] ?? 100;
  if (type === "forex")  return MIN_STOP_FOREX[mt5Symbol]     ?? 0.0005;
  return 0.01;
}

const WEEKEND_ALLOWED = new Set(["BTCUSD","ETHUSD"]);
function isCryptoWeekend(sym) {
  return WEEKEND_ALLOWED.has(sym) || ["BTC","ETH"].some(c => sym.startsWith(c));
}

function getMT5Symbol(sym) {
  if (learnedPatches[sym]?.mt5Override) return learnedPatches[sym].mt5Override;
  return SYMBOL_MAP[sym]?.mt5 ?? sym;
}

function getSymbolType(sym) {
  if (SYMBOL_MAP[sym]) return SYMBOL_MAP[sym].type;
  if (["BTC","ETH"].some(c => sym.startsWith(c))) return "crypto";
  return "stock";
}

function isMarketOpen(type, symbol) {
  return isMarketOpenFn(type, symbol, isCryptoWeekend);
}

// ── METAAPI ───────────────────────────────────────────────────
const META_BASE = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

async function fetchOpenPositions() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${META_BASE}/positions`, { headers: {"auth-token": META_API_TOKEN}, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`positions ${r.status}`);
    return r.json();
  } catch(e) { clearTimeout(t); throw e; }
}

async function fetchAccountInfo() {
  const r = await fetch(`${META_BASE}/accountInformation`, { headers: {"auth-token": META_API_TOKEN} });
  if (!r.ok) throw new Error(`accountInfo ${r.status}`);
  return r.json();
}

async function closePosition(id) {
  const r = await fetch(`${META_BASE}/positions/${id}/close`, {
    method: "POST",
    headers: {"Content-Type":"application/json","auth-token":META_API_TOKEN},
  });
  return r.json();
}

async function fetchCurrentPrice(mt5Symbol) {
  try {
    const r = await fetch(
      `${META_BASE}/symbols/${encodeURIComponent(mt5Symbol)}/currentPrice`,
      { headers: {"auth-token": META_API_TOKEN} }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const bid  = data.bid ?? null;
    const ask  = data.ask ?? null;
    if (bid !== null && ask !== null) return { mid: (bid + ask) / 2, spread: ask - bid, bid, ask };
    const mid = bid ?? ask ?? null;
    return mid !== null ? { mid, spread: 0, bid: mid, ask: mid } : null;
  } catch (e) {
    console.warn(`⚠️ fetchCurrentPrice(${mt5Symbol}):`, e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// AUTO-CLOSE 20:50 Brussels
// ══════════════════════════════════════════════════════════════
cron.schedule("50 20 * * *", async () => {
  const { day } = getBrusselsComponents();
  const isWE    = day === 0 || day === 6;
  console.log("🔔 20:50 Brussels — auto-close gestart...");
  try {
    const positions = await fetchOpenPositions();
    if (!Array.isArray(positions) || !positions.length) return;
    for (const pos of positions) {
      const tvSym = Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k].mt5 === pos.symbol) || pos.symbol;
      if (isWE && getSymbolType(tvSym) === "crypto" && isCryptoWeekend(tvSym)) {
        console.log(`⏭️  Weekend crypto ${pos.symbol} — niet gesloten`);
        continue;
      }
      try {
        await closePosition(pos.id);
        console.log(`✅ Auto-close: ${pos.symbol}`);
        addWebhookHistory({ type:"AUTOCLOSE_2050", symbol:pos.symbol, positionId:pos.id });
      } catch (e) { console.error(`❌ Auto-close ${pos.symbol}:`, e.message); }
    }
  } catch (e) { console.error("❌ Auto-close fout:", e.message); }
}, { timezone: "Europe/Brussels" });

// ══════════════════════════════════════════════════════════════
// NIGHTLY TP OPTIMIZER — 03:00 Brussels
// ══════════════════════════════════════════════════════════════
cron.schedule("0 3 * * *", async () => {
  console.log("🌙 03:00 Brussels — nightly TP optimizer...");
  const symbols = [...new Set(closedTrades.map(t => t.symbol).filter(Boolean))];
  for (const sym of symbols) {
    await runTPLockEngine(sym).catch(e => console.error(`❌ [TP nightly] ${sym}:`, e.message));
  }
  console.log(`✅ Nightly TP optimizer klaar — ${symbols.length} symbolen verwerkt`);
}, { timezone: "Europe/Brussels" });

// ══════════════════════════════════════════════════════════════
// RESTART RECOVERY
// ══════════════════════════════════════════════════════════════
async function restoreOpenPositionsFromMT5() {
  try {
    const live = await fetchOpenPositions();
    if (!Array.isArray(live) || !live.length) {
      console.log("🔄 [Restart Recovery] Geen open MT5 posities gevonden.");
      return;
    }
    let restored = 0;
    for (const pos of live) {
      const id = String(pos.id);
      if (openPositions[id]) continue;

      const tvSym   = Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k].mt5 === pos.symbol) || pos.symbol;
      const direction = pos.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
      const entry     = pos.openPrice ?? pos.currentPrice ?? 0;
      const sl        = pos.stopLoss  ?? 0;
      const tp        = pos.takeProfit ?? null;
      const lots      = pos.volume    ?? 0.01;
      const type      = getSymbolType(tvSym);
      const session   = getSessionGMT1(pos.time ? new Date(pos.time) : null);

      openPositions[id] = {
        id,
        symbol:     tvSym,
        mt5Symbol:  pos.symbol,
        direction,
        entry,
        sl,
        tp,
        lots,
        riskEUR:    RISK[type] ?? 30,
        openedAt:   pos.time ?? new Date().toISOString(),
        session,
        sessionLabel: SESSION_LABELS[session] || session,
        maxPrice:   entry,
        maxRR:      0,
        currentPnL: pos.unrealizedProfit ?? pos.profit ?? 0,
        lastSync:   null,
        slMultiplierApplied: 1.0,
        spreadGuard: false,
        restoredAfterRestart: true,
      };

      incrementTracker(tvSym, direction);
      restored++;
      console.log(`🔄 [Restart Recovery] ${tvSym} (${direction}) id=${id} entry=${entry} sl=${sl}`);
    }
    console.log(`✅ [Restart Recovery] ${restored} positie(s) hersteld van MT5`);
  } catch (e) {
    console.warn("⚠️ [Restart Recovery] Mislukt:", e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// FOREX ANTI-CONSOLIDATIE
// ══════════════════════════════════════════════════════════════
function checkForexConsolidation(symbol, direction) {
  const mt5Sym = getMT5Symbol(symbol);
  let count = 0;
  for (const pos of Object.values(openPositions)) {
    const posMt5 = getMT5Symbol(pos.symbol) || pos.mt5Symbol;
    if ((posMt5 === mt5Sym || pos.symbol === symbol) && pos.direction === direction) {
      count++;
    }
  }
  return {
    blocked:  count >= FOREX_MAX_SAME_DIR,
    halfRisk: count >= FOREX_HALF_RISK_THRESHOLD && count < FOREX_MAX_SAME_DIR,
    count,
  };
}

// ── SPREAD GUARD ──────────────────────────────────────────────
function checkSpreadGuard(spread, entryNum, slNum) {
  const slDist    = Math.abs(entryNum - slNum);
  const maxSpread = slDist * STOCK_MAX_SPREAD_FRACTION;
  return {
    ok:         spread <= maxSpread,
    spreadPct:  slDist > 0 ? parseFloat((spread / slDist * 100).toFixed(1)) : 0,
    maxAllowed: maxSpread,
    slDist,
  };
}

// ── HELPERS ───────────────────────────────────────────────────
function getEffectiveRisk(symbol, direction) {
  const key    = `${symbol}_${direction}`;
  const count  = openTradeTracker[key] || 0;
  const base   = RISK[getSymbolType(symbol)] || 30;
  let risk     = Math.max(base * 0.10, base / Math.pow(2, count));

  const curSess = getSessionGMT1();
  const lockKey = `${symbol}__${curSess}`;
  const lock    = tpLocks[lockKey];
  if (lock && (lock.evAtLock ?? 0) > 0 && count === 0) {
    risk = Math.min(risk * TP_LOCK_RISK_MULT, base * TP_LOCK_RISK_MULT);
    console.log(`💥 [TP Lock] Risk boost ${symbol}/${curSess}: €${risk.toFixed(2)} (×${TP_LOCK_RISK_MULT} | EV +${lock.evAtLock}R)`);
  }
  return risk;
}

function incrementTracker(sym, dir) { const k=`${sym}_${dir}`; openTradeTracker[k]=(openTradeTracker[k]||0)+1; }
function decrementTracker(sym, dir) { const k=`${sym}_${dir}`; if (openTradeTracker[k]>0) openTradeTracker[k]--; }

function validateSL(dir, entry, sl, mt5Sym, type) {
  const minD = getMinStop(mt5Sym, type, entry);
  let dist   = Math.abs(entry - sl);

  if (type === "stock") {
    const requiredDist = Math.max(dist, minD) * STOCK_SL_SPREAD_MULT;
    const newSl = dir === "buy" ? entry - requiredDist : entry + requiredDist;
    console.log(`📐 [SL Stock] ${mt5Sym}: SL afstand ${dist.toFixed(4)} → ${requiredDist.toFixed(4)} (×${STOCK_SL_SPREAD_MULT})`);
    return parseFloat(newSl.toFixed(5));
  }

  if (dist < minD) {
    const adj = dir==="buy" ? entry-minD : entry+minD;
    console.warn(`⚠️ SL te dicht (${dist.toFixed(5)} < min ${minD}) → ${adj}`);
    return parseFloat(adj.toFixed(5));
  }
  return sl;
}

function calcLots(symbol, entry, sl, risk) {
  const type    = getSymbolType(symbol);
  const lotVal  = LOT_VALUE[type]  || 1;
  const maxLots = MAX_LOTS[type]   || 50;
  const lotStep = learnedPatches[symbol]?.lotStepOverride || (type==="stock" ? 1 : 0.01);
  const dist    = Math.abs(entry - sl);
  if (dist <= 0) return lotStep;

  let lots = Math.floor((risk / (dist * lotVal)) / lotStep) * lotStep;
  lots     = Math.min(lots, maxLots);
  lots     = Math.max(lots, lotStep);

  const minCost = lots * dist * lotVal;

  const baseRisk      = RISK[type] || 30;
  const isTPLockRisk  = risk >= baseRisk * TP_LOCK_RISK_MULT;
  const effectiveCap  = isTPLockRisk
    ? baseRisk * TP_LOCK_RISK_MULT
    : baseRisk;

  if (minCost > effectiveCap) {
    console.warn(`⚠️ Min lot kost €${minCost.toFixed(2)} > cap €${effectiveCap} (${type} ${isTPLockRisk ? "TP lock ×4" : "normaal"}) → skip`);
    return null;
  }
  return parseFloat(lots.toFixed(2));
}

function calcMaxRR(trade) {
  const { direction, entry, sl, maxPrice } = trade;
  const d = Math.abs(entry - sl);
  if (!d || !maxPrice) return 0;
  const fav = direction==="buy" ? maxPrice-entry : entry-maxPrice;
  return parseFloat((Math.max(0, fav) / d).toFixed(2));
}

function calcMaxRRFromPrice(trade, price) {
  const d = Math.abs(trade.entry - trade.sl);
  if (!d || price == null) return 0;
  const fav = trade.direction==="buy" ? price-trade.entry : trade.entry-price;
  return parseFloat((Math.max(0, fav) / d).toFixed(2));
}

function getBestRR(trade) {
  return trade.trueMaxRR ?? trade.maxRR ?? 0;
}

// ── SL ANALYSE HELPER ─────────────────────────────────────────
function buildSLAnalysis(trades) {
  return SL_MULTIPLES.map(mult => {
    const evTable = RR_LEVELS.map(rr => {
      const wins = trades.filter(t => {
        const origDist = Math.abs(t.entry - t.sl);
        if (!origDist) return false;
        const favMove = getBestRR(t) * origDist;
        return (favMove / (origDist * mult)) >= rr;
      }).length;
      const wr = wins / trades.length;
      return { rr, wins, total: trades.length, winrate: `${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
    });
    const best = evTable.reduce((a,b) => b.ev>a.ev ? b : a);
    return {
      slMultiple: mult,
      label: mult===1.0 ? "✅ huidig" : mult<1.0 ? `🔽 ${mult}× kleiner` : `🔼 ${mult}× groter`,
      bestTP: `${best.rr}R`, bestEV: best.ev, bestWinrate: best.winrate,
      evTable,
    };
  });
}

function getSLDirection(analysis) {
  const current = analysis.find(a => a.slMultiple === 1.0);
  const best    = analysis.reduce((a,b) => b.bestEV > a.bestEV ? b : a);
  if (!current || best.slMultiple === 1.0) return "unchanged";
  if (best.bestEV <= (current.bestEV ?? -Infinity)) return "unchanged";
  return best.slMultiple > 1.0 ? "up" : "down";
}

// ══════════════════════════════════════════════════════════════
// GHOST TRACKER
// ══════════════════════════════════════════════════════════════
function startGhostTracker(closedTrade) {
  const ghostId   = `ghost_${closedTrade.id}_${Date.now()}`;
  const startedAt = Date.now();
  let bestPrice   = closedTrade.maxPrice ?? closedTrade.entry;
  let currentTimer = null;

  console.log(`👻 Ghost gestart: ${closedTrade.symbol} | startMaxRR: ${closedTrade.maxRR}R`);

  async function tick() {
    try {
      const { hhmm } = getBrusselsComponents();
      const elapsed  = Date.now() - startedAt;
      const shouldStop = elapsed >= GHOST_DURATION_MS || hhmm >= 2000 || hhmm < 200;

      const priceData = await fetchCurrentPrice(closedTrade.mt5Symbol);
      const price     = priceData?.mid ?? null;

      if (price !== null) {
        const better = closedTrade.direction === "buy" ? price > bestPrice : price < bestPrice;
        if (better) bestPrice = price;
        if (ghostTrackers[ghostId]) ghostTrackers[ghostId].bestPrice = bestPrice;

        const slBreach = closedTrade.direction === "buy"
          ? price <= closedTrade.sl
          : price >= closedTrade.sl;

        if (slBreach) {
          console.log(`👻 ${closedTrade.symbol} — SL-breach na close`);
          finaliseGhost(ghostId, closedTrade, bestPrice, "sl_breach");
          return;
        }
      }

      if (shouldStop) {
        finaliseGhost(ghostId, closedTrade, bestPrice,
          elapsed >= GHOST_DURATION_MS ? "timeout" : "market_closed");
        return;
      }

      const interval = elapsed < GHOST_OLD_THRESHOLD_MS
        ? GHOST_INTERVAL_RECENT_MS
        : GHOST_INTERVAL_OLD_MS;
      currentTimer = setTimeout(tick, interval);
      if (ghostTrackers[ghostId]) ghostTrackers[ghostId].timer = currentTimer;
    } catch (e) { console.warn(`⚠️ Ghost ${ghostId}:`, e.message); }
  }

  currentTimer = setTimeout(tick, GHOST_INTERVAL_RECENT_MS);
  ghostTrackers[ghostId] = { trade: closedTrade, timer: currentTimer, startedAt, bestPrice };

  setTimeout(() => {
    if (ghostTrackers[ghostId])
      finaliseGhost(ghostId, closedTrade, ghostTrackers[ghostId].bestPrice, "failsafe");
  }, GHOST_DURATION_MS + 5 * 60 * 1000);
}

function finaliseGhost(ghostId, trade, bestPrice, reason) {
  if (!ghostTrackers[ghostId]) return;
  clearTimeout(ghostTrackers[ghostId].timer);
  delete ghostTrackers[ghostId];

  const trueMaxRR = calcMaxRRFromPrice(trade, bestPrice);
  const idx = closedTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    closedTrades[idx].trueMaxRR        = trueMaxRR;
    closedTrades[idx].trueMaxPrice     = bestPrice;
    closedTrades[idx].ghostStopReason  = reason;
    closedTrades[idx].ghostFinalizedAt = new Date().toISOString();

    saveTrade(closedTrades[idx]).catch(e => console.error(`❌ [DB] ghost saveTrade:`, e.message));
    console.log(`✅ Ghost ${trade.symbol} → trueMaxRR: ${trueMaxRR}R (was ${trade.maxRR}R) | ${reason}`);

    runTPLockEngine(trade.symbol).catch(e => console.error(`❌ [TP Lock]:`, e.message));
    runSLLockEngine(trade.symbol).catch(e => console.error(`❌ [SL Lock]:`, e.message));
  }
}

// ══════════════════════════════════════════════════════════════
// TP LOCK ENGINE
// ══════════════════════════════════════════════════════════════
async function runTPLockEngine(symbol) {
  for (const session of TRADING_SESSIONS) {
    await _runTPLockForSession(symbol, session).catch(e =>
      console.error(`❌ [TP Lock] ${symbol}/${session}:`, e.message)
    );
  }
}

async function _runTPLockForSession(symbol, session) {
  const trades = closedTrades.filter(t =>
    t.symbol === symbol && t.sl && t.entry && t.session === session
  );
  const n       = trades.length;
  const lockKey = `${symbol}__${session}`;

  if (n < TP_LOCK_THRESHOLD) return;

  const existing = tpLocks[lockKey];
  if (existing && (n - existing.lockedTrades) < TP_UPDATE_INTERVAL) return;

  const evTable = RR_LEVELS.map(rr => {
    const wins = trades.filter(t => getBestRR(t) >= rr).length;
    const wr   = wins / n;
    return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)) };
  });
  const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a);

  if (best.ev <= 0) {
    console.log(`⚠️ [TP Lock] ${symbol}/${session}: EV negatief — geen lock`);
    return;
  }

  const oldRR   = existing?.lockedRR ?? null;
  const isNew   = !existing;
  const changed = existing && existing.lockedRR !== best.rr;

  if (!isNew && !changed) {
    tpLocks[lockKey] = { ...existing, lockedTrades: n };
    return;
  }

  const reason = isNew
    ? `eerste lock na ${n} trades [${session}]`
    : `update na ${n} trades (${oldRR}R → ${best.rr}R) [${session}]`;

  tpLocks[lockKey] = {
    lockedRR:     best.rr,
    lockedAt:     new Date().toISOString(),
    lockedTrades: n,
    session,
    prevRR:       oldRR,
    prevLockedAt: existing?.lockedAt ?? null,
    evAtLock:     best.ev,
  };

  const logEntry = {
    symbol, session, oldRR, newRR: best.rr, trades: n, ev: best.ev, reason,
    ts: new Date().toISOString(),
  };
  tpUpdateLog.unshift(logEntry);
  if (tpUpdateLog.length > MAX_TP_LOG) tpUpdateLog.length = MAX_TP_LOG;

  try {
    await saveTPConfig(symbol, session, best.rr, n, best.ev, oldRR, existing?.lockedAt ?? null);
    await logTPUpdate(symbol, session, oldRR, best.rr, n, best.ev, reason);
  } catch (e) { console.error(`❌ [TP Lock] DB:`, e.message); }

  console.log(`🔒 [TP Lock] ${symbol}/${session}: ${isNew?"NIEUW":"UPDATE"} → ${best.rr}R (EV +${best.ev}R | ${n} trades)`);
}

// ══════════════════════════════════════════════════════════════
// SL LOCK ENGINE (READONLY)
// ══════════════════════════════════════════════════════════════
async function runSLLockEngine(symbol) {
  const trades = closedTrades.filter(t => t.symbol === symbol && t.sl && t.entry);
  const n = trades.length;
  if (n < SL_LOCK_THRESHOLD) return;

  const existing = slLocks[symbol];
  if (existing && (n - existing.lockedTrades) < SL_UPDATE_INTERVAL) return;

  const analysis  = buildSLAnalysis(trades);
  const best      = analysis.reduce((a,b) => b.bestEV > a.bestEV ? b : a);
  const current   = analysis.find(a => a.slMultiple === 1.0);
  const direction = getSLDirection(analysis);

  if (best.bestEV <= 0) {
    console.log(`⚠️ [SL Analyse] ${symbol}: geen positieve EV`);
    return;
  }

  const oldMult = existing?.multiplier ?? null;
  const isNew   = !existing;
  const changed = existing && (existing.multiplier !== best.slMultiple || existing.direction !== direction);

  if (!isNew && !changed) {
    slLocks[symbol] = { ...existing, lockedTrades: n };
    return;
  }

  const reason = isNew
    ? `eerste analyse na ${n} trades [${direction}]`
    : `update na ${n} trades (${oldMult}× → ${best.slMultiple}×, ${direction})`;

  slLocks[symbol] = {
    multiplier:     best.slMultiple,
    direction,
    lockedAt:       new Date().toISOString(),
    lockedTrades:   n,
    evAtLock:       best.bestEV,
    bestTPRR:       parseFloat(best.bestTP),
    prevMultiplier: oldMult,
    prevLockedAt:   existing?.lockedAt ?? null,
    currentEV:      current?.bestEV ?? null,
    note:           "⚠️ READONLY — advies voor SL richting",
    directionLabel: direction === "up" ? "🔼 Vergroot SL" : direction === "down" ? "🔽 Verklein SL" : "✅ Huidig optimaal",
  };

  const logEntry = {
    symbol, oldMultiplier: oldMult, newMultiplier: best.slMultiple, direction,
    trades: n, ev: best.bestEV, reason, ts: new Date().toISOString(),
  };
  slUpdateLog.unshift(logEntry);
  if (slUpdateLog.length > MAX_SL_LOG) slUpdateLog.length = MAX_SL_LOG;

  try {
    await saveSLConfig(symbol, best.slMultiple, direction, n, best.bestEV,
      parseFloat(best.bestTP), oldMult, existing?.lockedAt ?? null);
    await logSLUpdate(symbol, oldMult, best.slMultiple, direction, n, best.bestEV, reason);
  } catch (e) { console.error(`❌ [SL Analyse] DB:`, e.message); }

  console.log(`📐 [SL Analyse] ${symbol}: ${best.slMultiple}× (${direction}) EV +${best.bestEV}R | ${n} trades — READONLY`);
}

// ── SL MULTIPLIER TOEPASSEN ───────────────────────────────────
function applySlMultiplier(dir, entry, sl, multiplier) {
  if (!multiplier || multiplier === 1.0) return sl;
  const origDist = Math.abs(entry - sl);
  const newDist  = origDist * multiplier;
  const newSl    = dir === "buy" ? entry - newDist : entry + newDist;
  return parseFloat(newSl.toFixed(5));
}

function calcTPPrice(direction, entry, sl, lockedRR) {
  const dist = Math.abs(entry - sl);
  return direction === "buy"
    ? parseFloat((entry + dist * lockedRR).toFixed(5))
    : parseFloat((entry - dist * lockedRR).toFixed(5));
}

// ══════════════════════════════════════════════════════════════
// POSITION SYNC (30s)
// ══════════════════════════════════════════════════════════════
async function syncPositions() {
  try {
    const live    = await fetchOpenPositions();
    const liveIds = new Set((live||[]).map(p => String(p.id)));

    for (const pos of (live||[])) {
      const id    = String(pos.id);
      const trade = openPositions[id];
      if (!trade) continue;
      const cur   = pos.currentPrice ?? pos.openPrice ?? 0;
      const lotV  = LOT_VALUE[getSymbolType(trade.symbol)] || 1;
      trade.currentPnL = parseFloat((
        pos.unrealizedProfit ?? pos.profit ??
        ((trade.direction==="buy" ? cur-trade.entry : trade.entry-cur) * trade.lots * lotV)
      ).toFixed(2));
      const better = trade.direction==="buy"
        ? cur > (trade.maxPrice ?? trade.entry)
        : cur < (trade.maxPrice ?? trade.entry);
      if (better) { trade.maxPrice = cur; trade.maxRR = calcMaxRR({...trade, maxPrice:cur}); }
      trade.currentPrice = cur;
      trade.lastSync     = new Date().toISOString();
    }

    for (const [id, trade] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        const maxRR   = calcMaxRR(trade);
        const session = getSessionGMT1(trade.openedAt);
        const closed  = {
          ...trade,
          closedAt:     new Date().toISOString(),
          maxRR,
          session,
          sessionLabel: SESSION_LABELS[session] || session,
          trueMaxRR:    null,
          trueMaxPrice: null,
        };
        closedTrades.push(closed);
        saveTrade(closed).catch(e => console.error(`❌ [DB] saveTrade:`, e.message));
        if (trade.symbol && trade.direction) decrementTracker(trade.symbol, trade.direction);
        delete openPositions[id];
        console.log(`📦 ${trade.symbol} gesloten | MaxRR: ${maxRR}R | Sessie: ${session}`);
        startGhostTracker(closed);
      }
    }

    try {
      const info = await fetchAccountInfo();
      const snap = {
        ts:         new Date().toISOString(),
        balance:    info.balance    ?? null,
        equity:     info.equity     ?? null,
        floatingPL: parseFloat(((info.equity??0)-(info.balance??0)).toFixed(2)),
        margin:     info.margin     ?? null,
        freeMargin: info.freeMargin ?? null,
      };
      accountSnapshots.push(snap);
      if (accountSnapshots.length > MAX_SNAPSHOTS) accountSnapshots.shift();
      saveSnapshot(snap).catch(() => {});
    } catch (e) { console.warn("⚠️ Snapshot mislukt:", e.message); }
  } catch (e) { console.warn("⚠️ syncPositions:", e.message); }
}
setInterval(syncPositions, 30 * 1000);

// ══════════════════════════════════════════════════════════════
// ORDER PLAATSEN
// ══════════════════════════════════════════════════════════════
function learnFromError(symbol, code, msg) {
  const m = (msg||"").toLowerCase();
  if (!learnedPatches[symbol]) learnedPatches[symbol] = {};
  if (code==="TRADE_RETCODE_INVALID" && m.includes("symbol")) {
    const cur   = getMT5Symbol(symbol);
    const tried = learnedPatches[symbol]._triedMt5 || [];
    const next  = [cur.replace(".cash",""), cur+".cash"].filter(s => s!==cur && !tried.includes(s))[0];
    if (next) { learnedPatches[symbol].mt5Override = next; learnedPatches[symbol]._triedMt5 = [...tried, next]; }
  }
  if (m.includes("volume") || m.includes("lot"))
    learnedPatches[symbol].lotStepOverride = (learnedPatches[symbol]?.lotStepOverride || 0.01) * 10;
  if (m.includes("stop") || code==="TRADE_RETCODE_INVALID_STOPS") {
    const mt5  = getMT5Symbol(symbol);
    const type = getSymbolType(symbol);
    if (type === "index") {
      MIN_STOP_INDEX[mt5] = (MIN_STOP_INDEX[mt5] || 5) * 2;
    } else if (type === "forex") {
      MIN_STOP_FOREX[mt5] = (MIN_STOP_FOREX[mt5] || 0.0005) * 2;
    }
  }
}

async function placeOrder(dir, symbol, entry, sl, lots, session) {
  const mt5Symbol = getMT5Symbol(symbol);
  const type      = getSymbolType(symbol);
  const slPrice   = validateSL(dir, entry, sl, mt5Symbol, type);

  const lockKey = `${symbol}__${session}`;
  const tpLock  = tpLocks[lockKey];
  const tpPrice = tpLock ? calcTPPrice(dir, entry, slPrice, tpLock.lockedRR) : null;
  if (tpPrice) console.log(`🔒 [TP Lock] ${symbol}/${session} TP: ${tpPrice} (${tpLock.lockedRR}R)`);

  const body = {
    symbol:     mt5Symbol,
    volume:     lots,
    actionType: dir==="buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    stopLoss:   slPrice,
    comment:    `FTMO-NV-${dir.toUpperCase()}-${symbol}${tpLock ? `-TP${tpLock.lockedRR}R-${session}` : ""}`,
    ...(tpPrice ? { takeProfit: tpPrice } : {}),
  };

  const r = await fetch(`${META_BASE}/trade`, {
    method:  "POST",
    headers: {"Content-Type":"application/json","auth-token":META_API_TOKEN},
    body:    JSON.stringify(body),
  });
  return { result: await r.json(), mt5Symbol, slPrice, body };
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK
// ══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  try {
    const secret = req.query.secret || req.headers["x-secret"];
    if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error:"Unauthorized" });

    const symbol = (!req.body.symbol || req.body.symbol==="{{ticker}}") ? null : req.body.symbol;
    if (!symbol) return res.status(400).json({ error:"Symbool ontbreekt" });

    const { action, entry, sl } = req.body;
    if (!action||!entry||!sl) return res.status(400).json({ error:"Vereist: action, entry, sl" });

    const direction = ["buy","bull","long"].includes(action.toLowerCase()) ? "buy" : "sell";
    const entryNum  = parseFloat(entry);
    let   slNum     = parseFloat(sl);

    if (isNaN(entryNum)||isNaN(slNum)) return res.status(400).json({ error:"entry/sl geen getallen" });
    if (direction==="buy"  && slNum>=entryNum) return res.status(400).json({ error:"SL onder entry voor BUY" });
    if (direction==="sell" && slNum<=entryNum) return res.status(400).json({ error:"SL boven entry voor SELL" });

    const symType    = getSymbolType(symbol);
    const mt5Sym     = getMT5Symbol(symbol);
    const curSession = getSessionGMT1();

    if (!isMarketOpen(symType, symbol)) {
      addWebhookHistory({ type:"MARKET_CLOSED", symbol, symType });
      return res.status(200).json({ status:"SKIP", reason:`Markt gesloten voor ${symbol}` });
    }

    let forexHalfRisk = false;
    if (symType === "forex") {
      const consol = checkForexConsolidation(symbol, direction);
      if (consol.blocked) {
        const reason = `Anti-consolidatie: ${consol.count} open ${direction} trades voor ${symbol} (max ${FOREX_MAX_SAME_DIR})`;
        console.warn(`🚫 [Forex Consolidatie] ${reason}`);
        logForexConsolidation(symbol, direction, consol.count, reason).catch(() => {});
        addWebhookHistory({ type:"FOREX_CONSOLIDATION_BLOCKED", symbol, direction, count: consol.count });
        return res.status(200).json({ status:"SKIP", reason });
      }
      if (consol.halfRisk) {
        forexHalfRisk = true;
        console.log(`⚡ [Forex Consolidatie] ${symbol} ${direction}: ${consol.count} open → half risk`);
      }
    }

    const tpLockKey = `${symbol}__${curSession}`;
    const tpLockNow = tpLocks[tpLockKey];
    const tpProven  = tpLockNow && (tpLockNow.evAtLock ?? 0) > 0;

    let slApplied  = slNum;
    let slLockInfo = null;

    if (tpProven) {
      slApplied  = applySlMultiplier(direction, entryNum, slNum, SL_PROVEN_MULT);
      slLockInfo = `${SL_PROVEN_MULT}× (TP bewezen ${symbol}/${curSession}, EV +${tpLockNow.evAtLock}R)`;
      console.log(`📐 [SL] ${symbol}/${curSession}: SL=${slNum} → ${slApplied} (${SL_PROVEN_MULT}× TP lock bewezen)`);
    } else {
      console.log(`ℹ️ [SL] ${symbol}/${curSession}: geen bewezen TP lock — originele SL behouden`);
    }

    let spreadGuard = false;
    if (symType === "stock") {
      const priceData = await fetchCurrentPrice(mt5Sym).catch(() => null);
      if (priceData && priceData.spread > 0) {
        const sg = checkSpreadGuard(priceData.spread, entryNum, slApplied);
        if (!sg.ok) {
          const reason = `Spread ${sg.spreadPct}% van SL-afstand (max ${Math.round(STOCK_MAX_SPREAD_FRACTION*100)}%) — spread ${priceData.spread.toFixed(4)} > max ${sg.maxAllowed.toFixed(4)}`;
          console.warn(`🚫 [Spread Guard] ${symbol}: ${reason}`);
          addWebhookHistory({ type:"SPREAD_GUARD_BLOCKED", symbol, spreadPct: sg.spreadPct });
          return res.status(200).json({ status:"SKIP", reason:`Spread te groot: ${reason}` });
        }
        console.log(`✅ [Spread Guard] ${symbol}: spread ${sg.spreadPct}% OK`);
      }
    }

    let risk = getEffectiveRisk(symbol, direction);

    if (forexHalfRisk) {
      risk = risk * 0.5;
      console.log(`⚡ [Forex Half Risk] ${symbol}: risico gehalveerd → €${risk.toFixed(2)}`);
    }

    const ftmo = ftmoSafetyCheck(risk);
    if (!ftmo.ok) {
      addWebhookHistory({ type:"FTMO_BLOCKED", symbol });
      return res.status(200).json({ status:"FTMO_BLOCKED", reason:ftmo.reason });
    }

    const lots = calcLots(symbol, entryNum, slApplied, risk);
    if (lots===null) return res.status(200).json({ status:"SKIP", reason:`Min lot > cap` });

    const slDist = Math.abs(entryNum - slApplied).toFixed(5);
    console.log(`📊 ${direction.toUpperCase()} ${symbol}/${curSession} | Entry:${entryNum} SL:${slApplied} Lots:${lots} Risk:€${risk.toFixed(2)}${forexHalfRisk?" [HALF]":""}`);

    let { result, mt5Symbol, slPrice } = await placeOrder(direction, symbol, entryNum, slApplied, lots, curSession);

    const errCode = result?.error?.code || result?.retcode;
    const errMsg  = result?.error?.message || result?.comment || "";
    const isError = result?.error || (errCode && errCode!==10009 && errCode!=="TRADE_RETCODE_DONE");

    if (isError) {
      learnFromError(symbol, errCode, errMsg);
      const rl = calcLots(symbol, entryNum, slApplied, risk);
      if (rl !== null) {
        const retry    = await placeOrder(direction, symbol, entryNum, slApplied, rl, curSession);
        result         = retry.result;
        const retryErr = retry.result?.error || (retry.result?.retcode && retry.result.retcode!==10009 && retry.result.retcode!=="TRADE_RETCODE_DONE");
        if (retryErr) {
          learnFromError(symbol, retry.result?.error?.code||retry.result?.retcode, retry.result?.error?.message||retry.result?.comment);
          addWebhookHistory({ type:"ERROR", symbol, errCode, errMsg });
          return res.status(200).json({ status:"ERROR_LEARNED", errCode, errMsg });
        }
      }
    }

    registerFtmoLoss(risk);
    incrementTracker(symbol, direction);

    const posId         = String(result?.positionId || result?.orderId || Date.now());
    const tpLockActive  = tpLocks[tpLockKey];
    const tpUsed        = tpLockActive ? calcTPPrice(direction, entryNum, slPrice, tpLockActive.lockedRR) : null;
    const slMultApplied = tpProven ? SL_PROVEN_MULT : (symType === "stock" ? STOCK_SL_SPREAD_MULT : 1.0);

    openPositions[posId] = {
      id: posId, symbol, mt5Symbol, direction,
      entry: entryNum, sl: slPrice, tp: tpUsed, lots,
      riskEUR: risk, openedAt: new Date().toISOString(),
      session: curSession, sessionLabel: SESSION_LABELS[curSession] || curSession,
      maxPrice: entryNum, maxRR: 0, currentPnL: 0, lastSync: null,
      slMultiplierApplied: slMultApplied,
      spreadGuard,
      forexHalfRisk,
    };

    addWebhookHistory({
      type:"SUCCESS", symbol, mt5Symbol, direction, lots, posId,
      session: curSession,
      riskEUR: risk.toFixed(2),
      slAanpassing: slLockInfo ?? "geen",
      tp: tpUsed ? `${tpLockActive.lockedRR}R @ ${tpUsed}` : "geen",
      riskBoost: tpProven ? `×${TP_LOCK_RISK_MULT}` : "×1",
      forexHalfRisk: forexHalfRisk ? "50%" : null,
      stockSlBuffer: symType === "stock" ? `×${STOCK_SL_SPREAD_MULT}` : null,
    });

    res.json({
      status:         "OK",
      versie:         "v4.4",
      direction,
      tvSymbol:       symbol,
      mt5Symbol,
      symType,
      session:        curSession,
      sessionLabel:   SESSION_LABELS[curSession],
      entry:          entryNum,
      sl:             slPrice,
      slOriginal:     slNum,
      slMultiplier:   slMultApplied,
      slLockInfo:     slLockInfo ?? `geen — TP lock niet bewezen voor ${curSession}`,
      stockSlBuffer:  symType === "stock" ? `×${STOCK_SL_SPREAD_MULT} spread buffer toegepast` : null,
      tp:             tpUsed,
      tpRR:           tpLockActive?.lockedRR ?? null,
      tpInfo:         tpUsed
        ? `TP lock ${tpLockActive.lockedRR}R [${curSession}] (${tpLockActive.lockedTrades} trades) → ${tpUsed}`
        : `Geen TP lock voor ${symbol}/${curSession} — ghost tracker actief`,
      slDist,
      lots,
      risicoEUR:      risk.toFixed(2),
      riskBoost:      tpProven ? `×${TP_LOCK_RISK_MULT} (TP lock actief, EV +${tpLockNow?.evAtLock}R)` : "×1",
      forexHalfRisk:  forexHalfRisk ? "⚡ 50% risk — consolidatie (zelfde pair+richting)" : null,
      positionId:     posId,
      metaApi:        result,
    });
  } catch (err) {
    console.error("❌ Webhook fout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MANUAL CLOSE ──────────────────────────────────────────────
app.post("/close", async (req, res) => {
  const secret = req.query.secret || req.headers["x-secret"];
  if (secret!==WEBHOOK_SECRET) return res.status(401).json({ error:"Unauthorized" });
  const { positionId, symbol, direction } = req.body;
  if (!positionId) return res.status(400).json({ error:"Vereist: positionId" });
  try {
    const result = await closePosition(positionId);
    if (symbol&&direction) decrementTracker(symbol, direction);
    res.json({ status:"OK", result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  resetDailyLossIfNewDay();
  const lockedBySession = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (!lockedBySession[sess]) lockedBySession[sess] = [];
    lockedBySession[sess].push(`${sym}(${lock.lockedRR}R EV+${lock.evAtLock}R)`);
  }
  res.json({
    status:  "online",
    versie:  "ftmo-v4.4",
    fixes: {
      appListen:       "✅ app.listen() toegevoegd — Railway crash opgelost",
      capFix:          "✅ Min lot cap = baseRisk per type",
      restartRecovery: "✅ openPositions her-initialiseren vanuit MT5 bij startup",
      forexHalfRisk:   `✅ Forex consolidatie: 50% risk bij 1–${FOREX_MAX_SAME_DIR-1} open, blok bij ≥${FOREX_MAX_SAME_DIR}`,
    },
    capPerType: Object.fromEntries(Object.entries(RISK).map(([t,v]) => [t, `€${v} normaal | €${v*TP_LOCK_RISK_MULT} bij TP lock`])),
    tracking: {
      openPositions: Object.keys(openPositions).length,
      closedTrades:  closedTrades.length,
      tpLocks:       Object.keys(tpLocks).length,
      slAnalyses:    Object.keys(slLocks).length,
    },
    endpoints: {
      "POST /webhook":                      "TradingView → FTMO MT5",
      "POST /close":                        "Manueel sluiten",
      "GET  /live/positions":               "Live posities",
      "GET  /live/ghosts":                  "Actieve ghost trackers",
      "GET  /analysis/rr":                  "MaxRR + trueMaxRR",
      "GET  /analysis/sessions":            "EV per sessie",
      "GET  /analysis/equity-curve":        "Equity history",
      "GET  /research/tp-optimizer":        "TP optimizer (globaal)",
      "GET  /research/tp-optimizer/sessie": "TP optimizer per sessie",
      "GET  /research/sl-optimizer":        "SL optimizer (READONLY)",
      "GET  /tp-locks":                     "TP lock status",
      "GET  /sl-locks":                     "SL analyse status",
      "GET  /history":                      "Webhook log",
      "GET  /dashboard":                    "Visueel dashboard",
    },
  });
});

app.get("/status", (req, res) => {
  resetDailyLossIfNewDay();
  res.json({ openTrades:openTradeTracker, learnedPatches, risicoPerType:RISK });
});

app.get("/live/positions", (req, res) => {
  res.json({
    count: Object.keys(openPositions).length,
    positions: Object.values(openPositions).map(p => ({
      id:p.id, symbol:p.symbol, direction:p.direction,
      entry:p.entry, sl:p.sl, tp:p.tp, lots:p.lots,
      riskEUR:p.riskEUR, openedAt:p.openedAt,
      session:p.session, sessionLabel:p.sessionLabel,
      currentPrice:p.currentPrice??null, currentPnL:p.currentPnL??0,
      maxRR:p.maxRR??0, slMultiplier:p.slMultiplierApplied??1.0,
      spreadGuard:p.spreadGuard??false,
      forexHalfRisk:p.forexHalfRisk??false,
      restoredAfterRestart:p.restoredAfterRestart??false,
    })),
  });
});

app.get("/live/ghosts", (req, res) => {
  const active = Object.entries(ghostTrackers).map(([id,g]) => ({
    ghostId:          id,
    symbol:           g.trade.symbol,
    direction:        g.trade.direction,
    entry:            g.trade.entry,
    sl:               g.trade.sl,
    maxRRAtClose:     g.trade.maxRR,
    currentBestPrice: g.bestPrice,
    currentBestRR:    calcMaxRRFromPrice(g.trade, g.bestPrice),
    startedAt:        new Date(g.startedAt).toISOString(),
    elapsedMin:       Math.round((Date.now()-g.startedAt)/60000),
    remainingMin:     Math.round((GHOST_DURATION_MS-(Date.now()-g.startedAt))/60000),
  }));
  res.json({ count:active.length, ghosts:active });
});

// ── ANALYSE RR ────────────────────────────────────────────────
app.get("/analysis/rr", (req, res) => {
  const { symbol } = req.query;
  const trades = symbol
    ? closedTrades.filter(t => t.symbol?.toUpperCase()===symbol.toUpperCase())
    : closedTrades;
  const bySymbol = {};
  for (const t of trades) {
    const s = t.symbol||"UNKNOWN";
    if (!bySymbol[s]) bySymbol[s] = { count:0, totalMaxRR:0, totalTrueMaxRR:0, trueCount:0, trades:[] };
    bySymbol[s].trades.push({
      openedAt:t.openedAt, closedAt:t.closedAt, direction:t.direction,
      entry:t.entry, sl:t.sl, session:t.session,
      maxRR:t.maxRR??0, trueMaxRR:t.trueMaxRR??null,
      ghostStatus: t.trueMaxRR!==null ? "✅ compleet" : "⏳ ghost actief",
    });
    bySymbol[s].totalMaxRR += t.maxRR||0;
    if (t.trueMaxRR!==null) { bySymbol[s].totalTrueMaxRR+=t.trueMaxRR; bySymbol[s].trueCount++; }
    bySymbol[s].count++;
  }
  res.json({
    totalTrades: trades.length,
    bySymbol: Object.fromEntries(
      Object.entries(bySymbol).map(([s,g]) => [s, {
        trades:        g.count,
        avgMaxRR:      parseFloat((g.totalMaxRR/g.count).toFixed(2)),
        avgTrueMaxRR:  g.trueCount ? parseFloat((g.totalTrueMaxRR/g.trueCount).toFixed(2)) : null,
        ghostCoverage: `${g.trueCount}/${g.count}`,
        details:       g.trades,
      }])
    ),
  });
});

// ── SESSIE ANALYSE ────────────────────────────────────────────
app.get("/analysis/sessions", (req, res) => {
  const { symbol, session } = req.query;
  let trades = closedTrades;
  if (symbol)  trades = trades.filter(t => t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (session) trades = trades.filter(t => t.session===session);
  const bySymbol = {};
  for (const t of trades) {
    const sym=t.symbol||"UNKNOWN", sess=t.session||"unknown";
    if (!bySymbol[sym]) bySymbol[sym]={total:0,sessions:{}};
    if (!bySymbol[sym].sessions[sess]) bySymbol[sym].sessions[sess]={trades:[],totalRR:0};
    bySymbol[sym].sessions[sess].trades.push(t);
    bySymbol[sym].sessions[sess].totalRR+=getBestRR(t);
    bySymbol[sym].total++;
  }
  const result={};
  for (const [sym,d] of Object.entries(bySymbol)) {
    result[sym]={totalTrades:d.total,bestSession:null,sessions:{}};
    let bestEV=-Infinity, bestSess=null;
    for (const sess of TRADING_SESSIONS) {
      const g=d.sessions[sess]; if (!g||!g.trades.length) continue;
      const n=g.trades.length, avgRR=parseFloat((g.totalRR/n).toFixed(2));
      const evTable=RR_LEVELS.map(rr=>{
        const wins=g.trades.filter(t=>getBestRR(t)>=rr).length, wr=wins/n;
        return{rr,wins,total:n,winrate:`${(wr*100).toFixed(1)}%`,ev:parseFloat((wr*rr-(1-wr)).toFixed(3))};
      });
      const best=evTable.reduce((a,b)=>b.ev>a.ev?b:a);
      const tpLockForSess = tpLocks[`${sym}__${sess}`];
      result[sym].sessions[sess]={label:SESSION_LABELS[sess],trades:n,avgBestRR:avgRR,
        bestTP:`${best.rr}R`,bestEV:best.ev,evTable,
        tpLock: tpLockForSess ? { lockedRR: tpLockForSess.lockedRR, evAtLock: tpLockForSess.evAtLock } : null};
      if (best.ev>bestEV){bestEV=best.ev;bestSess=sess;}
    }
    result[sym].bestSession=bestSess?{session:bestSess,label:SESSION_LABELS[bestSess],ev:bestEV}:null;
  }
  res.json({ totalTrades:trades.length, sessieDefinities:SESSION_LABELS,
    filters:{symbol:symbol||"alle",session:session||"alle"}, bySymbol:result });
});

// ── TP OPTIMIZER ──────────────────────────────────────────────
function buildTPOptimizerResults(minTrades=3) {
  const bySymbol={};
  for (const t of closedTrades) {
    if (!t.sl||!t.entry) continue;
    if (!bySymbol[t.symbol]) bySymbol[t.symbol]=[];
    bySymbol[t.symbol].push(t);
  }
  const results=[];
  for (const [symbol,trades] of Object.entries(bySymbol)) {
    if (trades.length<minTrades){results.push({symbol,trades:trades.length,note:`Te weinig data (min ${minTrades})`,bestTP:null,bestEV:null});continue;}
    const ghostPending=trades.filter(t=>t.trueMaxRR===null).length;
    const evTable=RR_LEVELS.map(rr=>{
      const wins=trades.filter(t=>getBestRR(t)>=rr).length,wr=wins/trades.length;
      return{rr,wins,total:trades.length,winrate:`${(wr*100).toFixed(1)}%`,ev:parseFloat((wr*rr-(1-wr)).toFixed(3))};
    });
    const best=evTable.reduce((a,b)=>b.ev>a.ev?b:a);
    const subRRBest=evTable.filter(e=>e.rr<1).reduce((a,b)=>b.ev>a.ev?b:a,{rr:null,ev:-Infinity});
    results.push({
      symbol, trades:trades.length, ghostPending,
      bestTP:`${best.rr}R`, bestEV:best.ev, bestWinrate:best.winrate,
      subRRBest: subRRBest.rr!==null&&subRRBest.ev>0 ? {rr:`${subRRBest.rr}R`,ev:subRRBest.ev} : null,
      recommendation: best.ev>0 ? `Target: ${best.rr}R (EV: +${best.ev}R/trade)` : "EV negatief",
      evTable,
    });
  }
  results.sort((a,b)=>(b.bestEV??-99)-(a.bestEV??-99));
  return{results,rrLevels:RR_LEVELS};
}

app.get("/research/tp-optimizer", (req,res) => {
  if (!closedTrades.length) return res.json({info:"Geen gesloten trades.",trades:0});
  const {results,rrLevels}=buildTPOptimizerResults(3);
  res.json({generated:new Date().toISOString(),totalTrades:closedTrades.length,rrLevels,bySymbol:results});
});

app.get("/research/tp-optimizer/sessie", (req,res) => {
  const {symbol}=req.query;
  let trades=closedTrades;
  if (symbol) trades=trades.filter(t=>t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (!trades.length) return res.json({info:"Geen trades.",trades:0});
  const bySymbol={};
  for (const t of trades){const sym=t.symbol||"UNKNOWN",sess=t.session||"unknown";if(!bySymbol[sym])bySymbol[sym]={};if(!bySymbol[sym][sess])bySymbol[sym][sess]=[];bySymbol[sym][sess].push(t);}
  const result={};
  for (const [sym,sessions] of Object.entries(bySymbol)){
    result[sym]={totalTrades:0,sessions:{}};
    for (const sess of TRADING_SESSIONS){
      const st=sessions[sess]||[];result[sym].totalTrades+=st.length;
      if (st.length<3){result[sym].sessions[sess]={label:SESSION_LABELS[sess],trades:st.length,note:"Te weinig data"};continue;}
      const ghostPending=st.filter(t=>t.trueMaxRR===null).length;
      const evTable=RR_LEVELS.map(rr=>{const wins=st.filter(t=>getBestRR(t)>=rr).length,wr=wins/st.length;return{rr,wins,total:st.length,winrate:`${(wr*100).toFixed(1)}%`,ev:parseFloat((wr*rr-(1-wr)).toFixed(3))};});
      const best=evTable.reduce((a,b)=>b.ev>a.ev?b:a);
      const subRRBest=evTable.filter(e=>e.rr<1).reduce((a,b)=>b.ev>a.ev?b:a,{rr:null,ev:-Infinity});
      const tpLockForSess=tpLocks[`${sym}__${sess}`];
      result[sym].sessions[sess]={label:SESSION_LABELS[sess],trades:st.length,ghostPending,
        bestTP:`${best.rr}R`,bestEV:best.ev,bestWinrate:best.winrate,
        subRRBest:subRRBest.rr!==null&&subRRBest.ev>0?{rr:`${subRRBest.rr}R`,ev:subRRBest.ev}:null,
        tpLock:tpLockForSess?{lockedRR:tpLockForSess.lockedRR,evAtLock:tpLockForSess.evAtLock}:null,
        recommendation:best.ev>0?`Target: ${best.rr}R (EV +${best.ev}R/trade)`:"EV negatief",evTable};
    }
  }
  res.json({generated:new Date().toISOString(),totalTrades:trades.length,sessieDefinities:SESSION_LABELS,
    rrLevels:RR_LEVELS,filters:{symbol:symbol||"alle"},
    bySymbol:Object.fromEntries(Object.entries(result).sort((a,b)=>b[1].totalTrades-a[1].totalTrades))});
});

// ── SL OPTIMIZER ─────────────────────────────────────────────
app.get("/research/sl-optimizer", (req,res) => {
  const {symbol}=req.query;
  let trades=closedTrades.filter(t=>t.sl&&t.entry);
  if (symbol) trades=trades.filter(t=>t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (!trades.length) return res.json({info:"Geen bruikbare trades.",trades:0});
  const bySymbol={};
  for (const t of trades){if(!bySymbol[t.symbol])bySymbol[t.symbol]=[];bySymbol[t.symbol].push(t);}
  const results=[];
  for (const [sym,st] of Object.entries(bySymbol)){
    if (st.length<5){results.push({symbol:sym,trades:st.length,note:"Te weinig data"});continue;}
    const analysis=buildSLAnalysis(st);
    const best=analysis.reduce((a,b)=>b.bestEV>a.bestEV?b:a);
    const direction=getSLDirection(analysis);
    results.push({symbol:sym,trades:st.length,direction,
      advies:best.slMultiple===1.0?"✅ Huidig optimaal":best.slMultiple<1.0
        ?`🔽 Kleinere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`
        :`🔼 Grotere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`,
      slAnalysis:analysis});
  }
  res.json({generated:new Date().toISOString(),totalTrades:trades.length,
    warning:"⚠️ READONLY — direction advies",bySymbol:results});
});

// ── EQUITY CURVE ──────────────────────────────────────────────
app.get("/analysis/equity-curve", async (req,res) => {
  const hours=parseInt(req.query.hours)||24;
  try {
    const timeout = new Promise((_,rej) => setTimeout(() => rej(new Error("timeout")), 4000));
    const db = await Promise.race([loadSnapshots(hours), timeout]);
    if (db.length) return res.json({hours,count:db.length,source:"postgres",snapshots:db});
  } catch(e) { console.warn("⚠️ equity-curve DB fallback:", e.message); }
  const cutoff=new Date(Date.now()-hours*3600000).toISOString();
  const snaps=accountSnapshots.filter(s=>s.ts>=cutoff);
  res.json({hours,count:snaps.length,source:"memory",snapshots:snaps});
});

app.get("/history", (req,res) => {
  const limit=Math.min(parseInt(req.query.limit)||50,MAX_HISTORY);
  res.json({count:webhookHistory.length,history:webhookHistory.slice(0,limit)});
});

// ── TP / SL LOCK API ──────────────────────────────────────────
app.get("/tp-locks", (req,res) => {
  const bySym = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (!bySym[sym]) bySym[sym] = {};
    bySym[sym][sess] = lock;
  }
  res.json({generated:new Date().toISOString(),totalLocks:Object.keys(tpLocks).length,locksBySymbol:bySym});
});

app.get("/sl-locks", (req,res) => {
  res.json({generated:new Date().toISOString(),note:"READONLY — SL direction engine",
    totalAnalyses:Object.keys(slLocks).length,
    analyses:Object.entries(slLocks).map(([sym,lock])=>({symbol:sym,...lock}))});
});

app.delete("/tp-locks/:symbol", (req,res) => {
  const sym=req.params.symbol.toUpperCase(); let count=0;
  for (const key of Object.keys(tpLocks)) { if (key.startsWith(sym+"__")) { delete tpLocks[key]; count++; } }
  res.json({status:"OK",removed:count,symbol:sym});
});

app.delete("/tp-locks/:symbol/:session", (req,res) => {
  const key=`${req.params.symbol.toUpperCase()}__${req.params.session}`;
  const existed=!!tpLocks[key]; delete tpLocks[key];
  res.json({status:"OK",removed:existed?1:0,key});
});

app.delete("/sl-locks/:symbol", (req,res) => {
  const sym=req.params.symbol.toUpperCase(); const existed=!!slLocks[sym]; delete slLocks[sym];
  res.json({status:"OK",removed:existed?1:0,symbol:sym});
});

app.get("/tp-locks/:symbol", (req,res) => {
  const sym = req.params.symbol.toUpperCase();
  const locks = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    if (key.startsWith(sym+"__")) locks[key] = lock;
  }
  if (!Object.keys(locks).length) return res.json({info:`Geen TP locks voor ${sym}`});
  res.json({symbol:sym, locks});
});

app.get("/tp-locks/:symbol/:session", (req,res) => {
  const key = `${req.params.symbol.toUpperCase()}__${req.params.session}`;
  const lock = tpLocks[key];
  if (!lock) return res.json({info:`Geen TP lock voor ${key}`});
  res.json({key, lock});
});

app.get("/sl-locks/:symbol", (req,res) => {
  const sym = req.params.symbol.toUpperCase();
  const lock = slLocks[sym];
  if (!lock) return res.json({info:`Geen SL lock voor ${sym}`});
  res.json({symbol:sym, lock});
});

app.get("/webhook", (req,res) => {
  res.json({info:"POST endpoint", gebruik:"POST /webhook + x-secret header", status:"online"});
});

app.get("/close", (req,res) => {
  res.json({info:"POST endpoint", gebruik:"POST /close + {positionId} + x-secret header", status:"online"});
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  function rrColor(v) {
    if (v === null || v === undefined) return "#6a8098";
    if (v >= 2)   return "#22d18b";
    if (v >= 1)   return "#2dd4f4";
    if (v >= 0.5) return "#f0a050";
    return "#f26b62";
  }
  function evColor(v) { return v > 0 ? "#22d18b" : v === 0 ? "#6a8098" : "#f26b62"; }
  function fmt(v, dec=2) { return v == null ? "—" : Number(v).toFixed(dec); }
  function fmtRR(v) { return v == null ? "—" : Number(v).toFixed(2) + "R"; }
  function timeAgo(iso) {
    if (!iso) return "—";
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff/60000);
    if (m < 60)  return m + "m geleden";
    const h = Math.floor(m/60);
    if (h < 24)  return h + "u geleden";
    return Math.floor(h/24) + "d geleden";
  }
  function sessionLabel(s) {
    return {asia:"🌏 Asia",london:"🇬🇧 London",ny:"🗽 NY",buiten_venster:"🌙 Buiten"}[s] || s || "—";
  }

  const now = new Date();
  const brusselsTime = now.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels", hour12:false});
  const brusselsDate = now.toLocaleDateString("nl-BE", {timeZone:"Europe/Brussels", weekday:"long", year:"numeric", month:"long", day:"numeric"});

  const byPair = {};
  for (const t of closedTrades) {
    const sym = t.symbol || "UNKNOWN";
    if (!byPair[sym]) byPair[sym] = { trades:[], sessions:{} };
    byPair[sym].trades.push(t);
    const sess = t.session || "buiten_venster";
    if (!byPair[sym].sessions[sess]) byPair[sym].sessions[sess] = [];
    byPair[sym].sessions[sess].push(t);
  }

  const DASH_RR_LEVELS = [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5];
  function bestTP(trades) {
    if (!trades || trades.length < 3) return null;
    let best = { ev: -Infinity, rr: null, wr: null };
    for (const rr of DASH_RR_LEVELS) {
      const wins = trades.filter(t => (t.trueMaxRR ?? t.maxRR ?? 0) >= rr).length;
      const wr   = wins / trades.length;
      const ev   = parseFloat((wr * rr - (1 - wr)).toFixed(3));
      if (ev > best.ev) best = { ev, rr, wr, wins, total: trades.length };
    }
    return best;
  }

  const pairStats = Object.entries(byPair).map(([sym, d]) => {
    const total = d.trades.length;
    const avgMaxRR = total ? d.trades.reduce((s,t) => s + (t.maxRR||0), 0) / total : 0;
    const globalBest = bestTP(d.trades);
    const tpLock = Object.entries(tpLocks)
      .filter(([k]) => k.startsWith(sym + "__"))
      .map(([k, v]) => ({ sess: k.split("__")[1], ...v }));
    const slLock = slLocks[sym] || null;
    const sessionBreakdown = ["asia","london","ny"].map(sess => {
      const st = d.sessions[sess] || [];
      const bp = bestTP(st);
      const lock = tpLocks[`${sym}__${sess}`] || null;
      return { sess, trades: st.length, best: bp, lock };
    });
    const ghostCount = d.trades.filter(t => t.trueMaxRR === null && t.maxRR > 0).length;
    return { sym, total, avgMaxRR, globalBest, tpLock, slLock, sessionBreakdown, ghostCount };
  }).sort((a,b) => (b.globalBest?.ev ?? -99) - (a.globalBest?.ev ?? -99));

  const openPos = Object.values(openPositions);
  const activeGhosts = Object.entries(ghostTrackers).map(([id, g]) => ({
    id, sym: g.trade.symbol, dir: g.trade.direction,
    entry: g.trade.entry, sl: g.trade.sl,
    maxRRAtClose: g.trade.maxRR,
    bestRR: g.bestPrice ? Math.abs(g.bestPrice - g.trade.entry) / Math.abs(g.trade.entry - g.trade.sl) : 0,
    elapsedMin: Math.round((Date.now() - g.startedAt) / 60000),
    remainMin:  Math.round(((24*3600000) - (Date.now() - g.startedAt)) / 60000),
    session: g.trade.session,
  }));
  const recentWebhooks = webhookHistory.slice(0, 20);

  const totalTrades = closedTrades.length;
  const totalGhosts = activeGhosts.length;
  const totalOpen   = openPos.length;
  const totalPairs  = pairStats.length;
  const avgEV = pairStats.filter(p => p.globalBest?.ev != null)
    .reduce((s,p) => s + p.globalBest.ev, 0) /
    (pairStats.filter(p => p.globalBest?.ev != null).length || 1);
  const posEVPairs = pairStats.filter(p => (p.globalBest?.ev ?? -1) > 0).length;

  const css = `
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#07090d;--bg1:#0c1018;--bg2:#111820;--bg3:#18212d;--b:#1c2a38;--b2:#243342;
          --t:#c9d8e8;--t2:#8aa0b4;--t3:#4a6070;--acc:#2dd4f4;--g:#22d18b;--r:#f26b62;
          --o:#f0a050;--pu:#b88ff0;--ye:#e3b341;--mono:'JetBrains Mono','Courier New',monospace;
          --sans:'Segoe UI',system-ui,sans-serif}
    html{scroll-behavior:smooth}
    body{font-family:var(--mono);background:var(--bg);color:var(--t);font-size:13px;line-height:1.5}
    a{color:var(--acc);text-decoration:none}
    .top{position:sticky;top:0;z-index:100;background:var(--bg1);border-bottom:1px solid var(--b);
         display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px}
    .logo{font-family:var(--sans);font-weight:800;font-size:15px;color:var(--acc);display:flex;align-items:center;gap:8px}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--g);box-shadow:0 0 8px var(--g);animation:blink 2s infinite}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
    .time{font-size:12px;color:var(--t3)}
    .nav{background:var(--bg1);border-bottom:1px solid var(--b);display:flex;gap:0;overflow-x:auto;padding:0 16px}
    .nav a{display:flex;align-items:center;gap:6px;padding:12px 16px;font-size:12px;color:var(--t2);
           border-bottom:2px solid transparent;white-space:nowrap;transition:all .15s}
    .nav a:hover{color:var(--t);border-color:var(--b2)}
    .page{max-width:1400px;margin:0 auto;padding:24px 20px}
    .sec{margin-bottom:32px}
    .sec-title{font-family:var(--sans);font-size:16px;font-weight:700;color:var(--t);
               margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--b);
               display:flex;align-items:center;gap:8px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
    .card{background:var(--bg1);border:1px solid var(--b);border-radius:8px;padding:16px}
    .card .v{font-family:var(--sans);font-size:26px;font-weight:800;line-height:1;margin-bottom:4px}
    .card .l{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em}
    .card .s{font-size:11px;color:var(--t2);margin-top:4px}
    .pair-grid{display:flex;flex-direction:column;gap:12px}
    .pair-card{background:var(--bg1);border:1px solid var(--b);border-radius:8px;overflow:hidden}
    .pair-hdr{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg2);border-bottom:1px solid var(--b);flex-wrap:wrap}
    .pair-sym{font-family:var(--sans);font-weight:800;font-size:15px;color:var(--acc)}
    .pair-rank{font-size:10px;color:var(--t3);background:var(--bg3);border-radius:4px;padding:2px 6px}
    .badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600}
    .badge-g{background:#0b4e33;color:var(--g)}.badge-r{background:#4f1c18;color:var(--r)}
    .badge-o{background:#4e2c0a;color:var(--o)}.badge-b{background:#0e2a38;color:var(--acc)}
    .pair-body{padding:16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
    @media(max-width:700px){.pair-body{grid-template-columns:1fr}}
    .pair-section h4{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
    .kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--b);font-size:12px}
    .kv:last-child{border-bottom:none}.kv .k{color:var(--t2)}.kv .v{font-weight:600}
    .sess-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:4px}
    .sess-box{background:var(--bg3);border-radius:6px;padding:8px;border:1px solid var(--b)}
    .sess-box .sname{font-size:10px;color:var(--t3);margin-bottom:4px}
    .sess-box .sev{font-size:14px;font-weight:800;font-family:var(--sans)}
    .sess-box .srr{font-size:10px;color:var(--t2)}.locked{border-color:var(--ye) !important}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{text-align:left;padding:8px 10px;color:var(--t3);font-size:10px;text-transform:uppercase;
       letter-spacing:.06em;border-bottom:1px solid var(--b);font-weight:600}
    td{padding:8px 10px;border-bottom:1px solid var(--b)}
    tr:last-child td{border-bottom:none}tr:hover td{background:var(--bg2)}
    .empty{color:var(--t3);font-size:12px;padding:24px;text-align:center}
    .sticker{position:fixed;bottom:20px;right:20px;background:var(--acc);color:#000;
             border-radius:50%;width:36px;height:36px;display:flex;align-items:center;
             justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
    .update-info{font-size:11px;color:var(--t3);padding:8px 24px;background:var(--bg2);
                 border-bottom:1px solid var(--b);text-align:right}
  `;

  function renderPair(p, rank) {
    const ev = p.globalBest?.ev;
    const evStr = ev != null ? (ev > 0 ? "+" : "") + fmt(ev, 3) + "R/trade" : "Te weinig data";
    const evBadge = ev == null ? "badge-o" : ev > 0 ? "badge-g" : "badge-r";
    const slDir = p.slLock?.direction;
    const slBadge = slDir === "up" ? "badge-g" : slDir === "down" ? "badge-r" : "badge-b";
    const slText = slDir === "up" ? "↑ SL Groter" : slDir === "down" ? "↓ SL Kleiner" : "= SL Huidig";
    const sessHtml = ["asia","london","ny"].map(sess => {
      const sd = p.sessionBreakdown.find(s => s.sess === sess);
      const sev = sd?.best?.ev;
      const locked = sd?.lock;
      return `<div class="sess-box${locked ? " locked" : ""}">
        <div class="sname">${sessionLabel(sess)}${locked ? " 🔒" : ""}</div>
        <div class="sev" style="color:${evColor(sev)}">${sev != null ? (sev>0?"+":"")+fmt(sev,2)+"R" : "—"}</div>
        <div class="srr">${sd?.trades || 0} trades · ${sd?.best?.rr != null ? "TP "+sd.best.rr+"R" : "—"}${locked ? "<br>Lock: "+locked.lockedRR+"R" : ""}</div>
      </div>`;
    }).join("");
    return `<div class="pair-card">
      <div class="pair-hdr">
        <span class="pair-rank">#${rank}</span>
        <span class="pair-sym">${p.sym}</span>
        <span class="badge ${evBadge}">${evStr}</span>
        ${p.slLock ? `<span class="badge ${slBadge}">${slText}</span>` : ""}
        ${p.ghostCount > 0 ? `<span class="badge badge-b">👻 ${p.ghostCount} ghost pending</span>` : ""}
        <span style="margin-left:auto;font-size:11px;color:var(--t3)">${p.total} trades</span>
      </div>
      <div class="pair-body">
        <div class="pair-section">
          <h4>Beste TP (globaal)</h4>
          ${p.globalBest ? `
          <div class="kv"><span class="k">TP target</span><span class="v" style="color:var(--acc)">${p.globalBest.rr}R</span></div>
          <div class="kv"><span class="k">EV</span><span class="v" style="color:${evColor(p.globalBest.ev)}">${ev>0?"+":""}${fmt(p.globalBest.ev,3)}R</span></div>
          <div class="kv"><span class="k">Winrate</span><span class="v">${(p.globalBest.wr*100).toFixed(1)}%</span></div>
          <div class="kv"><span class="k">Wins</span><span class="v">${p.globalBest.wins}/${p.globalBest.total}</span></div>
          <div class="kv"><span class="k">Avg MaxRR</span><span class="v" style="color:${rrColor(p.avgMaxRR)}">${fmt(p.avgMaxRR)}R</span></div>
          ` : `<div class="empty">Te weinig data (&lt;3 trades)</div>`}
        </div>
        <div class="pair-section">
          <h4>SL Analyse</h4>
          ${p.slLock ? `
          <div class="kv"><span class="k">Multiplier</span><span class="v">${p.slLock.multiplier}×</span></div>
          <div class="kv"><span class="k">Advies</span><span class="v" style="color:${slDir==="up"?"var(--g)":slDir==="down"?"var(--r)":"var(--acc)"}">${slText}</span></div>
          <div class="kv"><span class="k">EV bij lock</span><span class="v" style="color:${evColor(p.slLock.evAtLock)}">${fmt(p.slLock.evAtLock,3)}R</span></div>
          <div class="kv"><span class="k">Trades</span><span class="v">${p.slLock.lockedTrades}</span></div>
          ` : `<div class="empty">Geen SL analyse</div>`}
        </div>
        <div class="pair-section">
          <h4>Per Sessie</h4>
          <div class="sess-grid">${sessHtml}</div>
        </div>
      </div>
    </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>FTMO PRO Dashboard v4.4</title>
<style>${css}</style>
</head>
<body>
<div class="top">
  <div class="logo"><div class="dot"></div>FTMO PRO v4.4</div>
  <div class="time">📅 ${brusselsDate} &nbsp;⏰ ${brusselsTime} &nbsp;·&nbsp; 🔄 60s</div>
</div>
<div class="nav">
  <a href="#overview">📊 Overview</a>
  <a href="#pairs">📈 Pairs (${pairStats.length})</a>
  <a href="#open">🟢 Open (${totalOpen})</a>
  <a href="#ghosts">👻 Ghosts (${totalGhosts})</a>
  <a href="#log">📋 Log</a>
</div>
<div class="update-info">Render: ${brusselsTime} &nbsp;·&nbsp; ${totalTrades} trades &nbsp;·&nbsp; auto-refresh 60s</div>
<div class="page">
  <div class="sec" id="overview">
    <div class="sec-title">📊 Overview</div>
    <div class="cards">
      <div class="card"><div class="v" style="color:var(--acc)">${totalTrades}</div><div class="l">Trades in DB</div></div>
      <div class="card"><div class="v">${totalPairs}</div><div class="l">Pairs</div></div>
      <div class="card"><div class="v" style="color:var(--g)">${posEVPairs}</div><div class="l">Positieve EV</div><div class="s">van ${totalPairs} pairs</div></div>
      <div class="card"><div class="v" style="color:${avgEV>0?"var(--g)":"var(--r)"}">${avgEV>0?"+":""}${fmt(avgEV,3)}R</div><div class="l">Gemiddelde EV</div></div>
      <div class="card"><div class="v" style="color:var(--o)">${totalOpen}</div><div class="l">Open posities</div></div>
      <div class="card"><div class="v" style="color:var(--pu)">${totalGhosts}</div><div class="l">Ghost trackers</div></div>
    </div>
  </div>
  <div class="sec" id="pairs">
    <div class="sec-title">📈 Analyse per Pair — gesorteerd op EV</div>
    <div class="pair-grid">
      ${pairStats.length ? pairStats.map((p,i) => renderPair(p, i+1)).join("") : `<div class="empty">Geen trade data beschikbaar</div>`}
    </div>
  </div>
  <div class="sec" id="open">
    <div class="sec-title">🟢 Open Posities</div>
    ${openPos.length ? `<table>
      <tr><th>Pair</th><th>Dir</th><th>Sessie</th><th>Entry</th><th>SL</th><th>Risk €</th><th>Lots</th><th>MaxRR</th><th>Geopend</th></tr>
      ${openPos.map(p => `<tr>
        <td style="color:var(--acc);font-weight:700">${p.symbol}</td>
        <td><span class="badge ${p.direction==="buy"?"badge-g":"badge-r"}">${p.direction.toUpperCase()}</span></td>
        <td>${sessionLabel(p.session)}</td>
        <td>${fmt(p.entry, 4)}</td><td>${fmt(p.sl, 4)}</td>
        <td style="color:var(--o)">€${fmt(p.riskEUR, 0)}</td>
        <td>${fmt(p.lots, 2)}</td>
        <td style="color:${rrColor(p.maxRR)}">${fmtRR(p.maxRR)}</td>
        <td>${timeAgo(p.openedAt)}</td>
      </tr>`).join("")}
    </table>` : `<div class="empty">Geen open posities</div>`}
  </div>
  <div class="sec" id="ghosts">
    <div class="sec-title">👻 Actieve Ghost Trackers</div>
    ${activeGhosts.length ? `<table>
      <tr><th>Pair</th><th>Dir</th><th>Sessie</th><th>MaxRR bij close</th><th>Beste RR nu</th><th>Elapsed</th><th>Resterend</th></tr>
      ${activeGhosts.map(g => `<tr>
        <td style="color:var(--acc);font-weight:700">${g.sym}</td>
        <td><span class="badge ${g.dir==="buy"?"badge-g":"badge-r"}">${g.dir.toUpperCase()}</span></td>
        <td>${sessionLabel(g.session)}</td>
        <td style="color:${rrColor(g.maxRRAtClose)}">${fmtRR(g.maxRRAtClose)}</td>
        <td style="color:${rrColor(g.bestRR)}">${fmtRR(g.bestRR)}</td>
        <td>${g.elapsedMin}m</td>
        <td>${g.remainMin > 0 ? g.remainMin+"m" : "Verlopen"}</td>
      </tr>`).join("")}
    </table>` : `<div class="empty">Geen actieve ghost trackers</div>`}
  </div>
  <div class="sec" id="log">
    <div class="sec-title">📋 Recente Webhook Events (laatste 20)</div>
    ${recentWebhooks.length ? `<table>
      <tr><th>Tijd</th><th>Type</th><th>Pair</th><th>Dir</th><th>Sessie</th><th>Risk €</th><th>Lots</th></tr>
      ${recentWebhooks.map(h => `<tr>
        <td style="color:var(--t3)">${timeAgo(h.ts)}</td>
        <td><span class="badge ${h.type==="SUCCESS"?"badge-g":h.type==="ERROR"?"badge-r":"badge-b"}">${h.type||"?"}</span></td>
        <td style="color:var(--acc)">${h.symbol||"—"}</td>
        <td>${h.direction||"—"}</td>
        <td>${sessionLabel(h.session)}</td>
        <td>${h.riskEUR != null ? "€"+fmt(h.riskEUR,0) : "—"}</td>
        <td>${h.lots != null ? fmt(h.lots,2) : "—"}</td>
      </tr>`).join("")}
    </table>` : `<div class="empty">Geen webhook events</div>`}
  </div>
</div>
<a href="#" class="sticker">↑</a>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.use((req, res) => {
  const BASE = req.protocol+"://"+req.get("host");
  res.status(404).json({
    error: "Route niet gevonden",
    geprobeerd: req.method+" "+req.originalUrl,
    beschikbare_routes: {
      "GET  /":                             BASE+"/",
      "GET  /dashboard":                    BASE+"/dashboard",
      "GET  /status":                       BASE+"/status",
      "GET  /live/positions":               BASE+"/live/positions",
      "GET  /live/ghosts":                  BASE+"/live/ghosts",
      "GET  /analysis/rr":                  BASE+"/analysis/rr",
      "GET  /analysis/sessions":            BASE+"/analysis/sessions",
      "GET  /analysis/equity-curve":        BASE+"/analysis/equity-curve?hours=24",
      "GET  /history":                      BASE+"/history?limit=100",
      "GET  /tp-locks":                     BASE+"/tp-locks",
      "GET  /sl-locks":                     BASE+"/sl-locks",
      "GET  /research/tp-optimizer":        BASE+"/research/tp-optimizer",
      "GET  /research/tp-optimizer/sessie": BASE+"/research/tp-optimizer/sessie",
      "GET  /research/sl-optimizer":        BASE+"/research/sl-optimizer",
      "POST /webhook":                      "TradingView alert → MT5",
      "POST /close":                        "Positie manueel sluiten",
    }
  });
});

// ══════════════════════════════════════════════════════════════
// STARTUP  ← [FIX v4.4] app.listen() was volledig afwezig
//            → oorzaak van "Application failed to respond" op Railway
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    console.log("🚀 FTMO Webhook Server v4.4 — opstarten...");

    // 1. DB schema
    await initDB();

    // 2. Trade history laden
    const dbTrades = await loadAllTrades();
    closedTrades.push(...dbTrades);
    console.log(`📂 ${dbTrades.length} trades geladen uit Postgres`);

    // 3. TP/SL configs laden
    const savedTP = await loadTPConfig();
    Object.assign(tpLocks, savedTP);
    console.log(`🔒 ${Object.keys(savedTP).length} TP locks geladen`);

    const savedSL = await loadSLConfig();
    Object.assign(slLocks, savedSL);
    console.log(`📐 ${Object.keys(savedSL).length} SL configs geladen`);

    // 4. Open posities herstellen na Railway restart
    await restoreOpenPositionsFromMT5();

    // 5. Server binden aan PORT
    app.listen(PORT, () => {
      console.log(`✅ Server luistert op port ${PORT}`);
      console.log(`📊 Dashboard: /dashboard`);
    });

  } catch (err) {
    console.error("❌ Startup mislukt:", err.message);
    process.exit(1);
  }
}

start();
