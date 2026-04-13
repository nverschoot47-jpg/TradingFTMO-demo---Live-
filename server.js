// ===============================================================
// TradingView -> MetaApi REST -> MT5  |  FTMO Webhook Server v7.9
// Account : Nick Verschoot  -  FTMO Demo
// MetaApi : 7cb566c1-be02-415b-ab95-495368f3885c
// ---------------------------------------------------------------
// WIJZIGINGEN v7.9:
//  [OK] fix1: placeOrder: r.ok check toegevoegd op /trade POST fetch
//     Voorheen: MetaApi 4xx/5xx werd stilzwijgend geparsed als geldig JSON
//     -> isError triggerde NIET -> order leek te slagen maar positionId was leeg
//     Nu: !r.ok gooit Error("MetaApi HTTP 4xx: <message>") -> placeOrderWithTimeout
//     vangt dit correct op en de foutdetails verschijnen in het dashboard.
//  [OK] fix2: extractMetaApiError() helper toegevoegd voor robuuste error-extractie
//     Oud: result?.error?.code || result?.retcode  -> miste alle andere velden
//     Nieuw: ondersteunt { error: { code/id/statusCode } }, { retcode },
//     { error: "string" }, { message }, { description }, { statusCode }
//     -> "retry: ?: geen detail" kan niet meer voorkomen in webhook history
//  [OK] fix3: volledige MetaApi response gelogd bij fouten (eerste poging + retry)
//     console.error met JSON.stringify(result) zodat exact zichtbaar is welke
//     veldnamen MetaApi gebruikt -> eenmalig checken in Railway logs = definitieve fix
//  [OK] fix4: Forex lot boost x4 bij positieve EV lock (lotsize, niet risicobedrag)
//     Voorheen: forex altijd 0.25L (trade1) / 0.12L (trade2), ongeacht EV-status.
//     Nu: positieve EV lock -> lots * 4 * 1.2^streak (compound identiek aan andere types).
//     Verhouding trade1/trade2 (0.25/0.12) blijft behouden.
//     Zichtbaar in dashboard via forexLotBoost veld in webhook history.
//  [OK] fix5: MT5 comment veld ingekort tot max 26 karakters
//     Oud: "FTMO-NV-BUY-USDCAD-TP4R-london" = 31 chars -> HTTP 400 clientId/comment invalid
//     Nieuw: "NV-B-USDCAD-4R-LON" = ~18-20 chars -> altijd binnen MT5 limiet.
//     Dit was de oorzaak van alle TIMEOUT/ERROR entries in het dashboard.
//
// WIJZIGINGEN v7.8:
//  [OK] fix1: EOD Ghost Check cron (21:00) verwijderd — geïntegreerd in syncPositions()
//     Reden: cron draaide vóór auto-close (21:50) dus vond nooit trades zonder trueMaxRR.
//     Nu: elke sync-cyclus automatisch orphan ghosts detecteren en starten.
//  [OK] fix2: Kelly Criterion toegevoegd aan Shadow SL Optimizer
//     Shadow koos voorheen enkel op hoogste EV. Kelly weegt EV/RR × (1 - slHitRate):
//     penaliseert hoge variance (hoge slHitRate) → stabielere multiplier-keuze.
//  [OK] fix3: RR_LEVELS verfijnd — 19 → 29 niveaus, fijnere stappen onder 3R
//     Tussenwaarden 0.3, 0.5, 0.7, 0.9, 1.1, 1.2, 1.3, 1.4, 1.75 toegevoegd.
//     Nauwkeuriger EV-maximum per sessie, minder kans op gemist optimum.
//  [OK] fix4: Insta-SL "spread-killed" logging (saveInstaSL / loadInstaSLStats)
//     Trades met maxRR ≤ 0.05 + closeReason=sl krijgen geen ghost maar worden
//     gelogd met uur, sessie, spread → patroonanalyse via GET /analysis/insta-sl.
//  [OK] fix5: Compound boost (4×) geldt voor ALLE trades met positieve EV lock
//     Niet meer enkel count===0. Bij positieve EV lock = altijd 4× base (+ compound)
//     voor elke trade in die pair/sessie — pyramiding-halvering vervalt dan.
//
// WIJZIGINGEN v7.7 (bugfixes):
//  [OK] placeOrder: AbortController + signal op /trade POST fetch
//     Voorheen: fetch had geen signal -> hing door na Promise.race timeout
//     -> stale connections accumuleerden op Railway
//  [OK] slMultiplierApplied -> slMultiplier fix (via db.js saveTrade)
//     Veld in openPositions heette slMultiplierApplied, saveTrade las slMultiplier
//     -> DB sloeg altijd 1.0 op; werkelijke multiplier ging verloren bij elke close
//  [OK] Autoclose cron: isWE dead code verwijderd
//     Cron draait enkel ma-vr (1-5) -> isWE altijd false -> crypto-skip triggerde nooit
//  [OK] reconstructConsecutivePositiveDays: loop bound 30 -> 50 kd
//     30 kalenderdagen bevatten ~22 werkdagen; loop stopte te vroeg voor 30 werkdagen target
//  [OK] Dashboard title + logo: v7.5 -> v7.7
//
// WIJZIGINGEN v7.5 (t.o.v. v7.4):
//  [OK] CRASHFIX: SyntaxError op Railway opgelost
//     Oorzaak: ${ACCOUNT_BALANCE} in client-side <script> binnenin
//     server-side template literal -> Node.js v18 op Railway crashte
//     op lijn 62:5 (eerste } na de template literal opening)
//     Fix: config injection via window.__CONFIG__ = ${JSON.stringify(...)}
//     in aparte <script> tag voor de client-side code
//
// WIJZIGINGEN v7.4 (t.o.v. v7.3):
//  [OK] closePosition: AbortController timeout 8s (was: geen timeout)
//  [OK] fetchAccountInfo: AbortController timeout 8s + try/catch (was: unhandled rejection)
//  [OK] reconstructConsecutivePositiveDays: Brussels weekday via getBrusselsComponents()
//     ipv UTC d.getDay() (was: maandag 00:30 BXL -> sunday UTC -> streak reset)
//  [OK] getEffectiveSLMultiplier v7.4: volledig herschreven
//     - Mechanisme 1: SL Lock Engine auto-applied (>=30 trades) -> statistische EV-multiplier
//     - Mechanisme 2: Shadow SL Optimizer (>=30 ghost trades) + TP Lock rijp -> shadow EV-mult
//     - Mechanisme 3: SL Lock Engine readonly (10-29 trades) + TP Lock rijp -> SL Lock mult
//     - Mechanisme 4: TP Lock rijp, geen SL-data -> 0.5x als gedocumenteerde fallback
//     - Mechanisme 5: niets actief -> 1.0x (geen aanpassing)
//     - Hardcoded 0.5x halvering VERWIJDERD als enige optie
//     - `source` veld toegevoegd aan response voor debugbaarheid
//
// WIJZIGINGEN v7.3 (t.o.v. v7.2):
//  [OK] TP Lock: altijd statistisch beste RR, ook bij negatieve EV (geen FIXED_TP_RR fallback)
//  [OK] SL halvering: op basis van trade count (>=30) ipv EV teken
//
// WIJZIGINGEN v7.2 (t.o.v. v7.1):
//  [OK] Insta-SL ghost fix: geen ghost tracker voor maxRR <= 0.05 + closeReason sl
//  [OK] close_reason "unknown" -> "manual" (onbekend = manuele close)
//  [OK] Risk display: alleen % van balance, nooit EUR voor instrumenten
//  [OK] Sessie cards -> 1 sorteerbare tabel (klik op header)
//  [OK] Matrix tabel headers sorteerbaar
// ===============================================================

"use strict";

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");
const app     = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // [v7.7 fix] inline <script> in dashboard werd geblokkeerd -> matrix "Laden..." + klok "--:--:--"
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      connectSrc:  ["'self'"],
      imgSrc:      ["'self'", "data:"],
    },
  },
}));
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
  saveInstaSL, loadInstaSLStats,
} = require("./db");

const {
  getBrusselsComponents,
  getBrusselsDateStr,
  getBrusselsDateOnly,
  getSessionGMT1,
  isMarketOpen: isMarketOpenFn,
  isGhostActive,
  isShadowActive,
  SESSION_LABELS,
} = require("./session");

// -- CONFIG ----------------------------------------------------
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || "10000");

const GHOST_DURATION_MS        = 24 * 3600 * 1000;
const GHOST_INTERVAL_RECENT_MS = 60 * 1000;
const GHOST_INTERVAL_OLD_MS    = 5 * 60 * 1000;
const GHOST_OLD_THRESHOLD_MS   = 6 * 3600 * 1000;

// -- RR / SL LEVELS --------------------------------------------
// [v7.8 fix3] Fijnere RR stappen onder 3R — tussenwaarden 1.1/1.2/1.3/1.4/1.75 geven
// nauwkeuriger EV-maximum per sessie ipv sprongen van 0.5R die optimum kunnen missen
const RR_LEVELS    = [
  0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
  1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75,
  2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0, 12.0, 15.0, 20.0, 25.0,
];
const SL_MULTIPLES = [0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

const SL_AUTO_APPLY_THRESHOLD = 30;
const SHADOW_SL_MIN_TRADES    = 30;
const FIXED_TP_RR             = 4;
const STOCK_SL_SPREAD_MULT      = 1.5;
const STOCK_MAX_SPREAD_FRACTION = 0.333;
const FOREX_MAX_SAME_DIR        = 2;
const FOREX_HALF_RISK_THRESHOLD = 1;
const TP_LOCK_RISK_MULT         = 4;

// -- RISICO PER TYPE -------------------------------------------
const BASE_RISK = {
  index:  parseFloat(process.env.RISK_INDEX  || "200"),
  forex:  parseFloat(process.env.RISK_FOREX  || "15"),
  gold:   parseFloat(process.env.RISK_GOLD   || "30"),
  brent:  parseFloat(process.env.RISK_BRENT  || "30"),
  wti:    parseFloat(process.env.RISK_WTI    || "30"),
  crypto: parseFloat(process.env.RISK_CRYPTO || "30"),
  stock:  parseFloat(process.env.RISK_STOCK  || "30"),
};

let dailyRiskMultiplier     = 1.0;
let dailyRiskMultiplierNext = 1.0;

function getRisk(type) {
  return (BASE_RISK[type] || 30) * dailyRiskMultiplier;
}

// -- IN-MEMORY STORES ------------------------------------------
const openTradeTracker = {};
const openPositions    = {};
const closedTrades     = [];
const accountSnapshots = [];
const webhookHistory   = [];
const ghostTrackers    = {};
const tpLocks          = {};
const slLocks          = {};
const shadowSLResults  = {};
const tpUpdateLog      = [];
const slUpdateLog      = [];
const consecutivePositiveDays = {};
const recentOrderGuard = new Map();
const DUPLICATE_GUARD_MS = 60 * 1000;
const cronLastRun = {
  "AUTOCLOSE_2150":    null,
  "DAY_END_22:00":     null,
  "RECONNECT_02:00":   null,
  "NIGHTLY_OPTIMIZER": null,
  // [v7.8 fix1] EOD_GHOST_21:00 verwijderd — ghost check geïntegreerd in syncPositions()
};
const MAX_SNAPSHOTS = 86400;
const MAX_HISTORY   = 200;
const MAX_TP_LOG    = 100;
const MAX_SL_LOG    = 100;
const TRADING_SESSIONS = ["asia", "london", "ny"];

function addWebhookHistory(entry) {
  webhookHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.length = MAX_HISTORY;
  if (entry.type && cronLastRun.hasOwnProperty(entry.type)) {
    cronLastRun[entry.type] = entry.ts || new Date().toISOString();
  }
}

const learnedPatches = {};

// -- SYMBOL MAP ------------------------------------------------
// mapAliases: meerdere invoernamen -> zelfde MT5 symbool + type
function mapAliases(aliases, mt5, type) {
  return Object.fromEntries(aliases.map(a => [a, { mt5, type }]));
}
// mapDirect: elke naam is zijn eigen MT5 symbool (1-op-1)
function mapDirect(symbols, type) {
  return Object.fromEntries(symbols.map(s => [s, { mt5: s, type }]));
}

const SYMBOL_MAP = {
  // -- Indices -----------------------------------------------
  ...mapAliases(["DE30EUR",  "GER40",  "GER40.cash"],             "GER40.cash",  "index"),
  ...mapAliases(["UK100GBP", "UK100",  "UK100.cash"],             "UK100.cash",  "index"),
  ...mapAliases(["NAS100USD","NAS100", "US100",   "US100.cash"],  "US100.cash",  "index"),
  ...mapAliases(["US30USD",  "US30",   "US30.cash"],              "US30.cash",   "index"),
  ...mapAliases(["SPX500USD","SPX500", "US500",   "US500.cash"],  "US500.cash",  "index"),
  ...mapAliases(["JP225USD", "JP225",  "JP225.cash"],             "JP225.cash",  "index"),
  ...mapAliases(["AU200AUD", "AU200",  "AUS200",  "AUS200.cash"], "AUS200.cash", "index"),
  ...mapAliases(["EU50EUR",  "EU50",   "EU50.cash"],              "EU50.cash",   "index"),
  ...mapAliases(["FR40EUR",  "FR40",   "FRA40",   "FRA40.cash"],  "FRA40.cash",  "index"),
  ...mapAliases(["HK33HKD",  "HK50",   "HK50.cash"],             "HK50.cash",   "index"),
  ...mapAliases(["US2000USD","US2000", "US2000.cash"],            "US2000.cash", "index"),
  ...mapAliases(["NL25EUR",  "N.25.cash"],                        "N.25.cash",   "index"),
  // -- Grondstoffen ------------------------------------------
  ...mapAliases(["XAUUSD",  "GOLD"],       "XAUUSD",     "gold"),
  ...mapAliases(["UKOIL",   "UKOIL.cash"], "UKOIL.cash", "brent"),
  ...mapAliases(["USOIL",   "USOIL.cash"], "USOIL.cash", "wti"),
  // -- Crypto ------------------------------------------------
  ...mapDirect(["BTCUSD", "ETHUSD"], "crypto"),
  // -- Aandelen met alias ------------------------------------
  ...mapAliases(["AAPL",  "APC"],        "AAPL", "stock"),
  ...mapAliases(["TSLA",  "TLO","TL0"],  "TSLA", "stock"),
  ...mapAliases(["GOOGL", "GOOG"],       "GOOG", "stock"),
  // -- Aandelen directe mapping ------------------------------
  ...mapDirect([
    "MSFT","NVDA","AMD","NFLX","AMZN","PLTR","CVX","ASML","AVGO",
    "AZN","BA","BABA","DIS","INTC","V","IBM","FDX","KO","BAC","CSCO",
    "GE","GM","GME","JNJ","JPM","LMT","MCD","META","MSTR","NKE",
    "PFE","QCOM","RACE","SBUX","SNOW","T","WMT","XOM","ZM","BRK.B","ARM",
  ], "stock"),
  // -- Forex directe mapping ---------------------------------
  ...mapDirect([
    "EURUSD","GBPUSD","USDCHF","USDCAD","AUDUSD","NZDUSD",
    "EURGBP","EURCHF","EURAUD","EURCAD","EURNZD",
    "GBPCHF","GBPAUD","GBPCAD","GBPNZD",
    "AUDCAD","AUDCHF","AUDNZD","CADCHF","NZDCAD","NZDCHF",
  ], "forex"),
};

function normalizeSymbol(sym) {
  if (sym === "NIKE") return "NKE";
  return sym;
}

// -- LOT / STOP CONFIG -----------------------------------------
const LOT_VALUE = { index:20, gold:100, brent:10, wti:10, crypto:1, stock:1, forex:10 };
const MAX_LOTS  = { index:10, gold:1,   brent:5,  wti:5,  crypto:1, stock:50, forex:0.25 };

const MIN_STOP_INDEX = {
  "GER40.cash":10,"UK100.cash":2,"US100.cash":10,"US30.cash":10,
  "US500.cash":5,"JP225.cash":10,"AUS200.cash":5,"EU50.cash":5,
  "FRA40.cash":5,"HK50.cash":10,"US2000.cash":5,"N.25.cash":5,
};
const MIN_STOP_COMMODITY = {
  "XAUUSD":0.0,"UKOIL.cash":0.05,"USOIL.cash":0.05,"BTCUSD":100.0,"ETHUSD":5.0,
};
const MIN_STOP_FOREX = {
  "EURUSD":0.0005,"GBPUSD":0.0005,"AUDUSD":0.0005,"NZDUSD":0.0005,
  "USDCHF":0.0005,"USDCAD":0.0005,"EURGBP":0.0005,"EURAUD":0.0005,
  "EURCAD":0.0005,"EURCHF":0.0005,"EURNZD":0.0005,"GBPAUD":0.0005,
  "GBPCAD":0.0005,"GBPCHF":0.0005,"GBPNZD":0.0005,"AUDCAD":0.0005,
  "AUDCHF":0.0005,"AUDNZD":0.0005,"CADCHF":0.0005,"NZDCAD":0.0005,"NZDCHF":0.0005,
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
  return null;
}
function isMarketOpen(type, symbol) {
  return isMarketOpenFn(type, symbol, isCryptoWeekend);
}

// -- METAAPI ---------------------------------------------------
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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${META_BASE}/accountInformation`, {
      headers: {"auth-token": META_API_TOKEN},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`accountInfo ${r.status}`);
    return r.json();
  } catch(e) { clearTimeout(t); throw e; }
}

async function closePosition(id) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${META_BASE}/positions/${id}/close`, {
      method: "POST",
      headers: {"Content-Type":"application/json","auth-token":META_API_TOKEN},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`closePosition ${r.status}`);
    return r.json();
  } catch(e) { clearTimeout(t); throw e; }
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
  } catch(e) { console.warn(`[!] fetchCurrentPrice(${mt5Symbol}):`, e.message); return null; }
}

