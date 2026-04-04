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
// WIJZIGINGEN v4.3 (t.o.v. v4.2):
//  ✅ [FIX] Min lot cap = baseRisk per type, niet vaste €60
//           → Indices buiten Asia worden niet langer fout geblokkeerd
//  ✅ [FIX] Restart recovery: openPositions her-initialiseren vanuit MT5
//           → Weesposities na Railway restart worden niet meer gemist
//  ✅ [FEAT] Forex consolidatie: half risk bij 1–2 open, blok bij ≥3
//           → Zelfde pair + richting: trades 2 en 3 aan 50% risk
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
const GHOST_INTERVAL_RECENT_MS = 60 * 1000;       // < 6u: elke 60s
const GHOST_INTERVAL_OLD_MS    = 5 * 60 * 1000;   // ≥ 6u: elke 5min
const GHOST_OLD_THRESHOLD_MS   = 6 * 3600 * 1000; // 6u grens

// ── RR / SL LEVELS ────────────────────────────────────────────
const RR_LEVELS    = [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25];
const SL_MULTIPLES = [0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

const SL_PROVEN_MULT           = 0.5;
const STOCK_SL_SPREAD_MULT     = 1.5;
// v4.3: spread max 1/3 van SL-afstand (was 1/2)
const STOCK_MAX_SPREAD_FRACTION = 0.333;

// Forex anti-consolidatie
const FOREX_MAX_SAME_DIR        = 3;   // ≥ 3 = blok
const FOREX_HALF_RISK_THRESHOLD = 1;   // ≥ 1 = half risk (nieuw v4.3)

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

// [v4.4] FTMO dagelijkse verlies-limiet UITGESCHAKELD — alle trades worden doorgelaten
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
// SYMBOL MAP — TV-naam → MT5-symbool + type
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
  // JPY pairs
  "USDJPY": 0.05, "EURJPY": 0.05, "GBPJPY": 0.05,
  "AUDJPY": 0.05, "CADJPY": 0.05, "NZDJPY": 0.05, "CHFJPY": 0.05,
};

const MIN_STOP_STOCK_PCT = 0.001; // 0.1% van entry

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
  const r = await fetch(`${META_BASE}/positions`, { headers: {"auth-token": META_API_TOKEN} });
  if (!r.ok) throw new Error(`positions ${r.status}`);
  return r.json();
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
// [FIX v4.3] RESTART RECOVERY — openPositions her-initialiseren
// ── Na Railway restart is openPositions{} leeg.
//    Posities die vóór de restart open stonden op MT5 worden nooit
//    herkend als gesloten → "weesposities".
//    Deze functie laadt alle live MT5 posities bij startup en
//    registreert ze als minimale placeholders zodat syncPositions()
//    hun close wél detecteert.
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
      if (openPositions[id]) continue; // al geregistreerd

      // Zoek TV-symbool op basis van MT5-symbool
      const tvSym = Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k].mt5 === pos.symbol) || pos.symbol;
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
        restoredAfterRestart: true, // markering voor debugging
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
// FOREX ANTI-CONSOLIDATIE (v4.3 — half risk bij count 1–2)
// ══════════════════════════════════════════════════════════════
/**
 * Controleert forex consolidatie voor een pair+richting.
 * @returns {{ blocked: boolean, halfRisk: boolean, count: number }}
 *   blocked:  true als count >= FOREX_MAX_SAME_DIR (3)  → SKIP
 *   halfRisk: true als count >= FOREX_HALF_RISK_THRESHOLD (1) → 50% risk
 */
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

// ── SPREAD GUARD — aandelen ───────────────────────────────────
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

/**
 * [FIX v4.3] Lotsize berekening — cap = baseRisk per type.
 *
 * PROBLEEM (v4.2): effectiveCap was altijd RISK_MINLOT_CAP (€60) buiten Asia.
 *   → Index buiten Asia: risk=€200, lots=1, minCost=€200 > €60 → SKIP. FOUT.
 *
 * FIX: cap = baseRisk van dat type. Voor index = €200. Voor forex = €15.
 *   Dit garandeert dat een order met exact het geconfigureerde risico
 *   altijd door de cap komt, ongeacht sessie of type.
 *
 * TP lock ×4:
 *   - Bij bewezen TP lock: risk = base×4 → cap = base×4 (consistent)
 *   - Index normaal: cap €200 | Index TP lock: cap €800
 *   - Forex normaal: cap €15  | Forex TP lock: cap €60
 */
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

  // [FIX v4.3] Cap = baseRisk van dat type, niet de vaste €60
  const baseRisk      = RISK[type] || 30;
  const isTPLockRisk  = risk >= baseRisk * TP_LOCK_RISK_MULT;
  const effectiveCap  = isTPLockRisk
    ? baseRisk * TP_LOCK_RISK_MULT   // bijv. index: €800, forex: €60
    : baseRisk;                       // bijv. index: €200, forex: €15

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
// GHOST TRACKER — post-close prijsvolging (24u)
// v4.3: prioriteit batching — recent < 6u → 60s, oud ≥ 6u → 5min
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

      // Kies interval op basis van leeftijd
      const interval = elapsed < GHOST_OLD_THRESHOLD_MS
        ? GHOST_INTERVAL_RECENT_MS
        : GHOST_INTERVAL_OLD_MS;
      currentTimer = setTimeout(tick, interval);
      if (ghostTrackers[ghostId]) ghostTrackers[ghostId].timer = currentTimer;
    } catch (e) { console.warn(`⚠️ Ghost ${ghostId}:`, e.message); }
  }

  currentTimer = setTimeout(tick, GHOST_INTERVAL_RECENT_MS);
  ghostTrackers[ghostId] = { trade: closedTrade, timer: currentTimer, startedAt, bestPrice };

  // Failsafe
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
// TP LOCK ENGINE (sessie-aware + sub-1R)
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
// SL LOCK ENGINE (ghost-driven direction + READONLY)
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

    // ── [v4.3] Forex consolidatie — half risk bij 1–2 open, blok bij ≥3
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

    // ── SL aanpassing ─────────────────────────────────────────
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

    // ── Spread guard voor aandelen ────────────────────────────
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

    // [v4.3] Forex half risk — pas toe na TP lock boost zodat
    // de boost niet verloren gaat maar wél gehalveerd wordt
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
      capFix:          "✅ Min lot cap = baseRisk per type (niet vaste €60) — indices buiten Asia werken nu",
      restartRecovery: "✅ openPositions her-initialiseren vanuit MT5 bij startup — geen weesposities meer",
      forexHalfRisk:   `✅ Forex consolidatie: 50% risk bij 1–${FOREX_MAX_SAME_DIR-1} open, blok bij ≥${FOREX_MAX_SAME_DIR}`,
    },
    capPerType: Object.fromEntries(Object.entries(RISK).map(([t,v]) => [t, `€${v} normaal | €${v*TP_LOCK_RISK_MULT} bij TP lock`])),
    forexConsolidatie: `max ${FOREX_MAX_SAME_DIR} trades (1–${FOREX_MAX_SAME_DIR-1}: half risk | ≥${FOREX_MAX_SAME_DIR}: geblokkeerd)`,
    minLotCap:         `per type (bijv. index €${RISK.index} normaal → €${RISK.index*TP_LOCK_RISK_MULT} bij TP lock)`,
    tpLock:            `sessie-aware — risk ×${TP_LOCK_RISK_MULT} ook stocks`,
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
      "GET  /research/tp-optimizer":        "TP optimizer (globaal, incl. sub-1R)",
      "GET  /research/tp-optimizer/sessie": "TP optimizer per sessie",
      "GET  /research/sl-optimizer":        "SL optimizer (direction + READONLY)",
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
      subRRBest: subRRBest.rr!==null&&subRRBest.ev>0
        ? {rr:`${subRRBest.rr}R`,ev:subRRBest.ev} : null,
      recommendation: best.ev>0
        ? `Target: ${best.rr}R (EV: +${best.ev}R/trade)` : "EV negatief",
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
  try { const db=await loadSnapshots(hours); if (db.length) return res.json({hours,count:db.length,source:"postgres",snapshots:db}); } catch(e){}
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

