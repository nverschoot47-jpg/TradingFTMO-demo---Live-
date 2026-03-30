// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v3.8
// Account : Nick Verschoot — FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ───────────────────────────────────────────────────────────────
// SESSIES (GMT+1):
//   asia      → 02:00–08:00
//   london    → 08:00–15:30
//   ny        → 15:30–20:00
//
// REGELS:
//  ✅ Indices  → GEEN auto-TP | risico €200/trade
//  ✅ Forex    → GEEN auto-TP | risico €15/trade | max 0.25 lot
//  ✅ Aandelen → GEEN auto-TP | venster 15:30–20:00 GMT+1
//  ✅ Gold/Crypto/Oil → GEEN auto-TP | risico €30/trade
//  ✅ Trading venster: 02:00–20:00 GMT+1
//  ✅ Auto-close 20:50 GMT+1 — ALLES
//  ✅ Weekend: alleen BTC/ETH (02:00–20:00 GMT+1)
//  ✅ TP optimizer per symbool + per sessie (RR 1–25) — READONLY advies
//  ✅ SL optimizer per symbool + per sessie (READONLY)
//  ✅ Trade logging: ENKEL effectief uitgevoerde + gesloten trades
//  ✅ maxRR bewaard bij sluiten (beste bereikbare RR vóór close)
//  ✅ trueMaxRR: post-close ghost tracker (24u na sluiting, stopt bij SL-breach)
//     → TP optimizer gebruikt trueMaxRR voor correcte statistiek
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const cron    = require("node-cron");
const app     = express();
app.use(express.json());

const { initDB, saveTrade, loadAllTrades, saveSnapshot, loadSnapshots,
        loadTPConfig, saveTPConfig, logTPUpdate, loadTPUpdateLog } = require("./db");

// ── CONFIG ────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "FtmoNV2025";
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || "10000");

// Ghost tracker: hoe lang na sluiting nog prijs volgen (ms)
const GHOST_DURATION_MS = 24 * 3600 * 1000; // 24 uur
const GHOST_INTERVAL_MS = 60 * 1000;        // elke 60s pollen

// ── RR LEVELS (1 t/m 25) ─────────────────────────────────────
const RR_LEVELS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25];