// ==============================================================
// CRON JOBS
// ==============================================================

cron.schedule("50 21 * * 1-5", async () => {
  // [v7.7 fix] isWE verwijderd: deze cron draait enkel ma-vr (1-5),
  // dus isWE is altijd false -> de crypto-weekend skip triggerde nooit.
  console.log("🔔 21:50 Brussels  -  auto-close gestart...");
  cronLastRun["AUTOCLOSE_2150"] = new Date().toISOString();
  try {
    const positions = await fetchOpenPositions();
    if (!Array.isArray(positions) || !positions.length) {
      console.log("[ ] Geen open posities bij auto-close.");
    } else {
      for (const pos of positions) {
        try {
          await closePosition(pos.id);
          console.log(`[OK] Auto-close 21:50: ${pos.symbol}`);
          if (openPositions[String(pos.id)]) {
            openPositions[String(pos.id)]._pendingCloseReason = "auto";
          }
          addWebhookHistory({ type:"AUTOCLOSE_2150", symbol:pos.symbol, positionId:pos.id });
        } catch(e) { console.error(`[ERR] Auto-close ${pos.symbol}:`, e.message); }
      }
    }
    await evaluateDailyRisk();
  } catch(e) { console.error("[ERR] Auto-close fout:", e.message); }
}, { timezone: "Europe/Brussels" });

// [v7.8 fix1] EOD Ghost Check cron (21:00) verwijderd.
// Was: aparte cron die om 21:00 zocht naar trades zonder trueMaxRR om dan ghosts te starten.
// Probleem: trades worden pas gesloten om 21:50 → de 21:00 cron vond nooit iets nuttigs.
// Fix: ghostcheck is nu geïntegreerd in syncPositions() — zie aldaar.

cron.schedule("0 22 * * 1-5", async () => {
  console.log("🌙 22:00 Brussels  -  ghost & shadow hard stop...");
  cronLastRun["DAY_END_22:00"] = new Date().toISOString();
  let ghostCount = 0;
  for (const [ghostId, g] of Object.entries(ghostTrackers)) {
    finaliseGhost(ghostId, g.trade, g.bestPrice, g.worstPrice, "auto_close_window", g.startedAt);
    ghostCount++;
  }
  console.log(`[ghost] ${ghostCount} ghost(s) gestopt om 22:00`);
  await runShadowSLOptimizerAll();
  addWebhookHistory({ type:"DAY_END_22:00", ghostsStopped: ghostCount });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 2 * * *", async () => {
  console.log("🔄 02:00 Brussels  -  dagelijkse reconnect...");
  cronLastRun["RECONNECT_02:00"] = new Date().toISOString();
  dailyRiskMultiplier = dailyRiskMultiplierNext;
  console.log(`💰 [Risk] Multiplier: x${dailyRiskMultiplier.toFixed(2)}`);
  await updateConsecutivePositiveDays();
  await restoreOpenPositionsFromMT5();
  recentOrderGuard.clear();
  addWebhookHistory({ type:"RECONNECT_02:00", riskMultiplier: dailyRiskMultiplier });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 3 * * *", async () => {
  console.log("🌙 03:00 Brussels  -  nightly optimizer...");
  cronLastRun["NIGHTLY_OPTIMIZER"] = new Date().toISOString();
  const symbols = [...new Set(closedTrades.map(t => t.symbol).filter(Boolean))];
  for (const sym of symbols) {
    await runTPLockEngine(sym).catch(e => console.error(`[ERR] [TP nightly] ${sym}:`, e.message));
    await runSLLockEngine(sym).catch(e => console.error(`[ERR] [SL nightly] ${sym}:`, e.message));
  }
  await runShadowSLOptimizerAll();
  addWebhookHistory({ type:"NIGHTLY_OPTIMIZER", symbols: symbols.length });
}, { timezone: "Europe/Brussels" });

// ==============================================================
// DAILY RISK
// ==============================================================
async function evaluateDailyRisk() {
  try {
    const todayStr = getBrusselsDateOnly();
    const todayTrades = closedTrades.filter(t =>
      t.closedAt && getBrusselsDateOnly(t.closedAt) === todayStr
    );
    const totalPnl = todayTrades.reduce((sum, t) => sum + (t.realizedPnlEUR ?? 0), 0);
    const evPositive = totalPnl > 0;
    dailyRiskMultiplierNext = evPositive
      ? parseFloat((dailyRiskMultiplier * 1.2).toFixed(4))
      : 1.0;
    await saveDailyRisk(todayStr, totalPnl, todayTrades.length, dailyRiskMultiplier, dailyRiskMultiplierNext);
  } catch(e) { console.warn("[!] evaluateDailyRisk:", e.message); }
}

async function updateConsecutivePositiveDays() {
  const yesterday = getBrusselsDateOnly(new Date(Date.now() - 86400000));
  for (const [lockKey] of Object.entries(tpLocks)) {
    const [sym, sess] = lockKey.split("__");
    const yesterdayTrades = closedTrades.filter(t =>
      t.symbol === sym && t.session === sess && t.closedAt &&
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
  }
}

// [v7.3] Reconstrueer consecutivePositiveDays bij startup vanuit closedTrades
// Zonder dit verliest elke herstart de streaks en werkt de compound boost nooit
function reconstructConsecutivePositiveDays() {
  const MAX_LOOKBACK_DAYS = 30;
  // Genereer lijst van datumstrings: gisteren, eergisteren, ...
  // Weekenddagen worden overgeslagen: geen trades in weekend != negatieve dag.
  // Zonder deze skip brak elke maandag de streak, waardoor de compound boost nooit werkte.
  const dayStrings = [];
  // [v7.7 fix] outer loop was i <= 30 (kalender) maar dayStrings.length < 30 stopt al na ~22 werkdagen in 30 kd.
  // Als je 30 werkdagen wil, itereer over meer kalenderdagen (50 = voldoende buffer).
  const MAX_CALENDAR_LOOKBACK = 50;
  for (let i = 1; i <= MAX_CALENDAR_LOOKBACK && dayStrings.length < MAX_LOOKBACK_DAYS; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const { day } = getBrusselsComponents(d); // [v7.4] Brussels weekday ipv UTC d.getDay()
    if (day === 0 || day === 6) continue; // weekend overslaan
    dayStrings.push(getBrusselsDateOnly(d));
  }
  for (const lockKey of Object.keys(tpLocks)) {
    const [sym, sess] = lockKey.split("__");
    let streak = 0;
    for (const dayStr of dayStrings) {
      const dayTrades = closedTrades.filter(t =>
        normalizeSymbol(t.symbol) === normalizeSymbol(sym) &&
        t.session === sess && t.closedAt &&
        getBrusselsDateOnly(t.closedAt) === dayStr
      );
      if (!dayTrades.length) break; // Geen trades op deze werkdag = streak stopt
      const rrArr = dayTrades.map(t => t.trueMaxRR ?? t.maxRR ?? 0);
      const bestEV = RR_LEVELS.reduce((best, rr) => {
        const wins = rrArr.filter(r => r >= rr).length;
        const wr   = wins / rrArr.length;
        const ev   = wr * rr - (1 - wr);
        return ev > best ? ev : best;
      }, -Infinity);
      if (bestEV > 0) streak++;
      else break; // Negatieve EV dag = streak gebroken
    }
    consecutivePositiveDays[lockKey] = streak;
  }
  const nonZero = Object.values(consecutivePositiveDays).filter(v => v > 0).length;
  console.log(`📅 [Startup] consecutivePositiveDays gereconstrueerd  -  ${Object.keys(consecutivePositiveDays).length} keys, ${nonZero} actieve streaks`);
}

// -- RESTART RECOVERY ------------------------------------------
async function restoreOpenPositionsFromMT5() {
  try {
    const live = await fetchOpenPositions();
    const liveIds = new Set((Array.isArray(live) ? live : []).map(p => String(p.id)));

    // [v7.3] Verwijder posities die tijdens downtime zijn gesloten uit openPositions + tracker
    // Zonder deze cleanup denkt het systeem dat ze nog open staan -> tracker klopt niet
    for (const [id, pos] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        decrementTracker(pos.symbol, pos.direction);
        delete openPositions[id];
        console.log(`🔧 [Restart Recovery] ${pos.symbol} ${pos.direction} tijdens downtime gesloten  -  verwijderd uit tracker`);
      }
    }

    if (!Array.isArray(live) || !live.length) {
      console.log(`[OK] [Restart Recovery] Geen open posities op MT5`);
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
    }
    console.log(`[OK] [Restart Recovery] ${restored} positie(s) hersteld`);
  } catch(e) { console.warn("[!] [Restart Recovery]:", e.message); }
}

async function repairOrphanedGhosts() {
  let repaired = 0;
  for (const trade of closedTrades) {
    if ((trade.trueMaxRR === null || trade.trueMaxRR === undefined) && (trade.maxRR ?? 0) > 0) {
      trade.trueMaxRR       = trade.maxRR;
      trade.ghostStopReason = "restart_lost";
      trade.ghostFinalizedAt = new Date().toISOString();
      saveTrade(trade).catch(() => {});
      repaired++;
    }
  }
  if (repaired > 0) console.log(`🔧 [Orphan Repair] ${repaired} trades gerepareerd`);
}

// -- FOREX / SPREAD / DUPLICATE --------------------------------
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

// -- HELPERS ---------------------------------------------------
function getEffectiveRisk(symbol, direction) {
  const key     = `${symbol}_${direction}`;
  const count   = openTradeTracker[key] || 0;
  const type    = getSymbolType(symbol) || "stock";
  const base    = BASE_RISK[type] || 30;
  const baseWithMult = base * dailyRiskMultiplier;
  // [v7.8 fix5] Compound boost geldt voor ALLE trades als de lock positieve EV heeft —
  // niet enkel de eerste (count===0). Rationale: als het systeem statistisch bewezen is
  // voor dit pair/sessie, verdient elke trade de boosted risico-allocatie.
  // De pyramiding-halvering wordt hier bewust uitgeschakeld — 4x is de vaste bodem.
  const curSess = getSessionGMT1();
  const lockKey = `${symbol}__${curSess}`;
  const lock    = tpLocks[lockKey];
  if (lock && (lock.evAtLock ?? 0) > 0) {
    const positiveDays  = consecutivePositiveDays[lockKey] || 0;
    const compoundBoost = Math.pow(1.2, positiveDays);
    return base * TP_LOCK_RISK_MULT * compoundBoost * dailyRiskMultiplier;
  }
  // Geen positieve lock → normale pyramiding-halvering
  let risk = Math.max(baseWithMult * 0.10, baseWithMult / Math.pow(2, count));
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
    return parseFloat(adj.toFixed(5));
  }
  return sl;
}

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
  const baseRisk     = BASE_RISK[type] || 30;
  const isTPLockRisk = risk >= baseRisk * TP_LOCK_RISK_MULT;
  const effectiveCap = isTPLockRisk ? baseRisk * TP_LOCK_RISK_MULT : baseRisk;
  const minCost      = lots * dist * lotVal;
  if (minCost > effectiveCap * dailyRiskMultiplier * 1.5) return null;
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

function calcMAE(trade, worstPrice) {
  const d = Math.abs(trade.entry - trade.sl);
  if (!d || worstPrice == null) return 0;
  const adverse = trade.direction === "buy"
    ? trade.entry - worstPrice
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
      label: mult===1.0?"[OK] huidig":mult<1.0?`🔽 ${mult}x kleiner`:`🔼 ${mult}x groter`,
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

// ==============================================================
// GHOST TRACKER v7.0
// ==============================================================
function startGhostTracker(closedTrade, isManual = false) {
  const ghostId      = `ghost_${closedTrade.id}_${Date.now()}`;
  const startedAt    = Date.now();
  const maxRRAtClose = closedTrade.maxRR ?? 0;
  let bestPrice      = closedTrade.maxPrice ?? closedTrade.entry;
  let worstPrice     = closedTrade.entry;
  let currentTimer   = null;

  async function tick() {
    try {
      const elapsed    = Date.now() - startedAt;
      const ghostOk    = isGhostActive();
      const shouldStop = elapsed >= GHOST_DURATION_MS || !ghostOk;
      const priceData  = await fetchCurrentPrice(closedTrade.mt5Symbol);
      const price      = priceData?.mid ?? null;
      if (price !== null) {
        const betterForTrade = closedTrade.direction === "buy" ? price > bestPrice : price < bestPrice;
        if (betterForTrade) bestPrice = price;
        const worseForTrade = closedTrade.direction === "buy" ? price < worstPrice : price > worstPrice;
        if (worseForTrade) worstPrice = price;
        if (ghostTrackers[ghostId]) {
          ghostTrackers[ghostId].bestPrice  = bestPrice;
          ghostTrackers[ghostId].worstPrice = worstPrice;
        }
        const slBreach = closedTrade.direction === "buy"
          ? price <= closedTrade.sl
          : price >= closedTrade.sl;
        if (slBreach) {
          const minutesElapsed = Math.round(elapsed / 60000);
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
    } catch(e) { console.warn(`[!] Ghost ${ghostId}:`, e.message); }
  }

  currentTimer = setTimeout(tick, GHOST_INTERVAL_RECENT_MS);
  ghostTrackers[ghostId] = {
    trade: closedTrade, timer: currentTimer, startedAt,
    bestPrice, worstPrice, isManual,
    failsafeTimer: null,  // [v7.3] aparte failsafe timer zodat 22:00 hard stop hem ook kan clearen
  };

  const failsafeTimer = setTimeout(() => {
    if (ghostTrackers[ghostId]) {
      const g = ghostTrackers[ghostId];
      finaliseGhost(ghostId, closedTrade, g.bestPrice, g.worstPrice, "failsafe", startedAt, null);
    }
  }, GHOST_DURATION_MS + 5 * 60 * 1000);
  ghostTrackers[ghostId].failsafeTimer = failsafeTimer;
}

function finaliseGhost(ghostId, trade, bestPrice, worstPrice, reason, startedAt, timeToSL = null) {
  if (!ghostTrackers[ghostId]) return;
  clearTimeout(ghostTrackers[ghostId].timer);
  clearTimeout(ghostTrackers[ghostId].failsafeTimer);  // [v7.3] ook failsafe timer stoppen
  const isManual = ghostTrackers[ghostId].isManual ?? false;
  delete ghostTrackers[ghostId];

  const trueMaxRR    = calcMaxRRFromPrice(trade, bestPrice);
  const maxRRAtClose = trade.maxRR ?? 0;
  const ghostExtraRR = parseFloat((trueMaxRR - maxRRAtClose).toFixed(3));
  const ghostMAE     = calcMAE(trade, worstPrice);
  const ghostHitSL   = reason === "phantom_sl" || ghostMAE >= 1.0;
  const ghostDurationMin = startedAt ? Math.round((Date.now() - startedAt) / 60000) : null;

  const idx = closedTrades.findIndex(t => t.id === trade.id);
  if (idx !== -1) {
    closedTrades[idx].trueMaxRR        = trueMaxRR;
    closedTrades[idx].trueMaxPrice     = bestPrice;
    closedTrades[idx].ghostStopReason  = reason;
    closedTrades[idx].ghostFinalizedAt = new Date().toISOString();
    saveTrade(closedTrades[idx]).catch(() => {});
    saveGhostAnalysis({
      symbol: trade.symbol, session: trade.session, direction: trade.direction,
      entry: trade.entry, sl: trade.sl, tp: trade.tp,
      maxRRAtClose, trueMaxRR, ghostExtraRR,
      hitTP: trade.hitTP ?? false, ghostStopReason: reason, ghostDurationMin,
      ghostFinalizedAt: new Date().toISOString(), closedAt: trade.closedAt,
      realizedPnlEUR: trade.realizedPnlEUR ?? null, tradePositionId: trade.id,
      ghostHitSL, ghostMAE, ghostTimeToSL: timeToSL ?? null, isManual,
      closeReason: trade.closeReason ?? "unknown",
    }).catch(() => {});
    console.log(`[OK] Ghost ${trade.symbol} -> trueMaxRR: ${trueMaxRR}R | extra: +${ghostExtraRR}R | MAE: ${ghostMAE}R | ${reason}`);
    runTPLockEngine(trade.symbol).catch(() => {});
    runSLLockEngine(trade.symbol).catch(() => {});
    const ghostFinished = closedTrades.filter(t => t.symbol === trade.symbol && t.trueMaxRR !== null).length;
    if (ghostFinished >= SHADOW_SL_MIN_TRADES) {
      runShadowSLOptimizer(trade.symbol).catch(() => {});
    }
  }
}

// ==============================================================
// TP LOCK ENGINE
// ==============================================================
async function runTPLockEngine(symbol) {
  for (const session of TRADING_SESSIONS) {
    await _runTPLockForSession(symbol, session).catch(() => {});
  }
}

async function _runTPLockForSession(symbol, session) {
  if (!session || session === "all") return;
  const trades = closedTrades.filter(t =>
    normalizeSymbol(t.symbol) === normalizeSymbol(symbol) &&
    t.sl && t.entry && t.session === session
  );
  const n       = trades.length;
  const lockKey = `${symbol}__${session}`;
  if (n < 3) return;
  const existing  = tpLocks[lockKey];
  const evTable   = RR_LEVELS.map(rr => {
    const wins = trades.filter(t => getBestRR(t) >= rr).length;
    const wr   = wins / n;
    return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)) };
  });
  const best       = evTable.reduce((a,b) => b.ev > a.ev ? b : a);
  const evPositive = best.ev > 0;
  const effectiveRR = best.rr; // [v7.3] altijd statistisch beste RR, ook bij negatieve EV
  const oldRR       = existing?.lockedRR ?? null;
  const isNew       = !existing;
  const changed     = existing && existing.lockedRR !== effectiveRR;
  const needsUpdate = existing && (n - existing.lockedTrades) >= 5;
  if (!isNew && !changed && !needsUpdate) {
    tpLocks[lockKey] = { ...existing, lockedTrades: n };
    return;
  }
  const reason = isNew
    ? `eerste lock na ${n} trades [${session}] -> ${effectiveRR}R`
    : `update na ${n} trades (${oldRR}R -> ${effectiveRR}R) [${session}]`;
  tpLocks[lockKey] = {
    lockedRR: effectiveRR, lockedAt: new Date().toISOString(), lockedTrades: n,
    session, prevRR: oldRR, prevLockedAt: existing?.lockedAt ?? null,
    evAtLock: best.ev, evPositive,
  };
  delete tpLocks[`${symbol}__all`];
  const logEntry = { symbol, session, oldRR, newRR: effectiveRR, trades: n, ev: best.ev, reason, ts: new Date().toISOString() };
  tpUpdateLog.unshift(logEntry);
  if (tpUpdateLog.length > MAX_TP_LOG) tpUpdateLog.length = MAX_TP_LOG;
  try {
    await saveTPConfig(symbol, session, effectiveRR, n, best.ev, oldRR, existing?.lockedAt ?? null);
    await logTPUpdate(symbol, session, oldRR, effectiveRR, n, best.ev, reason);
  } catch(e) { console.error(`[ERR] [TP Lock] DB:`, e.message); }
}