// ── DASHBOARD ─────────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  const SECRET = WEBHOOK_SECRET;
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FTMO Pro Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07090d;--bg1:#0c1018;--bg2:#111820;--bg3:#18212d;
  --b:#1c2a38;--b2:#243342;
  --t:#c9d8e8;--t2:#6a8098;--t3:#374d5e;
  --acc:#2dd4f4;--acc2:#0e7fa0;
  --g:#22d18b;--g2:#0b4e33;
  --r:#f26b62;--r2:#4f1c18;
  --o:#f0a050;--o2:#4e2c0a;
  --pu:#b88ff0;--pu2:#2e1c50;
  --ye:#e3b341;
  --mono:'JetBrains Mono',monospace;
  --sans:'Segoe UI',system-ui,sans-serif;
}
html,body{height:100%;overflow:hidden}
body{font-family:var(--mono);background:var(--bg);color:var(--t);font-size:12.5px;display:flex;flex-direction:column}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:var(--bg1)}
::-webkit-scrollbar-thumb{background:var(--b2);border-radius:3px}

/* TOPBAR */
.topbar{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:48px;background:var(--bg1);border-bottom:1px solid var(--b);z-index:50}
.logo{font-family:var(--sans);font-weight:800;font-size:14px;color:var(--acc);letter-spacing:-.02em;display:flex;align-items:center;gap:8px}
.logo-dot{width:7px;height:7px;border-radius:50%;background:var(--g);box-shadow:0 0 6px var(--g);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.topbar-mid{display:flex;gap:4px}
.topbar-right{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--t3)}
.clock{font-size:11px;color:var(--t2);background:var(--bg2);padding:3px 9px;border-radius:4px;border:1px solid var(--b)}
.btn{font-family:var(--mono);font-size:11px;cursor:pointer;padding:4px 12px;border-radius:4px;border:1px solid var(--b2);background:var(--bg3);color:var(--acc);transition:.15s;white-space:nowrap}
.btn:hover{background:var(--acc2);color:#fff;border-color:var(--acc)}
.btn.danger{color:var(--r);border-color:var(--r2)}
.btn.danger:hover{background:var(--r2);color:var(--r)}

/* TABS */
.tabs{flex-shrink:0;display:flex;background:var(--bg1);border-bottom:1px solid var(--b);padding:0 20px;overflow-x:auto}
.tab{font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:9px 16px;cursor:pointer;color:var(--t3);border-bottom:2px solid transparent;white-space:nowrap;transition:.15s}
.tab:hover{color:var(--t)}
.tab.on{color:var(--acc);border-bottom-color:var(--acc)}

/* PANELS */
.panels{flex:1;overflow:hidden;position:relative}
.panel{position:absolute;inset:0;overflow-y:auto;padding:18px 20px;display:none}
.panel.on{display:block}

/* STAT ROW */
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.sc{flex:1 1 130px;background:var(--bg1);border:1px solid var(--b);border-radius:7px;padding:12px 14px}
.sc .v{font-family:var(--sans);font-size:24px;font-weight:800;line-height:1;margin-bottom:3px}
.sc .l{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em}
.sc .s{font-size:10px;color:var(--t2);margin-top:2px}
.g{color:var(--g)}.r{color:var(--r)}.o{color:var(--o)}.a{color:var(--acc)}.pu{color:var(--pu)}.ye{color:var(--ye)}

/* SECTION */
.sh{display:flex;align-items:center;gap:8px;margin:14px 0 8px;color:var(--t2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.sh::before{content:'';width:3px;height:12px;background:var(--acc);border-radius:2px}

/* TABLE */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:5px 9px;color:var(--t3);font-size:10px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--b);font-weight:600;white-space:nowrap;text-align:left}
td{padding:5px 9px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.015)}
.tr{text-align:right}.tc{text-align:center}
.mono{font-family:var(--mono)}
.bold{font-weight:700}
.dim{color:var(--t3)}

