// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi REST → MT5  |  FTMO Webhook Server v3.5
// Account : Nick Verschoot — FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ───────────────────────────────────────────────────────────────
// REGELS:
//  ✅ Indices  → TP via TP_RR_BY_SYMBOL (dynamisch) | risico €200/trade
//  ✅ Forex    → TP via TP_RR_BY_SYMBOL (dynamisch) | risico €15/trade | max 0.25 lot
//  ✅ Aandelen → geen auto-TP  | manueel sluiten  | venster 15:30–20:00 GMT+1
//  ✅ Gold     → geen auto-TP  | risico €30/trade
//  ✅ Crypto   → geen auto-TP  | risico €30/trade
//  ✅ Trading venster: 02:00–20:00 GMT+1 (alle types behalve aandelen)
//  ✅ Aandelen venster: 15:30–20:00 GMT+1
//  ✅ Dagelijkse auto-close 20:50 GMT+1 — ALLES (werkdagen)
//  ✅ Vrijdag auto-close 20:50 GMT+1 — ALLES (ook vrijdag)
//  ✅ Weekend: alleen BTC/ETH mag traden (02:00–20:00 GMT+1 ook in weekend)
//  ✅ Geen weekend orders voor niet-crypto
//  ✅ Self-healing symbool/lot errors
//  ✅ Anti-consolidation risk halving
//  ✅ Max RR tracker — wat was max RR vóór SL
//  ✅ Equity curve snapshots (30s) + Postgres persistence
//  ✅ /research/tp-optimizer        — beste TP per symbool op basis van history
//  ✅ POST /research/tp-optimizer/apply — past TP_RR_BY_SYMBOL aan (≥10 trades, EV>0)
//  ✅ Live TP-correctie open posities — na apply worden open MT5 orders direct bijgewerkt
//  ✅ Postgres persistence — trades + equity bewaard na restart
//  ✅ Sessie tracking — Asia / London / LDN-NY Overlap / New York
//  ✅ GET /analysis/sessions — EV + maxRR per symbool per sessie
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const cron    = require("node-cron");
const app     = express();
app.use(express.json());

// ── DB + SESSIE ───────────────────────────────────────────────
const { initDB, saveTrade, loadAllTrades, saveSnapshot, loadSnapshots } = require("./db");
const { getSession, getSessionLabel } = require("./session");

// ── CONFIG ────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "FtmoNV2025";
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || "10000");

// ── RISICO PER TYPE (EUR) ────────────────────────────────────
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

// ── FTMO DRAWDOWN ─────────────────────────────────────────────
const FTMO_DAILY_LOSS_PCT = 1.0; // dagelijks verlies guard UITGESCHAKELD
const FTMO_TOTAL_LOSS_PCT = 0.10;
let ftmoDailyLossUsed = 0;
let ftmoStartBalance  = ACCOUNT_BALANCE;
let ftmoLastDayReset  = new Date().toDateString();

function resetDailyLossIfNewDay() {
  const today = new Date().toDateString();
  if (today !== ftmoLastDayReset) {
    console.log(`🔄 Nieuwe dag — reset dagelijks verlies (was €${ftmoDailyLossUsed.toFixed(2)})`);
    ftmoDailyLossUsed = 0;
    ftmoLastDayReset  = today;
  }
}

function ftmoSafetyCheck(_riskEUR) {
  return { ok: true };
}

function registerFtmoLoss(riskEUR) {
  ftmoDailyLossUsed += riskEUR;
  console.log(`📉 FTMO dagelijks verlies: €${ftmoDailyLossUsed.toFixed(2)}`);
}

// ── IN-MEMORY STORES ──────────────────────────────────────────
const openTradeTracker = {};
const openPositions    = {};
const closedTrades     = [];
const accountSnapshots = [];
const webhookHistory   = [];
const MAX_SNAPSHOTS    = 86400;
const MAX_HISTORY      = 200;

function addWebhookHistory(entry) {
  webhookHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.length = MAX_HISTORY;
}

const learnedPatches = {};

