// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v4.4
// Account : Nick Verschoot — FTMO Demo
// ───────────────────────────────────────────────────────────────
// SESSIES (Brussels — automatisch zomer/wintertijd):
//   asia      → 02:00–08:00
//   london    → 08:00–15:30
//   ny        → 15:30–20:00
//
// WIJZIGINGEN v4.4 (t.o.v. v4.3):
//  ✅ [SPREAD] Spread blokkeert niet meer — markeert trade als spreadGuard=true
//             Geldt nu voor ALLE types (was stock-only)
//             Trades met hoge spread worden UITGESLOTEN van TP/SL analyse
//  ✅ [SL] Drempel voor SL-advies verhoogd van 10 naar 50 trades
//          Meer data = betrouwbaarder advies
//  ✅ [SECURITY] Webhook secret enkel via body of x-secret header
//               Query param (?secret=) niet meer ondersteund
//  ✅ [SECURITY] Analyse-endpoints beveiligd met x-secret header
//  ✅ [RACE] Webhook mutex per symbool+richting — dubbele signalen geblokkeerd
//  ✅ [TIMEOUT] Alle MetaAPI fetch-calls hebben 8s timeout
//  ✅ [PERSIST] learnedPatches opgeslagen in PostgreSQL — niet verloren na restart
//  ✅ [FIX] learnFromError muteert geen globale constanten meer
//  ✅ [FIX] restoreOpenPositionsFromMT5: riskEUR berekend uit lots × SL-afstand
//  ✅ [FTMO] ftmoSafetyCheck implementeert dagelijkse verlieslimieten (5% default)
//  ✅ [DB] pool.end() op SIGTERM/SIGINT
//  ✅ [PERF] syncPositions slaat over als geen posities open zijn
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
  saveLearnedPatch, loadLearnedPatches,
  endPool,
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
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || "10000");

// FTMO dagelijks verlies: standaard 5% van ACCOUNT_BALANCE
const FTMO_DAILY_LOSS_PCT = parseFloat(process.env.FTMO_DAILY_LOSS_PCT || "5");

if (!META_API_TOKEN)  console.error("❌ META_API_TOKEN niet ingesteld!");
if (!META_ACCOUNT_ID) console.error("❌ META_ACCOUNT_ID niet ingesteld!");
if (!WEBHOOK_SECRET)  console.error("❌ WEBHOOK_SECRET niet ingesteld!");

const GHOST_DURATION_MS        = 24 * 3600 * 1000;
const GHOST_INTERVAL_RECENT_MS = 60 * 1000;
const GHOST_INTERVAL_OLD_MS    = 5 * 60 * 1000;
const GHOST_OLD_THRESHOLD_MS   = 6 * 3600 * 1000;

const FETCH_TIMEOUT_MS = 8_000;  // MetaAPI timeout

// ── RR / SL LEVELS ────────────────────────────────────────────
const RR_LEVELS    = [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25];
const SL_MULTIPLES = [0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

const SL_PROVEN_MULT       = 0.5;
const STOCK_SL_SPREAD_MULT = 1.5;

// v4.4: spread > 33% van SL-afstand → trade MARKEERT maar blokkeert NIET
//       Geldt voor ALLE types. Gemarkeerde trades worden uitgesloten van analyse.
const SPREAD_MAX_FRACTION = 0.333;

// Forex anti-consolidatie
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

const TP_LOCK_RISK_MULT = 4;

// ── FTMO DAGELIJKS VERLIES ────────────────────────────────────
let ftmoDailyLossUsed = 0;
let ftmoLastDayReset  = new Date().toDateString();

function resetDailyLossIfNewDay() {
  const today = new Date().toDateString();
  if (today !== ftmoLastDayReset) {
    ftmoDailyLossUsed = 0;
    ftmoLastDayReset  = today;
    console.log("🔄 [FTMO] Dagelijkse verlies teller gereset");
  }
}

/**
 * v4.4: Echte dagelijkse verliescontrole (was altijd { ok: true }).
 * Blokkeert trade als ftmoDailyLossUsed + riskEUR > FTMO_DAILY_LOSS_PCT % van balance.
 */
function ftmoSafetyCheck(riskEUR) {
  resetDailyLossIfNewDay();
  const dailyLimit = ACCOUNT_BALANCE * (FTMO_DAILY_LOSS_PCT / 100);
  if (ftmoDailyLossUsed + riskEUR > dailyLimit) {
    return {
      ok:     false,
      reason: `FTMO dagelijkse verlimiet: €${ftmoDailyLossUsed.toFixed(2)} gebruikt + €${riskEUR.toFixed(2)} aangevraagd > limiet €${dailyLimit.toFixed(2)} (${FTMO_DAILY_LOSS_PCT}% van €${ACCOUNT_BALANCE})`,
    };
  }
  return { ok: true };
}

function registerFtmoLoss(r) {
  ftmoDailyLossUsed += r;
  const dailyLimit = ACCOUNT_BALANCE * (FTMO_DAILY_LOSS_PCT / 100);
  console.log(`📉 FTMO dagelijks: €${ftmoDailyLossUsed.toFixed(2)} / €${dailyLimit.toFixed(2)}`);
}

// ── SECURITY MIDDLEWARE ───────────────────────────────────────

/**
 * Beschermt analyse- en beheer-endpoints met x-secret header.
 * Webhook gebruikt eigen check (ook body secret voor TradingView compat).
 */
function requireAuth(req, res, next) {
  const secret = req.headers["x-secret"];
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized — stuur x-secret header" });
  }
  next();
}

// ── IN-MEMORY STORES ──────────────────────────────────────────
const openTradeTracker = {};
const openPositions    = {};
const closedTrades     = [];
const accountSnapshots = [];
const webhookHistory   = [];
const ghostTrackers    = {};

// v4.4: race condition bescherming — duplicaat-signalen per symbool+richting
const webhookLocks = new Set();

// ── TP / SL LOCK CONFIG ───────────────────────────────────────
const TP_LOCK_THRESHOLD  = 10;
const TP_UPDATE_INTERVAL = 10;

// v4.4: SL advies pas na 50 trades — meer data, betrouwbaarder advies
const SL_LOCK_THRESHOLD  = 50;
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

// v4.4: learnedPatches wordt ook naar DB geschreven (zie startServer + learnFromError)
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
  "GER40.cash":  10, "UK100.cash":   5, "US100.cash":  10,
  "US30.cash":   10, "US500.cash":   5, "JP225.cash":  10,
  "AUS200.cash":  5, "EU50.cash":    5, "FRA40.cash":   5,
  "HK50.cash":   10, "US2000.cash":  5, "SPN35.cash":   5, "NL25.cash": 5,
};

const MIN_STOP_COMMODITY = {
  "XAUUSD": 1.0, "UKOIL.cash": 0.05, "USOIL.cash": 0.05,
  "BTCUSD": 100.0, "ETHUSD": 5.0,
};

