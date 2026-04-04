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
//  ✅ [FIX] Dashboard: gesorteerd op EV (meest positief → meest negatief)
//           per pair, met trade count — volledig visueel HTML dashboard
//  ✅ [FIX] TP lock: dagelijks reset + aanpasbaar via ghost data elke avond
//  ✅ [FIX] SL: read-only, pas aanpasbaar na 50+ trades (was 10)
//  ✅ [FIX] Forex max 2 trades per zelfde symbol+richting (was 3 blok op ≥3)
//           → blok bij ≥2 (was ≥3), half risk bij 1 open (was ≥1)
//  ✅ [FIX] Risk x4 boost bij positieve EV TP lock (correct)
//  ✅ [FIX] Index cap: min lot cap = baseRisk per type over alle sessies
//           (RISK_INDEX=€200, TP lock cap €800) — geen RISK_MINLOT_CAP €60 meer
//  ✅ [FIX] Ghost tracker: trueMaxRR = max koers GEDURENDE dag (niet bij sluiting)
//           → ghost volgt prijs tot 20u zonder SL-breach, bestPrice is running max
//  ✅ [FIX] Forex min stop: 0.0003 (was 0.0005) voor alle non-JPY pairs
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

// Forex anti-consolidatie — v4.4: max 2 trades zelfde pair+richting
const FOREX_MAX_SAME_DIR        = 2;   // ≥ 2 = blok (was 3)
const FOREX_HALF_RISK_THRESHOLD = 1;   // ≥ 1 = half risk

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

let ftmoDailyLossUsed = 0;
let ftmoLastDayReset  = new Date().toDateString();

