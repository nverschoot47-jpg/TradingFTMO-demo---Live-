// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v5.0
// Account : Nick Verschoot — FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ───────────────────────────────────────────────────────────────
// SESSIES (Brussels — automatisch zomer/wintertijd):
//   asia      → 02:00–08:00
//   london    → 08:00–15:30
//   ny        → 15:30–20:00
//
// WIJZIGINGEN v5.0 (t.o.v. v4.4):
//  ✅ [FEAT] TP wordt automatisch gezet per sessie zodra EV > 0
//           → Geen minimum trades vereist voor TP lock
//           → TP lock engine zet TP bij elke trade met positieve sessie EV
//  ✅ [FEAT] SL wordt automatisch toegepast na ≥50 trades per symbool
//           → Onder 50 trades: READONLY advies (zoals v4.x)
//           → Vanaf 50 trades: multiplier wordt écht toegepast op SL
//           → slApplied wordt berekend met de geleerde multiplier
//  ✅ [FEAT] Ghost analyse opgeslagen in DB (ghost_analysis tabel)
//           → ghostExtraRR, duur, reden, PnL bijgehouden
//  ✅ [FEAT] PnL log per trade (trade_pnl_log tabel)
//           → winsten/verliezen per sessie/pair traceerbaar
//  ✅ [FEAT] Diepgaande dashboard endpoints:
//           → /analysis/ghost-deep  — ghost effect analyse
//           → /analysis/pnl         — win/verlies per pair/sessie
//           → /analysis/extremes    — grootste winsten en verliezen
//  ✅ [FEAT] Volledig dashboard ingebouwd in /dashboard
//  ✅ [FIX]  app.listen() aanwezig — Railway crash opgelost
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

// ── SL DREMPEL: na 50 trades wordt multiplier écht toegepast ──
const SL_AUTO_APPLY_THRESHOLD  = 50;
const SL_PROVEN_MULT_THRESHOLD = 10;   // voor TP-lock bewezen SL halvering

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

const TP_LOCK_RISK_MULT = 4;

// [v5.0] FTMO dagelijkse verlies-limiet UITGESCHAKELD
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
// SYMBOL MAP (volledig — zelfde als v4.4)
// ══════════════════════════════════════════════════════════════
const SYMBOL_MAP = {
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
  "XAUUSD":      { mt5: "XAUUSD",      type: "gold"   },
  "GOLD":        { mt5: "XAUUSD",      type: "gold"   },
  "UKOIL":       { mt5: "UKOIL.cash",  type: "brent"  },
  "UKOIL.cash":  { mt5: "UKOIL.cash",  type: "brent"  },
  "USOIL":       { mt5: "USOIL.cash",  type: "wti"    },
  "USOIL.cash":  { mt5: "USOIL.cash",  type: "wti"    },
  "BTCUSD":      { mt5: "BTCUSD",      type: "crypto" },
  "ETHUSD":      { mt5: "ETHUSD",      type: "crypto" },
  "AAPL":  { mt5: "AAPL",  type: "stock" },
  "TSLA":  { mt5: "TSLA",  type: "stock" },
  "MSFT":  { mt5: "MSFT",  type: "stock" },
  "NVDA":  { mt5: "NVDA",  type: "stock" },
  "AMD":   { mt5: "AMD",   type: "stock" },
  "NFLX":  { mt5: "NFLX",  type: "stock" },
  "AMZN":  { mt5: "AMZN",  type: "stock" },
  "GOOGL": { mt5: "GOOG",  type: "stock" },
  "META":  { mt5: "META",  type: "stock" },
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
  "GER40.cash":10,"UK100.cash":5,"US100.cash":10,"US30.cash":10,
  "US500.cash":5,"JP225.cash":10,"AUS200.cash":5,"EU50.cash":5,
  "FRA40.cash":5,"HK50.cash":10,"US2000.cash":5,
};
const MIN_STOP_COMMODITY = {
  "XAUUSD":1.0,"UKOIL.cash":0.05,"USOIL.cash":0.05,"BTCUSD":100.0,"ETHUSD":5.0,
};
const MIN_STOP_FOREX = {
  "EURUSD":0.0005,"GBPUSD":0.0005,"AUDUSD":0.0005,"NZDUSD":0.0005,
  "USDCHF":0.0005,"USDCAD":0.0005,"EURGBP":0.0005,"EURAUD":0.0005,
  "EURCAD":0.0005,"EURCHF":0.0005,"GBPAUD":0.0005,"GBPCAD":0.0005,
  "GBPCHF":0.0005,"AUDCAD":0.0005,"AUDCHF":0.0005,"AUDNZD":0.0005,
  "CADCHF":0.0005,"NZDCAD":0.0005,"NZDCHF":0.0005,
  "USDJPY":0.05,"EURJPY":0.05,"GBPJPY":0.05,"AUDJPY":0.05,
  "CADJPY":0.05,"NZDJPY":0.05,"CHFJPY":0.05,
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

// ── AUTO-CLOSE 20:50 Brussels ─────────────────────────────────
cron.schedule("50 20 * * *", async () => {
  const { day } = getBrusselsComponents();
  const isWE = day === 0 || day === 6;
  console.log("🔔 20:50 Brussels — auto-close gestart...");
  try {
    const positions = await fetchOpenPositions();
    if (!Array.isArray(positions) || !positions.length) return;
    for (const pos of positions) {
      const tvSym = Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k].mt5 === pos.symbol) || pos.symbol;
      if (isWE && getSymbolType(tvSym) === "crypto" && isCryptoWeekend(tvSym)) continue;
      try {
        await closePosition(pos.id);
        console.log(`✅ Auto-close: ${pos.symbol}`);
        addWebhookHistory({ type:"AUTOCLOSE_2050", symbol:pos.symbol, positionId:pos.id });
      } catch(e) { console.error(`❌ Auto-close ${pos.symbol}:`, e.message); }
    }
  } catch(e) { console.error("❌ Auto-close fout:", e.message); }
}, { timezone: "Europe/Brussels" });

// ── NIGHTLY TP OPTIMIZER 03:00 Brussels ──────────────────────
cron.schedule("0 3 * * *", async () => {
  console.log("🌙 03:00 Brussels — nightly TP optimizer...");
  const symbols = [...new Set(closedTrades.map(t => t.symbol).filter(Boolean))];
  for (const sym of symbols) {
    await runTPLockEngine(sym).catch(e => console.error(`❌ [TP nightly] ${sym}:`, e.message));
    await runSLLockEngine(sym).catch(e => console.error(`❌ [SL nightly] ${sym}:`, e.message));
  }
  console.log(`✅ Nightly optimizer klaar — ${symbols.length} symbolen`);
}, { timezone: "Europe/Brussels" });

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
        lots: pos.volume ?? 0.01, riskEUR: RISK[getSymbolType(tvSym)] ?? 30,
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

// ── FOREX ANTI-CONSOLIDATIE ───────────────────────────────────
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
  const key   = `${symbol}_${direction}`;
  const count = openTradeTracker[key] || 0;
  const base  = RISK[getSymbolType(symbol)] || 30;
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

  const baseRisk     = RISK[type] || 30;
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

// ── SL MULTIPLIER TOEPASSEN ───────────────────────────────────
function applySlMultiplier(dir, entry, sl, multiplier) {
  if (!multiplier || multiplier === 1.0) return sl;
  const origDist = Math.abs(entry - sl);
  const newDist  = origDist * multiplier;
  const newSl    = dir === "buy" ? entry - newDist : entry + newDist;
  return parseFloat(newSl.toFixed(5));
}