const MIN_STOP_FOREX = {
  "EURUSD": 0.0005, "GBPUSD": 0.0005, "AUDUSD": 0.0005,
  "NZDUSD": 0.0005, "USDCHF": 0.0005, "USDCAD": 0.0005,
  "EURGBP": 0.0005, "EURAUD": 0.0005, "EURCAD": 0.0005,
  "EURCHF": 0.0005, "GBPAUD": 0.0005, "GBPCAD": 0.0005,
  "GBPCHF": 0.0005, "AUDCAD": 0.0005, "AUDCHF": 0.0005,
  "AUDNZD": 0.0005, "CADCHF": 0.0005, "NZDCAD": 0.0005, "NZDCHF": 0.0005,
  "USDJPY": 0.05, "EURJPY": 0.05, "GBPJPY": 0.05,
  "AUDJPY": 0.05, "CADJPY": 0.05, "NZDJPY": 0.05, "CHFJPY": 0.05,
};

const MIN_STOP_STOCK_PCT = 0.001;

/**
 * v4.4: Controleert learnedPatches voor minStopOverride VOOR het raadplegen
 *       van de globale constanten. learnFromError muteert de globale maps niet meer.
 */
function getMinStop(mt5Symbol, type, entryPrice = 0) {
  const patch = learnedPatches[mt5Symbol];
  if (patch?.minStopOverride) return patch.minStopOverride;

  if (type === "stock")  return Math.max(0.01, entryPrice * MIN_STOP_STOCK_PCT);
  if (type === "index")  return MIN_STOP_INDEX[mt5Symbol]     ?? 5;
  if (type === "gold")   return MIN_STOP_COMMODITY[mt5Symbol] ?? 1.0;
  if (type === "brent")  return MIN_STOP_COMMODITY[mt5Symbol] ?? 0.05;
  if (type === "wti")    return MIN_STOP_COMMODITY[mt5Symbol] ?? 0.05;
  if (type === "crypto") return MIN_STOP_COMMODITY[mt5Symbol] ?? 100;
  if (type === "forex")  return MIN_STOP_FOREX[mt5Symbol]     ?? 0.0005;
  return 0.01;
}

const WEEKEND_ALLOWED = new Set(["BTCUSD", "ETHUSD"]);
function isCryptoWeekend(sym) {
  return WEEKEND_ALLOWED.has(sym) || ["BTC", "ETH"].some(c => sym.startsWith(c));
}

function getMT5Symbol(sym) {
  if (learnedPatches[sym]?.mt5Override) return learnedPatches[sym].mt5Override;
  return SYMBOL_MAP[sym]?.mt5 ?? sym;
}

function getSymbolType(sym) {
  if (SYMBOL_MAP[sym]) return SYMBOL_MAP[sym].type;
  if (["BTC", "ETH"].some(c => sym.startsWith(c))) return "crypto";
  return "stock";
}

function isMarketOpen(type, symbol) {
  return isMarketOpenFn(type, symbol, isCryptoWeekend);
}

// ── METAAPI ───────────────────────────────────────────────────
const META_BASE = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

/**
 * v4.4: fetch met AbortController timeout.
 * Voorkomt dat een trage MetaAPI een webhook indefinite laat hangen.
 */