/* BADGES */
.bd{display:inline-block;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:600;white-space:nowrap}
.bd.buy{background:#0c2b1d;color:var(--g);border:1px solid #154030}
.bd.sell{background:#2b0c0c;color:var(--r);border:1px solid #401515}
.bd.info{background:var(--bg3);color:var(--t2);border:1px solid var(--b)}
.bd.acc{background:#091e28;color:var(--acc);border:1px solid #103040}
.bd.warn{background:var(--o2);color:var(--o);border:1px solid #6e3a0a}
.bd.pu{background:var(--pu2);color:var(--pu);border:1px solid #3e2470}
.bd.good{background:var(--g2);color:var(--g);border:1px solid #155038}
.bd.bad{background:var(--r2);color:var(--r);border:1px solid #601818}
.bd.ye{background:#2e2800;color:var(--ye);border:1px solid #504200}

/* PAIR ACCORDION */
.pairs{display:flex;flex-direction:column;gap:8px}
.pc{background:var(--bg1);border:1px solid var(--b);border-radius:7px;overflow:hidden}
.ph{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;background:var(--bg2);transition:.15s}
.ph:hover{background:var(--bg3)}
.psym{font-family:var(--sans);font-size:13px;font-weight:800;min-width:85px;color:var(--t)}
.pbadges{display:flex;gap:5px;flex-wrap:wrap}
.pstats{display:flex;gap:18px;margin-left:auto;align-items:center}
.ps .v{font-size:13px;font-weight:700;text-align:right}
.ps .l{font-size:9px;color:var(--t3);text-align:right}
.chev{color:var(--t3);font-size:11px;transition:.2s;flex-shrink:0}
.ph.open .chev{transform:rotate(180deg)}
.pb{display:none;padding:14px}
.pb.open{display:block}

/* INNER TABS */
.it{display:flex;gap:0;border-bottom:1px solid var(--b);margin-bottom:12px;overflow-x:auto}
.itb{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:6px 12px;cursor:pointer;color:var(--t3);border-bottom:2px solid transparent;white-space:nowrap;transition:.15s}
.itb:hover{color:var(--t)}
.itb.on{color:var(--acc);border-bottom-color:var(--acc)}
.itp{display:none}
.itp.on{display:block}

/* EV TABLE */
tr.best td{background:rgba(34,209,139,.04)}
tr.best td:first-child{border-left:2px solid var(--g);padding-left:7px}
.evbar{width:70px;height:3px;background:var(--b);border-radius:2px;overflow:hidden;display:inline-block;vertical-align:middle}
.evbf{height:100%;border-radius:2px}

/* SESSION CARDS */
.sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-bottom:10px}
.scard{background:var(--bg2);border:1px solid var(--b);border-radius:6px;padding:10px 12px}
.scard-name{font-family:var(--sans);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--t2);margin-bottom:7px}
.srow{display:flex;justify-content:space-between;font-size:11px;margin:2px 0}
.srow .k{color:var(--t3)}.srow .v{font-weight:600}

/* ADVICE */
.adv{background:var(--bg2);border:1px solid var(--b2);border-radius:6px;padding:10px 12px;margin-bottom:10px}
.advr{display:flex;align-items:flex-start;gap:7px;font-size:11.5px;margin:3px 0}
.advr .icon{flex-shrink:0;font-size:13px;margin-top:1px}
strong.acc{color:var(--acc)}strong.g{color:var(--g)}strong.r{color:var(--r)}strong.o{color:var(--o)}

/* GHOST */
.ghost-row{background:var(--bg2);border:1px solid var(--b);border-radius:6px;padding:10px 14px;margin-bottom:6px;display:grid;grid-template-columns:110px 1fr auto;gap:12px;align-items:center}
.ghost-sym{font-family:var(--sans);font-size:13px;font-weight:800}
.ghost-bar{height:5px;background:var(--b);border-radius:3px;overflow:hidden;margin-top:4px}
.ghost-bf{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--pu),var(--acc))}
.ghost-lbl{font-size:10px;color:var(--t3);margin-bottom:2px}
.ghost-rr{text-align:right}
.ghost-rr .big{font-size:18px;font-weight:800}
.ghost-rr .small{font-size:10px;color:var(--t3)}

/* FILTER */
.fr{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.fr label{font-size:10px;color:var(--t3)}
.fr select,.fr input{font-family:var(--mono);font-size:11px;background:var(--bg2);border:1px solid var(--b);color:var(--t);padding:4px 9px;border-radius:4px;outline:none}
.fr select:focus,.fr input:focus{border-color:var(--acc2)}

/* EMPTY / LOADING */
.empty{padding:28px;text-align:center;color:var(--t3);font-size:12px}
.empty div{font-size:24px;margin-bottom:6px}
.spin{display:inline-block;width:18px;height:18px;border:2px solid var(--b);border-top-color:var(--acc);border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.loading{padding:32px;text-align:center;color:var(--t3)}

/* LOCK CARDS */
.lc{background:var(--bg2);border:1px solid var(--b);border-radius:6px;padding:10px 13px;margin-bottom:6px}
.lc-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.lc-sym{font-family:var(--sans);font-weight:800;font-size:13px}
.lc-sub{display:flex;gap:12px;flex-wrap:wrap}
.lc-item{font-size:11px}.lc-item .k{color:var(--t3)}.lc-item .v{font-weight:600;margin-left:4px}

@media(max-width:700px){.topbar-mid{display:none}.pstats{display:none}.panels{overflow:auto}}
</style>
</head>
<body>

<!-- TOPBAR -->
<div class="topbar">
  <div class="logo"><div class="logo-dot"></div>FTMO PRO</div>
  <div class="topbar-mid">
    <button class="btn" onclick="loadAll()">↻ Refresh</button>
    <button class="btn danger" onclick="confirmReset()">🗑 Reset TP Locks</button>
  </div>
  <div class="topbar-right">
    <span id="last-update" style="font-size:10px;color:var(--t3)"></span>
    <div class="clock" id="clk">--:--:--</div>
  </div>
</div>

<!-- TABS -->
<div class="tabs">
  <div class="tab on"  onclick="tab('ov')">📊 Overview</div>
  <div class="tab"     onclick="tab('pairs')">📈 Per Pair</div>
  <div class="tab"     onclick="tab('ghosts')">👻 Ghost Tracker</div>
  <div class="tab"     onclick="tab('arch')">🗃 Archief</div>
  <div class="tab"     onclick="tab('hist')">📋 Webhook Log</div>
  <div class="tab"     onclick="tab('locks')">🔒 Locks</div>
  <div class="tab"     onclick="tab('equity')">📈 Equity</div>
</div>

<!-- PANELS -->
<div class="panels">

  <!-- OVERVIEW -->
  <div class="panel on" id="p-ov">
    <div class="stats" id="ov-stats"><div class="loading"><div class="spin"></div></div></div>
    <div id="ov-body"></div>
  </div>

  <!-- PAIRS -->
  <div class="panel" id="p-pairs">
    <div class="sh" style="margin-top:0">Analyse per Pair — klik om uit te klappen</div>
    <div class="pairs" id="pairs-grid"><div class="loading"><div class="spin"></div></div></div>
  </div>

  <!-- GHOSTS -->
  <div class="panel" id="p-ghosts">
    <div class="sh" style="margin-top:0">Actieve Ghost Trackers</div>
    <div id="ghost-active"></div>
    <div class="sh">Gesloten Trades — Ghost Nog Pending</div>
    <div class="tw"><table>
      <thead><tr><th>Pair</th><th>Dir</th><th>Sessie</th><th class="tr">MaxRR</th><th class="tr">Entry</th><th>Open</th><th>Gesloten</th></tr></thead>
      <tbody id="ghost-pending"></tbody>
    </table></div>
  </div>

  <!-- ARCHIVE -->
  <div class="panel" id="p-arch">
    <div class="fr">
      <label>Pair</label><select id="af-sym" onchange="renderArch()"><option value="">Alle</option></select>
      <label>Sessie</label>
      <select id="af-sess" onchange="renderArch()">
        <option value="">Alle</option><option value="asia">Asia</option>
        <option value="london">London</option><option value="ny">New York</option>
      </select>
      <label>Richting</label>
      <select id="af-dir" onchange="renderArch()">
        <option value="">Alle</option><option value="buy">Buy</option><option value="sell">Sell</option>
      </select>
      <label>Min RR</label>
      <input type="number" id="af-rr" placeholder="0" style="width:70px" onchange="renderArch()">
      <span id="af-info" style="font-size:10px;color:var(--t3);margin-left:4px"></span>
    </div>
    <div class="tw" style="max-height:calc(100vh - 160px);overflow-y:auto">
      <table>
        <thead><tr>
          <th>#</th><th>Pair</th><th>Dir</th><th>Sessie</th>
          <th class="tr">Entry</th><th class="tr">SL</th><th class="tr">MaxRR</th><th class="tr">TrueMaxRR</th>
          <th class="tr">Risk€</th><th class="tr">Lots</th><th>Ghost</th><th>Open</th><th>Gesloten</th>
        </tr></thead>
        <tbody id="arch-body"></tbody>
      </table>
    </div>
  </div>

  <!-- HISTORY -->
  <div class="panel" id="p-hist">
    <div class="sh" style="margin-top:0">Webhook Log — laatste 100 events</div>
    <div class="tw" style="max-height:calc(100vh - 100px);overflow-y:auto">
      <table>
        <thead><tr>
          <th>Tijd</th><th>Type</th><th>Pair</th><th>Dir</th><th>Sessie</th>
          <th class="tr">Lots</th><th class="tr">Risk€</th><th>TP</th><th>SL aanp.</th><th>Boost</th>
        </tr></thead>
        <tbody id="hist-body"></tbody>
      </table>
    </div>
  </div>

  <!-- LOCKS -->
  <div class="panel" id="p-locks">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div class="sh" style="margin-top:0">TP Locks per Sessie</div>
        <div id="tp-locks"></div>
      </div>
      <div>
        <div class="sh" style="margin-top:0">SL Analyses</div>
        <div id="sl-locks"></div>
      </div>
    </div>
  </div>

  <!-- EQUITY -->
  <div class="panel" id="p-equity">
    <div class="sh" style="margin-top:0">Equity Curve — laatste 24u</div>
    <canvas id="eq-canvas" style="width:100%;max-height:320px"></canvas>
    <div id="eq-stats" class="stats" style="margin-top:14px"></div>
  </div>

</div><!-- /panels -->

<script>
const S = '${SECRET}';
const SESS = ['asia','london','ny'];
const SL = {asia:'Asia 02–08',london:'London 08–15:30',ny:'NY 15:30–20',buiten_venster:'Buiten venster'};
const RR = [0.2,0.4,0.6,0.8,1,1.5,2,2.5,3,4,5,6,7,8,10,12,15,20,25];

let D = {pos:[],closed:[],tpL:{},slL:{},ghosts:[],hist:[],equity:[]};
let openedPairs = new Set();
let activeTab = 'ov';

// CLOCK
setInterval(()=>{
  document.getElementById('clk').textContent =
    new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour12:false});
},1000);

// TAB SWITCH
function tab(name){
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t,i)=>{
    t.classList.toggle('on',['ov','pairs','ghosts','arch','hist','locks','equity'][i]===name);
  });
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('on',p.id==='p-'+name));
  if(name==='arch') renderArch();
}

// API
async function api(url){
  try{const r=await fetch(url,{headers:{'x-secret':S}});return r.ok?r.json():null}
  catch{return null}
}

// LOAD ALL
async function loadAll(){
  document.getElementById('last-update').textContent='Laden...';
  const [pos,rr,tpLocks,slLocks,ghosts,hist,equity] = await Promise.all([
    api('/live/positions'),
    api('/analysis/rr'),
    api('/tp-locks'),
    api('/sl-locks'),
    api('/live/ghosts'),
    api('/history?limit=100'),
    api('/analysis/equity-curve?hours=24'),
  ]);
  if(pos)    D.pos = pos.positions||[];
  if(tpLocks)D.tpL = tpLocks.locksBySymbol||{};
  if(slLocks)D.slL = (slLocks.analyses||[]).reduce((a,x)=>({...a,[x.symbol]:x}),{});
  if(ghosts) D.ghosts = ghosts.ghosts||[];
  if(hist)   D.hist = hist.history||[];
  if(equity) D.equity = equity.snapshots||[];

  // flatten closed trades
  D.closed=[];
  if(rr?.bySymbol){
    for(const [sym,g] of Object.entries(rr.bySymbol)){
      for(const t of (g.details||[])) D.closed.push({...t,symbol:sym});
    }
  }
  D.closed.sort((a,b)=>new Date(b.closedAt||0)-new Date(a.closedAt||0));

  document.getElementById('last-update').textContent =
    'Update: '+new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour12:false});

  renderAll();
}

function renderAll(){
  renderOv(); renderPairs(); renderGhosts();
  renderHist(); renderLocks(); renderEquity();
  populateArchFilter();
}

// ── HELPERS ─────────────────────────────────────────────────────
function fmtRR(v){
  if(v==null||v===undefined)return '<span class="dim">—</span>';
  const n=parseFloat(v);
  const cls=n>=2?'g':n>=1?'a':n>=0?'o':'r';
  return '<span class="'+cls+'">'+n.toFixed(2)+'R</span>';
}
function fmtDate(s){
  if(!s)return'<span class="dim">—</span>';
  return new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',dateStyle:'short',timeStyle:'short'});
}
function evColor(ev){return ev>0.5?'var(--g)':ev>0?'var(--a)':ev>-0.3?'var(--o)':'var(--r)'}