// ─────────────────────────────────────────────────────────────
// SL ANALYSE HELPER
// ─────────────────────────────────────────────────────────────
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
      const elapsed   = Date.now() - startedAt;
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
          finaliseGhost(ghostId, closedTrade, bestPrice, "sl_breach", startedAt);
          return;
        }
      }

      if (shouldStop) {
        finaliseGhost(ghostId, closedTrade, bestPrice,
          elapsed >= GHOST_DURATION_MS ? "timeout" : "market_closed", startedAt);
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

  const trueMaxRR       = calcMaxRRFromPrice(trade, bestPrice);
  const ghostExtraRR    = parseFloat((trueMaxRR - (trade.maxRR ?? 0)).toFixed(3));
  const ghostDurationMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : null;
  const hitTP           = trade.tp != null && trueMaxRR >= (Math.abs(trade.entry - trade.sl) > 0
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

    // Ghost analyse opslaan in DB
    saveGhostAnalysis({
      symbol:          trade.symbol,
      session:         trade.session,
      direction:       trade.direction,
      entry:           trade.entry,
      sl:              trade.sl,
      tp:              trade.tp,
      maxRRAtClose:    trade.maxRR,
      trueMaxRR,
      ghostExtraRR,
      hitTP,
      ghostStopReason: reason,
      ghostDurationMin,
      ghostFinalizedAt: new Date().toISOString(),
      closedAt:        trade.closedAt,
      realizedPnlEUR:  trade.realizedPnlEUR ?? null,
      tradePositionId: trade.id,
    }).catch(e => console.error(`❌ [DB] ghost analyse:`, e.message));

    console.log(`✅ Ghost ${trade.symbol} → trueMaxRR: ${trueMaxRR}R (extra: ${ghostExtraRR}R) | ${reason}`);
    runTPLockEngine(trade.symbol).catch(e => console.error(`❌ [TP Lock]:`, e.message));
    runSLLockEngine(trade.symbol).catch(e => console.error(`❌ [SL Lock]:`, e.message));
  }
}

// ══════════════════════════════════════════════════════════════
// TP LOCK ENGINE
// [v5.0] TP wordt automatisch gezet zodra EV > 0 (geen min trades)
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

  // [v5.0] Minimaal 3 trades nodig voor berekening, maar GEEN minimum voor activatie
  if (n < 3) return;

  const existing = tpLocks[lockKey];

  const evTable = RR_LEVELS.map(rr => {
    const wins = trades.filter(t => getBestRR(t) >= rr).length;
    const wr   = wins / n;
    return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)) };
  });
  const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a);

  // [v5.0] Sla ook negatieve EV op zodat we weten welke sessies slecht zijn
  // Maar zet alleen TP als EV > 0
  const evPositive = best.ev > 0;

  const oldRR   = existing?.lockedRR ?? null;
  const isNew   = !existing;
  const changed = existing && existing.lockedRR !== best.rr;
  const needsUpdate = existing && (n - existing.lockedTrades) >= 5; // update elke 5 trades

  if (!isNew && !changed && !needsUpdate) {
    tpLocks[lockKey] = { ...existing, lockedTrades: n };
    return;
  }

  const reason = isNew
    ? `eerste lock na ${n} trades [${session}] EV:${evPositive?"positief":"negatief"}`
    : `update na ${n} trades (${oldRR}R → ${best.rr}R) [${session}]`;

  tpLocks[lockKey] = {
    lockedRR:     best.rr,
    lockedAt:     new Date().toISOString(),
    lockedTrades: n,
    session,
    prevRR:       oldRR,
    prevLockedAt: existing?.lockedAt ?? null,
    evAtLock:     best.ev,
    evPositive,
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
  } catch(e) { console.error(`❌ [TP Lock] DB:`, e.message); }

  const status = evPositive ? "✅ ACTIEF" : "⚠️ EV NEGATIEF";
  console.log(`🔒 [TP Lock] ${symbol}/${session}: ${isNew?"NIEUW":"UPDATE"} → ${best.rr}R (EV ${best.ev}R | ${n} trades) [${status}]`);
}

// ══════════════════════════════════════════════════════════════
// SL LOCK ENGINE
// [v5.0] Na ≥50 trades: multiplier wordt écht toegepast
//        Onder 50 trades: blijft READONLY advies
// ══════════════════════════════════════════════════════════════
async function runSLLockEngine(symbol) {
  const trades = closedTrades.filter(t => t.symbol === symbol && t.sl && t.entry);
  const n      = trades.length;
  if (n < 10) return;  // minimaal 10 voor analyse

  const existing  = slLocks[symbol];
  if (existing && (n - (existing.lockedTrades ?? 0)) < 5) return;

  const analysis  = buildSLAnalysis(trades);
  const best      = analysis.reduce((a,b) => b.bestEV > a.bestEV ? b : a);
  const current   = analysis.find(a => a.slMultiple === 1.0);
  const direction = getSLDirection(analysis);

  if (best.bestEV <= 0) {
    console.log(`⚠️ [SL Analyse] ${symbol}: geen positieve EV`);
    return;
  }

  const oldMult    = existing?.multiplier ?? null;
  const isNew      = !existing;
  const changed    = existing && (existing.multiplier !== best.slMultiple || existing.direction !== direction);
  const autoApply  = n >= SL_AUTO_APPLY_THRESHOLD;  // [v5.0] écht toepassen na 50 trades

  if (!isNew && !changed) {
    slLocks[symbol] = { ...existing, lockedTrades: n, autoApplied: autoApply };
    return;
  }

  const reason = isNew
    ? `eerste analyse na ${n} trades [${direction}]${autoApply ? " [AUTO APPLIED]" : " [READONLY]"}`
    : `update na ${n} trades (${oldMult}× → ${best.slMultiple}×)${autoApply ? " [AUTO APPLIED]" : " [READONLY]"}`;

  const appliedAt     = autoApply ? new Date().toISOString() : null;
  const appliedTrades = autoApply ? n : null;

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
    autoApplied:    autoApply,
    appliedAt,
    appliedTrades,
    note:           autoApply
      ? `✅ AUTO APPLIED na ${n} trades (≥${SL_AUTO_APPLY_THRESHOLD})`
      : `⚠️ READONLY — nog ${SL_AUTO_APPLY_THRESHOLD - n} trades tot auto-apply`,
    directionLabel: direction === "up"
      ? "🔼 Vergroot SL"
      : direction === "down"
      ? "🔽 Verklein SL"
      : "✅ Huidig optimaal",
  };

  const logEntry = {
    symbol, oldMultiplier: oldMult, newMultiplier: best.slMultiple, direction,
    trades: n, ev: best.bestEV, reason, autoApplied: autoApply,
    ts: new Date().toISOString(),
  };
  slUpdateLog.unshift(logEntry);
  if (slUpdateLog.length > MAX_SL_LOG) slUpdateLog.length = MAX_SL_LOG;

  try {
    await saveSLConfig(symbol, best.slMultiple, direction, n, best.bestEV,
      parseFloat(best.bestTP), oldMult, existing?.lockedAt ?? null,
      autoApply, appliedAt, appliedTrades);
    await logSLUpdate(symbol, oldMult, best.slMultiple, direction, n, best.bestEV, reason, autoApply);
  } catch(e) { console.error(`❌ [SL Analyse] DB:`, e.message); }

  console.log(`📐 [SL ${autoApply ? "AUTO" : "ADVIES"}] ${symbol}: ${best.slMultiple}× (${direction}) EV +${best.bestEV}R | ${n} trades`);
}

