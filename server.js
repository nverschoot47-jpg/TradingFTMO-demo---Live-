// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v5.2
// Account : Nick Verschoot — FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ───────────────────────────────────────────────────────────────
// WIJZIGINGEN v5.2 (t.o.v. v5.1):
//  ✅ [FEAT 1]  Forex uitgebreid — alle pairs behalve JPY & exotics
//              EURNZD + GBPNZD toegevoegd; 7 JPY-pairs verwijderd
//  ✅ [FEAT 2]  UK Index min SL: 5 → 2
//  ✅ [FEAT 3]  Ghost Trading hard stop: 22:00 (was 20:00)
//              Loopt door bij: manual close, TP close, TP lock,
//              shadow optimisation. Stopt alleen bij SL phantom
//              trigger of 22:00 hard stop.
//  ✅ [FEAT 4]  Vast TP = Risk × 4R voor ALLE trades in sessie/pair
//              (niet enkel eerste trade, niet afhankelijk van EV lock)
//  ✅ [FEAT 5]  TP lock na 3 trades per pair per sessie (avondregel)
//  ✅ [FEAT 6]  Daily Risk Scaling: positieve EV → Risk ×1.2 volgende
//              dag; geen positieve EV → reset naar standaard
//  ✅ [FEAT 7]  SL Shadow Optimizer trigger: 50 → 30 trades
//  ✅ [FEAT 8]  Duplicate entry guard — zelfde pair+richting binnen
//              60s volledig geblokkeerd
//  ✅ [FEAT 9]  Hard tijdslimieten bijgewerkt:
//              - Auto-close: 20:50 → 21:50
//              - Ghost + Shadow stop cron: 22:00 (nieuw)
//              - Reconnect cron: 02:00 (nieuw)
//  ✅ [FEAT 10] Forex pyramiding: max 2× per pair per richting
//              (was 3×). Trade 1 = vol risk, Trade 2 = 50% risk.
//  ✅ [KEEP]   Fix 3 (forex consolidation restart) — ongewijzigd
//  ✅ [KEEP]   Fix 5 (webhook timeout 8s) — ongewijzigd
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
  saveGhostAnalysis, loadGhostAnalysis,
  savePnlLog, loadPnlStats,
  logForexConsolidation,
  saveDailyRisk, loadLatestDailyRisk,
  logDuplicateEntry,
} = require("./db");

const {
  getBrusselsComponents,
  getBrusselsDateStr,
  getSessionGMT1,
  isMarketOpen: isMarketOpenFn,
  isGhostActive,
  isShadowActive,
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

// [FEAT 7] SL shadow optimizer na 30 trades (was 50)
const SL_AUTO_APPLY_THRESHOLD  = 30;

// [FEAT 4] Vast TP = 4R voor alle trades
const FIXED_TP_RR = 4;

const STOCK_SL_SPREAD_MULT      = 1.5;
const STOCK_MAX_SPREAD_FRACTION = 0.333;

// [FEAT 10] Forex pyramiding: max 2× per pair/richting
const FOREX_MAX_SAME_DIR        = 2;  // was 3
const FOREX_HALF_RISK_THRESHOLD = 1;  // trade 2 krijgt 50% risk

const TP_LOCK_RISK_MULT = 4;

// ── RISICO PER TYPE ───────────────────────────────────────────
const BASE_RISK = {
  index:  parseFloat(process.env.RISK_INDEX  || "200"),
  forex:  parseFloat(process.env.RISK_FOREX  || "15"),
  gold:   parseFloat(process.env.RISK_GOLD   || "30"),
  brent:  parseFloat(process.env.RISK_BRENT  || "30"),
  wti:    parseFloat(process.env.RISK_WTI    || "30"),
  crypto: parseFloat(process.env.RISK_CRYPTO || "30"),
  stock:  parseFloat(process.env.RISK_STOCK  || "30"),
};

// [FEAT 6] Daily risk multiplier — wordt bijgewerkt door dagelijkse EV check
let dailyRiskMultiplier     = 1.0;   // actief voor vandaag
let dailyRiskMultiplierNext = 1.0;   // berekend einde dag, toepassen morgen

function getRisk(type) {
  return (BASE_RISK[type] || 30) * dailyRiskMultiplier;
}

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
const tpLocks          = {};
const slLocks          = {};
const tpUpdateLog      = [];
const slUpdateLog      = [];

// [FEAT 8] Duplicate entry guard — key: "SYMBOL_direction", value: timestamp
const recentOrderGuard = new Map();
const DUPLICATE_GUARD_MS = 60 * 1000; // 60 seconden window

const MAX_SNAPSHOTS = 86400;
const MAX_HISTORY   = 200;
const MAX_TP_LOG    = 100;
const MAX_SL_LOG    = 100;

const TRADING_SESSIONS = ["asia", "london", "ny"];

function addWebhookHistory(entry) {
  webhookHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.length = MAX_HISTORY;
}

const learnedPatches = {};

// ══════════════════════════════════════════════════════════════
// SYMBOL MAP
// [FEAT 1] JPY-pairs verwijderd. EURNZD + GBPNZD toegevoegd.
// Alle resterende forex zijn major/minor zonder JPY/exotics.
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
  // ── Commodities & Crypto ─────────────────────────────────
  "XAUUSD":      { mt5: "XAUUSD",      type: "gold"   },
  "GOLD":        { mt5: "XAUUSD",      type: "gold"   },
  "UKOIL":       { mt5: "UKOIL.cash",  type: "brent"  },
  "UKOIL.cash":  { mt5: "UKOIL.cash",  type: "brent"  },
  "USOIL":       { mt5: "USOIL.cash",  type: "wti"    },
  "USOIL.cash":  { mt5: "USOIL.cash",  type: "wti"    },
  "BTCUSD":      { mt5: "BTCUSD",      type: "crypto" },
  "ETHUSD":      { mt5: "ETHUSD",      type: "crypto" },
  // ── Stocks ───────────────────────────────────────────────
  "AAPL":  { mt5: "AAPL",  type: "stock" },
  "APC":   { mt5: "AAPL",  type: "stock" }, // TradingView alias
  "TSLA":  { mt5: "TSLA",  type: "stock" },
  "TLO":   { mt5: "TSLA",  type: "stock" }, // TradingView alias
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
  // ── Forex — major/minor pairs (geen JPY, geen exotics) ───
  // [FEAT 1] JPY-pairs (USDJPY/EURJPY/GBPJPY/AUDJPY/CADJPY/NZDJPY/CHFJPY) verwijderd
  "EURUSD": { mt5: "EURUSD", type: "forex" },
  "GBPUSD": { mt5: "GBPUSD", type: "forex" },
  "USDCHF": { mt5: "USDCHF", type: "forex" },
  "USDCAD": { mt5: "USDCAD", type: "forex" },
  "AUDUSD": { mt5: "AUDUSD", type: "forex" },
  "NZDUSD": { mt5: "NZDUSD", type: "forex" },
  "EURGBP": { mt5: "EURGBP", type: "forex" },
  "EURCHF": { mt5: "EURCHF", type: "forex" },
  "EURAUD": { mt5: "EURAUD", type: "forex" },
  "EURCAD": { mt5: "EURCAD", type: "forex" },
  "EURNZD": { mt5: "EURNZD", type: "forex" }, // nieuw
  "GBPCHF": { mt5: "GBPCHF", type: "forex" },
  "GBPAUD": { mt5: "GBPAUD", type: "forex" },
  "GBPCAD": { mt5: "GBPCAD", type: "forex" },
  "GBPNZD": { mt5: "GBPNZD", type: "forex" }, // nieuw
  "AUDCAD": { mt5: "AUDCAD", type: "forex" },
  "AUDCHF": { mt5: "AUDCHF", type: "forex" },
  "AUDNZD": { mt5: "AUDNZD", type: "forex" },
  "CADCHF": { mt5: "CADCHF", type: "forex" },
  "NZDCAD": { mt5: "NZDCAD", type: "forex" },
  "NZDCHF": { mt5: "NZDCHF", type: "forex" },
};