async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`MetaAPI timeout (${ms}ms): ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenPositions() {
  const r = await fetchWithTimeout(`${META_BASE}/positions`, {
    headers: { "auth-token": META_API_TOKEN },
  });
  if (!r.ok) throw new Error(`positions ${r.status}`);
  return r.json();
}

async function fetchAccountInfo() {
  const r = await fetchWithTimeout(`${META_BASE}/accountInformation`, {
    headers: { "auth-token": META_API_TOKEN },
  });
  if (!r.ok) throw new Error(`accountInfo ${r.status}`);
  return r.json();
}

async function closePosition(id) {
  const r = await fetchWithTimeout(`${META_BASE}/positions/${id}/close`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
  });
  return r.json();
}

async function fetchCurrentPrice(mt5Symbol) {
  try {
    const r = await fetchWithTimeout(
      `${META_BASE}/symbols/${encodeURIComponent(mt5Symbol)}/currentPrice`,
      { headers: { "auth-token": META_API_TOKEN } }
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
        addWebhookHistory({ type: "AUTOCLOSE_2050", symbol: pos.symbol, positionId: pos.id });
      } catch (e) { console.error(`❌ Auto-close ${pos.symbol}:`, e.message); }
    }
  } catch (e) { console.error("❌ Auto-close fout:", e.message); }
}, { timezone: "Europe/Brussels" });

// ══════════════════════════════════════════════════════════════
// RESTART RECOVERY — openPositions her-initialiseren
// v4.4 FIX: riskEUR berekend uit lots × SL-afstand (was altijd base risk)
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

      const tvSym    = Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k].mt5 === pos.symbol) || pos.symbol;
      const direction = pos.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
      const entry     = pos.openPrice  ?? pos.currentPrice ?? 0;
      const sl        = pos.stopLoss   ?? 0;
      const tp        = pos.takeProfit ?? null;
      const lots      = pos.volume     ?? 0.01;
      const type      = getSymbolType(tvSym);
      const session   = getSessionGMT1(pos.time ? new Date(pos.time) : null);

      // v4.4 FIX: schat werkelijk risico op basis van lots × SL-afstand
      const lotVal       = LOT_VALUE[type] || 1;
      const slDist       = Math.abs(entry - sl);
      const estimatedRisk = (slDist > 0 && lots > 0)
        ? parseFloat((lots * slDist * lotVal).toFixed(2))
        : (RISK[type] ?? 30);

      openPositions[id] = {
        id, symbol: tvSym, mt5Symbol: pos.symbol, direction,
        entry, sl, tp, lots,
        riskEUR:   estimatedRisk,
        openedAt:  pos.time ?? new Date().toISOString(),
        session,   sessionLabel: SESSION_LABELS[session] || session,
        maxPrice:  entry, maxRR: 0, currentPnL: pos.unrealizedProfit ?? pos.profit ?? 0,
        lastSync:  null, slMultiplierApplied: 1.0, spreadGuard: false,
        restoredAfterRestart: true,
      };

      incrementTracker(tvSym, direction);
      restored++;
      console.log(`🔄 [Restart Recovery] ${tvSym} (${direction}) id=${id} entry=${entry} estimatedRisk=€${estimatedRisk}`);
    }
    console.log(`✅ [Restart Recovery] ${restored} positie(s) hersteld van MT5`);
  } catch (e) {
    console.warn("⚠️ [Restart Recovery] Mislukt:", e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// FOREX ANTI-CONSOLIDATIE (half risk bij count 1–2)
// ══════════════════════════════════════════════════════════════
function checkForexConsolidation(symbol, direction) {
  const mt5Sym = getMT5Symbol(symbol);
  let count = 0;
  for (const pos of Object.values(openPositions)) {
    const posMt5 = getMT5Symbol(pos.symbol) || pos.mt5Symbol;
    if ((posMt5 === mt5Sym || pos.symbol === symbol) && pos.direction === direction) count++;
  }
  return {
    blocked:  count >= FOREX_MAX_SAME_DIR,
    halfRisk: count >= FOREX_HALF_RISK_THRESHOLD && count < FOREX_MAX_SAME_DIR,
    count,
  };
}

// ── ANALYSE FILTER HELPER ─────────────────────────────────────
/**
 * v4.4: Sluit trades met hoge spread uit van alle statistische berekeningen.
 * spreadGuard=true = spread was >33% van SL-afstand bij orderplaatsing.
 */
function filterForAnalysis(trades) {
  return trades.filter(t => !t.spreadGuard);
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
    const adj = dir === "buy" ? entry - minD : entry + minD;
    console.warn(`⚠️ SL te dicht (${dist.toFixed(5)} < min ${minD}) → ${adj}`);
    return parseFloat(adj.toFixed(5));
  }
  return sl;
}

/**
 * Lot-berekening. Cap = baseRisk per type (v4.3 fix behouden).
 */
function calcLots(symbol, entry, sl, risk) {
  const type    = getSymbolType(symbol);
  const lotVal  = LOT_VALUE[type]  || 1;
  const maxLots = MAX_LOTS[type]   || 50;
  const patch   = learnedPatches[symbol];
  const lotStep = patch?.lotStepOverride || (type === "stock" ? 1 : 0.01);
  const dist    = Math.abs(entry - sl);
  if (dist <= 0) return lotStep;

  let lots = Math.floor((risk / (dist * lotVal)) / lotStep) * lotStep;
  lots     = Math.min(lots, maxLots);
  lots     = Math.max(lots, lotStep);

  const minCost       = lots * dist * lotVal;
  const baseRisk      = RISK[type] || 30;
  const isTPLockRisk  = risk >= baseRisk * TP_LOCK_RISK_MULT;
  const effectiveCap  = isTPLockRisk ? baseRisk * TP_LOCK_RISK_MULT : baseRisk;

  if (minCost > effectiveCap) {
    console.warn(`⚠️ Min lot kost €${minCost.toFixed(2)} > cap €${effectiveCap} (${type}) → skip`);
    return null;
  }
  return parseFloat(lots.toFixed(2));
}

function calcMaxRR(trade) {
  const { direction, entry, sl, maxPrice } = trade;
  const d = Math.abs(entry - sl);
  if (!d || !maxPrice) return 0;
  const fav = direction === "buy" ? maxPrice - entry : entry - maxPrice;
  return parseFloat((Math.max(0, fav) / d).toFixed(2));
}

function calcMaxRRFromPrice(trade, price) {
  const d = Math.abs(trade.entry - trade.sl);
  if (!d || price == null) return 0;
  const fav = trade.direction === "buy" ? price - trade.entry : trade.entry - price;
  return parseFloat((Math.max(0, fav) / d).toFixed(2));
}

function getBestRR(trade) {
  return trade.trueMaxRR ?? trade.maxRR ?? 0;
}

// ── SL ANALYSE HELPER ─────────────────────────────────────────
function buildSLAnalysis(trades) {
  // v4.4: trades zijn al gefilterd via filterForAnalysis() voor aanroep
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
    const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a);
    return {
      slMultiple: mult,
      label: mult===1.0 ? "✅ huidig" : mult<1.0 ? `🔽 ${mult}× kleiner` : `🔼 ${mult}× groter`,
      bestTP: `${best.rr}R`, bestEV: best.ev, bestWinrate: best.winrate, evTable,
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
// Prioriteit batching: recent < 6u → 60s, oud ≥ 6u → 5min
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
// TP LOCK ENGINE (sessie-aware + sub-1R)
// v4.4: sluit hoge-spread trades uit van EV berekening
// ══════════════════════════════════════════════════════════════
async function runTPLockEngine(symbol) {
  for (const session of TRADING_SESSIONS) {
    await _runTPLockForSession(symbol, session).catch(e =>
      console.error(`❌ [TP Lock] ${symbol}/${session}:`, e.message)
    );
  }
}

async function _runTPLockForSession(symbol, session) {
  // v4.4: hoge-spread trades uitgesloten van EV berekening
  const trades = filterForAnalysis(
    closedTrades.filter(t => t.symbol === symbol && t.sl && t.entry && t.session === session)
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
    lockedRR: best.rr, lockedAt: new Date().toISOString(), lockedTrades: n,
    session, prevRR: oldRR, prevLockedAt: existing?.lockedAt ?? null, evAtLock: best.ev,
  };

  const logEntry = { symbol, session, oldRR, newRR: best.rr, trades: n, ev: best.ev, reason, ts: new Date().toISOString() };
  tpUpdateLog.unshift(logEntry);
  if (tpUpdateLog.length > MAX_TP_LOG) tpUpdateLog.length = MAX_TP_LOG;

  try {
    await saveTPConfig(symbol, session, best.rr, n, best.ev, oldRR, existing?.lockedAt ?? null);
    await logTPUpdate(symbol, session, oldRR, best.rr, n, best.ev, reason);
  } catch (e) { console.error(`❌ [TP Lock] DB:`, e.message); }

  console.log(`🔒 [TP Lock] ${symbol}/${session}: ${isNew?"NIEUW":"UPDATE"} → ${best.rr}R (EV +${best.ev}R | ${n} trades)`);
}

// ══════════════════════════════════════════════════════════════
// SL LOCK ENGINE (ghost-driven + READONLY)
// v4.4: drempel 50 trades, hoge-spread trades uitgesloten
// ══════════════════════════════════════════════════════════════
async function runSLLockEngine(symbol) {
  // v4.4: hoge-spread trades uitgesloten + drempel = 50
  const trades = filterForAnalysis(
    closedTrades.filter(t => t.symbol === symbol && t.sl && t.entry)
  );
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
// v4.4: slaat over als geen open posities — vermijdt onnodige API calls
// ══════════════════════════════════════════════════════════════
async function syncPositions() {
  // v4.4: optimalisatie — skip als niets open
  if (Object.keys(openPositions).length === 0) return;

  try {
    const live    = await fetchOpenPositions();
    const liveIds = new Set((live || []).map(p => String(p.id)));

    for (const pos of (live || [])) {
      const id    = String(pos.id);
      const trade = openPositions[id];
      if (!trade) continue;
      const cur   = pos.currentPrice ?? pos.openPrice ?? 0;
      const lotV  = LOT_VALUE[getSymbolType(trade.symbol)] || 1;
      trade.currentPnL = parseFloat((
        pos.unrealizedProfit ?? pos.profit ??
        ((trade.direction === "buy" ? cur - trade.entry : trade.entry - cur) * trade.lots * lotV)
      ).toFixed(2));
      const better = trade.direction === "buy"
        ? cur > (trade.maxPrice ?? trade.entry)
        : cur < (trade.maxPrice ?? trade.entry);
      if (better) { trade.maxPrice = cur; trade.maxRR = calcMaxRR({ ...trade, maxPrice: cur }); }
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
          maxRR, session,
          sessionLabel: SESSION_LABELS[session] || session,
          trueMaxRR:    null, trueMaxPrice: null,
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
        floatingPL: parseFloat(((info.equity ?? 0) - (info.balance ?? 0)).toFixed(2)),
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
// v4.4: learnFromError muteert geen globale constanten meer
//       Overrides opgeslagen in learnedPatches + DB
// ══════════════════════════════════════════════════════════════
function learnFromError(symbol, code, msg) {
  const m = (msg || "").toLowerCase();
  if (!learnedPatches[symbol]) learnedPatches[symbol] = {};
  const patch = learnedPatches[symbol];

  if (code === "TRADE_RETCODE_INVALID" && m.includes("symbol")) {
    const cur   = getMT5Symbol(symbol);
    const tried = patch._triedMt5 || [];
    const next  = [cur.replace(".cash", ""), cur + ".cash"]
      .filter(s => s !== cur && !tried.includes(s))[0];
    if (next) {
      patch.mt5Override = next;
      patch._triedMt5   = [...tried, next];
    }
  }
  if (m.includes("volume") || m.includes("lot")) {
    patch.lotStepOverride = (patch.lotStepOverride || 0.01) * 10;
  }
  if (m.includes("stop") || code === "TRADE_RETCODE_INVALID_STOPS") {
    // v4.4 FIX: niet meer globale MIN_STOP_INDEX/MIN_STOP_FOREX muteren
    //           Sla override op in learnedPatches (persistente per-symbool cache)
    const mt5  = getMT5Symbol(symbol);
    const type = getSymbolType(symbol);
    const currentMin = getMinStop(mt5, type, 0);
    patch.minStopOverride = currentMin * 2;
    console.log(`🧠 [Learn] ${symbol}: minStop override → ${patch.minStopOverride}`);
  }

  // v4.4: persisteer naar DB zodat dit niet verloren gaat bij Railway restart
  saveLearnedPatch(symbol, patch).catch(e =>
    console.warn(`⚠️ [LearnedPatch] DB opslaan mislukt: ${e.message}`)
  );
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
    actionType: dir === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    stopLoss:   slPrice,
    comment:    `FTMO-NV-${dir.toUpperCase()}-${symbol}${tpLock ? `-TP${tpLock.lockedRR}R-${session}` : ""}`,
    ...(tpPrice ? { takeProfit: tpPrice } : {}),
  };

  const r = await fetchWithTimeout(`${META_BASE}/trade`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
    body:    JSON.stringify(body),
  });
  return { result: await r.json(), mt5Symbol, slPrice, body };
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK
// v4.4:
//  - Secret: body (req.body.secret) OF header (x-secret), NIET meer query param
//  - Spread: markeert alle types (niet enkel stocks), blokkeert NIET
//  - Mutex: duplicaat-signalen per symbool+richting geblokkeerd
// ══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  try {
    // v4.4: secret via body of header — query param verwijderd (verscheen in logs)
    const secret = req.body?.secret || req.headers["x-secret"];
    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const symbol = (!req.body.symbol || req.body.symbol === "{{ticker}}") ? null : req.body.symbol;
    if (!symbol) return res.status(400).json({ error: "Symbool ontbreekt" });

    const { action, entry, sl } = req.body;
    if (!action || !entry || !sl) return res.status(400).json({ error: "Vereist: action, entry, sl" });

    const direction = ["buy", "bull", "long"].includes(action.toLowerCase()) ? "buy" : "sell";
    const entryNum  = parseFloat(entry);
    let   slNum     = parseFloat(sl);

    if (isNaN(entryNum) || isNaN(slNum)) return res.status(400).json({ error: "entry/sl geen getallen" });
    if (direction === "buy"  && slNum >= entryNum) return res.status(400).json({ error: "SL onder entry voor BUY" });
    if (direction === "sell" && slNum <= entryNum) return res.status(400).json({ error: "SL boven entry voor SELL" });

    const symType    = getSymbolType(symbol);
    const mt5Sym     = getMT5Symbol(symbol);
    const curSession = getSessionGMT1();

    // v4.4: Mutex — voorkomt dubbele positie bij gelijktijdige signalen
    const lockKey = `${symbol}_${direction}`;
    if (webhookLocks.has(lockKey)) {
      console.warn(`⚠️ [Mutex] Duplicaat signaal geblokkeerd: ${symbol} ${direction}`);
      addWebhookHistory({ type: "DUPLICATE_BLOCKED", symbol, direction });
      return res.status(200).json({ status: "SKIP", reason: "Duplicaat signaal — vorige verwerking lopend" });
    }
    webhookLocks.add(lockKey);

    try {
      return await _handleWebhook(req, res, symbol, symType, mt5Sym, direction, entryNum, slNum, curSession);
    } finally {
      webhookLocks.delete(lockKey);
    }
  } catch (err) {
    console.error("❌ Webhook fout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

async function _handleWebhook(req, res, symbol, symType, mt5Sym, direction, entryNum, slNum, curSession) {
  if (!isMarketOpen(symType, symbol)) {
    addWebhookHistory({ type: "MARKET_CLOSED", symbol, symType });
    return res.status(200).json({ status: "SKIP", reason: `Markt gesloten voor ${symbol}` });
  }

  // ── Forex consolidatie
  let forexHalfRisk = false;
  if (symType === "forex") {
    const consol = checkForexConsolidation(symbol, direction);
    if (consol.blocked) {
      const reason = `Anti-consolidatie: ${consol.count} open ${direction} trades voor ${symbol}`;
      logForexConsolidation(symbol, direction, consol.count, reason).catch(() => {});
      addWebhookHistory({ type: "FOREX_CONSOLIDATION_BLOCKED", symbol, direction, count: consol.count });
      return res.status(200).json({ status: "SKIP", reason });
    }
    if (consol.halfRisk) {
      forexHalfRisk = true;
      console.log(`⚡ [Forex Consolidatie] ${symbol} ${direction}: ${consol.count} open → half risk`);
    }
  }

  // ── SL aanpassing
  const tpLockKey = `${symbol}__${curSession}`;
  const tpLockNow = tpLocks[tpLockKey];
  const tpProven  = tpLockNow && (tpLockNow.evAtLock ?? 0) > 0;

  let slApplied  = slNum;
  let slLockInfo = null;

  if (tpProven) {
    slApplied  = applySlMultiplier(direction, entryNum, slNum, SL_PROVEN_MULT);
    slLockInfo = `${SL_PROVEN_MULT}× (TP bewezen ${symbol}/${curSession}, EV +${tpLockNow.evAtLock}R)`;
    console.log(`📐 [SL] ${symbol}/${curSession}: SL=${slNum} → ${slApplied} (${SL_PROVEN_MULT}× TP lock bewezen)`);
  }

  // ── v4.4 SPREAD CHECK — alle types, blokkeert NIET, markeert alleen
  //    spreadGuard=true → trade wordt uitgevoerd maar uitgesloten van TP/SL analyse
  let spreadGuard = false;
  const priceData = await fetchCurrentPrice(mt5Sym);
  if (priceData?.spread > 0) {
    const slDist = Math.abs(entryNum - slApplied);
    if (slDist > 0 && priceData.spread > slDist * SPREAD_MAX_FRACTION) {
      spreadGuard = true;
      const pct = (priceData.spread / slDist * 100).toFixed(1);
      console.warn(`⚠️ [Spread] ${symbol}: ${pct}% van SL-afstand (max ${Math.round(SPREAD_MAX_FRACTION*100)}%) — trade doorgezet, uitgesloten van analyse`);
      addWebhookHistory({ type: "SPREAD_HIGH", symbol, symType, spreadPct: parseFloat(pct) });
    }
  }

  // ── Risico berekening
  let risk = getEffectiveRisk(symbol, direction);
  if (forexHalfRisk) {
    risk = risk * 0.5;
    console.log(`⚡ [Forex Half Risk] ${symbol}: risico gehalveerd → €${risk.toFixed(2)}`);
  }

  const ftmo = ftmoSafetyCheck(risk);
  if (!ftmo.ok) {
    addWebhookHistory({ type: "FTMO_BLOCKED", symbol, reason: ftmo.reason });
    return res.status(200).json({ status: "FTMO_BLOCKED", reason: ftmo.reason });
  }

  const lots = calcLots(symbol, entryNum, slApplied, risk);
  if (lots === null) {
    addWebhookHistory({ type: "SKIP_MIN_LOT", symbol });
    return res.status(200).json({ status: "SKIP", reason: "Min lot > cap" });
  }

  const slDist = Math.abs(entryNum - slApplied).toFixed(5);
  console.log(`📊 ${direction.toUpperCase()} ${symbol}/${curSession} | Entry:${entryNum} SL:${slApplied} Lots:${lots} Risk:€${risk.toFixed(2)}${forexHalfRisk ? " [HALF]" : ""}${spreadGuard ? " [SPREAD⚠️]" : ""}`);

  let { result, mt5Symbol, slPrice } = await placeOrder(direction, symbol, entryNum, slApplied, lots, curSession);

  const errCode = result?.error?.code || result?.retcode;
  const errMsg  = result?.error?.message || result?.comment || "";
  const isError = result?.error || (errCode && errCode !== 10009 && errCode !== "TRADE_RETCODE_DONE");

  if (isError) {
    learnFromError(symbol, errCode, errMsg);
    const rl = calcLots(symbol, entryNum, slApplied, risk);
    if (rl !== null) {
      const retry    = await placeOrder(direction, symbol, entryNum, slApplied, rl, curSession);
      result         = retry.result;
      slPrice        = retry.slPrice;
      const retryErr = retry.result?.error || (retry.result?.retcode && retry.result.retcode !== 10009 && retry.result.retcode !== "TRADE_RETCODE_DONE");
      if (retryErr) {
        learnFromError(symbol, retry.result?.error?.code || retry.result?.retcode, retry.result?.error?.message || retry.result?.comment);
        addWebhookHistory({ type: "ERROR", symbol, errCode, errMsg });
        return res.status(200).json({ status: "ERROR_LEARNED", errCode, errMsg });
      }
    }
  }

  registerFtmoLoss(risk);
  incrementTracker(symbol, direction);

  const posId        = String(result?.positionId || result?.orderId || Date.now());
  const tpLockActive = tpLocks[tpLockKey];
  const tpUsed       = tpLockActive ? calcTPPrice(direction, entryNum, slPrice, tpLockActive.lockedRR) : null;
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
    type: "SUCCESS", symbol, mt5Symbol, direction, lots, posId,
    session:      curSession,
    riskEUR:      risk.toFixed(2),
    spreadGuard:  spreadGuard ? `⚠️ hoge spread — uitgesloten van analyse` : null,
    slAanpassing: slLockInfo ?? "geen",
    tp:           tpUsed ? `${tpLockActive.lockedRR}R @ ${tpUsed}` : "geen",
    riskBoost:    tpProven ? `×${TP_LOCK_RISK_MULT}` : "×1",
    forexHalfRisk: forexHalfRisk ? "50%" : null,
  });

  return res.json({
    status:        "OK",
    versie:        "v4.4",
    direction,
    tvSymbol:      symbol,
    mt5Symbol,
    symType,
    session:       curSession,
    sessionLabel:  SESSION_LABELS[curSession],
    entry:         entryNum,
    sl:            slPrice,
    slOriginal:    slNum,
    slMultiplier:  slMultApplied,
    slLockInfo:    slLockInfo ?? `geen — TP lock niet bewezen voor ${curSession}`,
    stockSlBuffer: symType === "stock" ? `×${STOCK_SL_SPREAD_MULT} spread buffer toegepast` : null,
    tp:            tpUsed,
    tpRR:          tpLockActive?.lockedRR ?? null,
    tpInfo:        tpUsed
      ? `TP lock ${tpLockActive.lockedRR}R [${curSession}] → ${tpUsed}`
      : `Geen TP lock voor ${symbol}/${curSession}`,
    slDist,
    lots,
    risicoEUR:     risk.toFixed(2),
    riskBoost:     tpProven ? `×${TP_LOCK_RISK_MULT} (TP lock actief)` : "×1",
    forexHalfRisk: forexHalfRisk ? "⚡ 50% risk — consolidatie" : null,
    spreadGuard:   spreadGuard ? `⚠️ Spread hoog (>33% SL) — trade doorgezet, uitgesloten van analyse` : null,
    positionId:    posId,
    metaApi:       result,
  });
}

// ── MANUAL CLOSE ──────────────────────────────────────────────
app.post("/close", requireAuth, async (req, res) => {
  const { positionId, symbol, direction } = req.body;
  if (!positionId) return res.status(400).json({ error: "Vereist: positionId" });
  try {
    const result = await closePosition(positionId);
    if (symbol && direction) decrementTracker(symbol, direction);
    res.json({ status: "OK", result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  resetDailyLossIfNewDay();
  const dailyLimit = ACCOUNT_BALANCE * (FTMO_DAILY_LOSS_PCT / 100);
  res.json({
    status:  "online",
    versie:  "ftmo-v4.4",
    ftmo: {
      dagelijksVerlies: `€${ftmoDailyLossUsed.toFixed(2)} / €${dailyLimit.toFixed(2)} (${FTMO_DAILY_LOSS_PCT}%)`,
    },
    spread: `Hoge spread (>33% SL) blokkeert niet — markeert trade voor uitsluiting uit analyse`,
    slAdviesMinTrades: SL_LOCK_THRESHOLD,
    tracking: {
      openPositions: Object.keys(openPositions).length,
      closedTrades:  closedTrades.length,
      tpLocks:       Object.keys(tpLocks).length,
      slAnalyses:    Object.keys(slLocks).length,
      learnedPatches: Object.keys(learnedPatches).length,
      ghostsPending:  Object.keys(ghostTrackers).length,
    },
    endpoints: {
      "POST /webhook":                      "TradingView → FTMO MT5",
      "POST /close":                        "Manueel sluiten (x-secret)",
      "GET  /live/positions":               "Live posities",
      "GET  /live/ghosts":                  "Actieve ghost trackers",
      "GET  /analysis/rr":                  "MaxRR + trueMaxRR",
      "GET  /analysis/sessions":            "EV per sessie",
      "GET  /analysis/equity-curve":        "Equity history",
      "GET  /research/tp-optimizer":        "TP optimizer (globaal)",
      "GET  /research/tp-optimizer/sessie": "TP optimizer per sessie",
      "GET  /research/sl-optimizer":        "SL optimizer (min 50 trades)",
      "GET  /tp-locks":                     "TP lock status",
      "GET  /sl-locks":                     "SL analyse status",
      "GET  /history":                      "Webhook log",
      "GET  /dashboard":                    "Dashboard summary",
    },
  });
});

app.get("/status", requireAuth, (req, res) => {
  resetDailyLossIfNewDay();
  res.json({ openTrades: openTradeTracker, learnedPatches, risicoPerType: RISK });
});

// ── LIVE POSITIES ─────────────────────────────────────────────
app.get("/live/positions", requireAuth, (req, res) => {
  res.json({
    count: Object.keys(openPositions).length,
    positions: Object.values(openPositions).map(p => ({
      id: p.id, symbol: p.symbol, direction: p.direction,
      entry: p.entry, sl: p.sl, tp: p.tp, lots: p.lots,
      riskEUR: p.riskEUR, openedAt: p.openedAt,
      session: p.session, sessionLabel: p.sessionLabel,
      currentPrice: p.currentPrice ?? null, currentPnL: p.currentPnL ?? 0,
      maxRR: p.maxRR ?? 0, slMultiplier: p.slMultiplierApplied ?? 1.0,
      spreadGuard: p.spreadGuard ?? false,
      forexHalfRisk: p.forexHalfRisk ?? false,
      restoredAfterRestart: p.restoredAfterRestart ?? false,
    })),
  });
});

// ── LIVE GHOSTS ───────────────────────────────────────────────
app.get("/live/ghosts", requireAuth, (req, res) => {
  const active = Object.entries(ghostTrackers).map(([id, g]) => ({
    ghostId:          id,
    symbol:           g.trade.symbol,
    direction:        g.trade.direction,
    entry:            g.trade.entry,
    sl:               g.trade.sl,
    maxRRAtClose:     g.trade.maxRR,
    currentBestPrice: g.bestPrice,
    currentBestRR:    calcMaxRRFromPrice(g.trade, g.bestPrice),
    startedAt:        new Date(g.startedAt).toISOString(),
    elapsedMin:       Math.round((Date.now() - g.startedAt) / 60000),
    remainingMin:     Math.round((GHOST_DURATION_MS - (Date.now() - g.startedAt)) / 60000),
  }));
  res.json({ count: active.length, ghosts: active });
});

// ── ANALYSE RR ────────────────────────────────────────────────
app.get("/analysis/rr", requireAuth, (req, res) => {
  const { symbol } = req.query;
  const trades = symbol
    ? closedTrades.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase())
    : closedTrades;
  const bySymbol = {};
  for (const t of trades) {
    const s = t.symbol || "UNKNOWN";
    if (!bySymbol[s]) bySymbol[s] = { count: 0, totalMaxRR: 0, totalTrueMaxRR: 0, trueCount: 0, spreadExcluded: 0, trades: [] };
    bySymbol[s].trades.push({
      openedAt: t.openedAt, closedAt: t.closedAt, direction: t.direction,
      entry: t.entry, sl: t.sl, session: t.session,
      maxRR: t.maxRR ?? 0, trueMaxRR: t.trueMaxRR ?? null,
      spreadGuard: t.spreadGuard ?? false,
      ghostStatus: t.trueMaxRR !== null ? "✅ compleet" : "⏳ ghost actief",
    });
    bySymbol[s].totalMaxRR += t.maxRR || 0;
    if (t.spreadGuard) bySymbol[s].spreadExcluded++;
    if (t.trueMaxRR !== null) { bySymbol[s].totalTrueMaxRR += t.trueMaxRR; bySymbol[s].trueCount++; }
    bySymbol[s].count++;
  }
  res.json({
    totalTrades: trades.length,
    note: "spreadGuard=true trades uitgesloten van TP/SL optimalisatie",
    bySymbol: Object.fromEntries(
      Object.entries(bySymbol).map(([s, g]) => [s, {
        trades:         g.count,
        spreadExcluded: g.spreadExcluded,
        analysisTrades: g.count - g.spreadExcluded,
        avgMaxRR:       parseFloat((g.totalMaxRR / g.count).toFixed(2)),
        avgTrueMaxRR:   g.trueCount ? parseFloat((g.totalTrueMaxRR / g.trueCount).toFixed(2)) : null,
        ghostCoverage:  `${g.trueCount}/${g.count}`,
        details:        g.trades,
      }])
    ),
  });
});

// ── SESSIE ANALYSE ────────────────────────────────────────────
app.get("/analysis/sessions", requireAuth, (req, res) => {
  const { symbol, session } = req.query;
  let trades = filterForAnalysis(closedTrades); // v4.4: spreadGuard uitgesloten
  if (symbol)  trades = trades.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase());
  if (session) trades = trades.filter(t => t.session === session);

  const bySymbol = {};
  for (const t of trades) {
    const sym = t.symbol || "UNKNOWN", sess = t.session || "unknown";
    if (!bySymbol[sym]) bySymbol[sym] = { total: 0, sessions: {} };
    if (!bySymbol[sym].sessions[sess]) bySymbol[sym].sessions[sess] = { trades: [], totalRR: 0 };
    bySymbol[sym].sessions[sess].trades.push(t);
    bySymbol[sym].sessions[sess].totalRR += getBestRR(t);
    bySymbol[sym].total++;
  }

  const result = {};
  for (const [sym, d] of Object.entries(bySymbol)) {
    result[sym] = { totalTrades: d.total, bestSession: null, sessions: {} };
    let bestEV = -Infinity, bestSess = null;
    for (const sess of TRADING_SESSIONS) {
      const g = d.sessions[sess]; if (!g || !g.trades.length) continue;
      const n = g.trades.length, avgRR = parseFloat((g.totalRR / n).toFixed(2));
      const evTable = RR_LEVELS.map(rr => {
        const wins = g.trades.filter(t => getBestRR(t) >= rr).length, wr = wins / n;
        return { rr, wins, total: n, winrate: `${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
      });
      const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a);
      result[sym].sessions[sess] = {
        label: SESSION_LABELS[sess], trades: n, avgBestRR: avgRR,
        bestTP: `${best.rr}R`, bestEV: best.ev, evTable,
        tpLock: tpLocks[`${sym}__${sess}`] ? { lockedRR: tpLocks[`${sym}__${sess}`].lockedRR } : null,
      };
      if (best.ev > bestEV) { bestEV = best.ev; bestSess = sess; }
    }
    result[sym].bestSession = bestSess ? { session: bestSess, label: SESSION_LABELS[bestSess], ev: bestEV } : null;
  }
  res.json({ totalTrades: trades.length, filters: { symbol: symbol || "alle", session: session || "alle" }, bySymbol: result });
});