// ==============================================================
// SL LOCK ENGINE
// ==============================================================
async function runSLLockEngine(symbol) {
  // [v7.3 fix] Guard verwijderd: isShadowActive() blokkeerde ghost-finalisaties om 22:00
  // en de nightly optimizer om 03:00 (buiten tradingvenster). Analyse is puur statistisch
  // en mag altijd draaien  -  enkel live order plaatsing vereist market-open check.
  const trades = closedTrades.filter(t =>
    normalizeSymbol(t.symbol) === normalizeSymbol(symbol) && t.sl && t.entry
  );
  const n = trades.length;
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
  const reason        = isNew ? `eerste analyse na ${n} trades` : `update na ${n} trades`;
  const appliedAt     = autoApply ? new Date().toISOString() : null;
  const appliedTrades = autoApply ? n : null;
  slLocks[symbol] = {
    multiplier: best.slMultiple, direction, lockedAt: new Date().toISOString(),
    lockedTrades: n, evAtLock: best.bestEV, bestTPRR: parseFloat(best.bestTP),
    prevMultiplier: oldMult, prevLockedAt: existing?.lockedAt ?? null,
    autoApplied: autoApply, appliedAt, appliedTrades,
    note: autoApply ? `[OK] AUTO APPLIED na ${n} trades` : `⏳ READONLY  -  nog ${SL_AUTO_APPLY_THRESHOLD - n} trades tot auto-apply`,
    directionLabel: direction === "up" ? "🔼 Vergroot SL" : direction === "down" ? "🔽 Verklein SL" : "[OK] Huidig optimaal",
  };
  slUpdateLog.unshift({ symbol, oldMultiplier: oldMult, newMultiplier: best.slMultiple, direction, trades: n, ev: best.bestEV, reason, autoApplied: autoApply, ts: new Date().toISOString() });
  if (slUpdateLog.length > MAX_SL_LOG) slUpdateLog.length = MAX_SL_LOG;
  try {
    await saveSLConfig(symbol, best.slMultiple, direction, n, best.bestEV, parseFloat(best.bestTP), oldMult, existing?.lockedAt ?? null, autoApply, appliedAt, appliedTrades);
    await logSLUpdate(symbol, oldMult, best.slMultiple, direction, n, best.bestEV, reason, autoApply);
  } catch(e) { console.error(`[ERR] [SL Analyse] DB:`, e.message); }
}

// ==============================================================
// SL SHADOW OPTIMIZER
// ==============================================================
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
        return ((t.trueMaxRR ?? 0) / mult) >= rr;
      }).length;
      const wr = wins / trades.length;
      return { rr, ev: parseFloat((wr * rr - (1 - wr)).toFixed(3)), winrate: parseFloat((wr * 100).toFixed(1)) };
    });
    const best = evTable.reduce((a, b) => b.ev > a.ev ? b : a);
    const slHits = trades.filter(t => (t.ghostMAE ?? calcMAE(t, t.trueMaxPrice)) >= mult).length;
    const slHitRate = slHits / trades.length;

    // [v7.8 fix2] Kelly Criterion weighting
    // Kelly fraction = EV / RR — straft hoge RR met lage winrate af.
    // Een multiplier met EV=0.30 op 3R (Kelly=0.10) is minder stabiel dan
    // EV=0.22 op 1.5R (Kelly=0.147) → Kelly kiest de stabielere optie.
    // Penalty: hoge slHitRate = hoge variance = lagere Kelly score.
    const kellyFraction = best.rr > 0
      ? Math.max(0, best.ev / best.rr) * (1 - slHitRate)
      : 0;

    return {
      slMultiplier: mult,
      bestEV: best.ev,
      bestRR: best.rr,
      bestWinrate: best.winrate,
      slHitRate: parseFloat((slHitRate * 100).toFixed(1)),
      kellyFraction: parseFloat(kellyFraction.toFixed(4)),
      evTable,
    };
  });

  // [v7.8 fix2] Selecteer op Kelly-gewogen score ipv enkel hoogste EV
  // Alleen tussen multipliers met positieve EV — bij negatieve EV → hoogste EV wint nog steeds
  const positiveEV = results.filter(r => r.bestEV > 0);
  const bestResult = positiveEV.length > 0
    ? positiveEV.reduce((a, b) => b.kellyFraction > a.kellyFraction ? b : a)
    : results.reduce((a, b) => b.bestEV > a.bestEV ? b : a);

  const previous = shadowSLResults[symbol];
  shadowSLResults[symbol] = {
    symbol, best: bestResult, allMultiples: results, tradesUsed: trades.length,
    computedAt: new Date().toISOString(),
  };
  await saveShadowSLAnalysis(
    symbol, bestResult.slMultiplier, bestResult.bestEV, bestResult.bestRR,
    bestResult.bestWinrate, bestResult.slHitRate, trades.length,
    bestResult.kellyFraction
  ).catch(() => {});
  if (previous && previous.best.slMultiplier !== bestResult.slMultiplier) {
    await logShadowSLChange(
      symbol, previous.best.slMultiplier, bestResult.slMultiplier,
      previous.best.bestEV, bestResult.bestEV, trades.length, `recompute`
    ).catch(() => {});
  }
}

async function runShadowSLOptimizerAll() {
  const symbols = [...new Set(closedTrades.filter(t => t.trueMaxRR !== null).map(t => normalizeSymbol(t.symbol)))];
  for (const sym of symbols) {
    await runShadowSLOptimizer(sym).catch(() => {});
  }
}

// -- SL MULTIPLIER v7.4 ----------------------------------------
//
// Prioriteitsvolgorde (hoog -> laag):
//   1. SL Lock Engine auto-applied (>=30 trades) -> statistische best EV multiplier
//   2. Shadow SL Optimizer (>=30 ghost trades) + TP Lock aanwezig -> shadow best multiplier
//   3. SL Lock Engine readonly (10-29 trades)  + TP Lock aanwezig -> SL Lock multiplier
//   4. TP Lock aanwezig maar geen SL-data       + TP Lock aanwezig -> 0.5x fallback
//   5. Geen van bovenstaande                                       -> 1.0x (geen aanpassing)
//
// Rationale: halvering is NOOIT zomaar hardcoded. Het systeem gebruikt altijd
// de statistisch beste EV-multiplier uit de analyse-engines. Enkel als er
// helemaal geen data beschikbaar is maar er WEL een TP Lock is (>=30 trades),
// wordt 0.5x gebruikt als conservatieve fallback  -  dit is expliciet en gedocumenteerd.
//
function getEffectiveSLMultiplier(symbol, session, entryNum, slNum, direction) {
  const slLock    = slLocks[symbol];
  const tpLockKey = `${symbol}__${session}`;
  const tpLockNow = tpLocks[tpLockKey];
  const shadow    = shadowSLResults[symbol];

  const tpLockTrades   = tpLockNow?.lockedTrades ?? 0;
  const tpHalfEligible = tpLockNow && tpLockTrades >= SL_AUTO_APPLY_THRESHOLD;

  let multiplier = 1.0;
  let info       = "geen aanpassing";
  let source     = "none";

  // -- Mechanisme 1: SL Lock Engine auto-applied (>=30 trades) --
  // Statistisch bepaald via buildSLAnalysis() over alle closed trades.
  // Wordt automatisch toegepast zodra >=30 trades beschikbaar zijn.
  if (slLock?.autoApplied && slLock.multiplier !== 1.0) {
    multiplier = slLock.multiplier;
    source     = "sl_lock_auto";
    info       = `${multiplier}x (SL Lock Engine auto-applied, ${slLock.appliedTrades} trades, EV=${slLock.evAtLock?.toFixed(3) ?? '?'})`;

  // -- Mechanisme 2: Shadow SL Optimizer + TP Lock rijp ---------
  // Shadow gebruikt trueMaxRR (ghost-gecorrigeerde data)  -  nauwkeuriger dan SL Lock.
  // Alleen actief als TP Lock ook rijp is (>=30 trades), anders te weinig context.
  } else if (tpHalfEligible && shadow?.best?.slMultiplier && shadow.best.slMultiplier !== 1.0) {
    const shadowMult = shadow.best.slMultiplier;
    const shadowEV   = shadow.best.bestEV ?? 0;
    // Gebruik shadow alleen als het een duidelijke EV-verbetering geeft
    if (shadowEV > 0) {
      multiplier = shadowMult;
      source     = "shadow_optimizer";
      info       = `${multiplier}x (Shadow SL Optimizer, ${shadow.tradesUsed} ghost trades, EV=${shadowEV.toFixed(3)})`;
    }
  }

  // -- Mechanisme 3: SL Lock Engine readonly (10-29 trades) + TP Lock rijp --
  // Nog niet auto-applied maar data is beschikbaar. Gebruik voorzichtig.
  if (source === "none" && tpHalfEligible && slLock && !slLock.autoApplied && slLock.multiplier !== 1.0) {
    const slEV = slLock.evAtLock ?? 0;
    if (slEV > 0) {
      multiplier = slLock.multiplier;
      source     = "sl_lock_readonly";
      info       = `${multiplier}x (SL Lock Engine readonly, ${slLock.lockedTrades} trades, EV=${slEV.toFixed(3)})`;
    }
  }

  // -- Mechanisme 4: TP Lock rijp maar GEEN SL-data -> 0.5x fallback --------
  // Enige geval waar 0.5x hardcoded wordt toegepast  -  bewust en gedocumenteerd.
  // Rationale: TP Lock geeft aan dat het systeem de trade statistisch begrijpt,
  // maar zonder SL-analyse is verkleinen van SL conservatief zinvol.
  if (source === "none" && tpHalfEligible) {
    multiplier = 0.5;
    source     = "tp_lock_fallback";
    info       = `0.5x (TP Lock fallback  -  geen SL-data voor ${symbol}/${session}, ${tpLockTrades} trades)`;
  }

  const newSL = applySlMultiplier(direction, entryNum, slNum, multiplier);
  return { multiplier, slApplied: newSL, info, source };
}

// [v7.8 fix4] Insta-SL "spread-killed" logging
// Trades die meteen SL raken (maxRR ≤ 0.05) krijgen geen ghost maar worden
// wel gecategoriseerd zodat patronen zichtbaar worden:
// welk uur, welke sessie, welk symbool gets systematisch spread-killed?
async function logInstaSL(trade) {
  try {
    const { hour } = getBrusselsComponents();
    const priceData = await fetchCurrentPrice(trade.mt5Symbol || trade.symbol).catch(() => null);
    const spread = priceData?.spread ?? null;
    await saveInstaSL({
      symbol:    trade.symbol,
      mt5Symbol: trade.mt5Symbol ?? null,
      session:   trade.session   ?? getSessionGMT1(),
      direction: trade.direction,
      entry:     trade.entry,
      sl:        trade.sl,
      spread,
      hourBrussels: hour,
      closedAt:  trade.closedAt ?? new Date().toISOString(),
    });
    console.log(`[insta-sl] ${trade.symbol} spread-killed | spread=${spread} | uur=${hour}:00`);
  } catch(e) { console.warn("[!] logInstaSL:", e.message); }
}


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
      trade.currentPnL = parseFloat((pos.unrealizedProfit ?? pos.profit ?? ((trade.direction==="buy" ? cur-trade.entry : trade.entry-cur) * trade.lots * lotV)).toFixed(2));
      const better = trade.direction==="buy" ? cur > (trade.maxPrice ?? trade.entry) : cur < (trade.maxPrice ?? trade.entry);
      if (better) { trade.maxPrice = cur; trade.maxRR = calcMaxRR({...trade, maxPrice:cur}); }
      trade.currentPrice = cur;
      trade.lastSync = new Date().toISOString();
    }
    for (const [id, trade] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        const maxRR          = calcMaxRR(trade);
        const session        = getSessionGMT1(trade.openedAt);
        const realizedPnlEUR = trade.currentPnL ?? 0;
        const hitTP          = trade.tp != null && maxRR >= Math.abs((trade.direction==="buy" ? trade.tp-trade.entry : trade.entry-trade.tp) / Math.abs(trade.entry-trade.sl));
        let closeReason      = trade._pendingCloseReason ?? "manual";
        if (closeReason === "manual" || closeReason === "unknown") {
          if (hitTP) closeReason = "tp";
          else if (maxRR <= 0.05) closeReason = "sl";
          // [v7.2] Als niet TP/SL en geen pending reden -> manual close
        }
        const closed = {
          ...trade, closedAt: new Date().toISOString(), maxRR, session,
          sessionLabel: SESSION_LABELS[session] || session,
          trueMaxRR: null, trueMaxPrice: null,
          realizedPnlEUR, hitTP, closeReason, maxRRAtClose: maxRR,
        };
        closedTrades.push(closed);
        saveTrade(closed).catch(() => {});
        savePnlLog(trade.symbol, session, trade.direction, maxRR, hitTP, realizedPnlEUR).catch(() => {});
        if (trade.symbol && trade.direction) decrementTracker(trade.symbol, trade.direction);
        delete openPositions[id];
        console.log(`📦 ${trade.symbol} gesloten | MaxRR: ${maxRR}R | closeReason: ${closeReason}`);
        // [v7.8 fix1] Ghost check geïntegreerd: na elke close direct controleren of
        // ghost al loopt. Vervangt de aparte 21:00 cron die te vroeg draaide.
        const isInstaSL = closeReason === "sl" && maxRR <= 0.05;
        if (!isInstaSL) {
          startGhostTracker(closed, closeReason === "manual");
        } else {
          // [v7.8 fix4] Insta-SL: geen ghost maar wel spread-killed logging
          logInstaSL(trade).catch(() => {});
        }
      }
    }
    if (Date.now() - lastAccountSync > ACCOUNT_SYNC_INTERVAL) {
      lastAccountSync = Date.now();
      try {
        const info = await fetchAccountInfo();
        const snap = {
          ts: new Date().toISOString(), balance: info.balance ?? null, equity: info.equity ?? null,
          floatingPL: parseFloat(((info.equity??0)-(info.balance??0)).toFixed(2)),
          margin: info.margin ?? null, freeMargin: info.freeMargin ?? null,
        };
        accountSnapshots.push(snap);
        if (accountSnapshots.length > MAX_SNAPSHOTS) accountSnapshots.shift();
        saveSnapshot(snap).catch(() => {});
      } catch(e) { console.warn("[!] Snapshot mislukt:", e.message); }
    }
    // [v7.8 fix1] Periodieke orphan ghost check — vervangt de 21:00 EOD cron.
    // Elke sync-cyclus: controleer of er gesloten trades zijn zonder trueMaxRR
    // die ook geen actieve ghost hebben. Als isGhostActive() → start alsnog.
    if (isGhostActive()) {
      for (const trade of closedTrades) {
        if (trade.trueMaxRR !== null || (trade.maxRR ?? 0) <= 0.05) continue;
        const alreadyRunning = Object.values(ghostTrackers).some(g => g.trade.id === trade.id);
        if (alreadyRunning) continue;
        const closedAt = trade.closedAt ? new Date(trade.closedAt).getTime() : 0;
        const age = Date.now() - closedAt;
        if (age < GHOST_DURATION_MS) {
          startGhostTracker(trade, trade.closeReason === "manual");
        }
      }
    }
  } catch(e) { console.warn("[!] syncPositions:", e.message); }
}
setInterval(syncPositions, 30 * 1000);