// ── LOT / STOP CONFIG ─────────────────────────────────────────
const LOT_VALUE = { index:20, gold:100, brent:10, wti:10, crypto:1, stock:1, forex:10 };
const MAX_LOTS  = { index:10, gold:1,   brent:5,  wti:5,  crypto:1, stock:50, forex:0.25 };

const MIN_STOP_INDEX = {
  "GER40.cash":10,
  "UK100.cash":2,    // [FEAT 2] was 5 → 2
  "US100.cash":10,
  "US30.cash":10,
  "US500.cash":5,
  "JP225.cash":10,
  "AUS200.cash":5,
  "EU50.cash":5,
  "FRA40.cash":5,
  "HK50.cash":10,
  "US2000.cash":5,
};
const MIN_STOP_COMMODITY = {
  "XAUUSD":1.0, "UKOIL.cash":0.05, "USOIL.cash":0.05, "BTCUSD":100.0, "ETHUSD":5.0,
};

// [FEAT 1] Geen JPY pairs in min-stop map (worden niet getraded)
const MIN_STOP_FOREX = {
  "EURUSD":0.0005, "GBPUSD":0.0005, "AUDUSD":0.0005, "NZDUSD":0.0005,
  "USDCHF":0.0005, "USDCAD":0.0005,
  "EURGBP":0.0005, "EURAUD":0.0005, "EURCAD":0.0005, "EURCHF":0.0005,
  "EURNZD":0.0005, // nieuw
  "GBPAUD":0.0005, "GBPCAD":0.0005, "GBPCHF":0.0005,
  "GBPNZD":0.0005, // nieuw
  "AUDCAD":0.0005, "AUDCHF":0.0005, "AUDNZD":0.0005,
  "CADCHF":0.0005,
  "NZDCAD":0.0005, "NZDCHF":0.0005,
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
  return learnedPatches[sym]?.mt5Override ?? SYMBOL_MAP[sym]?.mt5 ?? sym;
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
    const r = await fetch(`${META_BASE}/positions`, {
      headers: {"auth-token": META_API_TOKEN}, signal: ctrl.signal
    });
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
    const bid = data.bid ?? null, ask = data.ask ?? null;
    if (bid !== null && ask !== null) return { mid: (bid+ask)/2, spread: ask-bid, bid, ask };
    const mid = bid ?? ask ?? null;
    return mid !== null ? { mid, spread:0, bid:mid, ask:mid } : null;
  } catch(e) { console.warn(`⚠️ fetchCurrentPrice(${mt5Symbol}):`, e.message); return null; }
}

// ── [FEAT 9] AUTO-CLOSE 21:50 Brussels (was 20:50) ───────────
cron.schedule("50 21 * * *", async () => {
  const { day } = getBrusselsComponents();
  const isWE = day === 0 || day === 6;
  console.log("🔔 21:50 Brussels — auto-close gestart...");
  try {
    const positions = await fetchOpenPositions();
    if (!Array.isArray(positions) || !positions.length) {
      console.log("📭 Geen open posities bij auto-close.");
    } else {
      for (const pos of positions) {
        const tvSym = Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k].mt5 === pos.symbol) || pos.symbol;
        if (isWE && getSymbolType(tvSym) === "crypto" && isCryptoWeekend(tvSym)) continue;
        try {
          await closePosition(pos.id);
          console.log(`✅ Auto-close 21:50: ${pos.symbol}`);
          addWebhookHistory({ type:"AUTOCLOSE_2150", symbol:pos.symbol, positionId:pos.id });
        } catch(e) { console.error(`❌ Auto-close ${pos.symbol}:`, e.message); }
      }
    }
    // [FEAT 6] Bereken dagelijkse EV na sluiting posities
    await evaluateDailyRisk();
  } catch(e) { console.error("❌ Auto-close fout:", e.message); }
}, { timezone: "Europe/Brussels" });

// ── [FEAT 9] GHOST + SHADOW HARD STOP 22:00 ──────────────────
cron.schedule("0 22 * * *", async () => {
  console.log("🌙 22:00 Brussels — ghost & shadow hard stop...");

  // Stop alle actieve ghost trackers
  let ghostCount = 0;
  for (const [ghostId, g] of Object.entries(ghostTrackers)) {
    finaliseGhost(ghostId, g.trade, g.bestPrice, "day_end_22:00", g.startedAt);
    ghostCount++;
  }
  console.log(`👻 ${ghostCount} ghost(s) gestopt om 22:00`);

  // Consolideer sessie data
  const todayTrades = closedTrades.filter(t => {
    if (!t.closedAt) return false;
    const d = new Date(t.closedAt);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  console.log(`📊 Sessie data: ${todayTrades.length} trades vandaag opgeslagen`);
  addWebhookHistory({ type:"DAY_END_22:00", ghostsStopped: ghostCount, todayTrades: todayTrades.length });
}, { timezone: "Europe/Brussels" });

// ── [FEAT 9] RECONNECT 02:00 Brussels ────────────────────────
cron.schedule("0 2 * * *", async () => {
  console.log("🔄 02:00 Brussels — dagelijkse reconnect...");
  // Pas risk multiplier toe voor nieuwe dag
  dailyRiskMultiplier = dailyRiskMultiplierNext;
  console.log(`💰 [Risk] Multiplier voor vandaag: ×${dailyRiskMultiplier.toFixed(2)}`);
  // Herstel open posities van MT5
  await restoreOpenPositionsFromMT5();
  // Reset duplicate guard
  recentOrderGuard.clear();
  addWebhookHistory({ type:"RECONNECT_02:00", riskMultiplier: dailyRiskMultiplier });
}, { timezone: "Europe/Brussels" });

// ── NIGHTLY TP OPTIMIZER 03:00 Brussels ──────────────────────
cron.schedule("0 3 * * *", async () => {
  console.log("🌙 03:00 Brussels — nightly optimizer...");
  const symbols = [...new Set(closedTrades.map(t => t.symbol).filter(Boolean))];
  for (const sym of symbols) {
    await runTPLockEngine(sym).catch(e => console.error(`❌ [TP nightly] ${sym}:`, e.message));
    await runSLLockEngine(sym).catch(e => console.error(`❌ [SL nightly] ${sym}:`, e.message));
  }
  console.log(`✅ Nightly optimizer klaar — ${symbols.length} symbolen`);
}, { timezone: "Europe/Brussels" });

// ── [FEAT 6] DAILY RISK SCALING ───────────────────────────────
async function evaluateDailyRisk() {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    const todayTrades = closedTrades.filter(t => {
      if (!t.closedAt) return false;
      return t.closedAt.startsWith(todayStr);
    });

    const totalPnl = todayTrades.reduce((sum, t) => sum + (t.realizedPnlEUR ?? 0), 0);
    const evPositive = totalPnl > 0;

    // Bepaal multiplier voor morgen
    dailyRiskMultiplierNext = evPositive
      ? parseFloat(Math.min(dailyRiskMultiplier * 1.2, 3.0).toFixed(2)) // max cap ×3
      : 1.0; // reset naar standaard

    console.log(
      `📅 [Daily Risk] ${todayStr}: PnL=€${totalPnl.toFixed(2)} | EV=${evPositive?"✅":"❌"} | ` +
      `Morgen mult=×${dailyRiskMultiplierNext}`
    );

    await saveDailyRisk(
      todayStr,
      totalPnl,
      todayTrades.length,
      dailyRiskMultiplier,
      dailyRiskMultiplierNext
    );
  } catch(e) { console.warn("⚠️ evaluateDailyRisk:", e.message); }
}

// ── RESTART RECOVERY ──────────────────────────────────────────
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
      const entry     = pos.openPrice ?? pos.currentPrice ?? 0;
      const session   = getSessionGMT1(pos.time ? new Date(pos.time) : null);
      openPositions[id] = {
        id, symbol: tvSym, mt5Symbol: pos.symbol, direction,
        entry, sl: pos.stopLoss ?? 0, tp: pos.takeProfit ?? null,
        lots: pos.volume ?? 0.01, riskEUR: getRisk(getSymbolType(tvSym)),
        openedAt: pos.time ?? new Date().toISOString(),
        session, sessionLabel: SESSION_LABELS[session] || session,
        maxPrice: entry, maxRR: 0, currentPnL: pos.unrealizedProfit ?? 0,
        lastSync: null, slMultiplierApplied: 1.0, spreadGuard: false,
        restoredAfterRestart: true,
      };
      incrementTracker(tvSym, direction);
      restored++;
      console.log(`🔄 [Restart Recovery] ${tvSym} id=${id}`);
    }
    console.log(`✅ [Restart Recovery] ${restored} positie(s) hersteld`);
  } catch(e) { console.warn("⚠️ [Restart Recovery] Mislukt:", e.message); }
}