// ── TP OPTIMIZER ──────────────────────────────────────────────
function buildTPOptimizerResults(minTrades = 3) {
  const bySymbol = {};
  for (const t of closedTrades) {
    if (!t.sl || !t.entry || t.spreadGuard) continue; // v4.4: spreadGuard uitgesloten
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }
  const results = [];
  for (const [symbol, trades] of Object.entries(bySymbol)) {
    if (trades.length < minTrades) { results.push({ symbol, trades: trades.length, note: `Te weinig data (min ${minTrades})`, bestTP: null, bestEV: null }); continue; }
    const ghostPending = trades.filter(t => t.trueMaxRR === null).length;
    const evTable = RR_LEVELS.map(rr => {
      const wins = trades.filter(t => getBestRR(t) >= rr).length, wr = wins / trades.length;
      return { rr, wins, total: trades.length, winrate: `${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
    });
    const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a);
    const subRRBest = evTable.filter(e => e.rr < 1).reduce((a,b) => b.ev > a.ev ? b : a, { rr: null, ev: -Infinity });
    results.push({
      symbol, trades: trades.length, ghostPending,
      bestTP: `${best.rr}R`, bestEV: best.ev, bestWinrate: best.winrate,
      subRRBest: subRRBest.rr !== null && subRRBest.ev > 0 ? { rr: `${subRRBest.rr}R`, ev: subRRBest.ev } : null,
      recommendation: best.ev > 0 ? `Target: ${best.rr}R (EV: +${best.ev}R/trade)` : "EV negatief",
      evTable,
    });
  }
  results.sort((a,b) => (b.bestEV ?? -99) - (a.bestEV ?? -99));
  return { results, rrLevels: RR_LEVELS };
}

app.get("/research/tp-optimizer", requireAuth, (req, res) => {
  if (!closedTrades.length) return res.json({ info: "Geen gesloten trades.", trades: 0 });
  const { results, rrLevels } = buildTPOptimizerResults(3);
  res.json({ generated: new Date().toISOString(), totalTrades: closedTrades.length, note: "Hoge-spread trades uitgesloten", rrLevels, bySymbol: results });
});

app.get("/research/tp-optimizer/sessie", requireAuth, (req, res) => {
  const { symbol } = req.query;
  let trades = filterForAnalysis(closedTrades); // v4.4
  if (symbol) trades = trades.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase());
  if (!trades.length) return res.json({ info: "Geen bruikbare trades.", trades: 0 });

  const bySymbol = {};
  for (const t of trades) {
    const sym = t.symbol || "UNKNOWN", sess = t.session || "unknown";
    if (!bySymbol[sym]) bySymbol[sym] = {};
    if (!bySymbol[sym][sess]) bySymbol[sym][sess] = [];
    bySymbol[sym][sess].push(t);
  }

  const result = {};
  for (const [sym, sessions] of Object.entries(bySymbol)) {
    result[sym] = { totalTrades: 0, sessions: {} };
    for (const sess of TRADING_SESSIONS) {
      const st = sessions[sess] || []; result[sym].totalTrades += st.length;
      if (st.length < 3) { result[sym].sessions[sess] = { label: SESSION_LABELS[sess], trades: st.length, note: "Te weinig data" }; continue; }
      const ghostPending = st.filter(t => t.trueMaxRR === null).length;
      const evTable = RR_LEVELS.map(rr => { const wins = st.filter(t => getBestRR(t) >= rr).length, wr = wins / st.length; return { rr, wins, total: st.length, winrate: `${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) }; });
      const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a);
      const subRRBest = evTable.filter(e => e.rr < 1).reduce((a,b) => b.ev > a.ev ? b : a, { rr: null, ev: -Infinity });
      const tpLockForSess = tpLocks[`${sym}__${sess}`];
      result[sym].sessions[sess] = {
        label: SESSION_LABELS[sess], trades: st.length, ghostPending,
        bestTP: `${best.rr}R`, bestEV: best.ev, bestWinrate: best.winrate,
        subRRBest: subRRBest.rr !== null && subRRBest.ev > 0 ? { rr: `${subRRBest.rr}R`, ev: subRRBest.ev } : null,
        tpLock: tpLockForSess ? { lockedRR: tpLockForSess.lockedRR, evAtLock: tpLockForSess.evAtLock } : null,
        recommendation: best.ev > 0 ? `Target: ${best.rr}R (EV +${best.ev}R/trade)` : "EV negatief", evTable,
      };
    }
  }
  res.json({ generated: new Date().toISOString(), totalTrades: trades.length, note: "Hoge-spread trades uitgesloten", filters: { symbol: symbol || "alle" }, bySymbol: Object.fromEntries(Object.entries(result).sort((a,b) => b[1].totalTrades - a[1].totalTrades)) });
});