function calcEV(trades){
  return RR.map(rr=>{
    const best=trades.filter(t=>(t.trueMaxRR??t.maxRR??0)>=rr).length;
    const wr=trades.length?best/trades.length:0;
    const ev=parseFloat((wr*rr-(1-wr)).toFixed(3));
    return{rr,wins:best,total:trades.length,wr,ev};
  });
}

// ── OVERVIEW ────────────────────────────────────────────────────
function renderOv(){
  const {pos,closed,ghosts,tpL,slL}=D;
  const total=closed.length;
  const wins=closed.filter(t=>(t.trueMaxRR??t.maxRR??0)>=1).length;
  const wr=total?(wins/total*100).toFixed(1):'—';
  const avgRR=total?(closed.reduce((a,t)=>a+(t.maxRR||0),0)/total).toFixed(2):'—';
  const tTrue=closed.filter(t=>t.trueMaxRR!=null);
  const avgTrue=tTrue.length?(tTrue.reduce((a,t)=>a+t.trueMaxRR,0)/tTrue.length).toFixed(2):'—';
  const gPend=closed.filter(t=>t.trueMaxRR===null).length;
  const syms=[...new Set(closed.map(t=>t.symbol))].length;
  const tpCnt=Object.values(tpL).reduce((a,s)=>a+Object.keys(s).length,0);
  const slCnt=Object.keys(slL).length;
  const evAll=calcEV(closed);
  const bestEV=evAll.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-99,rr:0});

  document.getElementById('ov-stats').innerHTML=\`
    <div class="sc"><div class="v a">\${pos.length}</div><div class="l">Open Posities</div></div>
    <div class="sc"><div class="v">\${total}</div><div class="l">Gesloten Trades</div></div>
    <div class="sc"><div class="v \${parseFloat(wr)>=50?'g':'r'}">\${wr}%</div><div class="l">Winrate ≥1R</div></div>
    <div class="sc"><div class="v">\${avgRR}R</div><div class="l">Gem. MaxRR</div></div>
    <div class="sc"><div class="v a">\${avgTrue}R</div><div class="l">Gem. TrueMaxRR</div><div class="s">\${tTrue.length} afgerond</div></div>
    <div class="sc"><div class="v o">\${gPend}</div><div class="l">Ghost Pending</div><div class="s">\${ghosts.length} actief</div></div>
    <div class="sc"><div class="v">\${syms}</div><div class="l">Pairs</div></div>
    <div class="sc"><div class="v a">\${tpCnt}</div><div class="l">TP Locks</div><div class="s">\${slCnt} SL analyses</div></div>
    <div class="sc"><div class="v \${bestEV.ev>0?'g':'r'}">\${bestEV.ev>0?'+'+bestEV.ev+'R':'—'}</div><div class="l">Beste Globale EV</div><div class="s">\${bestEV.ev>0?'Target: '+bestEV.rr+'R':''}</div></div>
    <div class="sc"><div class="v g">✓ UIT</div><div class="l">FTMO Dagcap</div></div>
  \`;

  // session summary
  const sessHtml=SESS.map(s=>{
    const tr=closed.filter(t=>t.session===s);
    if(!tr.length)return'';
    const w=tr.filter(t=>(t.trueMaxRR??t.maxRR??0)>=1).length;
    const wr=(w/tr.length*100).toFixed(1);
    const avg=(tr.reduce((a,t)=>a+(t.maxRR||0),0)/tr.length).toFixed(2);
    const ev=calcEV(tr);
    const best=ev.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-99,rr:0});
    return \`<div class="scard">
      <div class="scard-name">\${SL[s]}</div>
      <div class="srow"><span class="k">Trades</span><span class="v">\${tr.length}</span></div>
      <div class="srow"><span class="k">Winrate ≥1R</span><span class="v \${parseFloat(wr)>=50?'g':'r'}">\${wr}%</span></div>
      <div class="srow"><span class="k">Gem. MaxRR</span><span class="v">\${avg}R</span></div>
      <div class="srow"><span class="k">Beste TP</span><span class="v \${best.ev>0?'g':'r'}">\${best.ev>0?best.rr+'R (EV +'+best.ev+'R)':'—'}</span></div>
    </div>\`;
  }).join('');

  // open positions
  const posHtml=pos.length===0
    ?'<div class="empty"><div>📭</div>Geen open posities</div>'
    :\`<div class="tw"><table>
      <thead><tr><th>Pair</th><th>Dir</th><th class="tr">Lots</th><th class="tr">Risk€</th><th>Sessie</th><th class="tr">Entry</th><th class="tr">SL</th><th class="tr">TP</th><th>Flags</th></tr></thead>
      <tbody>\${pos.map(p=>\`<tr>
        <td class="bold">\${p.symbol}</td>
        <td><span class="bd \${p.direction}">\${p.direction.toUpperCase()}</span></td>
        <td class="tr">\${p.lots}</td>
        <td class="tr">\${(p.riskEUR||0).toFixed(2)}</td>
        <td><span class="bd info">\${p.sessionLabel||p.session||'—'}</span></td>
        <td class="tr mono">\${p.entry||'—'}</td>
        <td class="tr mono r">\${p.sl||'—'}</td>
        <td class="tr mono g">\${p.tp||'—'}</td>
        <td>\${p.forexHalfRisk?'<span class="bd warn">½R</span> ':''}\${p.restoredAfterRestart?'<span class="bd pu">RST</span>':''}</td>
      </tr>\`).join('')}</tbody></table></div>\`;

  document.getElementById('ov-body').innerHTML=\`
    <div class="sh">Open Posities</div>\${posHtml}
    <div class="sh">Per Sessie</div>
    <div class="sg">\${sessHtml}</div>
  \`;
}

// ── PAIRS ────────────────────────────────────────────────────────
function renderPairs(){
  const syms=[...new Set(D.closed.map(t=>t.symbol))].sort();
  if(!syms.length){
    document.getElementById('pairs-grid').innerHTML='<div class="empty"><div>📊</div>Geen trades</div>';
    return;
  }
  document.getElementById('pairs-grid').innerHTML=syms.map(sym=>buildPairCard(sym)).join('');
}

function buildPairCard(sym){
  const trades=D.closed.filter(t=>t.symbol===sym);
  const op=D.pos.filter(p=>p.symbol===sym);
  const tp=D.tpL[sym]||{};
  const sl=D.slL[sym]||null;
  const gh=D.ghosts.filter(g=>g.symbol===sym);
  const wins=trades.filter(t=>(t.trueMaxRR??t.maxRR??0)>=1).length;
  const wr=trades.length?(wins/trades.length*100).toFixed(1):0;
  const avgRR=trades.length?(trades.reduce((a,t)=>a+(t.maxRR||0),0)/trades.length).toFixed(2):0;
  const isOpen=openedPairs.has(sym);
  return \`<div class="pc">
    <div class="ph \${isOpen?'open':''}" onclick="togglePair('\${sym}')">
      <div class="psym">\${sym}</div>
      <div class="pbadges">
        \${op.length?'<span class="bd acc">'+op.length+' open</span>':''}
        \${gh.length?'<span class="bd pu">'+gh.length+' ghost</span>':''}
        \${sl?.direction==='up'?'<span class="bd good">SL ↑</span>':sl?.direction==='down'?'<span class="bd bad">SL ↓</span>':''}
        \${Object.keys(tp).length?'<span class="bd ye">TP locked</span>':''}
      </div>
      <div class="pstats">
        <div class="ps"><div class="v \${parseFloat(wr)>=50?'g':'r'}">\${wr}%</div><div class="l">WR</div></div>
        <div class="ps"><div class="v">\${trades.length}</div><div class="l">Trades</div></div>
        <div class="ps"><div class="v a">\${avgRR}R</div><div class="l">AvgRR</div></div>
      </div>
      <div class="chev">▼</div>
    </div>
    <div class="pb \${isOpen?'open':''}" id="pb-\${sym}">
      \${isOpen?buildPairBody(sym,trades,op,tp,sl,gh):''}
    </div>
  </div>\`;
}

function togglePair(sym){
  const isOpen=openedPairs.has(sym);
  if(isOpen) openedPairs.delete(sym); else openedPairs.add(sym);
  const ph=document.querySelector(\`#pb-\${sym}\`).previousElementSibling;
  ph.classList.toggle('open',!isOpen);
  const pb=document.getElementById('pb-'+sym);
  pb.classList.toggle('open',!isOpen);
  if(!isOpen&&!pb.dataset.loaded){
    const trades=D.closed.filter(t=>t.symbol===sym);
    const op=D.pos.filter(p=>p.symbol===sym);
    const tp=D.tpL[sym]||{};
    const sl=D.slL[sym]||null;
    const gh=D.ghosts.filter(g=>g.symbol===sym);
    pb.innerHTML=buildPairBody(sym,trades,op,tp,sl,gh);
    pb.dataset.loaded='1';
  }
}

function buildPairBody(sym,trades,op,tp,sl,gh){
  const tabs=['analyse','sessions','tp','sl','trades'];
  if(op.length)tabs.push('open');
  return \`
    <div class="it" id="it-\${sym}">
      \${tabs.map((t,i)=>\`<div class="itb \${i===0?'on':''}" onclick="innerTab('\${sym}','\${t}')">\${{analyse:'📊 Analyse',sessions:'⏱ Sessies',tp:'🎯 TP Opt.',sl:'📐 SL Opt.',trades:'📋 Trades',open:'🟢 Open'}[t]}</div>\`).join('')}
    </div>
    \${tabs.map((t,i)=>\`<div class="itp \${i===0?'on':''}" id="itp-\${sym}-\${t}">
      \${{
        analyse:()=>buildAnalyse(sym,trades,tp,sl),
        sessions:()=>buildSessions(sym,trades),
        tp:()=>buildTP(sym,trades,tp),
        sl:()=>buildSL(sym,trades,sl),
        trades:()=>buildTrades(sym,trades),
        open:()=>buildOpen(op),
      }[t]()}
    </div>\`).join('')}
  \`;
}

function innerTab(sym,name){
  document.querySelectorAll(\`#it-\${sym} .itb\`).forEach(t=>t.classList.remove('on'));
  document.querySelectorAll(\`[id^="itp-\${sym}-"]\`).forEach(p=>p.classList.remove('on'));
  const tEl=[...document.querySelectorAll(\`#it-\${sym} .itb\`)].find(t=>t.textContent.includes({analyse:'Analyse',sessions:'Sessies',tp:'TP',sl:'SL',trades:'Trades',open:'Open'}[name]));
  if(tEl)tEl.classList.add('on');
  document.getElementById(\`itp-\${sym}-\${name}\`)?.classList.add('on');
}

// ANALYSE TAB
function buildAnalyse(sym,trades,tp,sl){
  if(!trades.length)return'<div class="empty">Geen data</div>';
  const ev=calcEV(trades);
  const best=ev.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-99,rr:0});
  const wins=trades.filter(t=>(t.trueMaxRR??t.maxRR??0)>=1).length;
  const wr=(wins/trades.length*100).toFixed(1);
  const avgRR=(trades.reduce((a,t)=>a+(t.maxRR||0),0)/trades.length).toFixed(2);
  const tTrue=trades.filter(t=>t.trueMaxRR!=null);
  const avgTrue=tTrue.length?(tTrue.reduce((a,t)=>a+t.trueMaxRR,0)/tTrue.length).toFixed(2):'—';
  const gPend=trades.filter(t=>t.trueMaxRR===null).length;

  // Adviezen
  let advices='';
  if(best.ev>0) advices+=\`<div class="advr"><span class="icon">🎯</span><span>Beste TP: <strong class="g">\${best.rr}R</strong> — EV <strong class="g">+\${best.ev}R</strong>/trade (WR \${(best.wr*100).toFixed(1)}%, \${best.wins}/\${best.total} wins)</span></div>\`;
  else advices+=\`<div class="advr"><span class="icon">⚠️</span><span>Geen positief EV gevonden — te weinig data of negatief systeem</span></div>\`;
  const tpKeys=Object.keys(tp);
  if(tpKeys.length){
    tpKeys.forEach(sess=>{const l=tp[sess];advices+=\`<div class="advr"><span class="icon">🔒</span><span>TP Lock <strong class="a">\${sess}</strong>: \${l.lockedRR}R — EV +\${l.evAtLock}R (\${l.lockedTrades} trades)</span></div>\`;});
  }
  if(sl){
    const dir=sl.direction==='up'?'📈 Groter':'sl.direction==="down"?'📉 Kleiner':'✅ Huidig optimaal';
    advices+=\`<div class="advr"><span class="icon">\${sl.direction==='up'?'📈':sl.direction==='down'?'📉':'✅'}</span><span>SL Advies: <strong class="\${sl.direction==='up'?'g':sl.direction==='down'?'r':'a'}">\${sl.direction==='up'?'Groter':sl.direction==='down'?'Kleiner':'Huidig optimaal'}</strong> (\${sl.multiplier}×) — EV \${sl.evAtLock}R</span></div>\`;
  }
  if(gPend>0) advices+=\`<div class="advr"><span class="icon">👻</span><span><strong class="pu">\${gPend}</strong> trades wachten op Ghost finalisatie (TrueMaxRR nog onbekend)</span></div>\`;

  const maxEVabs=Math.max(...ev.map(e=>Math.abs(e.ev)),0.01);
  const evRows=ev.map(e=>{
    const isBest=e.rr===best.rr&&best.ev>0;
    const pct=Math.max(0,(e.ev/maxEVabs)*100);
    const clr=evColor(e.ev);
    return \`<tr class="\${isBest?'best':''}">
      <td>\${e.rr}R\${isBest?' <span class="bd good">BEST</span>':''}</td>
      <td class="tr">\${e.wins}/\${e.total}</td>
      <td class="tr">\${(e.wr*100).toFixed(1)}%</td>
      <td class="tr" style="color:\${clr}">\${e.ev>0?'+':''}\${e.ev}R</td>
      <td><span class="evbar"><span class="evbf" style="width:\${pct}%;background:\${clr}"></span></span></td>
    </tr>\`;
  }).join('');

  return \`
    <div class="stats" style="margin-bottom:10px">
      <div class="sc"><div class="v \${parseFloat(wr)>=50?'g':'r'}">\${wr}%</div><div class="l">Winrate ≥1R</div></div>
      <div class="sc"><div class="v">\${trades.length}</div><div class="l">Trades</div></div>
      <div class="sc"><div class="v">\${avgRR}R</div><div class="l">Avg MaxRR</div></div>
      <div class="sc"><div class="v a">\${avgTrue}R</div><div class="l">Avg TrueMaxRR</div></div>
      <div class="sc"><div class="v o">\${gPend}</div><div class="l">Ghost Pending</div></div>
    </div>
    <div class="adv">\${advices}</div>
    <div class="tw"><table>
      <thead><tr><th>TP Level</th><th class="tr">W/T</th><th class="tr">Winrate</th><th class="tr">EV/trade</th><th>Bar</th></tr></thead>
      <tbody>\${evRows}</tbody>
    </table></div>
  \`;
}

// SESSIONS TAB
function buildSessions(sym,trades){
  if(!trades.length)return'<div class="empty">Geen data</div>';
  return SESS.map(s=>{
    const tr=trades.filter(t=>t.session===s);
    if(!tr.length)return\`<div class="scard-name" style="color:var(--t3);font-size:11px;margin:6px 0">\${SL[s]} — geen trades</div>\`;
    const w=tr.filter(t=>(t.trueMaxRR??t.maxRR??0)>=1).length;
    const wr=(w/tr.length*100).toFixed(1);
    const avg=(tr.reduce((a,t)=>a+(t.maxRR||0),0)/tr.length).toFixed(2);
    const ev=calcEV(tr);
    const best=ev.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-99,rr:0});
    const maxEV=Math.max(...ev.map(e=>Math.abs(e.ev)),0.01);
    const rows=ev.filter(e=>e.ev>-1||e.rr<=3).map(e=>{
      const isBest=e.rr===best.rr&&best.ev>0;
      const pct=Math.max(0,(e.ev/maxEV)*100);
      const clr=evColor(e.ev);
      return \`<tr class="\${isBest?'best':''}">
        <td>\${e.rr}R\${isBest?' <span class="bd good">★</span>':''}</td>
        <td class="tr">\${e.wins}/\${e.total}</td>
        <td class="tr">\${(e.wr*100).toFixed(1)}%</td>
        <td class="tr" style="color:\${clr}">\${e.ev>0?'+':''}\${e.ev}R</td>
        <td><span class="evbar"><span class="evbf" style="width:\${pct}%;background:\${clr}"></span></span></td>
      </tr>\`;
    }).join('');
    return \`<div style="margin-bottom:14px">
      <div class="sh" style="margin-top:0">\${SL[s]} — \${tr.length} trades | WR: \${wr}% | Avg: \${avg}R | Beste TP: \${best.ev>0?best.rr+'R (EV +'+best.ev+'R)':'—'}</div>
      <div class="tw"><table>
        <thead><tr><th>TP</th><th class="tr">W/T</th><th class="tr">WR%</th><th class="tr">EV</th><th>Bar</th></tr></thead>
        <tbody>\${rows}</tbody>
      </table></div>
    </div>\`;
  }).join('');
}

// TP OPTIMIZER TAB
function buildTP(sym,trades,tpLock){
  if(!trades.length)return'<div class="empty">Geen data</div>';
  const ev=calcEV(trades);
  const best=ev.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-99,rr:0});
  const current=tpLock&&Object.keys(tpLock).length?Object.entries(tpLock).sort((a,b)=>(b[1].evAtLock||0)-(a[1].evAtLock||0))[0]:null;

  let topHtml=\`<div class="adv">\`;
  if(best.ev>0){
    topHtml+=\`<div class="advr"><span class="icon">🎯</span><span>Globaal beste TP: <strong class="g">\${best.rr}R</strong> — EV <strong class="g">+\${best.ev}R</strong>/trade (WR \${(best.wr*100).toFixed(1)}%)</span></div>\`;
    if(current&&current[1].lockedRR!==best.rr){
      topHtml+=\`<div class="advr"><span class="icon">🔄</span><span>Huidig lock: \${current[0]} \${current[1].lockedRR}R — overweeg update naar \${best.rr}R</span></div>\`;
    } else if(current){
      topHtml+=\`<div class="advr"><span class="icon">✅</span><span>Lock (\${current[0]}) is al op optimaal niveau \${current[1].lockedRR}R</span></div>\`;
    } else {
      topHtml+=\`<div class="advr"><span class="icon">💡</span><span>Nog geen TP lock — wacht op voldoende data (min 10 trades)</span></div>\`;
    }
  } else {
    topHtml+=\`<div class="advr"><span class="icon">⚠️</span><span>Geen positief EV — onvoldoende data of systeem niet winstgevend</span></div>\`;
  }
  topHtml+=\`</div>\`;

  // Per sessie
  const sessHtml=SESS.map(s=>{
    const tr=trades.filter(t=>t.session===s);
    if(!tr.length)return'';
    const ev=calcEV(tr);
    const b=ev.reduce((a,e)=>e.ev>a.ev?e:a,{ev:-99,rr:0});
    const lock=tpLock[s];
    return \`<div class="scard">
      <div class="scard-name">\${SL[s]}</div>
      <div class="srow"><span class="k">Trades</span><span class="v">\${tr.length}</span></div>
      <div class="srow"><span class="k">Beste TP</span><span class="v \${b.ev>0?'g':'r'}">\${b.ev>0?b.rr+'R':'—'}</span></div>
      <div class="srow"><span class="k">EV</span><span class="v \${b.ev>0?'g':'r'}">\${b.ev>0?'+'+b.ev+'R':'—'}</span></div>
      <div class="srow"><span class="k">WR</span><span class="v">\${b.ev>0?(b.wr*100).toFixed(1)+'%':'—'}</span></div>
      <div class="srow"><span class="k">Lock actief</span><span class="v \${lock?'ye':'dim'}">\${lock?lock.lockedRR+'R ✓':'nee'}</span></div>
    </div>\`;
  }).join('');

  const maxEV=Math.max(...ev.map(e=>Math.abs(e.ev)),0.01);
  const rows=ev.map(e=>{
    const isBest=e.rr===best.rr&&best.ev>0;
    const pct=Math.max(0,(e.ev/maxEV)*100);
    const clr=evColor(e.ev);
    return \`<tr class="\${isBest?'best':''}">
      <td>\${e.rr}R\${isBest?' <span class="bd good">BEST</span>':''}</td>
      <td class="tr">\${e.wins}/\${e.total}</td>
      <td class="tr">\${(e.wr*100).toFixed(1)}%</td>
      <td class="tr" style="color:\${clr}">\${e.ev>0?'+':''}\${e.ev}R</td>
      <td><span class="evbar"><span class="evbf" style="width:\${pct}%;background:\${clr}"></span></span></td>
    </tr>\`;
  }).join('');

  return \`\${topHtml}
    <div class="sg">\${sessHtml}</div>
    <div class="sh">Volledige EV Tabel (globaal)</div>
    <div class="tw"><table>
      <thead><tr><th>TP Level</th><th class="tr">Wins/Total</th><th class="tr">Winrate</th><th class="tr">EV/trade</th><th>Bar</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table></div>\`;
}

// SL OPTIMIZER TAB
function buildSL(sym,trades,slLock){
  if(!trades.length)return'<div class="empty">Geen data</div>';
  const MULTS=[0.5,0.6,0.75,0.85,1.0,1.25,1.5,2.0,2.5,3.0];
  const rows=MULTS.map(mult=>{
    // Simulate SL scaled trades: a tighter SL → proportionally larger maxRR
    const sim=trades.map(t=>{
      const scaledMaxRR=(t.trueMaxRR??t.maxRR??0)/mult;
      return{...t,simRR:scaledMaxRR};
    });
    const ev=calcEV(sim.map(t=>({...t,maxRR:t.simRR,trueMaxRR:t.simRR})));
    const best=ev.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-99,rr:0});
    const isCur=mult===1.0;
    const isAdv=slLock&&Math.abs(slLock.multiplier-mult)<0.01;
    return{mult,best,isCur,isAdv,sim};
  });
  const bestMult=rows.reduce((a,b)=>b.best.ev>a.best.ev?b:a,{best:{ev:-99}});
  const advDir=bestMult.mult<1.0?'Kleiner (dichter bij entry)':bestMult.mult>1.0?'Groter (verder van entry)':'Huidig optimaal';
  const advIcon=bestMult.mult<1.0?'📉':bestMult.mult>1.0?'📈':'✅';
  const advCls=bestMult.mult<1.0?'r':bestMult.mult>1.0?'g':'a';

  let advice=\`<div class="adv">
    <div class="advr"><span class="icon">\${advIcon}</span><span>SL Advies: <strong class="\${advCls}">\${advDir}</strong> (\${bestMult.mult}×) — beste EV: \${bestMult.best.ev>0?'+'+bestMult.best.ev+'R bij '+bestMult.best.rr+'R TP':'—'}</span></div>\`;
  if(slLock){
    advice+=\`<div class="advr"><span class="icon">🔒</span><span>Huidig lock: \${slLock.multiplier}× (\${slLock.direction}) — EV \${slLock.evAtLock}R bij \${slLock.lockedTrades} trades</span></div>\`;
  }
  advice+=\`</div>\`;

  const tableRows=rows.map(r=>{
    const cls=r.mult===bestMult.mult?'best':'';
    return \`<tr class="\${cls}">
      <td>\${r.mult}× \${r.mult===1.0?'<span class="bd info">huidig</span>':''} \${r.mult===bestMult.mult?'<span class="bd good">BEST</span>':''}  \${r.isAdv?'<span class="bd ye">lock</span>':''}</td>
      <td class="tr">\${r.best.ev>0?r.best.rr+'R':'—'}</td>
      <td class="tr \${r.best.ev>0?'g':'r'}">\${r.best.ev>0?'+'+r.best.ev+'R':'—'}</td>
      <td class="tr">\${r.best.ev>0?(r.best.wr*100).toFixed(1)+'%':'—'}</td>
    </tr>\`;
  }).join('');

  return \`\${advice}
    <div class="sh">SL Multiplier Vergelijking</div>
    <div style="font-size:10px;color:var(--t3);margin-bottom:8px">⚠️ Simulatie: SL groter = kleinere relatieve MaxRR. Advies is indicatief.</div>
    <div class="tw"><table>
      <thead><tr><th>SL Multiplier</th><th class="tr">Beste TP</th><th class="tr">EV</th><th class="tr">Winrate</th></tr></thead>
      <tbody>\${tableRows}</tbody>
    </table></div>\`;
}

// TRADES TAB
function buildTrades(sym,trades){
  if(!trades.length)return'<div class="empty">Geen trades</div>';
  const rows=trades.slice(0,50).map((t,i)=>\`<tr>
    <td class="dim">\${i+1}</td>
    <td><span class="bd \${t.direction}">\${t.direction?.toUpperCase()}</span></td>
    <td><span class="bd info">\${SL[t.session]||t.session||'—'}</span></td>
    <td class="tr mono">\${t.entry?.toFixed(4)||'—'}</td>
    <td class="tr mono r">\${t.sl?.toFixed(4)||'—'}</td>
    <td class="tr">\${fmtRR(t.maxRR)}</td>
    <td class="tr">\${fmtRR(t.trueMaxRR)}</td>
    <td class="dim" style="font-size:10px">\${t.trueMaxRR!=null?'<span class="bd good">✓</span>':'<span class="bd pu">👻</span>'}</td>
    <td style="font-size:10px">\${fmtDate(t.openedAt)}</td>
    <td style="font-size:10px">\${fmtDate(t.closedAt)}</td>
  </tr>\`).join('');
  return \`<div class="tw" style="max-height:400px;overflow-y:auto"><table>
    <thead><tr><th>#</th><th>Dir</th><th>Sessie</th><th class="tr">Entry</th><th class="tr">SL</th><th class="tr">MaxRR</th><th class="tr">TrueMaxRR</th><th>Ghost</th><th>Open</th><th>Gesloten</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table></div>\${trades.length>50?'<div class="dim" style="font-size:10px;margin-top:6px">Toon 50/'+trades.length+' — zie Archief voor alles</div>':''}\`;
}

// OPEN TAB
function buildOpen(op){
  if(!op.length)return'<div class="empty">Geen open posities</div>';
  return \`<div class="tw"><table>
    <thead><tr><th>Dir</th><th>Sessie</th><th class="tr">Lots</th><th class="tr">Risk€</th><th class="tr">Entry</th><th class="tr">SL</th><th class="tr">TP</th><th>Flags</th></tr></thead>
    <tbody>\${op.map(p=>\`<tr>
      <td><span class="bd \${p.direction}">\${p.direction?.toUpperCase()}</span></td>
      <td><span class="bd info">\${p.sessionLabel||p.session||'—'}</span></td>
      <td class="tr">\${p.lots}</td>
      <td class="tr">\${(p.riskEUR||0).toFixed(2)}</td>
      <td class="tr mono">\${p.entry||'—'}</td>
      <td class="tr mono r">\${p.sl||'—'}</td>
      <td class="tr mono g">\${p.tp||'—'}</td>
      <td>\${p.forexHalfRisk?'<span class="bd warn">½R</span> ':''}\${p.restoredAfterRestart?'<span class="bd pu">RST</span>':''}</td>
    </tr>\`).join('')}</tbody>
  </table></div>\`;
}

// ── GHOSTS ───────────────────────────────────────────────────────
function renderGhosts(){
  const gh=D.ghosts;
  if(!gh.length){
    document.getElementById('ghost-active').innerHTML='<div class="empty"><div>👻</div>Geen actieve ghost trackers</div>';
  } else {
    document.getElementById('ghost-active').innerHTML=gh.map(g=>{
      const pct=Math.min(100,(g.elapsedMin/1440)*100);
      return \`<div class="ghost-row">
        <div><div class="ghost-sym">\${g.symbol}</div>
          <span class="bd \${g.direction}">\${g.direction?.toUpperCase()}</span>
          <span class="bd info" style="margin-left:4px">\${SL[g.session]||'—'}</span></div>
        <div>
          <div class="ghost-lbl">Tijd verstreken: \${g.elapsedMin}min / \${Math.round(g.remainingMin)}min resterend</div>
          <div class="ghost-bar"><div class="ghost-bf" style="width:\${pct}%"></div></div>
          <div style="font-size:10px;color:var(--t2);margin-top:3px">Entry: \${g.entry} | SL: \${g.sl} | MaxRR bij sluiting: \${g.maxRRAtClose}R</div>
        </div>
        <div class="ghost-rr"><div class="big pu">\${parseFloat(g.currentBestRR||0).toFixed(2)}R</div><div class="small">CurrentBest</div></div>
      </div>\`;
    }).join('');
  }

  const pending=D.closed.filter(t=>t.trueMaxRR===null);
  if(!pending.length){
    document.getElementById('ghost-pending').innerHTML='<div class="empty">Geen pending ghost trades</div>';
  } else {
    document.getElementById('ghost-pending').innerHTML=pending.slice(0,100).map(t=>\`<tr>
      <td class="bold">\${t.symbol}</td>
      <td><span class="bd \${t.direction}">\${t.direction?.toUpperCase()}</span></td>
      <td><span class="bd info">\${SL[t.session]||t.session||'—'}</span></td>
      <td class="tr">\${fmtRR(t.maxRR)}</td>
      <td class="tr mono">\${t.entry?.toFixed(4)||'—'}</td>
      <td style="font-size:10px">\${fmtDate(t.openedAt)}</td>
      <td style="font-size:10px">\${fmtDate(t.closedAt)}</td>
    </tr>\`).join('');
  }
}

// ── ARCHIVE ──────────────────────────────────────────────────────
function populateArchFilter(){
  const syms=[...new Set(D.closed.map(t=>t.symbol))].sort();
  const sel=document.getElementById('af-sym');
  const cur=sel.value;
  sel.innerHTML='<option value="">Alle</option>'+syms.map(s=>\`<option value="\${s}" \${s===cur?'selected':''}>\${s}</option>\`).join('');
  renderArch();
}

function renderArch(){
  let tr=[...D.closed];
  const sym=document.getElementById('af-sym')?.value;
  const sess=document.getElementById('af-sess')?.value;
  const dir=document.getElementById('af-dir')?.value;
  const minRR=parseFloat(document.getElementById('af-rr')?.value)||0;
  if(sym)  tr=tr.filter(t=>t.symbol===sym);
  if(sess) tr=tr.filter(t=>t.session===sess);
  if(dir)  tr=tr.filter(t=>t.direction===dir);
  if(minRR)tr=tr.filter(t=>(t.trueMaxRR??t.maxRR??0)>=minRR);
  document.getElementById('af-info').textContent=tr.length+' trades';
  document.getElementById('arch-body').innerHTML=tr.slice(0,500).map((t,i)=>\`<tr>
    <td class="dim">\${i+1}</td>
    <td class="bold">\${t.symbol}</td>
    <td><span class="bd \${t.direction}">\${t.direction?.toUpperCase()}</span></td>
    <td><span class="bd info">\${SL[t.session]||t.session||'—'}</span></td>
    <td class="tr mono">\${t.entry?.toFixed(4)||'—'}</td>
    <td class="tr mono r">\${t.sl?.toFixed(4)||'—'}</td>
    <td class="tr">\${fmtRR(t.maxRR)}</td>
    <td class="tr">\${fmtRR(t.trueMaxRR)}</td>
    <td class="tr">\${t.riskEUR?.toFixed(2)||'—'}</td>
    <td class="tr">\${t.lots||'—'}</td>
    <td class="tc">\${t.trueMaxRR!=null?'<span class="bd good">✓</span>':'<span class="bd pu">👻</span>'}</td>
    <td style="font-size:10px">\${fmtDate(t.openedAt)}</td>
    <td style="font-size:10px">\${fmtDate(t.closedAt)}</td>
  </tr>\`).join('');
}

// ── HISTORY ──────────────────────────────────────────────────────
function renderHist(){
  const rows=D.hist.map(h=>\`<tr>
    <td style="font-size:10px;color:var(--t3)">\${h.ts?.slice(0,19).replace('T',' ')||'—'}</td>
    <td><span class="bd \${h.type==='SUCCESS'?'good':h.type==='ERROR'?'bad':'info'}">\${h.type}</span></td>
    <td class="bold">\${h.symbol||'—'}</td>
    <td>\${h.direction?'<span class="bd '+h.direction+'">'+h.direction.toUpperCase()+'</span>':'—'}</td>
    <td><span class="bd info">\${h.session||'—'}</span></td>
    <td class="tr">\${h.lots||'—'}</td>
    <td class="tr">\${h.riskEUR?'€'+h.riskEUR:'—'}</td>
    <td>\${h.tp||'—'}</td>
    <td style="font-size:10px">\${h.slAanpassing||'—'}</td>
    <td style="font-size:10px">\${h.riskBoost||'—'}</td>
  </tr>\`).join('');
  document.getElementById('hist-body').innerHTML=rows||'<tr><td colspan="10" class="empty">Geen data</td></tr>';
}

// ── LOCKS ────────────────────────────────────────────────────────
function renderLocks(){
  // TP locks
  const tpHtml=Object.entries(D.tpL).length===0
    ?'<div class="empty">Geen TP locks</div>'
    :Object.entries(D.tpL).map(([sym,sessions])=>\`
      <div class="lc">
        <div class="lc-hdr"><div class="lc-sym">\${sym}</div></div>
        <div class="lc-sub">
          \${Object.entries(sessions).map(([sess,l])=>\`
            <div class="lc-item"><span class="k">\${sess}:</span><span class="v a">\${l.lockedRR}R</span> <span style="font-size:10px;color:var(--t3)">EV +\${l.evAtLock}R | \${l.lockedTrades} trades</span></div>
          \`).join('')}
        </div>
      </div>
    \`).join('');

  // SL locks
  const slHtml=Object.entries(D.slL).length===0
    ?'<div class="empty">Geen SL analyses</div>'
    :Object.entries(D.slL).map(([sym,l])=>\`
      <div class="lc">
        <div class="lc-hdr">
          <div class="lc-sym">\${sym}</div>
          <span class="bd \${l.direction==='up'?'good':l.direction==='down'?'bad':'info'}">\${l.direction==='up'?'↑ Groter':l.direction==='down'?'↓ Kleiner':'= Huidig'}</span>
        </div>
        <div class="lc-sub">
          <div class="lc-item"><span class="k">Mult:</span><span class="v">\${l.multiplier}×</span></div>
          <div class="lc-item"><span class="k">EV:</span><span class="v \${l.evAtLock>0?'g':'r'}">\${l.evAtLock}R</span></div>
          <div class="lc-item"><span class="k">Trades:</span><span class="v">\${l.lockedTrades}</span></div>
        </div>
      </div>
    \`).join('');

  document.getElementById('tp-locks').innerHTML=tpHtml;
  document.getElementById('sl-locks').innerHTML=slHtml;
}

// ── EQUITY ───────────────────────────────────────────────────────
function renderEquity(){
  const snaps=D.equity;
  const canvas=document.getElementById('eq-canvas');
  if(!canvas)return;
  if(!snaps.length){canvas.style.display='none';return;}
  canvas.style.display='block';
  canvas.width=canvas.offsetWidth||800;
  canvas.height=300;
  const ctx=canvas.getContext('2d');
  const bal=snaps.map(s=>s.equity??s.balance??0);
  const mn=Math.min(...bal),mx=Math.max(...bal);
  const pad={t:20,r:20,b:30,l:70};
  const W=canvas.width-pad.l-pad.r,H=canvas.height-pad.t-pad.b;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#0c1018';ctx.fillRect(0,0,canvas.width,canvas.height);
  // grid
  ctx.strokeStyle='#1c2a38';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const y=pad.t+H*(1-i/4);
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(pad.l+W,y);ctx.stroke();
    const v=mn+(mx-mn)*i/4;
    ctx.fillStyle='#4a6070';ctx.font='10px monospace';ctx.textAlign='right';
    ctx.fillText(v.toFixed(0),pad.l-6,y+4);
  }
  // line
  const range=mx-mn||1;
  ctx.beginPath();ctx.strokeStyle='#2dd4f4';ctx.lineWidth=2;
  snaps.forEach((s,i)=>{
    const x=pad.l+W*i/(snaps.length-1);
    const y=pad.t+H*(1-(((s.equity??s.balance??0)-mn)/range));
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  });
  ctx.stroke();
  // fill
  ctx.beginPath();
  snaps.forEach((s,i)=>{
    const x=pad.l+W*i/(snaps.length-1);
    const y=pad.t+H*(1-(((s.equity??s.balance??0)-mn)/range));
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  });
  ctx.lineTo(pad.l+W,pad.t+H);ctx.lineTo(pad.l,pad.t+H);ctx.closePath();
  const grad=ctx.createLinearGradient(0,pad.t,0,pad.t+H);
  grad.addColorStop(0,'rgba(45,212,244,.2)');grad.addColorStop(1,'rgba(45,212,244,0)');
  ctx.fillStyle=grad;ctx.fill();

  const last=snaps[snaps.length-1];
  const first=snaps[0];
  const diff=((last.equity??last.balance??0)-(first.equity??first.balance??0)).toFixed(2);
  document.getElementById('eq-stats').innerHTML=\`
    <div class="sc"><div class="v">\${(last.balance||0).toFixed(0)}</div><div class="l">Balance</div></div>
    <div class="sc"><div class="v a">\${(last.equity||0).toFixed(0)}</div><div class="l">Equity</div></div>
    <div class="sc"><div class="v \${parseFloat(diff)>=0?'g':'r'}">\${parseFloat(diff)>=0?'+':''}\${diff}</div><div class="l">Change 24u</div></div>
    <div class="sc"><div class="v">\${(last.floatingPL||0).toFixed(2)}</div><div class="l">Floating P/L</div></div>
    <div class="sc"><div class="v">\${snaps.length}</div><div class="l">Snapshots</div></div>
  \`;
}

// ── ACTIONS ──────────────────────────────────────────────────────
async function confirmReset(){
  if(!confirm('Alle TP locks resetten? Dit kan niet ongedaan worden gemaakt.'))return;
  const syms=[...new Set(Object.values(D.tpL).flatMap(()=>Object.keys(D.tpL)))];
  for(const s of Object.keys(D.tpL)){
    await fetch('/tp-locks/'+s,{method:'DELETE',headers:{'x-secret':S}});
  }
  alert('TP locks gereset.');
  loadAll();
}

// AUTO-REFRESH
loadAll();
setInterval(loadAll, 30000);
</script>
</body>
</html>`);
});


// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function startServer() {
  await initDB();

  // Laad gesloten trades
  const hist  = await loadAllTrades();
  const valid = hist.filter(t => t.closed_at || t.closedAt);
  // v4.3: herbereken sessie voor trades zonder sessie op basis van openedAt
  for (const t of valid) {
    if (!t.session && t.openedAt) {
      t.session = getSessionGMT1(t.openedAt);
    }
  }
  closedTrades.push(...valid);
  console.log(`📂 ${valid.length} gesloten trades geladen`);

  // Laad TP / SL configs
  try {
    const saved = await loadTPConfig();
    Object.assign(tpLocks, saved);
    console.log(`🔒 ${Object.keys(tpLocks).length} TP sessie-locks geladen`);
  } catch (e) { console.warn("⚠️ TP config laden:", e.message); }

  try {
    const saved = await loadSLConfig();
    Object.assign(slLocks, saved);
    console.log(`📐 ${Object.keys(slLocks).length} SL analyses geladen`);
  } catch (e) { console.warn("⚠️ SL config laden:", e.message); }

  // Run engines voor alle symbolen
  const symSet = [...new Set(valid.map(t => t.symbol).filter(Boolean))];
  for (const sym of symSet) {
    await runTPLockEngine(sym).catch(() => {});
    await runSLLockEngine(sym).catch(() => {});
  }
  console.log(`🔒 TP sessie-locks: ${Object.keys(tpLocks).length} | 📐 SL analyses: ${Object.keys(slLocks).length}`);

  // [FIX v4.3] Herstel open posities vanuit MT5 na restart
  await restoreOpenPositionsFromMT5();

  const server = app.listen(PORT, () =>
    console.log([
      `🚀 FTMO Webhook v4.4 — poort ${PORT}`,
      `✅ [FIX] Cap = baseRisk per type — indices buiten Asia werken nu`,
      `✅ [FIX] Restart recovery — weesposities worden hersteld`,
      `✅ [FEAT] Forex half risk bij 1–${FOREX_MAX_SAME_DIR-1} open trades zelfde pair+richting`,
      `📈 Risico | Index:€${RISK.index} Forex:€${RISK.forex} Gold:€${RISK.gold} Crypto:€${RISK.crypto} Stock:€${RISK.stock}`,
      `💰 Cap per type: Index €${RISK.index}→€${RISK.index*TP_LOCK_RISK_MULT} | Forex €${RISK.forex}→€${RISK.forex*TP_LOCK_RISK_MULT}`,
      `🔄 Forex anti-consolidatie: half risk bij 1–${FOREX_MAX_SAME_DIR-1} open | blok bij ≥${FOREX_MAX_SAME_DIR}`,
    ].join("\n"))
  );

  function shutdown(sig) {
    console.log(`\n🛑 ${sig} — ghost trackers stoppen...`);
    for (const [id, g] of Object.entries(ghostTrackers)) {
      clearTimeout(g.timer);
      delete ghostTrackers[id];
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

startServer().catch(err => { console.error("❌", err.message); process.exit(1); });