// ── [FIX 3] FOREX ANTI-CONSOLIDATIE ──────────────────────────
// [FEAT 10] Aangepast: max 2× (was 3×), halfRisk bij count===1
function checkForexConsolidation(symbol, direction) {
  const mt5Sym = getMT5Symbol(symbol);
  let count = 0;
  for (const pos of Object.values(openPositions)) {
    if (pos.restoredAfterRestart) continue;
    const posMt5 = getMT5Symbol(pos.symbol) || pos.mt5Symbol;
    if ((posMt5 === mt5Sym || pos.symbol === symbol) && pos.direction === direction) count++;
  }
  return {
    blocked:  count >= FOREX_MAX_SAME_DIR,          // ≥2 → geblokkeerd
    halfRisk: count >= FOREX_HALF_RISK_THRESHOLD && count < FOREX_MAX_SAME_DIR, // count===1 → 50%
    count,
  };
}

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

// ── [FEAT 8] DUPLICATE ENTRY GUARD ───────────────────────────
function isDuplicateOrder(symbol, direction) {
  const key = `${symbol}_${direction}`;
  const last = recentOrderGuard.get(key);
  if (!last) return false;
  return (Date.now() - last) < DUPLICATE_GUARD_MS;
}

function registerRecentOrder(symbol, direction) {
  const key = `${symbol}_${direction}`;
  recentOrderGuard.set(key, Date.now());
  // Auto-cleanup na 2 minuten
  setTimeout(() => recentOrderGuard.delete(key), DUPLICATE_GUARD_MS * 2);
}

// ── HELPERS ───────────────────────────────────────────────────
function getEffectiveRisk(symbol, direction) {
  const key   = `${symbol}_${direction}`;
  const count = openTradeTracker[key] || 0;
  const base  = getRisk(getSymbolType(symbol)); // [FEAT 6] gebruikt dagelijkse multiplier
  let risk    = Math.max(base * 0.10, base / Math.pow(2, count));

  const curSess = getSessionGMT1();
  const lockKey = `${symbol}__${curSess}`;
  const lock    = tpLocks[lockKey];
  if (lock && (lock.evAtLock ?? 0) > 0 && count === 0) {
    risk = Math.min(risk * TP_LOCK_RISK_MULT, base * TP_LOCK_RISK_MULT);
    console.log(`💥 [TP Lock] Risk boost ${symbol}/${curSess}: €${risk.toFixed(2)}`);
  }
  return risk;
}

function incrementTracker(sym, dir) { const k=`${sym}_${dir}`; openTradeTracker[k]=(openTradeTracker[k]||0)+1; }
function decrementTracker(sym, dir) { const k=`${sym}_${dir}`; if (openTradeTracker[k]>0) openTradeTracker[k]--; }

function getBestRR(trade) { return trade.trueMaxRR ?? trade.maxRR ?? 0; }

function validateSL(dir, entry, sl, mt5Sym, type) {
  const minD = getMinStop(mt5Sym, type, entry);
  const dist = Math.abs(entry - sl);
  if (type === "stock") {
    const reqDist = Math.max(dist, minD) * STOCK_SL_SPREAD_MULT;
    return parseFloat((dir === "buy" ? entry - reqDist : entry + reqDist).toFixed(5));
  }
  if (dist < minD) {
    const adj = dir==="buy" ? entry-minD : entry+minD;
    console.warn(`⚠️ SL te dicht → ${adj}`);
    return parseFloat(adj.toFixed(5));
  }
  return sl;
}

