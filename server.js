// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v7.0
// Account : Nick Verschoot — FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ───────────────────────────────────────────────────────────────
// WIJZIGINGEN v7.0 (t.o.v. v5.2):
//  ✅ [1]  Ghost Tracker volledige herschrijving:
//          - ghost_mae, ghost_hit_sl, ghost_time_to_sl
//          - phantom_sl trigger (originele SL floor)
//          - trueMaxRR gemeten van ENTRY baseline
//          - maxRRAtClose bevroren bij sluiting, nooit gemuteerd
//          - ghostExtraRR = trueMaxRR − maxRRAtClose
//          - close_reason: tp / sl / manual / auto / unknown
//          - is_manual vlag voor /close endpoint
//          - ghost_stop_reason: phantom_sl / auto_close_window /
//            timeout / restart_lost / failsafe
//  ✅ [2]  Symbol map fixes: NL25EUR, AU200AUD aliases, NKE (geen NIKE)
//  ✅ [3]  'all' sessie volledig verwijderd uit tpLocks + DB
//  ✅ [4]  getBrusselsDateOnly() overal i.p.v. .toISOString().split("T")[0]
//  ✅ [5]  GBPUSD SL recalc op startup voor alle symbolen ≥ 30 trades
//  ✅ [6]  calcLots double multiplier fix — effectiveCap gebruikt baseRisk
//  ✅ [7]  TP Lock risk boost: ×4 + ×1.2 per consecutive positive dag
//          consecutivePositiveDays bijgehouden per symbol+session
//  ✅ [8]  Ghost triggert altijd: tp / sl / manual / auto
//  ✅ [10] SL Shadow Optimizer (symbol-level, ghost-finalized trades)
//  ✅ [24] Dashboard: Daily Risk panel
//  ✅ [25] Dashboard: Last Cron Runs sectie
//  ✅ [26] Forex tweede trade: 50% risk, EV-conditioneel
//  ✅ [33] Nieuwe symbolen: BRK.B, ARM, NL25EUR, TL0 (TSLA alias)
//  ✅ [34] Symbol validation: onbekend symbool → SKIP met reden
//  ✅ [EOD] 21:00 ghost cron voor trades gesloten laatste 20 min
//  ✅ Orphan repair op startup: restart_lost voor null trueMaxRR
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
  saveShadowSLAnalysis, loadShadowSLAnalysis, logShadowSLChange,
} = require("./db");

const {
  getBrusselsComponents,
  getBrusselsDateStr,
  getBrusselsDateOnly,   // [v7.0] vervangt .toISOString().split("T")[0]
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

const SL_AUTO_APPLY_THRESHOLD = 30;
const SHADOW_SL_MIN_TRADES    = 30;

const FIXED_TP_RR = 4;

const STOCK_SL_SPREAD_MULT      = 1.5;
const STOCK_MAX_SPREAD_FRACTION = 0.333;

// [v5.2] Forex pyramiding: max 2×
const FOREX_MAX_SAME_DIR        = 2;
const FOREX_HALF_RISK_THRESHOLD = 1;

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

// [v5.2/v7.0] Daily risk multiplier
let dailyRiskMultiplier     = 1.0;
let dailyRiskMultiplierNext = 1.0;

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
const shadowSLResults  = {}; // [v7.0] symbol → shadow optimizer result
const tpUpdateLog      = [];
const slUpdateLog      = [];

// [v7.0] Track consecutive positive EV days per symbol+session for TP boost
const consecutivePositiveDays = {}; // key: "SYMBOL__SESSION" → integer

// [v5.2] Duplicate entry guard
const recentOrderGuard = new Map();
const DUPLICATE_GUARD_MS = 60 * 1000;

// [v7.0] Track last cron fire times for dashboard
const cronLastRun = {
  "AUTOCLOSE_2150":   null,
  "DAY_END_22:00":    null,
  "RECONNECT_02:00":  null,
  "NIGHTLY_OPTIMIZER":null,
  "EOD_GHOST_21:00":  null,
};

const MAX_SNAPSHOTS = 86400;
const MAX_HISTORY   = 200;
const MAX_TP_LOG    = 100;
const MAX_SL_LOG    = 100;

const TRADING_SESSIONS = ["asia", "london", "ny"]; // [v7.0] never 'all'

function addWebhookHistory(entry) {
  webhookHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.length = MAX_HISTORY;
  // Update cron tracker
  if (entry.type && cronLastRun.hasOwnProperty(entry.type)) {
    cronLastRun[entry.type] = entry.ts || new Date().toISOString();
  }
}

const learnedPatches = {};

// ══════════════════════════════════════════════════════════════
// SYMBOL MAP v7.0
// Changes: NL25EUR added, AU200AUD alias confirmed, SPX500USD confirmed,
//          UK100GBP confirmed, NIKE removed → NKE only,
//          BRK.B, ARM, TL0 added
// ══════════════════════════════════════════════════════════════
const SYMBOL_MAP = {
  // ── Indices ──────────────────────────────────────────────
  "DE30EUR":     { mt5: "GER40.cash",  type: "index" },
  "UK100GBP":    { mt5: "UK100.cash",  type: "index" },
  "NAS100USD":   { mt5: "US100.cash",  type: "index" },
  "US30USD":     { mt5: "US30.cash",   type: "index" },
  "SPX500USD":   { mt5: "US500.cash",  type: "index" },
  "JP225USD":    { mt5: "JP225.cash",  type: "index" },
  "AU200AUD":    { mt5: "AUS200.cash", type: "index" }, // TV alias confirmed
  "EU50EUR":     { mt5: "EU50.cash",   type: "index" },
  "FR40EUR":     { mt5: "FRA40.cash",  type: "index" },
  "HK33HKD":     { mt5: "HK50.cash",   type: "index" },
  "US2000USD":   { mt5: "US2000.cash", type: "index" },
  // [v7.0] NL25EUR → N.25.cash
  "NL25EUR":     { mt5: "N.25.cash",   type: "index" },
  // Aliases
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
  "N.25.cash":   { mt5: "N.25.cash",   type: "index" },
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
  "APC":   { mt5: "AAPL",  type: "stock" },  // TradingView alias
  "TSLA":  { mt5: "TSLA",  type: "stock" },
  "TLO":   { mt5: "TSLA",  type: "stock" },  // TradingView alias
  "TL0":   { mt5: "TSLA",  type: "stock" },  // [v7.0] TradingView alias (zero not O)
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
  // [v7.0] NIKE verwijderd — alleen NKE
  "NKE":   { mt5: "NKE",   type: "stock" },
  "PFE":   { mt5: "PFE",   type: "stock" },
  "QCOM":  { mt5: "QCOM",  type: "stock" },
  "RACE":  { mt5: "RACE",  type: "stock" },
  "SBUX":  { mt5: "SBUX",  type: "stock" },
  "SNOW":  { mt5: "SNOW",  type: "stock" },
  "T":     { mt5: "T",     type: "stock" },
  "WMT":   { mt5: "WMT",   type: "stock" },
  "XOM":   { mt5: "XOM",   type: "stock" },
  "ZM":    { mt5: "ZM",    type: "stock" },
  // [v7.0] Nieuw
  "BRK.B": { mt5: "BRK.B", type: "stock" },
  "ARM":   { mt5: "ARM",   type: "stock" },
  // ── Forex — major/minor pairs (geen JPY, geen exotics) ───
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
  "EURNZD": { mt5: "EURNZD", type: "forex" },
  "GBPCHF": { mt5: "GBPCHF", type: "forex" },
  "GBPAUD": { mt5: "GBPAUD", type: "forex" },
  "GBPCAD": { mt5: "GBPCAD", type: "forex" },
  "GBPNZD": { mt5: "GBPNZD", type: "forex" },
  "AUDCAD": { mt5: "AUDCAD", type: "forex" },
  "AUDCHF": { mt5: "AUDCHF", type: "forex" },
  "AUDNZD": { mt5: "AUDNZD", type: "forex" },
  "CADCHF": { mt5: "CADCHF", type: "forex" },
  "NZDCAD": { mt5: "NZDCAD", type: "forex" },
  "NZDCHF": { mt5: "NZDCHF", type: "forex" },
};

// [v7.0] Normalize symbol — treat NIKE as NKE for legacy data
function normalizeSymbol(sym) {
  if (sym === "NIKE") return "NKE";
  return sym;
}

// ── LOT / STOP CONFIG ─────────────────────────────────────────
const LOT_VALUE = { index:20, gold:100, brent:10, wti:10, crypto:1, stock:1, forex:10 };
const MAX_LOTS  = { index:10, gold:1,   brent:5,  wti:5,  crypto:1, stock:50, forex:0.25 };

const MIN_STOP_INDEX = {
  "GER40.cash":  10,
  "UK100.cash":  2,
  "US100.cash":  10,
  "US30.cash":   10,
  "US500.cash":  5,
  "JP225.cash":  10,
  "AUS200.cash": 5,
  "EU50.cash":   5,
  "FRA40.cash":  5,
  "HK50.cash":   10,
  "US2000.cash": 5,
  "N.25.cash":   5,   // [v7.0]
};
const MIN_STOP_COMMODITY = {
  "XAUUSD":0.0, "UKOIL.cash":0.05, "USOIL.cash":0.05, "BTCUSD":100.0, "ETHUSD":5.0,
};
const MIN_STOP_FOREX = {
  "EURUSD":0.0005, "GBPUSD":0.0005, "AUDUSD":0.0005, "NZDUSD":0.0005,
  "USDCHF":0.0005, "USDCAD":0.0005,
  "EURGBP":0.0005, "EURAUD":0.0005, "EURCAD":0.0005, "EURCHF":0.0005,
  "EURNZD":0.0005,
  "GBPAUD":0.0005, "GBPCAD":0.0005, "GBPCHF":0.0005,
  "GBPNZD":0.0005,
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
  const ns = normalizeSymbol(sym);
  if (SYMBOL_MAP[ns]) return SYMBOL_MAP[ns].type;
  if (["BTC","ETH"].some(c => ns.startsWith(c))) return "crypto";
  // [v7.0] Do NOT silently fall back — return null for unknown symbols
  return null;
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

// ══════════════════════════════════════════════════════════════
// CRON JOBS
// ══════════════════════════════════════════════════════════════

// ── AUTO-CLOSE 21:50 Brussels ─────────────────────────────────
cron.schedule("50 21 * * 1-5", async () => {
  const { day } = getBrusselsComponents();
  const isWE = day === 0 || day === 6;
  console.log("🔔 21:50 Brussels — auto-close gestart...");
  cronLastRun["AUTOCLOSE_2150"] = new Date().toISOString();
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
          // [v7.0] close_reason = 'auto' voor syncPositions om op te pikken
          if (openPositions[String(pos.id)]) {
            openPositions[String(pos.id)]._pendingCloseReason = "auto";
          }
          addWebhookHistory({ type:"AUTOCLOSE_2150", symbol:pos.symbol, positionId:pos.id });
        } catch(e) { console.error(`❌ Auto-close ${pos.symbol}:`, e.message); }
      }
    }
    // [v7.0] Brussels-correcte datum
    await evaluateDailyRisk();
  } catch(e) { console.error("❌ Auto-close fout:", e.message); }
}, { timezone: "Europe/Brussels" });