// ══════════════════════════════════════════════════════════════
// SYMBOL MAP — TradingView → FTMO MT5
// ══════════════════════════════════════════════════════════════
const SYMBOL_MAP = {

  // ── INDICES ───────────────────────────────────────────────
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

  // ── GOLD ──────────────────────────────────────────────────
  "XAUUSD":      { mt5: "XAUUSD",      type: "gold"   },
  "GOLD":        { mt5: "XAUUSD",      type: "gold"   },

  // ── COMMODITIES ───────────────────────────────────────────
  "UKOIL":       { mt5: "UKOIL.cash",  type: "brent"  },
  "UKOIL.cash":  { mt5: "UKOIL.cash",  type: "brent"  },
  "USOIL":       { mt5: "USOIL.cash",  type: "wti"    },
  "USOIL.cash":  { mt5: "USOIL.cash",  type: "wti"    },

  // ── CRYPTO ────────────────────────────────────────────────
  "BTCUSD":      { mt5: "BTCUSD",      type: "crypto" },
  "ETHUSD":      { mt5: "ETHUSD",      type: "crypto" },

  // ── US STOCKS ─────────────────────────────────────────────
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

  // ── FOREX MAJORS ──────────────────────────────────────────
  "EURUSD":      { mt5: "EURUSD",      type: "forex"  },
  "GBPUSD":      { mt5: "GBPUSD",      type: "forex"  },
  "USDJPY":      { mt5: "USDJPY",      type: "forex"  },
  "USDCHF":      { mt5: "USDCHF",      type: "forex"  },
  "USDCAD":      { mt5: "USDCAD",      type: "forex"  },
  "AUDUSD":      { mt5: "AUDUSD",      type: "forex"  },
  "NZDUSD":      { mt5: "NZDUSD",      type: "forex"  },

  // ── FOREX CROSSES ─────────────────────────────────────────
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

// ── TAKE PROFIT CONFIG ────────────────────────────────────────
const TP_RR_BY_SYMBOL = {
  "GER40.cash":  3,
  "UK100.cash":  3,
  "US100.cash":  3,
  "US30.cash":   3,
  "US500.cash":  3,
  "JP225.cash":  3,
  "AUS200.cash": 3,
  "EU50.cash":   3,
  "FRA40.cash":  3,
  "HK50.cash":   3,
  "US2000.cash": 3,
  "SPN35.cash":  3,
  "NL25.cash":   3,
  "EURUSD": 2, "GBPUSD": 2, "USDJPY": 2, "USDCHF": 2,
  "USDCAD": 2, "AUDUSD": 2, "NZDUSD": 2, "EURGBP": 2,
  "EURJPY": 2, "EURCHF": 2, "EURAUD": 2, "EURCAD": 2,
  "GBPJPY": 2, "GBPCHF": 2, "GBPAUD": 2, "GBPCAD": 2,
  "AUDJPY": 2, "AUDCAD": 2, "AUDCHF": 2, "AUDNZD": 2,
  "CADJPY": 2, "CADCHF": 2, "NZDJPY": 2, "NZDCAD": 2,
  "NZDCHF": 2, "CHFJPY": 2,
  "XAUUSD": null, "UKOIL.cash": null, "USOIL.cash": null,
  "BTCUSD": null, "ETHUSD": null,
  "AAPL": null, "TSLA": null, "NVDA": null, "MSFT": null,
  "PLTR": null, "AMZN": null, "AMD":  null, "META": null,
  "MU":   null, "GOOGL": null, "NFLX": null,
};

const TP_RR_DEFAULT = {
  index: 3, forex: 2, gold: null, brent: null,
  wti: null, crypto: null, stock: null,
};

function getTPRR(mt5Symbol, type) {
  if (mt5Symbol in TP_RR_BY_SYMBOL) return TP_RR_BY_SYMBOL[mt5Symbol];
  return TP_RR_DEFAULT[type] ?? null;
}

// ── LOT VALUE / MAX LOTS / MIN STOP ──────────────────────────
const LOT_VALUE = {
  index: 20.00, gold: 100.00, brent: 10.00, wti: 10.00,
  crypto: 1.00, stock: 1.00, forex: 10.00,
};

const MAX_LOTS = {
  index: 10.0, gold: 1.0, brent: 5.0, wti: 5.0,
  crypto: 1.0, stock: 50.0, forex: 0.25,
};

const MIN_STOP = {
  "GER40.cash": 5.0, "UK100.cash": 5.0, "US100.cash": 5.0,
  "US30.cash": 5.0, "US500.cash": 2.0, "JP225.cash": 10.0,
  "AUS200.cash": 3.0, "EU50.cash": 5.0, "FRA40.cash": 5.0,
  "HK50.cash": 10.0, "US2000.cash": 1.0, "SPN35.cash": 2.0,
  "NL25.cash": 1.0, "XAUUSD": 0.5, "UKOIL.cash": 0.05,
  "USOIL.cash": 0.05, "BTCUSD": 100.0, "ETHUSD": 5.0,
  "default_stock": 0.5, "default_forex": 0.0005,
  "USDJPY": 0.05, "EURJPY": 0.05, "GBPJPY": 0.05,
  "AUDJPY": 0.05, "CADJPY": 0.05, "NZDJPY": 0.05, "CHFJPY": 0.05,
};

// ── CRYPTO SYMBOLS SET ────────────────────────────────────────
// Alleen deze symbolen mogen in het weekend traden
const WEEKEND_ALLOWED_SYMBOLS = new Set(["BTCUSD", "ETHUSD", "BTC", "ETH"]);

function isCryptoWeekendAllowed(symbol) {
  return WEEKEND_ALLOWED_SYMBOLS.has(symbol) ||
    ["BTC", "ETH"].some(c => symbol.startsWith(c));
}

// ── SYMBOL HELPERS ────────────────────────────────────────────
function getMT5Symbol(symbol) {
  if (learnedPatches[symbol]?.mt5Override) return learnedPatches[symbol].mt5Override;
  if (SYMBOL_MAP[symbol]) return SYMBOL_MAP[symbol].mt5;
  return symbol;
}

function getSymbolType(symbol) {
  if (SYMBOL_MAP[symbol]) return SYMBOL_MAP[symbol].type;
  if (["BTC","ETH"].some(c => symbol.startsWith(c))) return "crypto";
  return "stock";
}

// ══════════════════════════════════════════════════════════════
// MARKTUREN CHECK (GMT+1)
// ──────────────────────────────────────────────────────────────
// Regels:
//  • Alle types: trading venster 02:00–20:00 GMT+1
//  • Aandelen:   extra beperking 15:30–20:00 GMT+1
//  • Weekend:    alleen crypto (BTC/ETH) mag traden, ook binnen 02:00–20:00
//  • Vrijdag:    zelfde venster 02:00–20:00, crypto mag door in weekend
// ══════════════════════════════════════════════════════════════
function getGMT1Time() {
  const now = new Date();
  return new Date(now.getTime() + 1 * 3600 * 1000);
}

function isMarketOpen(type, symbol) {
  const t    = getGMT1Time();
  const day  = t.getUTCDay(); // 0=zondag, 6=zaterdag
  const hhmm = t.getUTCHours() * 100 + t.getUTCMinutes();

  // ── Weekend check ─────────────────────────────────────────
  const isWeekend = (day === 0 || day === 6);
  if (isWeekend) {
    // Alleen BTC/ETH toegestaan in weekend
    if (!isCryptoWeekendAllowed(symbol || "")) {
      console.warn(`🚫 Weekend — enkel crypto toegestaan (${symbol} geblokkeerd)`);
      return false;
    }
    // Crypto in weekend: ook beperkt tot 02:00–20:00 GMT+1
    if (hhmm < 200 || hhmm >= 2000) {
      console.warn(`🚫 Weekend crypto buiten venster (${hhmm} — venster 0200–2000 GMT+1)`);
      return false;
    }
    return true;
  }

  // ── Werkdag + vrijdag: globaal venster 02:00–20:00 GMT+1 ──
  if (hhmm < 200) {
    console.warn(`🚫 Voor 02:00 GMT+1 (${hhmm}) — geen trading (heropening om 02:00)`);
    return false;
  }
  if (hhmm >= 2000) {
    console.warn(`🚫 Na 20:00 GMT+1 (${hhmm}) — geen nieuwe orders meer (gesloten om 20:50)`);
    return false;
  }

  // ── Aandelen: extra venster 15:30–20:00 GMT+1 ─────────────
  if (type === "stock") {
    if (hhmm < 1530) {
      console.warn(`🚫 Aandelen buiten venster (${hhmm} — venster 1530–2000 GMT+1)`);
      return false;
    }
    return true;
  }

  return true;
}

// ── METAAPI REST BASE ─────────────────────────────────────────
const META_BASE = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

async function fetchOpenPositions() {
  const res = await fetch(`${META_BASE}/positions`, {
    headers: { "auth-token": META_API_TOKEN },
  });
  if (!res.ok) throw new Error(`MetaApi positions ${res.status}`);
  return res.json();
}

async function fetchAccountInfo() {
  const res = await fetch(`${META_BASE}/accountInformation`, {
    headers: { "auth-token": META_API_TOKEN },
  });
  if (!res.ok) throw new Error(`MetaApi accountInfo ${res.status}`);
  return res.json();
}

async function closePosition(positionId) {
  const res = await fetch(`${META_BASE}/positions/${positionId}/close`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
  });
  const data = await res.json();
  console.log(`🔒 Positie ${positionId} gesloten:`, JSON.stringify(data));
  return data;
}