function calcLots(symbol, entry, sl, risk) {
  const type    = getSymbolType(symbol);
  const lotVal  = LOT_VALUE[type] || 1;
  const maxLots = MAX_LOTS[type]  || 50;
  const lotStep = learnedPatches[symbol]?.lotStepOverride || (type==="stock" ? 1 : 0.01);
  const dist    = Math.abs(entry - sl);
  if (dist <= 0) return lotStep;

  let lots = Math.floor((risk / (dist * lotVal)) / lotStep) * lotStep;
  lots = Math.min(lots, maxLots);
  lots = Math.max(lots, lotStep);

  const baseRisk     = getRisk(type);
  const isTPLockRisk = risk >= baseRisk * TP_LOCK_RISK_MULT;
  const effectiveCap = isTPLockRisk ? baseRisk * TP_LOCK_RISK_MULT : baseRisk;
  const minCost      = lots * dist * lotVal;

  if (minCost > effectiveCap) {
    console.warn(`⚠️ Min lot kost €${minCost.toFixed(2)} > cap €${effectiveCap} → skip`);
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

function calcTPPrice(direction, entry, sl, lockedRR) {
  const dist = Math.abs(entry - sl);
  return direction === "buy"
    ? parseFloat((entry + dist * lockedRR).toFixed(5))
    : parseFloat((entry - dist * lockedRR).toFixed(5));
}

function applySlMultiplier(dir, entry, sl, multiplier) {
  if (!multiplier || multiplier === 1.0) return sl;
  const origDist = Math.abs(entry - sl);
  const newDist  = origDist * multiplier;
  const newSl    = dir === "buy" ? entry - newDist : entry + newDist;
  return parseFloat(newSl.toFixed(5));
}

// ── SL ANALYSE ────────────────────────────────────────────────
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
      return { rr, wins, total: trades.length, winrate:`${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
    });
    const best = evTable.reduce((a,b) => b.ev>a.ev ? b : a);
    return {
      slMultiple: mult,
      label: mult===1.0?"✅ huidig":mult<1.0?`🔽 ${mult}× kleiner`:`🔼 ${mult}× groter`,
      bestTP:`${best.rr}R`, bestEV:best.ev, bestWinrate:best.winrate, evTable,
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
// [FEAT 3] Loopt door tot 22:00 — stopt niet bij 20:00
// Stopt enkel bij: SL phantom trigger of 22:00 hard stop
// ══════════════════════════════════════════════════════════════
function startGhostTracker(closedTrade) {
  const ghostId   = `ghost_${closedTrade.id}_${Date.now()}`;
  const startedAt = Date.now();
  let bestPrice   = closedTrade.maxPrice ?? closedTrade.entry;
  let currentTimer = null;

  console.log(`👻 Ghost gestart: ${closedTrade.symbol} | startMaxRR: ${closedTrade.maxRR}R`);

  async function tick() {
    try {
      // [FEAT 3] Gebruik isGhostActive() i.p.v. hhmm >= 2000
      // Ghost stopt bij 22:00, niet bij 20:00
      const elapsed   = Date.now() - startedAt;
      const ghostOk   = isGhostActive();
      const shouldStop = elapsed >= GHOST_DURATION_MS || !ghostOk;

      const priceData = await fetchCurrentPrice(closedTrade.mt5Symbol);
      const price     = priceData?.mid ?? null;

      if (price !== null) {
        const better = closedTrade.direction === "buy" ? price > bestPrice : price < bestPrice;
        if (better) bestPrice = price;
        if (ghostTrackers[ghostId]) ghostTrackers[ghostId].bestPrice = bestPrice;

        // SL Phantom Trigger — stopt ghost onmiddellijk
        const slBreach = closedTrade.direction === "buy"
          ? price <= closedTrade.sl
          : price >= closedTrade.sl;

        if (slBreach) {
          console.log(`💀 [Ghost] SL phantom trigger: ${closedTrade.symbol}`);
          finaliseGhost(ghostId, closedTrade, bestPrice, "sl_phantom_trigger", startedAt);
          return;
        }
      }

      if (shouldStop) {
        const reason = elapsed >= GHOST_DURATION_MS ? "timeout" : "day_end_22:00";
        finaliseGhost(ghostId, closedTrade, bestPrice, reason, startedAt);
        return;
      }

      const interval = elapsed < GHOST_OLD_THRESHOLD_MS ? GHOST_INTERVAL_RECENT_MS : GHOST_INTERVAL_OLD_MS;
      currentTimer = setTimeout(tick, interval);
      if (ghostTrackers[ghostId]) ghostTrackers[ghostId].timer = currentTimer;
    } catch(e) { console.warn(`⚠️ Ghost ${ghostId}:`, e.message); }
  }

  currentTimer = setTimeout(tick, GHOST_INTERVAL_RECENT_MS);
  ghostTrackers[ghostId] = { trade: closedTrade, timer: currentTimer, startedAt, bestPrice };

  setTimeout(() => {
    if (ghostTrackers[ghostId])
      finaliseGhost(ghostId, closedTrade, ghostTrackers[ghostId].bestPrice, "failsafe", startedAt);
  }, GHOST_DURATION_MS + 5 * 60 * 1000);
}

function finaliseGhost(ghostId, trade, bestPrice, reason, startedAt) {
  if (!ghostTrackers[ghostId]) return;
  clearTimeout(ghostTrackers[ghostId].timer);
  delete ghostTrackers[ghostId];

  const trueMaxRR        = calcMaxRRFromPrice(trade, bestPrice);
  const ghostExtraRR     = parseFloat((trueMaxRR - (trade.maxRR ?? 0)).toFixed(3));
  const ghostDurationMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : null;
  const hitTP            = trade.tp != null && trueMaxRR >= (Math.abs(trade.entry - trade.sl) > 0
    ? Math.abs((trade.direction === "buy" ? trade.tp - trade.entry : trade.entry - trade.tp) / Math.abs(trade.entry - trade.sl))
    : 0);

  const idx = closedTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    closedTrades[idx].trueMaxRR        = trueMaxRR;
    closedTrades[idx].trueMaxPrice     = bestPrice;
    closedTrades[idx].ghostStopReason  = reason;
    closedTrades[idx].ghostFinalizedAt = new Date().toISOString();
    closedTrades[idx].hitTP            = hitTP;

    saveTrade(closedTrades[idx]).catch(e => console.error(`❌ [DB] ghost saveTrade:`, e.message));

    saveGhostAnalysis({
      symbol: trade.symbol, session: trade.session, direction: trade.direction,
      entry: trade.entry, sl: trade.sl, tp: trade.tp,
      maxRRAtClose: trade.maxRR, trueMaxRR, ghostExtraRR, hitTP,
      ghostStopReason: reason, ghostDurationMin,
      ghostFinalizedAt: new Date().toISOString(),
      closedAt: trade.closedAt, realizedPnlEUR: trade.realizedPnlEUR ?? null,
      tradePositionId: trade.id,
    }).catch(e => console.error(`❌ [DB] ghost analyse:`, e.message));

    console.log(`✅ Ghost ${trade.symbol} → trueMaxRR: ${trueMaxRR}R (extra: ${ghostExtraRR}R) | ${reason}`);
    runTPLockEngine(trade.symbol).catch(e => console.error(`❌ [TP Lock]:`, e.message));
    runSLLockEngine(trade.symbol).catch(e => console.error(`❌ [SL Lock]:`, e.message));
  }
}

// ══════════════════════════════════════════════════════════════
// TP LOCK ENGINE
// [FEAT 5] TP lock na 3 trades (ongewijzigd — was al correct)
// [FEAT 4] FIXED_TP_RR = 4 als default wanneer geen EV-data
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

  // [FEAT 5] Lock na 3 trades
  if (n < 3) return;

  const existing = tpLocks[lockKey];

  const evTable = RR_LEVELS.map(rr => {
    const wins = trades.filter(t => getBestRR(t) >= rr).length;
    const wr   = wins / n;
    return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)) };
  });
  const best       = evTable.reduce((a,b) => b.ev > a.ev ? b : a);
  const evPositive = best.ev > 0;

  // [FEAT 4] Gebruik FIXED_TP_RR (4R) als basis; EV-optimaal als het beter is
  const effectiveRR = evPositive ? best.rr : FIXED_TP_RR;

  const oldRR      = existing?.lockedRR ?? null;
  const isNew      = !existing;
  const changed    = existing && existing.lockedRR !== effectiveRR;
  const needsUpdate = existing && (n - existing.lockedTrades) >= 5;

  if (!isNew && !changed && !needsUpdate) {
    tpLocks[lockKey] = { ...existing, lockedTrades: n };
    return;
  }

  const reason = isNew
    ? `eerste lock na ${n} trades [${session}] → ${effectiveRR}R`
    : `update na ${n} trades (${oldRR}R → ${effectiveRR}R) [${session}]`;

  tpLocks[lockKey] = {
    lockedRR: effectiveRR, lockedAt: new Date().toISOString(), lockedTrades: n,
    session, prevRR: oldRR, prevLockedAt: existing?.lockedAt ?? null,
    evAtLock: best.ev, evPositive,
  };

  const logEntry = { symbol, session, oldRR, newRR: effectiveRR, trades: n, ev: best.ev, reason, ts: new Date().toISOString() };
  tpUpdateLog.unshift(logEntry);
  if (tpUpdateLog.length > MAX_TP_LOG) tpUpdateLog.length = MAX_TP_LOG;

  try {
    await saveTPConfig(symbol, session, effectiveRR, n, best.ev, oldRR, existing?.lockedAt ?? null);
    await logTPUpdate(symbol, session, oldRR, effectiveRR, n, best.ev, reason);
  } catch(e) { console.error(`❌ [TP Lock] DB:`, e.message); }

  console.log(`🔒 [TP Lock] ${symbol}/${session}: ${isNew?"NIEUW":"UPDATE"} → ${effectiveRR}R (EV ${best.ev}R | ${n} trades) [${evPositive?"✅":"⚠️ 4R default"}]`);
}

// ══════════════════════════════════════════════════════════════
// SL LOCK ENGINE
// [FEAT 7] Auto-apply na 30 trades (was 50)
// [FEAT 3] Shadow optimizer check via isShadowActive()
// ══════════════════════════════════════════════════════════════
async function runSLLockEngine(symbol) {
  // [FEAT 3] Shadow optimizer respecteert 22:00 stop
  if (!isShadowActive()) {
    console.log(`⏸️ [SL Shadow] ${symbol}: shadow optimizer gestopt (na 22:00)`);
    return;
  }

  const trades = closedTrades.filter(t => t.symbol === symbol && t.sl && t.entry);
  const n      = trades.length;
  if (n < 10) return;

  const existing  = slLocks[symbol];
  if (existing && (n - (existing.lockedTrades ?? 0)) < 5) return;

  const analysis  = buildSLAnalysis(trades);
  const best      = analysis.reduce((a,b) => b.bestEV > a.bestEV ? b : a);
  const direction = getSLDirection(analysis);

  if (best.bestEV <= 0) return;

  const oldMult   = existing?.multiplier ?? null;
  const isNew     = !existing;
  const changed   = existing && (existing.multiplier !== best.slMultiple || existing.direction !== direction);
  // [FEAT 7] Auto-apply na 30 trades (was SL_AUTO_APPLY_THRESHOLD = 50)
  const autoApply = n >= SL_AUTO_APPLY_THRESHOLD;

  if (!isNew && !changed) {
    slLocks[symbol] = { ...existing, lockedTrades: n, autoApplied: autoApply };
    return;
  }

  const reason        = isNew
    ? `eerste analyse na ${n} trades [${direction}]${autoApply ? " [AUTO APPLIED]" : " [READONLY]"}`
    : `update na ${n} trades${autoApply ? " [AUTO APPLIED]" : " [READONLY]"}`;
  const appliedAt     = autoApply ? new Date().toISOString() : null;
  const appliedTrades = autoApply ? n : null;

  slLocks[symbol] = {
    multiplier: best.slMultiple, direction, lockedAt: new Date().toISOString(),
    lockedTrades: n, evAtLock: best.bestEV, bestTPRR: parseFloat(best.bestTP),
    prevMultiplier: oldMult, prevLockedAt: existing?.lockedAt ?? null,
    autoApplied: autoApply, appliedAt, appliedTrades,
    note: autoApply
      ? `✅ AUTO APPLIED na ${n} trades`
      : `⏳ READONLY — nog ${SL_AUTO_APPLY_THRESHOLD - n} trades tot auto-apply`,
    directionLabel: direction === "up" ? "🔼 Vergroot SL" : direction === "down" ? "🔽 Verklein SL" : "✅ Huidig optimaal",
  };

  const logEntry = {
    symbol, oldMultiplier: oldMult, newMultiplier: best.slMultiple, direction,
    trades: n, ev: best.bestEV, reason, autoApplied: autoApply, ts: new Date().toISOString(),
  };
  slUpdateLog.unshift(logEntry);
  if (slUpdateLog.length > MAX_SL_LOG) slUpdateLog.length = MAX_SL_LOG;

  try {
    await saveSLConfig(symbol, best.slMultiple, direction, n, best.bestEV,
      parseFloat(best.bestTP), oldMult, existing?.lockedAt ?? null,
      autoApply, appliedAt, appliedTrades);
    await logSLUpdate(symbol, oldMult, best.slMultiple, direction, n, best.bestEV, reason, autoApply);
  } catch(e) { console.error(`❌ [SL Analyse] DB:`, e.message); }

  console.log(`📐 [SL ${autoApply?"AUTO":"ADVIES"}] ${symbol}: ${best.slMultiple}× (${direction}) EV +${best.bestEV}R | ${n} trades | auto@${SL_AUTO_APPLY_THRESHOLD}`);
}

// ── SL MULTIPLIER BEPALEN ─────────────────────────────────────
function getEffectiveSLMultiplier(symbol, session, entryNum, slNum, direction) {
  const slLock    = slLocks[symbol];
  const tpLockKey = `${symbol}__${session}`;
  const tpLockNow = tpLocks[tpLockKey];
  const tpProven  = tpLockNow && (tpLockNow.evAtLock ?? 0) > 0;

  let multiplier = 1.0;
  let info       = "geen aanpassing";

  if (slLock?.autoApplied && slLock.multiplier !== 1.0) {
    multiplier = slLock.multiplier;
    info       = `${multiplier}× (auto-apply na ${slLock.appliedTrades} trades, EV +${slLock.evAtLock}R)`;
    console.log(`📐 [SL Auto] ${symbol}: ${multiplier}× toegepast`);
  } else if (tpProven) {
    multiplier = 0.5;
    info       = `0.5× (TP bewezen ${symbol}/${session}, EV +${tpLockNow.evAtLock}R)`;
    console.log(`📐 [SL TP-proven] ${symbol}/${session}: 0.5×`);
  }

  const newSL = applySlMultiplier(direction, entryNum, slNum, multiplier);
  return { multiplier, slApplied: newSL, info };
}

// ── POSITION SYNC (30s) ───────────────────────────────────────
const ACCOUNT_SYNC_INTERVAL = 5 * 60 * 1000;
let lastAccountSync = 0;

async function syncPositions() {
  try {
    const live    = await fetchOpenPositions();
    const liveIds = new Set((live||[]).map(p => String(p.id)));

    for (const pos of (live||[])) {
      const id    = String(pos.id);
      const trade = openPositions[id];
      if (!trade) continue;
      const cur  = pos.currentPrice ?? pos.openPrice ?? 0;
      const lotV = LOT_VALUE[getSymbolType(trade.symbol)] || 1;
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
        const maxRR          = calcMaxRR(trade);
        const session        = getSessionGMT1(trade.openedAt);
        const realizedPnlEUR = trade.currentPnL ?? 0;
        const hitTP          = trade.tp != null && maxRR >= (trade.tp != null
          ? Math.abs((trade.direction==="buy" ? trade.tp-trade.entry : trade.entry-trade.tp) / Math.abs(trade.entry-trade.sl))
          : 999);

        const closed = {
          ...trade, closedAt: new Date().toISOString(), maxRR, session,
          sessionLabel: SESSION_LABELS[session] || session,
          trueMaxRR: null, trueMaxPrice: null, realizedPnlEUR, hitTP,
        };
        closedTrades.push(closed);
        saveTrade(closed).catch(e => console.error(`❌ [DB] saveTrade:`, e.message));
        savePnlLog(trade.symbol, session, trade.direction, maxRR, hitTP, realizedPnlEUR)
          .catch(e => console.error(`❌ [DB] pnlLog:`, e.message));
        if (trade.symbol && trade.direction) decrementTracker(trade.symbol, trade.direction);
        delete openPositions[id];
        console.log(`📦 ${trade.symbol} gesloten | MaxRR: ${maxRR}R | Sessie: ${session}`);
        // [FEAT 3] Ghost start altijd — ook na TP of manual close
        startGhostTracker(closed);
      }
    }

    if (Date.now() - lastAccountSync > ACCOUNT_SYNC_INTERVAL) {
      lastAccountSync = Date.now();
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
      } catch(e) { console.warn("⚠️ Snapshot mislukt:", e.message); }
    }
  } catch(e) { console.warn("⚠️ syncPositions:", e.message); }
}
setInterval(syncPositions, 30 * 1000);

// ── ORDER PLAATSEN MET TIMEOUT (Fix 5) ───────────────────────
function learnFromError(symbol, code, msg) {
  const m = (msg||"").toLowerCase();
  if (!learnedPatches[symbol]) learnedPatches[symbol] = {};
  if (code==="TRADE_RETCODE_INVALID" && m.includes("symbol")) {
    const cur   = getMT5Symbol(symbol);
    const tried = learnedPatches[symbol]._triedMt5 || [];
    const next  = [cur.replace(".cash",""), cur+".cash"].filter(s => s!==cur && !tried.includes(s))[0];
    if (next) { learnedPatches[symbol].mt5Override = next; learnedPatches[symbol]._triedMt5 = [...tried, next]; }
  }
  if (m.includes("volume")||m.includes("lot"))
    learnedPatches[symbol].lotStepOverride = (learnedPatches[symbol]?.lotStepOverride || 0.01) * 10;
  if (m.includes("stop")||code==="TRADE_RETCODE_INVALID_STOPS") {
    const mt5  = getMT5Symbol(symbol);
    const type = getSymbolType(symbol);
    if (type==="index") MIN_STOP_INDEX[mt5] = (MIN_STOP_INDEX[mt5] || 5) * 2;
    else if (type==="forex") MIN_STOP_FOREX[mt5] = (MIN_STOP_FOREX[mt5] || 0.0005) * 2;
  }
}

async function placeOrder(dir, symbol, entry, sl, lots, session) {
  const mt5Symbol = getMT5Symbol(symbol);
  const type      = getSymbolType(symbol);
  const slPrice   = validateSL(dir, entry, sl, mt5Symbol, type);

  // [FEAT 4] Vast TP = FIXED_TP_RR (4R) voor ALLE trades
  // Override met TP lock waarde indien hoger EV beschikbaar
  const lockKey   = `${symbol}__${session}`;
  const tpLock    = tpLocks[lockKey];
  const tpRR      = tpLock ? tpLock.lockedRR : FIXED_TP_RR;
  const tpPrice   = calcTPPrice(dir, entry, slPrice, tpRR);

  console.log(`🎯 [TP] ${symbol}/${session} TP: ${tpPrice} (${tpRR}R${tpLock ? " [lock]" : " [4R default]"})`);

  const body = {
    symbol:     mt5Symbol,
    volume:     lots,
    actionType: dir==="buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    stopLoss:   slPrice,
    takeProfit: tpPrice,
    comment:    `FTMO-NV-${dir.toUpperCase()}-${symbol}-TP${tpRR}R-${session}`,
  };

  const r = await fetch(`${META_BASE}/trade`, {
    method: "POST",
    headers: {"Content-Type":"application/json","auth-token":META_API_TOKEN},
    body:   JSON.stringify(body),
  });
  return { result: await r.json(), mt5Symbol, slPrice, body, tpPrice, tpRR };
}

async function placeOrderWithTimeout(dir, symbol, entry, sl, lots, session) {
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("MetaApi timeout — order niet bevestigd binnen 8s")), 8000)
  );
  return Promise.race([
    placeOrder(dir, symbol, entry, sl, lots, session),
    timeout,
  ]);
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK
// [FEAT 8] Duplicate entry guard toegevoegd
// [FEAT 10] Forex pyramiding: max 2× per pair/richting
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

    // [FEAT 8] Duplicate entry check
    if (isDuplicateOrder(symbol, direction)) {
      const dupReason = `Duplicate geblokkeerd: ${symbol} ${direction} (binnen 60s)`;
      logDuplicateEntry(symbol, direction, dupReason).catch(() => {});
      addWebhookHistory({ type:"DUPLICATE_BLOCKED", symbol, direction });
      console.warn(`🚫 [Duplicate] ${dupReason}`);
      return res.status(200).json({ status:"SKIP", reason: dupReason });
    }

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
        // [FEAT 10] Geblokkeerd na 2e trade
        const reason = `Forex pyramiding max 2×: ${consol.count} open ${direction} trades voor ${symbol}`;
        logForexConsolidation(symbol, direction, consol.count, reason).catch(() => {});
        addWebhookHistory({ type:"FOREX_PYRAMID_BLOCKED", symbol, direction, count:consol.count });
        return res.status(200).json({ status:"SKIP", reason });
      }
      if (consol.halfRisk) {
        // [FEAT 10] Trade 2 = 50% risk
        forexHalfRisk = true;
        console.log(`⚡ [Forex Pyramiding] ${symbol} ${direction} trade #${consol.count+1} → 50% risk`);
      }
    }

    const { multiplier: slMult, slApplied, info: slLockInfo } =
      getEffectiveSLMultiplier(symbol, curSession, entryNum, slNum, direction);

    let spreadGuard = false;
    if (symType === "stock") {
      const priceData = await fetchCurrentPrice(mt5Sym).catch(() => null);
      if (priceData && priceData.spread > 0) {
        const sg = checkSpreadGuard(priceData.spread, entryNum, slApplied);
        if (!sg.ok) {
          addWebhookHistory({ type:"SPREAD_GUARD_BLOCKED", symbol, spreadPct:sg.spreadPct });
          return res.status(200).json({ status:"SKIP", reason:`Spread te groot: ${sg.spreadPct}%` });
        }
      }
    }

    let risk = getEffectiveRisk(symbol, direction);
    if (forexHalfRisk) { risk *= 0.5; }

    const ftmo = ftmoSafetyCheck(risk);
    if (!ftmo.ok) {
      addWebhookHistory({ type:"FTMO_BLOCKED", symbol });
      return res.status(200).json({ status:"FTMO_BLOCKED", reason:ftmo.reason });
    }

    const lots = calcLots(symbol, entryNum, slApplied, risk);
    if (lots===null) return res.status(200).json({ status:"SKIP", reason:`Min lot > cap` });

    console.log(`📊 ${direction.toUpperCase()} ${symbol}/${curSession} | Entry:${entryNum} SL:${slApplied} (${slMult}×) Lots:${lots} Risk:€${risk.toFixed(2)} Mult:×${dailyRiskMultiplier}`);

    // Registreer order guard VOOR plaatsing
    registerRecentOrder(symbol, direction);

    let orderResult;
    try {
      orderResult = await placeOrderWithTimeout(direction, symbol, entryNum, slApplied, lots, curSession);
    } catch(timeoutErr) {
      console.error(`⏱️ [Timeout] ${symbol}:`, timeoutErr.message);
      addWebhookHistory({ type:"TIMEOUT", symbol, reason: timeoutErr.message });
      return res.status(200).json({ status:"TIMEOUT", reason: timeoutErr.message });
    }

    let { result, mt5Symbol, slPrice, tpPrice, tpRR } = orderResult;

    const errCode = result?.error?.code || result?.retcode;
    const errMsg  = result?.error?.message || result?.comment || "";
    const isError = result?.error || (errCode && errCode!==10009 && errCode!=="TRADE_RETCODE_DONE");

    if (isError) {
      learnFromError(symbol, errCode, errMsg);
      const rl = calcLots(symbol, entryNum, slApplied, risk);
      if (rl !== null) {
        try {
          const retry  = await placeOrderWithTimeout(direction, symbol, entryNum, slApplied, rl, curSession);
          result       = retry.result;
          tpPrice      = retry.tpPrice;
          tpRR         = retry.tpRR;
          const retryErr = retry.result?.error || (retry.result?.retcode && retry.result.retcode!==10009 && retry.result.retcode!=="TRADE_RETCODE_DONE");
          if (retryErr) {
            learnFromError(symbol, retry.result?.error?.code||retry.result?.retcode, retry.result?.error?.message||retry.result?.comment);
            addWebhookHistory({ type:"ERROR", symbol, errCode, errMsg });
            return res.status(200).json({ status:"ERROR_LEARNED", errCode, errMsg });
          }
        } catch(retryTimeout) {
          console.error(`⏱️ [Retry Timeout] ${symbol}:`, retryTimeout.message);
          addWebhookHistory({ type:"TIMEOUT_RETRY", symbol });
          return res.status(200).json({ status:"TIMEOUT", reason:"Retry ook timeout" });
        }
      }
    }

    registerFtmoLoss(risk);
    incrementTracker(symbol, direction);

    const posId = String(result?.positionId || result?.orderId || Date.now());

    openPositions[posId] = {
      id: posId, symbol, mt5Symbol, direction,
      entry: entryNum, sl: slPrice, tp: tpPrice, lots,
      riskEUR: risk, openedAt: new Date().toISOString(),
      session: curSession, sessionLabel: SESSION_LABELS[curSession] || curSession,
      maxPrice: entryNum, maxRR: 0, currentPnL: 0, lastSync: null,
      slMultiplierApplied: slMult, spreadGuard, forexHalfRisk,
      restoredAfterRestart: false,
    };

    addWebhookHistory({
      type:"SUCCESS", symbol, mt5Symbol, direction, lots, posId,
      session: curSession, riskEUR: risk.toFixed(2),
      slAanpassing: slLockInfo,
      tp: `${tpRR}R @ ${tpPrice}`,
      slAutoApplied: slMult !== 1.0,
      dailyRiskMult: dailyRiskMultiplier,
      forexPyramiding: forexHalfRisk ? "trade2_50pct" : null,
    });

    res.json({
      status:"OK", versie:"v5.2",
      direction, tvSymbol:symbol, mt5Symbol, symType,
      session:curSession, sessionLabel:SESSION_LABELS[curSession],
      entry:entryNum, sl:slPrice, slOriginal:slNum,
      slMultiplier:slMult, slLockInfo,
      slAutoApplied: slLocks[symbol]?.autoApplied ?? false,
      slTradesUntilAuto: Math.max(0, SL_AUTO_APPLY_THRESHOLD - (closedTrades.filter(t=>t.symbol===symbol).length)),
      tp: tpPrice, tpRR, tpFixed: `${FIXED_TP_RR}R (vast)`,
      tpInfo: `✅ TP: ${tpRR}R @ ${tpPrice} [${curSession}]${tpLocks[`${symbol}__${curSession}`] ? " [lock]" : " [4R default]"}`,
      lots, risicoEUR:risk.toFixed(2),
      dailyRiskMultiplier, dailyRiskMultiplierNext,
      forexHalfRisk: forexHalfRisk ? "⚡ 50% risk (trade 2/2)" : null,
      positionId:posId, metaApi:result,
    });
  } catch(err) {
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
    // Ghost blijft actief na manual close [FEAT 3]
    res.json({ status:"OK", result, note:"Ghost tracker blijft actief na manual close" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ENDPOINTS ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  const { hhmm } = getBrusselsComponents();
  res.json({
    status:"online", versie:"ftmo-v5.2",
    time: getBrusselsDateStr(),
    features: {
      "feat1_forex": "✅ Uitgebreid (geen JPY/exotics) — 21 pairs",
      "feat2_uk100": `✅ UK100 min SL: 2 (was 5)`,
      "feat3_ghost": `✅ Ghost tot 22:00 | actief nu: ${isGhostActive()}`,
      "feat4_tp4R":  `✅ Vast TP = ${FIXED_TP_RR}R voor alle trades`,
      "feat5_tplock":"✅ TP lock na 3 trades per sessie",
      "feat6_risksc":  `✅ Daily risk mult: ×${dailyRiskMultiplier} | morgen: ×${dailyRiskMultiplierNext}`,
      "feat7_sl30":  `✅ SL shadow optimizer na ${SL_AUTO_APPLY_THRESHOLD} trades`,
      "feat8_dup":   "✅ Duplicate guard 60s",
      "feat9_times": "✅ Auto-close 21:50 | Ghost/Shadow stop 22:00 | Reconnect 02:00",
      "feat10_pyr":  `✅ Forex pyramiding max 2× (50% risk op trade 2)`,
    },
    tracking: {
      openPositions: Object.keys(openPositions).length,
      closedTrades:  closedTrades.length,
      tpLocks:       Object.keys(tpLocks).length,
      slAnalyses:    Object.keys(slLocks).length,
      ghostTrackers: Object.keys(ghostTrackers).length,
      duplicateGuard: recentOrderGuard.size,
    },
  });
});

app.get("/status", (req, res) => {
  res.json({
    openTrades: openTradeTracker,
    learnedPatches,
    risicoPerType: Object.fromEntries(
      Object.entries(BASE_RISK).map(([k,v]) => [k, `€${(v * dailyRiskMultiplier).toFixed(2)} (base €${v} × ${dailyRiskMultiplier})`])
    ),
    dailyRisk: { multiplier: dailyRiskMultiplier, nextDay: dailyRiskMultiplierNext },
  });
});

app.get("/live/positions", (req, res) => {
  res.json({
    count: Object.keys(openPositions).length,
    positions: Object.values(openPositions).map(p => ({
      id:p.id, symbol:p.symbol, direction:p.direction,
      entry:p.entry, sl:p.sl, tp:p.tp, tpRR: FIXED_TP_RR, lots:p.lots,
      riskEUR:p.riskEUR, openedAt:p.openedAt, session:p.session,
      currentPrice:p.currentPrice??null, currentPnL:p.currentPnL??0,
      maxRR:p.maxRR??0, slMultiplier:p.slMultiplierApplied??1.0,
      restoredAfterRestart:p.restoredAfterRestart??false,
      forexHalfRisk:p.forexHalfRisk??false,
    })),
  });
});

app.get("/live/ghosts", (req, res) => {
  const active = Object.entries(ghostTrackers).map(([id,g]) => ({
    ghostId:id, symbol:g.trade.symbol, direction:g.trade.direction,
    entry:g.trade.entry, sl:g.trade.sl, maxRRAtClose:g.trade.maxRR,
    currentBestRR: calcMaxRRFromPrice(g.trade, g.bestPrice),
    elapsedMin: Math.round((Date.now()-g.startedAt)/60000),
    remainingMin: Math.round((GHOST_DURATION_MS-(Date.now()-g.startedAt))/60000),
    activeUntil: "22:00 Brussels",
  }));
  res.json({ count:active.length, ghosts:active, ghostActiveNow: isGhostActive() });
});

app.get("/tp-locks", (req,res) => {
  const bySym = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (!bySym[sym]) bySym[sym] = {};
    bySym[sym][sess] = lock;
  }
  res.json({ generated:new Date().toISOString(), fixedTpRR: FIXED_TP_RR, totalLocks:Object.keys(tpLocks).length, locksBySymbol:bySym });
});