// -- ERROR LEARNING --------------------------------------------
function learnFromError(symbol, code, msg) {
  const m = (msg||"").toLowerCase();
  if (!learnedPatches[symbol]) learnedPatches[symbol] = {};
  if (code==="TRADE_RETCODE_INVALID" && m.includes("symbol")) {
    const cur = getMT5Symbol(symbol);
    const tried = learnedPatches[symbol]._triedMt5 || [];
    const next = [cur.replace(".cash",""), cur+".cash"].filter(s => s!==cur && !tried.includes(s))[0];
    if (next) { learnedPatches[symbol].mt5Override = next; learnedPatches[symbol]._triedMt5 = [...tried, next]; }
  }
  if (m.includes("volume")||m.includes("lot"))
    learnedPatches[symbol].lotStepOverride = (learnedPatches[symbol]?.lotStepOverride || 0.01) * 10;
  if (m.includes("stop")||code==="TRADE_RETCODE_INVALID_STOPS") {
    const mt5 = getMT5Symbol(symbol);
    const type = getSymbolType(symbol) || "index";
    if (type==="index") MIN_STOP_INDEX[mt5] = (MIN_STOP_INDEX[mt5] || 5) * 2;
    else if (type==="forex") MIN_STOP_FOREX[mt5] = (MIN_STOP_FOREX[mt5] || 0.0005) * 2;
  }
}