// ── [v7.0] EOD GHOST 21:00 — trades gesloten laatste 20 min ──
cron.schedule("0 21 * * 1-5", async () => {
  console.log("👻 21:00 Brussels — EOD ghost check (trades laatste 20min)...");
  cronLastRun["EOD_GHOST_21:00"] = new Date().toISOString();
  const cutoff = Date.now() - 20 * 60 * 1000;
  const recent = closedTrades.filter(t =>
    t.closedAt && new Date(t.closedAt).getTime() >= cutoff && t.trueMaxRR === null
  );
  for (const trade of recent) {
    // Check of er al een ghost loopt voor deze trade
    const alreadyRunning = Object.values(ghostTrackers).some(g => g.trade.id === trade.id);
    if (!alreadyRunning) {
      console.log(`👻 [EOD] Ghost start voor ${trade.symbol} (gesloten ${trade.closedAt})`);
      startGhostTracker(trade);
    }
  }
  addWebhookHistory({ type:"EOD_GHOST_21:00", ghostsStarted: recent.length });
}, { timezone: "Europe/Brussels" });

// ── GHOST + SHADOW HARD STOP 22:00 ────────────────────────────
cron.schedule("0 22 * * 1-5", async () => {
  console.log("🌙 22:00 Brussels — ghost & shadow hard stop...");
  cronLastRun["DAY_END_22:00"] = new Date().toISOString();

  let ghostCount = 0;
  for (const [ghostId, g] of Object.entries(ghostTrackers)) {
    finaliseGhost(ghostId, g.trade, g.bestPrice, "auto_close_window", g.startedAt);
    ghostCount++;
  }
  console.log(`👻 ${ghostCount} ghost(s) gestopt om 22:00`);

  // Run shadow optimizer after ghost finalize
  await runShadowSLOptimizerAll();

  const todayStr = getBrusselsDateOnly();
  const todayTrades = closedTrades.filter(t => {
    if (!t.closedAt) return false;
    return getBrusselsDateOnly(t.closedAt) === todayStr;
  });
  console.log(`📊 Sessie data: ${todayTrades.length} trades vandaag`);
  addWebhookHistory({ type:"DAY_END_22:00", ghostsStopped: ghostCount, todayTrades: todayTrades.length });
}, { timezone: "Europe/Brussels" });

// ── RECONNECT 02:00 Brussels ──────────────────────────────────
cron.schedule("0 2 * * *", async () => {
  console.log("🔄 02:00 Brussels — dagelijkse reconnect...");
  cronLastRun["RECONNECT_02:00"] = new Date().toISOString();

  // [v7.0] Apply multiplier — no cap, let it compound
  dailyRiskMultiplier = dailyRiskMultiplierNext;
  console.log(`💰 [Risk] Multiplier voor vandaag: ×${dailyRiskMultiplier.toFixed(2)}`);

  // Update consecutive positive days per symbol+session
  await updateConsecutivePositiveDays();

  await restoreOpenPositionsFromMT5();
  recentOrderGuard.clear();
  addWebhookHistory({ type:"RECONNECT_02:00", riskMultiplier: dailyRiskMultiplier });
}, { timezone: "Europe/Brussels" });

// ── NIGHTLY OPTIMIZER 03:00 Brussels ─────────────────────────
cron.schedule("0 3 * * *", async () => {
  console.log("🌙 03:00 Brussels — nightly optimizer...");
  cronLastRun["NIGHTLY_OPTIMIZER"] = new Date().toISOString();
  const symbols = [...new Set(closedTrades.map(t => t.symbol).filter(Boolean))];
  for (const sym of symbols) {
    await runTPLockEngine(sym).catch(e => console.error(`❌ [TP nightly] ${sym}:`, e.message));
    await runSLLockEngine(sym).catch(e => console.error(`❌ [SL nightly] ${sym}:`, e.message));
  }
  await runShadowSLOptimizerAll();
  console.log(`✅ Nightly optimizer klaar — ${symbols.length} symbolen`);
  addWebhookHistory({ type:"NIGHTLY_OPTIMIZER", symbols: symbols.length });
}, { timezone: "Europe/Brussels" });