// ── SL MULTIPLIER BEPALEN VOOR WEBHOOK ───────────────────────
function getEffectiveSLMultiplier(symbol, session, entryNum, slNum, direction) {
  const slLock    = slLocks[symbol];
  const tpLockKey = `${symbol}__${session}`;
  const tpLockNow = tpLocks[tpLockKey];
  const tpProven  = tpLockNow && (tpLockNow.evAtLock ?? 0) > 0;

  let multiplier  = 1.0;
  let info        = "geen aanpassing";

  // [v5.0] Auto-apply SL na ≥50 trades
  if (slLock?.autoApplied && slLock.multiplier !== 1.0) {
    multiplier = slLock.multiplier;
    info       = `${multiplier}× (auto-apply na ${slLock.appliedTrades} trades, EV +${slLock.evAtLock}R)`;
    console.log(`📐 [SL Auto] ${symbol}: ${multiplier}× toegepast`);
  }
  // TP bewezen → halveer SL (ongeacht auto-apply)
  else if (tpProven) {
    const proveMult = 0.5;
    multiplier      = proveMult;
    info            = `${proveMult}× (TP bewezen ${symbol}/${session}, EV +${tpLockNow.evAtLock}R)`;
    console.log(`📐 [SL TP-proven] ${symbol}/${session}: ${proveMult}×`);
  }

  const newSL = applySlMultiplier(direction, entryNum, slNum, multiplier);
  return { multiplier, slApplied: newSL, info };
}

// ── POSITION SYNC (30s) ───────────────────────────────────────
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
        const maxRR   = calcMaxRR(trade);
        const session = getSessionGMT1(trade.openedAt);

        // PnL berekenen (approximatie)
        const lotV      = LOT_VALUE[getSymbolType(trade.symbol)] || 1;
        const realizedPnlEUR = trade.currentPnL ?? 0;
        const hitTP     = trade.tp != null && maxRR >= (trade.tp != null
          ? Math.abs((trade.direction==="buy" ? trade.tp-trade.entry : trade.entry-trade.tp) / Math.abs(trade.entry-trade.sl))
          : 999);

        const closed = {
          ...trade, closedAt: new Date().toISOString(), maxRR, session,
          sessionLabel: SESSION_LABELS[session] || session,
          trueMaxRR: null, trueMaxPrice: null,
          realizedPnlEUR, hitTP,
        };
        closedTrades.push(closed);
        saveTrade(closed).catch(e => console.error(`❌ [DB] saveTrade:`, e.message));
        savePnlLog(trade.symbol, session, trade.direction, maxRR, hitTP, realizedPnlEUR)
          .catch(e => console.error(`❌ [DB] pnlLog:`, e.message));
        if (trade.symbol && trade.direction) decrementTracker(trade.symbol, trade.direction);
        delete openPositions[id];
        console.log(`📦 ${trade.symbol} gesloten | MaxRR: ${maxRR}R | PnL: €${realizedPnlEUR} | Sessie: ${session}`);
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
    } catch(e) { console.warn("⚠️ Snapshot mislukt:", e.message); }
  } catch(e) { console.warn("⚠️ syncPositions:", e.message); }
}
setInterval(syncPositions, 30 * 1000);