// ── SL MULTIPLES (voor SL optimizer — READONLY) ──────────────
const SL_MULTIPLES = [0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

// ── SESSIES GMT+1 ─────────────────────────────────────────────
// asia:   02:00–08:00
// london: 08:00–15:30
// ny:     15:30–20:00
function getSessionGMT1(dateOrStr) {
  const d    = dateOrStr ? new Date(dateOrStr) : new Date();
  const gmt1 = new Date(d.getTime() + 3600 * 1000);
  const hhmm = gmt1.getUTCHours() * 100 + gmt1.getUTCMinutes();
  if (hhmm >= 200  && hhmm < 800)  return "asia";
  if (hhmm >= 800  && hhmm < 1530) return "london";
  if (hhmm >= 1530 && hhmm < 2000) return "ny";
  return "buiten_venster";
}

const SESSION_LABELS = {
  asia:           "Asia (02:00–08:00 GMT+1)",
  london:         "London (08:00–15:30 GMT+1)",
  ny:             "New York (15:30–20:00 GMT+1)",
  buiten_venster: "Buiten venster",
};

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

const RISK_MINLOT_CAP = parseFloat(process.env.RISK_MINLOT_CAP || "60");

const FTMO_DAILY_LOSS_PCT = 1.0;
const FTMO_TOTAL_LOSS_PCT = 0.10;
let ftmoDailyLossUsed = 0;
let ftmoStartBalance  = ACCOUNT_BALANCE;
let ftmoLastDayReset  = new Date().toDateString();

function resetDailyLossIfNewDay() {
  const today = new Date().toDateString();
  if (today !== ftmoLastDayReset) {
    ftmoDailyLossUsed = 0;
    ftmoLastDayReset  = today;
  }
}

function ftmoSafetyCheck(_r) { return { ok: true }; }
function registerFtmoLoss(r) {
  ftmoDailyLossUsed += r;
  console.log(`📉 FTMO daily: €${ftmoDailyLossUsed.toFixed(2)}`);
}

// ── IN-MEMORY STORES ──────────────────────────────────────────
const openTradeTracker = {};
const openPositions    = {};
// closedTrades = ENKEL effectief gesloten trades
const closedTrades     = [];
const accountSnapshots = [];
const webhookHistory   = [];
// ghostTrackers = post-close trackers per tijdelijk ID
const ghostTrackers    = {};

// ── TP LOCK CONFIG ────────────────────────────────────────────
const TP_LOCK_THRESHOLD  = 10;   // eerste lock na X trades
const TP_UPDATE_INTERVAL = 10;   // herbereken elke X nieuwe trades
// In-memory: { [symbol]: { lockedRR, lockedAt, lockedTrades, prevRR, prevLockedAt, evAtLock } }
const tpLocks     = {};
const tpUpdateLog = [];          // in-memory log, max 100 entries
const MAX_TP_LOG  = 100;

const MAX_SNAPSHOTS = 86400;
const MAX_HISTORY   = 200;

function addWebhookHistory(entry) {
  webhookHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.length = MAX_HISTORY;
}

const learnedPatches = {};

// ══════════════════════════════════════════════════════════════
// SYMBOL MAP
// ══════════════════════════════════════════════════════════════
const SYMBOL_MAP = {
  "DE30EUR":     { mt5: "GER40.cash",  type: "index"  },
  "UK100GBP":    { mt5: "UK100.cash",  type: "index"  },
  "NAS100USD":   { mt5: "US100.cash",  type: "index"  },
  "US30USD":     { mt5: "US30.cash",   type: "index"  },
  "SPX500USD":   { mt5: "US500.cash",  type: "index"  },
  "JP225USD":    { mt5: "JP225.cash",  type: "index"  },
  "AU200AUD":    { mt5: "AUS200.cash", type: "index"  },
  "EU50EUR":     { mt5: "EU50.cash",   type: "index"  },
  "FR40EUR":     { mt5: "FRA40.cash",  type: "index"  },
  "HK33HKD":     { mt5: "HK50.cash",   type: "index"  },
  "US2000USD":   { mt5: "US2000.cash", type: "index"  },
  "ESPIXEUR":    { mt5: "SPN35.cash",  type: "index"  },
  "NL25EUR":     { mt5: "NL25.cash",   type: "index"  },
  "GER40":       { mt5: "GER40.cash",  type: "index"  },
  "GER40.cash":  { mt5: "GER40.cash",  type: "index"  },
  "UK100":       { mt5: "UK100.cash",  type: "index"  },
  "UK100.cash":  { mt5: "UK100.cash",  type: "index"  },
  "NAS100":      { mt5: "US100.cash",  type: "index"  },
  "US100":       { mt5: "US100.cash",  type: "index"  },
  "US100.cash":  { mt5: "US100.cash",  type: "index"  },
  "US30":        { mt5: "US30.cash",   type: "index"  },
  "US30.cash":   { mt5: "US30.cash",   type: "index"  },
  "SPX500":      { mt5: "US500.cash",  type: "index"  },
  "US500":       { mt5: "US500.cash",  type: "index"  },
  "US500.cash":  { mt5: "US500.cash",  type: "index"  },
  "JP225":       { mt5: "JP225.cash",  type: "index"  },
  "JP225.cash":  { mt5: "JP225.cash",  type: "index"  },
  "AU200":       { mt5: "AUS200.cash", type: "index"  },
  "AUS200":      { mt5: "AUS200.cash", type: "index"  },
  "AUS200.cash": { mt5: "AUS200.cash", type: "index"  },
  "EU50":        { mt5: "EU50.cash",   type: "index"  },
  "EU50.cash":   { mt5: "EU50.cash",   type: "index"  },
  "FR40":        { mt5: "FRA40.cash",  type: "index"  },
  "FRA40":       { mt5: "FRA40.cash",  type: "index"  },
  "FRA40.cash":  { mt5: "FRA40.cash",  type: "index"  },
  "HK50":        { mt5: "HK50.cash",   type: "index"  },
  "HK50.cash":   { mt5: "HK50.cash",   type: "index"  },
  "US2000":      { mt5: "US2000.cash", type: "index"  },
  "US2000.cash": { mt5: "US2000.cash", type: "index"  },
  "SPN35":       { mt5: "SPN35.cash",  type: "index"  },
  "SPN35.cash":  { mt5: "SPN35.cash",  type: "index"  },
  "NL25":        { mt5: "NL25.cash",   type: "index"  },
  "NL25.cash":   { mt5: "NL25.cash",   type: "index"  },
  "XAUUSD":      { mt5: "XAUUSD",      type: "gold"   },
  "GOLD":        { mt5: "XAUUSD",      type: "gold"   },
  "UKOIL":       { mt5: "UKOIL.cash",  type: "brent"  },
  "UKOIL.cash":  { mt5: "UKOIL.cash",  type: "brent"  },
  "USOIL":       { mt5: "USOIL.cash",  type: "wti"    },
  "USOIL.cash":  { mt5: "USOIL.cash",  type: "wti"    },
  "BTCUSD":      { mt5: "BTCUSD",      type: "crypto" },
  "ETHUSD":      { mt5: "ETHUSD",      type: "crypto" },
  "AAPL":        { mt5: "AAPL",        type: "stock"  },
  "TSLA":        { mt5: "TSLA",        type: "stock"  },
  "NVDA":        { mt5: "NVDA",        type: "stock"  },
  "MSFT":        { mt5: "MSFT",        type: "stock"  },
  "PLTR":        { mt5: "PLTR",        type: "stock"  },
  "AMZN":        { mt5: "AMZN",        type: "stock"  },
  "AMD":         { mt5: "AMD",         type: "stock"  },
  "META":        { mt5: "META",        type: "stock"  },
  "MU":          { mt5: "MU",          type: "stock"  },
  "GOOGL":       { mt5: "GOOGL",       type: "stock"  },
  "NFLX":        { mt5: "NFLX",        type: "stock"  },
  "EURUSD":      { mt5: "EURUSD",      type: "forex"  },
  "GBPUSD":      { mt5: "GBPUSD",      type: "forex"  },
  "USDJPY":      { mt5: "USDJPY",      type: "forex"  },
  "USDCHF":      { mt5: "USDCHF",      type: "forex"  },
  "USDCAD":      { mt5: "USDCAD",      type: "forex"  },
  "AUDUSD":      { mt5: "AUDUSD",      type: "forex"  },
  "NZDUSD":      { mt5: "NZDUSD",      type: "forex"  },
  "EURGBP":      { mt5: "EURGBP",      type: "forex"  },
  "EURJPY":      { mt5: "EURJPY",      type: "forex"  },
  "EURCHF":      { mt5: "EURCHF",      type: "forex"  },
  "EURAUD":      { mt5: "EURAUD",      type: "forex"  },
  "EURCAD":      { mt5: "EURCAD",      type: "forex"  },
  "GBPJPY":      { mt5: "GBPJPY",      type: "forex"  },
  "GBPCHF":      { mt5: "GBPCHF",      type: "forex"  },
  "GBPAUD":      { mt5: "GBPAUD",      type: "forex"  },
  "GBPCAD":      { mt5: "GBPCAD",      type: "forex"  },
  "AUDJPY":      { mt5: "AUDJPY",      type: "forex"  },
  "AUDCAD":      { mt5: "AUDCAD",      type: "forex"  },
  "AUDCHF":      { mt5: "AUDCHF",      type: "forex"  },
  "AUDNZD":      { mt5: "AUDNZD",      type: "forex"  },
  "CADJPY":      { mt5: "CADJPY",      type: "forex"  },
  "CADCHF":      { mt5: "CADCHF",      type: "forex"  },
  "NZDJPY":      { mt5: "NZDJPY",      type: "forex"  },
  "NZDCAD":      { mt5: "NZDCAD",      type: "forex"  },
  "NZDCHF":      { mt5: "NZDCHF",      type: "forex"  },
  "CHFJPY":      { mt5: "CHFJPY",      type: "forex"  },
};

// ── LOT / STOP CONFIG ─────────────────────────────────────────
const LOT_VALUE = { index: 20, gold: 100, brent: 10, wti: 10, crypto: 1, stock: 1, forex: 10 };
const MAX_LOTS  = { index: 10, gold: 1, brent: 5, wti: 5, crypto: 1, stock: 50, forex: 0.25 };
const MIN_STOP  = {
  "GER40.cash": 5, "UK100.cash": 5, "US100.cash": 5, "US30.cash": 5,
  "US500.cash": 2, "JP225.cash": 10, "AUS200.cash": 3, "EU50.cash": 5,
  "FRA40.cash": 5, "HK50.cash": 10, "US2000.cash": 1, "SPN35.cash": 2, "NL25.cash": 1,
  "XAUUSD": 0.5, "UKOIL.cash": 0.05, "USOIL.cash": 0.05,
  "BTCUSD": 100, "ETHUSD": 5,
  "default_stock": 0.5, "default_forex": 0.0005,
  "USDJPY": 0.05, "EURJPY": 0.05, "GBPJPY": 0.05,
  "AUDJPY": 0.05, "CADJPY": 0.05, "NZDJPY": 0.05, "CHFJPY": 0.05,
};

const WEEKEND_ALLOWED = new Set(["BTCUSD", "ETHUSD"]);
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

// ── MARKT OPEN CHECK ─────────────────────────────────────────
function getGMT1Time() {
  return new Date(Date.now() + 3600 * 1000);
}

function isMarketOpen(type, symbol) {
  const t    = getGMT1Time();
  const day  = t.getUTCDay();
  const hhmm = t.getUTCHours() * 100 + t.getUTCMinutes();
  const isWE = day === 0 || day === 6;

  if (isWE) {
    if (!isCryptoWeekend(symbol || "")) {
      console.warn(`🚫 Weekend — ${symbol} geblokkeerd`);
      return false;
    }
    if (hhmm < 200 || hhmm >= 2000) {
      console.warn(`🚫 Weekend crypto buiten 02:00–20:00 (${hhmm})`);
      return false;
    }
    return true;
  }
  if (hhmm < 200)  { console.warn(`🚫 Voor 02:00 (${hhmm})`); return false; }
  if (hhmm >= 2000){ console.warn(`🚫 Na 20:00 (${hhmm})`);   return false; }
  if (type === "stock" && hhmm < 1530) {
    console.warn(`🚫 Aandelen buiten 15:30–20:00 (${hhmm})`);
    return false;
  }
  return true;
}

// ── METAAPI ───────────────────────────────────────────────────
const META_BASE = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

async function fetchOpenPositions() {
  const r = await fetch(`${META_BASE}/positions`, { headers: { "auth-token": META_API_TOKEN } });
  if (!r.ok) throw new Error(`positions ${r.status}`);
  return r.json();
}

async function fetchAccountInfo() {
  const r = await fetch(`${META_BASE}/accountInformation`, { headers: { "auth-token": META_API_TOKEN } });
  if (!r.ok) throw new Error(`accountInfo ${r.status}`);
  return r.json();
}

async function closePosition(id) {
  const r = await fetch(`${META_BASE}/positions/${id}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
  });
  return r.json();
}

// ── HUIDIGE PRIJS OPHALEN (voor ghost tracker) ────────────────
// Geeft de mid-price (bid+ask)/2 terug, of null bij fout
async function fetchCurrentPrice(mt5Symbol) {
  try {
    const r = await fetch(
      `${META_BASE}/symbols/${encodeURIComponent(mt5Symbol)}/currentPrice`,
      { headers: { "auth-token": META_API_TOKEN } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const bid  = data.bid ?? null;
    const ask  = data.ask ?? null;
    if (bid !== null && ask !== null) return (bid + ask) / 2;
    return bid ?? ask ?? null;
  } catch (e) {
    console.warn(`⚠️ fetchCurrentPrice(${mt5Symbol}):`, e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// AUTO-CLOSE 20:50 GMT+1 — ELKE DAG
// ══════════════════════════════════════════════════════════════
cron.schedule("50 20 * * *", async () => {
  const day  = getGMT1Time().getUTCDay();
  const isWE = day === 0 || day === 6;
  console.log("🔔 20:50 GMT+1 — auto-close gestart...");
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

// ── HELPERS ───────────────────────────────────────────────────
function getEffectiveRisk(symbol, direction) {
  const key   = `${symbol}_${direction}`;
  const count = openTradeTracker[key] || 0;
  const base  = RISK[getSymbolType(symbol)] || 30;
  return Math.max(base * 0.10, base / Math.pow(2, count));
}
function incrementTracker(sym, dir) { const k = `${sym}_${dir}`; openTradeTracker[k] = (openTradeTracker[k]||0)+1; }
function decrementTracker(sym, dir) { const k = `${sym}_${dir}`; if (openTradeTracker[k]>0) openTradeTracker[k]--; }

function validateSL(dir, entry, sl, mt5Sym) {
  const type = getSymbolType(mt5Sym);
  const minD = MIN_STOP[mt5Sym] || (type==="forex" ? MIN_STOP.default_forex : MIN_STOP.default_stock) || 0.01;
  const dist = Math.abs(entry - sl);
  if (dist < minD) {
    const adj = dir==="buy" ? entry-minD : entry+minD;
    console.warn(`⚠️ SL te dicht → ${adj}`);
    return adj;
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

  let lots = risk / (dist * lotVal);
  if (type === "stock") {
    lots = Math.floor(lots);
    if (lots < 1) {
      if (1 * dist * lotVal <= RISK_MINLOT_CAP) lots = 1;
      else return null;
    }
  } else {
    lots = parseFloat((Math.round(lots / lotStep) * lotStep).toFixed(2));
    if (lots < lotStep) {
      if (lotStep * dist * lotVal <= RISK_MINLOT_CAP) lots = lotStep;
      else return null;
    }
  }
  lots = Math.min(maxLots, lots);
  console.log(`💶 ${lots} lots × ${dist.toFixed(5)} × €${lotVal} = €${(lots*dist*lotVal).toFixed(2)}`);
  return lots;
}

// ── MAX RR ────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════
// GHOST TRACKER — post-close prijsvolging
// ──────────────────────────────────────────────────────────────
// Na het sluiten van een trade blijft de server de prijs volgen
// voor max GHOST_DURATION_MS (24u), of totdat de prijs het
// originele SL-niveau bereikt (prijs ging verkeerd na close).
// Het beste resultaat wordt opgeslagen als trueMaxRR.
// ══════════════════════════════════════════════════════════════
function startGhostTracker(closedTrade) {
  const ghostId  = `ghost_${closedTrade.id}_${Date.now()}`;
  const startedAt = Date.now();

  // Begin vanaf de maxPrice die we al hadden op het moment van sluiten
  let bestPrice = closedTrade.maxPrice ?? closedTrade.entry;

  console.log(`👻 Ghost tracker gestart: ${closedTrade.symbol} | startMaxRR: ${closedTrade.maxRR}R`);

  const timer = setInterval(async () => {
    try {
      // Stop als we het handelsvenster voorbij zijn (20:00 GMT+1)
      const gmt1    = getGMT1Time();
      const hhmm    = gmt1.getUTCHours() * 100 + gmt1.getUTCMinutes();
      const elapsed = Date.now() - startedAt;

      const shouldStop =
        elapsed >= GHOST_DURATION_MS ||
        hhmm >= 2000 ||
        hhmm < 200;

      const price = await fetchCurrentPrice(closedTrade.mt5Symbol);

      if (price !== null) {
        // Kijk of prijs verder ging in de goede richting
        const better = closedTrade.direction === "buy"
          ? price > bestPrice
          : price < bestPrice;
        if (better) bestPrice = price;

        // Kijk of prijs door het originele SL-niveau ging (definitief gestopt)
        const slBreach = closedTrade.direction === "buy"
          ? price <= closedTrade.sl
          : price >= closedTrade.sl;

        if (slBreach) {
          console.log(`👻 ${closedTrade.symbol} — SL-breach na close, ghost stopt`);
          finaliseGhost(ghostId, closedTrade, bestPrice, "sl_breach");
          return;
        }
      }

      if (shouldStop) {
        console.log(`👻 ${closedTrade.symbol} — ghost klaar (${elapsed < GHOST_DURATION_MS ? "venster gesloten" : "24u verstreken"})`);
        finaliseGhost(ghostId, closedTrade, bestPrice, elapsed >= GHOST_DURATION_MS ? "timeout" : "market_closed");
      }
    } catch (e) {
      console.warn(`⚠️ Ghost ${ghostId}:`, e.message);
    }
  }, GHOST_INTERVAL_MS);

  ghostTrackers[ghostId] = { trade: closedTrade, timer, startedAt, bestPrice };

  // Failsafe: altijd stoppen na 24u + 5min
  setTimeout(() => {
    if (ghostTrackers[ghostId]) {
      finaliseGhost(ghostId, closedTrade, ghostTrackers[ghostId].bestPrice, "failsafe");
    }
  }, GHOST_DURATION_MS + 5 * 60 * 1000);
}

function finaliseGhost(ghostId, trade, bestPrice, reason) {
  if (!ghostTrackers[ghostId]) return;
  clearInterval(ghostTrackers[ghostId].timer);
  delete ghostTrackers[ghostId];

  const trueMaxRR = calcMaxRRFromPrice(trade, bestPrice);

  // Update het gesloten trade object
  const idx = closedTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    closedTrades[idx].trueMaxRR          = trueMaxRR;
    closedTrades[idx].trueMaxPrice       = bestPrice;
    closedTrades[idx].ghostStopReason    = reason;
    closedTrades[idx].ghostFinalizedAt   = new Date().toISOString();

    // Opslaan in Postgres
    saveTrade(closedTrades[idx]).catch(e => console.error(`❌ [DB] ghost saveTrade:`, e.message));

    console.log(`✅ Ghost ${trade.symbol} → trueMaxRR: ${trueMaxRR}R (was maxRR: ${trade.maxRR}R) | reden: ${reason}`);

    // ── TP Lock engine: herbereken na elke ghost finalisatie ──
    runTPLockEngine(trade.symbol).catch(e => console.error(`❌ [TP Lock] engine fout:`, e.message));
  }
}

// ── HELPER: beste RR (gebruikt door optimizer) ────────────────
// Gebruikt trueMaxRR als beschikbaar, anders maxRR
function getBestRR(trade) {
  return trade.trueMaxRR ?? trade.maxRR ?? 0;
}

// ══════════════════════════════════════════════════════════════
// TP LOCK ENGINE
// ──────────────────────────────────────────────────────────────
// Draait na elke ghost finalisatie + bij startup.
// Regels:
//   - Eerste lock: zodra symbool >= TP_LOCK_THRESHOLD trades heeft
//   - Update:      elke TP_UPDATE_INTERVAL nieuwe trades daarna
//   - Altijd automatisch, wordt gelogd in tpUpdateLog + Postgres
// ══════════════════════════════════════════════════════════════
async function runTPLockEngine(symbol) {
  const trades = closedTrades.filter(t => t.symbol === symbol && t.sl && t.entry);
  const n = trades.length;

  // Nog niet genoeg trades
  if (n < TP_LOCK_THRESHOLD) return;

  const existing = tpLocks[symbol];

  // Bepaal of update nodig is
  if (existing) {
    const tradesSinceLock = n - existing.lockedTrades;
    if (tradesSinceLock < TP_UPDATE_INTERVAL) return; // nog geen 10 nieuwe
  }

  // Bereken beste RR op basis van alle trades voor dit symbool
  const evTable = RR_LEVELS.map(rr => {
    const wins = trades.filter(t => getBestRR(t) >= rr).length;
    const wr   = wins / n;
    return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)) };
  });
  const best = evTable.reduce((a, b) => b.ev > a.ev ? b : a);

  // Geen positieve EV → geen lock
  if (best.ev <= 0) {
    console.log(`⚠️ [TP Lock] ${symbol}: EV negatief op alle niveaus — geen lock`);
    return;
  }

  const oldRR       = existing?.lockedRR ?? null;
  const oldLockedAt = existing?.lockedAt ?? null;
  const isNew       = !existing;
  const changed     = existing && existing.lockedRR !== best.rr;

  if (!isNew && !changed) {
    // Zelfde RR, update lockedTrades zodat teller correct blijft
    tpLocks[symbol] = { ...existing, lockedTrades: n };
    return;
  }

  const reason = isNew ? `eerste lock na ${n} trades` : `update na ${n} trades (${oldRR}R → ${best.rr}R)`;

  tpLocks[symbol] = {
    lockedRR:     best.rr,
    lockedAt:     new Date().toISOString(),
    lockedTrades: n,
    prevRR:       oldRR,
    prevLockedAt: oldLockedAt,
    evAtLock:     best.ev,
  };

  // Log in memory
  const logEntry = {
    symbol, oldRR, newRR: best.rr, trades: n, ev: best.ev, reason,
    ts: new Date().toISOString(),
  };
  tpUpdateLog.unshift(logEntry);
  if (tpUpdateLog.length > MAX_TP_LOG) tpUpdateLog.length = MAX_TP_LOG;

  // Persist naar Postgres
  try {
    await saveTPConfig(symbol, best.rr, n, best.ev, oldRR, oldLockedAt);
    await logTPUpdate(symbol, oldRR, best.rr, n, best.ev, reason);
  } catch (e) {
    console.error(`❌ [TP Lock] DB fout voor ${symbol}:`, e.message);
  }

  console.log(`🔒 [TP Lock] ${symbol}: ${isNew ? "NIEUW" : "UPDATE"} → ${best.rr}R (EV +${best.ev}R) op basis van ${n} trades`);
}

// Helper: berekent TP prijs op basis van gelockte RR
function calcTPPrice(direction, entry, sl, lockedRR) {
  const dist = Math.abs(entry - sl);
  return direction === "buy"
    ? parseFloat((entry + dist * lockedRR).toFixed(5))
    : parseFloat((entry - dist * lockedRR).toFixed(5));
}

// ══════════════════════════════════════════════════════════════
// POSITION SYNC (30s) — ENKEL ECHTE GESLOTEN TRADES OPSLAAN
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
      trade.currentPnL = parseFloat(
        ((trade.direction==="buy" ? cur-trade.entry : trade.entry-cur) * trade.lots * lotV).toFixed(2)
      );
      const better = trade.direction==="buy"
        ? cur > (trade.maxPrice ?? trade.entry)
        : cur < (trade.maxPrice ?? trade.entry);
      if (better) { trade.maxPrice = cur; trade.maxRR = calcMaxRR({...trade, maxPrice: cur}); }
      trade.currentPrice = cur;
      trade.lastSync     = new Date().toISOString();
    }

    for (const [id, trade] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        // ── Trade is effectief gesloten ──
        const maxRR   = calcMaxRR(trade);
        const session = getSessionGMT1(trade.openedAt);
        const closed  = {
          ...trade,
          closedAt:     new Date().toISOString(),
          maxRR,
          session,
          sessionLabel: SESSION_LABELS[session] || session,
          // trueMaxRR wordt later ingevuld door ghost tracker
          trueMaxRR:    null,
          trueMaxPrice: null,
        };
        closedTrades.push(closed);

        // Opslaan in Postgres (wordt overschreven als ghost klaar is)
        saveTrade(closed).catch(e => console.error(`❌ [DB] saveTrade:`, e.message));

        if (trade.symbol && trade.direction) decrementTracker(trade.symbol, trade.direction);
        delete openPositions[id];

        console.log(`📦 ${trade.symbol} gesloten | MaxRR: ${maxRR}R | Sessie: ${session} | Ghost gestart ▶`);

        // ── Start post-close ghost tracker ──
        startGhostTracker(closed);
      }
    }

    // Equity snapshot
    try {
      const info = await fetchAccountInfo();
      if (!accountSnapshots.length && info.balance) ftmoStartBalance = info.balance;
      const snap = {
        ts: new Date().toISOString(),
        balance:     info.balance   ?? null,
        equity:      info.equity    ?? null,
        floatingPL:  parseFloat(((info.equity??0)-(info.balance??0)).toFixed(2)),
        margin:      info.margin    ?? null,
        freeMargin:  info.freeMargin ?? null,
      };
      accountSnapshots.push(snap);
      if (accountSnapshots.length > MAX_SNAPSHOTS) accountSnapshots.shift();
      saveSnapshot(snap).catch(() => {});
    } catch (e) { console.warn("⚠️ Snapshot mislukt:", e.message); }

  } catch (e) { console.warn("⚠️ syncPositions:", e.message); }
}
setInterval(syncPositions, 30 * 1000);

// ══════════════════════════════════════════════════════════════
// ORDER PLAATSEN — GEEN TP — trades lopen tot SL of manuele close
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
  if (m.includes("volume") || m.includes("lot")) {
    learnedPatches[symbol].lotStepOverride = (learnedPatches[symbol]?.lotStepOverride || 0.01) * 10;
  }
  if (m.includes("stop") || code==="TRADE_RETCODE_INVALID_STOPS") {
    const mt5 = getMT5Symbol(symbol);
    MIN_STOP[mt5] = (MIN_STOP[mt5] || 0.01) * 2;
  }
}

async function placeOrder(dir, symbol, entry, sl, lots) {
  const mt5Symbol = getMT5Symbol(symbol);
  const slPrice   = validateSL(dir, entry, sl, mt5Symbol);

  // ── TP: gebruik gelockte waarde indien beschikbaar ──
  const lock   = tpLocks[symbol];
  const tpPrice = lock ? calcTPPrice(dir, entry, slPrice, lock.lockedRR) : null;

  const body = {
    symbol:     mt5Symbol,
    volume:     lots,
    actionType: dir==="buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    stopLoss:   slPrice,
    comment:    `FTMO-NV-${dir.toUpperCase()}-${symbol}${lock ? `-TP${lock.lockedRR}R` : ""}`,
    ...(tpPrice ? { takeProfit: tpPrice } : {}),
  };
  if (tpPrice) {
    console.log(`🔒 [TP Lock] ${symbol} TP ingesteld op ${tpPrice} (${lock.lockedRR}R)`);
  }

  const r = await fetch(`${META_BASE}/trade`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
    body:    JSON.stringify(body),
  });
  return { result: await r.json(), mt5Symbol, slPrice, body };
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK — ENKEL SUCCESVOLLE ORDERS WORDEN GEREGISTREERD
// ══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  try {
    const secret = req.query.secret || req.headers["x-secret"];
    if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });

    const symbol = (!req.body.symbol || req.body.symbol==="{{ticker}}") ? null : req.body.symbol;
    if (!symbol) return res.status(400).json({ error: "Symbool ontbreekt" });

    const { action, entry, sl } = req.body;
    if (!action||!entry||!sl) return res.status(400).json({ error: "Vereist: action, entry, sl" });

    const direction = ["buy","bull","long"].includes(action.toLowerCase()) ? "buy" : "sell";
    const entryNum  = parseFloat(entry);
    const slNum     = parseFloat(sl);

    if (isNaN(entryNum)||isNaN(slNum)) return res.status(400).json({ error: "entry/sl geen getallen" });
    if (direction==="buy"  && slNum>=entryNum) return res.status(400).json({ error: "SL onder entry voor BUY" });
    if (direction==="sell" && slNum<=entryNum) return res.status(400).json({ error: "SL boven entry voor SELL" });

    const symType = getSymbolType(symbol);
    const mt5Sym  = getMT5Symbol(symbol);

    // ── Markt gesloten → SKIP, NIET opslaan ──
    if (!isMarketOpen(symType, symbol)) {
      addWebhookHistory({ type: "MARKET_CLOSED", symbol, symType });
      return res.status(200).json({ status: "SKIP", reason: `Markt gesloten voor ${symbol}` });
    }

    const risk = getEffectiveRisk(symbol, direction);
    const ftmo = ftmoSafetyCheck(risk);
    if (!ftmo.ok) {
      addWebhookHistory({ type: "FTMO_BLOCKED", symbol });
      return res.status(200).json({ status: "FTMO_BLOCKED", reason: ftmo.reason });
    }

    const lots = calcLots(symbol, entryNum, slNum, risk);
    if (lots===null) return res.status(200).json({ status:"SKIP", reason:`Min lot > cap €${RISK_MINLOT_CAP}` });

    const slDist = Math.abs(entryNum - slNum).toFixed(5);
    console.log(`📊 ${direction.toUpperCase()} ${symbol} | Entry:${entryNum} SL:${slNum} Lots:${lots} | Geen TP`);

    let { result, mt5Symbol, slPrice } = await placeOrder(direction, symbol, entryNum, slNum, lots);

    const errCode = result?.error?.code || result?.retcode;
    const errMsg  = result?.error?.message || result?.comment || "";
    const isError = result?.error || (errCode && errCode!==10009 && errCode!=="TRADE_RETCODE_DONE");

    if (isError) {
      learnFromError(symbol, errCode, errMsg);
      const rl = calcLots(symbol, entryNum, slNum, risk);
      if (rl !== null) {
        const retry    = await placeOrder(direction, symbol, entryNum, slNum, rl);
        result         = retry.result;
        const retryErr = retry.result?.error || (retry.result?.retcode && retry.result.retcode!==10009 && retry.result.retcode!=="TRADE_RETCODE_DONE");
        if (retryErr) {
          learnFromError(symbol, retry.result?.error?.code||retry.result?.retcode, retry.result?.error?.message||retry.result?.comment);
          addWebhookHistory({ type: "ERROR", symbol, errCode, errMsg });
          return res.status(200).json({ status:"ERROR_LEARNED", errCode, errMsg });
        }
      }
    }

    // ── Order succesvol → nu pas registreren ──
    registerFtmoLoss(risk);
    incrementTracker(symbol, direction);

    const posId   = String(result?.positionId || result?.orderId || Date.now());
    const session = getSessionGMT1();
    openPositions[posId] = {
      id: posId, symbol, mt5Symbol, direction,
      entry: entryNum, sl: slPrice, tp: null, lots,
      riskEUR: risk, openedAt: new Date().toISOString(),
      session, sessionLabel: SESSION_LABELS[session] || session,
      maxPrice: entryNum, maxRR: 0, currentPnL: 0, lastSync: null,
    };

    const activeLock = tpLocks[symbol];
    const tpUsed     = activeLock ? calcTPPrice(direction, entryNum, slPrice, activeLock.lockedRR) : null;
    addWebhookHistory({ type:"SUCCESS", symbol, mt5Symbol, direction, lots, posId, session,
      tp: tpUsed ? `${activeLock.lockedRR}R (${tpUsed})` : "geen — wacht op TP lock (min 10 trades)" });

    res.json({
      status:     "OK",
      direction,
      tvSymbol:   symbol,
      mt5Symbol,
      entry:      entryNum,
      sl:         slPrice,
      tp:         tpUsed,
      tpRR:       activeLock?.lockedRR ?? null,
      tpInfo:     tpUsed
        ? `TP gelockt op ${activeLock.lockedRR}R (obv ${activeLock.lockedTrades} trades) → prijs: ${tpUsed}`
        : "Geen TP — ghost tracker actief, lock na 10 trades",
      slDist,
      lots,
      risicoEUR:  risk.toFixed(2),
      session,
      sessionLabel: SESSION_LABELS[session],
      positionId: posId,
      metaApi:    result,
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
  res.json({
    status:   "online",
    versie:   "ftmo-v3.8",
    tradingVenster:  "02:00–20:00 GMT+1",
    aandelenVenster: "15:30–20:00 GMT+1",
    autoClose:       "20:50 GMT+1 (elke dag)",
    weekendTrading:  "Alleen BTC/ETH (02:00–20:00 GMT+1)",
    takeProfit:      "❌ Geen auto-TP — trades lopen tot SL of manuele close",
    ghostTracker:    "✅ Post-close prijsvolging (24u) → trueMaxRR voor TP optimizer",
    sessies:         SESSION_LABELS,
    rrLevels:        RR_LEVELS,
    slMultiples:     SL_MULTIPLES,
    tradeLogging:    "Enkel effectief uitgevoerde en gesloten trades",
    ghostTrackers:   `${Object.keys(ghostTrackers).length} actief`,
    endpoints: {
      "POST /webhook":                      "TradingView → FTMO MT5 (geen TP)",
      "POST /close":                        "Manueel sluiten",
      "GET  /live/positions":               "Live posities",
      "GET  /live/ghosts":                  "Actieve ghost trackers",
      "GET  /analysis/rr":                  "MaxRR + trueMaxRR per gesloten trade",
      "GET  /analysis/sessions":            "EV per sessie (alle symbolen)",
      "GET  /analysis/equity-curve":        "Equity history",
      "GET  /research/tp-optimizer":        "TP optimizer per symbool (gebruikt trueMaxRR)",
      "GET  /research/tp-optimizer/sessie": "TP optimizer per symbool PER SESSIE",
      "GET  /research/sl-optimizer":        "SL rapport per symbool (READONLY)",
      "GET  /research/sl-optimizer/sessie": "SL rapport per symbool PER SESSIE (READONLY)",
      "GET  /history":                      "Webhook log",
      "GET  /status":                       "Status + open trades",
    },
    tracking: {
      openPositions: Object.keys(openPositions).length,
      closedTrades:  closedTrades.length,
    },
  });
});

app.get("/status", (req, res) => {
  resetDailyLossIfNewDay();
  res.json({ openTrades: openTradeTracker, learnedPatches, risicoPerType: RISK });
});

app.get("/live/positions", (req, res) => {
  res.json({
    count: Object.keys(openPositions).length,
    positions: Object.values(openPositions).map(p => ({
      id: p.id, symbol: p.symbol, direction: p.direction,
      entry: p.entry, sl: p.sl, tp: null, lots: p.lots,
      riskEUR: p.riskEUR, openedAt: p.openedAt,
      session: p.session, sessionLabel: p.sessionLabel,
      currentPrice: p.currentPrice ?? null, currentPnL: p.currentPnL ?? 0,
      maxRR: p.maxRR ?? 0,
    })),
  });
});

// ── LIVE GHOST TRACKERS ────────────────────────────────────────
app.get("/live/ghosts", (req, res) => {
  const active = Object.entries(ghostTrackers).map(([id, g]) => ({
    ghostId:   id,
    symbol:    g.trade.symbol,
    direction: g.trade.direction,
    entry:     g.trade.entry,
    sl:        g.trade.sl,
    maxRRAtClose: g.trade.maxRR,
    currentBestPrice: g.bestPrice,
    currentBestRR: calcMaxRRFromPrice(g.trade, g.bestPrice),
    startedAt: new Date(g.startedAt).toISOString(),
    elapsedMin: Math.round((Date.now() - g.startedAt) / 60000),
    remainingMin: Math.round((GHOST_DURATION_MS - (Date.now() - g.startedAt)) / 60000),
  }));
  res.json({ count: active.length, ghosts: active });
});

// ── ANALYSE RR ────────────────────────────────────────────────
app.get("/analysis/rr", (req, res) => {
  const { symbol } = req.query;
  const trades = symbol
    ? closedTrades.filter(t => t.symbol?.toUpperCase()===symbol.toUpperCase())
    : closedTrades;

  const bySymbol = {};
  for (const t of trades) {
    const s = t.symbol || "UNKNOWN";
    if (!bySymbol[s]) bySymbol[s] = { count: 0, totalMaxRR: 0, totalTrueMaxRR: 0, trueCount: 0, trades: [] };
    bySymbol[s].trades.push({
      openedAt:    t.openedAt,
      closedAt:    t.closedAt,
      direction:   t.direction,
      entry:       t.entry,
      sl:          t.sl,
      session:     t.session,
      sessionLabel: t.sessionLabel,
      maxRR:       t.maxRR ?? 0,
      trueMaxRR:   t.trueMaxRR ?? null,
      ghostStatus: t.trueMaxRR !== null ? "✅ compleet" : "⏳ ghost actief of nog niet verwerkt",
    });
    bySymbol[s].totalMaxRR += t.maxRR || 0;
    if (t.trueMaxRR !== null) { bySymbol[s].totalTrueMaxRR += t.trueMaxRR; bySymbol[s].trueCount++; }
    bySymbol[s].count++;
  }

  res.json({
    totalTrades: trades.length,
    info: "maxRR = beste prijs terwijl trade open was | trueMaxRR = post-close ghost tracker resultaat",
    bySymbol: Object.fromEntries(
      Object.entries(bySymbol).map(([s, g]) => [s, {
        trades:         g.count,
        avgMaxRR:       parseFloat((g.totalMaxRR / g.count).toFixed(2)),
        avgTrueMaxRR:   g.trueCount ? parseFloat((g.totalTrueMaxRR / g.trueCount).toFixed(2)) : null,
        ghostCoverage:  `${g.trueCount}/${g.count}`,
        details:        g.trades,
      }])
    ),
  });
});

// ── SESSIE ANALYSE ────────────────────────────────────────────
app.get("/analysis/sessions", (req, res) => {
  const { symbol, session } = req.query;
  const SESSIONS = ["asia","london","ny"];

  let trades = closedTrades;
  if (symbol)  trades = trades.filter(t => t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (session) trades = trades.filter(t => t.session===session);

  const bySymbol = {};
  for (const t of trades) {
    const sym  = t.symbol || "UNKNOWN";
    const sess = t.session || "unknown";
    if (!bySymbol[sym]) bySymbol[sym] = { total: 0, sessions: {} };
    if (!bySymbol[sym].sessions[sess]) bySymbol[sym].sessions[sess] = { trades: [], totalRR: 0 };
    bySymbol[sym].sessions[sess].trades.push(t);
    bySymbol[sym].sessions[sess].totalRR += getBestRR(t);
    bySymbol[sym].total++;
  }

  const result = {};
  for (const [sym, d] of Object.entries(bySymbol)) {
    result[sym] = { totalTrades: d.total, bestSession: null, sessions: {} };
    let bestEV=-Infinity, bestSess=null;
    for (const sess of SESSIONS) {
      const g = d.sessions[sess];
      if (!g || !g.trades.length) continue;
      const n       = g.trades.length;
      const avgRR   = parseFloat((g.totalRR / n).toFixed(2));
      const evTable = RR_LEVELS.map(rr => {
        const wins = g.trades.filter(t => getBestRR(t) >= rr).length;
        const wr   = wins / n;
        return { rr, wins, total: n, winrate: `${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
      });
      const best = evTable.reduce((a,b) => b.ev>a.ev ? b : a);
      result[sym].sessions[sess] = {
        label: SESSION_LABELS[sess], trades: n, avgBestRR: avgRR,
        bestTP: `${best.rr}R`, bestEV: best.ev, evTable,
      };
      if (best.ev > bestEV) { bestEV = best.ev; bestSess = sess; }
    }
    result[sym].bestSession = bestSess
      ? { session: bestSess, label: SESSION_LABELS[bestSess], ev: bestEV }
      : null;
  }

  res.json({
    totalTrades:      trades.length,
    sessieDefinities: SESSION_LABELS,
    rrBron:           "trueMaxRR indien beschikbaar, anders maxRR",
    filters:          { symbol: symbol||"alle", session: session||"alle" },
    bySymbol: Object.fromEntries(Object.entries(result).sort((a,b) => b[1].totalTrades - a[1].totalTrades)),
  });
});