// ══════════════════════════════════════════════════════════════
// DAILY RISK SCALING — [v7.0] getBrusselsDateOnly + no cap
// ══════════════════════════════════════════════════════════════
async function evaluateDailyRisk() {
  try {
    const todayStr = getBrusselsDateOnly(); // [v7.0] Brussels-correcte datum

    const todayTrades = closedTrades.filter(t => {
      if (!t.closedAt) return false;
      return getBrusselsDateOnly(t.closedAt) === todayStr; // [v7.0]
    });

    const totalPnl = todayTrades.reduce((sum, t) => sum + (t.realizedPnlEUR ?? 0), 0);
    const evPositive = totalPnl > 0;

    // [v7.0] No cap — let it compound indefinitely (spec item 7)
    dailyRiskMultiplierNext = evPositive
      ? parseFloat((dailyRiskMultiplier * 1.2).toFixed(4))
      : 1.0;

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

// [v7.0] Update consecutive positive EV days per symbol+session
async function updateConsecutivePositiveDays() {
  // For each symbol+session combo in tpLocks, check yesterday's EV
  const yesterday = getBrusselsDateOnly(new Date(Date.now() - 86400000));
  for (const [lockKey, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = lockKey.split("__");
    const yesterdayTrades = closedTrades.filter(t =>
      t.symbol === sym &&
      (t.session === sess || sess === "all") &&
      t.closedAt &&
      getBrusselsDateOnly(t.closedAt) === yesterday
    );
    if (!yesterdayTrades.length) continue;
    const rrArr = yesterdayTrades.map(t => t.trueMaxRR ?? t.maxRR ?? 0);
    const bestRR = RR_LEVELS.reduce((best, rr) => {
      const wins = rrArr.filter(r => r >= rr).length;
      const wr   = wins / rrArr.length;
      const ev   = wr * rr - (1 - wr);
      return ev > best.ev ? { rr, ev } : best;
    }, { rr: 0, ev: -Infinity });

    if (bestRR.ev > 0) {
      consecutivePositiveDays[lockKey] = (consecutivePositiveDays[lockKey] || 0) + 1;
    } else {
      consecutivePositiveDays[lockKey] = 0;
    }
    console.log(`📈 [Consecutive] ${lockKey}: ${consecutivePositiveDays[lockKey]} positive days`);
  }
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
        lots: pos.volume ?? 0.01, riskEUR: getRisk(getSymbolType(tvSym) || "stock"),
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

// ── [v7.0] ORPHAN REPAIR ─────────────────────────────────────
// Trades met trueMaxRR=null en maxRR>0 na restart → restart_lost
async function repairOrphanedGhosts() {
  let repaired = 0;
  for (const trade of closedTrades) {
    if (trade.trueMaxRR === null || trade.trueMaxRR === undefined) {
      if ((trade.maxRR ?? 0) > 0) {
        trade.trueMaxRR       = trade.maxRR; // conservative: maxRRAtClose
        trade.ghostStopReason = "restart_lost";
        trade.ghostFinalizedAt = new Date().toISOString();
        saveTrade(trade).catch(e => console.error(`❌ [Orphan] saveTrade:`, e.message));
        repaired++;
      }
    }
  }
  if (repaired > 0) {
    console.log(`🔧 [Orphan Repair] ${repaired} trades gerepareerd (restart_lost)`);
  }
}

// ── [v5.2] FOREX ANTI-CONSOLIDATIE ───────────────────────────
function checkForexConsolidation(symbol, direction) {
  const mt5Sym = getMT5Symbol(symbol);
  let count = 0;
  for (const pos of Object.values(openPositions)) {
    if (pos.restoredAfterRestart) continue;
    const posMt5 = getMT5Symbol(pos.symbol) || pos.mt5Symbol;
    if ((posMt5 === mt5Sym || pos.symbol === symbol) && pos.direction === direction) count++;
  }
  return {
    blocked:  count >= FOREX_MAX_SAME_DIR,
    halfRisk: count >= FOREX_HALF_RISK_THRESHOLD && count < FOREX_MAX_SAME_DIR,
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

// ── [v5.2] DUPLICATE ENTRY GUARD ─────────────────────────────
function isDuplicateOrder(symbol, direction) {
  const key = `${symbol}_${direction}`;
  const last = recentOrderGuard.get(key);
  if (!last) return false;
  return (Date.now() - last) < DUPLICATE_GUARD_MS;
}

function registerRecentOrder(symbol, direction) {
  const key = `${symbol}_${direction}`;
  recentOrderGuard.set(key, Date.now());
  setTimeout(() => recentOrderGuard.delete(key), DUPLICATE_GUARD_MS * 2);
}

// ── HELPERS ───────────────────────────────────────────────────
function getEffectiveRisk(symbol, direction) {
  const key     = `${symbol}_${direction}`;
  const count   = openTradeTracker[key] || 0;
  const type    = getSymbolType(symbol) || "stock";
  const base    = BASE_RISK[type] || 30;  // raw base, before multiplier
  const baseWithMult = base * dailyRiskMultiplier;

  let risk = Math.max(baseWithMult * 0.10, baseWithMult / Math.pow(2, count));

  const curSess = getSessionGMT1();
  const lockKey = `${symbol}__${curSess}`;
  const lock    = tpLocks[lockKey];

  if (lock && (lock.evAtLock ?? 0) > 0 && count === 0) {
    // [v7.0] TP Lock boost: ×4 × 1.2^consecutivePositiveDays
    const positiveDays = consecutivePositiveDays[lockKey] || 0;
    const compoundBoost = Math.pow(1.2, positiveDays);
    risk = base * TP_LOCK_RISK_MULT * compoundBoost * dailyRiskMultiplier;
    console.log(
      `💥 [TP Lock] Risk boost ${symbol}/${curSess}: ` +
      `€${risk.toFixed(2)} (×${TP_LOCK_RISK_MULT} × 1.2^${positiveDays} × mult${dailyRiskMultiplier})`
    );
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

// [v7.0] FIX: calcLots double multiplier fix
// effectiveCap gebruikt BASE_RISK (vóór dailyRiskMultiplier)
// want de `risk` parameter bevat de multiplier al
function calcLots(symbol, entry, sl, risk) {
  const type    = getSymbolType(symbol) || "stock";
  const lotVal  = LOT_VALUE[type] || 1;
  const maxLots = MAX_LOTS[type]  || 50;
  const lotStep = learnedPatches[symbol]?.lotStepOverride || (type==="stock" ? 1 : 0.01);
  const dist    = Math.abs(entry - sl);
  if (dist <= 0) return lotStep;

  let lots = Math.floor((risk / (dist * lotVal)) / lotStep) * lotStep;
  lots = Math.min(lots, maxLots);
  lots = Math.max(lots, lotStep);

  // [v7.0] Cap uses BASE_RISK (raw, no multiplier) — risk param already contains multiplier
  const baseRisk     = BASE_RISK[type] || 30;
  const isTPLockRisk = risk >= baseRisk * TP_LOCK_RISK_MULT;
  // Cap = base×4 if TP lock boosted, else base (both WITHOUT multiplier — multiplier is in risk)
  const effectiveCap = isTPLockRisk ? baseRisk * TP_LOCK_RISK_MULT : baseRisk;
  const minCost      = lots * dist * lotVal;

  if (minCost > effectiveCap * dailyRiskMultiplier * 1.5) {
    // Allow up to 1.5× cap with multiplier before blocking (avoids blocking valid boosted trades)
    console.warn(`⚠️ Min lot kost €${minCost.toFixed(2)} > cap → skip`);
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
  // [v7.0] Measured from ENTRY baseline, not close price
  const fav = trade.direction==="buy" ? price-trade.entry : trade.entry-price;
  return parseFloat((Math.max(0, fav) / d).toFixed(2));
}

// [v7.0] ghost_mae: Maximum Adverse Excursion in R during ghost window
// = how far price moved AGAINST the trade direction from entry
function calcMAE(trade, worstPrice) {
  const d = Math.abs(trade.entry - trade.sl);
  if (!d || worstPrice == null) return 0;
  // Against trade = buy → price below entry; sell → price above entry
  const adverse = trade.direction === "buy"
    ? trade.entry - worstPrice   // positive = moved against
    : worstPrice - trade.entry;
  return parseFloat((Math.max(0, adverse) / d).toFixed(3));
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
// GHOST TRACKER v7.0 — Complete rewrite
//
// Elke trade-close spawnt een ghost (tp / sl / manual / auto).
// Ghost meet:
//   - trueMaxRR      van ENTRY baseline (niet close price)
//   - maxRRAtClose   bevroren bij spawn (nooit gemuteerd)
//   - ghostExtraRR   = trueMaxRR − maxRRAtClose
//   - ghost_mae      = max adverse excursion in R
//   - ghost_hit_sl   = bereikte prijs originele SL?
//   - ghost_time_to_sl = minuten tot phantom_sl hit
//
// Stop condities (prioriteit):
//   1. phantom_sl    — prijs raakt originele SL
//   2. 22:00 Brussels hard stop
//   3. 24h timeout
//   4. server restart → restart_lost (orphan repair)
// ══════════════════════════════════════════════════════════════
// Ghost runs IDENTICALLY for every close reason: tp / sl / manual / auto
// is_manual is metadata only — no behaviour difference whatsoever
// Manual ghost trades count for ALL optimizers exactly like any other trade
function startGhostTracker(closedTrade, isManual = false) {
  const ghostId      = `ghost_${closedTrade.id}_${Date.now()}`;
  const startedAt    = Date.now();
  // trueMaxRR measured from ENTRY baseline (not close price)
  const maxRRAtClose = closedTrade.maxRR ?? 0;
  let bestPrice      = closedTrade.maxPrice ?? closedTrade.entry;
  let worstPrice     = closedTrade.entry; // for ghost_mae
  let currentTimer   = null;

  console.log(
    `👻 Ghost gestart: ${closedTrade.symbol} | ` +
    `closeReason=${closedTrade.closeReason ?? "unknown"} | ` +
    `maxRRAtClose=${maxRRAtClose}R | is_manual=${isManual} (metadata only)`
  );

  async function tick() {
    try {
      const elapsed    = Date.now() - startedAt;
      const ghostOk    = isGhostActive();
      const shouldStop = elapsed >= GHOST_DURATION_MS || !ghostOk;

      const priceData  = await fetchCurrentPrice(closedTrade.mt5Symbol);
      const price      = priceData?.mid ?? null;

      if (price !== null) {
        // Track best price (for trueMaxRR from entry)
        const betterForTrade = closedTrade.direction === "buy"
          ? price > bestPrice
          : price < bestPrice;
        if (betterForTrade) bestPrice = price;

        // Track worst price (for ghost_mae)
        const worseForTrade = closedTrade.direction === "buy"
          ? price < worstPrice
          : price > worstPrice;
        if (worseForTrade) worstPrice = price;

        if (ghostTrackers[ghostId]) {
          ghostTrackers[ghostId].bestPrice  = bestPrice;
          ghostTrackers[ghostId].worstPrice = worstPrice;
        }

        // [v7.0] phantom_sl — prijs raakt de originele SL (floor)
        const slBreach = closedTrade.direction === "buy"
          ? price <= closedTrade.sl
          : price >= closedTrade.sl;

        if (slBreach) {
          const minutesElapsed = Math.round(elapsed / 60000);
          console.log(`💀 [Ghost] phantom_sl trigger: ${closedTrade.symbol} na ${minutesElapsed}min`);
          finaliseGhost(ghostId, closedTrade, bestPrice, worstPrice, "phantom_sl", startedAt, minutesElapsed);
          return;
        }
      }

      if (shouldStop) {
        const reason = elapsed >= GHOST_DURATION_MS ? "timeout" : "auto_close_window";
        finaliseGhost(ghostId, closedTrade, bestPrice, worstPrice, reason, startedAt, null);
        return;
      }

      const interval = elapsed < GHOST_OLD_THRESHOLD_MS ? GHOST_INTERVAL_RECENT_MS : GHOST_INTERVAL_OLD_MS;
      currentTimer = setTimeout(tick, interval);
      if (ghostTrackers[ghostId]) ghostTrackers[ghostId].timer = currentTimer;
    } catch(e) { console.warn(`⚠️ Ghost ${ghostId}:`, e.message); }
  }

  currentTimer = setTimeout(tick, GHOST_INTERVAL_RECENT_MS);
  ghostTrackers[ghostId] = {
    trade: closedTrade, timer: currentTimer, startedAt,
    bestPrice, worstPrice, isManual,
  };

  // Failsafe
  setTimeout(() => {
    if (ghostTrackers[ghostId]) {
      const g = ghostTrackers[ghostId];
      finaliseGhost(ghostId, closedTrade, g.bestPrice, g.worstPrice, "failsafe", startedAt, null);
    }
  }, GHOST_DURATION_MS + 5 * 60 * 1000);
}

function finaliseGhost(ghostId, trade, bestPrice, worstPrice, reason, startedAt, timeToSL = null) {
  if (!ghostTrackers[ghostId]) return;
  clearTimeout(ghostTrackers[ghostId].timer);
  const isManual = ghostTrackers[ghostId].isManual ?? false;
  delete ghostTrackers[ghostId];

  // [v7.0] trueMaxRR from ENTRY baseline
  const trueMaxRR    = calcMaxRRFromPrice(trade, bestPrice);
  const maxRRAtClose = trade.maxRR ?? 0; // frozen at close, never mutated
  const ghostExtraRR = parseFloat((trueMaxRR - maxRRAtClose).toFixed(3));

  // [v7.0] ghost_mae in R
  const ghostMAE = calcMAE(trade, worstPrice);
  // ghost_hit_sl: ghost_mae >= 1.0 means SL would have been hit
  const ghostHitSL   = reason === "phantom_sl" || ghostMAE >= 1.0;

  const ghostDurationMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : null;

  const idx = closedTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    closedTrades[idx].trueMaxRR        = trueMaxRR;
    closedTrades[idx].trueMaxPrice     = bestPrice;
    closedTrades[idx].ghostStopReason  = reason;
    closedTrades[idx].ghostFinalizedAt = new Date().toISOString();

    saveTrade(closedTrades[idx]).catch(e => console.error(`❌ [DB] ghost saveTrade:`, e.message));

    saveGhostAnalysis({
      symbol:           trade.symbol,
      session:          trade.session,
      direction:        trade.direction,
      entry:            trade.entry,
      sl:               trade.sl,
      tp:               trade.tp,
      maxRRAtClose,
      trueMaxRR,
      ghostExtraRR,
      hitTP:            trade.hitTP ?? false,
      ghostStopReason:  reason,
      ghostDurationMin,
      ghostFinalizedAt: new Date().toISOString(),
      closedAt:         trade.closedAt,
      realizedPnlEUR:   trade.realizedPnlEUR ?? null,
      tradePositionId:  trade.id,
      // [v7.0] nieuwe velden
      ghostHitSL,
      ghostMAE,
      ghostTimeToSL:    timeToSL ?? null,
      isManual,
      closeReason:      trade.closeReason ?? "unknown",
    }).catch(e => console.error(`❌ [DB] ghost analyse:`, e.message));

    console.log(
      `✅ Ghost ${trade.symbol} → trueMaxRR: ${trueMaxRR}R | ` +
      `extra: +${ghostExtraRR}R | MAE: ${ghostMAE}R | hitSL: ${ghostHitSL} | ${reason}`
    );
    runTPLockEngine(trade.symbol).catch(e => console.error(`❌ [TP Lock]:`, e.message));
    runSLLockEngine(trade.symbol).catch(e => console.error(`❌ [SL Lock]:`, e.message));

    // [v7.0] Run shadow optimizer if enough new ghost trades
    const ghostFinished = closedTrades.filter(t =>
      t.symbol === trade.symbol && t.trueMaxRR !== null
    ).length;
    if (ghostFinished >= SHADOW_SL_MIN_TRADES) {
      runShadowSLOptimizer(trade.symbol).catch(e =>
        console.error(`❌ [Shadow SL]:`, e.message)
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════
// TP LOCK ENGINE v7.0
// [v7.0] Only sessions: asia / london / ny (never 'all')
// [v7.0] TP risk boost: ×4 × 1.2^consecutivePositiveDays
// ══════════════════════════════════════════════════════════════
async function runTPLockEngine(symbol) {
  for (const session of TRADING_SESSIONS) {
    await _runTPLockForSession(symbol, session).catch(e =>
      console.error(`❌ [TP Lock] ${symbol}/${session}:`, e.message)
    );
  }
}

async function _runTPLockForSession(symbol, session) {
  if (!session || session === "all") return; // [v7.0] guard

  const trades = closedTrades.filter(t =>
    normalizeSymbol(t.symbol) === normalizeSymbol(symbol) &&
    t.sl && t.entry && t.session === session
  );
  const n       = trades.length;
  const lockKey = `${symbol}__${session}`;

  if (n < 3) return;

  const existing = tpLocks[lockKey];

  const evTable = RR_LEVELS.map(rr => {
    const wins = trades.filter(t => getBestRR(t) >= rr).length;
    const wr   = wins / n;
    return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)) };
  });
  const best       = evTable.reduce((a,b) => b.ev > a.ev ? b : a);
  const evPositive = best.ev > 0;

  const effectiveRR = evPositive ? best.rr : FIXED_TP_RR;

  const oldRR       = existing?.lockedRR ?? null;
  const isNew       = !existing;
  const changed     = existing && existing.lockedRR !== effectiveRR;
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

  // [v7.0] Remove any stale 'all' session entry for this symbol
  delete tpLocks[`${symbol}__all`];

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
// SL LOCK ENGINE v7.0
// ══════════════════════════════════════════════════════════════
async function runSLLockEngine(symbol) {
  if (!isShadowActive()) {
    console.log(`⏸️ [SL Shadow] ${symbol}: shadow optimizer gestopt (na 22:00)`);
    return;
  }

  const trades = closedTrades.filter(t =>
    normalizeSymbol(t.symbol) === normalizeSymbol(symbol) && t.sl && t.entry
  );
  const n      = trades.length;
  if (n < 10) return;

  const existing = slLocks[symbol];
  if (existing && (n - (existing.lockedTrades ?? 0)) < 5) return;

  const analysis  = buildSLAnalysis(trades);
  const best      = analysis.reduce((a,b) => b.bestEV > a.bestEV ? b : a);
  const direction = getSLDirection(analysis);

  if (best.bestEV <= 0) return;

  const oldMult   = existing?.multiplier ?? null;
  const isNew     = !existing;
  const changed   = existing && (existing.multiplier !== best.slMultiple || existing.direction !== direction);
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

  console.log(`📐 [SL ${autoApply?"AUTO":"ADVIES"}] ${symbol}: ${best.slMultiple}× (${direction}) EV +${best.bestEV}R | ${n} trades`);
}

// ══════════════════════════════════════════════════════════════
// SL SHADOW OPTIMIZER v7.0 (item 10)
// Uses ONLY ghost-finalized trades (trueMaxRR not null)
// Per symbol (not per session)
// ══════════════════════════════════════════════════════════════
async function runShadowSLOptimizer(symbol) {
  const trades = closedTrades.filter(t =>
    normalizeSymbol(t.symbol) === normalizeSymbol(symbol) &&
    t.trueMaxRR !== null && t.sl && t.entry
  );
  if (trades.length < SHADOW_SL_MIN_TRADES) return;

  const results = SL_MULTIPLES.map(mult => {
    const evTable = RR_LEVELS.map(rr => {
      const wins = trades.filter(t => {
        const origDist = Math.abs(t.entry - t.sl);
        if (!origDist) return false;
        const adjustedRR = (t.trueMaxRR ?? 0) / mult;
        return adjustedRR >= rr;
      }).length;
      const wr = wins / trades.length;
      return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)), winrate: parseFloat((wr * 100).toFixed(1)) };
    });
    const best = evTable.reduce((a, b) => b.ev > a.ev ? b : a);

    // slHitRate: simulated SL hit = ghost_mae >= mult
    const slHits = trades.filter(t => (t.ghostMAE ?? calcMAE(t, t.trueMaxPrice)) >= mult).length;
    const slHitRate = parseFloat(((slHits / trades.length) * 100).toFixed(1));

    return {
      slMultiplier: mult,
      bestEV:       best.ev,
      bestRR:       best.rr,
      bestWinrate:  best.winrate,
      slHitRate,
      evTable,
    };
  });

  const bestResult = results.reduce((a, b) => b.bestEV > a.bestEV ? b : a);
  const previous   = shadowSLResults[symbol];

  shadowSLResults[symbol] = {
    symbol,
    best:        bestResult,
    allMultiples: results,
    tradesUsed:  trades.length,
    computedAt:  new Date().toISOString(),
  };

  // Persist
  await saveShadowSLAnalysis(
    symbol,
    bestResult.slMultiplier,
    bestResult.bestEV,
    bestResult.bestRR,
    bestResult.bestWinrate,
    bestResult.slHitRate,
    trades.length
  ).catch(e => console.error(`❌ [Shadow SL] save:`, e.message));

  if (previous && previous.best.slMultiplier !== bestResult.slMultiplier) {
    await logShadowSLChange(
      symbol,
      previous.best.slMultiplier,
      bestResult.slMultiplier,
      previous.best.bestEV,
      bestResult.bestEV,
      trades.length,
      `shadow optimizer recompute: ${trades.length} ghost trades`
    ).catch(() => {});
  }

  console.log(
    `🌑 [Shadow SL] ${symbol}: best mult=${bestResult.slMultiplier}× | ` +
    `EV=${bestResult.bestEV} | RR=${bestResult.bestRR}R | SL hit=${bestResult.slHitRate}% | ` +
    `trades=${trades.length}`
  );
}

async function runShadowSLOptimizerAll() {
  const symbols = [...new Set(
    closedTrades
      .filter(t => t.trueMaxRR !== null)
      .map(t => normalizeSymbol(t.symbol))
  )];
  for (const sym of symbols) {
    await runShadowSLOptimizer(sym).catch(e =>
      console.error(`❌ [Shadow SL all] ${sym}:`, e.message)
    );
  }
  console.log(`🌑 [Shadow SL] All symbols done: ${symbols.length}`);
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
      const lotV = LOT_VALUE[getSymbolType(trade.symbol) || "stock"] || 1;
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

        // [v7.0] Determine close_reason
        let closeReason = trade._pendingCloseReason ?? "unknown";
        if (closeReason === "unknown") {
          // Infer from maxRR vs TP
          if (hitTP) closeReason = "tp";
          else if (maxRR <= 0.05) closeReason = "sl"; // near entry = SL
        }

        const closed = {
          ...trade,
          closedAt:      new Date().toISOString(),
          maxRR,         session,
          sessionLabel:  SESSION_LABELS[session] || session,
          trueMaxRR:     null,
          trueMaxPrice:  null,
          realizedPnlEUR,
          hitTP,
          closeReason,
          // [v7.0] maxRRAtClose frozen at this moment
          maxRRAtClose:  maxRR,
        };
        closedTrades.push(closed);
        saveTrade(closed).catch(e => console.error(`❌ [DB] saveTrade:`, e.message));
        savePnlLog(trade.symbol, session, trade.direction, maxRR, hitTP, realizedPnlEUR)
          .catch(e => console.error(`❌ [DB] pnlLog:`, e.message));
        if (trade.symbol && trade.direction) decrementTracker(trade.symbol, trade.direction);
        delete openPositions[id];
        console.log(`📦 ${trade.symbol} gesloten | MaxRR: ${maxRR}R | Sessie: ${session} | closeReason: ${closeReason}`);

        // [v7.0] Ghost spawnt ALTIJD — tp / sl / manual / auto
        const isManual = closeReason === "manual";
        startGhostTracker(closed, isManual);
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

// ── ERROR LEARNING ────────────────────────────────────────────
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
    const type = getSymbolType(symbol) || "index";
    if (type==="index") MIN_STOP_INDEX[mt5] = (MIN_STOP_INDEX[mt5] || 5) * 2;
    else if (type==="forex") MIN_STOP_FOREX[mt5] = (MIN_STOP_FOREX[mt5] || 0.0005) * 2;
  }
}

// ── ORDER PLAATSEN ────────────────────────────────────────────
async function placeOrder(dir, symbol, entry, sl, lots, session) {
  const mt5Symbol = getMT5Symbol(symbol);
  const type      = getSymbolType(symbol) || "stock";
  const slPrice   = validateSL(dir, entry, sl, mt5Symbol, type);

  const lockKey = `${symbol}__${session}`;
  const tpLock  = tpLocks[lockKey];
  const tpRR    = tpLock ? tpLock.lockedRR : FIXED_TP_RR;
  const tpPrice = calcTPPrice(dir, entry, slPrice, tpRR);

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
// WEBHOOK v7.0
// [v7.0] Symbol validation: onbekend symbool → SKIP
// [v7.0] Forex second trade EV-conditional half risk
// ══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  try {
    const secret = req.query.secret || req.headers["x-secret"];
    if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error:"Unauthorized" });

    const rawSymbol = (!req.body.symbol || req.body.symbol==="{{ticker}}") ? null : req.body.symbol;
    if (!rawSymbol) return res.status(400).json({ error:"Symbool ontbreekt" });

    // [v7.0] Normalize symbol (NIKE → NKE)
    const symbol = normalizeSymbol(rawSymbol);

    // [v7.0] Symbol validation — must be in map OR have a learned patch
    const inMap = !!SYMBOL_MAP[symbol];
    const hasLearnedPatch = !!(learnedPatches[symbol]?.mt5Override);
    if (!inMap && !hasLearnedPatch) {
      const skipReason = `Symbol ${symbol} not in SYMBOL_MAP — add it first`;
      console.warn(`⚠️ [Symbol] ${symbol} not in map — trade blocked`);
      addWebhookHistory({ type:"SYMBOL_NOT_IN_MAP", symbol });
      return res.status(200).json({ status:"SKIP", reason: skipReason });
    }

    const { action, entry, sl } = req.body;
    if (!action||!entry||!sl) return res.status(400).json({ error:"Vereist: action, entry, sl" });

    const direction = ["buy","bull","long"].includes(action.toLowerCase()) ? "buy" : "sell";
    const entryNum  = parseFloat(entry);
    let   slNum     = parseFloat(sl);

    if (isNaN(entryNum)||isNaN(slNum)) return res.status(400).json({ error:"entry/sl geen getallen" });
    if (direction==="buy"  && slNum>=entryNum) return res.status(400).json({ error:"SL onder entry voor BUY" });
    if (direction==="sell" && slNum<=entryNum) return res.status(400).json({ error:"SL boven entry voor SELL" });

    // Duplicate check
    if (isDuplicateOrder(symbol, direction)) {
      const dupReason = `Duplicate geblokkeerd: ${symbol} ${direction} (binnen 60s)`;
      logDuplicateEntry(symbol, direction, dupReason).catch(() => {});
      addWebhookHistory({ type:"DUPLICATE_BLOCKED", symbol, direction });
      console.warn(`🚫 [Duplicate] ${dupReason}`);
      return res.status(200).json({ status:"SKIP", reason: dupReason });
    }

    const symType    = getSymbolType(symbol) || "stock";
    const mt5Sym     = getMT5Symbol(symbol);
    const curSession = getSessionGMT1();

    if (!isMarketOpen(symType, symbol)) {
      addWebhookHistory({ type:"MARKET_CLOSED", symbol, symType });
      return res.status(200).json({ status:"SKIP", reason:`Markt gesloten voor ${symbol}` });
    }

    // [v7.0] Forex second trade — EV-conditional half risk (item 26)
    let forexHalfRisk = false;
    let forexTrade2   = false;
    if (symType === "forex") {
      const consol = checkForexConsolidation(symbol, direction);
      if (consol.blocked) {
        const reason = `Forex pyramiding max 2×: ${consol.count} open ${direction} trades voor ${symbol}`;
        logForexConsolidation(symbol, direction, consol.count, reason).catch(() => {});
        addWebhookHistory({ type:"FOREX_PYRAMID_BLOCKED", symbol, direction, count:consol.count });
        return res.status(200).json({ status:"SKIP", reason });
      }
      if (consol.halfRisk) {
        forexHalfRisk = true;
        forexTrade2   = true;
        console.log(`⚡ [Forex Trade 2] ${symbol} ${direction} → 50% risk`);
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

    // [v7.0] Risk calculation
    let risk = getEffectiveRisk(symbol, direction);

    if (forexHalfRisk) {
      // [v7.0] Item 26: EV-conditional
      const lockKey = `${symbol}__${curSession}`;
      const lock    = tpLocks[lockKey];
      const evPos   = lock && (lock.evAtLock ?? 0) > 0;
      if (evPos) {
        // EV positive: first trade got boosted risk, second = 50% of that boosted risk
        risk = risk * 0.5;
        console.log(`⚡ [Forex Trade 2] ${symbol} EV positive → risk=€${risk.toFixed(2)} (50% of boosted)`);
      } else {
        // No EV boost: second trade = 50% of base
        risk = (BASE_RISK[symType] || 15) * dailyRiskMultiplier * 0.5;
        console.log(`⚡ [Forex Trade 2] ${symbol} no EV → risk=€${risk.toFixed(2)} (50% of base)`);
      }
    }

    const ftmo = ftmoSafetyCheck(risk);
    if (!ftmo.ok) {
      addWebhookHistory({ type:"FTMO_BLOCKED", symbol });
      return res.status(200).json({ status:"FTMO_BLOCKED", reason:ftmo.reason });
    }

    // [v7.0] Forex second trade max lots cap
    let lots = calcLots(symbol, entryNum, slApplied, risk);
    if (lots === null) return res.status(200).json({ status:"SKIP", reason:`Min lot > cap` });
    if (symType === "forex" && forexTrade2) {
      lots = Math.min(lots, 0.12); // [v7.0] max 0.12 for second forex trade
    } else if (symType === "forex") {
      lots = Math.min(lots, 0.25);
    }

    console.log(`📊 ${direction.toUpperCase()} ${symbol}/${curSession} | Entry:${entryNum} SL:${slApplied} (${slMult}×) Lots:${lots} Risk:€${risk.toFixed(2)} Mult:×${dailyRiskMultiplier}`);

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
      status:"OK", versie:"v7.0",
      direction, tvSymbol:symbol, mt5Symbol, symType,
      session:curSession, sessionLabel:SESSION_LABELS[curSession],
      entry:entryNum, sl:slPrice, slOriginal:slNum,
      slMultiplier:slMult, slLockInfo,
      slAutoApplied: slLocks[symbol]?.autoApplied ?? false,
      slTradesUntilAuto: Math.max(0, SL_AUTO_APPLY_THRESHOLD - (closedTrades.filter(t=>normalizeSymbol(t.symbol)===symbol).length)),
      tp: tpPrice, tpRR, tpFixed: `${FIXED_TP_RR}R (vast)`,
      tpInfo: `✅ TP: ${tpRR}R @ ${tpPrice} [${curSession}]${tpLocks[`${symbol}__${curSession}`] ? " [lock]" : " [4R default]"}`,
      lots, risicoEUR:risk.toFixed(2),
      dailyRiskMultiplier, dailyRiskMultiplierNext,
      forexTrade2: forexTrade2 ? `⚡ 50% risk (trade 2/2) max 0.12 lots` : null,
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
    // [v7.0] Mark as manual close so syncPositions sets close_reason='manual'
    const posIdStr = String(positionId);
    if (openPositions[posIdStr]) {
      openPositions[posIdStr]._pendingCloseReason = "manual";
      openPositions[posIdStr]._isManual           = true;
    }
    const result = await closePosition(positionId);
    if (symbol&&direction) decrementTracker(symbol, direction);
    // Ghost will start automatically via syncPositions with is_manual=true
    res.json({
      status:"OK", result,
      note:"close_reason=manual | Ghost tracker start via syncPositions | is_manual=true"
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status:"online", versie:"ftmo-v7.0",
    time: getBrusselsDateStr(),
    features: {
      "ghost_v7":     `✅ Complete rewrite: MAE, phantom_sl, trueMaxRR from entry`,
      "symbol_map":   `✅ NL25EUR, BRK.B, ARM, TL0 added | NIKE removed (NKE only)`,
      "no_all_sess":  `✅ 'all' session verwijderd overal`,
      "brussels_date":`✅ getBrusselsDateOnly() — geen UTC datum mismatch`,
      "sl_recalc":    `✅ SL recalc op startup voor alle symbolen ≥${SL_AUTO_APPLY_THRESHOLD} trades`,
      "calc_lots_fix":`✅ calcLots double multiplier fix`,
      "tp_boost":     `✅ TP boost: ×${TP_LOCK_RISK_MULT} × 1.2^days (no cap)`,
      "shadow_sl":    `✅ SL Shadow Optimizer (symbol-level, ghost trades)`,
      "daily_risk":   `✅ Daily risk mult: ×${dailyRiskMultiplier.toFixed(2)} | morgen: ×${dailyRiskMultiplierNext.toFixed(2)}`,
      "sym_validate": `✅ Onbekend symbool → SKIP met reden`,
      "forex_trade2": `✅ Forex trade 2: max 0.12 lots, EV-conditional 50% risk`,
    },
    tracking: {
      openPositions:  Object.keys(openPositions).length,
      closedTrades:   closedTrades.length,
      tpLocks:        Object.keys(tpLocks).filter(k => !k.endsWith("__all")).length,
      slAnalyses:     Object.keys(slLocks).length,
      ghostTrackers:  Object.keys(ghostTrackers).length,
      shadowResults:  Object.keys(shadowSLResults).length,
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
    consecutivePositiveDays,
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
    entry:g.trade.entry, sl:g.trade.sl,
    maxRRAtClose:  g.trade.maxRR ?? g.trade.maxRRAtClose,
    currentTrueRR: calcMaxRRFromPrice(g.trade, g.bestPrice),
    currentMAE:    calcMAE(g.trade, g.worstPrice),
    isManual:      g.isManual ?? false,
    closeReason:   g.trade.closeReason ?? "unknown",
    elapsedMin:    Math.round((Date.now()-g.startedAt)/60000),
    remainingMin:  Math.round((GHOST_DURATION_MS-(Date.now()-g.startedAt))/60000),
    activeUntil:   "22:00 Brussels",
  }));
  res.json({ count:active.length, ghosts:active, ghostActiveNow: isGhostActive() });
});

app.get("/tp-locks", (req,res) => {
  const bySym = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (sess === "all") continue; // [v7.0] filter out 'all'
    if (!bySym[sym]) bySym[sym] = {};
    bySym[sym][sess] = lock;
  }
  res.json({ generated:new Date().toISOString(), fixedTpRR: FIXED_TP_RR, totalLocks:Object.keys(tpLocks).filter(k=>!k.endsWith("__all")).length, locksBySymbol:bySym });
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

// [v7.0] SL Shadow endpoints (item 10)
app.get("/sl-shadow", (req, res) => {
  const { symbol } = req.query;
  if (symbol) {
    const ns  = normalizeSymbol(symbol.toUpperCase());
    const r   = shadowSLResults[ns];
    return res.json({ symbol: ns, result: r ?? null });
  }
  res.json({
    generated:  new Date().toISOString(),
    totalSymbols: Object.keys(shadowSLResults).length,
    minTrades:  SHADOW_SL_MIN_TRADES,
    results:    shadowSLResults,
  });
});

app.post("/sl-shadow/run", async (req, res) => {
  const rawSym = req.body?.symbol;
  try {
    if (rawSym) {
      const sym = normalizeSymbol(rawSym.toUpperCase());
      await runShadowSLOptimizer(sym);
      return res.json({ status:"OK", symbol:sym, result: shadowSLResults[sym] ?? null });
    }
    await runShadowSLOptimizerAll();
    return res.json({ status:"OK", symbols: Object.keys(shadowSLResults).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/daily-risk", async (req, res) => {
  try {
    const latest = await loadLatestDailyRisk();
    res.json({
      generated: new Date().toISOString(),
      today: {
        multiplier: dailyRiskMultiplier,
        date: getBrusselsDateOnly(),
      },
      tomorrow: {
        multiplier: dailyRiskMultiplierNext,
      },
      lastRecord: latest,
      effectiveRisk: Object.fromEntries(
        Object.entries(BASE_RISK).map(([k,v]) => [k, parseFloat((v * dailyRiskMultiplier).toFixed(2))])
      ),
      effectiveRiskTomorrow: Object.fromEntries(
        Object.entries(BASE_RISK).map(([k,v]) => [k, parseFloat((v * dailyRiskMultiplierNext).toFixed(2))])
      ),
      consecutivePositiveDays,
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
  const pending  = closedTrades.filter(t => t.trueMaxRR === null && (t.maxRR ?? 0) > 0);
  const bySymSess = {};
  for (const t of finished) {
    const sym = normalizeSymbol(t.symbol);
    const key = `${sym}__${t.session||"?"}`;
    if (!bySymSess[key]) bySymSess[key] = {
      symbol:sym, session:t.session,
      count:0, totalExtraRR:0, totalMAE:0, maeCount:0, hitTP:0, manualCount:0
    };
    const g = bySymSess[key];
    const maxRRAtClose = t.maxRRAtClose ?? t.maxRR ?? 0;
    g.count++;
    g.totalExtraRR += (t.trueMaxRR ?? 0) - maxRRAtClose;
    if (t.ghostMAE != null) { g.totalMAE += t.ghostMAE; g.maeCount++; }
    if (t.hitTP) g.hitTP++;
    if (t.closeReason === "manual" || t.isManual) g.manualCount++;
  }
  const results = Object.values(bySymSess).map(g => ({
    symbol:      g.symbol,
    session:     g.session,
    trades:      g.count,
    avgExtraRR:  parseFloat((g.totalExtraRR / g.count).toFixed(3)),
    avgGhostMAE: g.maeCount ? parseFloat((g.totalMAE / g.maeCount).toFixed(3)) : null,
    tpHitRate:   parseFloat(((g.hitTP / g.count) * 100).toFixed(1)),
    manualCount: g.manualCount,
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
    bestTrades:  [...withPnl].sort((a,b)=>b.realizedPnlEUR-a.realizedPnlEUR).slice(0,n).map(t=>({symbol:normalizeSymbol(t.symbol),session:t.session,maxRR:t.maxRR,pnl:t.realizedPnlEUR})),
    worstTrades: [...withPnl].sort((a,b)=>a.realizedPnlEUR-b.realizedPnlEUR).slice(0,n).map(t=>({symbol:normalizeSymbol(t.symbol),session:t.session,maxRR:t.maxRR,pnl:t.realizedPnlEUR})),
  });
});

// ══════════════════════════════════════════════════════════════
// DASHBOARD v7.0
// [v7.0] Adds: Daily Risk Panel, Last Cron Runs section
// Filters: no 'all' session rows
// ══════════════════════════════════════════════════════════════
app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FTMO Dashboard v7.0 — Nick Verschoot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#080c10;--panel:#0d1117;--border:#1a2233;--accent:#00ffe0;--accent2:#7b61ff;
    --gold:#f5c842;--red:#ff4560;--green:#00e396;--muted:#3a4a5c;--text:#c8d8e8;--dim:#556070;
    --font-ui:'Space Mono',monospace;--font-hd:'Syne',sans-serif;
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:13px;min-height:100vh}
  header{display:flex;align-items:center;justify-content:space-between;padding:18px 32px;border-bottom:1px solid var(--border);background:linear-gradient(90deg,#0d1117 0%,#080c10 100%);position:sticky;top:0;z-index:100}
  .logo{font-family:var(--font-hd);font-size:20px;font-weight:800;color:var(--accent);letter-spacing:-0.5px}
  .logo span{color:var(--text);font-weight:400;font-size:13px;margin-left:12px;opacity:0.6}
  .header-right{display:flex;gap:16px;align-items:center}
  .pill{background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:4px 14px;font-size:11px;color:var(--dim)}
  .pill.live{border-color:var(--green);color:var(--green)}
  #clock{font-size:11px;color:var(--dim)}
  .refresh-btn{background:none;border:1px solid var(--accent);color:var(--accent);padding:5px 14px;border-radius:4px;cursor:pointer;font-family:var(--font-ui);font-size:11px;transition:background 0.15s}
  .refresh-btn:hover{background:rgba(0,255,224,0.08)}
  main{max-width:1600px;margin:0 auto;padding:28px 24px 60px}
  .summary-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:28px}
  .stat-card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px 18px}
  .stat-card .label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
  .stat-card .value{font-size:22px;font-family:var(--font-hd);font-weight:800;color:var(--accent)}
  .stat-card .sub{font-size:10px;color:var(--dim);margin-top:3px}
  .filter-bar{display:flex;gap:8px;margin-bottom:18px;align-items:center;flex-wrap:wrap}
  .filter-btn{background:var(--panel);border:1px solid var(--border);color:var(--dim);padding:5px 16px;border-radius:20px;cursor:pointer;font-family:var(--font-ui);font-size:11px;transition:all 0.15s}
  .filter-btn.active{border-color:var(--accent);color:var(--accent);background:rgba(0,255,224,0.06)}
  .filter-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-right:4px}
  .search-box{background:var(--panel);border:1px solid var(--border);color:var(--text);padding:5px 14px;border-radius:4px;font-family:var(--font-ui);font-size:11px;outline:none;width:160px}
  .search-box:focus{border-color:var(--accent)}
  .table-wrap{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:auto;margin-bottom:32px}
  table{width:100%;border-collapse:collapse}
  thead th{background:#0b0f15;padding:10px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);border-bottom:1px solid var(--border);white-space:nowrap;cursor:pointer;user-select:none}
  thead th:hover{color:var(--accent)}
  thead th.sort-asc::after{content:" ▲";color:var(--accent)}
  thead th.sort-desc::after{content:" ▼";color:var(--accent)}
  tbody tr{border-bottom:1px solid rgba(26,34,51,0.5);transition:background 0.12s;cursor:pointer}
  tbody tr:hover{background:rgba(0,255,224,0.03)}
  tbody tr.expanded{background:rgba(123,97,255,0.05)}
  td{padding:10px 14px;white-space:nowrap;vertical-align:middle}
  .badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:0.5px}
  .badge-asia{background:rgba(123,97,255,0.2);color:var(--accent2);border:1px solid rgba(123,97,255,0.4)}
  .badge-london{background:rgba(0,255,224,0.1);color:var(--accent);border:1px solid rgba(0,255,224,0.3)}
  .badge-ny{background:rgba(245,200,66,0.12);color:var(--gold);border:1px solid rgba(245,200,66,0.4)}
  .ev-pos{color:var(--green)}.ev-neg{color:var(--red)}.ev-zero{color:var(--dim)}
  .mult-up{color:var(--gold)}.mult-down{color:var(--accent2)}.mult-ok{color:var(--green)}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
  .dot-green{background:var(--green);box-shadow:0 0 6px var(--green)}
  .dot-red{background:var(--red);box-shadow:0 0 6px var(--red)}
  .dot-gold{background:var(--gold);box-shadow:0 0 6px var(--gold)}
  .dot-dim{background:var(--muted)}
  .detail-row td{padding:0;background:#0a0f18}
  .detail-panel{padding:20px 24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;border-top:1px solid var(--border)}
  .detail-section h4{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin-bottom:10px;border-bottom:1px solid var(--border);padding-bottom:6px}
  .kv-row{display:flex;justify-content:space-between;margin-bottom:5px;font-size:11px}
  .kv-row .k{color:var(--dim)}.kv-row .v{color:var(--text);font-weight:700}
  .kv-row .v.accent{color:var(--accent)}.kv-row .v.gold{color:var(--gold)}
  .kv-row .v.green{color:var(--green)}.kv-row .v.red{color:var(--red)}
  .kv-row .v.purple{color:var(--accent2)}
  .bottom-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:12px}
  @media(max-width:900px){.bottom-grid{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px}
  .panel h3{font-family:var(--font-hd);font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px}
  .panel h3 .sub{font-size:11px;color:var(--dim);font-family:var(--font-ui);font-weight:400;margin-left:8px}
  .log-list{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto}
  .log-item{display:flex;justify-content:space-between;align-items:center;background:#0b0f15;border:1px solid var(--border);border-radius:5px;padding:8px 12px;font-size:10px}
  .log-item .log-sym{color:var(--accent);font-weight:700;margin-right:8px}
  .log-item .log-ts{color:var(--muted)}
  .log-item .log-val{font-weight:700}
  /* [v7.0] Daily Risk Panel */
  .risk-panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:20px}
  .risk-panel h3{font-family:var(--font-hd);font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px}
  .risk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
  .risk-card{background:#0b0f15;border:1px solid var(--border);border-radius:6px;padding:12px 16px}
  .risk-card .rc-label{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
  .risk-card .rc-value{font-size:18px;font-family:var(--font-hd);font-weight:800}
  .risk-card .rc-sub{font-size:10px;color:var(--dim);margin-top:2px}
  /* [v7.0] Cron Status */
  .cron-panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:20px}
  .cron-panel h3{font-family:var(--font-hd);font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px}
  .cron-list{display:flex;flex-direction:column;gap:8px}
  .cron-item{display:flex;justify-content:space-between;align-items:center;background:#0b0f15;border:1px solid var(--border);border-radius:5px;padding:10px 14px;font-size:11px}
  .cron-name{color:var(--text);font-weight:700;min-width:180px}
  .cron-ts{color:var(--dim);font-size:10px}
  .cron-status{font-size:10px;padding:2px 8px;border-radius:3px}
  .cron-ok{background:rgba(0,227,150,0.1);color:var(--green);border:1px solid rgba(0,227,150,0.3)}
  .cron-never{background:rgba(58,74,92,0.3);color:var(--muted);border:1px solid var(--border)}
  .no-data{color:var(--muted);text-align:center;padding:32px;font-size:12px}
  .loading{display:flex;align-items:center;justify-content:center;height:200px;color:var(--dim);font-size:12px;animation:pulse 1.2s infinite}
  @keyframes pulse{0%,100%{opacity:0.4}50%{opacity:1}}
  ::-webkit-scrollbar{width:6px;height:6px}
  ::-webkit-scrollbar-track{background:var(--panel)}
  ::-webkit-scrollbar-thumb{background:var(--muted);border-radius:3px}
</style>
</head>
<body>
<header>
  <div class="logo">FTMO v7.0<span>Nick Verschoot — Demo Account</span></div>
  <div class="header-right">
    <div id="clock">--:--:--</div>
    <div class="pill live">● LIVE</div>
    <button class="refresh-btn" onclick="loadAll()">↺ Refresh</button>
  </div>
</header>
<main>

  <!-- SUMMARY STRIP -->
  <div class="summary-strip" id="summary-strip">
    <div class="stat-card"><div class="label">Symbols tracked</div><div class="value" id="s-symbols">—</div><div class="sub">with optimizer data</div></div>
    <div class="stat-card"><div class="label">TP Ghost locks</div><div class="value" id="s-tp">—</div><div class="sub">asia/london/ny only</div></div>
    <div class="stat-card"><div class="label">SL Shadow locks</div><div class="value" id="s-sl">—</div><div class="sub">auto-applied</div></div>
    <div class="stat-card"><div class="label">Avg Ghost Extra RR</div><div class="value" id="s-ghost-rr">—</div><div class="sub">across all symbols</div></div>
    <div class="stat-card"><div class="label">TP EV positive</div><div class="value" id="s-ev-pos">—</div><div class="sub">sessions with +EV TP</div></div>
    <div class="stat-card"><div class="label">Open positions</div><div class="value" id="s-open">—</div><div class="sub">live MT5 trades</div></div>
  </div>

  <!-- [v7.0] DAILY RISK PANEL -->
  <div class="risk-panel">
    <h3>💰 Daily Risk Scaling <span class="sub">auto-refresh 30s</span></h3>
    <div class="risk-grid" id="risk-grid">
      <div class="risk-card"><div class="rc-label">Today Multiplier</div><div class="rc-value" id="risk-today" style="color:var(--accent)">—</div><div class="rc-sub">active now</div></div>
      <div class="risk-card"><div class="rc-label">Yesterday EV</div><div class="rc-value" id="risk-yest-ev">—</div><div class="rc-sub">determines tomorrow</div></div>
      <div class="risk-card"><div class="rc-label">Tomorrow Multiplier</div><div class="rc-value" id="risk-tomorrow" style="color:var(--gold)">—</div><div class="rc-sub">applied at 02:00</div></div>
      <div class="risk-card"><div class="rc-label">Tomorrow Forex Risk</div><div class="rc-value" id="risk-forex-tmr" style="color:var(--green)">—</div><div class="rc-sub">base × mult tomorrow</div></div>
      <div class="risk-card"><div class="rc-label">Tomorrow Index Risk</div><div class="rc-value" id="risk-index-tmr" style="color:var(--green)">—</div><div class="rc-sub">base × mult tomorrow</div></div>
    </div>
    <div style="margin-top:14px;font-size:11px;color:var(--dim)">
      Consecutive positive days per symbol/session (TP boost):
      <span id="consec-days" style="color:var(--accent);margin-left:8px">Loading...</span>
    </div>
  </div>

  <!-- [v7.0] CRON STATUS PANEL -->
  <div class="cron-panel">
    <h3>⏱ Last Cron Runs <span class="sub">auto-refresh 30s</span></h3>
    <div class="cron-list" id="cron-list">
      <div class="loading">Loading cron data...</div>
    </div>
  </div>

  <!-- SESSION FILTER -->
  <div class="filter-bar">
    <span class="filter-label">Session:</span>
    <button class="filter-btn active" data-session="all" onclick="setSession('all',this)">All</button>
    <button class="filter-btn" data-session="asia"   onclick="setSession('asia',this)">Asia</button>
    <button class="filter-btn" data-session="london" onclick="setSession('london',this)">London</button>
    <button class="filter-btn" data-session="ny"     onclick="setSession('ny',this)">New York</button>
    <span style="flex:1"></span>
    <input class="search-box" type="text" placeholder="Filter symbol..." oninput="filterSymbol(this.value)" id="sym-search">
  </div>

  <!-- MAIN TABLE -->
  <div class="table-wrap">
    <table id="main-table">
      <thead>
        <tr>
          <th onclick="sortBy('symbol')">Symbol</th>
          <th onclick="sortBy('session')">Session</th>
          <th onclick="sortBy('tpRR')">TP Ghost RR</th>
          <th onclick="sortBy('tpEV')">TP EV</th>
          <th onclick="sortBy('tpTrades')">TP Trades</th>
          <th onclick="sortBy('slMult')">SL Shadow Mult</th>
          <th onclick="sortBy('slEV')">SL EV</th>
          <th onclick="sortBy('slHitRate')">SL Hit Rate</th>
          <th onclick="sortBy('slAuto')">Auto Applied</th>
          <th onclick="sortBy('ghostExtra')">Ghost +RR</th>
          <th onclick="sortBy('ghostMAE')">Ghost MAE</th>
          <th onclick="sortBy('ghostTrades')">Ghost Trades</th>
          <th onclick="sortBy('tpHitRate')">TP Hit%</th>
        </tr>
      </thead>
      <tbody id="table-body">
        <tr><td colspan="13" class="loading">Loading optimizer data...</td></tr>
      </tbody>
    </table>
  </div>

  <!-- BOTTOM PANELS -->
  <div class="bottom-grid">
    <div class="panel">
      <h3>TP Ghost Update Log <span class="sub">last 20 changes</span></h3>
      <div class="log-list" id="tp-log"></div>
    </div>
    <div class="panel">
      <h3>SL Shadow Update Log <span class="sub">last 20 changes</span></h3>
      <div class="log-list" id="sl-log"></div>
    </div>
  </div>

</main>

<script>
let allRows=[];let sessionFilter='all';let symbolFilter='';let sortKey='symbol';let sortDir=1;let expandedKey=null;

function updateClock(){
  document.getElementById('clock').textContent=
    new Date().toLocaleTimeString('en-GB',{timeZone:'Europe/Brussels',hour12:false})+' BXL';
}
setInterval(updateClock,1000);updateClock();

// Hardened fetch — one endpoint failing never kills the whole dashboard
async function safeFetch(url, fallback){
  try{
    const r=await fetch(url);
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  }catch(e){
    console.warn('safeFetch failed:', url, e.message);
    return fallback;
  }
}

async function loadAll(){
  try{
    const[tpRes,slRes,shadowRes,ghostRes,liveRes,dailyRes,histRes]=await Promise.all([
      safeFetch('/tp-locks',            {locksBySymbol:{}}),
      safeFetch('/sl-locks',            {analyses:[]}),
      safeFetch('/sl-shadow',           {results:{}}),
      safeFetch('/analysis/ghost-deep', {bySymbolSession:[],ghostFinished:0,ghostPending:0}),
      safeFetch('/live/positions',      {count:0,positions:[]}),
      safeFetch('/daily-risk',          null),
      safeFetch('/history?limit=200',   {history:[]}),
    ]);
    buildRows(tpRes,slRes,shadowRes,ghostRes);
    updateSummary(tpRes,slRes,shadowRes,ghostRes,liveRes);
    updateDailyRiskPanel(dailyRes);
    updateCronPanel(histRes);
    renderTable();
    loadLogs();
  }catch(e){
    console.error('loadAll crash:', e);
    document.getElementById('table-body').innerHTML='<tr><td colspan="13" class="no-data">Dashboard error: '+e.message+' — check console</td></tr>';
  }
}

// [v7.0] Daily Risk Panel
function updateDailyRiskPanel(d){
  if(!d) return;
  const todayMult=d.today?.multiplier??1;
  const tmrMult=d.tomorrow?.multiplier??1;
  const lastRec=d.lastRecord;
  document.getElementById('risk-today').textContent='×'+todayMult.toFixed(2);
  const evEl=document.getElementById('risk-yest-ev');
  if(lastRec){
    evEl.textContent=lastRec.evPositive?'✅ Positive':'❌ Negative';
    evEl.style.color=lastRec.evPositive?'var(--green)':'var(--red)';
  }else{evEl.textContent='—';}
  document.getElementById('risk-tomorrow').textContent='×'+tmrMult.toFixed(2);
  const fxTmr=d.effectiveRiskTomorrow?.forex??0;
  const idxTmr=d.effectiveRiskTomorrow?.index??0;
  document.getElementById('risk-forex-tmr').textContent='€'+fxTmr.toFixed(2);
  document.getElementById('risk-index-tmr').textContent='€'+idxTmr.toFixed(2);
  // Consecutive days
  const cd=d.consecutivePositiveDays??{};
  const cdEntries=Object.entries(cd).filter(([,v])=>v>0);
  document.getElementById('consec-days').textContent=
    cdEntries.length?cdEntries.map(([k,v])=>k+': '+v+'d').join(' | '):'None (all at 0)';
}

// [v7.0] Cron Status Panel
function updateCronPanel(histRes){
  const CRONS=[
    {key:'AUTOCLOSE_2150',  label:'21:50 Auto-close',    schedule:'Mon-Fri 21:50'},
    {key:'DAY_END_22:00',   label:'22:00 Ghost finalize', schedule:'Mon-Fri 22:00'},
    {key:'EOD_GHOST_21:00', label:'21:00 EOD Ghost',      schedule:'Mon-Fri 21:00'},
    {key:'RECONNECT_02:00', label:'02:00 Reconnect',      schedule:'Daily 02:00'},
    {key:'NIGHTLY_OPTIMIZER',label:'03:00 Nightly Optimizer',schedule:'Daily 03:00'},
  ];
  const history=(histRes?.history||[]);
  const lastFire={};
  for(const h of history){
    if(!lastFire[h.type])lastFire[h.type]=h.ts;
  }
  const html=CRONS.map(c=>{
    const ts=lastFire[c.key]??null;
    const hasRun=!!ts;
    const tsStr=ts?new Date(ts).toLocaleString('en-GB',{timeZone:'Europe/Brussels'}):'Never fired';
    return \`<div class="cron-item">
      <span class="cron-name">\${c.label}</span>
      <span class="cron-ts">\${c.schedule}</span>
      <span class="cron-ts">\${tsStr}</span>
      <span class="cron-status \${hasRun?'cron-ok':'cron-never'}">\${hasRun?'OK':'—'}</span>
    </div>\`;
  }).join('');
  document.getElementById('cron-list').innerHTML=html;
}

function buildRows(tpRes,slRes,shadowRes,ghostRes){
  const rows=[];
  const tpBySymbol=tpRes.locksBySymbol||{};
  const slBySymbol={};
  for(const a of(slRes.analyses||[]))slBySymbol[a.symbol]=a;
  const shadowResults=shadowRes.results||{};
  const ghostBySS={};
  for(const g of(ghostRes.bySymbolSession||[]))ghostBySS[(g.symbol||'')+'__'+(g.session||'')]=g;
  const keys=new Set();
  for(const[sym,sessions]of Object.entries(tpBySymbol)){
    for(const sess of Object.keys(sessions)){
      if(sess==='all')continue; // [v7.0] skip 'all'
      keys.add(sym+'__'+sess);
    }
  }
  for(const k of Object.keys(ghostBySS))keys.add(k);
  for(const sym of Object.keys(slBySymbol)){
    const hasSess=[...keys].some(k=>k.startsWith(sym+'__'));
    if(!hasSess)keys.add(sym+'__all');
  }
  for(const key of keys){
    const[sym,sess]=key.split('__');
    if(sess==='all'&&!ghostBySS[key]&&!slBySymbol[sym])continue; // skip empty all rows
    const tpSess=sess!=='all'?(tpBySymbol[sym]?.[sess]||null):null;
    const slData=slBySymbol[sym]||null;
    const shadow=shadowResults[sym]||null;
    const ghost=ghostBySS[key]||null;
    rows.push({
      symbol:sym,session:sess,key,
      tpRR:tpSess?.lockedRR??null,tpEV:tpSess?.evAtLock??null,
      tpEvPos:tpSess?.evPositive??false,tpTrades:tpSess?.lockedTrades??null,
      tpPrevRR:tpSess?.prevRR??null,tpLockedAt:tpSess?.lockedAt??null,
      slMult:shadow?.best?.slMultiplier??slData?.multiplier??null,
      slEV:shadow?.best?.bestEV??slData?.evAtLock??null,
      slHitRate:shadow?.best?.slHitRate??null,
      slAuto:slData?.autoApplied??false,
      slTrades:shadow?.tradesUsed??slData?.lockedTrades??null,
      slDir:slData?.direction??null,
      ghostExtra:ghost?.avgExtraRR??null,
      ghostMAE:ghost?.avgGhostMAE??null,
      ghostTrades:ghost?.trades??null,
      tpHitRate:ghost?.tpHitRate??null,
      manualCount:ghost?.manualCount??null,
      _tpSess:tpSess,_slData:slData,_shadow:shadow,_ghost:ghost,
    });
  }
  allRows=rows;
}

function updateSummary(tpRes,slRes,shadowRes,ghostRes,liveRes){
  const unique=new Set(allRows.map(r=>r.symbol));
  document.getElementById('s-symbols').textContent=unique.size;
  const tpCount=Object.keys(tpRes.locksBySymbol||{}).reduce((s,k)=>s+Object.keys(tpRes.locksBySymbol[k]).filter(sk=>sk!=='all').length,0);
  document.getElementById('s-tp').textContent=tpCount;
  const slAuto=(slRes.analyses||[]).filter(a=>a.autoApplied).length;
  document.getElementById('s-sl').textContent=slAuto+'/'+(slRes.analyses||[]).length;
  const ghostItems=ghostRes.bySymbolSession||[];
  const avgExtra=ghostItems.length?(ghostItems.reduce((s,g)=>s+g.avgExtraRR,0)/ghostItems.length).toFixed(2):'—';
  document.getElementById('s-ghost-rr').textContent=avgExtra!=='—'?'+'+avgExtra+'R':'—';
  document.getElementById('s-ev-pos').textContent=allRows.filter(r=>r.tpEvPos).length;
  document.getElementById('s-open').textContent=liveRes.count??'—';
}

function renderTable(){
  let rows=allRows.filter(r=>{
    if(sessionFilter!=='all'&&r.session!==sessionFilter)return false;
    if(symbolFilter&&!r.symbol.toLowerCase().includes(symbolFilter.toLowerCase()))return false;
    if(r.session==='all'&&!r.ghostExtra&&!r.slMult)return false; // hide empty 'all' rows
    return true;
  });
  rows.sort((a,b)=>{
    const av=a[sortKey],bv=b[sortKey];
    if(av===null&&bv===null)return 0;
    if(av===null)return 1;if(bv===null)return -1;
    if(typeof av==='string')return av.localeCompare(bv)*sortDir;
    return(av-bv)*sortDir;
  });
  const tbody=document.getElementById('table-body');
  if(!rows.length){
    const msg=allRows.length===0
      ? 'No optimizer data yet — trades will appear here after ghost finalization'
      : 'No rows match current filters';
    tbody.innerHTML='<tr><td colspan="13" class="no-data">'+msg+'</td></tr>';
    return;
  }
  let html='';
  for(const r of rows){
    const sessClass={asia:'badge-asia',london:'badge-london',ny:'badge-ny'}[r.session]||'badge-all';
    const tpEVClass=r.tpEV===null?'ev-zero':r.tpEV>0?'ev-pos':'ev-neg';
    const slEVClass=r.slEV===null?'ev-zero':r.slEV>0?'ev-pos':'ev-neg';
    const multClass=!r.slMult?'ev-zero':r.slMult>1?'mult-up':r.slMult<1?'mult-down':'mult-ok';
    const autoSign=r.slAuto?'<span class="dot dot-green"></span>YES':'<span class="dot dot-dim"></span>—';
    const ghostSign=r.ghostExtra===null?'<span class="ev-zero">—</span>':r.ghostExtra>0?'<span class="ev-pos">+'+r.ghostExtra.toFixed(2)+'R</span>':'<span class="ev-neg">'+r.ghostExtra.toFixed(2)+'R</span>';
    const isExp=expandedKey===r.key;
    html+=\`<tr class="\${isExp?'expanded':''}" onclick="toggleDetail('\${r.key}')">
      <td style="font-weight:700;color:var(--text)">\${r.symbol}</td>
      <td><span class="badge \${sessClass}">\${r.session}</span></td>
      <td style="color:var(--accent)">\${r.tpRR!==null?r.tpRR+'R':'<span class="ev-zero">—</span>'}</td>
      <td class="\${tpEVClass}">\${r.tpEV!==null?r.tpEV.toFixed(3):'—'}</td>
      <td style="color:var(--dim)">\${r.tpTrades??'—'}</td>
      <td class="\${multClass}">\${r.slMult!==null?r.slMult+'×':'—'}</td>
      <td class="\${slEVClass}">\${r.slEV!==null?r.slEV.toFixed(3):'—'}</td>
      <td>\${r.slHitRate!==null?r.slHitRate+'%':'<span class="ev-zero">—</span>'}</td>
      <td>\${autoSign}</td>
      <td>\${ghostSign}</td>
      <td style="color:var(--dim)">\${r.ghostMAE!==null?r.ghostMAE+'R':'—'}</td>
      <td style="color:var(--dim)">\${r.ghostTrades??'—'}</td>
      <td>\${r.tpHitRate!==null?r.tpHitRate+'%':'<span class="ev-zero">—</span>'}</td>
    </tr>\`;
    if(isExp)html+=\`<tr class="detail-row"><td colspan="13">\${buildDetailPanel(r)}</td></tr>\`;
  }
  tbody.innerHTML=html;
}

function buildDetailPanel(r){
  const tp=r._tpSess,sl=r._slData,sh=r._shadow,gh=r._ghost;
  let html='<div class="detail-panel">';
  html+=\`<div class="detail-section">
    <h4>👻 TP Ghost — \${r.symbol} / \${r.session}</h4>
    <div class="kv-row"><span class="k">Locked RR</span><span class="v accent">\${tp?.lockedRR??'—'}R</span></div>
    <div class="kv-row"><span class="k">EV at lock</span><span class="v \${(tp?.evAtLock??0)>0?'green':'red'}">\${tp?.evAtLock?.toFixed(3)??'—'}</span></div>
    <div class="kv-row"><span class="k">Trades used</span><span class="v">\${tp?.lockedTrades??'—'}</span></div>
    <div class="kv-row"><span class="k">Prev RR</span><span class="v">\${tp?.prevRR??'—'}R</span></div>
    <div class="kv-row"><span class="k">EV positive</span><span class="v \${tp?.evPositive?'green':'red'}">\${tp?.evPositive?'YES ✅':'NO ❌'}</span></div>
  </div>\`;
  const bestMult=sh?.best?.slMultiplier;
  const multLabel=!bestMult?'—':bestMult>1?\`🔼 \${bestMult}× (wider)\`:bestMult<1?\`🔽 \${bestMult}× (tighter)\`:'✅ current optimal';
  html+=\`<div class="detail-section">
    <h4>🌑 SL Shadow — \${r.symbol}</h4>
    <div class="kv-row"><span class="k">Best multiplier</span><span class="v gold">\${multLabel}</span></div>
    <div class="kv-row"><span class="k">Best EV</span><span class="v \${(sh?.best?.bestEV??0)>0?'green':'red'}">\${sh?.best?.bestEV?.toFixed(3)??'—'}</span></div>
    <div class="kv-row"><span class="k">SL hit rate</span><span class="v">\${sh?.best?.slHitRate??'—'}%</span></div>
    <div class="kv-row"><span class="k">Trades used</span><span class="v">\${sh?.tradesUsed??'—'}</span></div>
    <div class="kv-row"><span class="k">Auto applied</span><span class="v \${sl?.autoApplied?'green':'ev-zero'}">\${sl?.autoApplied?'YES ✅':'No'}</span></div>
  </div>\`;
  html+=\`<div class="detail-section">
    <h4>📊 Ghost Analytics</h4>
    <div class="kv-row"><span class="k">Ghost trades</span><span class="v">\${gh?.trades??'—'}</span></div>
    <div class="kv-row"><span class="k">Avg extra RR</span><span class="v \${(gh?.avgExtraRR??0)>0?'green':'red'}">\${gh?.avgExtraRR!==undefined?(gh.avgExtraRR>=0?'+':'')+gh.avgExtraRR.toFixed(3)+'R':'—'}</span></div>
    <div class="kv-row"><span class="k">TP hit rate</span><span class="v">\${gh?.tpHitRate??'—'}%</span></div>
    <div class="kv-row"><span class="k">Manual closes</span><span class="v gold">\${gh?.manualCount??'—'}</span></div>
  </div>\`;
  html+='</div>';
  return html;
}

function toggleDetail(key){expandedKey=expandedKey===key?null:key;renderTable();}
function setSession(sess,btn){
  sessionFilter=sess;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');renderTable();
}
function filterSymbol(val){symbolFilter=val;renderTable();}
function sortBy(key){
  if(sortKey===key)sortDir*=-1;else{sortKey=key;sortDir=1;}
  document.querySelectorAll('thead th').forEach(th=>th.classList.remove('sort-asc','sort-desc'));
  const keys=['symbol','session','tpRR','tpEV','tpTrades','slMult','slEV','slHitRate','slAuto','ghostExtra','ghostMAE','ghostTrades','tpHitRate'];
  const idx=keys.indexOf(key);
  const ths=document.querySelectorAll('thead th');
  if(ths[idx])ths[idx].classList.add(sortDir===1?'sort-asc':'sort-desc');
  renderTable();
}

async function loadLogs(){
  try{
    const tpLog=await fetch('/tp-locks').then(r=>r.json());
    const entries=[];
    for(const[sym,sessions]of Object.entries(tpLog.locksBySymbol||{})){
      for(const[sess,lock]of Object.entries(sessions)){
        if(sess==='all')continue;
        entries.push({sym,sess,rr:lock.lockedRR,ev:lock.evAtLock,ts:lock.lockedAt,prev:lock.prevRR});
      }
    }
    entries.sort((a,b)=>(b.ts||'').localeCompare(a.ts||''));
    const tpLogEl=document.getElementById('tp-log');
    if(!entries.length){tpLogEl.innerHTML='<div class="no-data">No TP Ghost data yet</div>';return;}
    tpLogEl.innerHTML=entries.slice(0,20).map(e=>\`
      <div class="log-item">
        <div><span class="log-sym">\${e.sym}</span><span style="color:\${e.sess==='asia'?'#7b61ff':e.sess==='london'?'#00ffe0':'#f5c842'}">\${e.sess}</span></div>
        <div class="log-val" style="color:var(--accent)">\${e.prev?e.prev+'R → ':''}\${e.rr}R</div>
        <div style="color:\${(e.ev??0)>0?'var(--green)':'var(--red)'}">EV \${e.ev?.toFixed(3)??'—'}</div>
        <div class="log-ts">\${e.ts?new Date(e.ts).toLocaleDateString('en-GB'):''}</div>
      </div>\`).join('');
  }catch(e){}
  try{
    const slLog=await fetch('/sl-locks').then(r=>r.json());
    const entries=(slLog.analyses||[]).filter(a=>a.lockedAt);
    entries.sort((a,b)=>(b.lockedAt||'').localeCompare(a.lockedAt||''));
    const slLogEl=document.getElementById('sl-log');
    if(!entries.length){slLogEl.innerHTML='<div class="no-data">No SL Shadow data yet</div>';return;}
    slLogEl.innerHTML=entries.slice(0,20).map(e=>\`
      <div class="log-item">
        <div><span class="log-sym">\${e.symbol}</span><span style="color:var(--dim)">\${e.direction||'—'}</span></div>
        <div class="log-val" style="color:\${e.multiplier>1?'var(--gold)':e.multiplier<1?'var(--accent2)':'var(--green)'}">\${e.multiplier}×</div>
        <div style="color:\${(e.evAtLock??0)>0?'var(--green)':'var(--red)'}">EV \${e.evAtLock?.toFixed(3)??'—'}</div>
        <div style="color:\${e.autoApplied?'var(--green)':'var(--dim)'};font-size:10px">\${e.autoApplied?'AUTO':'READONLY'}</div>
      </div>\`).join('');
  }catch(e){}
}

loadAll();
setInterval(loadAll,30000);
</script>
</body>
</html>`);
});

app.use((req, res) => {
  res.status(404).json({ error:"Route niet gevonden", geprobeerd:req.method+" "+req.originalUrl });
});

// ══════════════════════════════════════════════════════════════
// STARTUP v7.0
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    console.log("🚀 FTMO Webhook Server v7.0 — opstarten...");
    await initDB();

    const dbTrades = await loadAllTrades();
    closedTrades.push(...dbTrades);
    console.log(`📂 ${dbTrades.length} trades geladen`);

    const savedTP = await loadTPConfig();
    // [v7.0] Filter out any 'all' session keys that snuck in
    for (const [key, val] of Object.entries(savedTP)) {
      if (!key.endsWith("__all")) tpLocks[key] = val;
    }
    console.log(`🔒 ${Object.keys(tpLocks).length} TP locks geladen (geen 'all' sessie)`);

    const savedSL = await loadSLConfig();
    Object.assign(slLocks, savedSL);
    console.log(`📐 ${Object.keys(savedSL).length} SL configs geladen`);

    // [v7.0] Load shadow SL results
    const shadowRows = await loadShadowSLAnalysis();
    for (const row of shadowRows) {
      shadowSLResults[row.symbol] = {
        symbol:    row.symbol,
        best:      { slMultiplier: row.bestMultiplier, bestEV: row.bestEV, bestRR: row.bestRR, bestWinrate: row.bestWinrate, slHitRate: row.slHitRate },
        tradesUsed: row.tradesUsed,
        computedAt: row.computedAt,
      };
    }
    console.log(`🌑 ${shadowRows.length} shadow SL resultaten geladen`);

    // [v7.0] Daily risk multiplier
    const dailyRisk = await loadLatestDailyRisk();
    if (dailyRisk) {
      dailyRiskMultiplier     = dailyRisk.riskMultNext ?? 1.0;
      dailyRiskMultiplierNext = dailyRisk.riskMultNext ?? 1.0;
      console.log(`📅 [Daily Risk] Geladen: ×${dailyRiskMultiplier} (${dailyRisk.evPositive?"✅ positief":"❌ reset"})`);
    }

    await restoreOpenPositionsFromMT5();

    // [v7.0] Orphan repair
    await repairOrphanedGhosts();

    // [v7.0] Forced SL recalc on startup for symbols with >= 30 trades
    const symbolCounts = {};
    for (const t of closedTrades) {
      const sym = normalizeSymbol(t.symbol);
      symbolCounts[sym] = (symbolCounts[sym] || 0) + 1;
    }
    for (const [sym, n] of Object.entries(symbolCounts)) {
      if (n >= SL_AUTO_APPLY_THRESHOLD) {
        console.log(`[Startup] Forced SL recalc for ${sym}: ${n} trades`);
        await runSLLockEngine(sym).catch(e => console.error(`❌ [SL startup] ${sym}:`, e.message));
      }
    }

    // [v7.0] Run shadow optimizer on startup
    await runShadowSLOptimizerAll();

    // [v7.0] Purge any 'all' session tpLocks from memory
    for (const key of Object.keys(tpLocks)) {
      if (key.endsWith("__all")) delete tpLocks[key];
    }

    app.listen(PORT, () => {
      console.log(`✅ Server luistert op port ${PORT}`);
      console.log(`📋 v7.0 actief:`);
      console.log(`   🔹 Ghost v7.0: MAE, phantom_sl, trueMaxRR from entry, close_reason`);
      console.log(`   🔹 Symbols: NL25EUR, BRK.B, ARM, TL0 | NIKE→NKE`);
      console.log(`   🔹 'all' sessie verwijderd overal`);
      console.log(`   🔹 Brussels date fix: getBrusselsDateOnly()`);
      console.log(`   🔹 SL recalc op startup: ${Object.keys(symbolCounts).filter(s=>symbolCounts[s]>=SL_AUTO_APPLY_THRESHOLD).length} symbolen`);
      console.log(`   🔹 calcLots double multiplier fix`);
      console.log(`   🔹 TP boost: ×${TP_LOCK_RISK_MULT} × 1.2^days (no cap)`);
      console.log(`   🔹 Shadow SL optimizer actief`);
      console.log(`   🔹 Daily risk mult: ×${dailyRiskMultiplier}`);
      console.log(`   🔹 Symbol validation: onbekend → SKIP`);
      console.log(`   🔹 Forex trade 2: max 0.12 lots, EV-conditional`);
    });
  } catch(err) {
    console.error("❌ Startup mislukt:", err.message);
    process.exit(1);
  }
}

start();