// -- ORDER PLAATSEN --------------------------------------------
async function placeOrder(dir, symbol, entry, sl, lots, session) {
  const mt5Symbol = getMT5Symbol(symbol);
  const type      = getSymbolType(symbol) || "stock";
  const slPrice   = validateSL(dir, entry, sl, mt5Symbol, type);
  const lockKey   = `${symbol}__${session}`;
  const tpLock    = tpLocks[lockKey];
  const tpRR      = tpLock ? tpLock.lockedRR : FIXED_TP_RR;
  // [v7.3] "geen FIXED_TP_RR fallback" = geen fallback bij negatieve EV (lock altijd statistisch beste RR).
  // Voor symbolen zonder lock (< 3 trades) is 4R nog steeds de initiele fallback  -  dit is correct gedrag.
  const tpPrice   = calcTPPrice(dir, entry, slPrice, tpRR);
  const body      = {
    symbol: mt5Symbol, volume: lots,
    actionType: dir==="buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    stopLoss: slPrice, takeProfit: tpPrice,
    // [v7.9 fix5] MT5 comment limit ~26 chars. Oud: "FTMO-NV-BUY-USDCAD-TP4R-london" = 31 chars -> HTTP 400.
    // Nieuw: "NV-B-USDCAD-4R-LON" = max 20 chars -> altijd binnen limiet.
    comment: `NV-${dir[0].toUpperCase()}-${symbol.slice(0,6)}-${tpRR}R-${session.slice(0,3).toUpperCase()}`,
  };
  // [v7.7 fix] AbortController toegevoegd op de /trade POST
  // Voorheen: geen signal -> fetch kon hangen na Promise.race timeout in placeOrderWithTimeout
  // -> stale connections accumuleerden op Railway
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${META_BASE}/trade`, {
      method: "POST",
      headers: {"Content-Type":"application/json","auth-token":META_API_TOKEN},
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    // [v7.9 fix] r.ok check toegevoegd: HTTP 4xx/5xx van MetaApi werden stilzwijgend
    // als geldig JSON geparsed zonder dat de error herkend werd als fout.
    // Nu wordt de HTTP status + body als Error gegooid zodat placeOrderWithTimeout
    // hem correct afhandelt en de foutdetails in het dashboard verschijnen.
    const data = await r.json();
    if (!r.ok) {
      const httpMsg = (typeof data?.message === "string" ? data.message : null)
                   || (typeof data?.error   === "string" ? data.error   : null)
                   || `HTTP ${r.status}`;
      throw new Error(`MetaApi HTTP ${r.status}: ${httpMsg}`);
    }
    return { result: data, mt5Symbol, slPrice, body, tpPrice, tpRR };
  } catch(e) { clearTimeout(t); throw e; }
}

async function placeOrderWithTimeout(dir, symbol, entry, sl, lots, session) {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("MetaApi timeout")), 8000));
  return Promise.race([placeOrder(dir, symbol, entry, sl, lots, session), timeout]);
}

// ==============================================================
// WEBHOOK
// ==============================================================
app.post("/webhook", async (req, res) => {
  try {
    const secret = req.query.secret || req.headers["x-secret"];
    if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error:"Unauthorized" });
    const rawSymbol = (!req.body.symbol || req.body.symbol==="{{ticker}}") ? null : req.body.symbol;
    if (!rawSymbol) return res.status(400).json({ error:"Symbool ontbreekt" });
    const symbol = normalizeSymbol(rawSymbol);
    const inMap = !!SYMBOL_MAP[symbol];
    const hasLearnedPatch = !!(learnedPatches[symbol]?.mt5Override);
    if (!inMap && !hasLearnedPatch) {
      addWebhookHistory({ type:"SYMBOL_NOT_IN_MAP", symbol });
      return res.status(200).json({ status:"SKIP", reason:`Symbol ${symbol} not in SYMBOL_MAP` });
    }
    const { action, entry, sl } = req.body;
    if (!action||!entry||!sl) return res.status(400).json({ error:"Vereist: action, entry, sl" });
    const direction = ["buy","bull","long"].includes(action.toLowerCase()) ? "buy" : "sell";
    const entryNum  = parseFloat(entry);
    let   slNum     = parseFloat(sl);
    if (isNaN(entryNum)||isNaN(slNum)) return res.status(400).json({ error:"entry/sl geen getallen" });
    if (direction==="buy"  && slNum>=entryNum) return res.status(400).json({ error:"SL onder entry voor BUY" });
    if (direction==="sell" && slNum<=entryNum) return res.status(400).json({ error:"SL boven entry voor SELL" });
    if (isDuplicateOrder(symbol, direction)) {
      logDuplicateEntry(symbol, direction, "duplicate").catch(() => {});
      addWebhookHistory({ type:"DUPLICATE_BLOCKED", symbol, direction });
      return res.status(200).json({ status:"SKIP", reason:`Duplicate geblokkeerd` });
    }
    const symType    = getSymbolType(symbol) || "stock";
    const mt5Sym     = getMT5Symbol(symbol);
    const curSession = getSessionGMT1();
    if (!isMarketOpen(symType, symbol)) {
      addWebhookHistory({ type:"MARKET_CLOSED", symbol, symType });
      return res.status(200).json({ status:"SKIP", reason:`Markt gesloten voor ${symbol}` });
    }
    let forexHalfRisk = false, forexTrade2 = false;
    if (symType === "forex") {
      const consol = checkForexConsolidation(symbol, direction);
      if (consol.blocked) {
        logForexConsolidation(symbol, direction, consol.count, "max 2x").catch(() => {});
        addWebhookHistory({ type:"FOREX_PYRAMID_BLOCKED", symbol, direction });
        return res.status(200).json({ status:"SKIP", reason:`Forex pyramiding max 2x` });
      }
      if (consol.halfRisk) { forexHalfRisk = true; forexTrade2 = true; }
    }
    const { multiplier: slMult, slApplied, info: slLockInfo } =
      getEffectiveSLMultiplier(symbol, curSession, entryNum, slNum, direction);
    if (symType === "stock") {
      const priceData = await fetchCurrentPrice(mt5Sym).catch(() => null);
      if (priceData?.spread > 0) {
        const sg = checkSpreadGuard(priceData.spread, entryNum, slApplied);
        if (!sg.ok) {
          addWebhookHistory({ type:"SPREAD_GUARD_BLOCKED", symbol });
          return res.status(200).json({ status:"SKIP", reason:`Spread te groot: ${sg.spreadPct}%` });
        }
      }
    }
    let risk = getEffectiveRisk(symbol, direction);
    if (forexHalfRisk) {
      const lock = tpLocks[`${symbol}__${curSession}`];
      const evPos = lock && (lock.evAtLock ?? 0) > 0;
      risk = evPos ? risk * 0.5 : (BASE_RISK[symType] || 15) * dailyRiskMultiplier * 0.5;
    }

    // [v7.3] Forex: altijd vaste lotgrootte  -  geen risico-berekening nodig
    // Trade 1 (geen open zelfde richting) = 0.25L, Trade 2 = 0.12L
    // [v7.9 fix4] Bij positieve EV lock wordt de lotsize x4 verhoogd (niet de risicobedrag).
    // Compound boost (1.2^streak) wordt bovenop de x4 toegepast, identiek aan andere types.
    // forexTrade2 (pyramiding) krijgt ook de boost maar behoudt de halveringsverhouding (0.12/0.25).
    let lots;
    if (symType === "forex") {
      const forexLockKey   = `${symbol}__${curSession}`;
      const forexLock      = tpLocks[forexLockKey];
      const forexEvPositive = forexLock && (forexLock.evAtLock ?? 0) > 0;
      const forexStreak    = consecutivePositiveDays[forexLockKey] || 0;
      const forexCompound  = forexEvPositive ? Math.pow(1.2, forexStreak) : 1.0;
      const forexBoost     = forexEvPositive ? 4 * forexCompound : 1.0;
      const baseLots       = forexTrade2 ? 0.12 : 0.25;
      lots = parseFloat((baseLots * forexBoost).toFixed(2));
      if (forexEvPositive) {
        console.log(`[Forex EV boost] ${symbol} ${curSession}: ${baseLots}L x${forexBoost.toFixed(2)} (EV=${(forexLock.evAtLock ?? 0).toFixed(3)}, streak=${forexStreak}) = ${lots}L`);
      }
    } else {
      lots = calcLots(symbol, entryNum, slApplied, risk);
      if (lots === null) {
        addWebhookHistory({ type:"SKIP", symbol, reason:`calcLots null  -  SL te klein voor minimale lotgrootte` });
        return res.status(200).json({ status:"SKIP", reason:`Lot berekening mislukt: SL afstand te klein voor ${symbol}` });
      }
    }
    registerRecentOrder(symbol, direction);
    let orderResult;
    try {
      orderResult = await placeOrderWithTimeout(direction, symbol, entryNum, slApplied, lots, curSession);
    } catch(timeoutErr) {
      addWebhookHistory({ type:"TIMEOUT", symbol, reason: timeoutErr.message });
      return res.status(200).json({ status:"TIMEOUT", reason: timeoutErr.message });
    }
    let { result, mt5Symbol, slPrice, tpPrice, tpRR } = orderResult;

    // [v7.9 fix] Verbeterde error-extractie: MetaApi gebruikt inconsistente foutstructuren.
    // Mogelijke formaten: { error: { code, message } }, { retcode, comment },
    // { error: "string" }, { message, id }, { statusCode, message }, etc.
    // extractMetaApiError() vangt alle bekende varianten op zodat errCode/errMsg
    // nooit meer "?" of "geen detail" zijn in het dashboard.
    function extractMetaApiError(r) {
      const errObj = r?.error;
      const code = (typeof errObj === "object" ? (errObj?.code || errObj?.id || errObj?.statusCode) : null)
                || r?.retcode || r?.id || r?.statusCode;
      const msg  = (typeof errObj === "string"  ? errObj : errObj?.message)
                || r?.comment || r?.message || r?.description || "";
      return { code: code ?? null, msg: String(msg) };
    }

    const { code: errCode, msg: errMsg } = extractMetaApiError(result);
    const isError = result?.error != null
      || (errCode !== null && errCode !== 10009 && errCode !== "TRADE_RETCODE_DONE");

    if (isError) {
      // [v7.9 fix] Log volledige MetaApi response zodat foutstructuur traceerbaar is in Railway logs
      console.error(`[ERR] MetaApi order mislukt ${symbol}:`, JSON.stringify(result));
      learnFromError(symbol, errCode, errMsg);
      // [v7.3] Forex heeft altijd vaste lots  -  calcLots niet gebruiken bij retry
      const rl = symType === "forex" ? lots : calcLots(symbol, entryNum, slApplied, risk);
      if (rl !== null) {
        try {
          const retry = await placeOrderWithTimeout(direction, symbol, entryNum, slApplied, rl, curSession);
          result = retry.result; tpPrice = retry.tpPrice; tpRR = retry.tpRR;
          const { code: retryCode, msg: retryMsg } = extractMetaApiError(retry.result);
          const retryErr = retry.result?.error != null
            || (retryCode !== null && retryCode !== 10009 && retryCode !== "TRADE_RETCODE_DONE");
          if (retryErr) {
            // [v7.9 fix] Log ook retry response volledig
            console.error(`[ERR] MetaApi retry mislukt ${symbol}:`, JSON.stringify(retry.result));
            learnFromError(symbol, retryCode, retryMsg);
            // [v7.9 fix] reason bevat nu altijd bruikbare details dankzij extractMetaApiError()
            const detail = retryMsg || errMsg || JSON.stringify(retry.result ?? result ?? "geen response");
            addWebhookHistory({ type:"ERROR", symbol, errCode: retryCode, errMsg: retryMsg, reason: `retry: ${retryCode ?? "?"}: ${detail}` });
            return res.status(200).json({ status:"ERROR_LEARNED", errCode: retryCode, errMsg: retryMsg });
          }
        } catch(retryTimeout) {
          return res.status(200).json({ status:"TIMEOUT", reason:"Retry ook timeout" });
        }
      }
    }
    incrementTracker(symbol, direction);
    const posId = String(result?.positionId || result?.orderId || Date.now());
    openPositions[posId] = {
      id: posId, symbol, mt5Symbol, direction,
      entry: entryNum, sl: slPrice, tp: tpPrice, lots,
      riskEUR: risk, openedAt: new Date().toISOString(),
      session: curSession, sessionLabel: SESSION_LABELS[curSession] || curSession,
      maxPrice: entryNum, maxRR: 0, currentPnL: 0, lastSync: null,
      slMultiplierApplied: slMult, spreadGuard: false, forexHalfRisk,
      restoredAfterRestart: false,
    };
    addWebhookHistory({
      type:"SUCCESS", symbol, mt5Symbol, direction, lots, posId,
      session: curSession, riskEUR: risk.toFixed(2),
      slAanpassing: slLockInfo, tp: `${tpRR}R @ ${tpPrice}`,
      slAutoApplied: slMult !== 1.0, dailyRiskMult: dailyRiskMultiplier,
      forexLotBoost: symType === "forex" && lots > (forexTrade2 ? 0.12 : 0.25) ? `x${(lots / (forexTrade2 ? 0.12 : 0.25)).toFixed(2)}` : null,
    });
    res.json({
      status:"OK", versie:"v7.9",
      direction, tvSymbol:symbol, mt5Symbol, symType, session:curSession,
      entry:entryNum, sl:slPrice, slOriginal:slNum, slMultiplier:slMult, slLockInfo,
      tp: tpPrice, tpRR, lots, risicoEUR:risk.toFixed(2),
      dailyRiskMultiplier, positionId:posId, metaApi:result,
    });
  } catch(err) {
    console.error("[ERR] Webhook fout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/close", async (req, res) => {
  const secret = req.query.secret || req.headers["x-secret"];
  if (secret!==WEBHOOK_SECRET) return res.status(401).json({ error:"Unauthorized" });
  const { positionId, symbol, direction } = req.body;
  if (!positionId) return res.status(400).json({ error:"Vereist: positionId" });
  try {
    const posIdStr = String(positionId);
    if (openPositions[posIdStr]) {
      openPositions[posIdStr]._pendingCloseReason = "manual";
      openPositions[posIdStr]._isManual           = true;
    }
    const result = await closePosition(positionId);
    if (symbol&&direction) decrementTracker(symbol, direction);
    res.json({ status:"OK", result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==============================================================
// API ENDPOINTS
// ==============================================================
app.get("/", (req, res) => {
  res.json({
    status:"online", versie:"ftmo-v7.9",
    time: getBrusselsDateStr(),
    tracking: {
      openPositions: Object.keys(openPositions).length,
      closedTrades:  closedTrades.length,
      tpLocks:       Object.keys(tpLocks).filter(k => !k.endsWith("__all")).length,
      slAnalyses:    Object.keys(slLocks).length,
      ghostTrackers: Object.keys(ghostTrackers).length,
      shadowResults: Object.keys(shadowSLResults).length,
    },
  });
});

app.get("/status", (req, res) => {
  res.json({
    openTrades: openTradeTracker, learnedPatches,
    risicoPerType: Object.fromEntries(
      Object.entries(BASE_RISK).map(([k,v]) => [k, `€${(v * dailyRiskMultiplier).toFixed(2)}`])
    ),
    dailyRisk: { multiplier: dailyRiskMultiplier, nextDay: dailyRiskMultiplierNext },
    consecutivePositiveDays,
  });
});

app.get("/live/positions", (req, res) => {
  const balance = accountSnapshots.length
    ? (accountSnapshots[accountSnapshots.length-1].balance ?? ACCOUNT_BALANCE)
    : ACCOUNT_BALANCE;
  res.json({
    count: Object.keys(openPositions).length,
    balance,
    positions: Object.values(openPositions).map(p => {
      const slDist = Math.abs(p.entry - p.sl);
      const slDistPct = p.entry > 0 ? parseFloat(((slDist / p.entry) * 100).toFixed(3)) : 0;
      const riskPct = balance > 0 ? parseFloat(((p.riskEUR / balance) * 100).toFixed(2)) : 0;
      const pnlPct  = balance > 0 ? parseFloat(((p.currentPnL / balance) * 100).toFixed(3)) : 0;
      return {
        id:p.id, symbol:p.symbol, direction:p.direction,
        entry:p.entry, sl:p.sl, tp:p.tp,
        slDistPct, riskPct, pnlPct,
        lots:p.lots, riskEUR:p.riskEUR,
        openedAt:p.openedAt, session:p.session,
        currentPrice:p.currentPrice??null, currentPnL:p.currentPnL??0,
        maxRR:p.maxRR??0, slMultiplier:p.slMultiplierApplied??1.0,
        restoredAfterRestart:p.restoredAfterRestart??false,
        forexHalfRisk:p.forexHalfRisk??false,
      };
    }),
  });
});

app.get("/live/ghosts", (req, res) => {
  const active = Object.entries(ghostTrackers).map(([id,g]) => {
    const trueRR    = calcMaxRRFromPrice(g.trade, g.bestPrice);
    const maxRRAtClose = g.trade.maxRR ?? g.trade.maxRRAtClose ?? 0;
    const delta     = parseFloat((trueRR - maxRRAtClose).toFixed(3));
    const mae       = calcMAE(g.trade, g.worstPrice);
    return {
      ghostId:id, symbol:g.trade.symbol, direction:g.trade.direction,
      entry:g.trade.entry, sl:g.trade.sl,
      maxRRAtClose, trueRR, delta, mae,
      isManual:g.isManual??false,
      closeReason:g.trade.closeReason??"unknown",
      elapsedMin:Math.round((Date.now()-g.startedAt)/60000),
      remainingMin:Math.round((GHOST_DURATION_MS-(Date.now()-g.startedAt))/60000),
    };
  });
  res.json({ count:active.length, ghosts:active, ghostActiveNow: isGhostActive() });
});

app.get("/tp-locks", (req,res) => {
  const bySym = {};
  for (const [key, lock] of Object.entries(tpLocks)) {
    const [sym, sess] = key.split("__");
    if (sess === "all") continue;
    if (!bySym[sym]) bySym[sym] = {};
    bySym[sym][sess] = lock;
  }
  res.json({ generated:new Date().toISOString(), fixedTpRR: FIXED_TP_RR, totalLocks:Object.keys(tpLocks).filter(k=>!k.endsWith("__all")).length, locksBySymbol:bySym });
});

app.get("/sl-locks", (req,res) => {
  res.json({
    generated: new Date().toISOString(),
    note: `Auto-apply na >=${SL_AUTO_APPLY_THRESHOLD} trades`,
    totalAnalyses: Object.keys(slLocks).length,
    shadowActiveNow: isShadowActive(),
    analyses: Object.entries(slLocks).map(([sym,lock]) => ({ symbol:sym, ...lock })),
  });
});

app.get("/sl-shadow", (req, res) => {
  const { symbol } = req.query;
  if (symbol) {
    const ns = normalizeSymbol(symbol.toUpperCase());
    return res.json({ symbol: ns, result: shadowSLResults[ns] ?? null });
  }
  res.json({
    generated: new Date().toISOString(), totalSymbols: Object.keys(shadowSLResults).length,
    minTrades: SHADOW_SL_MIN_TRADES, results: shadowSLResults,
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// /api/matrix -- server-side pre-computed matrix for dashboard
// Combineert closedTrades + tpLocks + slLocks + shadowSLResults
// Alle pairs die ooit getraded zijn verschijnen hier, ook zonder optimizer data
app.get("/api/matrix", (req, res) => {
  try {
    const SESSIONS = ['asia', 'london', 'ny'];

    // Verzamel alle symbols uit closedTrades + optimizer data
    const symSet = new Set();
    for (const t of closedTrades) { if (t.symbol) symSet.add(normalizeSymbol(t.symbol)); }
    for (const key of Object.keys(tpLocks)) { const [s] = key.split('__'); symSet.add(s); }
    for (const s of Object.keys(slLocks)) symSet.add(s);
    for (const s of Object.keys(shadowSLResults)) symSet.add(s);
    const symbols = [...symSet].sort();

    const rows = symbols.map(sym => {
      // Trades per sessie
      const tradesBySess = {};
      for (const sess of SESSIONS) {
        const trades = closedTrades.filter(tr =>
          normalizeSymbol(tr.symbol) === sym && tr.session === sess && tr.entry && tr.sl
        );
        const n = trades.length;
        const rrs = trades.map(x => getBestRR(x));
        const wins = rrs.filter(r => r >= (tpLocks[sym + '__' + sess] ? tpLocks[sym + '__' + sess].lockedRR : 1)).length;
        const wr   = n ? wins / n : null;

        // Beste EV uit RR tabel
        let bestEV = null, bestRR = null;
        if (n >= 3) {
          const ev = RR_LEVELS.map(rr => {
            const w = rrs.filter(r => r >= rr).length / n;
            return { rr, ev: parseFloat((w * rr - (1 - w)).toFixed(3)) };
          }).reduce((a, b) => b.ev > a.ev ? b : a);
          bestEV = ev.ev;
          bestRR = ev.rr;
        }

        const lock = tpLocks[sym + '__' + sess] || null;
        tradesBySess[sess] = {
          count: n,
          lockedRR:   lock?.lockedRR   ?? null,
          evAtLock:   lock?.evAtLock   ?? bestEV,
          bestRR:     lock?.lockedRR   ?? bestRR,
          winrate:    wr !== null ? parseFloat((wr * 100).toFixed(1)) : null,
          hasLock:    !!lock,
        };
      }

      // SL & Shadow
      const slData  = slLocks[sym]  ?? null;
      const shadow  = shadowSLResults[sym] ?? null;
      const totalTrades = closedTrades.filter(t => normalizeSymbol(t.symbol) === sym).length;

      return {
        symbol:      sym,
        totalTrades,
        sessions:    tradesBySess,
        slMult:      slData?.multiplier      ?? null,
        slAutoApplied: slData?.autoApplied   ?? false,
        slTrades:    slData?.lockedTrades    ?? 0,
        slEV:        slData?.evAtLock        ?? null,
        shadowMult:  shadow?.best?.slMultiplier ?? null,
        shadowEV:    shadow?.best?.bestEV    ?? null,
        shadowTrades: shadow?.tradesUsed     ?? null,
      };
    });

    res.json({ generated: new Date().toISOString(), count: rows.length, rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/daily-risk", async (req, res) => {
  try {
    const latest = await loadLatestDailyRisk();
    res.json({
      generated: new Date().toISOString(),
      today: { multiplier: dailyRiskMultiplier, date: getBrusselsDateOnly() },
      tomorrow: { multiplier: dailyRiskMultiplierNext },
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
  } catch(e) {}
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
      symbol:sym, session:t.session, count:0, totalExtraRR:0,
      totalMAE:0, maeCount:0, hitTP:0, manualCount:0
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
    symbol: g.symbol, session: g.session, trades: g.count,
    avgExtraRR: parseFloat((g.totalExtraRR / g.count).toFixed(3)),
    avgGhostMAE: g.maeCount ? parseFloat((g.totalMAE / g.maeCount).toFixed(3)) : null,
    tpHitRate: parseFloat(((g.hitTP / g.count) * 100).toFixed(1)),
    manualCount: g.manualCount,
  })).sort((a,b) => b.avgExtraRR - a.avgExtraRR);
  res.json({ generated:new Date().toISOString(), ghostFinished:finished.length, ghostPending:pending.length, bySymbolSession:results });
});

// [v7.8 fix4] Insta-SL spread-killed analyse
// Toont patronen: welk uur/sessie/symbool wordt systematisch spread-killed?
app.get("/analysis/insta-sl", async (req, res) => {
  const { symbol, session } = req.query;
  try {
    const rows = await loadInstaSLStats(symbol || null, session || null);
    // Groepeer per uur voor heatmap
    const byHour = {};
    for (const r of rows) {
      const h = r.hourBrussels ?? "?";
      if (!byHour[h]) byHour[h] = { hour: h, count: 0, symbols: {} };
      byHour[h].count++;
      byHour[h].symbols[r.symbol] = (byHour[h].symbols[r.symbol] || 0) + 1;
    }
    const hourHeatmap = Object.values(byHour).sort((a, b) => b.count - a.count);
    res.json({
      generated: new Date().toISOString(),
      filters: { symbol: symbol || "alle", session: session || "alle" },
      total: rows.length,
      hourHeatmap,
      rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    bestTrades:  [...withPnl].sort((a,b)=>b.realizedPnlEUR-a.realizedPnlEUR).slice(0,n),
    worstTrades: [...withPnl].sort((a,b)=>a.realizedPnlEUR-b.realizedPnlEUR).slice(0,n),
  });
});

// -- [v7.1] NIEUWE ENDPOINTS -----------------------------------

// /analysis/rr  -  RR verdeling per symbol + sessie
app.get("/analysis/rr", (req, res) => {
  const { symbol, session } = req.query;
  let trades = closedTrades.filter(t => t.sl && t.entry);
  if (symbol)  trades = trades.filter(t => normalizeSymbol(t.symbol) === normalizeSymbol(symbol));
  if (session && session !== "all") trades = trades.filter(t => t.session === session);
  const rrDist = RR_LEVELS.map(rr => {
    const hits  = trades.filter(t => getBestRR(t) >= rr).length;
    const wr    = trades.length ? hits / trades.length : 0;
    const ev    = parseFloat((wr * rr - (1 - wr)).toFixed(3));
    return { rr, hits, total: trades.length, winrate: parseFloat((wr*100).toFixed(1)), ev };
  });
  const bestRR = rrDist.reduce((a,b) => b.ev > a.ev ? b : a, { ev:-Infinity, rr:0 });
  const bySymbol = {};
  for (const t of trades) {
    const sym = normalizeSymbol(t.symbol);
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(getBestRR(t));
  }
  const symStats = Object.entries(bySymbol).map(([sym, rrs]) => ({
    symbol: sym,
    count: rrs.length,
    avgRR: parseFloat((rrs.reduce((s,r)=>s+r,0)/rrs.length).toFixed(2)),
    maxRR: parseFloat(Math.max(...rrs).toFixed(2)),
    medianRR: parseFloat([...rrs].sort((a,b)=>a-b)[Math.floor(rrs.length/2)].toFixed(2)),
  })).sort((a,b) => b.avgRR - a.avgRR);
  res.json({
    generated: new Date().toISOString(),
    filters: { symbol: symbol||"all", session: session||"all" },
    totalTrades: trades.length,
    bestRR: bestRR.rr, bestEV: bestRR.ev,
    rrDistribution: rrDist,
    bySymbol: symStats,
  });
});

// /analysis/sessions  -  sessie vergelijking
app.get("/analysis/sessions", (req, res) => {
  const sessions = ["asia", "london", "ny"];
  const result = sessions.map(sess => {
    const trades = closedTrades.filter(t => t.session === sess);
    const n      = trades.length;
    if (!n) return { session: sess, trades: 0 };
    const pnlArr  = trades.filter(t=>t.realizedPnlEUR!=null).map(t=>t.realizedPnlEUR);
    const rrArr   = trades.map(t => getBestRR(t));
    const wins    = trades.filter(t=>(t.realizedPnlEUR??0)>0).length;
    const slHits  = trades.filter(t=>t.closeReason==="sl"||(t.maxRR??0)<0.1).length;
    const balance = accountSnapshots.length
      ? (accountSnapshots[accountSnapshots.length-1].balance ?? ACCOUNT_BALANCE)
      : ACCOUNT_BALANCE;

    // Tijd-tot-SL analyse: ghost_time_to_sl per symbool
    const slTimeTrades = trades.filter(t => t.ghostTimeToSL != null);
    const slTimeBySym = {};
    for (const t of slTimeTrades) {
      const sym = normalizeSymbol(t.symbol);
      if (!slTimeBySym[sym]) slTimeBySym[sym] = [];
      slTimeBySym[sym].push({ min: t.ghostTimeToSL, hour: new Date(t.closedAt||Date.now()).getHours() });
    }
    const slTimeRows = Object.entries(slTimeBySym).map(([sym, entries]) => {
      const times = entries.map(e=>e.min); // [v7.3] was e.m  -  typo fix, was altijd undefined
      const hourCounts = {};
      for (const e of entries) {
        hourCounts[e.hour] = (hourCounts[e.hour]||0)+1;
      }
      const hoursSorted = Object.entries(hourCounts).sort((a,b)=>b[1]-a[1]);
      return {
        symbol: sym,
        count: entries.length,
        avgMin: times.length ? parseFloat((times.reduce((s,v)=>s+v,0)/times.length).toFixed(1)) : null,
        fastestMin: times.length ? Math.min(...times) : null,
        slowestMin: times.length ? Math.max(...times) : null,
        bestPushHour: hoursSorted[0]?.[0] ?? null,
        worstSLHour:  hoursSorted[hoursSorted.length-1]?.[0] ?? null,
      };
    });

    // Best TP RR for this session
    const evTable = RR_LEVELS.map(rr => {
      const w = trades.filter(t=>getBestRR(t)>=rr).length;
      const wr = n ? w/n : 0;
      return { rr, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
    });
    const bestRR = evTable.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-Infinity,rr:0});

    return {
      session: sess,
      label: SESSION_LABELS[sess] || sess,
      trades: n,
      wins, losses: n - wins,
      winrate: parseFloat(((wins/n)*100).toFixed(1)),
      slHits, slHitRate: parseFloat(((slHits/n)*100).toFixed(1)),
      totalPnl: parseFloat(pnlArr.reduce((s,v)=>s+v,0).toFixed(2)),
      totalPnlPct: balance > 0 ? parseFloat((pnlArr.reduce((s,v)=>s+v,0)/balance*100).toFixed(2)) : null,
      avgRR: parseFloat((rrArr.reduce((s,r)=>s+r,0)/n).toFixed(2)),
      bestRR: bestRR.rr, bestEV: bestRR.ev,
      tpLockCount: Object.keys(tpLocks).filter(k=>k.endsWith(`__${sess}`)).length,
      slTimeTable: slTimeRows,
    };
  });
  res.json({ generated: new Date().toISOString(), sessions: result });
});

// /research/tp-optimizer  -  TP optimizer over alles
app.get("/research/tp-optimizer", (req, res) => {
  const { symbol } = req.query;
  let trades = closedTrades.filter(t => t.sl && t.entry);
  if (symbol) trades = trades.filter(t => normalizeSymbol(t.symbol) === normalizeSymbol(symbol));
  const n = trades.length;
  const evTable = RR_LEVELS.map(rr => {
    const wins = trades.filter(t => getBestRR(t) >= rr).length;
    const wr   = n ? wins / n : 0;
    const ev   = parseFloat((wr * rr - (1 - wr)).toFixed(3));
    return { rr, wins, winrate: parseFloat((wr*100).toFixed(1)), ev };
  });
  const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a, { ev:-Infinity, rr:0 });
  const bySymbol = {};
  for (const t of trades) {
    const sym = normalizeSymbol(t.symbol);
    const sess = t.session || "unknown";
    if (!bySymbol[sym]) bySymbol[sym] = {};
    if (!bySymbol[sym][sess]) bySymbol[sym][sess] = [];
    bySymbol[sym][sess].push(getBestRR(t));
  }
  const symSessStats = [];
  for (const [sym, sessions] of Object.entries(bySymbol)) {
    for (const [sess, rrs] of Object.entries(sessions)) {
      const sn = rrs.length;
      const sessEvTable = RR_LEVELS.map(rr => {
        const w = rrs.filter(r => r >= rr).length;
        const wr = sn ? w/sn : 0;
        return { rr, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
      });
      const sBest = sessEvTable.reduce((a,b) => b.ev > a.ev ? b : a, { ev:-Infinity, rr:0 });
      const currentLock = tpLocks[`${sym}__${sess}`];
      symSessStats.push({
        symbol: sym, session: sess, trades: sn,
        bestRR: sBest.rr, bestEV: sBest.ev,
        lockedRR: currentLock?.lockedRR ?? null,
        evPositive: sBest.ev > 0,
        drift: currentLock ? parseFloat((sBest.rr - currentLock.lockedRR).toFixed(2)) : null,
      });
    }
  }
  symSessStats.sort((a,b) => b.bestEV - a.bestEV);
  res.json({
    generated: new Date().toISOString(),
    filters: { symbol: symbol||"all" },
    totalTrades: n,
    globalBestRR: best.rr, globalBestEV: best.ev,
    fixedDefault: FIXED_TP_RR,
    evTable,
    bySymbolSession: symSessStats,
  });
});

// /research/tp-optimizer/sessie  -  TP optimizer per sessie
app.get("/research/tp-optimizer/sessie", (req, res) => {
  const { symbol } = req.query;
  const result = {};
  for (const sess of TRADING_SESSIONS) {
    let trades = closedTrades.filter(t => t.sl && t.entry && t.session === sess);
    if (symbol) trades = trades.filter(t => normalizeSymbol(t.symbol) === normalizeSymbol(symbol));
    const n = trades.length;
    if (!n) { result[sess] = { session: sess, trades: 0 }; continue; }
    const evTable = RR_LEVELS.map(rr => {
      const wins = trades.filter(t => getBestRR(t) >= rr).length;
      const wr   = n ? wins / n : 0;
      return { rr, wins, winrate: parseFloat((wr*100).toFixed(1)), ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
    });
    const best = evTable.reduce((a,b) => b.ev > a.ev ? b : a, { ev:-Infinity, rr:0 });
    const bySymbol = {};
    for (const t of trades) {
      const sym = normalizeSymbol(t.symbol);
      if (!bySymbol[sym]) bySymbol[sym] = [];
      bySymbol[sym].push(getBestRR(t));
    }
    const symStats = Object.entries(bySymbol).map(([sym, rrs]) => {
      const sn = rrs.length;
      const sessEvTable = RR_LEVELS.map(rr => {
        const w = rrs.filter(r => r >= rr).length;
        const wr = sn ? w/sn : 0;
        return { rr, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
      });
      const sBest = sessEvTable.reduce((a,b) => b.ev > a.ev ? b : a, { ev:-Infinity, rr:0 });
      const currentLock = tpLocks[`${sym}__${sess}`];
      return {
        symbol: sym, trades: sn,
        bestRR: sBest.rr, bestEV: sBest.ev,
        lockedRR: currentLock?.lockedRR ?? null,
        evPositive: sBest.ev > 0,
      };
    }).sort((a,b) => b.bestEV - a.bestEV);
    result[sess] = {
      session: sess, label: SESSION_LABELS[sess]||sess, trades: n,
      bestRR: best.rr, bestEV: best.ev,
      evTable, bySymbol: symStats,
    };
  }
  res.json({ generated: new Date().toISOString(), filters: { symbol: symbol||"all" }, sessions: result });
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

// ==============================================================
// DASHBOARD v7.5  -  Professioneel dark terminal UI
// ==============================================================
app.get("/dashboard", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  // Pre-compute data server-side for initial render
  const balance = accountSnapshots.length
    ? (accountSnapshots[accountSnapshots.length-1].balance ?? ACCOUNT_BALANCE)
    : ACCOUNT_BALANCE;
  const equity = accountSnapshots.length
    ? (accountSnapshots[accountSnapshots.length-1].equity ?? balance)
    : balance;
  const floatPL = parseFloat((equity - balance).toFixed(2));
  const floatPct = balance > 0 ? parseFloat((floatPL / balance * 100).toFixed(2)) : 0;

  // Open posities
  const posArr = Object.values(openPositions).map(p => {
    const slDist    = Math.abs(p.entry - p.sl);
    const slDistPct = p.entry > 0 ? parseFloat(((slDist / p.entry) * 100).toFixed(3)) : 0;
    const riskPct   = balance > 0 ? parseFloat(((p.riskEUR / balance) * 100).toFixed(2)) : 0;
    const pnlPct    = balance > 0 ? parseFloat(((p.currentPnL / balance) * 100).toFixed(3)) : 0;
    return { ...p, slDistPct, riskPct, pnlPct };
  });

  // Actieve ghosts
  const ghostArr = Object.entries(ghostTrackers).map(([id, g]) => {
    const trueRR    = calcMaxRRFromPrice(g.trade, g.bestPrice);
    const maxRRAtClose = g.trade.maxRR ?? g.trade.maxRRAtClose ?? 0;
    const delta     = parseFloat((trueRR - maxRRAtClose).toFixed(3));
    const mae       = calcMAE(g.trade, g.worstPrice);
    return {
      ghostId: id, symbol: g.trade.symbol, direction: g.trade.direction,
      closeReason: g.trade.closeReason ?? "unknown",
      maxRRAtClose, trueRR, delta, mae,
      elapsedMin: Math.round((Date.now() - g.startedAt) / 60000),
    };
  });

  // Sessie stats
  const sessStats = {};
  for (const sess of ["asia","london","ny"]) {
    const st    = closedTrades.filter(t => t.session === sess);
    const n     = st.length;
    const pnls  = st.filter(t=>t.realizedPnlEUR!=null).map(t=>t.realizedPnlEUR);
    const rrs   = st.map(t => getBestRR(t));
    const wins  = st.filter(t=>(t.realizedPnlEUR??0)>0).length;
    const slHits= st.filter(t=>t.closeReason==="sl"||(t.maxRR??0)<0.1).length;
    const totalPnl = pnls.reduce((s,v)=>s+v,0);
    const evTable = RR_LEVELS.map(rr => {
      const w = n ? st.filter(t=>getBestRR(t)>=rr).length : 0;
      const wr = n ? w/n : 0;
      return { rr, ev: parseFloat((wr*rr-(1-wr)).toFixed(3)) };
    });
    const bestRR = evTable.reduce((a,b)=>b.ev>a.ev?b:a,{ev:-Infinity,rr:0});
    const tpLockKeys = Object.keys(tpLocks).filter(k=>k.endsWith(`__${sess}`));
    const evPositiveLocks = tpLockKeys.filter(k=>tpLocks[k].evPositive).length;
    sessStats[sess] = {
      n, wins, slHits, totalPnl, totalPnlPct: balance>0?parseFloat((totalPnl/balance*100).toFixed(2)):0,
      winrate: n ? parseFloat(((wins/n)*100).toFixed(1)) : 0,
      slRate: n ? parseFloat(((slHits/n)*100).toFixed(1)) : 0,
      avgRR: n ? parseFloat((rrs.reduce((s,r)=>s+r,0)/n).toFixed(2)) : 0,
      bestRR: bestRR.rr, bestEV: bestRR.ev,
      tpLocks: tpLockKeys.length, evPositiveLocks,
    };
  }

  // Tijd-tot-SL tabel: per pair x sessie
  // Gebruik ghost_time_to_sl data + sluit-uur
  const slTimeMap = {};
  for (const t of closedTrades.filter(t => t.ghostTimeToSL != null || t.closeReason === "sl")) {
    const sym  = normalizeSymbol(t.symbol);
    const sess = t.session || "unknown";
    const key  = `${sym}__${sess}`;
    if (!slTimeMap[key]) slTimeMap[key] = { symbol:sym, session:sess, times:[], hours:[] };
    if (t.ghostTimeToSL) slTimeMap[key].times.push(t.ghostTimeToSL);
    if (t.closedAt) slTimeMap[key].hours.push(new Date(t.closedAt).getUTCHours() + 1); // BXL approx
  }
  const slTimeRows = Object.values(slTimeMap)
    .filter(r => r.times.length >= 1)
    .map(r => {
      const times = r.times;
      const avg   = parseFloat((times.reduce((s,v)=>s+v,0)/times.length).toFixed(0));
      const fastest = Math.min(...times);
      const slowest = Math.max(...times);
      const hourCnt = {};
      for (const h of r.hours) hourCnt[h] = (hourCnt[h]||0)+1;
      const hoursSorted = Object.entries(hourCnt).sort((a,b)=>b[1]-a[1]);
      return {
        symbol: r.symbol, session: r.session,
        count: times.length, avg, fastest, slowest,
        bestPushHour: hoursSorted[0]?.[0] ?? null,
        worstSLHour: hoursSorted[hoursSorted.length-1]?.[0] ?? null,
      };
    })
    .sort((a,b) => a.avg - b.avg);

  // Summary stats
  const totalClosed = closedTrades.length;
  const totalGhostFinished = closedTrades.filter(t=>t.trueMaxRR!==null).length;
  const allRRs = closedTrades.map(t=>getBestRR(t)).filter(r=>r>0);
  const avgRR  = allRRs.length ? parseFloat((allRRs.reduce((s,r)=>s+r,0)/allRRs.length).toFixed(2)) : 0;
  const tpLockCount = Object.keys(tpLocks).filter(k=>!k.endsWith("__all")).length;

  const h = (s) => s.replace(/`/g, "\\`");

  res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FTMO v7.8  -  Nick Verschoot</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Barlow+Condensed:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