// ── SL OPTIMIZER ─────────────────────────────────────────────
app.get("/research/sl-optimizer", requireAuth, (req, res) => {
  const { symbol } = req.query;
  let trades = filterForAnalysis(closedTrades.filter(t => t.sl && t.entry)); // v4.4
  if (symbol) trades = trades.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase());
  if (!trades.length) return res.json({ info: "Geen bruikbare trades.", trades: 0 });

  const bySymbol = {};
  for (const t of trades) { if (!bySymbol[t.symbol]) bySymbol[t.symbol] = []; bySymbol[t.symbol].push(t); }

  const results = [];
  for (const [sym, st] of Object.entries(bySymbol)) {
    if (st.length < SL_LOCK_THRESHOLD) {
      results.push({ symbol: sym, trades: st.length, note: `Te weinig data (min ${SL_LOCK_THRESHOLD})` });
      continue;
    }
    const analysis = buildSLAnalysis(st);
    const best     = analysis.reduce((a,b) => b.bestEV > a.bestEV ? b : a);
    const direction = getSLDirection(analysis);
    results.push({
      symbol: sym, trades: st.length, direction,
      advies: best.slMultiple === 1.0
        ? "✅ Huidig optimaal"
        : best.slMultiple < 1.0
          ? `🔽 Kleinere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`
          : `🔼 Grotere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`,
      slAnalysis: analysis,
    });
  }
  res.json({ generated: new Date().toISOString(), totalTrades: trades.length, minTrades: SL_LOCK_THRESHOLD, warning: "⚠️ READONLY — direction advies", bySymbol: results });
});