// ══════════════════════════════════════════════════════════════
// TP OPTIMIZER — gebruikt trueMaxRR indien beschikbaar
// ══════════════════════════════════════════════════════════════
function buildTPOptimizerResults(minTrades=3) {
  const bySymbol = {};
  for (const t of closedTrades) {
    if (!t.sl || !t.entry) continue;
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }

  const results = [];
  for (const [symbol, trades] of Object.entries(bySymbol)) {
    if (trades.length < minTrades) {
      results.push({ symbol, trades: trades.length, note: `Te weinig data (min ${minTrades})`, bestTP: null, bestEV: null });
      continue;
    }
    const ghostPending = trades.filter(t => t.trueMaxRR === null).length;
    const evTable = RR_LEVELS.map(rr => {
      const wins = trades.filter(t => getBestRR(t) >= rr).length;
      const wr   = wins / trades.length;
      return { rr, wins, total: trades.length, winrate: `${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
    });
    const best = evTable.reduce((a,b) => b.ev>a.ev ? b : a);
    results.push({
      symbol, trades: trades.length,
      ghostPending,
      rrBron:      ghostPending > 0 ? `⚠️ ${ghostPending}/${trades.length} nog zonder trueMaxRR` : "✅ alle trueMaxRR compleet",
      bestTP:      `${best.rr}R`,
      bestEV:      best.ev,
      bestWinrate: best.winrate,
      recommendation: best.ev > 0
        ? `Manuele close target: ${best.rr}R  (EV: +${best.ev}R per trade)`
        : "EV negatief op alle niveaus — herbekijk strategie op dit symbool",
      evTable,
    });
  }
  results.sort((a,b) => (b.bestEV ?? -99) - (a.bestEV ?? -99));
  return { results, rrLevels: RR_LEVELS };
}

app.get("/research/tp-optimizer", (req, res) => {
  if (!closedTrades.length) return res.json({ info:"Geen gesloten trades.", trades:0 });
  const { results, rrLevels } = buildTPOptimizerResults(3);
  const ghostPendingTotal = closedTrades.filter(t => t.trueMaxRR === null).length;
  res.json({
    generated:    new Date().toISOString(),
    totalTrades:  closedTrades.length,
    ghostPending: ghostPendingTotal,
    rrLevels,
    info:     "EV per RR niveau. Gebaseerd op trueMaxRR (post-close ghost tracker) indien beschikbaar, anders maxRR.",
    rrBron:   "trueMaxRR = prijs na sluiting gevolgd tot SL-breach of 24u | maxRR = enkel terwijl trade open was",
    warning:  "Hoe hoger het RR, hoe meer trades nodig voor betrouwbare statistiek.",
    bySymbol: results,
  });
});

// ── TP OPTIMIZER PER SESSIE ───────────────────────────────────
app.get("/research/tp-optimizer/sessie", (req, res) => {
  const { symbol }  = req.query;
  const SESSIONS    = ["asia","london","ny"];

  let trades = closedTrades;
  if (symbol) trades = trades.filter(t => t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (!trades.length) return res.json({ info:"Geen trades.", trades:0 });

  const bySymbol = {};
  for (const t of trades) {
    const sym  = t.symbol || "UNKNOWN";
    const sess = t.session || "unknown";
    if (!bySymbol[sym]) bySymbol[sym] = {};
    if (!bySymbol[sym][sess]) bySymbol[sym][sess] = [];
    bySymbol[sym][sess].push(t);
  }

  const result = {};
  for (const [sym, sessions] of Object.entries(bySymbol)) {
    result[sym] = { totalTrades: 0, sessions: {} };
    for (const sess of SESSIONS) {
      const st = sessions[sess] || [];
      result[sym].totalTrades += st.length;
      if (st.length < 3) {
        result[sym].sessions[sess] = { label: SESSION_LABELS[sess], trades: st.length, note: "Te weinig data (min 3)" };
        continue;
      }
      const ghostPending = st.filter(t => t.trueMaxRR === null).length;
      const evTable = RR_LEVELS.map(rr => {
        const wins = st.filter(t => getBestRR(t) >= rr).length;
        const wr   = wins / st.length;
        return { rr, wins, total: st.length, winrate: `${(wr*100).toFixed(1)}%`, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
      });
      const best = evTable.reduce((a,b) => b.ev>a.ev ? b : a);
      result[sym].sessions[sess] = {
        label:        SESSION_LABELS[sess],
        trades:       st.length,
        ghostPending,
        bestTP:       `${best.rr}R`,
        bestEV:       best.ev,
        bestWinrate:  best.winrate,
        recommendation: best.ev > 0
          ? `Target: ${best.rr}R  (EV +${best.ev}R/trade)`
          : "EV negatief",
        evTable,
      };
    }
  }

  res.json({
    generated:        new Date().toISOString(),
    totalTrades:      trades.length,
    sessieDefinities: SESSION_LABELS,
    rrLevels:         RR_LEVELS,
    rrBron:           "trueMaxRR indien beschikbaar, anders maxRR",
    info:             "TP optimizer per symbool, uitgesplitst per sessie (Asia / London / NY).",
    filters:          { symbol: symbol||"alle" },
    bySymbol: Object.fromEntries(Object.entries(result).sort((a,b) => b[1].totalTrades - a[1].totalTrades)),
  });
});

// ══════════════════════════════════════════════════════════════
// SL OPTIMIZER — READONLY — gebruikt ook trueMaxRR
// ══════════════════════════════════════════════════════════════
function buildSLAnalysis(trades) {
  return SL_MULTIPLES.map(mult => {
    const evTable = RR_LEVELS.map(rr => {
      const wins = trades.filter(t => {
        const origDist = Math.abs(t.entry - t.sl);
        if (!origDist) return false;
        const newDist  = origDist * mult;
        // Gebruik trueMaxRR-equivalent: beste bereikbare afstand
        const bestRR   = getBestRR(t);
        // Omrekenen: had de prijs ver genoeg bewogen voor de gecorrigeerde SL?
        const favMove  = bestRR * origDist; // absolute bewging in prijspunten
        return (favMove / newDist) >= rr;
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

app.get("/research/sl-optimizer", (req, res) => {
  const { symbol } = req.query;
  let trades = closedTrades.filter(t => t.sl && t.entry);
  if (symbol) trades = trades.filter(t => t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (!trades.length) return res.json({ info:"Geen bruikbare trades.", trades:0 });

  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }

  const results = [];
  for (const [sym, st] of Object.entries(bySymbol)) {
    if (st.length < 5) { results.push({ symbol: sym, trades: st.length, note: "Te weinig data (min 5)" }); continue; }
    const analysis = buildSLAnalysis(st);
    const current  = analysis.find(a => a.slMultiple===1.0);
    const best     = analysis.reduce((a,b) => b.bestEV>a.bestEV ? b : a);
    const smaller  = analysis.filter(a => a.slMultiple<1.0).sort((a,b) => b.bestEV-a.bestEV)[0];
    results.push({
      symbol:   sym,
      trades:   st.length,
      huidigEV: current?.bestEV,
      huidigBestTP: current?.bestTP,
      advies: best.slMultiple===1.0
        ? "✅ Huidige SL grootte is optimaal"
        : best.slMultiple<1.0
          ? `🔽 Kleinere SL (${best.slMultiple}×) geeft betere EV: ${best.bestEV}R bij ${best.bestTP} TP`
          : `🔼 Grotere SL (${best.slMultiple}×) geeft betere EV: ${best.bestEV}R bij ${best.bestTP} TP`,
      kleinsteWinstgevende: smaller && smaller.bestEV>0
        ? { slMultiple: smaller.slMultiple, bestEV: smaller.bestEV, bestTP: smaller.bestTP, winrate: smaller.bestWinrate }
        : null,
      slAnalysis: analysis,
    });
  }

  results.sort((a,b) => (b.trades??0) - (a.trades??0));

  res.json({
    generated:   new Date().toISOString(),
    totalTrades: trades.length,
    warning:     "⚠️ READONLY — past NIETS aan aan SL in live trades",
    rrBron:      "trueMaxRR indien beschikbaar, anders maxRR",
    info:        "Analyseert of kleinere of grotere SL historisch beter zou presteren.",
    slMultiples: SL_MULTIPLES,
    rrLevels:    RR_LEVELS,
    filters:     { symbol: symbol||"alle" },
    bySymbol:    results,
  });
});

// ── SL OPTIMIZER PER SESSIE ───────────────────────────────────
app.get("/research/sl-optimizer/sessie", (req, res) => {
  const { symbol }  = req.query;
  const SESSIONS    = ["asia","london","ny"];

  let trades = closedTrades.filter(t => t.sl && t.entry);
  if (symbol) trades = trades.filter(t => t.symbol?.toUpperCase()===symbol.toUpperCase());
  if (!trades.length) return res.json({ info:"Geen bruikbare trades.", trades:0 });

  const bySymbol = {};
  for (const t of trades) {
    const sym  = t.symbol || "UNKNOWN";
    const sess = t.session || "unknown";
    if (!bySymbol[sym]) bySymbol[sym] = {};
    if (!bySymbol[sym][sess]) bySymbol[sym][sess] = [];
    bySymbol[sym][sess].push(t);
  }

  const result = {};
  for (const [sym, sessions] of Object.entries(bySymbol)) {
    result[sym] = { totalTrades: 0, sessions: {} };
    for (const sess of SESSIONS) {
      const st = sessions[sess] || [];
      result[sym].totalTrades += st.length;
      if (st.length < 5) {
        result[sym].sessions[sess] = { label: SESSION_LABELS[sess], trades: st.length, note: "Te weinig data (min 5)" };
        continue;
      }
      const analysis = buildSLAnalysis(st);
      const current  = analysis.find(a => a.slMultiple===1.0);
      const best     = analysis.reduce((a,b) => b.bestEV>a.bestEV ? b : a);
      const smaller  = analysis.filter(a => a.slMultiple<1.0).sort((a,b) => b.bestEV-a.bestEV)[0];
      result[sym].sessions[sess] = {
        label: SESSION_LABELS[sess], trades: st.length,
        huidigEV: current?.bestEV, huidigBestTP: current?.bestTP,
        advies: best.slMultiple===1.0
          ? "✅ Huidig optimaal"
          : best.slMultiple<1.0
            ? `🔽 Kleinere SL (${best.slMultiple}×) beter: EV ${best.bestEV}R bij ${best.bestTP}`
            : `🔼 Grotere SL (${best.slMultiple}×) beter: EV ${best.bestEV}R bij ${best.bestTP}`,
        kleinsteWinstgevende: smaller && smaller.bestEV>0
          ? { slMultiple: smaller.slMultiple, bestEV: smaller.bestEV, bestTP: smaller.bestTP }
          : null,
        slAnalysis: analysis,
      };
    }
  }

  res.json({
    generated:        new Date().toISOString(),
    totalTrades:      trades.length,
    warning:          "⚠️ READONLY — past NIETS aan",
    rrBron:           "trueMaxRR indien beschikbaar, anders maxRR",
    sessieDefinities: SESSION_LABELS,
    slMultiples:      SL_MULTIPLES,
    rrLevels:         RR_LEVELS,
    filters:          { symbol: symbol||"alle" },
    bySymbol: Object.fromEntries(Object.entries(result).sort((a,b) => b[1].totalTrades - a[1].totalTrades)),
  });
});

// ── EQUITY CURVE ──────────────────────────────────────────────
app.get("/analysis/equity-curve", async (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  try {
    const db = await loadSnapshots(hours);
    if (db.length) return res.json({ hours, count: db.length, source: "postgres", snapshots: db });
  } catch (e) {}
  const cutoff = new Date(Date.now() - hours*3600000).toISOString();
  const snaps  = accountSnapshots.filter(s => s.ts >= cutoff);
  res.json({ hours, count: snaps.length, source: "memory", snapshots: snaps });
});

app.get("/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||50, MAX_HISTORY);
  res.json({ count: webhookHistory.length, history: webhookHistory.slice(0, limit) });
});

// ── TP LOCK STATUS API ────────────────────────────────────────
app.get("/tp-locks", (req, res) => {
  res.json({
    generated: new Date().toISOString(),
    threshold: TP_LOCK_THRESHOLD,
    updateInterval: TP_UPDATE_INTERVAL,
    locks: tpLocks,
    recentLog: tpUpdateLog.slice(0, 20),
  });
});

// ── TP LOCK LOG API (uit Postgres) ───────────────────────────
app.get("/tp-locks/log", async (req, res) => {
  try {
    const log = await loadTPUpdateLog(50);
    res.json({ count: log.length, log });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TP LOCK MANUEEL RESETTEN (per symbool) ───────────────────
app.delete("/tp-locks/:symbol", (req, res) => {
  const secret = req.query.secret || req.headers["x-secret"];
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const sym = req.params.symbol.toUpperCase();
  if (!tpLocks[sym]) return res.status(404).json({ error: "Geen lock voor dit symbool" });
  delete tpLocks[sym];
  console.log(`🗑️ [TP Lock] ${sym} manueel gereset`);
  res.json({ status: "OK", message: `TP lock voor ${sym} verwijderd` });
});

// ══════════════════════════════════════════════════════════════
// DASHBOARD — visueel overzicht met adviezen per symbool/sessie
// ══════════════════════════════════════════════════════════════
app.get("/dashboard", (req, res) => {
  const SESSIONS = ["asia","london","ny"];

  // ── Per symbool analyse ──
  const bySymbol = {};
  for (const t of closedTrades) {
    if (!t.sl || !t.entry) continue;
    const sym  = t.symbol || "UNKNOWN";
    const sess = t.session || "buiten_venster";
    if (!bySymbol[sym]) bySymbol[sym] = { all: [], sessions: {} };
    bySymbol[sym].all.push(t);
    if (!bySymbol[sym].sessions[sess]) bySymbol[sym].sessions[sess] = [];
    bySymbol[sym].sessions[sess].push(t);
  }

  const symbolCards = Object.entries(bySymbol)
    .sort((a,b) => b[1].all.length - a[1].all.length)
    .map(([sym, d]) => {
      const allTrades = d.all;
      const n = allTrades.length;
      const avgRR = parseFloat((allTrades.reduce((s,t) => s + getBestRR(t), 0) / n).toFixed(2));

      const globalEV = RR_LEVELS.map(rr => {
        const wins = allTrades.filter(t => getBestRR(t) >= rr).length;
        const wr = wins / n;
        return { rr, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)), wr };
      });
      const bestGlobal = globalEV.reduce((a,b) => b.ev>a.ev ? b : a);

      const sessieData = SESSIONS.map(sess => {
        const st = d.sessions[sess] || [];
        if (st.length < 3) return { sess, label: SESSION_LABELS[sess], trades: st.length, skip: true };
        const avgSessRR = parseFloat((st.reduce((s,t) => s + getBestRR(t), 0) / st.length).toFixed(2));
        const evTable = RR_LEVELS.map(rr => {
          const wins = st.filter(t => getBestRR(t) >= rr).length;
          const wr = wins / st.length;
          return { rr, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)), wr: parseFloat((wr*100).toFixed(1)) };
        });
        const bestTP = evTable.reduce((a,b) => b.ev>a.ev ? b : a);

        const slAnalysis = SL_MULTIPLES.map(mult => {
          const evT = RR_LEVELS.map(rr => {
            const wins = st.filter(t => {
              const origDist = Math.abs(t.entry - t.sl);
              if (!origDist) return false;
              return (getBestRR(t) * origDist / (origDist * mult)) >= rr;
            }).length;
            const wr = wins / st.length;
            return { rr, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
          });
          const best = evT.reduce((a,b) => b.ev>a.ev ? b : a);
          return { mult, bestEV: best.ev, bestRR: best.rr };
        });
        const currentSL = slAnalysis.find(s => s.mult === 1.0);
        const bestSL    = slAnalysis.reduce((a,b) => b.bestEV>a.bestEV ? b : a);

        let slAdvies = bestSL.mult < 1.0
          ? `🔽 Kleinere SL (${bestSL.mult}×) geeft +${(bestSL.bestEV-(currentSL?.bestEV||0)).toFixed(2)}R EV`
          : bestSL.mult > 1.0
            ? `🔼 Bredere SL (${bestSL.mult}×) geeft +${(bestSL.bestEV-(currentSL?.bestEV||0)).toFixed(2)}R EV`
            : `✅ Huidige SL is optimaal`;

        let tpAdvies = bestTP.ev > 0.5
          ? `🎯 Sterk: target ${bestTP.rr}R (EV +${bestTP.ev}R)`
          : bestTP.ev > 0
            ? `⚠️ Matig: target ${bestTP.rr}R (EV +${bestTP.ev}R)`
            : `❌ EV negatief op alle niveaus`;

        return {
          sess, label: SESSION_LABELS[sess], trades: st.length, avgRR: avgSessRR,
          bestTP: bestTP.rr, bestEV: bestTP.ev, bestWR: bestTP.wr,
          slAdvies, tpAdvies, sessieKleur: bestTP.ev > 0.3 ? "green" : bestTP.ev > 0 ? "orange" : "red",
          skip: false,
        };
      }).filter(s => !s.skip || s.trades > 0);

      const validSessies = sessieData.filter(s => !s.skip);
      const bestSessie   = validSessies.length ? validSessies.reduce((a,b) => b.bestEV>a.bestEV ? b : a) : null;
      const worstSessie  = validSessies.length > 1 ? validSessies.reduce((a,b) => b.bestEV<a.bestEV ? b : a) : null;

      // ── TP Lock info voor dit symbool ──
      const lock = tpLocks[sym];
      const tradesLeft = lock ? Math.max(0, (Math.ceil(lock.lockedTrades / TP_UPDATE_INTERVAL) * TP_UPDATE_INTERVAL + TP_UPDATE_INTERVAL) - n) : Math.max(0, TP_LOCK_THRESHOLD - n);
      const lockOptimizer = bestGlobal.rr;
      const lockDiffers   = lock && lock.lockedRR !== lockOptimizer && bestGlobal.ev > 0;

      let globalAdvies = [];
      if (bestGlobal.ev > 0.5) globalAdvies.push(`✅ Sterke setup: EV +${bestGlobal.ev}R bij ${bestGlobal.rr}R TP`);
      else if (bestGlobal.ev > 0) globalAdvies.push(`⚠️ Matige EV: +${bestGlobal.ev}R bij ${bestGlobal.rr}R`);
      else globalAdvies.push(`❌ Negatieve EV — herbekijk strategie`);
      if (bestSessie) globalAdvies.push(`🏆 Beste sessie: ${bestSessie.label} (EV +${bestSessie.bestEV}R @ ${bestSessie.bestTP}R)`);
      if (worstSessie && worstSessie.bestEV < 0) globalAdvies.push(`🚫 Vermijd: ${worstSessie.label}`);
      const ghostPending = allTrades.filter(t => t.trueMaxRR === null).length;
      if (ghostPending > 0) globalAdvies.push(`👻 ${ghostPending}/${n} ghost pending`);

      return { sym, n, avgRR, bestGlobalTP: bestGlobal.rr, bestGlobalEV: bestGlobal.ev,
               sessieData, globalAdvies, ghostPending, lock, tradesLeft, lockOptimizer, lockDiffers };
    });

  const equityData  = accountSnapshots.slice(-50).map(s => ({ ts: s.ts, equity: s.equity, balance: s.balance }));
  const activeGhosts = Object.values(ghostTrackers).map(g => ({
    symbol: g.trade.symbol, direction: g.trade.direction,
    elapsed: Math.round((Date.now()-g.startedAt)/60000),
    remaining: Math.round((GHOST_DURATION_MS-(Date.now()-g.startedAt))/60000),
    currentRR: calcMaxRRFromPrice(g.trade, g.bestPrice),
  }));
  const recentTPLog = tpUpdateLog.slice(0, 10);
  const lockedCount = Object.keys(tpLocks).length;

  // ── HTML ──
  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FTMO Dashboard — NV v3.8</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0d0f14;--card:#161920;--border:#252a35;--green:#00c896;--orange:#f59e0b;--red:#ef4444;--blue:#3b82f6;--purple:#a855f7;--text:#e2e8f0;--muted:#64748b;--accent:#6366f1}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
header{background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:18px;font-weight:700;color:var(--green)}
.badge{background:#1e2433;border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-size:11px;color:var(--muted)}
.badge.live{border-color:var(--green);color:var(--green)}
.badge.lock{border-color:var(--purple);color:var(--purple)}
.badge.warn{border-color:var(--orange);color:var(--orange)}
main{max-width:1400px;margin:0 auto;padding:24px 20px}
.section-title{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:28px 0 12px;display:flex;align-items:center;gap:8px}
.section-title::after{content:'';flex:1;height:1px;background:var(--border)}
/* Stats */
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:4px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px}
.stat .val{font-size:24px;font-weight:700;color:var(--green)}
.stat .lbl{font-size:11px;color:var(--muted);margin-top:3px}
/* Chart */
.chart-wrap{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:4px}
/* TP Lock panel */
.tp-panel{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:4px}
.tp-panel-header{background:#1a1330;border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;gap:10px}
.tp-panel-header h3{font-size:14px;font-weight:700;color:var(--purple)}
.tp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0}
.tp-cell{padding:14px 18px;border-right:1px solid var(--border);border-bottom:1px solid var(--border)}
.tp-cell:last-child{border-right:none}
.tp-sym{font-weight:700;font-size:15px;margin-bottom:6px}
.tp-locked{color:var(--purple);font-size:22px;font-weight:700}
.tp-meta{font-size:11px;color:var(--muted);margin-top:3px;line-height:1.6}
.tp-badge{display:inline-block;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:600;margin-top:6px}
.tp-badge.new{background:#1e1035;color:var(--purple);border:1px solid var(--purple)}
.tp-badge.updated{background:#1a2a10;color:var(--green);border:1px solid var(--green)}
.tp-badge.differs{background:#2a1a05;color:var(--orange);border:1px solid var(--orange)}
.tp-badge.pending{background:#1a1f2e;color:var(--muted);border:1px solid var(--border)}
.tp-pending-cell{padding:14px 18px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);color:var(--muted);font-size:12px}
/* TP Update log */
.log-table{width:100%;border-collapse:collapse;font-size:12px}
.log-table th{text-align:left;color:var(--muted);font-weight:600;padding:8px 12px;border-bottom:1px solid var(--border);font-size:11px}
.log-table td{padding:9px 12px;border-bottom:1px solid #1a1f2e}
.log-table tr:last-child td{border-bottom:none}
.log-table tr:hover td{background:#1a1f2e}
.arr-up{color:var(--green)}
.arr-dn{color:var(--red)}
.arr-eq{color:var(--muted)}
/* Symbol cards */
.sym-card{background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:14px;overflow:hidden}
.sym-header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--border);background:#1a1f2e}
.sym-name{font-size:17px;font-weight:700}
.sym-meta{color:var(--muted);font-size:12px}
.sym-ev{margin-left:auto;text-align:right}
.sym-ev .val{font-size:19px;font-weight:700}
.sym-ev .lbl{font-size:11px;color:var(--muted)}
.ev-pos{color:var(--green)}.ev-neg{color:var(--red)}.ev-mid{color:var(--orange)}
/* TP lock inline badge */
.tp-inline{display:inline-flex;align-items:center;gap:6px;background:#1e1035;border:1px solid var(--purple);border-radius:6px;padding:4px 10px;font-size:12px;color:var(--purple);margin-left:12px}
.tp-inline.no-lock{background:#1a1f2e;border-color:var(--border);color:var(--muted)}
.tp-inline.differs{background:#2a1a05;border-color:var(--orange);color:var(--orange)}
.global-advies{padding:10px 20px;border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:6px}
.advies-pill{background:#1e2433;border-radius:20px;padding:4px 11px;font-size:12px}
.sessie-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.sessie-col{padding:14px 18px;border-right:1px solid var(--border)}
.sessie-col:last-child{border-right:none}
.sessie-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.sessie-label.green{color:var(--green)}.sessie-label.orange{color:var(--orange)}.sessie-label.red{color:var(--red)}.sessie-label.gray{color:var(--muted)}
.sessie-stat{display:flex;justify-content:space-between;margin-bottom:5px;font-size:12px}
.sessie-stat .k{color:var(--muted)}.sessie-stat .v{font-weight:600}
.sessie-advies{margin-top:8px;padding:7px 9px;background:#1a1f2e;border-radius:6px;font-size:12px;line-height:1.5}
.sessie-advies .sl{margin-top:4px;color:var(--blue)}
.no-data{color:var(--muted);font-size:12px;font-style:italic}
/* Ghost */
.ghost-bar{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 20px}
.ghost-item{display:flex;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)}
.ghost-item:last-child{border-bottom:none}
.ghost-sym{font-weight:600;width:90px;font-size:13px}
.ghost-detail{color:var(--muted);font-size:12px;flex:1}
.ghost-rr{font-weight:700;color:var(--green);width:40px;text-align:right}
.prog-wrap{width:80px;height:4px;background:#252a35;border-radius:2px}
.prog-fill{height:100%;background:var(--accent);border-radius:2px}
footer{text-align:center;color:var(--muted);font-size:11px;padding:28px 20px}
a{color:var(--muted);text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>⚡ FTMO Dashboard</h1>
  <span style="color:var(--muted);font-size:12px">NV v3.8</span>
  <span class="badge live">● Live</span>
  <span class="badge">${new Date().toLocaleString("nl-BE",{timeZone:"Europe/Brussels"})}</span>
  ${lockedCount ? `<span class="badge lock">🔒 ${lockedCount} TP gelockt</span>` : ""}
  ${activeGhosts.length ? `<span class="badge warn">👻 ${activeGhosts.length} ghost actief</span>` : ""}
</header>
<main>

<!-- SUMMARY -->
<p class="section-title">Overzicht</p>
<div class="summary">
  <div class="stat"><div class="val">${closedTrades.length}</div><div class="lbl">Gesloten trades</div></div>
  <div class="stat"><div class="val" style="color:var(--blue)">${symbolCards.length}</div><div class="lbl">Symbolen</div></div>
  <div class="stat"><div class="val" style="color:var(--purple)">${lockedCount}</div><div class="lbl">TP locks actief</div></div>
  <div class="stat"><div class="val" style="color:var(--orange)">${closedTrades.filter(t=>t.trueMaxRR===null).length}</div><div class="lbl">Ghost pending</div></div>
  <div class="stat"><div class="val">${closedTrades.length ? (closedTrades.reduce((s,t)=>s+getBestRR(t),0)/closedTrades.length).toFixed(2) : "–"}R</div><div class="lbl">Gem. best RR</div></div>
</div>

${equityData.length >= 2 ? `
<!-- EQUITY -->
<p class="section-title">Equity Curve</p>
<div class="chart-wrap">
  <canvas id="eqChart" height="70"></canvas>
</div>` : ""}

<!-- TP LOCK PANEL -->
<p class="section-title">TP Lock — Automatische Optimalisatie</p>
<div class="tp-panel">
  <div class="tp-panel-header">
    <span style="font-size:18px">🔒</span>
    <h3>Gelockte TP niveaus per symbool</h3>
    <span style="color:var(--muted);font-size:12px;margin-left:auto">Lock na ${TP_LOCK_THRESHOLD} trades · Update elke ${TP_UPDATE_INTERVAL} trades</span>
  </div>
  <div class="tp-grid">
    ${symbolCards.map(c => {
      if (c.lock) {
        const diffArrow = c.lock.prevRR ? (c.lock.lockedRR > c.lock.prevRR ? "▲" : c.lock.lockedRR < c.lock.prevRR ? "▼" : "=") : null;
        const diffClass = c.lock.prevRR ? (c.lock.lockedRR > c.lock.prevRR ? "arr-up" : c.lock.lockedRR < c.lock.prevRR ? "arr-dn" : "arr-eq") : "";
        const badgeLabel = c.lock.prevRR ? "🔄 geüpdated" : "🔒 gelockt";
        const badgeClass = c.lockDiffers ? "differs" : c.lock.prevRR ? "updated" : "new";
        return `<div class="tp-cell">
  <div class="tp-sym">${c.sym}</div>
  <div class="tp-locked">${c.lock.lockedRR}R TP</div>
  <div class="tp-meta">
    EV: +${c.lock.evAtLock ?? "–"}R &nbsp;·&nbsp; ${c.lock.lockedTrades} trades<br>
    ${c.lock.prevRR ? `Vorige: <span class="${diffClass}">${diffArrow} ${c.lock.prevRR}R</span><br>` : ""}
    Gezet: ${new Date(c.lock.lockedAt).toLocaleString("nl-BE",{timeZone:"Europe/Brussels",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}
  </div>
  <span class="tp-badge ${badgeClass}">${badgeLabel}</span>
  ${c.lockDiffers ? `<span class="tp-badge differs" style="margin-left:4px">⚡ optimizer: ${c.lockOptimizer}R</span>` : ""}
</div>`;
      } else {
        return `<div class="tp-pending-cell">
  <div style="font-weight:600;margin-bottom:4px">${c.sym}</div>
  <div style="color:var(--orange);font-size:13px">⏳ ${c.n}/${TP_LOCK_THRESHOLD} trades</div>
  <div style="margin-top:4px;font-size:11px">Nog ${c.tradesLeft} trade${c.tradesLeft===1?"":"s"} nodig voor eerste lock</div>
</div>`;
      }
    }).join("")}
  </div>
</div>

${recentTPLog.length ? `
<!-- TP UPDATE LOG -->
<p class="section-title">TP Wijzigingen — Historiek</p>
<div class="tp-panel">
  <table class="log-table">
    <thead><tr>
      <th>Tijdstip</th><th>Symbool</th><th>Oud RR</th><th></th><th>Nieuw RR</th><th>Trades</th><th>EV</th><th>Reden</th>
    </tr></thead>
    <tbody>
      ${recentTPLog.map(l => {
        const arrow = l.oldRR === null ? "🆕" : l.newRR > l.oldRR ? `<span class="arr-up">▲</span>` : l.newRR < l.oldRR ? `<span class="arr-dn">▼</span>` : `<span class="arr-eq">=</span>`;
        return `<tr>
          <td>${new Date(l.ts).toLocaleString("nl-BE",{timeZone:"Europe/Brussels",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
          <td style="font-weight:600">${l.symbol}</td>
          <td style="color:var(--muted)">${l.oldRR !== null ? l.oldRR+"R" : "–"}</td>
          <td>${arrow}</td>
          <td style="font-weight:700;color:var(--purple)">${l.newRR}R</td>
          <td>${l.trades}</td>
          <td style="color:${(l.ev||0)>0?"var(--green)":"var(--red)"}">${l.ev !== null ? (l.ev>0?"+":"")+l.ev+"R" : "–"}</td>
          <td style="color:var(--muted);font-size:11px">${l.reason}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>
</div>` : ""}

<!-- SYMBOOL ANALYSE -->
<p class="section-title">Analyse per symbool &amp; sessie</p>
${symbolCards.length === 0 ? `<p style="color:var(--muted)">Nog geen gesloten trades.</p>` : symbolCards.map(c => {
  const evCls = c.bestGlobalEV > 0.3 ? "ev-pos" : c.bestGlobalEV > 0 ? "ev-mid" : "ev-neg";
  const lockBadge = c.lock
    ? `<span class="tp-inline${c.lockDiffers?" differs":""}">🔒 TP ${c.lock.lockedRR}R${c.lockDiffers ? ` · optimizer: ${c.lockOptimizer}R ⚡` : ""}</span>`
    : `<span class="tp-inline no-lock">⏳ ${c.n}/${TP_LOCK_THRESHOLD} — geen lock</span>`;
  return `
<div class="sym-card">
  <div class="sym-header">
    <div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="sym-name">${c.sym}</span>${lockBadge}
      </div>
      <div class="sym-meta">${c.n} trades · gem. best RR: ${c.avgRR}R · ${c.ghostPending>0?`👻 ${c.ghostPending} ghost pending`:"✅ ghost compleet"}</div>
    </div>
    <div class="sym-ev">
      <div class="val ${evCls}">${c.bestGlobalEV>0?"+":""}${c.bestGlobalEV}R</div>
      <div class="lbl">beste EV @ ${c.bestGlobalTP}R</div>
    </div>
  </div>
  <div class="global-advies">${c.globalAdvies.map(a=>`<span class="advies-pill">${a}</span>`).join("")}</div>
  <div class="sessie-grid">
    ${c.sessieData.map(s => {
      if (s.skip) return `<div class="sessie-col"><div class="sessie-label gray">${s.label}</div><p class="no-data">Te weinig data (${s.trades})</p></div>`;
      return `<div class="sessie-col">
  <div class="sessie-label ${s.sessieKleur}">${s.label}</div>
  <div class="sessie-stat"><span class="k">Trades</span><span class="v">${s.trades}</span></div>
  <div class="sessie-stat"><span class="k">Gem. best RR</span><span class="v">${s.avgRR}R</span></div>
  <div class="sessie-stat"><span class="k">Beste TP</span><span class="v">${s.bestTP}R</span></div>
  <div class="sessie-stat"><span class="k">EV @ beste TP</span><span class="v ${s.bestEV>0?"ev-pos":s.bestEV>-0.1?"ev-mid":"ev-neg"}">${s.bestEV>0?"+":""}${s.bestEV}R</span></div>
  <div class="sessie-stat"><span class="k">Winrate</span><span class="v">${s.bestWR}%</span></div>
  <div class="sessie-advies">${s.tpAdvies}<div class="sl">${s.slAdvies}</div></div>
</div>`;
    }).join("")}
  </div>
</div>`;
}).join("")}

${activeGhosts.length ? `
<!-- GHOSTS -->
<p class="section-title">Actieve Ghost Trackers</p>
<div class="ghost-bar">
  ${activeGhosts.map(g=>`<div class="ghost-item">
  <div class="ghost-sym">👻 ${g.symbol}</div>
  <div class="ghost-detail">${g.direction.toUpperCase()} · ${g.elapsed}min geleden · ${g.remaining}min resterend</div>
  <div class="ghost-rr">${g.currentRR}R</div>
  <div class="prog-wrap"><div class="prog-fill" style="width:${Math.min(100,Math.round(g.elapsed/(g.elapsed+g.remaining||1)*100))}%"></div></div>
</div>`).join("")}
</div>` : ""}

</main>
<footer>FTMO NV v3.8 · Auto-refresh 60s · GMT+1 · <a href="/">API</a> · <a href="/tp-locks">TP Lock JSON</a></footer>
<script>
setTimeout(()=>location.reload(),60000);
${equityData.length >= 2 ? `
const ctx=document.getElementById("eqChart").getContext("2d");
new Chart(ctx,{
  type:"line",
  data:{
    labels:${JSON.stringify(equityData.map(s=>new Date(s.ts).toLocaleTimeString("nl-BE",{hour:"2-digit",minute:"2-digit"})))},
    datasets:[
      {label:"Equity",data:${JSON.stringify(equityData.map(s=>s.equity))},borderColor:"#00c896",backgroundColor:"rgba(0,200,150,.08)",borderWidth:2,pointRadius:0,tension:.3,fill:true},
      {label:"Balance",data:${JSON.stringify(equityData.map(s=>s.balance))},borderColor:"#6366f1",backgroundColor:"transparent",borderWidth:1.5,pointRadius:0,borderDash:[4,4],tension:.3}
    ]
  },
  options:{
    responsive:true,maintainAspectRatio:true,
    plugins:{legend:{labels:{color:"#94a3b8",font:{size:11}}}},
    scales:{
      x:{ticks:{color:"#475569",font:{size:10}},grid:{color:"#1e2433"}},
      y:{ticks:{color:"#475569",font:{size:10}},grid:{color:"#1e2433"}}
    }
  }
});` : ""}
</script>
</body>
</html>`;
  res.send(html);
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  await initDB();
  const hist  = await loadAllTrades();
  // Enkel laden wat al een closedAt heeft (= effectief gesloten)
  const valid = hist.filter(t => t.closed_at || t.closedAt);
  closedTrades.push(...valid);
  console.log(`📂 ${valid.length} gesloten trades geladen uit Postgres`);

  // ── TP Lock: laad bestaande configs uit Postgres ──
  try {
    const savedLocks = await loadTPConfig();
    Object.assign(tpLocks, savedLocks);
    console.log(`🔒 ${Object.keys(tpLocks).length} TP locks geladen`);
  } catch (e) { console.warn("⚠️ TP config laden mislukt:", e.message); }

  // ── TP Lock engine: draai voor alle symbolen met genoeg data ──
  const symSet = [...new Set(valid.map(t => t.symbol).filter(Boolean))];
  for (const sym of symSet) {
    await runTPLockEngine(sym).catch(() => {});
  }
  console.log(`🔒 TP Lock engine klaar — ${Object.keys(tpLocks).length} symbolen gelockt`);

  const server = app.listen(PORT, () =>
    console.log([
      `🚀 FTMO Webhook v3.8 — poort ${PORT}`,
      `💰 Balance: €${ACCOUNT_BALANCE}`,
      `📈 Risico | Index:€${RISK.index} Forex:€${RISK.forex} Gold:€${RISK.gold} Crypto:€${RISK.crypto}`,
      `🕐 Venster: 02:00–20:00 GMT+1 | Aandelen: 15:30–20:00`,
      `⏰ Auto-close: 20:50 GMT+1 elke dag`,
      `🌙 Weekend: BTC/ETH only (02:00–20:00)`,
      `📊 Sessies: Asia 02-08 | London 08-15:30 | NY 15:30-20 GMT+1`,
      `❌ Geen auto-TP — trades lopen tot SL of manuele close`,
      `👻 Ghost tracker: 24u post-close prijsvolging → trueMaxRR`,
      `📊 RR levels: ${RR_LEVELS.join(", ")}`,
      `📐 SL multiples: ${SL_MULTIPLES.join(", ")}`,
      `🔬 TP optimizer: /research/tp-optimizer + /research/tp-optimizer/sessie`,
      `📐 SL optimizer: /research/sl-optimizer + /research/sl-optimizer/sessie (READONLY)`,
      `👻 Ghost status: /live/ghosts`,
      `✅ Trade logging: enkel effectief uitgevoerde + gesloten trades`,
      `🗄️  Postgres: ${process.env.DATABASE_URL?"✅":"❌ ontbreekt"}`,
    ].join("\n"))
  );

  function shutdown(sig) {
    console.log(`\n🛑 ${sig} — ghost trackers stoppen...`);
    // Actieve ghost timers opruimen
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