function resetDailyLossIfNewDay() {
  const today = new Date().toDateString();
  if (today !== ftmoLastDayReset) { ftmoDailyLossUsed = 0; ftmoLastDayReset = today; }
}
function ftmoSafetyCheck(_r) { return { ok: true }; }
function registerFtmoLoss(r) {
  ftmoDailyLossUsed += r;
  console.log(`📉 FTMO daily: €${ftmoDailyLossUsed.toFixed(2)}`);
}

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
const SL_LOCK_THRESHOLD  = 50;  // v4.4: SL pas aanpasbaar na 50+ trades (was 10)
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
  // v4.4: minimum 0.0003 voor alle non-JPY forex pairs (was 0.0005)
  "EURUSD": 0.0003, "GBPUSD": 0.0003, "AUDUSD": 0.0003,
  "NZDUSD": 0.0003, "USDCHF": 0.0003, "USDCAD": 0.0003,
  "EURGBP": 0.0003, "EURAUD": 0.0003, "EURCAD": 0.0003,
  "EURCHF": 0.0003, "GBPAUD": 0.0003, "GBPCAD": 0.0003,
  "GBPCHF": 0.0003, "AUDCAD": 0.0003, "AUDCHF": 0.0003,
  "AUDNZD": 0.0003, "CADCHF": 0.0003, "NZDCAD": 0.0003,
  "NZDCHF": 0.0003,
  // JPY pairs — grotere minimale afstand
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
 *   blocked:  true als count >= FOREX_MAX_SAME_DIR (2)  → SKIP
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
// GHOST TRACKER — post-close prijsvolging tot stipt 20u Brussels
//
// LOGICA:
//  1. Ghost start zodra een trade gesloten wordt (TP, manueel, SL)
//  2. Volgt de prijs actief als running max VANAF entry
//     → trueMaxRR = hoogste gunstige prijs bereikt ZONDER SL te raken
//     → zelfs als trade eerder gesloten werd door TP/manueel
//  3. Stopt ALTIJD om 20u Brussels → finaliseGhost() → DB → TP lock
//     → om 20u zijn alle trades dicht → ghost data is compleet
//     → TP lock engine herberekent direct op verse trueMaxRR
//  4. Stopt ook bij SL-breach (prijs raakt SL na close)
//  5. Failsafe timeout na 24u
//
// Batching: recent < 6u → elke 60s | oud ≥ 6u → elke 5min
// ══════════════════════════════════════════════════════════════
function startGhostTracker(closedTrade) {
  const ghostId   = `ghost_${closedTrade.id}_${Date.now()}`;
  const startedAt = Date.now();
  // Start vanaf entry — meet wat de markt NA de close maximaal deed
  // zonder de SL te raken (= echte opportunity / ghost RR)
  let bestPrice   = closedTrade.entry;

  console.log(`👻 Ghost gestart: ${closedTrade.symbol} | entry: ${closedTrade.entry} | maxRR bij close: ${closedTrade.maxRR}R`);
  console.log(`   → volgt running max tot 20u Brussels — trueMaxRR = max zonder SL`);

  let currentTimer = null;

  async function tick() {
    try {
      const { hhmm } = getBrusselsComponents();
      const elapsed  = Date.now() - startedAt;

      // STOP om 20u Brussels — alle dagelijkse trades zijn dicht,
      // ghost data compleet → onmiddellijk finaliseren voor TP lock
      if (hhmm >= 2000) {
        console.log(`👻 ${closedTrade.symbol} — 20u bereikt, ghost finaliseren`);
        finaliseGhost(ghostId, closedTrade, bestPrice, "market_closed_20u");
        return;
      }

      // Failsafe: stop na 24u
      if (elapsed >= GHOST_DURATION_MS) {
        finaliseGhost(ghostId, closedTrade, bestPrice, "timeout_24u");
        return;
      }

      const priceData = await fetchCurrentPrice(closedTrade.mt5Symbol);
      const price     = priceData?.mid ?? null;

      if (price !== null) {
        // Running max: bijhouden hoogste gunstige prijs t.o.v. entry
        const isFavorable = closedTrade.direction === "buy"
          ? price > bestPrice
          : price < bestPrice;
        if (isFavorable) {
          bestPrice = price;
          if (ghostTrackers[ghostId]) ghostTrackers[ghostId].bestPrice = bestPrice;
          const currentRR = calcMaxRRFromPrice(closedTrade, bestPrice);
          console.log(`👻 ${closedTrade.symbol} nieuw max: ${bestPrice} → ${currentRR}R`);
        }

        // SL-breach: prijs doorbreekt SL → ghost stopt
        // trueMaxRR = max bereikt vóór de SL-breach
        const slBreach = closedTrade.direction === "buy"
          ? price <= closedTrade.sl
          : price >= closedTrade.sl;

        if (slBreach) {
          const rrAtBreach = calcMaxRRFromPrice(closedTrade, bestPrice);
          console.log(`👻 ${closedTrade.symbol} — SL-breach na close @ ${price} | trueMaxRR=${rrAtBreach}R`);
          finaliseGhost(ghostId, closedTrade, bestPrice, "sl_breach");
          return;
        }
      }

      // Kies polling interval op basis van leeftijd ghost
      const interval = elapsed < GHOST_OLD_THRESHOLD_MS
        ? GHOST_INTERVAL_RECENT_MS   // < 6u: elke 60s
        : GHOST_INTERVAL_OLD_MS;     // ≥ 6u: elke 5min
      currentTimer = setTimeout(tick, interval);
      if (ghostTrackers[ghostId]) ghostTrackers[ghostId].timer = currentTimer;
    } catch (e) { console.warn(`⚠️ Ghost ${ghostId}:`, e.message); }
  }

  currentTimer = setTimeout(tick, GHOST_INTERVAL_RECENT_MS);
  ghostTrackers[ghostId] = { trade: closedTrade, timer: currentTimer, startedAt, bestPrice };

  // Failsafe na 24u+5min
  setTimeout(() => {
    if (ghostTrackers[ghostId])
      finaliseGhost(ghostId, closedTrade, ghostTrackers[ghostId].bestPrice, "failsafe");
  }, GHOST_DURATION_MS + 5 * 60 * 1000);
}