// ── UPDATE TP VAN OPEN POSITIES IN MT5 ───────────────────────
async function updateOpenPositionsTP(mt5Sym, newRR) {
  const affected = Object.values(openPositions).filter(p => p.mt5Symbol === mt5Sym);
  if (affected.length === 0) {
    console.log(`[TP-UPDATE] Geen open posities voor ${mt5Sym} — niets te updaten`);
    return { updated: 0, skipped: 0, errors: [] };
  }

  let updated = 0, skipped = 0;
  const errors = [];

  for (const pos of affected) {
    try {
      const slDist = Math.abs(pos.entry - pos.sl);
      if (!slDist) { skipped++; continue; }
      const newTP = pos.direction === "buy"
        ? parseFloat((pos.entry + slDist * newRR).toFixed(5))
        : parseFloat((pos.entry - slDist * newRR).toFixed(5));
      const res  = await fetch(`${META_BASE}/positions/${pos.id}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
        body:    JSON.stringify({ takeProfit: newTP }),
      });
      const data = await res.json();
      const isErr = data?.error || (data?.retcode && data?.retcode !== 10009 && data?.retcode !== "TRADE_RETCODE_DONE");
      if (isErr) {
        const msg = data?.error?.message || data?.comment || JSON.stringify(data);
        console.warn(`⚠️ [TP-UPDATE] ${mt5Sym} pos ${pos.id} — MT5 fout: ${msg}`);
        errors.push({ posId: pos.id, error: msg });
        skipped++;
      } else {
        const oldTP = pos.tp ?? "geen";
        pos.tp = newTP;
        console.log(`✅ [TP-UPDATE] ${mt5Sym} pos ${pos.id} | ${pos.direction} | TP: ${oldTP} → ${newTP}  (${newRR}RR)`);
        updated++;
      }
    } catch (e) {
      console.error(`❌ [TP-UPDATE] ${mt5Sym} pos ${pos.id} — exception: ${e.message}`);
      errors.push({ posId: pos.id, error: e.message });
      skipped++;
    }
  }
  console.log(`[TP-UPDATE] ${mt5Sym} klaar — ${updated} bijgewerkt, ${skipped} overgeslagen`);
  return { updated, skipped, errors };
}

// ══════════════════════════════════════════════════════════════
// DAGELIJKSE AUTO-CLOSE — 20:50 GMT+1, ELKE DAG (ma–zo)
// Sluit ALLES: aandelen, indices, forex, gold, crypto, ...
// Uitzondering: crypto (BTC/ETH) in weekend wordt NIET gesloten
// zodat ze de nacht door kunnen gaan (wordt geblokkeerd via isMarketOpen)
// ══════════════════════════════════════════════════════════════
cron.schedule("50 20 * * *", async () => {
  const t   = getGMT1Time();
  const day = t.getUTCDay();

  console.log("🔔 20:50 GMT+1 — auto-close ALLE posities gestart...");
  try {
    const positions = await fetchOpenPositions();
    if (!Array.isArray(positions) || positions.length === 0) {
      console.log("[AUTO-CLOSE 20:50] Geen open posities.");
      return;
    }

    for (const pos of positions) {
      // In het weekend: BTC/ETH laten staan (die mogen 's nachts doorlopen)
      // Op werkdagen: alles sluiten
      const tvSym  = Object.keys(SYMBOL_MAP).find(k => SYMBOL_MAP[k].mt5 === pos.symbol) || pos.symbol;
      const symType = getSymbolType(tvSym);
      const isWeekend = (day === 0 || day === 6);

      if (isWeekend && symType === "crypto" && isCryptoWeekendAllowed(tvSym)) {
        // Weekend crypto mag blijven — wordt om 20:00 geblokkeerd voor nieuwe orders
        // maar bestaande posities mogen doorlopen
        console.log(`⏭️  [AUTO-CLOSE 20:50] ${pos.symbol} — weekend crypto, niet gesloten`);
        continue;
      }

      try {
        const result = await closePosition(pos.id);
        const pnl    = pos.unrealizedProfit != null ? `P&L: €${pos.unrealizedProfit}` : "";
        console.log(`✅ [AUTO-CLOSE 20:50] ${pos.symbol} gesloten ${pnl}`, JSON.stringify(result));
        addWebhookHistory({
          type: "AUTOCLOSE_2050", symbol: pos.symbol, positionId: pos.id,
          reason: "daily 20:50 close — alles"
        });
      } catch (e) {
        console.error(`❌ [AUTO-CLOSE 20:50] Fout bij sluiten ${pos.symbol}:`, e.message);
      }
    }
  } catch (e) {
    console.error("❌ [AUTO-CLOSE 20:50] Fout bij ophalen posities:", e.message);
  }
}, { timezone: "Europe/Brussels" });

console.log("⏰ Auto-close 20:50 actief: elke dag (Europe/Brussels) — sluit ALLES behalve weekend crypto");

// ── NACHTELIJKE TP AUTO-UPDATE (03:00 CET) ────────────────────
cron.schedule("0 3 * * *", async () => {
  console.log("🌙 [TP AUTO-UPDATE] Nachtelijke optimizer gestart (03:00 CET)...");
  const MIN_TRADES = 10;
  if (closedTrades.length < MIN_TRADES) {
    console.log(`[TP AUTO-UPDATE] Te weinig gesloten trades (${closedTrades.length}) — overgeslagen`);
    return;
  }
  const { results } = buildOptimizerResults(MIN_TRADES);
  const applied = [], skipped = [];
  for (const r of results) {
    if (r.bestEV === null) { skipped.push(`${r.symbol}: te weinig data`); continue; }
    if (r.bestEV <= 0)     { skipped.push(`${r.symbol}: EV negatief`);    continue; }
    const mt5Sym = getMT5Symbol(r.symbol);
    const newRR  = parseFloat(r.bestTP);
    const oldRR  = TP_RR_BY_SYMBOL[mt5Sym] ?? TP_RR_BY_SYMBOL[r.symbol] ?? null;
    if (mt5Sym in TP_RR_BY_SYMBOL)      TP_RR_BY_SYMBOL[mt5Sym]   = newRR;
    else if (r.symbol in TP_RR_BY_SYMBOL) TP_RR_BY_SYMBOL[r.symbol] = newRR;
    else                                   TP_RR_BY_SYMBOL[mt5Sym]   = newRR;
    applied.push(`${mt5Sym}: ${oldRR ?? "?"} → ${newRR}RR`);
    console.log(`✅ [TP AUTO-UPDATE] ${mt5Sym}: ${oldRR ?? "?"} → ${newRR}RR  (EV: +${r.bestEV} | ${r.trades} trades)`);
    await updateOpenPositionsTP(mt5Sym, newRR);
  }
  if (skipped.length)  console.log(`⏭️  Overgeslagen: ${skipped.join(" | ")}`);
  if (!applied.length) console.log("ℹ️  Geen wijzigingen");
  else                 console.log(`📊 Klaar — ${applied.length} symbolen bijgewerkt`);
}, { timezone: "Europe/Brussels" });

console.log("🌙 Nachtelijke TP auto-update actief: elke nacht om 03:00 (Europe/Brussels)");

// ── ANTI-CONSOLIDATION ────────────────────────────────────────
function getEffectiveRisk(symbol, direction) {
  const key      = `${symbol}_${direction}`;
  const count    = openTradeTracker[key] || 0;
  const type     = getSymbolType(symbol);
  const base     = RISK[type] || 30;
  const effective = Math.max(base * 0.10, base / Math.pow(2, count));
  if (count > 0) console.log(`⚖️ Anti-consolidatie ${symbol} ${direction}: trade #${count + 1} → €${effective.toFixed(2)}`);
  return effective;
}

function incrementTradeTracker(symbol, direction) {
  const key = `${symbol}_${direction}`;
  openTradeTracker[key] = (openTradeTracker[key] || 0) + 1;
}

function decrementTradeTracker(symbol, direction) {
  const key = `${symbol}_${direction}`;
  if (openTradeTracker[key] > 0) openTradeTracker[key]--;
}

// ── SL VALIDATIE ──────────────────────────────────────────────
function validateSL(direction, entry, sl, mt5Symbol) {
  const type    = getSymbolType(mt5Symbol);
  const minDist = MIN_STOP[mt5Symbol] ||
    (type === "forex" ? MIN_STOP["default_forex"] : MIN_STOP["default_stock"]) || 0.01;
  const slDist  = Math.abs(entry - sl);
  if (slDist < minDist) {
    const adjusted = direction === "buy" ? entry - minDist : entry + minDist;
    console.warn(`⚠️ SL te dicht (${slDist} < ${minDist}) → aangepast naar ${adjusted}`);
    return adjusted;
  }
  return sl;
}

// ── LOT BEREKENING ────────────────────────────────────────────
function calcLots(symbol, entry, sl, effectiveRisk) {
  const type     = getSymbolType(symbol);
  const lotValue = LOT_VALUE[type] || 1.0;
  const maxLots  = MAX_LOTS[type]  || 50.0;
  const lotStep  = learnedPatches[symbol]?.lotStepOverride || (type === "stock" ? 1 : 0.01);
  const slDist   = Math.abs(entry - sl);
  if (slDist <= 0) return lotStep;

  let lots = effectiveRisk / (slDist * lotValue);

  if (type === "stock") {
    lots = Math.floor(lots);
    if (lots < 1) {
      const riskWith1 = 1 * slDist * lotValue;
      if (riskWith1 <= RISK_MINLOT_CAP) { lots = 1; }
      else { console.warn(`❌ 1 share = €${riskWith1.toFixed(2)} > €${RISK_MINLOT_CAP} — geannuleerd`); return null; }
    }
    lots = Math.min(maxLots, lots);
  } else {
    lots = Math.round(lots / lotStep) * lotStep;
    lots = parseFloat(lots.toFixed(2));
    if (lots < lotStep) {
      const riskWithMin = lotStep * slDist * lotValue;
      if (riskWithMin <= RISK_MINLOT_CAP) { lots = lotStep; }
      else { console.warn(`❌ Min lot = €${riskWithMin.toFixed(2)} > €${RISK_MINLOT_CAP} — geannuleerd`); return null; }
    }
    lots = Math.min(maxLots, lots);
  }

  const actualRisk = lots * slDist * lotValue;
  console.log(`💶 Risico: ${lots} lots × ${slDist.toFixed(5)} pts × €${lotValue} = €${actualRisk.toFixed(2)}`);
  return lots;
}

// ── TAKE PROFIT BEREKENING ────────────────────────────────────
function calcTP(direction, entry, sl, type, mt5Symbol) {
  const rr = getTPRR(mt5Symbol, type);
  if (!rr) return null;
  const slDist = Math.abs(entry - sl);
  return parseFloat((direction === "buy" ? entry + slDist * rr : entry - slDist * rr).toFixed(5));
}

// ── ORDER PLAATSEN ────────────────────────────────────────────
async function placeOrder(direction, symbol, entry, sl, lots) {
  const mt5Symbol = getMT5Symbol(symbol);
  const type      = getSymbolType(symbol);
  const slPrice   = validateSL(direction, parseFloat(entry), parseFloat(sl), mt5Symbol);
  const tpPrice   = calcTP(direction, parseFloat(entry), slPrice, type, mt5Symbol);

  const body = {
    symbol:     mt5Symbol,
    volume:     lots,
    actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    stopLoss:   slPrice,
    comment:    `FTMO-NV-${direction.toUpperCase()}-${symbol}`,
  };
  if (tpPrice !== null) {
    body.takeProfit = tpPrice;
    console.log(`🎯 TP ingesteld op ${getTPRR(mt5Symbol, type)}RR: ${tpPrice}`);
  }

  const res = await fetch(`${META_BASE}/trade`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
    body:    JSON.stringify(body),
  });
  const result = await res.json();
  return { result, mt5Symbol, slPrice, tpPrice, body };
}

// ── SELF-HEALING ──────────────────────────────────────────────
function learnFromError(symbol, errorCode, errorMessage, requestBody) {
  const msg = (errorMessage || "").toLowerCase();
  if (!learnedPatches[symbol]) learnedPatches[symbol] = {};
  if (errorCode === "TRADE_RETCODE_INVALID" && msg.includes("symbol")) {
    const current   = getMT5Symbol(symbol);
    const fallbacks = [current.replace(".cash",""), current+".cash", current+".US", current.replace(".US","")].filter(s => s !== current);
    const tried     = learnedPatches[symbol]._triedMt5 || [];
    const next      = fallbacks.find(f => !tried.includes(f));
    if (next) { learnedPatches[symbol].mt5Override = next; learnedPatches[symbol]._triedMt5 = [...tried, next]; console.log(`🧠 LEARN: ${symbol} → probeer "${next}"`); }
  }
  if (msg.includes("volume") || msg.includes("lot")) {
    const cur = learnedPatches[symbol]?.lotStepOverride || 0.01;
    learnedPatches[symbol].lotStepOverride = cur * 10;
    console.log(`🧠 LEARN: ${symbol} lot step → ${learnedPatches[symbol].lotStepOverride}`);
  }
  if (msg.includes("stop") || errorCode === "TRADE_RETCODE_INVALID_STOPS") {
    const mt5Sym = getMT5Symbol(symbol);
    MIN_STOP[mt5Sym] = (MIN_STOP[mt5Sym] || 0.01) * 2;
    console.log(`🧠 LEARN: Min stop ${mt5Sym} → ${MIN_STOP[mt5Sym]}`);
  }
  console.log("🔧 Patches:", JSON.stringify(learnedPatches));
}

// ── MAX RR TRACKER ────────────────────────────────────────────
function calcMaxRR(trade) {
  const { direction, entry, sl, maxPrice } = trade;
  const slDist = Math.abs(entry - sl);
  if (!slDist || !maxPrice) return 0;
  const favMove = direction === "buy" ? maxPrice - entry : entry - maxPrice;
  return parseFloat((Math.max(0, favMove) / slDist).toFixed(2));
}

// ── POSITION SYNC (30s) ───────────────────────────────────────
async function syncPositions() {
  try {
    const livePositions = await fetchOpenPositions();
    const liveIds = new Set((livePositions || []).map(p => String(p.id)));

    for (const pos of (livePositions || [])) {
      const id    = String(pos.id);
      const trade = openPositions[id];
      if (!trade) continue;
      const cur   = pos.currentPrice ?? pos.openPrice ?? 0;
      const lotV  = LOT_VALUE[getSymbolType(trade.symbol)] || 1.0;
      const pnl   = trade.direction === "buy"
        ? (cur - trade.entry) * trade.lots * lotV
        : (trade.entry - cur) * trade.lots * lotV;
      const better = trade.direction === "buy"
        ? cur > (trade.maxPrice ?? trade.entry)
        : cur < (trade.maxPrice ?? trade.entry);
      if (better) {
        trade.maxPrice = cur;
        trade.maxRR    = calcMaxRR({ ...trade, maxPrice: cur });
      }
      trade.currentPrice = cur;
      trade.currentPnL   = parseFloat(pnl.toFixed(2));
      trade.lastSync     = new Date().toISOString();
    }

    for (const [id, trade] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        const maxRR   = calcMaxRR(trade);
        const session = getSession(trade.openedAt);
        const closed  = { ...trade, closedAt: new Date().toISOString(), maxRR, session };
        closedTrades.push(closed);
        saveTrade(closed).catch(e =>
          console.error(`❌ [DB] saveTrade mislukt voor ${trade.symbol}:`, e.message)
        );
        if (trade.symbol && trade.direction) decrementTradeTracker(trade.symbol, trade.direction);
        delete openPositions[id];
        console.log(`📦 ${trade.symbol} gesloten | Max RR: ${maxRR}R | Sessie: ${session}`);
      }
    }

    try {
      const info = await fetchAccountInfo();
      if (accountSnapshots.length === 0 && info.balance) {
        ftmoStartBalance = info.balance;
        console.log(`📊 FTMO startbalans: €${ftmoStartBalance}`);
      }
      const snap = {
        ts:            new Date().toISOString(),
        balance:       info.balance    ?? null,
        equity:        info.equity     ?? null,
        floatingPL:    parseFloat(((info.equity ?? 0) - (info.balance ?? 0)).toFixed(2)),
        margin:        info.margin     ?? null,
        freeMargin:    info.freeMargin ?? null,
        ftmoDailyUsed: ftmoDailyLossUsed,
        ftmoDailyLimit: ftmoStartBalance * FTMO_DAILY_LOSS_PCT,
      };
      accountSnapshots.push(snap);
      if (accountSnapshots.length > MAX_SNAPSHOTS) accountSnapshots.shift();
      saveSnapshot(snap).catch(e => console.warn("⚠️ [DB] saveSnapshot mislukt:", e.message));
    } catch (e) { console.warn("⚠️ Equity snapshot mislukt:", e.message); }

  } catch (e) { console.warn("⚠️ syncPositions fout:", e.message); }
}
setInterval(syncPositions, 30 * 1000);

// ══════════════════════════════════════════════════════════════
// WEBHOOK ENDPOINT — TradingView → MetaApi → MT5
// ══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  try {
    console.log("📨 Webhook ontvangen:", JSON.stringify(req.body));
    addWebhookHistory({ type: "RECEIVED", body: req.body });

    const secret = req.query.secret || req.headers["x-secret"];
    if (secret !== WEBHOOK_SECRET) {
      console.warn("⚠️ Ongeldige secret");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const symbol = (req.body.symbol === "{{ticker}}" || !req.body.symbol) ? null : req.body.symbol;
    if (!symbol) {
      return res.status(400).json({ error: "Symbool ontbreekt of is letterlijk {{ticker}} — verwijder de TradingView alert en maak hem opnieuw aan." });
    }

    const { action, entry, sl } = req.body;
    if (!action || !entry || !sl) return res.status(400).json({ error: "Vereist: action, symbol, entry, sl" });

    const direction = ["buy","bull","long"].includes(action.toLowerCase()) ? "buy" : "sell";
    const entryNum  = parseFloat(entry);
    const slNum     = parseFloat(sl);

    if (isNaN(entryNum) || isNaN(slNum)) return res.status(400).json({ error: "entry en sl moeten geldige getallen zijn" });
    if (direction === "buy"  && slNum >= entryNum) return res.status(400).json({ error: "SL moet onder entry voor BUY" });
    if (direction === "sell" && slNum <= entryNum) return res.status(400).json({ error: "SL moet boven entry voor SELL" });

    const symType = getSymbolType(symbol);
    const mt5Sym  = getMT5Symbol(symbol);

    if (!SYMBOL_MAP[symbol]) console.warn(`⚠️ Onbekend symbool: "${symbol}" → doorgestuurd als "${mt5Sym}"`);

    // ── Markt open check (met symbool doorgeven voor weekend-crypto check) ──
    if (!isMarketOpen(symType, symbol)) {
      const msg = `🕐 Markt gesloten voor ${symbol} (${symType}) — order genegeerd`;
      console.warn(msg);
      addWebhookHistory({ type: "MARKET_CLOSED", symbol, symType });
      return res.status(200).json({ status: "SKIP", reason: msg });
    }

    const effectiveRisk = getEffectiveRisk(symbol, direction);
    const ftmoCheck     = ftmoSafetyCheck(effectiveRisk);
    if (!ftmoCheck.ok) {
      addWebhookHistory({ type: "FTMO_BLOCKED", symbol, reason: ftmoCheck.reason });
      return res.status(200).json({ status: "FTMO_BLOCKED", reason: ftmoCheck.reason });
    }

    const lots = calcLots(symbol, entryNum, slNum, effectiveRisk);
    if (lots === null) return res.status(200).json({ status: "SKIP", reason: `Minimale lot overschrijdt risico cap €${RISK_MINLOT_CAP}` });

    const tpRR   = getTPRR(mt5Sym, symType);
    const slDist = Math.abs(entryNum - slNum).toFixed(5);
    console.log(`📊 ${direction.toUpperCase()} ${symbol} → ${mt5Sym} [${symType}] | Entry: ${entryNum} | SL: ${slNum} | Dist: ${slDist} | Lots: ${lots} | Risico: €${effectiveRisk.toFixed(2)} | TP: ${tpRR ? tpRR + "RR" : "geen"}`);

    let { result, mt5Symbol, slPrice, tpPrice, body } = await placeOrder(direction, symbol, entryNum, slNum, lots);
    console.log("📬 MetaApi resultaat:", JSON.stringify(result));

    const errCode = result?.error?.code || result?.retcode;
    const errMsg  = result?.error?.message || result?.comment || "";
    const isError = result?.error || (errCode && errCode !== 10009 && errCode !== "TRADE_RETCODE_DONE");

    if (isError) {
      console.warn(`⚠️ Order fout (${errCode}): ${errMsg}`);
      learnFromError(symbol, errCode, errMsg, body);
      console.log("🔄 Self-healing retry...");
      const retryLots = calcLots(symbol, entryNum, slNum, effectiveRisk);
      if (retryLots !== null) {
        const retry    = await placeOrder(direction, symbol, entryNum, slNum, retryLots);
        result         = retry.result;
        tpPrice        = retry.tpPrice;
        console.log("🔄 Retry resultaat:", JSON.stringify(result));
        const retryErr = result?.error || (result?.retcode && result?.retcode !== 10009 && result?.retcode !== "TRADE_RETCODE_DONE");
        if (retryErr) {
          learnFromError(symbol, result?.error?.code || result?.retcode, result?.error?.message || result?.comment, retry.body);
          addWebhookHistory({ type: "ERROR", symbol, errCode, errMsg });
          return res.status(200).json({ status: "ERROR_LEARNED", errCode, errMsg, learnedPatches });
        }
      }
    }

    registerFtmoLoss(effectiveRisk);
    incrementTradeTracker(symbol, direction);

    const posId = String(result?.positionId || result?.orderId || Date.now());
    openPositions[posId] = {
      id: posId, symbol, mt5Symbol, direction,
      entry: entryNum, sl: slPrice, tp: tpPrice ?? null, lots,
      riskEUR:    effectiveRisk,
      openedAt:   new Date().toISOString(),
      session:    getSession(),
      maxPrice:   entryNum,
      maxRR:      0,
      currentPnL: 0,
      lastSync:   null,
    };

    addWebhookHistory({ type: "SUCCESS", symbol, mt5Symbol, direction, lots, posId, tpRR: tpRR ?? "geen" });
    res.json({
      status: "OK", direction, tvSymbol: symbol, mt5Symbol,
      entry: entryNum, sl: slPrice, tp: tpPrice ?? null,
      tpRR: tpRR ? `${tpRR}RR` : "geen auto-TP",
      slDist, lots,
      risicoEUR:          effectiveRisk.toFixed(2),
      ftmoDailyUsed:      ftmoDailyLossUsed.toFixed(2),
      ftmoDailyLimit:     (ftmoStartBalance * FTMO_DAILY_LOSS_PCT).toFixed(2),
      ftmoDailyRemaining: (ftmoStartBalance * FTMO_DAILY_LOSS_PCT - ftmoDailyLossUsed).toFixed(2),
      tradeNummer:        openTradeTracker[`${symbol}_${direction}`] || 1,
      positionId:         posId,
      metaApi:            result,
      learnedPatches:     Object.keys(learnedPatches).length ? learnedPatches : undefined,
    });

  } catch (err) {
    console.error("❌ Fout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MANUAL CLOSE ──────────────────────────────────────────────
app.post("/close", async (req, res) => {
  const secret = req.query.secret || req.headers["x-secret"];
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const { positionId, symbol, direction } = req.body;
  if (!positionId) return res.status(400).json({ error: "Vereist: positionId" });
  try {
    const result = await closePosition(positionId);
    if (symbol && direction) decrementTradeTracker(symbol, direction);
    res.json({ status: "OK", result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  resetDailyLossIfNewDay();
  res.json({
    status: "online", versie: "ftmo-v3.5", broker: "FTMO-Demo",
    account: ACCOUNT_BALANCE, risicoPerType: RISK, maxLotsPerType: MAX_LOTS,
    tpRrBySimbool: TP_RR_BY_SYMBOL,
    tradingVenster: "02:00–20:00 GMT+1 (alle types)",
    stockTradingWindow: "15:30–20:00 GMT+1 (aandelen)",
    dailyAutoClose: "20:50 GMT+1 (elke dag — ALLES, behalve weekend crypto)",
    weekendTrading: "Alleen BTC/ETH (02:00–20:00 GMT+1)",
    ftmo: {
      startBalance:       ftmoStartBalance,
      dailyLossUsed:      parseFloat(ftmoDailyLossUsed.toFixed(2)),
      dailyLossLimit:     "UITGESCHAKELD",
      totalLossLimit:     parseFloat((ftmoStartBalance * FTMO_TOTAL_LOSS_PCT).toFixed(2)),
      dailyLossRemaining: "UITGESCHAKELD",
    },
    postgres: process.env.DATABASE_URL ? "✅ verbonden" : "❌ DATABASE_URL ontbreekt",
    symbolMap: Object.fromEntries(Object.entries(SYMBOL_MAP).map(([tv, v]) => [tv, v.mt5])),
    endpoints: {
      "POST /webhook":                     "TradingView → FTMO MT5",
      "POST /close":                       "Manueel positie sluiten",
      "GET  /status":                      "Open trades + FTMO limieten",
      "GET  /live/positions":              "Live posities met P&L + max RR",
      "GET  /analysis/rr":                 "Max RR analyse per gesloten trade",
      "GET  /analysis/sessions":           "EV + maxRR per symbool per sessie",
      "GET  /analysis/equity-curve":       "Equity history (Postgres + memory)",
      "GET  /research/tp-optimizer":       "Beste TP per symbool (EV-gebaseerd)",
      "POST /research/tp-optimizer/apply": "Pas TP_RR_BY_SYMBOL aan (≥10 trades, EV>0)",
      "GET  /history":                     "Webhook log",
    },
    tracking: {
      openPositions:   Object.keys(openPositions).length,
      closedTrades:    closedTrades.length,
      equitySnapshots: accountSnapshots.length,
      webhookHistory:  webhookHistory.length,
    },
  });
});

// ── STATUS ────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  resetDailyLossIfNewDay();
  res.json({
    openTrades: openTradeTracker, learnedPatches,
    risicoPerType: RISK, maxLotsPerType: MAX_LOTS,
    ftmoDailyUsed:      parseFloat(ftmoDailyLossUsed.toFixed(2)),
    ftmoDailyLimit:     parseFloat((ftmoStartBalance * FTMO_DAILY_LOSS_PCT).toFixed(2)),
    ftmoDailyRemaining: parseFloat((ftmoStartBalance * FTMO_DAILY_LOSS_PCT - ftmoDailyLossUsed).toFixed(2)),
  });
});

// ── LIVE POSITIONS ────────────────────────────────────────────
app.get("/live/positions", (req, res) => {
  const positions = Object.values(openPositions).map(p => ({
    id: p.id, symbol: p.symbol, mt5Symbol: p.mt5Symbol, direction: p.direction,
    entry: p.entry, sl: p.sl, tp: p.tp ?? null, lots: p.lots,
    riskEUR: p.riskEUR, openedAt: p.openedAt, session: p.session ?? null,
    currentPrice: p.currentPrice ?? null, currentPnL: p.currentPnL ?? 0,
    maxPrice: p.maxPrice, maxRR: p.maxRR ?? 0, lastSync: p.lastSync,
  }));
  res.json({ count: positions.length, positions });
});

// ── MAX RR ANALYSE ────────────────────────────────────────────
app.get("/analysis/rr", (req, res) => {
  const { symbol } = req.query;
  const trades = symbol
    ? closedTrades.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase())
    : closedTrades;

  const bySymbol = {};
  for (const t of trades) {
    const s = t.symbol || "UNKNOWN";
    if (!bySymbol[s]) bySymbol[s] = { trades: [], totalMaxRR: 0, count: 0 };
    const maxRR = t.maxRR ?? calcMaxRR(t);
    bySymbol[s].trades.push({
      openedAt: t.openedAt, closedAt: t.closedAt, direction: t.direction,
      entry: t.entry, sl: t.sl, tp: t.tp ?? null, session: t.session ?? null, maxRR,
      tpHit: t.tp ? (t.direction === "buy" ? t.maxPrice >= t.tp : t.maxPrice <= t.tp) : null,
    });
    bySymbol[s].totalMaxRR += maxRR;
    bySymbol[s].count++;
  }

  const summary = Object.entries(bySymbol).map(([sym, g]) => ({
    symbol: sym, trades: g.count,
    avgMaxRR: parseFloat((g.totalMaxRR / g.count).toFixed(2)),
    details:  g.trades,
  }));

  res.json({ totalTrades: trades.length, info: "maxRR = hoeveel R de prijs maximaal bewoog vóór SL of TP", bySymbol: summary });
});

// ── SESSIE ANALYSE ────────────────────────────────────────────
app.get("/analysis/sessions", (req, res) => {
  const { symbol, session } = req.query;
  const RR_LEVELS = [1, 1.5, 2, 2.5, 3, 4];
  const SESSIONS  = ["asia", "london", "overlap_lndy", "new_york"];

  let trades = closedTrades;
  if (symbol)  trades = trades.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase());
  if (session) trades = trades.filter(t => t.session === session);

  const bySymbol = {};
  for (const t of trades) {
    const sym  = t.symbol  || "UNKNOWN";
    const sess = t.session || "unknown";
    if (!bySymbol[sym]) bySymbol[sym] = { totalTrades: 0, sessions: {} };
    if (!bySymbol[sym].sessions[sess]) bySymbol[sym].sessions[sess] = { trades: [], totalMaxRR: 0 };
    bySymbol[sym].sessions[sess].trades.push(t);
    bySymbol[sym].sessions[sess].totalMaxRR += t.maxRR || 0;
    bySymbol[sym].totalTrades++;
  }

  const result = {};
  for (const [sym, symData] of Object.entries(bySymbol)) {
    result[sym] = { totalTrades: symData.totalTrades, bestSession: null, sessions: {} };
    let bestEV = -Infinity, bestSess = null;

    for (const sess of SESSIONS) {
      const group = symData.sessions[sess];
      if (!group || group.trades.length === 0) continue;
      const count    = group.trades.length;
      const avgMaxRR = parseFloat((group.totalMaxRR / count).toFixed(2));
      const evTable  = RR_LEVELS.map(rr => {
        const wins    = group.trades.filter(t => (t.maxRR || 0) >= rr).length;
        const winrate = wins / count;
        const ev      = parseFloat((winrate * rr - (1 - winrate) * 1).toFixed(3));
        return { rr, wins, total: count, winrate: `${(winrate * 100).toFixed(1)}%`, ev };
      });
      const bestRR = evTable.reduce((a, b) => b.ev > a.ev ? b : a);
      result[sym].sessions[sess] = {
        label: getSessionLabel(sess), trades: count, avgMaxRR,
        bestTP: `${bestRR.rr}R`, bestEV: bestRR.ev, evTable,
      };
      if (bestRR.ev > bestEV) { bestEV = bestRR.ev; bestSess = sess; }
    }
    result[sym].bestSession = bestSess
      ? { session: bestSess, label: getSessionLabel(bestSess), ev: bestEV }
      : null;
  }

  const sorted = Object.fromEntries(
    Object.entries(result).sort((a, b) => b[1].totalTrades - a[1].totalTrades)
  );

  res.json({
    totalTrades: trades.length,
    filters: { symbol: symbol || "alle", session: session || "alle" },
    info: "Primair per symbool, dan per sessie. bestSession = hoogste EV voor dat pair.",
    queryTips: {
      alleSymbolen:    "GET /analysis/sessions",
      eenSymbool:      "GET /analysis/sessions?symbol=GBPUSD",
      eenSessie:       "GET /analysis/sessions?session=london",
      symboolEnSessie: "GET /analysis/sessions?symbol=GBPUSD&session=london",
    },
    bySymbol: sorted,
  });
});

// ── TP OPTIMIZER ─────────────────────────────────────────────
function buildOptimizerResults(minTrades = 3) {
  const RR_LEVELS = [1, 1.5, 2, 2.5, 3, 4];
  const slMap = {};
  for (const log of webhookHistory) {
    if (log.body?.symbol && log.body?.entry && log.body?.sl) {
      const key = `${log.body.symbol}_${parseFloat(log.body.entry).toFixed(5)}`;
      slMap[key] = parseFloat(log.body.sl);
    }
  }

  const bySymbol = {};
  let skipped    = 0;
  for (const t of closedTrades) {
    const sl = t.sl ?? slMap[`${t.symbol}_${parseFloat(t.entry).toFixed(5)}`];
    if (!sl || !t.entry || !t.maxPrice) { skipped++; continue; }
    const slDist = Math.abs(t.entry - sl);
    if (slDist === 0) { skipped++; continue; }
    const favMove   = t.direction === "buy" ? t.maxPrice - t.entry : t.entry - t.maxPrice;
    const achievedR = favMove / slDist;
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push({ achievedR, direction: t.direction });
  }

  const results = [];
  for (const [symbol, trades] of Object.entries(bySymbol)) {
    if (trades.length < minTrades) {
      results.push({ symbol, trades: trades.length, note: `Te weinig data (min. ${minTrades} trades vereist)`, bestTP: null, bestEV: null });
      continue;
    }
    const evTable = RR_LEVELS.map(rr => {
      const wins    = trades.filter(t => t.achievedR >= rr).length;
      const winrate = wins / trades.length;
      const ev      = winrate * rr - (1 - winrate) * 1;
      return { rr, wins, total: trades.length, winrate: `${(winrate * 100).toFixed(1)}%`, ev: parseFloat(ev.toFixed(3)) };
    });
    const best = evTable.reduce((a, b) => b.ev > a.ev ? b : a);
    results.push({
      symbol, trades: trades.length,
      bestTP: `${best.rr}R`, bestEV: best.ev, bestWinrate: best.winrate,
      recommendation: best.ev > 0
        ? `Gebruik TP = ${best.rr}R  (EV: +${best.ev}R per trade)`
        : "EV negatief op alle niveaus — herbekijk strategie op dit symbool",
      evTable,
    });
  }
  results.sort((a, b) => {
    if (a.bestEV === null) return 1;
    if (b.bestEV === null) return -1;
    return b.bestEV - a.bestEV;
  });
  return { results, skipped, rrLevels: RR_LEVELS };
}

app.get("/research/tp-optimizer", (req, res) => {
  if (closedTrades.length === 0) {
    return res.json({ info: "Nog geen gesloten trades beschikbaar.", trades: 0, bySymbol: [] });
  }
  const { results, skipped, rrLevels } = buildOptimizerResults(3);
  res.json({
    generated: new Date().toISOString(), totalTrades: closedTrades.length, skipped, rrLevels,
    info: "EV = winrate_op_X × X − (1 − winrate_op_X) × 1  |  positief = winstgevend TP-niveau",
    applyHint: "POST /research/tp-optimizer/apply om TP_RR_BY_SYMBOL bij te werken (≥10 trades, EV>0)",
    bySymbol: results,
  });
});

app.post("/research/tp-optimizer/apply", async (req, res) => {
  const secret = req.query.secret || req.headers["x-secret"];
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const MIN_TRADES = 10;
  if (closedTrades.length === 0) return res.json({ status: "SKIP", reason: "Geen gesloten trades beschikbaar.", applied: [], skipped: [] });

  const { results }      = buildOptimizerResults(MIN_TRADES);
  const applied          = [];
  const skippedSymbols   = [];

  for (const r of results) {
    if (r.bestEV === null) { skippedSymbols.push({ symbol: r.symbol, reason: `Te weinig data (${r.trades} < ${MIN_TRADES} trades)` }); continue; }
    if (r.bestEV <= 0)     { skippedSymbols.push({ symbol: r.symbol, reason: `EV negatief (${r.bestEV})` }); continue; }

    const mt5Sym = getMT5Symbol(r.symbol);
    const newRR  = parseFloat(r.bestTP);
    const oldRR  = TP_RR_BY_SYMBOL[mt5Sym] ?? TP_RR_BY_SYMBOL[r.symbol] ?? null;

    if (mt5Sym in TP_RR_BY_SYMBOL)        TP_RR_BY_SYMBOL[mt5Sym]   = newRR;
    else if (r.symbol in TP_RR_BY_SYMBOL)  TP_RR_BY_SYMBOL[r.symbol] = newRR;
    else                                    TP_RR_BY_SYMBOL[mt5Sym]   = newRR;

    console.log(`✅ TP-APPLY: ${mt5Sym} → ${newRR}RR  (was: ${oldRR ?? "onbekend"} | EV: +${r.bestEV} | ${r.trades} trades)`);
    const liveUpdate = await updateOpenPositionsTP(mt5Sym, newRR);
    applied.push({ symbol: r.symbol, mt5Sym, oldRR, newRR, trades: r.trades, bestEV: r.bestEV, winrate: r.bestWinrate, liveUpdate });
  }

  res.json({
    status: "OK", appliedAt: new Date().toISOString(),
    minTradesVereist: MIN_TRADES, applied, skipped: skippedSymbols,
    tpRrBySimbool: TP_RR_BY_SYMBOL,
  });
});

// ── EQUITY CURVE ──────────────────────────────────────────────
app.get("/analysis/equity-curve", async (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  try {
    const dbSnaps = await loadSnapshots(hours);
    if (dbSnaps.length > 0) {
      return res.json({ hours, count: dbSnaps.length, source: "postgres", snapshots: dbSnaps });
    }
  } catch (e) {
    console.warn("⚠️ [DB] equity-curve fallback naar memory:", e.message);
  }
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const snaps  = accountSnapshots.filter(s => s.ts >= cutoff);
  res.json({ hours, count: snaps.length, source: "memory", snapshots: snaps });
});

// ── WEBHOOK HISTORY ───────────────────────────────────────────
app.get("/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_HISTORY);
  res.json({ count: webhookHistory.length, history: webhookHistory.slice(0, limit) });
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  await initDB();
  const historicTrades = await loadAllTrades();
  closedTrades.push(...historicTrades);
  console.log(`📂 ${historicTrades.length} historische trades geladen uit Postgres`);

  const server = app.listen(PORT, () =>
    console.log([
      `🚀 FTMO Webhook v3.5 — online op poort ${PORT}`,
      `💰 Balance: €${ACCOUNT_BALANCE}`,
      `📈 Risico  | Index: €${RISK.index} | Forex: €${RISK.forex} | Stock: €${RISK.stock} | Gold: €${RISK.gold}`,
      `🎯 TP      | Dynamisch via TP_RR_BY_SYMBOL (zie GET /)`,
      `🕐 Venster algemeen  : 02:00–20:00 GMT+1 (heropening 02:00, laatste order 20:00)`,
      `🕐 Aandelen venster  : 15:30–20:00 GMT+1`,
      `⏰ Auto-close 20:50  : elke dag — ALLES (behalve weekend crypto)`,
      `🌙 Weekend trading   : alleen BTC/ETH (02:00–20:00 GMT+1)`,
      `📉 Forex max: ${MAX_LOTS.forex} lot`,
      `🛡️  FTMO dagelijks verlies: UITGESCHAKELD`,
      `🗺️  Symbolen in map: ${Object.keys(SYMBOL_MAP).length}`,
      `🔬 TP optimizer     : GET  /research/tp-optimizer`,
      `⚡ TP auto-apply    : POST /research/tp-optimizer/apply`,
      `📊 Sessie analyse   : GET  /analysis/sessions`,
      `🗄️  Postgres         : ${process.env.DATABASE_URL ? "✅ verbonden" : "❌ DATABASE_URL ontbreekt"}`,
      `📂 Trades geladen   : ${historicTrades.length}`,
    ].join("\n"))
  );

  function shutdown(signal) {
    console.log(`🛑 ${signal} ontvangen — server netjes afsluiten...`);
    server.close(() => { console.log("✅ Server afgesloten"); process.exit(0); });
    setTimeout(() => { console.warn("⚠️ Geforceerde exit na 10s"); process.exit(1); }, 10_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

startServer().catch(err => {
  console.error("❌ Startup fout:", err.message);
  process.exit(1);
});
