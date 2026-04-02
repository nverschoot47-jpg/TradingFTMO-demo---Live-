// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v4.2
// Account : Nick Verschoot — FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ───────────────────────────────────────────────────────────────
// SESSIES (Brussels — automatisch zomer/wintertijd):
//   asia      → 02:00–08:00
//   london    → 08:00–15:30
//   ny        → 15:30–20:00
//
// WIJZIGINGEN v4.2 (t.o.v. v4.1):
//  ✅ Indices nu ook tijdens Asia sessie (02:00–08:00)
//  ✅ Min lot cap ×4 bij bewezen TP lock (€60 → €240)
//  ✅ MIN_STOP: AUS200/US2000/SPN35/NL25 → 5 punten minimum
//  ✅ Schone stocklijst (44 symbolen) — aliassen verwijderd
//  ✅ GOOGL → GOOG (MT5), NIKE → NKE (MT5)
//  ✅ Nieuwe stocks toegevoegd: GM, JNJ, LMT, MSTR, QCOM, RACE,
//       SBUX, SNOW, T, ZM, ASML, AVGO
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

const GHOST_DURATION_MS = 24 * 3600 * 1000;
const GHOST_INTERVAL_MS = 60 * 1000;

// ── RR / SL LEVELS (sub-1R toegevoegd) ───────────────────────
const RR_LEVELS    = [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25];
const SL_MULTIPLES = [0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

// SL multiplier die wordt toegepast wanneer TP lock bewezen is (EV > 0, niet stock)
const SL_PROVEN_MULT = 0.5;

// Stock SL spread buffer multiplier (×1.5 boven 5min candle low/high)
const STOCK_SL_SPREAD_MULT = 1.5;

// Max spread als fractie van entry-SL afstand (50% voor aandelen)
const STOCK_MAX_SPREAD_FRACTION = 0.5;

// Forex anti-consolidatie: max open trades zelfde richting+pair
const FOREX_MAX_SAME_DIR = 3;

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
const TP_LOCK_RISK_MULT = 4;  // Risk ×4 als TP lock actief + EV positief (ook stocks!)

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
const SL_LOCK_THRESHOLD  = 10;
const SL_UPDATE_INTERVAL = 10;

// tpLocks: keyed op "SYMBOL__sessie" (bijv. "XAUUSD__london")
const tpLocks     = {};
// slLocks: keyed op "SYMBOL" — analyse/dashboard + direction advies
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

  // ── Aandelen (v4.2 — schone lijst, 44 symbolen) ───────────
  // TV ticker = MT5 ticker, behalve GOOGL→GOOG en NIKE→NKE
  "AAPL":  { mt5: "AAPL",  type: "stock" },
  "TSLA":  { mt5: "TSLA",  type: "stock" },
  "MSFT":  { mt5: "MSFT",  type: "stock" },
  "NVDA":  { mt5: "NVDA",  type: "stock" },
  "AMD":   { mt5: "AMD",   type: "stock" },
  "NFLX":  { mt5: "NFLX",  type: "stock" },
  "AMZN":  { mt5: "AMZN",  type: "stock" },
  "GOOGL": { mt5: "GOOG",  type: "stock" },  // TV: GOOGL → MT5: GOOG
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
  "NIKE":  { mt5: "NKE",   type: "stock" },  // TV: NIKE → MT5: NKE
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

// ── MIN_STOP — elk symbool apart (v4.2) ───────────────────────
// Indices (punten)
const MIN_STOP_INDEX = {
  "GER40.cash":  10,   // GER40:    10 punten minimum
  "UK100.cash":   5,   // UK100:     5 punten minimum
  "US100.cash":  10,   // NAS100:   10 punten minimum
  "US30.cash":   10,   // US30:     10 punten minimum
  "US500.cash":   5,   // S&P500:    5 punten minimum
  "JP225.cash":  10,   // Nikkei:   10 punten minimum
  "AUS200.cash":  5,   // ASX200:    5 punten minimum  (was 3)
  "EU50.cash":    5,   // EuroStoxx: 5 punten minimum
  "FRA40.cash":   5,   // CAC40:     5 punten minimum
  "HK50.cash":   10,   // HangSeng: 10 punten minimum
  "US2000.cash":  5,   // Russell:   5 punten minimum  (was 1)
  "SPN35.cash":   5,   // IBEX:      5 punten minimum  (was 2)
  "NL25.cash":    5,   // AEX:       5 punten minimum  (was 1)
};

// Grondstoffen (prijs)
const MIN_STOP_COMMODITY = {
  "XAUUSD":      1.0,  // Gold:  1 punt minimum
  "UKOIL.cash":  0.05, // Brent: 5 cent minimum
  "USOIL.cash":  0.05, // WTI:   5 cent minimum
  "BTCUSD":    100.0,  // BTC:   $100 minimum
  "ETHUSD":      5.0,  // ETH:   $5 minimum
};

// Forex — elk pair apart (pip waarde, 4-digit pairs tenzij JPY)
const MIN_STOP_FOREX = {
  "EURUSD": 0.0005,
  "GBPUSD": 0.0005,
  "AUDUSD": 0.0005,
  "NZDUSD": 0.0005,
  "USDCHF": 0.0005,
  "USDCAD": 0.0005,
  "EURGBP": 0.0005,
  "EURAUD": 0.0005,
  "EURCAD": 0.0005,
  "EURCHF": 0.0005,
  "GBPAUD": 0.0005,
  "GBPCAD": 0.0005,
  "GBPCHF": 0.0005,
  "AUDCAD": 0.0005,
  "AUDCHF": 0.0005,
  "AUDNZD": 0.0005,
  "CADCHF": 0.0005,
  "NZDCAD": 0.0005,
  "NZDCHF": 0.0005,
  // JPY pairs (2-digit) — minimum 0.05
  "USDJPY": 0.05,
  "EURJPY": 0.05,
  "GBPJPY": 0.05,
  "AUDJPY": 0.05,
  "CADJPY": 0.05,
  "NZDJPY": 0.05,
  "CHFJPY": 0.05,
};

// Stocks — dynamisch: 0.1% van entry price (berekend bij gebruik)
const MIN_STOP_STOCK_PCT = 0.001; // 0.1% van entry price

/**
 * Berekent minimale SL afstand voor een symbool.
 * Stocks: dynamisch 0.1% van entry.
 * Alle anderen: vaste tabel.
 * @param {string} mt5Symbol
 * @param {string} type
 * @param {number} entryPrice
 * @returns {number}
 */
function getMinStop(mt5Symbol, type, entryPrice = 0) {
  if (type === "stock") {
    return Math.max(0.01, entryPrice * MIN_STOP_STOCK_PCT);
  }
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

// ── FOREX ANTI-CONSOLIDATIE ───────────────────────────────────
/**
 * Controleer of een forex trade geblokkeerd moet worden wegens consolidatie.
 * Blokkeer als er al FOREX_MAX_SAME_DIR of meer open trades zijn
 * met dezelfde richting voor hetzelfde pair.
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
  return { blocked: count >= FOREX_MAX_SAME_DIR, count };
}

// ── SPREAD GUARD — aandelen ───────────────────────────────────
/**
 * Spread mag max 50% van de entry-SL afstand zijn.
 */
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

/**
 * Berekent het effectieve risico voor een order.
 * Risk ×4 als er een bewezen TP lock bestaat voor het HUIDIGE sessie-moment.
 * Nu ook voor stocks.
 */
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

/**
 * Valideert en past SL aan tot minimumafstand.
 * Stocks: ×1.5 spread buffer toegepast op afstand.
 */
function validateSL(dir, entry, sl, mt5Sym, type) {
  const minD = getMinStop(mt5Sym, type, entry);
  let dist   = Math.abs(entry - sl);

  if (type === "stock") {
    const requiredDist = Math.max(dist, minD) * STOCK_SL_SPREAD_MULT;
    const newSl = dir === "buy" ? entry - requiredDist : entry + requiredDist;
    console.log(`📐 [SL Stock] ${mt5Sym}: SL afstand ${dist.toFixed(4)} → ${requiredDist.toFixed(4)} (×${STOCK_SL_SPREAD_MULT} spread buffer)`);
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
 * Berekent lotsize.
 * v4.2: min lot cap wordt ×4 bij bewezen TP lock (€60 → €240).
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

  // ── v4.2: cap ×4 bij bewezen TP lock ────────────────────────
  const baseRisk      = RISK[type] || 30;
  const isTPLockRisk  = risk >= baseRisk * TP_LOCK_RISK_MULT;
  const effectiveCap  = isTPLockRisk
    ? RISK_MINLOT_CAP * TP_LOCK_RISK_MULT   // €60 × 4 = €240
    : RISK_MINLOT_CAP;                       // €60 normaal

  if (minCost > effectiveCap) {
    console.warn(`⚠️ Min lot kost €${minCost.toFixed(2)} > cap €${effectiveCap} (${isTPLockRisk ? "TP lock ×4" : "normaal"}) → skip`);
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

// ── SL ANALYSE HELPER (v4.1 — met direction) ─────────────────
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

/**
 * Bepaal de aanbevolen SL direction op basis van analyse.
 * @returns {"up"|"down"|"unchanged"}
 */
function getSLDirection(analysis) {
  const current = analysis.find(a => a.slMultiple === 1.0);
  const best    = analysis.reduce((a,b) => b.bestEV > a.bestEV ? b : a);
  if (!current || best.slMultiple === 1.0) return "unchanged";
  if (best.bestEV <= (current.bestEV ?? -Infinity)) return "unchanged";
  return best.slMultiple > 1.0 ? "up" : "down";
}

// ══════════════════════════════════════════════════════════════
// GHOST TRACKER — post-close prijsvolging (24u)
// ══════════════════════════════════════════════════════════════
function startGhostTracker(closedTrade) {
  const ghostId   = `ghost_${closedTrade.id}_${Date.now()}`;
  const startedAt = Date.now();
  let bestPrice   = closedTrade.maxPrice ?? closedTrade.entry;

  console.log(`👻 Ghost gestart: ${closedTrade.symbol} | startMaxRR: ${closedTrade.maxRR}R`);

  const timer = setInterval(async () => {
    try {
      const { hhmm } = getBrusselsComponents();
      const elapsed  = Date.now() - startedAt;
      const shouldStop = elapsed >= GHOST_DURATION_MS || hhmm >= 2000 || hhmm < 200;

      const priceData = await fetchCurrentPrice(closedTrade.mt5Symbol);
      const price     = priceData?.mid ?? null;

      if (price !== null) {
        const better = closedTrade.direction === "buy" ? price > bestPrice : price < bestPrice;
        if (better) bestPrice = price;

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
      }
    } catch (e) { console.warn(`⚠️ Ghost ${ghostId}:`, e.message); }
  }, GHOST_INTERVAL_MS);

  ghostTrackers[ghostId] = { trade: closedTrade, timer, startedAt, bestPrice };

  setTimeout(() => {
    if (ghostTrackers[ghostId])
      finaliseGhost(ghostId, closedTrade, ghostTrackers[ghostId].bestPrice, "failsafe");
  }, GHOST_DURATION_MS + 5 * 60 * 1000);
}

function finaliseGhost(ghostId, trade, bestPrice, reason) {
  if (!ghostTrackers[ghostId]) return;
  clearInterval(ghostTrackers[ghostId].timer);
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
// TP LOCK ENGINE (v4.1 — SESSIE-AWARE + sub-1R)
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
// SL LOCK ENGINE (v4.1 — ghost-driven direction + READONLY)
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
    ? `eerste analyse na ${n} trades (huidig EV: ${current?.bestEV ?? "–"}R) [${direction}]`
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

    // ── Forex anti-consolidatie check ────────────────────────
    if (symType === "forex") {
      const consol = checkForexConsolidation(symbol, direction);
      if (consol.blocked) {
        const reason = `Anti-consolidatie: ${consol.count} open ${direction} trades voor ${symbol} (max ${FOREX_MAX_SAME_DIR})`;
        console.warn(`🚫 [Forex Consolidatie] ${reason}`);
        logForexConsolidation(symbol, direction, consol.count, reason).catch(() => {});
        addWebhookHistory({ type:"FOREX_CONSOLIDATION_BLOCKED", symbol, direction, count: consol.count });
        return res.status(200).json({ status:"SKIP", reason });
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
          const reason = `Spread ${sg.spreadPct}% van SL-afstand (max ${STOCK_MAX_SPREAD_FRACTION*100}%) — spread ${priceData.spread.toFixed(4)} > max ${sg.maxAllowed.toFixed(4)}`;
          console.warn(`🚫 [Spread Guard] ${symbol}: ${reason}`);
          addWebhookHistory({ type:"SPREAD_GUARD_BLOCKED", symbol, spreadPct: sg.spreadPct });
          return res.status(200).json({ status:"SKIP", reason:`Spread te groot: ${reason}` });
        }
        console.log(`✅ [Spread Guard] ${symbol}: spread ${sg.spreadPct}% OK (< ${STOCK_MAX_SPREAD_FRACTION*100}%)`);
      }
    }

    const risk = getEffectiveRisk(symbol, direction);
    const ftmo = ftmoSafetyCheck(risk);
    if (!ftmo.ok) {
      addWebhookHistory({ type:"FTMO_BLOCKED", symbol });
      return res.status(200).json({ status:"FTMO_BLOCKED", reason:ftmo.reason });
    }

    const lots = calcLots(symbol, entryNum, slApplied, risk);
    if (lots===null) return res.status(200).json({ status:"SKIP", reason:`Min lot > cap` });

    const slDist = Math.abs(entryNum - slApplied).toFixed(5);
    console.log(`📊 ${direction.toUpperCase()} ${symbol}/${curSession} | Entry:${entryNum} SL:${slApplied} Lots:${lots} Risk:€${risk.toFixed(2)}`);

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
    };

    addWebhookHistory({
      type:"SUCCESS", symbol, mt5Symbol, direction, lots, posId,
      session: curSession,
      riskEUR: risk.toFixed(2),
      slAanpassing: slLockInfo ?? "geen",
      tp: tpUsed ? `${tpLockActive.lockedRR}R @ ${tpUsed}` : "geen",
      riskBoost: tpProven ? `×${TP_LOCK_RISK_MULT}` : "×1",
      stockSlBuffer: symType === "stock" ? `×${STOCK_SL_SPREAD_MULT}` : null,
    });

    res.json({
      status:         "OK",
      versie:         "v4.2",
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
      riskBoost:      tpProven ? `×${TP_LOCK_RISK_MULT} (TP lock ${symbol}/${curSession} actief, EV +${tpLockNow?.evAtLock}R)` : "×1",
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
    versie:  "ftmo-v4.2",
    timezone: "Europe/Brussels (auto CET/CEST)",
    tradingVenster:      "02:00–20:00",
    indicesVenster:      "02:00–20:00 (ook Asia sessie)",
    aandelenVenster:     "15:30–20:00",
    autoClose:           "20:50 (elke dag)",
    weekendTrading:      "Alleen BTC/ETH (02:00–20:00)",
    ghostTracker:        "✅ 24u post-close → trueMaxRR + triggert SL direction engine",
    tpLock:              `✅ sessie-aware — risk ×${TP_LOCK_RISK_MULT} ook op stocks bij EV>0`,
    tpSubRR:             "✅ Sub-1R niveaus (0.2/0.4/0.6/0.8) in TP optimizer",
    slLogic:             `✅ 0.5× bij bewezen TP lock — ook stocks`,
    slEngine:            "📐 ghost-driven direction analyse (up/down/unchanged) — READONLY",
    stockSlBuffer:       `✅ Stock SL ×${STOCK_SL_SPREAD_MULT} spread buffer`,
    spreadGuard:         `✅ Aandelen: spread max ${STOCK_MAX_SPREAD_FRACTION*100}% van SL-afstand`,
    forexConsolidatie:   `✅ Max ${FOREX_MAX_SAME_DIR} trades zelfde richting+pair → geblokkeerd`,
    minLotCap:           `€${RISK_MINLOT_CAP} normaal | €${RISK_MINLOT_CAP * TP_LOCK_RISK_MULT} bij bewezen TP lock (×${TP_LOCK_RISK_MULT})`,
    minStopIndex:        MIN_STOP_INDEX,
    minStopCommodity:    MIN_STOP_COMMODITY,
    minStopForex:        MIN_STOP_FOREX,
    minStopStock:        `dynamisch: ${MIN_STOP_STOCK_PCT*100}% van entry price`,
    aantalSymbolen:      Object.keys(SYMBOL_MAP).length,
    sessies:             SESSION_LABELS,
    rrLevels:            RR_LEVELS,
    tpLocksActief:       Object.keys(tpLocks).length,
    tpLocksPerSessie:    lockedBySession,
    endpoints: {
      "POST /webhook":                        "TradingView → FTMO MT5",
      "POST /close":                          "Manueel sluiten",
      "GET  /live/positions":                 "Live posities",
      "GET  /live/ghosts":                    "Actieve ghost trackers",
      "GET  /analysis/rr":                    "MaxRR + trueMaxRR",
      "GET  /analysis/sessions":              "EV per sessie",
      "GET  /analysis/equity-curve":          "Equity history",
      "GET  /research/tp-optimizer":          "TP optimizer (globaal, incl. sub-1R)",
      "GET  /research/tp-optimizer/sessie":   "TP optimizer per sessie",
      "GET  /research/sl-optimizer":          "SL optimizer (direction + READONLY)",
      "GET  /research/sl-optimizer/sessie":   "SL optimizer per sessie",
      "GET  /tp-locks":                       "TP lock status (sessie-aware)",
      "GET  /sl-locks":                       "SL analyse status (direction)",
      "DELETE /tp-locks/:symbol":             "Reset alle TP locks voor symbool",
      "DELETE /tp-locks/:symbol/:session":    "Reset TP lock voor symbool + sessie",
      "DELETE /sl-locks/:symbol":             "Reset SL analyse voor symbool",
      "GET  /history":                        "Webhook log",
      "GET  /dashboard":                      "Visueel dashboard",
    },
    tracking: {
      openPositions: Object.keys(openPositions).length,
      closedTrades:  closedTrades.length,
      tpLocks:       Object.keys(tpLocks).length,
      slAnalyses:    Object.keys(slLocks).length,
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
      entry:t.entry, sl:t.sl, session:t.session, sessionLabel:t.sessionLabel,
      maxRR:t.maxRR??0, trueMaxRR:t.trueMaxRR??null,
      ghostStatus: t.trueMaxRR!==null ? "✅ compleet" : "⏳ ghost actief",
    });
    bySymbol[s].totalMaxRR += t.maxRR||0;
    if (t.trueMaxRR!==null) { bySymbol[s].totalTrueMaxRR+=t.trueMaxRR; bySymbol[s].trueCount++; }
    bySymbol[s].count++;
  }
  res.json({
    totalTrades: trades.length,
    info: "maxRR = tijdens trade | trueMaxRR = ghost tracker",
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
    rrBron:"trueMaxRR indien beschikbaar, anders maxRR",
    filters:{symbol:symbol||"alle",session:session||"alle"},
    bySymbol:Object.fromEntries(Object.entries(result).sort((a,b)=>b[1].totalTrades-a[1].totalTrades)),
  });
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
    const subRRBest = evTable.filter(e=>e.rr<1).reduce((a,b)=>b.ev>a.ev?b:a, {rr:null,ev:-Infinity});
    results.push({
      symbol, trades:trades.length, ghostPending,
      rrBron:ghostPending>0?`⚠️ ${ghostPending}/${trades.length} nog zonder trueMaxRR`:"✅ compleet",
      bestTP:`${best.rr}R`, bestEV:best.ev, bestWinrate:best.winrate,
      subRRBest: subRRBest.rr !== null && subRRBest.ev > 0
        ? { rr:`${subRRBest.rr}R`, ev:subRRBest.ev, winrate:evTable.find(e=>e.rr===subRRBest.rr)?.winrate }
        : null,
      recommendation: best.ev>0
        ? `Target: ${best.rr}R (EV: +${best.ev}R/trade)${best.rr<1?` ⚡ sub-1R high-winrate setup`:""}`
        : "EV negatief",
      evTable,
    });
  }
  results.sort((a,b)=>(b.bestEV??-99)-(a.bestEV??-99));
  return{results,rrLevels:RR_LEVELS};
}

app.get("/research/tp-optimizer", (req,res) => {
  if (!closedTrades.length) return res.json({info:"Geen gesloten trades.",trades:0});
  const {results,rrLevels}=buildTPOptimizerResults(3);
  res.json({
    generated:new Date().toISOString(),
    totalTrades:closedTrades.length,
    ghostPending:closedTrades.filter(t=>t.trueMaxRR===null).length,
    rrLevels,
    info:"EV per RR niveau inclusief sub-1R (0.2/0.4/0.6/0.8). trueMaxRR indien beschikbaar.",
    subRRNote:"Sub-1R niveaus kunnen profitable zijn bij hoge winrate.",
    bySymbol:results,
  });
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
      if (st.length<3){result[sym].sessions[sess]={label:SESSION_LABELS[sess],trades:st.length,note:"Te weinig data (min 3)"};continue;}
      const ghostPending=st.filter(t=>t.trueMaxRR===null).length;
      const evTable=RR_LEVELS.map(rr=>{const wins=st.filter(t=>getBestRR(t)>=rr).length,wr=wins/st.length;return{rr,wins,total:st.length,winrate:`${(wr*100).toFixed(1)}%`,ev:parseFloat((wr*rr-(1-wr)).toFixed(3))};});
      const best=evTable.reduce((a,b)=>b.ev>a.ev?b:a);
      const subRRBest=evTable.filter(e=>e.rr<1).reduce((a,b)=>b.ev>a.ev?b:a,{rr:null,ev:-Infinity});
      const tpLockForSess = tpLocks[`${sym}__${sess}`];
      result[sym].sessions[sess]={
        label:SESSION_LABELS[sess],trades:st.length,ghostPending,
        bestTP:`${best.rr}R`,bestEV:best.ev,bestWinrate:best.winrate,
        subRRBest:subRRBest.rr!==null&&subRRBest.ev>0?{rr:`${subRRBest.rr}R`,ev:subRRBest.ev}:null,
        tpLock: tpLockForSess ? {lockedRR:tpLockForSess.lockedRR,evAtLock:tpLockForSess.evAtLock} : null,
        recommendation:best.ev>0?`Target: ${best.rr}R (EV +${best.ev}R/trade)${best.rr<1?" ⚡ sub-1R":""}`:"EV negatief",
        evTable,
      };
    }
  }
  res.json({generated:new Date().toISOString(),totalTrades:trades.length,sessieDefinities:SESSION_LABELS,
    rrLevels:RR_LEVELS,rrBron:"trueMaxRR indien beschikbaar",
    subRRNote:"Sub-1R niveaus inbegrepen (0.2/0.4/0.6/0.8)",
    filters:{symbol:symbol||"alle"},
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
    if (st.length<5){results.push({symbol:sym,trades:st.length,note:"Te weinig data (min 5)"});continue;}
    const analysis=buildSLAnalysis(st);
    const current=analysis.find(a=>a.slMultiple===1.0);
    const best=analysis.reduce((a,b)=>b.bestEV>a.bestEV?b:a);
    const direction=getSLDirection(analysis);
    const dirLabel=direction==="up"?"🔼 Vergroot SL voor betere EV":direction==="down"?"🔽 Verklein SL voor betere EV":"✅ Huidige SL optimaal";
    const anyTPLock = TRADING_SESSIONS.some(sess => {
      const lk = tpLocks[`${sym}__${sess}`];
      return lk && (lk.evAtLock ?? 0) > 0;
    });
    results.push({
      symbol:sym, trades:st.length,
      huidigEV:current?.bestEV, huidigBestTP:current?.bestTP,
      analyseOnly:slLocks[sym]??null,
      direction, directionLabel:dirLabel,
      tpLockBewezen:anyTPLock,
      slWouldApply:anyTPLock,
      slMultiplierInWebhook: anyTPLock ? SL_PROVEN_MULT : "niet van toepassing",
      advies:best.slMultiple===1.0?"✅ Huidige SL optimaal":best.slMultiple<1.0
        ?`🔽 Kleinere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`
        :`🔼 Grotere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`,
      slAnalysis:analysis,
    });
  }
  results.sort((a,b)=>(b.trades??0)-(a.trades??0));
  res.json({
    generated:new Date().toISOString(), totalTrades:trades.length,
    warning:"⚠️ READONLY — direction advies (up/down/unchanged)",
    regel:"SL 0.5× bij bewezen TP lock (EV>0) — ook voor stocks",
    rrBron:"trueMaxRR indien beschikbaar",
    slMultiples:SL_MULTIPLES, rrLevels:RR_LEVELS,
    filters:{symbol:symbol||"alle"}, bySymbol:results,
  });
});

app.get("/research/sl-optimizer/sessie", (req,res) => {
  const {symbol}=req.query;
  let trades=closedTrades.filter(t=>t.sl&&t.entry);
  if (symbol) trades=trades.filter(t=>t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (!trades.length) return res.json({info:"Geen bruikbare trades.",trades:0});
  const bySymbol={};
  for (const t of trades){const sym=t.symbol||"UNKNOWN",sess=t.session||"unknown";if(!bySymbol[sym])bySymbol[sym]={};if(!bySymbol[sym][sess])bySymbol[sym][sess]=[];bySymbol[sym][sess].push(t);}
  const result={};
  for (const [sym,sessions] of Object.entries(bySymbol)){
    result[sym]={totalTrades:0,sessions:{}};
    for (const sess of TRADING_SESSIONS){
      const st=sessions[sess]||[];result[sym].totalTrades+=st.length;
      if (st.length<5){result[sym].sessions[sess]={label:SESSION_LABELS[sess],trades:st.length,note:"Te weinig data (min 5)"};continue;}
      const analysis=buildSLAnalysis(st);
      const current=analysis.find(a=>a.slMultiple===1.0);
      const best=analysis.reduce((a,b)=>b.bestEV>a.bestEV?b:a);
      const direction=getSLDirection(analysis);
      const tpLockForSess = tpLocks[`${sym}__${sess}`];
      const tpLockProven  = tpLockForSess && (tpLockForSess.evAtLock ?? 0) > 0;
      result[sym].sessions[sess]={
        label:SESSION_LABELS[sess], trades:st.length,
        huidigEV:current?.bestEV, huidigBestTP:current?.bestTP,
        direction, directionLabel:direction==="up"?"🔼 Vergroot SL":direction==="down"?"🔽 Verklein SL":"✅ Optimaal",
        tpLockBewezen:tpLockProven, slWouldApply:tpLockProven,
        advies:best.slMultiple===1.0?"✅ Huidig optimaal":best.slMultiple<1.0
          ?`🔽 Kleinere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`
          :`🔼 Grotere SL (${best.slMultiple}×): EV ${best.bestEV}R bij ${best.bestTP}`,
        slAnalysis:analysis,
      };
    }
  }
  res.json({
    generated:new Date().toISOString(), totalTrades:trades.length,
    warning:"⚠️ READONLY sessie view — direction advies per sessie",
    rrBron:"trueMaxRR indien beschikbaar",
    sessieDefinities:SESSION_LABELS, slMultiples:SL_MULTIPLES, rrLevels:RR_LEVELS,
    filters:{symbol:symbol||"alle"},
    bySymbol:Object.fromEntries(Object.entries(result).sort((a,b)=>b[1].totalTrades-a[1].totalTrades)),
  });
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

// ── TP LOCK API ───────────────────────────────────────────────
app.get("/tp-locks", (req,res) => {
  const bySym = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (!bySym[sym]) bySym[sym] = {};
    bySym[sym][sess] = lock;
  }
  res.json({
    generated:new Date().toISOString(), versie:"v4.2-sessie-aware",
    threshold:TP_LOCK_THRESHOLD, updateInterval:TP_UPDATE_INTERVAL,
    riskMultiplier:`×${TP_LOCK_RISK_MULT} per sessie (ook stocks)`,
    minLotCap:`€${RISK_MINLOT_CAP} normaal | €${RISK_MINLOT_CAP*TP_LOCK_RISK_MULT} bij TP lock`,
    totalLocks:Object.keys(tpLocks).length,
    locksBySessie:{ asia:Object.keys(tpLocks).filter(k=>k.endsWith("__asia")).length, london:Object.keys(tpLocks).filter(k=>k.endsWith("__london")).length, ny:Object.keys(tpLocks).filter(k=>k.endsWith("__ny")).length },
    locksBySymbol:bySym,
  });
});

// ── SL LOCK API ───────────────────────────────────────────────
app.get("/sl-locks", (req,res) => {
  res.json({
    generated:new Date().toISOString(), versie:"v4.2-direction",
    note:"READONLY — SL direction engine op basis van ghost tracker + EV analyse",
    regel:"SL 0.5× bij bewezen TP lock — ook stocks. Direction = aanbeveling.",
    totalAnalyses:Object.keys(slLocks).length,
    analyses:Object.entries(slLocks).map(([sym,lock])=>({
      symbol:sym, multiplier:lock.multiplier, direction:lock.direction,
      directionLabel:lock.directionLabel, evAtLock:lock.evAtLock,
      bestTPRR:lock.bestTPRR, lockedTrades:lock.lockedTrades,
      lockedAt:lock.lockedAt, prevMultiplier:lock.prevMultiplier,
      currentEV:lock.currentEV, note:lock.note,
    })),
  });
});

app.delete("/tp-locks/:symbol", (req,res) => {
  const sym = req.params.symbol.toUpperCase();
  let count = 0;
  for (const key of Object.keys(tpLocks)) {
    if (key.startsWith(sym + "__")) { delete tpLocks[key]; count++; }
  }
  res.json({ status:"OK", removed:count, symbol:sym });
});

app.delete("/tp-locks/:symbol/:session", (req,res) => {
  const key = `${req.params.symbol.toUpperCase()}__${req.params.session}`;
  const existed = !!tpLocks[key];
  delete tpLocks[key];
  res.json({ status:"OK", removed:existed?1:0, key });
});

app.delete("/sl-locks/:symbol", (req,res) => {
  const sym = req.params.symbol.toUpperCase();
  const existed = !!slLocks[sym];
  delete slLocks[sym];
  res.json({ status:"OK", removed:existed?1:0, symbol:sym });
});

// ══════════════════════════════════════════════════════════════
// DASHBOARD (v4.2)
// ══════════════════════════════════════════════════════════════
app.get("/dashboard", (req,res) => {
  const bySymbol={};
  for (const t of closedTrades) {
    const sym=t.symbol||"UNKNOWN";
    if (!bySymbol[sym]) bySymbol[sym]={trades:[],sessions:{}};
    bySymbol[sym].trades.push(t);
    const sess=t.session||"unknown";
    if (!bySymbol[sym].sessions[sess]) bySymbol[sym].sessions[sess]=[];
    bySymbol[sym].sessions[sess].push(t);
  }

  const symbolCards = Object.entries(bySymbol).map(([sym,d]) => {
    const allTrades=d.trades;
    const n=allTrades.length;
    const avgRR=parseFloat((allTrades.reduce((s,t)=>s+getBestRR(t),0)/n).toFixed(2));
    const globalEV=RR_LEVELS.map(rr=>{
      const wins=allTrades.filter(t=>getBestRR(t)>=rr).length,wr=wins/n;
      return{rr,ev:parseFloat((wr*rr-(1-wr)).toFixed(3))};
    });
    const bestGlobal=globalEV.reduce((a,b)=>b.ev>a.ev?b:a);
    const sessieData=TRADING_SESSIONS.map(sess=>{
      const st=d.sessions[sess]||[];
      const sessTPLock=tpLocks[`${sym}__${sess}`]||null;
      const slLockForSess=slLocks[sym]||null;
      if (st.length<3) return{sess,label:SESSION_LABELS[sess],trades:st.length,skip:true,tpLock:sessTPLock};
      const avgSessRR=parseFloat((st.reduce((s,t)=>s+getBestRR(t),0)/st.length).toFixed(2));
      const evTable=RR_LEVELS.map(rr=>{const wins=st.filter(t=>getBestRR(t)>=rr).length,wr=wins/st.length;return{rr,ev:parseFloat((wr*rr-(1-wr)).toFixed(3)),wr:parseFloat((wr*100).toFixed(1))};});
      const bestTP=evTable.reduce((a,b)=>b.ev>a.ev?b:a);
      const subRRBest=evTable.filter(e=>e.rr<1).reduce((a,b)=>b.ev>a.ev?b:a,{rr:null,ev:-Infinity});
      const tpLockProven=sessTPLock&&(sessTPLock.evAtLock??0)>0;
      const isStock=getSymbolType(sym)==="stock";
      const slWouldApply=tpLockProven;
      const slDirection=slLockForSess?.direction||"unchanged";
      const slDirLabel=slDirection==="up"?"🔼 Vergroot SL":slDirection==="down"?"🔽 Verklein SL":"✅ Huidig optimaal";
      const slAdvies=slWouldApply?`✅ SL 0.5× actief${isStock?" (ook aandeel)":""}`:`${slDirLabel} (ghost engine)`;
      const tpAdvies=bestTP.ev>0.5?`🎯 Sterk: ${bestTP.rr}R (EV +${bestTP.ev}R)`:bestTP.ev>0?`⚠️ Matig: ${bestTP.rr}R (EV +${bestTP.ev}R)`:"❌ EV negatief";
      const subRRAdvies=subRRBest.rr!==null&&subRRBest.ev>0?`⚡ Sub-1R: ${subRRBest.rr}R (EV +${subRRBest.ev}R)`:"";
      return{sess,label:SESSION_LABELS[sess],trades:st.length,avgRR:avgSessRR,
        bestTP:bestTP.rr,bestEV:bestTP.ev,bestWR:bestTP.wr,
        subRRBest:subRRBest.rr!==null&&subRRBest.ev>0?subRRBest:null,
        slAdvies,tpAdvies,subRRAdvies,tpLock:sessTPLock,slWouldApply,slLock:slLockForSess,
        slDirection,slDirLabel,sessieKleur:bestTP.ev>0.3?"green":bestTP.ev>0?"orange":"red",skip:false};
    }).filter(s=>!s.skip||s.trades>0);

    const validSessies=sessieData.filter(s=>!s.skip);
    const bestSessie=validSessies.length?validSessies.reduce((a,b)=>b.bestEV>a.bestEV?b:a):null;
    const worstSessie=validSessies.length>1?validSessies.reduce((a,b)=>b.bestEV<a.bestEV?b:a):null;
    const symSessionLocks=TRADING_SESSIONS.map(sess=>({sess,lock:tpLocks[`${sym}__${sess}`]||null})).filter(x=>x.lock!==null);
    const bestTPLock=symSessionLocks.length?symSessionLocks.reduce((a,b)=>((b.lock.evAtLock??0)>(a.lock.evAtLock??0)?b:a)).lock:null;
    const slLock=slLocks[sym];
    const tradesLeft=bestTPLock?Math.max(0,(Math.ceil(bestTPLock.lockedTrades/TP_UPDATE_INTERVAL)*TP_UPDATE_INTERVAL+TP_UPDATE_INTERVAL)-n):Math.max(0,TP_LOCK_THRESHOLD-n);
    const lockOptimizer=bestGlobal.rr;
    const lockDiffers=bestTPLock&&bestTPLock.lockedRR!==lockOptimizer&&bestGlobal.ev>0;
    const ghostPending=allTrades.filter(t=>t.trueMaxRR===null).length;
    const anyRiskBoost=symSessionLocks.some(x=>(x.lock.evAtLock??0)>0);
    const isStock=getSymbolType(sym)==="stock";
    const subRRGlobal=globalEV.filter(e=>e.rr<1).reduce((a,b)=>b.ev>a.ev?b:a,{rr:null,ev:-Infinity});

    let globalAdvies=[];
    if (bestGlobal.ev>0.5) globalAdvies.push(`✅ Sterk: EV +${bestGlobal.ev}R @ ${bestGlobal.rr}R`);
    else if (bestGlobal.ev>0) globalAdvies.push(`⚠️ Matig EV: +${bestGlobal.ev}R @ ${bestGlobal.rr}R`);
    else globalAdvies.push(`❌ Negatieve EV`);
    if (subRRGlobal.rr!==null&&subRRGlobal.ev>0) globalAdvies.push(`⚡ Sub-1R: ${subRRGlobal.rr}R (EV +${subRRGlobal.ev}R)`);
    if (bestSessie) globalAdvies.push(`🏆 ${bestSessie.label} (EV +${bestSessie.bestEV}R @ ${bestSessie.bestTP}R)`);
    if (worstSessie&&worstSessie.bestEV<0) globalAdvies.push(`🚫 Vermijd: ${worstSessie.label}`);
    if (anyRiskBoost) globalAdvies.push(`💥 Risk ×${TP_LOCK_RISK_MULT} actief`);
    if (anyRiskBoost) globalAdvies.push(`📐 SL 0.5× actief (TP lock bewezen)`);
    if (isStock) globalAdvies.push(`📊 Aandeel — SL ×${STOCK_SL_SPREAD_MULT} spread buffer`);
    if (slLock) globalAdvies.push(`🔧 SL engine: ${slLock.directionLabel||"analyse actief"}`);
    if (ghostPending>0) globalAdvies.push(`👻 ${ghostPending}/${n} ghost pending`);

    return{sym,n,avgRR,bestGlobalTP:bestGlobal.rr,bestGlobalEV:bestGlobal.ev,subRRGlobal,
      sessieData,globalAdvies,ghostPending,tpLock:bestTPLock,tpSessionLocks:symSessionLocks,
      slLock,tradesLeft,lockOptimizer,lockDiffers,isStock};
  });

  const equityData   = accountSnapshots.slice(-50).map(s=>({ts:s.ts,equity:s.equity,balance:s.balance}));
  const activeGhosts = Object.values(ghostTrackers).map(g=>({symbol:g.trade.symbol,direction:g.trade.direction,elapsed:Math.round((Date.now()-g.startedAt)/60000),remaining:Math.round((GHOST_DURATION_MS-(Date.now()-g.startedAt))/60000),currentRR:calcMaxRRFromPrice(g.trade,g.bestPrice)}));
  const recentTPLog  = tpUpdateLog.slice(0,10);
  const recentSLLog  = slUpdateLog.slice(0,10);
  const lockedTPCount = Object.keys(tpLocks).length;
  const lockedSLCount = Object.keys(slLocks).length;

  const forexConsolStatus = {};
  for (const [, pos] of Object.entries(openPositions)) {
    if (getSymbolType(pos.symbol) === "forex") {
      const k = `${getMT5Symbol(pos.symbol)}_${pos.direction}`;
      forexConsolStatus[k] = (forexConsolStatus[k] || 0) + 1;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FTMO Dashboard — NV v4.2</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0d0f14;--card:#161920;--border:#252a35;--green:#00c896;--orange:#f59e0b;--red:#ef4444;--blue:#3b82f6;--purple:#a855f7;--teal:#06b6d4;--text:#e2e8f0;--muted:#64748b;--accent:#6366f1;--yellow:#eab308}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
header{background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:18px;font-weight:700;color:var(--green)}
.badge{background:#1e2433;border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-size:11px;color:var(--muted)}
.badge.live{border-color:var(--green);color:var(--green)}
.badge.tp{border-color:var(--purple);color:var(--purple)}
.badge.sl{border-color:var(--teal);color:var(--teal)}
.badge.warn{border-color:var(--orange);color:var(--orange)}
main{max-width:1400px;margin:0 auto;padding:24px 20px}
.section-title{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:28px 0 12px;display:flex;align-items:center;gap:8px}
.section-title::after{content:'';flex:1;height:1px;background:var(--border)}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:4px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
.stat .val{font-size:24px;font-weight:700;color:var(--green)}
.stat .lbl{font-size:11px;color:var(--muted);margin-top:3px}
.chart-wrap{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:4px}
.lock-panel{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:4px}
.lock-panel-header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border)}
.lock-panel-header.tp{background:#1a0f2e}
.lock-panel-header.sl{background:#091a1f}
.lock-panel-header.forex{background:#0a1520}
.lock-panel-header h3{font-size:14px;font-weight:700}
.lock-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0}
.lock-cell{padding:14px 16px;border-right:1px solid var(--border);border-bottom:1px solid var(--border)}
.lock-pending{padding:14px 16px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);opacity:.6}
.lock-sym{font-size:15px;font-weight:700;margin-bottom:4px}
.lock-val{font-size:18px;font-weight:800;margin-bottom:4px}
.tp-color{color:var(--purple)}.sl-color{color:var(--teal)}.sl-up{color:var(--orange)}.sl-down{color:var(--blue)}
.lock-meta{font-size:11px;color:var(--muted);line-height:1.5}
.lock-badge{display:inline-block;font-size:10px;padding:2px 7px;border-radius:4px;margin-top:5px}
.new-tp{background:#1e1035;color:var(--purple);border:1px solid var(--purple)}
.upd-tp{background:#2a1a05;color:var(--orange);border:1px solid var(--orange)}
.new-sl{background:#091a1f;color:var(--teal);border:1px solid var(--teal)}
.sl-dir-up{background:#1a1205;color:var(--orange);border:1px solid var(--orange)}
.sl-dir-down{background:#050e1a;color:var(--blue);border:1px solid var(--blue)}
.sl-dir-ok{background:#051a10;color:var(--green);border:1px solid var(--green)}
.log-table{width:100%;border-collapse:collapse;font-size:12px}
.log-table th{text-align:left;color:var(--muted);font-weight:600;padding:8px 12px;border-bottom:1px solid var(--border);font-size:11px}
.log-table td{padding:9px 12px;border-bottom:1px solid #1a1f2e}
.log-table tr:last-child td{border-bottom:none}
.log-table tr:hover td{background:#1a1f2e}
.arr-up{color:var(--green)}.arr-dn{color:var(--red)}.arr-eq{color:var(--muted)}
.sym-card{background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:14px;overflow:hidden}
.sym-header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--border);background:#1a1f2e}
.sym-name{font-size:17px;font-weight:700}
.sym-meta{color:var(--muted);font-size:12px}
.sym-ev{margin-left:auto;text-align:right}
.sym-ev .val{font-size:19px;font-weight:700}
.sym-ev .lbl{font-size:11px;color:var(--muted)}
.ev-pos{color:var(--green)}.ev-neg{color:var(--red)}.ev-mid{color:var(--orange)}
.badge-inline{display:inline-flex;align-items:center;gap:5px;border-radius:6px;padding:3px 9px;font-size:11px;margin-left:6px}
.badge-inline.tp-active{background:#1e1035;border:1px solid var(--purple);color:var(--purple)}
.badge-inline.sl-active{background:#0a1f20;border:1px solid var(--teal);color:var(--teal)}
.badge-inline.no-lock{background:#1a1f2e;border:1px solid var(--border);color:var(--muted)}
.badge-inline.stock-badge{background:#1a1a2e;border:1px solid var(--blue);color:var(--blue)}
.badge-inline.sub-rr{background:#1a1500;border:1px solid var(--yellow);color:var(--yellow)}
.global-advies{padding:10px 20px;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:6px}
.advies-pill{background:#1e2433;border-radius:20px;padding:4px 11px;font-size:12px}
.sessie-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.sessie-col{padding:14px 18px;border-right:1px solid var(--border)}
.sessie-col:last-child{border-right:none}
.sessie-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.sessie-label.green{color:var(--green)}.sessie-label.orange{color:var(--orange)}.sessie-label.red{color:var(--red)}.sessie-label.gray{color:var(--muted)}
.sessie-stat{display:flex;justify-content:space-between;margin-bottom:5px;font-size:12px}
.sessie-stat .k{color:var(--muted)}.sessie-stat .v{font-weight:600}
.sessie-advies{margin-top:8px;padding:7px 9px;background:#1a1f2e;border-radius:6px;font-size:12px;line-height:1.5}
.sessie-advies .sl{margin-top:4px;color:var(--teal)}
.sessie-advies .sub-rr-note{margin-top:4px;color:var(--yellow)}
.tp-sessie-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;margin-top:4px;background:#1e1035;border:1px solid var(--purple);color:var(--purple)}
.sl-dir-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;margin-top:4px}
.no-data{color:var(--muted);font-size:12px;font-style:italic}
.ghost-bar{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 20px}
.ghost-item{display:flex;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)}
.ghost-item:last-child{border-bottom:none}
.ghost-sym{font-weight:600;width:90px;font-size:13px}
.ghost-detail{color:var(--muted);font-size:12px;flex:1}
.ghost-rr{font-weight:700;color:var(--green);width:40px;text-align:right}
.prog-wrap{width:80px;height:4px;background:#252a35;border-radius:2px}
.prog-fill{height:100%;background:var(--accent);border-radius:2px}
.forex-consol{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 20px;margin-bottom:4px}
.consol-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px}
.consol-row:last-child{border-bottom:none}
.consol-count{font-weight:700;color:var(--orange)}
.consol-blocked{color:var(--red);font-weight:700}
footer{text-align:center;color:var(--muted);font-size:11px;padding:28px 20px}
a{color:var(--muted);text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>⚡ FTMO Dashboard</h1>
  <span style="color:var(--muted);font-size:12px">NV v4.2</span>
  <span class="badge live">● Live</span>
  <span class="badge">${getBrusselsDateStr()}</span>
  ${lockedTPCount?`<span class="badge tp">🔒 ${lockedTPCount} TP locks</span>`:""}
  ${lockedSLCount?`<span class="badge sl">📐 ${lockedSLCount} SL analyses</span>`:""}
  ${activeGhosts.length?`<span class="badge warn">👻 ${activeGhosts.length} ghost</span>`:""}
</header>
<main>

<p class="section-title">Overzicht</p>
<div class="summary">
  <div class="stat"><div class="val">${closedTrades.length}</div><div class="lbl">Gesloten trades</div></div>
  <div class="stat"><div class="val" style="color:var(--blue)">${symbolCards.length}</div><div class="lbl">Symbolen</div></div>
  <div class="stat"><div class="val" style="color:var(--purple)">${lockedTPCount}</div><div class="lbl">TP sessie-locks</div></div>
  <div class="stat"><div class="val" style="color:var(--teal)">${lockedSLCount}</div><div class="lbl">SL analyses</div></div>
  <div class="stat"><div class="val" style="color:var(--orange)">${closedTrades.filter(t=>t.trueMaxRR===null).length}</div><div class="lbl">Ghost pending</div></div>
  <div class="stat"><div class="val">${closedTrades.length?(closedTrades.reduce((s,t)=>s+getBestRR(t),0)/closedTrades.length).toFixed(2):"–"}R</div><div class="lbl">Gem. best RR</div></div>
  <div class="stat"><div class="val" style="color:var(--blue)">${Object.keys(openPositions).length}</div><div class="lbl">Open posities</div></div>
</div>

${equityData.length>=2?`
<p class="section-title">Equity Curve</p>
<div class="chart-wrap"><canvas id="eqChart" height="70"></canvas></div>`:""}

${Object.keys(forexConsolStatus).length>0?`
<p class="section-title">Forex Consolidatie Monitor</p>
<div class="lock-panel">
  <div class="lock-panel-header forex">
    <span style="font-size:18px">🔄</span>
    <h3>Open forex posities per pair + richting</h3>
    <span style="color:var(--muted);font-size:12px;margin-left:auto">Blokkeert bij ≥${FOREX_MAX_SAME_DIR}</span>
  </div>
  <div style="padding:14px 20px">
    ${Object.entries(forexConsolStatus).map(([k,count])=>{
      const blocked=count>=FOREX_MAX_SAME_DIR;
      return`<div class="consol-row"><span style="font-weight:600">${k}</span><span class="${blocked?"consol-blocked":"consol-count"}">${count}/${FOREX_MAX_SAME_DIR} ${blocked?"🚫 GEBLOKKEERD":"✅ OK"}</span></div>`;
    }).join("")}
  </div>
</div>`:""}

<p class="section-title">TP Lock — Sessie-Aware (Risk ×${TP_LOCK_RISK_MULT} | Min lot cap ×${TP_LOCK_RISK_MULT} bij lock)</p>
<div class="lock-panel">
  <div class="lock-panel-header tp">
    <span style="font-size:18px">🔒</span>
    <h3>Gelockte TP niveaus per symbool per sessie</h3>
    <span style="color:var(--muted);font-size:12px;margin-left:auto">Sub-1R (0.2–0.8R) · Lock na ${TP_LOCK_THRESHOLD} trades · Min lot €${RISK_MINLOT_CAP}→€${RISK_MINLOT_CAP*TP_LOCK_RISK_MULT}</span>
  </div>
  <div class="lock-grid">
    ${symbolCards.map(c=>{
      if (c.tpSessionLocks.length){
        return c.tpSessionLocks.map(({sess,lock})=>{
          const diffArrow=lock.prevRR?(lock.lockedRR>lock.prevRR?"▲":lock.lockedRR<lock.prevRR?"▼":"="):null;
          const diffClass=lock.prevRR?(lock.lockedRR>lock.prevRR?"arr-up":lock.lockedRR<lock.prevRR?"arr-dn":"arr-eq"):"";
          const isSubRR=lock.lockedRR<1;
          return`<div class="lock-cell">
  <div class="lock-sym">${c.sym}${isSubRR?` <span style="color:var(--yellow);font-size:10px">⚡sub-1R</span>`:""}</div>
  <div style="font-size:10px;color:var(--muted);margin-bottom:3px">${SESSION_LABELS[sess]||sess}</div>
  <div class="lock-val tp-color">${lock.lockedRR}R TP</div>
  <div class="lock-meta">EV: +${lock.evAtLock??"-"}R · ${lock.lockedTrades} trades<br>
  ${lock.prevRR?`Vorige: <span class="${diffClass}">${diffArrow} ${lock.prevRR}R</span><br>`:""}
  ${new Date(lock.lockedAt).toLocaleString("nl-BE",{timeZone:"Europe/Brussels",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</div>
  <span class="lock-badge ${lock.prevRR?"upd-tp":"new-tp"}">${lock.prevRR?"🔄 update":"🔒 nieuw"}</span>
</div>`;
        }).join("");
      }
      return`<div class="lock-pending">
  <div style="font-weight:600;margin-bottom:4px">${c.sym}</div>
  <div style="color:var(--orange);font-size:13px">⏳ ${c.n}/${TP_LOCK_THRESHOLD}</div>
  <div style="font-size:11px;margin-top:3px">Nog ${c.tradesLeft} trade${c.tradesLeft===1?"":"s"}</div>
</div>`;
    }).join("")}
  </div>
</div>

<p class="section-title">SL Direction Engine (Ghost-driven — READONLY)</p>
<div class="lock-panel">
  <div class="lock-panel-header sl">
    <span style="font-size:18px">📐</span>
    <h3>SL advies per symbool</h3>
    <span style="color:var(--muted);font-size:12px;margin-left:auto">SL 0.5× bij bewezen TP lock · Stocks ×${STOCK_SL_SPREAD_MULT} spread buffer</span>
  </div>
  <div class="lock-grid">
    ${symbolCards.map(c=>{
      const slLock=c.slLock;
      const anyProven=c.tpSessionLocks.some(x=>(x.lock.evAtLock??0)>0);
      const dir=slLock?.direction||"unchanged";
      const dirBadgeClass=dir==="up"?"sl-dir-up":dir==="down"?"sl-dir-down":"sl-dir-ok";
      const dirLabel=dir==="up"?"🔼 Vergroot SL":dir==="down"?"🔽 Verklein SL":"✅ Huidig optimaal";
      return`<div class="lock-cell">
  <div class="lock-sym">${c.sym}</div>
  ${anyProven?`<div class="lock-val sl-color">0.5× actief</div><div class="lock-meta">✅ TP lock bewezen${c.isStock?" (stock ✅)":""}</div>`
    :`<div class="lock-val" style="color:var(--muted)">Geen 0.5×</div><div class="lock-meta">⏳ TP lock niet bewezen</div>`}
  ${slLock?`<div class="lock-meta" style="margin-top:4px">Multiplier: ${slLock.multiplier}× · EV +${slLock.evAtLock}R</div>
  <span class="lock-badge ${dirBadgeClass}">${dirLabel}</span>`
    :`<div class="lock-meta" style="margin-top:4px;color:var(--muted)">⏳ Nog geen ghost data</div>`}
</div>`;
    }).join("")}
  </div>
</div>

${recentTPLog.length||recentSLLog.length?`
<p class="section-title">Lock Wijzigingen</p>
<div class="lock-panel">
  <table class="log-table">
    <thead><tr><th>Tijdstip</th><th>Type</th><th>Symbool</th><th>Sessie</th><th>Oud</th><th></th><th>Nieuw</th><th>Trades</th><th>EV</th><th>Reden</th></tr></thead>
    <tbody>
      ${[...recentTPLog.map(l=>({...l,type:"TP"})),...recentSLLog.map(l=>({...l,type:"SL",oldRR:l.oldMultiplier,newRR:l.newMultiplier}))].sort((a,b)=>new Date(b.ts)-new Date(a.ts)).slice(0,15).map(l=>{
        const arrow=l.oldRR===null?"🆕":l.newRR>l.oldRR?`<span class="arr-up">▲</span>`:l.newRR<l.oldRR?`<span class="arr-dn">▼</span>`:`<span class="arr-eq">=</span>`;
        const unit=l.type==="TP"?"R":"×";
        const dirInfo=l.type==="SL"&&l.direction?` <span style="font-size:10px;color:var(--muted)">[${l.direction}]</span>`:"";
        return`<tr>
          <td>${new Date(l.ts).toLocaleString("nl-BE",{timeZone:"Europe/Brussels",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
          <td><span style="color:${l.type==="TP"?"var(--purple)":"var(--teal)"};font-weight:600">${l.type}</span></td>
          <td style="font-weight:600">${l.symbol}</td>
          <td style="color:var(--muted);font-size:11px">${l.session||"–"}</td>
          <td style="color:var(--muted)">${l.oldRR!==null?l.oldRR+unit:"–"}</td>
          <td>${arrow}</td>
          <td style="font-weight:700;color:${l.type==="TP"?"var(--purple)":"var(--teal)"}">${l.newRR}${unit}${dirInfo}</td>
          <td>${l.trades}</td>
          <td style="color:${(l.ev||0)>0?"var(--green)":"var(--red)"}">${l.ev!=null?(l.ev>0?"+":"")+l.ev+"R":"–"}</td>
          <td style="color:var(--muted);font-size:11px">${l.reason}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>
</div>`:""}

<p class="section-title">Analyse per symbool &amp; sessie</p>
${symbolCards.length===0?`<p style="color:var(--muted)">Nog geen gesloten trades.</p>`:symbolCards.map(c=>{
  const evCls=c.bestGlobalEV>0.3?"ev-pos":c.bestGlobalEV>0?"ev-mid":"ev-neg";
  const bestTPLock=c.tpLock;
  const tpBadge=bestTPLock
    ?`<span class="badge-inline tp-active${c.lockDiffers?" diff":""}">🔒 TP ${bestTPLock.lockedRR}R${bestTPLock.evAtLock?(` EV+${bestTPLock.evAtLock}R`):""}</span>`
    :`<span class="badge-inline no-lock">⏳ TP ${c.n}/${TP_LOCK_THRESHOLD}</span>`;
  const isStockBadge=c.isStock?`<span class="badge-inline stock-badge">📊 aandeel ×${STOCK_SL_SPREAD_MULT}SL</span>`:"";
  const subRRBadge=c.subRRGlobal&&c.subRRGlobal.rr!==null&&c.subRRGlobal.ev>0?`<span class="badge-inline sub-rr">⚡ sub-1R: ${c.subRRGlobal.rr}R (+${c.subRRGlobal.ev}R)</span>`:"";
  const anyProven=c.tpSessionLocks.some(x=>(x.lock.evAtLock??0)>0);
  const slBadge=anyProven
    ?`<span class="badge-inline sl-active">📐 SL 0.5× actief</span>`
    :`<span class="badge-inline no-lock">📐 SL wacht TP lock</span>`;
  return`<div class="sym-card">
  <div class="sym-header">
    <div>
      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
        <span class="sym-name">${c.sym}</span>${tpBadge}${slBadge}${isStockBadge}${subRRBadge}
      </div>
      <div class="sym-meta">${c.n} trades · gem. best RR: ${c.avgRR}R · ${c.ghostPending>0?`👻 ${c.ghostPending} pending`:"✅ ghost compleet"}</div>
    </div>
    <div class="sym-ev">
      <div class="val ${evCls}">${c.bestGlobalEV>0?"+":""}${c.bestGlobalEV}R</div>
      <div class="lbl">beste EV @ ${c.bestGlobalTP}R</div>
    </div>
  </div>
  <div class="global-advies">${c.globalAdvies.map(a=>`<span class="advies-pill">${a}</span>`).join("")}</div>
  <div class="sessie-grid">
    ${c.sessieData.map(s=>{
      if (s.skip) return`<div class="sessie-col"><div class="sessie-label gray">${s.label}</div><p class="no-data">Te weinig data (${s.trades})</p>${s.tpLock?`<div class="tp-sessie-badge">🔒 ${s.tpLock.lockedRR}R</div>`:""}</div>`;
      const slDirBadgeClass=s.slDirection==="up"?"sl-dir-up":s.slDirection==="down"?"sl-dir-down":"sl-dir-ok";
      return`<div class="sessie-col">
  <div class="sessie-label ${s.sessieKleur}">${s.label}</div>
  ${s.tpLock?`<div class="tp-sessie-badge">🔒 TP ${s.tpLock.lockedRR}R · EV +${s.tpLock.evAtLock}R${s.tpLock.lockedRR<1?" ⚡":""}</div>`:`<div style="font-size:11px;color:var(--muted);margin-bottom:6px">⏳ geen TP lock</div>`}
  <div class="sessie-stat"><span class="k">Trades</span><span class="v">${s.trades}</span></div>
  <div class="sessie-stat"><span class="k">Gem. best RR</span><span class="v">${s.avgRR}R</span></div>
  <div class="sessie-stat"><span class="k">Beste TP</span><span class="v">${s.bestTP}R${s.bestTP<1?" ⚡":""}</span></div>
  <div class="sessie-stat"><span class="k">EV @ beste TP</span><span class="v ${s.bestEV>0?"ev-pos":s.bestEV>-0.1?"ev-mid":"ev-neg"}">${s.bestEV>0?"+":""}${s.bestEV}R</span></div>
  <div class="sessie-stat"><span class="k">Winrate</span><span class="v">${s.bestWR}%</span></div>
  <div class="sessie-stat"><span class="k">Risk boost</span><span class="v" style="color:${s.tpLock&&(s.tpLock.evAtLock??0)>0?"var(--green)":"var(--muted)"}">${s.tpLock&&(s.tpLock.evAtLock??0)>0?`×${TP_LOCK_RISK_MULT}`:"×1"}</span></div>
  ${s.slLock?`<div class="sessie-stat"><span class="k">SL advies</span><span class="v"><span class="lock-badge ${slDirBadgeClass}" style="font-size:10px;padding:1px 5px">${s.slDirLabel}</span></span></div>`:""}
  <div class="sessie-advies">${s.tpAdvies}<div class="sl">${s.slAdvies}</div>${s.subRRAdvies?`<div class="sub-rr-note">${s.subRRAdvies}</div>`:""}</div>
</div>`;
    }).join("")}
  </div>
</div>`;
}).join("")}

${activeGhosts.length?`
<p class="section-title">Actieve Ghost Trackers</p>
<div class="ghost-bar">
  ${activeGhosts.map(g=>`<div class="ghost-item">
  <div class="ghost-sym">👻 ${g.symbol}</div>
  <div class="ghost-detail">${g.direction.toUpperCase()} · ${g.elapsed}min geleden · ${g.remaining}min resterend</div>
  <div class="ghost-rr">${g.currentRR}R</div>
  <div class="prog-wrap"><div class="prog-fill" style="width:${Math.min(100,Math.round(g.elapsed/(g.elapsed+g.remaining||1)*100))}%"></div></div>
</div>`).join("")}
</div>`:""}

</main>
<footer>FTMO NV v4.2 · Auto-refresh 60s · CET/CEST auto · <a href="/">API</a> · <a href="/tp-locks">TP Locks</a> · <a href="/sl-locks">SL Engine</a></footer>
<script>
setTimeout(()=>location.reload(),60000);
${equityData.length>=2?`
const ctx=document.getElementById("eqChart").getContext("2d");
new Chart(ctx,{type:"line",data:{
  labels:${JSON.stringify(equityData.map(s=>new Date(s.ts).toLocaleTimeString("nl-BE",{hour:"2-digit",minute:"2-digit"})))},
  datasets:[
    {label:"Equity",data:${JSON.stringify(equityData.map(s=>s.equity))},borderColor:"#00c896",backgroundColor:"rgba(0,200,150,.08)",borderWidth:2,pointRadius:0,tension:.3,fill:true},
    {label:"Balance",data:${JSON.stringify(equityData.map(s=>s.balance))},borderColor:"#6366f1",backgroundColor:"transparent",borderWidth:1.5,pointRadius:0,borderDash:[4,4],tension:.3}
  ]},options:{responsive:true,maintainAspectRatio:true,
  plugins:{legend:{labels:{color:"#94a3b8",font:{size:11}}}},
  scales:{x:{ticks:{color:"#475569",font:{size:10}},grid:{color:"#1e2433"}},y:{ticks:{color:"#475569",font:{size:10}},grid:{color:"#1e2433"}}}}});`:""}
</script>
</body>
</html>`;
  res.send(html);
});

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function startServer() {
  await initDB();

  const hist  = await loadAllTrades();
  const valid = hist.filter(t => t.closed_at || t.closedAt);
  closedTrades.push(...valid);
  console.log(`📂 ${valid.length} gesloten trades geladen`);

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

  const symSet = [...new Set(valid.map(t => t.symbol).filter(Boolean))];
  for (const sym of symSet) {
    await runTPLockEngine(sym).catch(() => {});
    await runSLLockEngine(sym).catch(() => {});
  }
  console.log(`🔒 TP sessie-locks: ${Object.keys(tpLocks).length} | 📐 SL analyses: ${Object.keys(slLocks).length}`);

  for (const sess of TRADING_SESSIONS) {
    const sessLocks = Object.entries(tpLocks)
      .filter(([k]) => k.endsWith(`__${sess}`))
      .map(([k,v]) => `${k.replace(`__${sess}`,"")}: ${v.lockedRR}R (EV+${v.evAtLock}R)`);
    if (sessLocks.length)
      console.log(`🔒 [${sess.toUpperCase()}] ${sessLocks.join(" | ")}`);
  }

  const server = app.listen(PORT, () =>
    console.log([
      `🚀 FTMO Webhook v4.2 — poort ${PORT}`,
      `🌍 Timezone: Europe/Brussels (auto CET/CEST)`,
      `💰 Balance: €${ACCOUNT_BALANCE}`,
      `📈 Risico | Index:€${RISK.index} Forex:€${RISK.forex} Gold:€${RISK.gold} Crypto:€${RISK.crypto} Stock:€${RISK.stock}`,
      `📊 Indices: 02:00–20:00 (ook Asia sessie) | Stocks: 15:30–20:00`,
      `🔒 TP Lock: sessie-aware | Risk ×${TP_LOCK_RISK_MULT} ook stocks bij EV>0`,
      `💰 Min lot cap: €${RISK_MINLOT_CAP} normaal → €${RISK_MINLOT_CAP*TP_LOCK_RISK_MULT} bij TP lock (×${TP_LOCK_RISK_MULT})`,
      `📐 SL Regel: 0.5× bij bewezen TP lock — ook stocks`,
      `🔧 SL Engine: ghost-driven direction (up/down/unchanged) — READONLY`,
      `📊 Stock SL: ×${STOCK_SL_SPREAD_MULT} spread buffer | Spread guard: max ${STOCK_MAX_SPREAD_FRACTION*100}% van SL-afstand`,
      `🔄 Forex anti-consolidatie: max ${FOREX_MAX_SAME_DIR} trades zelfde richting+pair`,
      `⚡ Sub-1R TP levels: 0.2/0.4/0.6/0.8R inbegrepen in optimizer`,
      `⏰ Auto-close: 20:50 elke dag`,
      `🌙 Weekend: BTC/ETH (02:00–20:00)`,
      `👻 Ghost tracker: 24u post-close → trueMaxRR + SL direction`,
      `🗺️  Symbolen: ${Object.keys(SYMBOL_MAP).length} (indices/forex/gold/crypto/stocks)`,
    ].join("\n"))
  );

  function shutdown(sig) {
    console.log(`\n🛑 ${sig} — ghost trackers stoppen...`);
    for (const [id, g] of Object.entries(ghostTrackers)) {
      clearInterval(g.timer);
      delete ghostTrackers[id];
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

startServer().catch(err => { console.error("❌", err.message); process.exit(1); });