function finaliseGhost(ghostId, trade, bestPrice, reason) {
  if (!ghostTrackers[ghostId]) return;
  clearTimeout(ghostTrackers[ghostId].timer);
  delete ghostTrackers[ghostId];

  // trueMaxRR = max gunstige beweging gemeten tijdens ghost tracking
  // zonder SL te raken — zelfs als trade eerder gesloten werd door TP/manueel
  // Dit is de basis voor de TP lock engine (getBestRR geeft trueMaxRR prioriteit)
  const trueMaxRR = calcMaxRRFromPrice(trade, bestPrice);
  const idx = closedTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    closedTrades[idx].trueMaxRR        = trueMaxRR;
    closedTrades[idx].trueMaxPrice     = bestPrice;
    closedTrades[idx].ghostStopReason  = reason;
    closedTrades[idx].ghostFinalizedAt = new Date().toISOString();

    // Onmiddellijk opslaan in DB
    saveTrade(closedTrades[idx]).catch(e => console.error(`❌ [DB] ghost saveTrade:`, e.message));
    console.log(`✅ Ghost ${trade.symbol} → trueMaxRR: ${trueMaxRR}R (maxRR bij close: ${trade.maxRR}R) | reden: ${reason}`);

    // TP lock engine draait DIRECT na ghost finalisatie op verse trueMaxRR data
    // getBestRR() in de engine geeft trueMaxRR prioriteit boven maxRR
    // → meest positieve EV TP wordt automatisch ingesteld
    runTPLockEngine(trade.symbol).catch(e => console.error(`❌ [TP Lock na ghost ${reason}]:`, e.message));
    runSLLockEngine(trade.symbol).catch(e => console.error(`❌ [SL Lock na ghost ${reason}]:`, e.message));
  }
}

// ══════════════════════════════════════════════════════════════
// TP LOCK ENGINE (sessie-aware + sub-1R + dagelijks reset)
// v4.4: TP lock wordt elke dag opnieuw berekend zodra ghost tracker
//        data bijwerkt (trueMaxRR). Daily reset via cron om middernacht.
//        TP lock = AANPASBAAR elke dag op basis van verse ghost data.
//        EV moet positief zijn voor risk x4 boost te activeren.
// ══════════════════════════════════════════════════════════════