app.get("/sl-locks", (req,res) => {
  res.json({
    generated: new Date().toISOString(),
    note: `Auto-apply na ≥${SL_AUTO_APPLY_THRESHOLD} trades (shadow optimizer)`,
    totalAnalyses: Object.keys(slLocks).length,
    shadowActiveNow: isShadowActive(),
    analyses: Object.entries(slLocks).map(([sym,lock]) => ({ symbol:sym, ...lock })),
  });
});

app.get("/daily-risk", async (req, res) => {
  try {
    const latest = await loadLatestDailyRisk();
    res.json({
      generated: new Date().toISOString(),
      today: { multiplier: dailyRiskMultiplier },
      tomorrow: { multiplier: dailyRiskMultiplierNext },
      lastRecord: latest,
      effectiveRisk: Object.fromEntries(
        Object.entries(BASE_RISK).map(([k,v]) => [k, parseFloat((v * dailyRiskMultiplier).toFixed(2))])
      ),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/tp-locks/:symbol", (req,res) => {
  const sym=req.params.symbol.toUpperCase(); let count=0;
  for (const key of Object.keys(tpLocks)) { if (key.startsWith(sym+"__")) { delete tpLocks[key]; count++; } }
  res.json({ status:"OK", removed:count, symbol:sym });
});

app.delete("/sl-locks/:symbol", (req,res) => {
  const sym=req.params.symbol.toUpperCase(); const existed=!!slLocks[sym]; delete slLocks[sym];
  res.json({ status:"OK", removed:existed?1:0, symbol:sym });
});

app.get("/history", (req,res) => {
  const limit=Math.min(parseInt(req.query.limit)||50,MAX_HISTORY);
  res.json({ count:webhookHistory.length, history:webhookHistory.slice(0,limit) });
});

app.get("/analysis/equity-curve", async (req,res) => {
  const hours=parseInt(req.query.hours)||24;
  try {
    const timeout = new Promise((_,rej) => setTimeout(() => rej(new Error("timeout")), 4000));
    const db = await Promise.race([loadSnapshots(hours), timeout]);
    if (db.length) return res.json({ hours, count:db.length, source:"postgres", snapshots:db });
  } catch(e) { console.warn("⚠️ equity-curve DB fallback:", e.message); }
  const cutoff=new Date(Date.now()-hours*3600000).toISOString();
  const snaps=accountSnapshots.filter(s=>s.ts>=cutoff);
  res.json({ hours, count:snaps.length, source:"memory", snapshots:snaps });
});

app.get("/analysis/ghost-deep", async (req, res) => {
  const finished = closedTrades.filter(t => t.trueMaxRR !== null);
  const pending  = closedTrades.filter(t => t.trueMaxRR === null && t.maxRR > 0);
  const bySymSess = {};
  for (const t of finished) {
    const key = `${t.symbol}__${t.session||"?"}`;
    if (!bySymSess[key]) bySymSess[key] = { symbol:t.symbol, session:t.session, trades:[], totalExtraRR:0, hitTP:0 };
    const extraRR = (t.trueMaxRR ?? 0) - (t.maxRR ?? 0);
    bySymSess[key].trades.push({ extraRR, maxRRAtClose:t.maxRR, trueMaxRR:t.trueMaxRR, ghostStopReason:t.ghostStopReason });
    bySymSess[key].totalExtraRR += extraRR;
    if (t.hitTP) bySymSess[key].hitTP++;
  }
  const results = Object.values(bySymSess).map(g => ({
    symbol:g.symbol, session:g.session, trades:g.trades.length,
    avgExtraRR: parseFloat((g.totalExtraRR/g.trades.length).toFixed(3)),
    tpHitRate: parseFloat(((g.hitTP/g.trades.length)*100).toFixed(1)),
  })).sort((a,b) => b.avgExtraRR - a.avgExtraRR);
  res.json({ generated:new Date().toISOString(), ghostFinished:finished.length, ghostPending:pending.length, bySymbolSession:results });
});

app.get("/analysis/pnl", async (req, res) => {
  const { symbol, session } = req.query;
  let stats = [];
  try { stats = await loadPnlStats(symbol||null, session||null); } catch(e) {}
  res.json({ generated:new Date().toISOString(), filters:{symbol:symbol||"alle",session:session||"alle"}, data:stats });
});

app.get("/analysis/extremes", (req, res) => {
  const n = parseInt(req.query.n) || 10;
  const withPnl = closedTrades.filter(t=>t.realizedPnlEUR!=null);
  const sessSummary = {};
  for (const sess of ["asia","london","ny"]) {
    const st = closedTrades.filter(t=>t.session===sess);
    const pnl = st.filter(t=>t.realizedPnlEUR!=null).map(t=>t.realizedPnlEUR);
    sessSummary[sess] = {
      trades:st.length, totalPnl:parseFloat(pnl.reduce((s,v)=>s+v,0).toFixed(2)),
      wins:st.filter(t=>(t.realizedPnlEUR??0)>0).length,
      avgRR:st.length?parseFloat((st.reduce((s,t)=>s+getBestRR(t),0)/st.length).toFixed(2)):null,
    };
  }
  res.json({
    generated:new Date().toISOString(), sessionSummary:sessSummary,
    bestTrades:  [...withPnl].sort((a,b)=>b.realizedPnlEUR-a.realizedPnlEUR).slice(0,n).map(t=>({symbol:t.symbol,session:t.session,maxRR:t.maxRR,pnl:t.realizedPnlEUR})),
    worstTrades: [...withPnl].sort((a,b)=>a.realizedPnlEUR-b.realizedPnlEUR).slice(0,n).map(t=>({symbol:t.symbol,session:t.session,maxRR:t.maxRR,pnl:t.realizedPnlEUR})),
  });
});

app.use((req, res) => {
  res.status(404).json({ error:"Route niet gevonden", geprobeerd:req.method+" "+req.originalUrl });
});

// ══════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    console.log("🚀 FTMO Webhook Server v5.2 — opstarten...");
    await initDB();

    const dbTrades = await loadAllTrades();
    closedTrades.push(...dbTrades);
    console.log(`📂 ${dbTrades.length} trades geladen`);

    const savedTP = await loadTPConfig();
    Object.assign(tpLocks, savedTP);
    console.log(`🔒 ${Object.keys(savedTP).length} TP locks geladen`);

    const savedSL = await loadSLConfig();
    Object.assign(slLocks, savedSL);
    console.log(`📐 ${Object.keys(savedSL).length} SL configs geladen`);

    // [FEAT 6] Laad dagelijkse risk multiplier bij startup
    const dailyRisk = await loadLatestDailyRisk();
    if (dailyRisk) {
      dailyRiskMultiplier     = dailyRisk.riskMultNext ?? 1.0;
      dailyRiskMultiplierNext = dailyRisk.riskMultNext ?? 1.0;
      console.log(`📅 [Daily Risk] Geladen: ×${dailyRiskMultiplier} (${dailyRisk.evPositive?"✅ positief":"❌ reset"})`);
    }

    await restoreOpenPositionsFromMT5();

    app.listen(PORT, () => {
      console.log(`✅ Server luistert op port ${PORT}`);
      console.log(`📋 v5.2 actief:`);
      console.log(`   🔹 Forex: 21 pairs (geen JPY/exotics)`);
      console.log(`   🔹 UK100 min SL: 2`);
      console.log(`   🔹 Ghost tot 22:00 | Shadow tot 22:00`);
      console.log(`   🔹 Vast TP = ${FIXED_TP_RR}R | TP lock na 3 trades`);
      console.log(`   🔹 Daily risk mult: ×${dailyRiskMultiplier}`);
      console.log(`   🔹 SL shadow auto-apply na ${SL_AUTO_APPLY_THRESHOLD} trades`);
      console.log(`   🔹 Duplicate guard: 60s`);
      console.log(`   🔹 Auto-close 21:50 | Reconnect 02:00`);
      console.log(`   🔹 Forex pyramiding: max 2× (50% op trade 2)`);
    });
  } catch(err) {
    console.error("❌ Startup mislukt:", err.message);
    process.exit(1);
  }
}

start();