// ── ORDER PLAATSEN ────────────────────────────────────────────
function learnFromError(symbol, code, msg) {
  const m = (msg||"").toLowerCase();
  if (!learnedPatches[symbol]) learnedPatches[symbol] = {};
  if (code==="TRADE_RETCODE_INVALID" && m.includes("symbol")) {
    const cur  = getMT5Symbol(symbol);
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
  const lockKey   = `${symbol}__${session}`;
  const tpLock    = tpLocks[lockKey];

  // [v5.0] TP altijd zetten als EV positief is voor deze sessie
  const tpEvPositive = tpLock && tpLock.evPositive === true && (tpLock.evAtLock ?? 0) > 0;
  const tpPrice      = tpEvPositive ? calcTPPrice(dir, entry, slPrice, tpLock.lockedRR) : null;

  if (tpPrice)
    console.log(`🔒 [TP Auto] ${symbol}/${session} TP: ${tpPrice} (${tpLock.lockedRR}R EV+${tpLock.evAtLock}R)`);
  else if (tpLock && !tpEvPositive)
    console.log(`⚠️ [TP Skip] ${symbol}/${session} EV negatief (${tpLock.evAtLock}R) — geen TP gezet`);

  const body = {
    symbol:     mt5Symbol,
    volume:     lots,
    actionType: dir==="buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    stopLoss:   slPrice,
    comment:    `FTMO-NV-${dir.toUpperCase()}-${symbol}${tpEvPositive ? `-TP${tpLock.lockedRR}R-${session}` : ""}`,
    ...(tpPrice ? { takeProfit: tpPrice } : {}),
  };

  const r = await fetch(`${META_BASE}/trade`, {
    method: "POST",
    headers: {"Content-Type":"application/json","auth-token":META_API_TOKEN},
    body:   JSON.stringify(body),
  });
  return { result: await r.json(), mt5Symbol, slPrice, body, tpPrice, tpEvPositive };
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
        const reason = `Anti-consolidatie: ${consol.count} open ${direction} trades voor ${symbol}`;
        logForexConsolidation(symbol, direction, consol.count, reason).catch(() => {});
        addWebhookHistory({ type:"FOREX_CONSOLIDATION_BLOCKED", symbol, direction, count:consol.count });
        return res.status(200).json({ status:"SKIP", reason });
      }
      if (consol.halfRisk) { forexHalfRisk = true; }
    }

    // [v5.0] SL multiplier bepalen (auto of advised)
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

    console.log(`📊 ${direction.toUpperCase()} ${symbol}/${curSession} | Entry:${entryNum} SL:${slApplied} (${slMult}×) Lots:${lots} Risk:€${risk.toFixed(2)}`);

    let { result, mt5Symbol, slPrice, tpPrice, tpEvPositive } =
      await placeOrder(direction, symbol, entryNum, slApplied, lots, curSession);

    const errCode = result?.error?.code || result?.retcode;
    const errMsg  = result?.error?.message || result?.comment || "";
    const isError = result?.error || (errCode && errCode!==10009 && errCode!=="TRADE_RETCODE_DONE");

    if (isError) {
      learnFromError(symbol, errCode, errMsg);
      const rl = calcLots(symbol, entryNum, slApplied, risk);
      if (rl !== null) {
        const retry    = await placeOrder(direction, symbol, entryNum, slApplied, rl, curSession);
        result         = retry.result;
        tpPrice        = retry.tpPrice;
        tpEvPositive   = retry.tpEvPositive;
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

    const posId        = String(result?.positionId || result?.orderId || Date.now());
    const tpLockActive = tpLocks[`${symbol}__${curSession}`];

    openPositions[posId] = {
      id: posId, symbol, mt5Symbol, direction,
      entry: entryNum, sl: slPrice, tp: tpPrice, lots,
      riskEUR: risk, openedAt: new Date().toISOString(),
      session: curSession, sessionLabel: SESSION_LABELS[curSession] || curSession,
      maxPrice: entryNum, maxRR: 0, currentPnL: 0, lastSync: null,
      slMultiplierApplied: slMult,
      spreadGuard, forexHalfRisk,
    };

    addWebhookHistory({
      type:"SUCCESS", symbol, mt5Symbol, direction, lots, posId,
      session: curSession, riskEUR: risk.toFixed(2),
      slAanpassing: slLockInfo,
      tp: tpPrice ? `${tpLockActive?.lockedRR}R @ ${tpPrice}` : "geen",
      slAutoApplied: slMult !== 1.0,
    });

    res.json({
      status:"OK", versie:"v5.0",
      direction, tvSymbol:symbol, mt5Symbol, symType,
      session:curSession, sessionLabel:SESSION_LABELS[curSession],
      entry:entryNum, sl:slPrice, slOriginal:slNum,
      slMultiplier:slMult, slLockInfo,
      slAutoApplied: slLocks[symbol]?.autoApplied ?? false,
      slTradesUntilAuto: Math.max(0, SL_AUTO_APPLY_THRESHOLD - (closedTrades.filter(t=>t.symbol===symbol).length)),
      tp: tpPrice,
      tpRR: tpLockActive?.lockedRR ?? null,
      tpEvPositive,
      tpInfo: tpPrice
        ? `✅ TP auto-gezet: ${tpLockActive.lockedRR}R [${curSession}] (EV+${tpLockActive.evAtLock}R) → ${tpPrice}`
        : tpLockActive
          ? `⚠️ TP niet gezet: EV negatief (${tpLockActive.evAtLock}R) voor ${symbol}/${curSession}`
          : `ℹ️ Geen TP lock voor ${symbol}/${curSession} — ghost tracker actief`,
      lots, risicoEUR:risk.toFixed(2),
      forexHalfRisk: forexHalfRisk ? "⚡ 50% risk" : null,
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
    res.json({ status:"OK", result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:"online", versie:"ftmo-v5.0",
    features: {
      tpAutoPerSessie:  "✅ TP automatisch gezet zodra EV > 0 per sessie (geen min trades)",
      slAutoNa50:       `✅ SL multiplier auto-apply na ≥${SL_AUTO_APPLY_THRESHOLD} trades`,
      slReadonlyOnder:  `✅ Onder ${SL_AUTO_APPLY_THRESHOLD} trades: READONLY advies`,
      ghostAnalyse:     "✅ Ghost trades opgeslagen in DB met extra RR, duur, reden",
      pnlLog:           "✅ Win/verlies per sessie/pair bijgehouden",
      dashboardIngebouwd: "✅ Volledig dashboard op /dashboard",
    },
    tracking: {
      openPositions: Object.keys(openPositions).length,
      closedTrades:  closedTrades.length,
      tpLocks:       Object.keys(tpLocks).length,
      slAnalyses:    Object.keys(slLocks).length,
      ghostTrackers: Object.keys(ghostTrackers).length,
    },
    endpoints: {
      "GET  /dashboard":             "Volledig visueel dashboard",
      "GET  /analysis/ghost-deep":   "Ghost trade diepgaande analyse",
      "GET  /analysis/pnl":          "Win/verlies per pair/sessie",
      "GET  /analysis/extremes":     "Grootste winsten en verliezen",
      "POST /webhook":               "TradingView → FTMO MT5",
      "POST /close":                 "Manueel sluiten",
    },
  });
});

// ── LIVE POSITIONS ────────────────────────────────────────────
app.get("/live/positions", (req, res) => {
  res.json({
    count: Object.keys(openPositions).length,
    positions: Object.values(openPositions).map(p => ({
      id:p.id, symbol:p.symbol, direction:p.direction,
      entry:p.entry, sl:p.sl, tp:p.tp, lots:p.lots,
      riskEUR:p.riskEUR, openedAt:p.openedAt,
      session:p.session, currentPrice:p.currentPrice??null,
      currentPnL:p.currentPnL??0, maxRR:p.maxRR??0,
      slMultiplier:p.slMultiplierApplied??1.0,
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
  }));
  res.json({ count:active.length, ghosts:active });
});

// ── GHOST DEEP ANALYSE ────────────────────────────────────────
app.get("/analysis/ghost-deep", async (req, res) => {
  const { symbol, session } = req.query;

  // In-memory analyse
  const finished = closedTrades.filter(t => t.trueMaxRR !== null);
  const pending  = closedTrades.filter(t => t.trueMaxRR === null && t.maxRR > 0);

  // Per pair per sessie
  const bySymSess = {};
  for (const t of finished) {
    const key = `${t.symbol}__${t.session||"?"}`;
    if (!bySymSess[key]) bySymSess[key] = {
      symbol:t.symbol, session:t.session, trades:[], totalExtraRR:0, hitTP:0
    };
    const extraRR = (t.trueMaxRR ?? 0) - (t.maxRR ?? 0);
    bySymSess[key].trades.push({
      extraRR, maxRRAtClose:t.maxRR, trueMaxRR:t.trueMaxRR,
      ghostStopReason:t.ghostStopReason, closedAt:t.closedAt,
    });
    bySymSess[key].totalExtraRR += extraRR;
    if (t.hitTP) bySymSess[key].hitTP++;
  }

  const results = Object.values(bySymSess).map(g => ({
    symbol: g.symbol, session: g.session,
    trades: g.trades.length,
    avgExtraRR: g.trades.length ? parseFloat((g.totalExtraRR / g.trades.length).toFixed(3)) : 0,
    totalExtraRR: parseFloat(g.totalExtraRR.toFixed(3)),
    tpHitRate: g.trades.length ? parseFloat(((g.hitTP / g.trades.length) * 100).toFixed(1)) : 0,
    stopReasons: g.trades.reduce((acc, t) => {
      const r = t.ghostStopReason || "onbekend";
      acc[r] = (acc[r]||0) + 1;
      return acc;
    }, {}),
  })).sort((a,b) => b.avgExtraRR - a.avgExtraRR);

  const totalGhost   = finished.length;
  const avgExtraRR   = totalGhost ? finished.reduce((s,t) => s + ((t.trueMaxRR??0)-(t.maxRR??0)), 0) / totalGhost : 0;
  const bestGhost    = finished.reduce((best, t) => (((t.trueMaxRR??0)-(t.maxRR??0)) > best.extra) ? {extra:(t.trueMaxRR??0)-(t.maxRR??0), sym:t.symbol, sess:t.session} : best, {extra:-Infinity, sym:null, sess:null});

  res.json({
    generated: new Date().toISOString(),
    summary: {
      ghostFinished: totalGhost,
      ghostPending:  pending.length,
      avgExtraRR:    parseFloat(avgExtraRR.toFixed(3)),
      bestGhostPair: bestGhost.sym ? `${bestGhost.sym}/${bestGhost.sess} (+${bestGhost.extra.toFixed(2)}R)` : "—",
    },
    bySymbolSession: results,
    pending: pending.map(t => ({ symbol:t.symbol, session:t.session, maxRR:t.maxRR, closedAt:t.closedAt })),
  });
});

// ── PNL ANALYSE ───────────────────────────────────────────────
app.get("/analysis/pnl", async (req, res) => {
  const { symbol, session } = req.query;

  // Probeer eerst DB
  let stats = [];
  try {
    stats = await loadPnlStats(symbol || null, session || null);
  } catch(e) {
    console.warn("⚠️ PnL DB fallback:", e.message);
  }

  // In-memory als DB leeg
  if (!stats.length) {
    const byKey = {};
    for (const t of closedTrades) {
      if (symbol && t.symbol?.toUpperCase() !== symbol.toUpperCase()) continue;
      if (session && t.session !== session) continue;
      const key = `${t.symbol}__${t.session||"?"}`;
      if (!byKey[key]) byKey[key] = { symbol:t.symbol, session:t.session, trades:[], pnl:[] };
      byKey[key].trades.push(t);
      if (t.realizedPnlEUR != null) byKey[key].pnl.push(t.realizedPnlEUR);
    }
    stats = Object.values(byKey).map(g => {
      const pnls = g.pnl;
      return {
        symbol: g.symbol, session: g.session,
        total: g.trades.length,
        wins: g.trades.filter(t => (t.realizedPnlEUR??0) > 0).length,
        losses: g.trades.filter(t => (t.realizedPnlEUR??0) < 0).length,
        total_pnl:   pnls.reduce((s,v)=>s+v,0),
        best_trade:  pnls.length ? Math.max(...pnls) : null,
        worst_trade: pnls.length ? Math.min(...pnls) : null,
        avg_pnl:     pnls.length ? pnls.reduce((s,v)=>s+v,0)/pnls.length : null,
        avg_rr:      g.trades.reduce((s,t)=>s+(t.trueMaxRR??t.maxRR??0),0)/g.trades.length,
        best_rr:     Math.max(...g.trades.map(t=>t.trueMaxRR??t.maxRR??0)),
        worst_rr:    Math.min(...g.trades.map(t=>t.trueMaxRR??t.maxRR??0)),
        tp_hits:     g.trades.filter(t=>t.hitTP).length,
      };
    }).sort((a,b) => (b.total_pnl??0) - (a.total_pnl??0));
  }

  res.json({
    generated: new Date().toISOString(),
    filters: { symbol:symbol||"alle", session:session||"alle" },
    totalPairs: stats.length,
    data: stats,
  });
});

// ── EXTREMES ANALYSE ──────────────────────────────────────────
app.get("/analysis/extremes", (req, res) => {
  const n = parseInt(req.query.n) || 10;
  const withPnl = closedTrades.filter(t => t.realizedPnlEUR != null);
  const allRR   = closedTrades.filter(t => (t.trueMaxRR ?? t.maxRR) != null);

  const bestPnl  = [...withPnl].sort((a,b) => (b.realizedPnlEUR??0) - (a.realizedPnlEUR??0)).slice(0,n);
  const worstPnl = [...withPnl].sort((a,b) => (a.realizedPnlEUR??0) - (b.realizedPnlEUR??0)).slice(0,n);
  const bestRR   = [...allRR].sort((a,b) => getBestRR(b) - getBestRR(a)).slice(0,n);
  const worstRR  = [...allRR].sort((a,b) => getBestRR(a) - getBestRR(b)).slice(0,n);

  function mapTrade(t) {
    return {
      symbol:t.symbol, session:t.session, direction:t.direction,
      entry:t.entry, sl:t.sl, tp:t.tp,
      maxRR:t.maxRR, trueMaxRR:t.trueMaxRR,
      realizedPnlEUR:t.realizedPnlEUR,
      hitTP:t.hitTP, closedAt:t.closedAt,
    };
  }

  // Sessie statistieken
  const sessSummary = {};
  for (const sess of ["asia","london","ny"]) {
    const st = closedTrades.filter(t => t.session === sess);
    const pnls = st.filter(t => t.realizedPnlEUR != null).map(t => t.realizedPnlEUR);
    sessSummary[sess] = {
      trades: st.length,
      totalPnl: parseFloat(pnls.reduce((s,v)=>s+v,0).toFixed(2)),
      wins: st.filter(t => (t.realizedPnlEUR??0) > 0).length,
      losses: st.filter(t => (t.realizedPnlEUR??0) < 0).length,
      avgRR: st.length ? parseFloat((st.reduce((s,t)=>s+getBestRR(t),0)/st.length).toFixed(2)) : null,
    };
  }

  res.json({
    generated: new Date().toISOString(),
    sessionSummary: sessSummary,
    bestTrades:  bestPnl.map(mapTrade),
    worstTrades: worstPnl.map(mapTrade),
    bestRR:      bestRR.map(mapTrade),
    worstRR:     worstRR.map(mapTrade),
  });
});

// ── TP / SL ENDPOINTS ────────────────────────────────────────
app.get("/tp-locks", (req,res) => {
  const bySym = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (!bySym[sym]) bySym[sym] = {};
    bySym[sym][sess] = lock;
  }
  res.json({ generated:new Date().toISOString(), totalLocks:Object.keys(tpLocks).length, locksBySymbol:bySym });
});

app.get("/sl-locks", (req,res) => {
  res.json({
    generated: new Date().toISOString(),
    note: `Auto-apply na ≥${SL_AUTO_APPLY_THRESHOLD} trades`,
    totalAnalyses: Object.keys(slLocks).length,
    analyses: Object.entries(slLocks).map(([sym,lock]) => ({ symbol:sym, ...lock })),
  });
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

// ══════════════════════════════════════════════════════════════
// DASHBOARD — volledig ingebouwd
// ══════════════════════════════════════════════════════════════
app.get("/dashboard", (req, res) => {
  // Helpers
  const fmt = (v, d=2) => v == null ? "—" : Number(v).toFixed(d);
  const fmtEUR = v => v == null ? "—" : (v >= 0 ? "+" : "") + "€" + Math.abs(v).toFixed(0);
  const evColor = v => v == null ? "#4a6070" : v > 0 ? "#22d18b" : "#f26b62";
  const rrColor = v => v == null ? "#4a6070" : v >= 2 ? "#22d18b" : v >= 1 ? "#2dd4f4" : v >= 0.5 ? "#f0a050" : "#f26b62";
  const pnlColor = v => v == null ? "#4a6070" : v >= 0 ? "#22d18b" : "#f26b62";
  const timeAgo = iso => { if (!iso) return "—"; const m=Math.floor((Date.now()-new Date(iso).getTime())/60000); return m<60?m+"m":m<1440?Math.floor(m/60)+"u":Math.floor(m/1440)+"d"; };
  const sessLabel = s => ({asia:"🌏 Asia",london:"🇬🇧 London",ny:"🗽 NY",buiten_venster:"🌙 Buiten"}[s]||s||"—");

  const now = new Date();
  const brusselsTime = now.toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels",hour12:false});
  const brusselsDate = now.toLocaleDateString("nl-BE", {timeZone:"Europe/Brussels",weekday:"long",year:"numeric",month:"long",day:"numeric"});
  const curSess = getSessionGMT1();

  // Data berekenen
  const DASH_RR = [0.2,0.4,0.6,0.8,1,1.5,2,2.5,3,4,5];
  function bestTP(trades) {
    if (!trades || trades.length < 3) return null;
    let best = { ev:-Infinity, rr:null, wr:null };
    for (const rr of DASH_RR) {
      const wins = trades.filter(t => getBestRR(t) >= rr).length;
      const wr   = wins / trades.length;
      const ev   = parseFloat((wr*rr-(1-wr)).toFixed(3));
      if (ev > best.ev) best = { ev, rr, wr, wins, total:trades.length };
    }
    return best;
  }

  const byPair = {};
  for (const t of closedTrades) {
    const sym = t.symbol || "UNKNOWN";
    if (!byPair[sym]) byPair[sym] = { trades:[], pnlTrades:[], ghost:[] };
    byPair[sym].trades.push(t);
    if (t.realizedPnlEUR != null) byPair[sym].pnlTrades.push(t.realizedPnlEUR);
    if (t.trueMaxRR !== null) byPair[sym].ghost.push(t);
  }

  const pairStats = Object.entries(byPair).map(([sym, d]) => {
    const total    = d.trades.length;
    const globalBest = bestTP(d.trades);
    const totalPnl   = d.pnlTrades.reduce((s,v)=>s+v,0);
    const bestTrade  = d.pnlTrades.length ? Math.max(...d.pnlTrades) : null;
    const worstTrade = d.pnlTrades.length ? Math.min(...d.pnlTrades) : null;
    const avgExtraRR = d.ghost.length
      ? d.ghost.reduce((s,t)=>s+((t.trueMaxRR??0)-(t.maxRR??0)),0)/d.ghost.length : null;
    const tpLockInfo = Object.entries(tpLocks)
      .filter(([k]) => k.startsWith(sym+"__"))
      .map(([k,v]) => ({sess:k.split("__")[1],...v}));
    const slLock = slLocks[sym] || null;
    const sessionBreakdown = ["asia","london","ny"].map(sess => {
      const st   = d.trades.filter(t => t.session === sess);
      const bp   = bestTP(st);
      const lock = tpLocks[`${sym}__${sess}`] || null;
      const pnls = st.filter(t=>t.realizedPnlEUR!=null).map(t=>t.realizedPnlEUR);
      const sessGhost = st.filter(t=>t.trueMaxRR!==null);
      const sessExtra = sessGhost.length ? sessGhost.reduce((s,t)=>s+((t.trueMaxRR??0)-(t.maxRR??0)),0)/sessGhost.length : null;
      return {
        sess, trades:st.length, best:bp, lock,
        totalPnl: pnls.reduce((s,v)=>s+v,0),
        bestTrade: pnls.length?Math.max(...pnls):null,
        worstTrade:pnls.length?Math.min(...pnls):null,
        avgExtraRR: sessExtra,
        ghostFinished:sessGhost.length,
      };
    });
    return { sym, total, globalBest, totalPnl, bestTrade, worstTrade, avgExtraRR, tpLockInfo, slLock, sessionBreakdown };
  }).sort((a,b) => (b.globalBest?.ev??-99)-(a.globalBest?.ev??-99));

  const openPos      = Object.values(openPositions);
  const activeGhosts = Object.entries(ghostTrackers).map(([id,g]) => ({
    id, sym:g.trade.symbol, dir:g.trade.direction, entry:g.trade.entry, sl:g.trade.sl,
    maxRRAtClose:g.trade.maxRR, bestRR:calcMaxRRFromPrice(g.trade, g.bestPrice),
    elapsedMin:Math.round((Date.now()-g.startedAt)/60000),
    session:g.trade.session,
  }));

  // Sessie totalen
  const sessTotals = {};
  for (const sess of ["asia","london","ny"]) {
    const st  = closedTrades.filter(t=>t.session===sess);
    const pnl = st.filter(t=>t.realizedPnlEUR!=null).map(t=>t.realizedPnlEUR);
    sessTotals[sess] = {
      trades:st.length,
      totalPnl:parseFloat(pnl.reduce((s,v)=>s+v,0).toFixed(2)),
      wins:st.filter(t=>(t.realizedPnlEUR??0)>0).length,
      avgRR:st.length?parseFloat((st.reduce((s,t)=>s+getBestRR(t),0)/st.length).toFixed(2)):null,
    };
  }

  // Extremen
  const withPnl = closedTrades.filter(t=>t.realizedPnlEUR!=null).sort((a,b)=>b.realizedPnlEUR-a.realizedPnlEUR);
  const top5Best  = withPnl.slice(0,5);
  const top5Worst = [...withPnl].sort((a,b)=>a.realizedPnlEUR-b.realizedPnlEUR).slice(0,5);

  const totalTrades = closedTrades.length;
  const posEVPairs  = pairStats.filter(p=>(p.globalBest?.ev??-1)>0).length;
  const avgEV       = pairStats.filter(p=>p.globalBest?.ev!=null).reduce((s,p)=>s+p.globalBest.ev,0) /
    (pairStats.filter(p=>p.globalBest?.ev!=null).length||1);
  const totalPnlAll = closedTrades.filter(t=>t.realizedPnlEUR!=null).reduce((s,t)=>s+t.realizedPnlEUR,0);

  // ── CSS ───────────────────────────────────────────────────
  const css = `
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#07090d;--bg1:#0c1018;--bg2:#111820;--bg3:#18212d;--b:#1c2a38;
          --t:#c9d8e8;--t2:#8aa0b4;--t3:#4a6070;--acc:#2dd4f4;--g:#22d18b;--r:#f26b62;
          --o:#f0a050;--pu:#b88ff0;--ye:#e3b341;
          --mono:'JetBrains Mono','Courier New',monospace;--sans:'Segoe UI',system-ui,sans-serif}
    html{scroll-behavior:smooth}
    body{font-family:var(--mono);background:var(--bg);color:var(--t);font-size:13px;line-height:1.5;min-height:100vh}
    a{color:var(--acc);text-decoration:none}
    .top{position:sticky;top:0;z-index:100;background:var(--bg1);border-bottom:1px solid var(--b);
         display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:50px}
    .logo{font-family:var(--sans);font-weight:800;font-size:15px;color:var(--acc);display:flex;align-items:center;gap:8px}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--g);box-shadow:0 0 8px var(--g);animation:blink 2s infinite}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
    .nav{background:var(--bg1);border-bottom:1px solid var(--b);display:flex;gap:0;overflow-x:auto;padding:0 14px}
    .nav a{display:flex;align-items:center;padding:11px 14px;font-size:12px;color:var(--t2);
           border-bottom:2px solid transparent;white-space:nowrap;transition:all .15s;text-decoration:none}
    .nav a:hover{color:var(--t);border-color:var(--b)}
    .page{max-width:1380px;margin:0 auto;padding:20px 16px}
    .sec{margin-bottom:28px}
    .sec-title{font-family:var(--sans);font-size:15px;font-weight:700;color:var(--t);
               margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--b);display:flex;align-items:center;gap:8px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:22px}
    .card{background:var(--bg1);border:1px solid var(--b);border-radius:8px;padding:14px}
    .card .v{font-family:var(--sans);font-size:22px;font-weight:800;line-height:1;margin-bottom:3px}
    .card .l{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em}
    .card .s{font-size:11px;color:var(--t2);margin-top:3px}
    .pair-card{background:var(--bg1);border:1px solid var(--b);border-radius:8px;margin-bottom:10px;overflow:hidden}
    .pair-hdr{display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--bg2);border-bottom:1px solid var(--b);flex-wrap:wrap}
    .pair-sym{font-family:var(--sans);font-weight:800;font-size:14px;color:var(--acc)}
    .badge{font-size:10px;padding:2px 7px;border-radius:10px;font-weight:600;white-space:nowrap}
    .badge-g{background:#0b4e33;color:var(--g)}.badge-r{background:#4f1c18;color:var(--r)}
    .badge-o{background:#4e2c0a;color:var(--o)}.badge-b{background:#0e2a38;color:var(--acc)}
    .badge-y{background:#3a2e00;color:var(--ye)}
    .pair-body{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:0}
    @media(max-width:900px){.pair-body{grid-template-columns:1fr 1fr}}
    @media(max-width:500px){.pair-body{grid-template-columns:1fr}}
    .pair-sec{padding:14px;border-right:1px solid var(--bg)}
    .pair-sec:last-child{border-right:none}
    .pair-sec h4{font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
    .kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--b);font-size:12px}
    .kv:last-child{border-bottom:none}.kv .k{color:var(--t2)}.kv .v{font-weight:600}
    .sess-row{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:4px}
    .sess-box{background:var(--bg3);border-radius:6px;padding:8px;border:1px solid var(--b)}
    .sess-box.locked{border-color:var(--ye)}
    .sess-box .sn{font-size:10px;color:var(--t3);margin-bottom:2px}
    .sess-box .sv{font-size:14px;font-weight:800;font-family:var(--sans)}
    .sess-box .ss{font-size:10px;color:var(--t2)}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{text-align:left;padding:7px 10px;color:var(--t3);font-size:10px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--b);font-weight:600}
    td{padding:7px 10px;border-bottom:1px solid var(--b)}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:var(--bg2)}
    .empty{color:var(--t3);font-size:12px;padding:24px;text-align:center}
    .update-info{font-size:11px;color:var(--t3);padding:7px 20px;background:var(--bg2);border-bottom:1px solid var(--b);text-align:right}
    .sess-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
    .sess-summary-card{background:var(--bg1);border:1px solid var(--b);border-radius:8px;padding:14px}
    .sess-summary-card h3{font-size:12px;color:var(--t2);margin-bottom:10px;font-family:var(--sans)}
    .extremes-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    @media(max-width:700px){.extremes-grid{grid-template-columns:1fr}}
    .extreme-card{background:var(--bg1);border:1px solid var(--b);border-radius:8px;overflow:hidden}
    .extreme-hdr{padding:10px 14px;font-size:12px;font-weight:700}
    .sl-status{padding:8px 12px;border-radius:6px;font-size:11px;margin-top:6px}
    .sl-auto{background:#0b4e33;color:var(--g)}.sl-readonly{background:#3a2a0a;color:var(--o)}
  `;

  // ── PAIR CARDS HTML ───────────────────────────────────────
  function renderPairCard(p, rank) {
    const ev = p.globalBest?.ev;
    const evBadge = ev==null?"badge-o":ev>0?"badge-g":"badge-r";
    const evStr   = ev==null?"Te weinig data":(ev>0?"+":"")+fmt(ev,3)+"R/trade";
    const slDir   = p.slLock?.direction;
    const slText  = slDir==="up"?"↑ SL Groter":slDir==="down"?"↓ SL Kleiner":"= SL Huidig";
    const slBadge = slDir==="down"?"badge-o":slDir==="up"?"badge-g":"badge-b";
    const slAutoApplied = p.slLock?.autoApplied;
    const slTradesLeft  = SL_AUTO_APPLY_THRESHOLD - (p.total);
    const ghostPending  = p.total - byPair[p.sym]?.ghost?.length;

    const sessHtml = ["asia","london","ny"].map(s => {
      const sd   = p.sessionBreakdown.find(x=>x.sess===s);
      const sev  = sd?.best?.ev;
      const lock = sd?.lock;
      return `<div class="sess-box${lock?" locked":""}">
        <div class="sn">${sessLabel(s)}${lock?` 🔒${lock.lockedRR}R`:""}</div>
        <div class="sv" style="color:${evColor(sev)}">${sev!=null?(sev>0?"+":"")+fmt(sev,2)+"R":"—"}</div>
        <div class="ss">${sd?.trades||0}t${sd?.totalPnl?` · ${fmtEUR(sd.totalPnl)}`:""}</div>
        ${sd?.avgExtraRR!=null?`<div class="ss" style="color:var(--pu)">👻 +${fmt(sd.avgExtraRR,2)}R avg</div>`:""}
      </div>`;
    }).join("");

    return `<div class="pair-card">
      <div class="pair-hdr">
        <span style="font-size:10px;color:var(--t3);background:var(--bg3);border-radius:4px;padding:2px 6px">#${rank}</span>
        <span class="pair-sym">${p.sym}</span>
        <span class="badge ${evBadge}">${evStr}</span>
        ${p.slLock?`<span class="badge ${slBadge}">${slText}${slAutoApplied?" ✅ AUTO":" 🔶 ADVIES"}</span>`:""}
        ${ghostPending>0?`<span class="badge badge-b">👻 ${ghostPending} pending</span>`:""}
        <span style="margin-left:auto;font-size:11px;color:var(--t3)">${p.total} trades · ${fmtEUR(p.totalPnl)} PnL</span>
      </div>
      <div class="pair-body">
        <div class="pair-sec">
          <h4>Beste TP (globaal)</h4>
          ${p.globalBest?`
          <div class="kv"><span class="k">TP target</span><span class="v" style="color:var(--acc)">${p.globalBest.rr}R</span></div>
          <div class="kv"><span class="k">EV</span><span class="v" style="color:${evColor(ev)}">${ev>0?"+":""}${fmt(ev,3)}R</span></div>
          <div class="kv"><span class="k">Winrate</span><span class="v">${(p.globalBest.wr*100).toFixed(1)}%</span></div>
          <div class="kv"><span class="k">Wins</span><span class="v">${p.globalBest.wins}/${p.globalBest.total}</span></div>
          <div class="kv"><span class="k">Best trade</span><span class="v" style="color:var(--g)">${fmtEUR(p.bestTrade)}</span></div>
          <div class="kv"><span class="k">Worst trade</span><span class="v" style="color:var(--r)">${fmtEUR(p.worstTrade)}</span></div>
          `:`<div class="empty">Te weinig data (&lt;3 trades)</div>`}
        </div>
        <div class="pair-sec">
          <h4>SL Analyse</h4>
          ${p.slLock?`
          <div class="kv"><span class="k">Multiplier</span><span class="v">${p.slLock.multiplier}×</span></div>
          <div class="kv"><span class="k">Richting</span><span class="v" style="color:${slDir==="up"?"var(--g)":slDir==="down"?"var(--o)":"var(--acc)"}">${slText}</span></div>
          <div class="kv"><span class="k">EV bij lock</span><span class="v" style="color:${evColor(p.slLock.evAtLock)}">${fmt(p.slLock.evAtLock,3)}R</span></div>
          <div class="kv"><span class="k">Trades</span><span class="v">${p.slLock.lockedTrades}/${SL_AUTO_APPLY_THRESHOLD}</span></div>
          <div class="sl-status ${slAutoApplied?"sl-auto":"sl-readonly"}">
            ${slAutoApplied
              ? `✅ AUTO APPLIED — na ${p.slLock.appliedTrades} trades`
              : `⏳ READONLY — nog ${Math.max(0,SL_AUTO_APPLY_THRESHOLD-p.total)} trades`}
          </div>
          `:`<div class="empty">Geen SL analyse<br><small style="color:var(--t3)">min 10 trades nodig</small></div>`}
        </div>
        <div class="pair-sec">
          <h4>Ghost Analyse</h4>
          ${p.avgExtraRR!=null?`
          <div class="kv"><span class="k">Avg extra RR</span><span class="v" style="color:var(--pu)">+${fmt(p.avgExtraRR,3)}R</span></div>
          <div class="kv"><span class="k">Ghost trades</span><span class="v">${byPair[p.sym]?.ghost?.length}/${p.total}</span></div>
          `:`<div class="empty" style="font-size:11px">Ghost data pending</div>`}
          <div class="kv"><span class="k">TP Locks</span><span class="v" style="color:var(--ye)">${p.tpLockInfo.length} sessies</span></div>
          ${p.tpLockInfo.map(l=>`
          <div class="kv"><span class="k" style="color:var(--ye)">🔒 ${sessLabel(l.sess)}</span>
          <span class="v" style="color:${evColor(l.evAtLock)}">${l.lockedRR}R ${l.evPositive?"✅":"❌"}</span></div>
          `).join("")}
        </div>
        <div class="pair-sec">
          <h4>Per Sessie</h4>
          <div class="sess-row">${sessHtml}</div>
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
<title>FTMO PRO v5.0</title>
<style>${css}</style>
</head>
<body>
<div class="top">
  <div class="logo"><div class="dot"></div>FTMO PRO v5.0</div>
  <div style="font-size:11px;color:var(--t3)">📅 ${brusselsDate} &nbsp;⏰ ${brusselsTime} &nbsp;·&nbsp; ${sessLabel(curSess)} &nbsp;·&nbsp; 🔄 60s</div>
</div>
<div class="nav">
  <a href="#overview">📊 Overview</a>
  <a href="#sessions">🕐 Sessies</a>
  <a href="#pairs">📈 Pairs (${pairStats.length})</a>
  <a href="#ghost">👻 Ghost (${activeGhosts.length})</a>
  <a href="#extremes">🏆 Extremen</a>
  <a href="#open">🟢 Open (${openPos.length})</a>
  <a href="#log">📋 Log</a>
</div>
<div class="update-info">Render: ${brusselsTime} &nbsp;·&nbsp; ${totalTrades} trades &nbsp;·&nbsp; ${pairStats.length} pairs &nbsp;·&nbsp; auto-refresh 60s</div>
<div class="page">

  <!-- OVERVIEW -->
  <div class="sec" id="overview">
    <div class="sec-title">📊 Portfolio Overview</div>
    <div class="cards">
      <div class="card"><div class="v" style="color:var(--acc)">${totalTrades}</div><div class="l">Trades in DB</div></div>
      <div class="card"><div class="v">${pairStats.length}</div><div class="l">Pairs</div></div>
      <div class="card"><div class="v" style="color:var(--g)">${posEVPairs}</div><div class="l">Positieve EV</div><div class="s">van ${pairStats.length} pairs</div></div>
      <div class="card"><div class="v" style="color:${avgEV>0?"var(--g)":"var(--r)"}">${avgEV>0?"+":""}${fmt(avgEV,3)}R</div><div class="l">Gemiddelde EV</div></div>
      <div class="card"><div class="v" style="color:${pnlColor(totalPnlAll)}">${fmtEUR(totalPnlAll)}</div><div class="l">Totaal PnL</div></div>
      <div class="card"><div class="v" style="color:var(--o)">${openPos.length}</div><div class="l">Open posities</div></div>
      <div class="card"><div class="v" style="color:var(--pu)">${activeGhosts.length}</div><div class="l">Ghost actief</div></div>
      <div class="card"><div class="v" style="color:var(--ye)">${Object.keys(tpLocks).length}</div><div class="l">TP Locks</div></div>
    </div>
  </div>

  <!-- SESSIES -->
  <div class="sec" id="sessions">
    <div class="sec-title">🕐 Sessie Overzicht</div>
    <div class="sess-summary">
      ${["asia","london","ny"].map(sess => {
        const st = sessTotals[sess];
        return `<div class="sess-summary-card">
          <h3>${sessLabel(sess)}</h3>
          <div class="kv"><span class="k">Trades</span><span class="v">${st.trades}</span></div>
          <div class="kv"><span class="k">Totaal PnL</span><span class="v" style="color:${pnlColor(st.totalPnl)}">${fmtEUR(st.totalPnl)}</span></div>
          <div class="kv"><span class="k">Wins</span><span class="v" style="color:var(--g)">${st.wins}</span></div>
          <div class="kv"><span class="k">Losses</span><span class="v" style="color:var(--r)">${st.trades-st.wins}</span></div>
          <div class="kv"><span class="k">Avg RR</span><span class="v" style="color:${rrColor(st.avgRR)}">${st.avgRR!=null?fmt(st.avgRR)+"R":"—"}</span></div>
        </div>`;
      }).join("")}
    </div>
  </div>

  <!-- PAIRS -->
  <div class="sec" id="pairs">
    <div class="sec-title">📈 Analyse per Pair — EV · Ghost · SL · PnL</div>
    ${pairStats.length ? pairStats.map((p,i) => renderPairCard(p,i+1)).join("") : `<div class="empty">Geen trade data</div>`}
  </div>

  <!-- GHOST -->
  <div class="sec" id="ghost">
    <div class="sec-title">👻 Actieve Ghost Trackers</div>
    ${activeGhosts.length ? `<table>
      <tr><th>Pair</th><th>Dir</th><th>Sessie</th><th>MaxRR bij close</th><th>Beste RR nu</th><th>Elapsed</th></tr>
      ${activeGhosts.map(g => `<tr>
        <td style="color:var(--acc);font-weight:700">${g.sym}</td>
        <td><span class="badge ${g.dir==="buy"?"badge-g":"badge-r"}">${g.dir.toUpperCase()}</span></td>
        <td>${sessLabel(g.session)}</td>
        <td style="color:${rrColor(g.maxRRAtClose)}">${fmt(g.maxRRAtClose)}R</td>
        <td style="color:${rrColor(g.bestRR)}">${fmt(g.bestRR)}R</td>
        <td>${g.elapsedMin}m</td>
      </tr>`).join("")}
    </table>` : `<div class="empty">Geen actieve ghost trackers</div>`}
  </div>

  <!-- EXTREMEN -->
  <div class="sec" id="extremes">
    <div class="sec-title">🏆 Grootste Winsten & Verliezen</div>
    <div class="extremes-grid">
      <div class="extreme-card">
        <div class="extreme-hdr" style="background:#0b4e33;color:var(--g)">🏆 Top 5 Beste Trades (PnL €)</div>
        <table>
          <tr><th>Pair</th><th>Sessie</th><th>RR</th><th>PnL</th></tr>
          ${top5Best.length ? top5Best.map(t => `<tr>
            <td style="color:var(--acc);font-weight:700">${t.symbol}</td>
            <td>${sessLabel(t.session)}</td>
            <td style="color:${rrColor(getBestRR(t))}">${fmt(getBestRR(t))}R</td>
            <td style="color:var(--g);font-weight:700">${fmtEUR(t.realizedPnlEUR)}</td>
          </tr>`).join("") : `<tr><td colspan="4" class="empty">Geen PnL data</td></tr>`}
        </table>
      </div>
      <div class="extreme-card">
        <div class="extreme-hdr" style="background:#4f1c18;color:var(--r)">💸 Top 5 Slechtste Trades (PnL €)</div>
        <table>
          <tr><th>Pair</th><th>Sessie</th><th>RR</th><th>PnL</th></tr>
          ${top5Worst.length ? top5Worst.map(t => `<tr>
            <td style="color:var(--acc);font-weight:700">${t.symbol}</td>
            <td>${sessLabel(t.session)}</td>
            <td style="color:${rrColor(getBestRR(t))}">${fmt(getBestRR(t))}R</td>
            <td style="color:var(--r);font-weight:700">${fmtEUR(t.realizedPnlEUR)}</td>
          </tr>`).join("") : `<tr><td colspan="4" class="empty">Geen PnL data</td></tr>`}
        </table>
      </div>
    </div>
  </div>

  <!-- OPEN -->
  <div class="sec" id="open">
    <div class="sec-title">🟢 Open Posities</div>
    ${openPos.length ? `<table>
      <tr><th>Pair</th><th>Dir</th><th>Sessie</th><th>Entry</th><th>SL</th><th>TP</th><th>Risk €</th><th>Lots</th><th>MaxRR</th><th>SL×</th></tr>
      ${openPos.map(p => `<tr>
        <td style="color:var(--acc);font-weight:700">${p.symbol}</td>
        <td><span class="badge ${p.direction==="buy"?"badge-g":"badge-r"}">${p.direction.toUpperCase()}</span></td>
        <td>${sessLabel(p.session)}</td>
        <td>${fmt(p.entry,4)}</td><td>${fmt(p.sl,4)}</td>
        <td style="color:var(--ye)">${p.tp?fmt(p.tp,4):"—"}</td>
        <td style="color:var(--o)">€${fmt(p.riskEUR,0)}</td>
        <td>${fmt(p.lots,2)}</td>
        <td style="color:${rrColor(p.maxRR)}">${fmt(p.maxRR)}R</td>
        <td>${p.slMultiplierApplied??1}×</td>
      </tr>`).join("")}
    </table>` : `<div class="empty">Geen open posities</div>`}
  </div>

  <!-- LOG -->
  <div class="sec" id="log">
    <div class="sec-title">📋 Recente Webhook Events</div>
    ${webhookHistory.slice(0,20).length ? `<table>
      <tr><th>Tijd</th><th>Type</th><th>Pair</th><th>Dir</th><th>Sessie</th><th>SL×</th><th>TP</th><th>Risk €</th></tr>
      ${webhookHistory.slice(0,20).map(h => `<tr>
        <td style="color:var(--t3)">${timeAgo(h.ts)}</td>
        <td><span class="badge ${h.type==="SUCCESS"?"badge-g":h.type==="ERROR"?"badge-r":"badge-b"}">${h.type||"?"}</span></td>
        <td style="color:var(--acc)">${h.symbol||"—"}</td>
        <td>${h.direction||"—"}</td>
        <td>${sessLabel(h.session)}</td>
        <td>${h.slAutoApplied?"✅ AUTO":"—"}</td>
        <td>${h.tp||"—"}</td>
        <td>${h.riskEUR?"€"+h.riskEUR:"—"}</td>
      </tr>`).join("")}
    </table>` : `<div class="empty">Geen events</div>`}
  </div>

</div>
<a href="#" style="position:fixed;bottom:18px;right:18px;background:var(--acc);color:#000;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.4);text-decoration:none">↑</a>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error:"Route niet gevonden", geprobeerd: req.method+" "+req.originalUrl });
});

// ══════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    console.log("🚀 FTMO Webhook Server v5.0 — opstarten...");
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

    await restoreOpenPositionsFromMT5();

    app.listen(PORT, () => {
      console.log(`✅ Server luistert op port ${PORT}`);
      console.log(`📊 Dashboard: /dashboard`);
      console.log(`🔒 TP auto-apply: zodra EV > 0 per sessie (≥3 trades)`);
      console.log(`📐 SL auto-apply: na ≥${SL_AUTO_APPLY_THRESHOLD} trades`);
    });
  } catch(err) {
    console.error("❌ Startup mislukt:", err.message);
    process.exit(1);
  }
}

start();