// ── EQUITY CURVE ──────────────────────────────────────────────
app.get("/analysis/equity-curve", requireAuth, async (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  try {
    const db = await loadSnapshots(hours);
    if (db.length) return res.json({ hours, count: db.length, source: "postgres", snapshots: db });
  } catch (e) {}
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const snaps  = accountSnapshots.filter(s => s.ts >= cutoff);
  res.json({ hours, count: snaps.length, source: "memory", snapshots: snaps });
});

app.get("/history", requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_HISTORY);
  res.json({ count: webhookHistory.length, history: webhookHistory.slice(0, limit) });
});

// ── TP / SL LOCK API ──────────────────────────────────────────
app.get("/tp-locks", requireAuth, (req, res) => {
  const bySym = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (!bySym[sym]) bySym[sym] = {};
    bySym[sym][sess] = lock;
  }
  res.json({ generated: new Date().toISOString(), totalLocks: Object.keys(tpLocks).length, locksBySymbol: bySym });
});

app.get("/sl-locks", requireAuth, (req, res) => {
  res.json({
    generated: new Date().toISOString(),
    note: "READONLY — SL direction engine | min 50 trades",
    totalAnalyses: Object.keys(slLocks).length,
    analyses: Object.entries(slLocks).map(([sym, lock]) => ({ symbol: sym, ...lock })),
  });
});