// Dagelijkse reset van TP locks om middernacht Brussels — herberekening op verse data
cron.schedule("0 0 * * *", async () => {
  console.log("🔄 [TP Lock] Dagelijkse reset om middernacht — herberekening op alle trades...");
  const symSet = [...new Set(closedTrades.map(t => t.symbol).filter(Boolean))];
  for (const sym of symSet) {
    await runTPLockEngine(sym).catch(e => console.error(`❌ [TP Lock reset] ${sym}:`, e.message));
  }
  console.log(`✅ [TP Lock] Reset klaar — ${Object.keys(tpLocks).length} locks herberekend`);
}, { timezone: "Europe/Brussels" });
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
// v4.4: SL pas aanpasbaar na 50+ trades (SL_LOCK_THRESHOLD = 50)
//        Onder 50 trades: engine loopt niet, advies = "te weinig data"
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
      versie:         "v4.3",
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
      forexHalfRisk:   `✅ Forex consolidatie: 50% risk bij 1 open, blok bij ≥${FOREX_MAX_SAME_DIR}`,
      forexMinStop:    "✅ Forex min stop: 0.0003 (was 0.0005) voor alle non-JPY pairs",
      ghostTracker:    "✅ Ghost tracker: trueMaxRR = running max GEDURENDE de dag (niet bij close)",
      tpLockReset:     "✅ TP lock: dagelijks herberekend om middernacht op verse ghost data",
      slThreshold:     `✅ SL: read-only, pas aanpasbaar na ${SL_LOCK_THRESHOLD}+ trades`,
      dashboard:       "✅ Dashboard: volledig HTML, gesorteerd op EV",
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
// v4.4: Volledig visueel HTML dashboard
//        - gesorteerd op EV (meest positief → meest negatief)
//        - TP lock per pair per sessie
//        - SL read-only, pas na 50+ trades
//        - open posities, ghost trackers, forex consolidatie status
app.get("/dashboard", (req, res) => {
  resetDailyLossIfNewDay();

  // Bouw TP lock overzicht gesorteerd op EV
  const tpLockRows = Object.entries(tpLocks)
    .map(([key, lock]) => {
      const [sym, sess] = key.split("__");
      return { sym, sess, ...lock };
    })
    .sort((a, b) => (b.evAtLock ?? -99) - (a.evAtLock ?? -99));

  // Bouw gesloten trades overzicht gesorteerd op tradecount per symbol
  const bySymbol = {};
  for (const t of closedTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, ghostPending: 0, evMax: -Infinity };
    bySymbol[t.symbol].count++;
    if (t.trueMaxRR === null) bySymbol[t.symbol].ghostPending++;
  }
  // Koppel EV van beste TP lock per symbool
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym] = key.split("__");
    if (bySymbol[sym] && (lock.evAtLock ?? -Infinity) > bySymbol[sym].evMax) {
      bySymbol[sym].evMax = lock.evAtLock ?? -Infinity;
    }
  }
  // Sorteer: meest positieve EV eerst, dan op trade count
  const symbolRows = Object.entries(bySymbol)
    .sort((a, b) => {
      const evA = a[1].evMax === -Infinity ? -999 : a[1].evMax;
      const evB = b[1].evMax === -Infinity ? -999 : b[1].evMax;
      if (evB !== evA) return evB - evA;
      return b[1].count - a[1].count;
    });

  const openPos = Object.values(openPositions);
  const ghostCount = Object.keys(ghostTrackers).length;
  const now = getBrusselsDateStr();

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PRONTO-AI Dashboard v4.4</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; }
  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 1.2rem; color: #58a6ff; }
  .header .version { font-size: 0.75rem; color: #8b949e; }
  .header .time { font-size: 0.8rem; color: #3fb950; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; padding: 16px 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 16px; }
  .card .label { font-size: 0.7rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.6rem; font-weight: 700; margin-top: 4px; }
  .card .sub { font-size: 0.72rem; color: #8b949e; margin-top: 2px; }
  .green { color: #3fb950; } .red { color: #f85149; } .blue { color: #58a6ff; } .orange { color: #d29922; } .grey { color: #8b949e; }
  section { padding: 0 24px 20px; }
  section h2 { font-size: 0.85rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; padding-top: 16px; border-top: 1px solid #21262d; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th { text-align: left; padding: 6px 10px; color: #8b949e; font-weight: 600; font-size: 0.72rem; text-transform: uppercase; border-bottom: 1px solid #21262d; }
  td { padding: 6px 10px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #1c2128; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 12px; font-size: 0.68rem; font-weight: 600; }
  .badge-green { background: #1a3a1e; color: #3fb950; }
  .badge-red { background: #3a1a1a; color: #f85149; }
  .badge-orange { background: #3a2a0a; color: #d29922; }
  .badge-blue { background: #0d2340; color: #58a6ff; }
  .badge-grey { background: #1c2128; color: #8b949e; }
  .ev-pos { color: #3fb950; font-weight: 700; }
  .ev-neg { color: #f85149; }
  .ev-zero { color: #8b949e; }
  .refresh { color: #58a6ff; font-size: 0.75rem; cursor: pointer; text-decoration: underline; float: right; }
  .warn-box { background: #3a2a0a; border: 1px solid #d29922; border-radius: 6px; padding: 10px 14px; margin: 0 24px 12px; font-size: 0.8rem; color: #d29922; }
</style>
</head>
<body>
<div class="header">
  <h1>🤖 PRONTO-AI &nbsp;<span style="color:#8b949e;font-weight:400">nv-tradingview-webhook</span></h1>
  <div>
    <span class="version">v4.4</span> &nbsp;
    <span class="time">⏱ ${now}</span>
    <span class="refresh" onclick="location.reload()">↻ refresh</span>
  </div>
</div>

${openPos.length === 0 ? "" : `<div class="warn-box">⚡ <strong>${openPos.length} open positie(s)</strong> — live trading actief</div>`}

<div class="grid">
  <div class="card">
    <div class="label">Open posities</div>
    <div class="value ${openPos.length > 0 ? "orange" : "grey"}">${openPos.length}</div>
    <div class="sub">live op MT5</div>
  </div>
  <div class="card">
    <div class="label">Gesloten trades</div>
    <div class="value blue">${closedTrades.length}</div>
    <div class="sub">totaal historiek</div>
  </div>
  <div class="card">
    <div class="label">TP Locks actief</div>
    <div class="value green">${Object.keys(tpLocks).length}</div>
    <div class="sub">sessie-gebaseerd</div>
  </div>
  <div class="card">
    <div class="label">Ghost trackers</div>
    <div class="value ${ghostCount > 0 ? "orange" : "grey"}">${ghostCount}</div>
    <div class="sub">post-close actief</div>
  </div>
  <div class="card">
    <div class="label">Ghost pending</div>
    <div class="value ${closedTrades.filter(t=>t.trueMaxRR===null).length > 0 ? "orange" : "green"}">${closedTrades.filter(t=>t.trueMaxRR===null).length}</div>
    <div class="sub">wacht op trueMaxRR</div>
  </div>
  <div class="card">
    <div class="label">SL analyses</div>
    <div class="value grey">${Object.keys(slLocks).length}</div>
    <div class="sub">readonly, min 50 trades</div>
  </div>
</div>

${openPos.length > 0 ? `
<section>
  <h2>📊 Open posities</h2>
  <table>
    <thead><tr>
      <th>Symbool</th><th>Dir</th><th>Lots</th><th>Risk €</th><th>Sessie</th><th>Flags</th><th>Entry</th><th>SL</th><th>TP</th>
    </tr></thead>
    <tbody>
    ${openPos.map(p => `<tr>
      <td><strong>${p.symbol}</strong></td>
      <td><span class="badge ${p.direction==="buy"?"badge-green":"badge-red"}">${p.direction.toUpperCase()}</span></td>
      <td>${p.lots}</td>
      <td>€${(p.riskEUR||0).toFixed(2)}</td>
      <td><span class="badge badge-blue">${p.session||"?"}</span></td>
      <td>${p.forexHalfRisk?"<span class='badge badge-orange'>½ risk</span>":""}${p.restoredAfterRestart?"<span class='badge badge-grey'>restored</span>":""}</td>
      <td>${p.entry}</td>
      <td>${p.sl}</td>
      <td>${p.tp||"—"}</td>
    </tr>`).join("")}
    </tbody>
  </table>
</section>
` : ""}

<section>
  <h2>🔒 TP Locks — gesorteerd op EV (meest positief → meest negatief)</h2>
  <table>
    <thead><tr>
      <th>#</th><th>Symbool</th><th>Sessie</th><th>TP RR</th><th>EV</th><th>Trades</th><th>Risk boost</th><th>Vergrendeld op</th>
    </tr></thead>
    <tbody>
    ${tpLockRows.length === 0
      ? `<tr><td colspan="8" style="color:#8b949e;text-align:center;padding:20px">Geen TP locks — min 10 trades nodig per symbool/sessie</td></tr>`
      : tpLockRows.map((lock, i) => {
          const evClass = (lock.evAtLock??0) > 0 ? "ev-pos" : (lock.evAtLock??0) < 0 ? "ev-neg" : "ev-zero";
          const evStr = lock.evAtLock != null ? `${lock.evAtLock>0?"+":""}${lock.evAtLock}R` : "—";
          const boost = (lock.evAtLock??0) > 0 ? `<span class="badge badge-green">×4</span>` : `<span class="badge badge-grey">×1</span>`;
          return `<tr>
            <td style="color:#8b949e">${i+1}</td>
            <td><strong>${lock.sym}</strong></td>
            <td><span class="badge badge-blue">${lock.sess}</span></td>
            <td><strong>${lock.lockedRR}R</strong></td>
            <td class="${evClass}">${evStr}</td>
            <td>${lock.lockedTrades}</td>
            <td>${boost}</td>
            <td style="color:#8b949e;font-size:0.75rem">${lock.lockedAt ? new Date(lock.lockedAt).toLocaleDateString("nl-BE") : "—"}</td>
          </tr>`;
        }).join("")
    }
    </tbody>
  </table>
</section>

<section>
  <h2>📈 Trades per symbool — gesorteerd op EV</h2>
  <table>
    <thead><tr>
      <th>#</th><th>Symbool</th><th>Trades</th><th>Ghost pending</th><th>Beste EV (lock)</th><th>Status</th>
    </tr></thead>
    <tbody>
    ${symbolRows.length === 0
      ? `<tr><td colspan="6" style="color:#8b949e;text-align:center;padding:20px">Geen gesloten trades</td></tr>`
      : symbolRows.map(([sym, data], i) => {
          const ev = data.evMax === -Infinity ? null : data.evMax;
          const evClass = ev != null && ev > 0 ? "ev-pos" : ev != null && ev < 0 ? "ev-neg" : "ev-zero";
          const evStr = ev != null ? `${ev>0?"+":""}${ev}R` : "—";
          const ghostBadge = data.ghostPending > 0
            ? `<span class="badge badge-orange">${data.ghostPending} pending</span>`
            : `<span class="badge badge-green">✓ compleet</span>`;
          return `<tr>
            <td style="color:#8b949e">${i+1}</td>
            <td><strong>${sym}</strong></td>
            <td>${data.count}</td>
            <td>${ghostBadge}</td>
            <td class="${evClass}">${evStr}</td>
            <td>${ev != null && ev > 0
              ? `<span class="badge badge-green">✅ risk ×4 actief</span>`
              : data.count < 10
              ? `<span class="badge badge-grey">⏳ te weinig data</span>`
              : `<span class="badge badge-orange">EV negatief</span>`
            }</td>
          </tr>`;
        }).join("")
    }
    </tbody>
  </table>
</section>

<section>
  <h2>📐 SL analyses — read-only (min 50 trades)</h2>
  <table>
    <thead><tr>
      <th>Symbool</th><th>Trades</th><th>Richting advies</th><th>SL mult</th><th>EV bij lock</th><th>Beste TP</th>
    </tr></thead>
    <tbody>
    ${Object.entries(slLocks).length === 0
      ? `<tr><td colspan="6" style="color:#8b949e;text-align:center;padding:20px">Geen SL analyses — min 50 trades nodig per symbool</td></tr>`
      : Object.entries(slLocks).map(([sym, lock]) => `<tr>
          <td><strong>${sym}</strong></td>
          <td>${lock.lockedTrades}</td>
          <td>${lock.direction==="up"?"🔼 Vergroot SL":lock.direction==="down"?"🔽 Verklein SL":"✅ Huidig optimaal"}</td>
          <td>${lock.multiplier}×</td>
          <td class="${(lock.evAtLock??0)>0?"ev-pos":"ev-neg"}">${lock.evAtLock!=null?`${lock.evAtLock>0?"+":""}${lock.evAtLock}R`:"—"}</td>
          <td>${lock.bestTPRR ? lock.bestTPRR+"R" : "—"}</td>
        </tr>`).join("")
    }
    </tbody>
  </table>
</section>

${Object.keys(ghostTrackers).length > 0 ? `
<section>
  <h2>👻 Actieve ghost trackers</h2>
  <table>
    <thead><tr>
      <th>Symbool</th><th>Dir</th><th>Entry</th><th>SL</th><th>Max RR bij close</th><th>Huidig best RR</th><th>Actief (min)</th><th>Resterend (min)</th>
    </tr></thead>
    <tbody>
    ${Object.entries(ghostTrackers).map(([id, g]) => {
      const elapsed = Math.round((Date.now()-g.startedAt)/60000);
      const remaining = Math.round((GHOST_DURATION_MS-(Date.now()-g.startedAt))/60000);
      const currRR = calcMaxRRFromPrice(g.trade, g.bestPrice);
      return `<tr>
        <td><strong>${g.trade.symbol}</strong></td>
        <td><span class="badge ${g.trade.direction==="buy"?"badge-green":"badge-red"}">${g.trade.direction.toUpperCase()}</span></td>
        <td>${g.trade.entry}</td>
        <td>${g.trade.sl}</td>
        <td>${g.trade.maxRR}R</td>
        <td class="${currRR>g.trade.maxRR?"ev-pos":""}">${currRR}R</td>
        <td>${elapsed}</td>
        <td>${remaining}</td>
      </tr>`;
    }).join("")}
    </tbody>
  </table>
</section>
` : ""}

<section style="padding-bottom:32px">
  <h2>⚙️ Systeem configuratie</h2>
  <table>
    <thead><tr><th>Parameter</th><th>Waarde</th></tr></thead>
    <tbody>
      <tr><td>Forex max trades (blok bij ≥)</td><td><strong>${FOREX_MAX_SAME_DIR}</strong> per pair+richting</td></tr>
      <tr><td>Forex half risk bij</td><td>≥ ${FOREX_HALF_RISK_THRESHOLD} open zelfde pair+richting</td></tr>
      <tr><td>Forex min stop</td><td>0.0003 (non-JPY) | 0.05 (JPY pairs)</td></tr>
      <tr><td>Spread guard</td><td>max 1/3 van SL-afstand</td></tr>
      <tr><td>TP lock threshold</td><td>${TP_LOCK_THRESHOLD} trades | dagelijks herberekend om middernacht</td></tr>
      <tr><td>SL lock threshold</td><td>${SL_LOCK_THRESHOLD} trades (read-only)</td></tr>
      <tr><td>Risk per type (normaal / TP lock ×4)</td><td>${Object.entries(RISK).map(([t,v])=>`${t}: €${v}/€${v*TP_LOCK_RISK_MULT}`).join(" | ")}</td></tr>
      <tr><td>FTMO Safety Check</td><td><span class="badge badge-red">⚠️ UIT — moet geïmplementeerd worden voor live!</span></td></tr>
    </tbody>
  </table>
</section>

</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
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
      `✅ [FIX] Forex max ${FOREX_MAX_SAME_DIR} trades per pair+richting (blok bij ≥${FOREX_MAX_SAME_DIR}, half risk bij 1)`,
      `✅ [FIX] Forex min stop: 0.0003 voor non-JPY pairs (was 0.0005)`,
      `✅ [FIX] Ghost tracker: trueMaxRR = running max GEDURENDE dag (niet bij close)`,
      `✅ [FIX] TP lock: dagelijks herberekend om middernacht`,
      `✅ [FIX] SL: read-only tot ${SL_LOCK_THRESHOLD}+ trades per symbool`,
      `✅ [FIX] Dashboard: volledig HTML, gesorteerd op EV`,
      `📈 Risico | Index:€${RISK.index} Forex:€${RISK.forex} Gold:€${RISK.gold} Crypto:€${RISK.crypto} Stock:€${RISK.stock}`,
      `💰 Cap per type: Index €${RISK.index}→€${RISK.index*TP_LOCK_RISK_MULT} | Forex €${RISK.forex}→€${RISK.forex*TP_LOCK_RISK_MULT}`,
      `🔄 Forex anti-consolidatie: half risk bij 1 open | blok bij ≥${FOREX_MAX_SAME_DIR}`,
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