:root {
  --bg:       #050709;
  --bg2:      #080c10;
  --panel:    #0c1018;
  --panel2:   #101520;
  --border:   #161e2a;
  --border2:  #1d2a3a;
  --c:        #00ffe0;    /* cyan accent */
  --c2:       #00bfa8;
  --gold:     #f0c040;
  --red:      #ff3d5a;
  --green:    #00e396;
  --purple:   #7b61ff;
  --dim:      #2a3a4a;
  --muted:    #3a5060;
  --text:     #c0d8e8;
  --textdim:  #506070;
  --font:     'JetBrains Mono', monospace;
  --hd:       'Barlow Condensed', sans-serif;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 12px;
  line-height: 1.5;
  min-height: 100vh;
  overflow-x: hidden;
}

/* -- SCANLINE OVERLAY -- */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0,255,224,0.008) 2px,
    rgba(0,255,224,0.008) 4px
  );
  pointer-events: none;
  z-index: 1000;
}

/* -- HEADER -- */
header {
  position: sticky;
  top: 0;
  z-index: 200;
  background: rgba(5,7,9,0.96);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 0 24px;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 20px;
}
.logo {
  font-family: var(--hd);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 2px;
  color: var(--c);
  text-transform: uppercase;
  flex-shrink: 0;
}
.logo em { color: var(--textdim); font-style: normal; font-weight: 400; font-size: 13px; margin-left: 8px; letter-spacing: 0; }
.header-mid { flex: 1; display: flex; gap: 6px; align-items: center; }
.htag {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 2px 10px;
  font-size: 10px;
  color: var(--textdim);
  letter-spacing: 1px;
  text-transform: uppercase;
}
.htag.live { border-color: var(--green); color: var(--green); }
.htag.live::before { content: "● "; }
#hclock { font-size: 12px; color: var(--c); margin-left: auto; }
.hbtn {
  background: none;
  border: 1px solid var(--border2);
  color: var(--textdim);
  padding: 4px 14px;
  border-radius: 3px;
  cursor: pointer;
  font-family: var(--font);
  font-size: 10px;
  letter-spacing: 1px;
  text-transform: uppercase;
  transition: all 0.15s;
}
.hbtn:hover { border-color: var(--c); color: var(--c); }

/* -- LAYOUT -- */
main { max-width: 1680px; margin: 0 auto; padding: 20px 20px 60px; }

/* -- SECTION HEADERS -- */
.sec-hd {
  font-family: var(--hd);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--textdim);
  border-left: 3px solid var(--c);
  padding-left: 10px;
  margin-bottom: 14px;
  margin-top: 28px;
}
.sec-hd span { color: var(--c); }
.sec-hd small { font-size: 10px; color: var(--muted); font-weight: 400; margin-left: 10px; letter-spacing: 1px; font-family: var(--font); }

/* -- TOP STRIP -- */
.top-strip {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 8px;
  margin-bottom: 4px;
}
@media (max-width: 1200px) { .top-strip { grid-template-columns: repeat(4, 1fr); } }
.kpi {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px 16px;
  position: relative;
  overflow: hidden;
}
.kpi::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--c);
  opacity: 0.4;
}
.kpi.red::before  { background: var(--red); }
.kpi.green::before { background: var(--green); }
.kpi.gold::before  { background: var(--gold); }
.kpi.purple::before { background: var(--purple); }
.kpi-label { font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--textdim); margin-bottom: 6px; }
.kpi-value { font-family: var(--hd); font-size: 26px; font-weight: 700; line-height: 1; }
.kpi-value.c     { color: var(--c); }
.kpi-value.green { color: var(--green); }
.kpi-value.red   { color: var(--red); }
.kpi-value.gold  { color: var(--gold); }
.kpi-sub { font-size: 9px; color: var(--textdim); margin-top: 4px; }

/* -- TABLE BASE -- */
.tbl-wrap {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: auto;
  margin-bottom: 8px;
}
table { width: 100%; border-collapse: collapse; }
thead th {
  background: var(--bg2);
  padding: 8px 12px;
  text-align: left;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  font-weight: 400;
}
tbody tr { border-bottom: 1px solid rgba(22,30,42,0.6); transition: background 0.1s; }
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: rgba(0,255,224,0.025); }
td {
  padding: 9px 12px;
  white-space: nowrap;
  vertical-align: middle;
}
.no-data { text-align: center; padding: 32px; color: var(--muted); font-size: 11px; }

/* -- BADGES -- */
.badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
}
.b-asia   { background: rgba(123,97,255,0.15); color: var(--purple); border: 1px solid rgba(123,97,255,0.35); }
.b-london { background: rgba(0,255,224,0.08);  color: var(--c);      border: 1px solid rgba(0,255,224,0.25); }
.b-ny     { background: rgba(240,192,64,0.1);  color: var(--gold);   border: 1px solid rgba(240,192,64,0.3); }
.b-buy    { background: rgba(0,227,150,0.12);  color: var(--green);  border: 1px solid rgba(0,227,150,0.3); }
.b-sell   { background: rgba(255,61,90,0.12);  color: var(--red);    border: 1px solid rgba(255,61,90,0.3); }
.b-tp     { background: rgba(0,227,150,0.1);   color: var(--green);  border: 1px solid rgba(0,227,150,0.3); }
.b-sl     { background: rgba(255,61,90,0.1);   color: var(--red);    border: 1px solid rgba(255,61,90,0.3); }
.b-manual { background: rgba(240,192,64,0.1);  color: var(--gold);   border: 1px solid rgba(240,192,64,0.3); }
.b-auto   { background: rgba(58,80,96,0.3);    color: var(--textdim);border: 1px solid var(--border2); }
.b-unknown{ background: rgba(58,80,96,0.2);    color: var(--muted);  border: 1px solid var(--border); }