app.delete("/tp-locks/:symbol", requireAuth, (req, res) => {
  const sym = req.params.symbol.toUpperCase(); let count = 0;
  for (const key of Object.keys(tpLocks)) { if (key.startsWith(sym + "__")) { delete tpLocks[key]; count++; } }
  res.json({ status: "OK", removed: count, symbol: sym });
});

app.delete("/tp-locks/:symbol/:session", requireAuth, (req, res) => {
  const key = `${req.params.symbol.toUpperCase()}__${req.params.session}`;
  const existed = !!tpLocks[key]; delete tpLocks[key];
  res.json({ status: "OK", removed: existed ? 1 : 0, key });
});

app.delete("/sl-locks/:symbol", requireAuth, (req, res) => {
  const sym = req.params.symbol.toUpperCase(); const existed = !!slLocks[sym]; delete slLocks[sym];
  res.json({ status: "OK", removed: existed ? 1 : 0, symbol: sym });
});

// ── DASHBOARD ─────────────────────────────────────────────────
app.get("/dashboard", requireAuth, (req, res) => {
  const spreadMarked = closedTrades.filter(t => t.spreadGuard).length;
  const dailyLimit   = ACCOUNT_BALANCE * (FTMO_DAILY_LOSS_PCT / 100);
  res.json({
    versie:          "v4.4",
    openPositions:   Object.keys(openPositions).length,
    closedTrades:    closedTrades.length,
    spreadMarked,
    analysisTrades:  closedTrades.length - spreadMarked,
    tpLocks:         Object.keys(tpLocks).length,
    slAnalyses:      Object.keys(slLocks).length,
    ghostPending:    closedTrades.filter(t => t.trueMaxRR === null).length,
    ftmoDagelijks:   `€${ftmoDailyLossUsed.toFixed(2)} / €${dailyLimit.toFixed(2)}`,
    learnedPatches:  Object.keys(learnedPatches).length,
    fixes: {
      spreadGuard:   "✅ Markeert alle types — blokkeert niet, sluit uit van analyse",
      slDrempel:     `✅ SL advies na ${SL_LOCK_THRESHOLD} trades`,
      ftmoSafety:    `✅ Dagelijkse verlimiet ${FTMO_DAILY_LOSS_PCT}% actief`,
      restartFix:    "✅ Restart recovery + riskEUR schatting",
      learnedPatch:  "✅ Geleerde MT5 overrides opgeslagen in DB",
      raceFix:       "✅ Webhook mutex per symbool+richting",
    },
    positions: Object.values(openPositions).map(p => ({
      symbol: p.symbol, direction: p.direction, lots: p.lots,
      riskEUR: p.riskEUR, session: p.session,
      forexHalfRisk: p.forexHalfRisk ?? false,
      spreadGuard:   p.spreadGuard   ?? false,
      restored:      p.restoredAfterRestart ?? false,
    })),
  });
});