/* -- COLORS -- */
.c-c      { color: var(--c); }
.c-green  { color: var(--green); }
.c-red    { color: var(--red); }
.c-gold   { color: var(--gold); }
.c-purple { color: var(--purple); }
.c-dim    { color: var(--textdim); }
.c-muted  { color: var(--muted); }
.bold     { font-weight: 700; }

/* -- OPEN POSITIES -- */
.pos-empty {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
}
.pos-empty span { display: block; font-size: 28px; margin-bottom: 8px; opacity: 0.3; }

/* -- GHOST TABLE -- */
.delta-pos { color: var(--green); font-weight: 700; }
.delta-neg { color: var(--red); }
.delta-zero { color: var(--muted); }

/* -- TIJD-TOT-SL TABEL -- */
.tts-best { color: var(--c); font-weight: 700; }
.tts-worst { color: var(--red); font-weight: 700; }

/* -- SESSIE CARDS -- */
.sess-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 8px;
}
@media (max-width: 900px) { .sess-grid { grid-template-columns: 1fr; } }
.sess-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}
.sess-card-hd {
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
}
.sess-icon {
  width: 32px; height: 32px;
  border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}
.sess-icon.asia   { background: rgba(123,97,255,0.15); }
.sess-icon.london { background: rgba(0,255,224,0.08); }
.sess-icon.ny     { background: rgba(240,192,64,0.1); }
.sess-name {
  font-family: var(--hd);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
}
.sess-name.asia   { color: var(--purple); }
.sess-name.london { color: var(--c); }
.sess-name.ny     { color: var(--gold); }
.sess-time { font-size: 9px; color: var(--muted); }
.sess-body { padding: 14px 16px; }
.sess-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid rgba(22,30,42,0.5);
}
.sess-row:last-child { border-bottom: none; }
.sess-row .k { font-size: 10px; color: var(--textdim); }
.sess-row .v { font-size: 12px; font-weight: 700; }
.sess-pnl-bar {
  height: 3px;
  background: var(--border);
  border-radius: 2px;
  margin: 10px 0 4px;
  overflow: hidden;
}
.sess-pnl-fill { height: 100%; border-radius: 2px; transition: width 0.5s; }

/* -- RISK STRIP -- */
.risk-strip {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
@media (max-width: 1000px) { .risk-strip { grid-template-columns: repeat(3, 1fr); } }
.risk-card {
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 14px;
}
.risk-card .rl { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: var(--textdim); margin-bottom: 4px; }
.risk-card .rv { font-family: var(--hd); font-size: 20px; font-weight: 700; }
.risk-card .rs { font-size: 9px; color: var(--muted); margin-top: 2px; }

/* -- CRON STATUS -- */
.cron-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.cron-row:last-child { border-bottom: none; }
.cron-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.cron-dot.ok  { background: var(--green); box-shadow: 0 0 6px var(--green); }
.cron-dot.off { background: var(--muted); }
.cron-name { flex: 1; color: var(--text); }
.cron-sched { color: var(--muted); font-size: 10px; min-width: 120px; }
.cron-ts { color: var(--textdim); font-size: 10px; min-width: 160px; text-align: right; }

/* -- PAIR-SESSION TABLE -- */
.pair-sess-wrap { overflow-x: auto; }
.pair-sess-wrap table thead th:first-child { position: sticky; left: 0; background: var(--bg2); z-index: 2; }
.pair-sess-wrap table td:first-child { position: sticky; left: 0; background: var(--panel); z-index: 1; }

/* -- REFRESH INDICATOR -- */
#refresh-flash {
  position: fixed;
  top: 52px; right: 0;
  width: 100%;
  height: 1px;
  background: var(--c);
  opacity: 0;
  transition: opacity 0.1s;
  z-index: 300;
}
#refresh-flash.on { opacity: 0.6; }

/* -- SCROLL -- */
/* -- SORTABLE HEADERS -- */
th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
th.sortable:hover { color: var(--c); background: var(--panel2); }
th.sort-asc::after  { content: " ▲"; color: var(--c); font-size: 9px; }
th.sort-desc::after { content: " ▼"; color: var(--c); font-size: 9px; }

::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: var(--panel); }
::-webkit-scrollbar-thumb { background: var(--dim); border-radius: 3px; }

/* -- ANIMATIONS -- */
@keyframes fadeIn { from { opacity:0; transform: translateY(4px); } to { opacity:1; transform: none; } }
.fade-in { animation: fadeIn 0.3s ease forwards; }
@keyframes pulse { 0%,100%{opacity:0.5}50%{opacity:1} }
.pulse { animation: pulse 1.5s infinite; }
</style>
</head>
<body>
<div id="refresh-flash"></div>

<header>
  <div class="logo">FTMO <em>v7.8  -  Nick Verschoot</em></div>
  <div class="header-mid">
    <div class="htag live">Live</div>
    <div class="htag">Demo Account</div>
    <div class="htag">Railway</div>
  </div>
  <div id="hclock">--:--:-- BXL</div>
  <button class="hbtn" onclick="loadAll()">↺ Refresh</button>
</header>

<main>

<!-- KPI STRIP -->
<div class="sec-hd" style="margin-top:16px"><span>Account</span><small>live snapshot</small></div>
<div class="top-strip" id="kpi-strip">
  <div class="kpi green">
    <div class="kpi-label">Balance</div>
    <div class="kpi-value green" id="kpi-balance">${balance.toFixed(0)}</div>
    <div class="kpi-sub">account balance</div>
  </div>
  <div class="kpi ${floatPct >= 0 ? 'green' : 'red'}">
    <div class="kpi-label">Floating P&L</div>
    <div class="kpi-value ${floatPct >= 0 ? 'green' : 'red'}" id="kpi-float">${floatPct >= 0 ? '+' : ''}${floatPct.toFixed(2)}%</div>
    <div class="kpi-sub">van balance</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Open Posities</div>
    <div class="kpi-value c" id="kpi-open">${posArr.length}</div>
    <div class="kpi-sub">live MT5</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Actieve Ghosts</div>
    <div class="kpi-value c" id="kpi-ghosts">${ghostArr.length}</div>
    <div class="kpi-sub">post-close tracking</div>
  </div>
  <div class="kpi gold">
    <div class="kpi-label">Closed Trades</div>
    <div class="kpi-value gold" id="kpi-closed">${totalClosed}</div>
    <div class="kpi-sub">${totalGhostFinished} ghost finalized</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Gem. RR</div>
    <div class="kpi-value c" id="kpi-rr">${avgRR}R</div>
    <div class="kpi-sub">alle trades</div>
  </div>
  <div class="kpi purple">
    <div class="kpi-label">TP Locks</div>
    <div class="kpi-value" style="color:var(--purple)" id="kpi-tplocks">${tpLockCount}</div>
    <div class="kpi-sub">asia/london/ny</div>
  </div>
</div>

<!-- DAILY RISK -->
<div class="sec-hd"><span>Daily Risk</span><small>multiplier + effectief risico % van balance per type</small></div>
<div class="risk-strip" id="risk-strip">
  <div class="risk-card">
    <div class="rl">Vandaag mult</div>
    <div class="rv c-c">x${dailyRiskMultiplier.toFixed(2)}</div>
    <div class="rs">actief nu</div>
  </div>
  <div class="risk-card">
    <div class="rl">Morgen mult</div>
    <div class="rv c-gold" id="risk-tmr-mult">x${dailyRiskMultiplierNext.toFixed(2)}</div>
    <div class="rs">na 02:00</div>
  </div>
  <div class="risk-card">
    <div class="rl">Forex risk</div>
    <div class="rv c-green">${((BASE_RISK.forex * dailyRiskMultiplier) / balance * 100).toFixed(3)}%</div>
    <div class="rs">van balance</div>
  </div>
  <div class="risk-card">
    <div class="rl">Index risk</div>
    <div class="rv c-green">${((BASE_RISK.index * dailyRiskMultiplier) / balance * 100).toFixed(2)}%</div>
    <div class="rs">van balance</div>
  </div>
  <div class="risk-card">
    <div class="rl">Gold / Stock</div>
    <div class="rv c-green">${((BASE_RISK.gold * dailyRiskMultiplier) / balance * 100).toFixed(2)}% / ${((BASE_RISK.stock * dailyRiskMultiplier) / balance * 100).toFixed(2)}%</div>
    <div class="rs">van balance</div>
  </div>
</div>

<!-- OPEN POSITIES -->
<div class="sec-hd"><span>Open Posities</span><small>risk% · SL afstand% · PnL% van balance  -  nooit EUR</small></div>
<div id="pos-section">
${posArr.length === 0 ? `
  <div class="pos-empty">
    <span>[ ]</span>
    Geen open posities
  </div>
` : `
  <div class="tbl-wrap fade-in">
    <table>
      <thead>
        <tr>
          <th>Symbool</th>
          <th>Richting</th>
          <th>Sessie</th>
          <th>Entry</th>
          <th>SL</th>
          <th>SL Afstand%</th>
          <th>Risk%</th>
          <th>PnL%</th>
          <th>Max RR</th>
          <th>Lots</th>
          <th>SL Mult</th>
          <th>Open sinds</th>
        </tr>
      </thead>
      <tbody>
        ${posArr.map(p => `
        <tr>
          <td class="bold c-c">${p.symbol}</td>
          <td><span class="badge b-${p.direction}">${p.direction.toUpperCase()}</span></td>
          <td><span class="badge b-${p.session}">${p.session}</span></td>
          <td class="c-dim">${p.entry}</td>
          <td class="c-dim">${p.sl}</td>
          <td class="${p.slDistPct > 2 ? 'c-gold' : 'c-dim'}">${p.slDistPct}%</td>
          <td class="bold c-c">${p.riskPct}%</td>
          <td class="${p.pnlPct >= 0 ? 'c-green bold' : 'c-red bold'}">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%</td>
          <td class="c-dim">${p.maxRR}R</td>
          <td class="c-dim">${p.lots}</td>
          <td class="${p.slMultiplier !== 1.0 ? 'c-gold' : 'c-dim'}">${p.slMultiplier}x</td>
          <td class="c-muted">${p.openedAt ? new Date(p.openedAt).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels'}) : ' - '}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
`}
</div>

<!-- ACTIEVE GHOSTS -->
<div class="sec-hd"><span>Actieve Ghosts</span><small>delta = trueRR − maxRR@close · MAE in R · closeReason badge</small></div>
<div id="ghost-section">
${ghostArr.length === 0 ? `
  <div class="pos-empty">
    <span>[ghost]</span>
    Geen actieve ghost trackers
  </div>
` : `
  <div class="tbl-wrap fade-in">
    <table>
      <thead>
        <tr>
          <th>Symbool</th>
          <th>Richting</th>
          <th>Close Reden</th>
          <th>maxRR@close</th>
          <th>True RR</th>
          <th>Delta (extra RR)</th>
          <th>MAE (R)</th>
          <th>Elapsed</th>
        </tr>
      </thead>
      <tbody>
        ${ghostArr.map(g => {
          const deltaClass = g.delta > 0 ? 'delta-pos' : g.delta < 0 ? 'delta-neg' : 'delta-zero';
          const reasonClass = g.closeReason === 'tp' ? 'b-tp' : g.closeReason === 'sl' ? 'b-sl' : g.closeReason === 'manual' ? 'b-manual' : g.closeReason === 'auto' ? 'b-auto' : 'b-unknown';
          return `<tr>
            <td class="bold c-c">${g.symbol}</td>
            <td><span class="badge b-${g.direction}">${g.direction.toUpperCase()}</span></td>
            <td><span class="badge ${reasonClass}">${g.closeReason}</span></td>
            <td class="c-dim">${g.maxRRAtClose}R</td>
            <td class="bold">${g.trueRR}R</td>
            <td class="${deltaClass}">${g.delta >= 0 ? '+' : ''}${g.delta}R</td>
            <td class="${g.mae >= 0.8 ? 'c-red' : 'c-dim'}">${g.mae}R</td>
            <td class="c-muted">${g.elapsedMin}min</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
`}
</div>

<!-- SESSIE OVERZICHT -->
<div class="sec-hd"><span>Sessie Overzicht</span><small>Asia · London · New York  -  klik header om te sorteren</small></div>
<div class="tbl-wrap fade-in">
  <table id="sess-table">
    <thead>
      <tr>
        <th onclick="sortSess('sess')"     class="sortable">Sessie ↕</th>
        <th onclick="sortSess('n')"        class="sortable">Trades ↕</th>
        <th onclick="sortSess('winrate')"  class="sortable">Winrate% ↕</th>
        <th onclick="sortSess('slRate')"   class="sortable">SL hit% ↕</th>
        <th onclick="sortSess('avgRR')"    class="sortable">Gem. RR ↕</th>
        <th onclick="sortSess('bestRR')"   class="sortable">Best TP RR ↕</th>
        <th onclick="sortSess('bestEV')"   class="sortable">Best EV ↕</th>
        <th onclick="sortSess('tpLocks')"  class="sortable">TP Locks ↕</th>
        <th onclick="sortSess('evLocks')"  class="sortable">+EV Locks ↕</th>
        <th onclick="sortSess('pnl')"      class="sortable">PnL% ↕</th>
      </tr>
    </thead>
    <tbody id="sess-tbody">
${['asia','london','ny'].map(sess => {
  const s = sessStats[sess];
  const icons = { asia: '🌏', london: '🇬🇧', ny: '🗽' };
  const labels = { asia: '02:00-08:00', london: '08:00-15:30', ny: '15:30-20:00' };
  const pnlColor = s.totalPnlPct >= 0 ? 'var(--green)' : 'var(--red)';
  return `<tr data-sess="${sess}" data-n="${s.n}" data-winrate="${s.winrate}" data-slrate="${s.slRate}" data-avgrr="${s.avgRR}" data-bestrr="${s.bestRR}" data-bestev="${s.bestEV}" data-tplocks="${s.tpLocks}" data-evlocks="${s.evPositiveLocks}" data-pnl="${s.totalPnlPct}">
    <td class="bold"><span class="badge b-${sess}">${icons[sess]} ${sess.toUpperCase()}</span> <span class="c-muted" style="font-size:10px">${labels[sess]}</span></td>
    <td class="c-dim">${s.n}</td>
    <td style="color:${s.winrate >= 50 ? 'var(--green)' : 'var(--red)'}">${s.winrate}%</td>
    <td style="color:${s.slRate > 60 ? 'var(--red)' : 'var(--textdim)'}">${s.slRate}%</td>
    <td class="c-c">${s.avgRR}R</td>
    <td class="c-gold">${s.bestRR}R</td>
    <td style="color:${parseFloat(s.bestEV) > 0 ? 'var(--green)' : 'var(--red)'}">${s.bestEV}</td>
    <td style="color:var(--purple)">${s.tpLocks}</td>
    <td style="color:var(--purple)">${s.evPositiveLocks}</td>
    <td style="color:${pnlColor};font-weight:700">${s.totalPnlPct >= 0 ? '+' : ''}${s.totalPnlPct}%</td>
  </tr>`;
}).join('')}
    </tbody>
  </table>
</div>

<!-- TIJD TOT SL TABEL -->
<div class="sec-hd"><span>Tijd-tot-SL</span><small>gem · snelste · traagste per pair x sessie  -  beste push uur (cyaan) · slechtste SL uur (rood)</small></div>
<div id="tts-section">
${slTimeRows.length === 0 ? `
  <div class="pos-empty">
    <span>[timer]</span>
    Nog geen tijd-tot-SL data  -  verschijnt na ghost finalisatie met phantom_sl hits
  </div>
` : `
  <div class="tbl-wrap pair-sess-wrap fade-in">
    <table>
      <thead>
        <tr>
          <th>Pair</th>
          <th>Sessie</th>
          <th># SL hits</th>
          <th>Gem. (min)</th>
          <th>Snelste (min)</th>
          <th>Traagste (min)</th>
          <th>Beste push uur</th>
          <th>Slechtste SL uur</th>
        </tr>
      </thead>
      <tbody>
        ${slTimeRows.map(r => `
        <tr>
          <td class="bold c-c">${r.symbol}</td>
          <td><span class="badge b-${r.session}">${r.session}</span></td>
          <td class="c-dim">${r.count}</td>
          <td class="bold">${r.avg}min</td>
          <td class="c-green">${r.fastest}min</td>
          <td class="c-dim">${r.slowest}min</td>
          <td class="tts-best">${r.bestPushHour !== null ? r.bestPushHour + ':00' : ' - '}</td>
          <td class="tts-worst">${r.worstSLHour !== null ? r.worstSLHour + ':00' : ' - '}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
`}
</div>

<!-- PAIRS x SESSIE MATRIX -->
<div class="sec-hd"><span>Pair x Sessie Matrix</span><small>TP lock RR - EV - trades  -  alle combinaties</small></div>
<div id="matrix-section">
  <div class="tbl-wrap pair-sess-wrap fade-in" id="matrix-tbl">
    <table>
      <thead>
        <tr>
          <th onclick="sortMatrix(0)" class="sortable">Pair / Total</th>
          <th onclick="sortMatrix(1)" class="sortable">Asia RR</th>
          <th onclick="sortMatrix(2)" class="sortable">Asia EV</th>
          <th onclick="sortMatrix(3)" class="sortable">Asia #</th>
          <th onclick="sortMatrix(4)" class="sortable">London RR</th>
          <th onclick="sortMatrix(5)" class="sortable">London EV</th>
          <th onclick="sortMatrix(6)" class="sortable">London #</th>
          <th onclick="sortMatrix(7)" class="sortable">NY RR</th>
          <th onclick="sortMatrix(8)" class="sortable">NY EV</th>
          <th onclick="sortMatrix(9)" class="sortable">NY #</th>
          <th onclick="sortMatrix(10)" class="sortable">Shadow SL</th>
          <th onclick="sortMatrix(11)" class="sortable">SL Auto</th>
        </tr>
      </thead>
      <tbody id="matrix-body">
        <tr><td colspan="12" class="no-data pulse">Laden...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- CRON STATUS -->
<div class="sec-hd"><span>Cron Status</span><small>laatste run tijden</small></div>
<div class="tbl-wrap" id="cron-section">
  ${[
    { key:'AUTOCLOSE_2150',    label:'21:50 Auto-close',       sched:'Ma-Vr 21:50' },
    { key:'DAY_END_22:00',    label:'22:00 Ghost hard stop',  sched:'Ma-Vr 22:00' },
    { key:'RECONNECT_02:00',  label:'02:00 Reconnect',        sched:'Dagelijks' },
    { key:'NIGHTLY_OPTIMIZER',label:'03:00 Nightly Optimizer',sched:'Dagelijks' },
  ].map(c => {
    const ts = cronLastRun[c.key];
    const hasRun = !!ts;
    const tsStr = ts ? new Date(ts).toLocaleString('nl-BE', { timeZone:'Europe/Brussels', hour12:false }) : 'Nog niet gedraaid';
    return `<div class="cron-row">
      <div class="cron-dot ${hasRun ? 'ok' : 'off'}"></div>
      <div class="cron-name">${c.label}</div>
      <div class="cron-sched">${c.sched}</div>
      <div class="cron-ts">${tsStr}</div>
    </div>`;
  }).join('')}
</div>

<!-- RECENT WEBHOOK HISTORY -->
<div class="sec-hd"><span>Webhook History</span><small>laatste 20 events</small></div>
<div class="tbl-wrap fade-in">
  <table id="hist-table">
    <thead>
      <tr>
        <th>Tijd</th>
        <th>Type</th>
        <th>Symbool</th>
        <th>Detail</th>
      </tr>
    </thead>
    <tbody id="hist-body">
      ${webhookHistory.slice(0,20).map(h => {
        const typeColor = h.type === 'SUCCESS' ? 'c-green' : h.type.includes('BLOCK') || h.type === 'ERROR' ? 'c-red' : 'c-dim';
        return `<tr>
          <td class="c-muted">${h.ts ? new Date(h.ts).toLocaleTimeString('nl-BE', {timeZone:'Europe/Brussels'}) : ' - '}</td>
          <td class="bold ${typeColor}">${h.type}</td>
          <td class="c-c">${h.symbol || ' - '}</td>
          <td class="c-dim">${h.direction ? h.direction.toUpperCase() + ' ' : ''}${h.lots ? h.lots + 'L ' : ''}${h.session ? '['+h.session+']' : ''}${h.reason ? h.reason : ''}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="4" class="no-data">Geen history</td></tr>'}
    </tbody>
  </table>
</div>

</main>

<script>
// -- SERVER CONFIG (server-side injected, safe) --
window.__CONFIG__ = ${JSON.stringify({ accountBalance: ACCOUNT_BALANCE })};
</script>

<script>
// -- SESSION TABLE SORT --
let sessSort = { key: 'sess', dir: 1 };
function sortSess(key) {
  if (sessSort.key === key) sessSort.dir *= -1;
  else { sessSort.key = key; sessSort.dir = 1; }
  document.querySelectorAll('#sess-table th').forEach(th => th.classList.remove('sort-asc','sort-desc'));
  const idx = ['sess','n','winrate','slRate','avgRR','bestRR','bestEV','tpLocks','evLocks','pnl'].indexOf(key);
  const ths = document.querySelectorAll('#sess-table thead th');
  if (ths[idx]) ths[idx].classList.add(sessSort.dir === 1 ? 'sort-asc' : 'sort-desc');
  const tbody = document.getElementById('sess-tbody');
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr')];
  const dataKey = { sess:'sess', n:'n', winrate:'winrate', slRate:'slrate', avgRR:'avgrr', bestRR:'bestrr', bestEV:'bestev', tpLocks:'tplocks', evLocks:'evlocks', pnl:'pnl' }[key] || key;
  rows.sort((a, b) => {
    const av = a.dataset[dataKey] ?? '';
    const bv = b.dataset[dataKey] ?? '';
    const an = parseFloat(av), bn = parseFloat(bv);
    const cmp = isNaN(an) || isNaN(bn) ? av.localeCompare(bv) : an - bn;
    return cmp * sessSort.dir;
  });
  rows.forEach(r => tbody.appendChild(r));
}

// -- MATRIX TABLE SORT --
let matrixSort = { key: 0, dir: 1 };
function sortMatrix(colIdx) {
  if (matrixSort.key === colIdx) matrixSort.dir *= -1;
  else { matrixSort.key = colIdx; matrixSort.dir = 1; }
  document.querySelectorAll('#matrix-tbl thead th').forEach(th => th.classList.remove('sort-asc','sort-desc'));
  const ths = document.querySelectorAll('#matrix-tbl thead th');
  if (ths[colIdx]) ths[colIdx].classList.add(matrixSort.dir === 1 ? 'sort-asc' : 'sort-desc');
  const tbody = document.getElementById('matrix-body');
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr')];
  rows.sort((a, b) => {
    const ac = a.cells[colIdx]?.textContent?.trim() ?? '';
    const bc = b.cells[colIdx]?.textContent?.trim() ?? '';
    const an = parseFloat(ac), bn = parseFloat(bc);
    const cmp = isNaN(an) || isNaN(bn) ? ac.localeCompare(bc) : an - bn;
    return cmp * matrixSort.dir;
  });
  rows.forEach(r => tbody.appendChild(r));
}

// -- CLOCK --
function tick() {
  document.getElementById('hclock').textContent =
    new Date().toLocaleTimeString('nl-BE', { timeZone:'Europe/Brussels', hour12:false }) + ' BXL';
}
setInterval(tick, 1000); tick();

// -- SAFE FETCH met timeout --
async function sf(url, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('sf HTTP ' + r.status + ':', url, txt.slice(0, 200));
      return { _error: 'HTTP ' + r.status, _detail: txt.slice(0, 200) };
    }
    return r.json();
  } catch(e) {
    console.warn('sf failed:', url, e.message);
    return { _error: e.message };
  }
}

// -- MATRIX BUILDER -- uses /api/matrix (server-side pre-computed)
async function buildMatrix() {
  var tbody = document.getElementById('matrix-body');
  if (!tbody) return;

  var data = await sf('/api/matrix', 20000);

  if (!data) {
    tbody.innerHTML = '<tr><td colspan="12" class="no-data" style="color:var(--red)">Matrix fetch mislukt - zie browser console voor details</td></tr>';
    return;
  }
  if (data._error) {
    tbody.innerHTML = '<tr><td colspan="12" class="no-data" style="color:var(--red)">Server fout: ' + data._error + (data._detail ? ' - ' + data._detail.slice(0,150) : '') + '</td></tr>';
    return;
  }
  if (!data.rows || !data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="no-data">Nog geen trades beschikbaar - matrix verschijnt na eerste gesloten positie</td></tr>';
    return;
  }

  var rows = data.rows;
  var html = '';

  for (var i = 0; i < rows.length; i++) {
    var r    = rows[i];
    var cols = '';
    var sess = ['asia', 'london', 'ny'];

    for (var j = 0; j < sess.length; j++) {
      var s  = sess[j];
      var sd = r.sessions[s];

      if (!sd || sd.count === 0) {
        cols += '<td class="c-muted">-</td><td class="c-muted">-</td><td class="c-muted">-</td>';
      } else {
        var rrTxt  = sd.lockedRR  != null ? sd.lockedRR + 'R'            : (sd.bestRR != null ? '~' + sd.bestRR + 'R' : '-');
        var evTxt  = sd.evAtLock  != null ? sd.evAtLock.toFixed(3)       : '-';
        var evCls  = sd.evAtLock  != null ? (sd.evAtLock > 0 ? 'c-green' : 'c-red') : 'c-muted';
        var rrCls  = sd.hasLock             ? 'bold c-c'                 : 'c-dim';
        var wrTxt  = sd.winrate   != null   ? sd.winrate + '%'           : '';
        cols += '<td class="' + rrCls + '">' + rrTxt + (wrTxt ? '<br><span class="c-muted" style="font-size:9px">' + sd.count + 'tr ' + wrTxt + '</span>' : '<br><span class="c-muted" style="font-size:9px">' + sd.count + ' trades</span>') + '</td>'
              + '<td class="' + evCls + '">' + evTxt + '</td>'
              + '<td class="c-dim">' + sd.count + '</td>';
      }
    }

    // Shadow SL kolom
    var shadowMult = r.shadowMult != null ? r.shadowMult : r.slMult;
    var shadowCol;
    if (shadowMult == null) {
      shadowCol = '<span class="c-muted">-</span>';
    } else {
      var smCls = shadowMult > 1 ? 'c-gold' : shadowMult < 1 ? 'c-purple' : 'c-green';
      var smEV  = r.shadowEV != null ? ' <span class="c-muted" style="font-size:9px">EV ' + r.shadowEV.toFixed(3) + '</span>' : '';
      shadowCol = '<span class="' + smCls + '">' + shadowMult + 'x</span>' + smEV;
    }

    // Auto-apply kolom
    var autoCol;
    if (r.slAutoApplied) {
      var evStr = r.slEV != null ? ' EV=' + r.slEV.toFixed(3) : '';
      autoCol = '<span class="c-green">AUTO ' + (r.slMult || '?') + 'x' + evStr + '</span>';
    } else {
      var pct     = Math.min(100, Math.round((r.slTrades / 30) * 100));
      var barColor = pct >= 66 ? '#00e396' : pct >= 33 ? '#f0c040' : '#506070';
      autoCol = '<span class="c-muted">' + r.slTrades + '/30</span>'
              + '<div style="margin-top:3px;height:3px;background:#161e2a;border-radius:2px;width:60px">'
              + '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:2px"></div></div>';
    }

    // Total trades badge
    var totCls = r.totalTrades >= 30 ? 'c-green' : r.totalTrades >= 10 ? 'c-gold' : 'c-dim';

    html += '<tr>'
          + '<td class="bold c-c">' + r.symbol + '<br><span class="' + totCls + '" style="font-size:9px">' + r.totalTrades + ' total</span></td>'
          + cols
          + '<td>' + shadowCol + '</td>'
          + '<td>' + autoCol + '</td>'
          + '</tr>';
  }

  tbody.innerHTML = html;
}

// -- LIVE DATA REFRESH --
async function loadAll() {
  const flash = document.getElementById('refresh-flash');
  if (flash) { flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 300); }

  try {
    const [posRes, ghostRes, dailyRes] = await Promise.all([
      sf('/live/positions'),
      sf('/live/ghosts'),
      sf('/daily-risk'),
    ]);

    if (posRes) {
      document.getElementById('kpi-open').textContent = posRes.count ?? 0;
      const bal = posRes.balance || window.__CONFIG__.accountBalance;
      document.getElementById('kpi-balance').textContent = bal.toFixed(0);
    }
    if (ghostRes) {
      document.getElementById('kpi-ghosts').textContent = ghostRes.count ?? 0;
    }
    if (dailyRes) {
      document.getElementById('risk-tmr-mult').textContent = 'x' + (dailyRes.tomorrow?.multiplier ?? 1).toFixed(2);
    }
  } catch(e) { console.warn('loadAll KPI fout:', e.message); }

  try {
    await buildMatrix();
  } catch(e) {
    console.warn('buildMatrix fout:', e.message);
    const tbody = document.getElementById('matrix-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="12" class="no-data">[!] Matrix laad fout  -  refresh om opnieuw te proberen</td></tr>';
  }
}

document.addEventListener("DOMContentLoaded", function() { loadAll(); setInterval(loadAll, 30000); });
</script>
</body>
</html>`);
});

app.use((req, res) => {
  res.status(404).json({ error:"Route niet gevonden", route:req.method+" "+req.originalUrl });
});

// ==============================================================
// STARTUP v7.3
// ==============================================================
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // -- Env-variabelen valideren voor alles ----------------
    const REQUIRED_ENV = ["META_API_TOKEN", "META_ACCOUNT_ID", "WEBHOOK_SECRET"];
    const missing = REQUIRED_ENV.filter(k => !process.env[k]);
    if (missing.length) {
      console.error(`[ERR] Ontbrekende vereiste env-variabelen: ${missing.join(", ")}`);
      process.exit(1);
    }

    console.log("🚀 FTMO Webhook Server v7.9  -  opstarten...");
    await initDB();

    const dbTrades = await loadAllTrades();
    closedTrades.push(...dbTrades);
    console.log(`📂 ${dbTrades.length} trades geladen`);

    const savedTP = await loadTPConfig();
    for (const [key, val] of Object.entries(savedTP)) {
      if (!key.endsWith("__all")) tpLocks[key] = val;
    }
    console.log(`🔒 ${Object.keys(tpLocks).length} TP locks geladen`);

    const savedSL = await loadSLConfig();
    Object.assign(slLocks, savedSL);
    console.log(`📐 ${Object.keys(savedSL).length} SL configs geladen`);

    const shadowRows = await loadShadowSLAnalysis();
    for (const row of shadowRows) {
      shadowSLResults[row.symbol] = {
        symbol: row.symbol,
        best: { slMultiplier: row.bestMultiplier, bestEV: row.bestEV, bestRR: row.bestRR, bestWinrate: row.bestWinrate, slHitRate: row.slHitRate },
        allMultiples: [],   // [v7.3] placeholder  -  wordt gevuld door runShadowSLOptimizerAll() hieronder
        tradesUsed: row.tradesUsed, computedAt: row.computedAt,
      };
    }
    console.log(`🌑 ${shadowRows.length} shadow SL resultaten geladen`);

    const dailyRisk = await loadLatestDailyRisk();
    if (dailyRisk) {
      dailyRiskMultiplier     = dailyRisk.riskMultNext ?? 1.0;
      dailyRiskMultiplierNext = dailyRisk.riskMultNext ?? 1.0;
    }

    await restoreOpenPositionsFromMT5();
    await repairOrphanedGhosts();

    // [v7.3] Streaks reconstrueren vanuit closedTrades  -  overleeft herstarts
    reconstructConsecutivePositiveDays();

    const symbolCounts = {};
    for (const t of closedTrades) {
      const sym = normalizeSymbol(t.symbol);
      symbolCounts[sym] = (symbolCounts[sym] || 0) + 1;
    }
    for (const [sym, n] of Object.entries(symbolCounts)) {
      if (n >= SL_AUTO_APPLY_THRESHOLD) {
        await runSLLockEngine(sym).catch(() => {});
      }
    }

    await runShadowSLOptimizerAll();

    for (const key of Object.keys(tpLocks)) {
      if (key.endsWith("__all")) delete tpLocks[key];
    }

    app.listen(PORT, () => {
      console.log(`[OK] Server v7.9 luistert op port ${PORT}`);
      console.log(`   🔹 Dashboard: /dashboard`);
      console.log(`   🔹 Nieuwe endpoints: /analysis/rr, /analysis/sessions`);
      console.log(`   🔹 Nieuwe endpoints: /research/tp-optimizer, /research/tp-optimizer/sessie`);
      console.log(`   🔹 Live positions: risk%/balance, SL afstand%, PnL%`);
      console.log(`   🔹 Ghost delta, MAE, closeReason badge`);
      console.log(`   🔹 Tijd-tot-SL tabel per pairxsessie`);
      console.log(`   🔹 Sessie cards Asia/London/NY`);
    });
  } catch(err) {
    console.error("[ERR] Startup mislukt:", err.message);
    process.exit(1);
  }
}

start();