// ── GHOST PENDING ANALYSE ─────────────────────────────────────
app.get("/analysis/ghost-pending", requireAuth, (req, res) => {
  const pending = closedTrades.filter(t => t.trueMaxRR === null);
  res.json({ count: pending.length, trades: pending });
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
  for (const t of valid) {
    if (!t.session && t.openedAt) t.session = getSessionGMT1(t.openedAt);
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

  // v4.4: Laad learnedPatches uit DB (waren voorheen verloren bij restart)
  try {
    const patches = await loadLearnedPatches();
    Object.assign(learnedPatches, patches);
    console.log(`🧠 ${Object.keys(learnedPatches).length} learned patches geladen`);
  } catch (e) { console.warn("⚠️ Learned patches laden:", e.message); }

  // Run engines voor alle symbolen
  const symSet = [...new Set(valid.map(t => t.symbol).filter(Boolean))];
  for (const sym of symSet) {
    await runTPLockEngine(sym).catch(() => {});
    await runSLLockEngine(sym).catch(() => {});
  }
  console.log(`🔒 TP locks: ${Object.keys(tpLocks).length} | 📐 SL analyses: ${Object.keys(slLocks).length}`);

  // Herstel open posities vanuit MT5 na restart
  await restoreOpenPositionsFromMT5();

  const server = app.listen(PORT, () =>
    console.log([
      `🚀 FTMO Webhook v4.4 — poort ${PORT}`,
      `✅ [SPREAD] Hoge spread markeert trades, blokkeert niet — alle types`,
      `✅ [SL] Advies na ${SL_LOCK_THRESHOLD} trades (was 10)`,
      `✅ [FTMO] Dagelijkse verlimiet ${FTMO_DAILY_LOSS_PCT}% van €${ACCOUNT_BALANCE} = €${(ACCOUNT_BALANCE*FTMO_DAILY_LOSS_PCT/100).toFixed(0)}`,
      `✅ [RACE] Webhook mutex per symbool+richting actief`,
      `✅ [TIMEOUT] MetaAPI timeout ${FETCH_TIMEOUT_MS}ms`,
      `📈 Risico | Index:€${RISK.index} Forex:€${RISK.forex} Gold:€${RISK.gold} Crypto:€${RISK.crypto} Stock:€${RISK.stock}`,
    ].join("\n"))
  );

  async function shutdown(sig) {
    console.log(`\n🛑 ${sig} — graceful shutdown...`);
    for (const [id, g] of Object.entries(ghostTrackers)) {
      clearTimeout(g.timer);
      delete ghostTrackers[id];
    }
    server.close(async () => {
      await endPool(); // v4.4: DB pool netjes sluiten
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

startServer().catch(err => { console.error("❌", err.message); process.exit(1); });
