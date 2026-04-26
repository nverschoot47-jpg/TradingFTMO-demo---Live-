// ===============================================================
// server.js  v11.3  |  PRONTO-AI
// TradingView → MetaApi REST → FTMO MT5
//
// v11.3 — PHANTOM TRADE FIX + STOCK VOLUME STEP (21 April 2026):
//
//  FIX C1 — local_ positionId guard:
//    Als MetaApi geen positionId teruggeeft na placeOrder(), genereert de
//    server een fake local_${Date.now()} ID. Alle vervolgcalls faalden dan
//    met HTTP 404 en de trade werd toch opgeslagen als 0.00R phantom entry
//    in de TP Optimiser. Nieuw: na 2.5s wacht, zoek echte positie op MT5
//    o.b.v. symbol + richting + geopend < 30s geleden.
//    Gevonden → gebruik echt ID en ga door.
//    Niet gevonden → ORDER_NOT_CONFIRMED return (geen DB opslaan, geen ghost).
//
//  FIX C3 — NaN sanitizer in TV payload:
//    TradingView stuurt soms NaN voor session_high/low (forex + stocks).
//    JSON.parse() faalt op NaN → signaal verloren. Middleware vervangt
//    nu :NaN door :0 vóór parse. session_high/low worden toch niet
//    gebruikt in EV-berekening — veilig om 0 te zetten.
//
//  FIX C2 — Stock volume step (ZM, AAPL, TSLA, etc.):
//    calcLots() rondde altijd af op 0.01 stap. Stocks hebben minLot=1 en
//    volumeStep=1 (hele aandelen). MT5/FTMO weigerde volumes als 432.82.
//    fetchSymbolLotValue() slaat nu ook minVolume en volumeStep op uit spec.
//    calcLots() rondt af via floor naar volumeStep:
//      stocks: 432.82 → 432 lots (hele aandelen)
//      forex:  0.726  → 0.72 lots (0.01 stap, ongewijzigd gedrag)
//    minVolume gebruikt als ondergrens (ipv hardcoded 0.01).
//
// v11.2 — UK100 RISK FIX + VWAP BAND THRESHOLD (20 April 2026):
//
//  FIX A — vwapBandPct threshold: 0.9 → 1.5 (150%):
//    Channel break strategie genereert signals buiten de VWAP band.
//    Threshold van 90% blokkeerde bijna alle UK100 trades.
//    Verhoogd naar 150% — alleen extreme uitschieters (>1.5× halve band)
//    worden nog geblokkeerd met VWAP_BAND_EXHAUSTED.
//
//  FIX B — UK100 lotVal fallback gecorrigeerd:
//    LOT_VALUE[index] = 20 was fout voor UK100.cash (FTSE 100 CFD).
//    Echte lotVal = 1 GBP/punt/lot op FTMO MT5.
//    Nieuw: LOT_VALUE_BY_MT5 map met per-symbol fallbacks:
//      UK100.cash = 1, GER40.cash = 1, US100.cash = 1, US30.cash = 1.
//    fetchSymbolLotValue() gebruikt deze map vóór de generieke LOT_VALUE.
//    Bij actieve MT5 connectie prevaleert altijd de live spec (ongewijzigd).
//    recalcLotsAfterSL() en rebuildCurrencyExposure() ook bijgewerkt.
//
// v11.1 — BUG FIXES (20 April 2026):
//
//  FIX 1 — vwapPosition hersteld bij server restart:
//    restorePositionsFromMT5() parsete vpPos hardcoded als "unknown".
//    Nu wordt vwapPosition geparsed uit de MT5 comment string via
//    parseVwapFromComment(). Comment formaat: NV-{dir}-{sym}-{A|B|U}-{rr}-{sess}.
//    A=above, B=below, U=unknown. OptKey en ghost tracker gebruiken
//    de juiste vwapPosition na restart → VWAP-tag correct in dashboard.
//
//  FIX 2 — Ghost tracker eerste tick delay 3s:
//    Ghost startte onmiddellijk na placeOrder(). MetaApi had de positie
//    nog niet geregistreerd → eerste SL/TP modify mislukte met HTTP 404.
//    GHOST_INITIAL_DELAY_MS = 3000ms vóór de eerste tick.
//    Vervolgende ticks gebruiken GHOST_POLL_MS (30s) zoals voorheen.
//
//  FIX 3 — TP Optimiser: filter op openedAt ≥ 2026-04-20T12:00 + status closed:
//    Dashboard loadOverview() filterde op closedAt ≥ 2026-04-18.
//    Gecorrigeerd naar: openedAt ≥ 2026-04-20T12:00:00Z AND closedAt IS NOT NULL.
//    Trades die nog open staan (closedAt null) worden uitgesloten.
//    Trades geopend vóór 12u op 20/04/2026 worden uitgesloten.
//    Alleen in de dashboard-side filter — geen DB wijziging nodig.
//
// v11.0 — RISK SIZING FIXES (20 April 2026):
//
//  FIX R1 — getOptimalTP() altijd DEFAULT_TP_RR = 2.0R bij geen data:
//    Geen asset type cap. Zolang er geen EV-data is (< 5 ghosts),
//    wordt altijd 2.0R gebruikt als TP target voor alle asset types.
//    Zodra er voldoende ghosts zijn, pakt de EV optimizer het beste
//    RR niveau en wordt dat gelockt via updateTPLock().
//    De TP lock is de enige bron van truth voor EV+ combos.
//
//  FIX R2 — calcLots() min lot warning:
//    Als rawLots < 0.01 → clamped naar 0.01 maar console.warn
//    toont inflatedRisk vs riskEUR (+% inflatie) zodat het
//    dashboard niet stilletjes verkeerde risk toont.
//
//  FIX R3 — actualRiskEUR in /live/positions gebruikt live symbolSpecCache:
//    Primair: symbolSpecCache[mt5Sym].lotVal (live van MT5).
//    Fallback: LOT_VALUE[type] (statisch). Indexes tonen nu
//    correcte werkelijke exposure (niet 23× te laag).
//
//  FIX R4 — lotDivisor anti-consolidation VERWIJDERD:
//    lotDivisor was bedoeld voor currency correlatie maar
//    zorgt voor inconsistente lotgroottes. Verwijderd uit
//    alle lot berekeningen → uniform 0.15% risk per trade.
//
//  FIX R5 — Step C2 post-execution lot herberekening:
//    lotDivisor verwijderd. scaleFactor reductie ook verwijderd
//    voor EV+ trades. Alleen forex EV-neutraal krijgt nog
//    currency budget check (scaleFactor ≤ 1.0).
//
//  GENOTEERD (later fixen):
//    Alle pairs draaien momenteel op inconsistente riskPct.
//    getSymbolRiskPct resolvet via env var → DB → DEFAULT_RISK_BY_TYPE
//    → FIXED_RISK_PCT. Fix = uniforme configuratie per type zonder
//    losse env overrides, of een aparte reconcile-run.
//
// v10.6 — FUNDAMENTELE CORRECTIES (19 April 2026):
//
//  MULT CORRECTIE —
//    riskEUR = balance × FIXED_RISK_PCT  (puur, geen evMult).
//    evMult + dayMult worden VERWIJDERD uit calcRiskEUR().
//    Lotsize sequentieel: baseLots = riskEUR / (dist × lotVal)
//      → finalLots = baseLots × evMult × dayMult  (voor EV+ trades)
//      → finalLots = baseLots × scaleFactor        (voor EV neutraal)
//    Budget check: finalLots × dist × lotVal = werkelijke EUR-exposure.
//
//  FIX A — Server berekent derivedSlPct van TV absolute prijzen:
//    payload bevat entry_price + sl_price (absolute MT5 prijzen).
//    server berekent: derivedSlPct = |entry_price - sl_price| / entry_price.
//    Validatie: derivedSlPct > 0 EN ≤ 0.05, anders hard reject.
//    MT5 SL: executionPrice × (1 ± derivedSlPct × SL_BUFFER_MULT).
//
//  FIX C — Currency Exposure Budget + Anti-consolidation:
//    EV+ trades (evMult > 1.0): geen budget check, volle lots.
//    EV neutraal (evMult = 1.0): beide valuta's tellen mee in budget.
//    CURRENCY_BUDGET_PCT env var (default 0.02 = 2% van balance).
//    scaleFactor beperkt lots bij budget exhaustion.
//    Anti-consolidation: zelfde symbol+sessie+richting → modifyPosition()
//      SL ×1.5 cumulatief op huidige MT5 SL + TP herberekend, geen nieuwe trade.
//
//  FIX D — TP Floor Guard:
//    Na calcTPPrice(), vóór order naar MT5.
//    minTPDist = |executionPrice - mt5SL| × MIN_TP_RR_FLOOR.
//    TP gecorrigeerd zodat afstand ≥ minTPDist.
//
//  FIX E — RR Verificatie met echte MT5 data:
//    Na TP Floor Guard: actualSLPct + actualTPRR gecontroleerd.
//    SL op verkeerde kant → emergency close + ghost tracker start.
//    closeReason: "RR_VERIFY_FAILED", excludeFromEV: true.
//    Overige checks: SL_TOO_WIDE (>5%) + TP_RR_TOO_LOW (<0.3R) → log only.
//    ORDER_PLACED log uitgebreid met derivedSlPct, actualSLPct, actualTPRR.
//
// (alle v10.5 fixes blijven actief — zie v10.5 header)
// ===============================================================

"use strict";

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const app = express();
// Trust Railway proxy (X-Forwarded-* headers)
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false, // Dashboard-only, niet nodig voor webhook
}));
// express.json() parset alleen Content-Type: application/json.
// TradingView stuurt webhooks soms als Content-Type: text/plain.
// express.text() vangt dit op en we parsen het handmatig als JSON.
app.use(express.json());
app.use(express.text({ type: "text/plain" }));

// Middleware: parse text/plain body als JSON wanneer nodig.
// TradingView webhook body is altijd JSON-string, maar Content-Type kan text/plain zijn.
// FIX C3 (v11.3): TV stuurt soms NaN als waarde (bv. session_high:NaN, session_low:NaN).
// NaN is geen geldig JSON — vervang :NaN door :0 vóór de parse zodat signalen niet verloren gaan.
app.use((req, res, next) => {
  if (typeof req.body === "string" && req.body.trim().startsWith("{")) {
    try {
      const sanitized = req.body.replace(/:NaN\b/g, ":0");
      if (sanitized !== req.body) {
        console.warn("[BodyParse] NaN waarden vervangen door 0 in TV payload (session_high/low reset)");
      }
      req.body = JSON.parse(sanitized);
      console.log("[BodyParse] text/plain body geparsed als JSON OK");
    } catch (e) {
      console.warn("[BodyParse] text/plain body kon niet geparsed worden:", e.message, "raw:", req.body.slice(0, 200));
    }
  }
  next();
});

// ── DB & Session imports ─────────────────────────────────────────
const {
  initDB, saveTrade, loadAllTrades,
  saveGhostTrade, loadGhostTrades, countGhostsByKey,
  saveGhostState, loadAllGhostStates, deleteGhostState,
  saveBandGhost, loadBandGhosts, loadBandGhostStats,
  saveShadowSnapshot, loadShadowSnapshots, saveShadowAnalysis, loadShadowAnalysis,
  loadAllShadowAnalysis,
  saveTPConfig, loadTPConfig,
  savePnlLog,
  saveDailyRisk, loadLatestDailyRisk,
  upsertSymbolRisk, loadSymbolRiskConfig,
  logWebhook, loadWebhookHistory,
  logSignal,
  computeEVStats,
  loadSignalStats,
  loadShadowWinners,
  saveLotOverride, loadLotOverrides,
  saveKeyRiskMult, loadKeyRiskMults,
  fetchRealizedPnl,
  saveSpreadLog, loadSpreadStats, loadSpreadLog,
} = require("./db");

const {
  SYMBOL_CATALOG, SESSION_LABELS, DEFAULT_RISK_BY_TYPE,
  getBrusselsComponents, getBrusselsDateStr, getBrusselsDateOnly,
  getSession, isMarketOpen, canOpenNewTrade, isMonitoringActive,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey,
  COMPLIANCE_DATE, COMPLIANCE_DATE_MS,
} = require("./session");

// ── Config ───────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const PORT            = process.env.PORT || 3000;

// ── Risk constants ───────────────────────────────────────────────
// FIXED_RISK_PCT: base risk per trade (0.15% of balance)
const FIXED_RISK_PCT = parseFloat(process.env.FIXED_RISK_PCT || "0.0015");

// FIX C: Currency exposure budget per valuta (default 2% van balance).
// Op €100k balance = €2.000 max exposure per valuta voor EV-neutraal trades.
const CURRENCY_BUDGET_PCT = parseFloat(process.env.CURRENCY_BUDGET_PCT || "0.02");

// FIX D: Minimum TP RR floor — TP moet minimaal deze factor × SL-afstand zijn.
const MIN_TP_RR_FLOOR = parseFloat(process.env.MIN_TP_RR_FLOOR || "0.5");

// Ghost settings
const GHOST_MIN_TRADES_FOR_TP = 5;
const GHOST_POLL_MS           = 30000;
const GHOST_MAX_MS            = 14 * 24 * 3600 * 1000;  // 2 weeks max tracking
const GHOST_MAX_RR            = 15;                       // stop at 15R peak
const MULT_MIN_SAMPLE         = 30;

// FIX 16
const MAX_CLOSED_TRADES = 10000;  // verhoogd van 5000 — bij 4500+ trades was de limiet bijna bereikt
// FIX 15
const MAX_HISTORY       = 200;

// SL buffer: MT5 SL placed at sl_pct × 1.5 to absorb spread + timing lag
const SL_BUFFER_MULT = 1.5;

// Min stop distances per MT5 symbol
const MIN_STOP = {
  "GER40.cash": 10, "UK100.cash": 2, "US100.cash": 10, "US30.cash": 10,
  "XAUUSD": 0.5,
};

// LOT_VALUE = fallback contract size per lot per asset type.
// PRIMAIR: live lotVal wordt opgehaald via fetchSymbolLotValue() van MT5 spec.
// Onderstaande waarden zijn ALLEEN de fallback als MT5 spec niet beschikbaar is.
//
// Broker-specifieke specs (uit MT5 symbool info, 20 Apr 2026):
// ┌────────────┬──────────────┬──────────┬───────────┬──────────────────────────┐
// │ Symbool    │ Type         │ Min lot  │ Max lot   │ Commission               │
// ├────────────┼──────────────┼──────────┼───────────┼──────────────────────────┤
// │ XAUUSD     │ commodity    │ 0.01     │ 100       │ 0.0007% EUR/lot          │
// │ EURUSD     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ NZDUSD     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ GBPNZD     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ USDCHF     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ GOOG       │ stock (CFD)  │ 1        │ 10000     │ 0.002% EUR/lot           │
// └────────────┴──────────────┴──────────┴───────────┴──────────────────────────┘
// Swap type voor forex/commodity: "In punten" (points-based, niet percentage).
// Swap koersen: Ma/Di/Do/Vr=1x, Woensdag=3x (triple swap).
// Forex: dist × 100000 = pip-waarde. Live lotVal van MT5 prevaleert altijd.
const LOT_VALUE = {
  index: 20, commodity: 100, stock: 1, forex: 100000,
};

// FIX UK100: per-MT5-symbol lotVal fallback voor indexes.
// UK100.cash: lotVal = 1 GBP/punt/lot (niet 20 — dat is fout voor FTSE).
// GER40.cash: lotVal = 1 EUR/punt/lot.
// US100.cash: lotVal = 1 USD/punt/lot.
// US30.cash:  lotVal = 1 USD/punt/lot.
// Deze waarden worden gebruikt als fetchSymbolLotValue() geen MT5 spec terugkrijgt.
// Bij een werkende MT5 connectie wordt dit altijd overschreven door de live spec.
const LOT_VALUE_BY_MT5 = {
  "UK100.cash": 1,
  "GER40.cash": 1,
  "US100.cash": 1,
  "US30.cash":  1,
};

// ── Live balance cache ────────────────────────────────────────────
let liveBalance   = 50000;
let liveBalanceAt = 0;

// ── MetaApi ───────────────────────────────────────────────────────
// ── MetaApi ───────────────────────────────────────────────────────
// META_API_REGION: stel in via Railway env als je account niet op london staat.
// Geldige waarden: london, new-york, frankfurt, singapore, sydney
// Standaard: london. Als je HTTP 504 ziet "account region mismatch" -> wijzig dit.
// Zie: https://app.metaapi.cloud/api-access/api-urls voor jouw account regio.
const META_REGION = process.env.META_API_REGION || "london";
const META_BASE = `https://mt-client-api-v1.${META_REGION}.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

async function metaFetch(path, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${META_BASE}${path}`, {
      ...options,
      headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json", ...(options.headers || {}) },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const body = await r.json(); msg += `: ${body?.message || body?.error || JSON.stringify(body)}`; } catch {}
      throw new Error(msg);
    }
    return r.json();
  } catch (e) { clearTimeout(t); throw e; }
}

async function fetchOpenPositions()         { return metaFetch("/positions"); }
async function fetchAccountInfo() {
  const info = await metaFetch("/accountInformation");
  if (info?.balance) {
    liveBalance   = parseFloat(info.balance);
    liveBalanceAt = Date.now();
    console.log(`[Balance] Live MT5 balance: €${liveBalance.toFixed(2)}`);
  }
  return info;
}
async function closePosition(id)            { return metaFetch(`/positions/${id}/close`, { method: "POST" }); }
async function fetchCurrentPrice(mt5Symbol) {
  try {
    const d   = await metaFetch(`/symbols/${encodeURIComponent(mt5Symbol)}/currentPrice`, {}, 5000);
    const bid = d.bid ?? null, ask = d.ask ?? null;
    if (bid !== null && ask !== null) return { mid: (bid + ask) / 2, bid, ask, spread: ask - bid };
    const mid = bid ?? ask ?? null;
    return mid !== null ? { mid, bid: mid, ask: mid, spread: 0 } : null;
  } catch { return null; }
}
async function placeOrder(payload) { return metaFetch("/trade", { method: "POST", body: JSON.stringify(payload) }, 12000); }

// ── In-memory state ───────────────────────────────────────────────
const openPositions  = {};
const closedTrades   = [];
const ghostTrackers  = {};
const tpLocks        = {};
const shadowResults  = {};
const webhookLog     = [];
const symbolRiskMap  = {};
const keyRiskMult    = {};   // { [optimizerKey]: { streak, evMult, dayMult } }
const lotOverrides   = {};   // { [symbol]: baseLots }

// FIX C: currency exposure tracking { [currency]: currentEURExposure }
// Bijgewerkt bij elke nieuwe EV-neutraal trade open/close.
const currencyExposure = {};

// FIX 9: rate-limit protection
let lastSyncAt = 0;
const SYNC_MIN_INTERVAL_MS = 55000;

// FIX 20: dupGuard with TTL
const DUP_GUARD_TTL_MS = 120000;
if (!global._dupGuard) global._dupGuard = {};

function logEvent(entry) {
  webhookLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookLog.length > MAX_HISTORY) webhookLog.length = MAX_HISTORY;
}

// ── Balance helpers ───────────────────────────────────────────────
async function getLiveBalance() {
  if (Date.now() - liveBalanceAt > 5 * 60 * 1000) {
    try { await fetchAccountInfo(); } catch {}
  }
  return liveBalance;
}

// ── Risk calculation ──────────────────────────────────────────────
function getSymbolRiskPct(symbol) {
  const envKey = `RISK_${symbol}`;
  if (process.env[envKey]) return parseFloat(process.env[envKey]);
  if (symbolRiskMap[symbol]) return symbolRiskMap[symbol];
  const info = getSymbolInfo(symbol);
  return DEFAULT_RISK_BY_TYPE[info?.type || "stock"] ?? FIXED_RISK_PCT;
}

// v10.6 MULT CORRECTIE: evMult en dayMult alleen voor lotsize scaling.
// riskEUR is puur: balance × pct — geen multipliers.
function getKeyEvMult(optimizerKey)  { return keyRiskMult[optimizerKey]?.evMult  ?? 1.0; }
function getKeyDayMult(optimizerKey) { return keyRiskMult[optimizerKey]?.dayMult ?? 1.0; }

// v10.6: calcRiskEUR = puur balance × pct. Geen evMult.
async function calcRiskEUR(symbol) {
  const balance = await getLiveBalance();
  const pct     = getSymbolRiskPct(symbol);
  return balance * pct;
}

// ── FIX C: Currency exposure helpers ─────────────────────────────
// Haal de twee valuta's op uit een forex pair (bijv. EURUSD → ['EUR','USD']).
function getPairCurrencies(symbol) {
  if (!symbol || symbol.length < 6) return [];
  return [symbol.slice(0, 3).toUpperCase(), symbol.slice(3, 6).toUpperCase()];
}

// Bereken de werkelijke EUR-exposure van een positie.
function calcPositionExposureEUR(lots, dist, lotVal) {
  return lots * dist * lotVal;
}

// Haal het currency budget ceiling op (in EUR).
async function getCurrencyBudget() {
  const balance = await getLiveBalance();
  return balance * CURRENCY_BUDGET_PCT;
}

// Rebuild currencyExposure vanuit alle open EV-neutrale posities.
// Wordt aangeroepen na elke open/close van een EV-neutrale positie.
function rebuildCurrencyExposure() {
  for (const k of Object.keys(currencyExposure)) delete currencyExposure[k];
  for (const pos of Object.values(openPositions)) {
    // EV+ trades tellen NIET mee in currency budget (Fix C spec)
    if ((pos.evMult ?? 1.0) > 1.0) continue;
    const info   = getSymbolInfo(pos.symbol);
    if (info?.type !== "forex") continue;
    const dist   = Math.abs(pos.entry - pos.sl);
    // Gebruik gecachede lotVal van MT5 spec (live waarde), fallback op statische 100000 voor forex
    const mt5Sym4  = pos.mt5Symbol || getSymbolInfo(pos.symbol)?.mt5 || pos.symbol;
    const cachedSpec = symbolSpecCache[mt5Sym4];
    const lotVal = cachedSpec?.lotVal ?? LOT_VALUE_BY_MT5[mt5Sym4] ?? LOT_VALUE["forex"] ?? 100000;
    const expEUR = calcPositionExposureEUR(pos.lots ?? 0, dist, lotVal);
    for (const ccy of getPairCurrencies(pos.symbol)) {
      currencyExposure[ccy] = (currencyExposure[ccy] ?? 0) + expEUR;
    }
  }
}

// Bereken scaleFactor voor EV-neutrale trade op basis van budget.
// Retourneert een getal 0..1 waarmee de lots worden vermenigvuldigd.
// Bij 0 → budget volledig uitgeput → trade geblokkeerd.
async function calcCurrencyScaleFactor(symbol, proposedLots, dist, lotVal) {
  const budget      = await getCurrencyBudget();
  const currencies  = getPairCurrencies(symbol);
  if (!currencies.length) return 1.0; // non-forex: geen budget check

  const proposedExp = calcPositionExposureEUR(proposedLots, dist, lotVal);
  let   minScale    = 1.0;

  for (const ccy of currencies) {
    const current = currencyExposure[ccy] ?? 0;
    const room    = budget - current;
    if (room <= 0) return 0; // volledig uitgeput
    const scale = room / proposedExp;
    if (scale < minScale) minScale = scale;
  }
  return Math.min(1.0, Math.max(0, minScale));
}

// ── MT5 Symbol Spec Cache ─────────────────────────────────────────
// Haalt contractSize en tickValue op van MT5 via MetaApi.
// Gecached per mt5Symbol — één keer ophalen, daarna uit cache.
// lotValue = tickValue / tickSize  (EUR per 1 prijspunt per lot)
// Fallback: LOT_VALUE[type] als MetaApi niet beschikbaar is.
const symbolSpecCache = {};

async function fetchSymbolLotValue(mt5Symbol, assetType) {
  if (symbolSpecCache[mt5Symbol]) return symbolSpecCache[mt5Symbol];
  try {
    const spec = await metaFetch(`/symbols/${encodeURIComponent(mt5Symbol)}/specification`, {}, 6000);
    // MetaApi geeft: contractSize, tickSize, tickValue (in account currency)
    const contractSize = parseFloat(spec?.contractSize) || null;
    const tickSize     = parseFloat(spec?.tickSize)     || null;
    const tickValue    = parseFloat(spec?.tickValue)    || null;
    // FIX C2 (v11.3): sla ook minVolume en volumeStep op — kritisch voor stocks (volumeStep=1)
    const minVolume    = parseFloat(spec?.minVolume)    || null;
    const volumeStep   = parseFloat(spec?.volumeStep)   || null;
    if (contractSize && tickSize && tickValue && tickSize > 0) {
      // lotValue = hoeveel account-currency verandert per 1 prijspunt per lot
      const lotVal = parseFloat((tickValue / tickSize).toFixed(6));
      symbolSpecCache[mt5Symbol] = { lotVal, contractSize, tickSize, tickValue, minVolume, volumeStep, source: "mt5" };
      console.log(`[SymSpec] ${mt5Symbol}: contractSize=${contractSize} tickSize=${tickSize} tickValue=${tickValue} -> lotVal=${lotVal} minVol=${minVolume} step=${volumeStep}`);
      return symbolSpecCache[mt5Symbol];
    }
  } catch (e) {
    console.warn(`[SymSpec] ${mt5Symbol}: kon spec niet ophalen (${e.message}) — gebruik fallback`);
  }
  // Fallback: eerst per-symbol override, dan generiek per asset type
  // FIX C2 (v11.3): stocks fallback — minVolume=1, volumeStep=1 (hele aandelen)
  const lotVal     = LOT_VALUE_BY_MT5[mt5Symbol] ?? LOT_VALUE[assetType] ?? 1;
  const minVolume  = assetType === "stock" ? 1 : 0.01;
  const volumeStep = assetType === "stock" ? 1 : 0.01;
  symbolSpecCache[mt5Symbol] = { lotVal, minVolume, volumeStep, source: "fallback" };
  return symbolSpecCache[mt5Symbol];
}
// ── Lot calculation ───────────────────────────────────────────────
// v10.7: lotVal live opgehaald van MT5 via fetchSymbolLotValue().
// Fallback op statische LOT_VALUE als MetaApi spec niet beschikbaar.
// Retourneert object: { lots, lotVal, source }
async function calcLots(symbol, mt5Sym, assetType, entry, sl, riskEUR, evMult, dayMult) {
  const spec       = await fetchSymbolLotValue(mt5Sym, assetType);
  const lotVal     = spec.lotVal;
  // FIX C2 (v11.3): gebruik volumeStep en minVolume uit MT5 spec.
  // Stocks: volumeStep=1, minVolume=1 (hele aandelen, geen decimalen).
  // Forex:  volumeStep=0.01, minVolume=0.01 (ongewijzigd gedrag).
  const volumeStep = spec.volumeStep ?? (assetType === "stock" ? 1 : 0.01);
  const minVolume  = spec.minVolume  ?? (assetType === "stock" ? 1 : 0.01);

  const dist = Math.abs(entry - sl);
  if (!dist || !riskEUR) return { lots: minVolume, lotVal, source: spec.source };
  const baseLots = riskEUR / (dist * lotVal);
  const em       = (evMult  && evMult  > 0) ? evMult  : 1.0;
  const dm       = (dayMult && dayMult > 0) ? dayMult : 1.0;
  const rawLots  = baseLots * em * dm;

  // FIX C2 (v11.3): rond af naar volumeStep via floor (niet 0.01 hardcoded).
  // floor(432.82 / 1) * 1 = 432  → stocks: hele aandelen
  // floor(0.726  / 0.01) * 0.01 = 0.72 → forex: 0.01 stap
  const steppedLots = Math.floor(rawLots / volumeStep) * volumeStep;
  const clampedLots = Math.max(minVolume, steppedLots);

  // FIX R2 (v11.0): waarschuw als min lot floor de werkelijke risk inflateert.
  if (rawLots < minVolume) {
    const inflatedRisk = minVolume * dist * lotVal;
    const inflationPct = ((inflatedRisk / riskEUR - 1) * 100).toFixed(0);
    console.warn(`[MinLot] ${mt5Sym} (${assetType}): rawLots=${rawLots.toFixed(5)} → clamped ${minVolume}. actualRisk=€${inflatedRisk.toFixed(2)} vs intended=€${riskEUR.toFixed(2)} (+${inflationPct}%)`);
  }

  // Afronden op correcte decimalen op basis van volumeStep
  const decimals = volumeStep < 1 ? (String(volumeStep).split(".")[1]?.length ?? 2) : 0;
  const lots = parseFloat(clampedLots.toFixed(decimals));
  return { lots, lotVal, source: spec.source };
}

// ── Recalculate base lots after SL hit ────────────────────────────
// FIX 2: persists to DB immediately.
async function recalcLotsAfterSL(symbol, entry, sl) {
  try {
    const balance = await getLiveBalance();
    const pct     = getSymbolRiskPct(symbol);
    const info    = getSymbolInfo(symbol);
    const type    = info?.type || "stock";
    const mt5Sym  = info?.mt5 || symbol;
    // Gebruik live lotVal van MT5 spec als gecached, anders fallback
    const cachedSpec = symbolSpecCache[mt5Sym];
    const lotVal  = cachedSpec?.lotVal ?? LOT_VALUE_BY_MT5[mt5Sym] ?? LOT_VALUE[type] ?? 1;
    const dist    = Math.abs(entry - sl);
    if (!dist) return;
    // v10.6: puur balance × pct (geen multipliers in baseLots)
    const baseLots = parseFloat((balance * pct / (dist * lotVal)).toFixed(2));
    lotOverrides[symbol] = baseLots;
    await saveLotOverride(symbol, baseLots).catch(() => {});
    console.log(`[LotRecalc] ${symbol} → base lots = ${baseLots} (persisted to DB)`);
    logEvent({ type: "LOT_RECALC", symbol, baseLots, slDist: dist, balance, riskPct: pct });
  } catch (e) { console.warn("[LotRecalc]", e.message); }
}

// ── SL helpers ───────────────────────────────────────────────────
// FIX A: server berekent derivedSlPct van absolute TV prijzen.
// entry_price en sl_price komen uit de TV payload.
// derivedSlPct = |entry_price - sl_price| / entry_price
// Validatie: > 0 en <= 0.05 (5%), anders hard reject.
function deriveSLPct(tvEntryPrice, tvSLPrice) {
  if (!tvEntryPrice || !tvSLPrice || tvEntryPrice <= 0) return null;
  return Math.abs(tvEntryPrice - tvSLPrice) / tvEntryPrice;
}

// MT5 SL berekening op basis van executionPrice + derivedSlPct.
// ×1.5 buffer absorbeert slippage/delay én geeft shadow SL optimizer ruimte.
function calcSLFromDerivedPct(direction, executionPrice, derivedSlPct) {
  const buffered = derivedSlPct * SL_BUFFER_MULT;
  return direction === "buy"
    ? parseFloat((executionPrice * (1 - buffered)).toFixed(5))
    : parseFloat((executionPrice * (1 + buffered)).toFixed(5));
}

// Backwards compat alias
function calcSLFromPct(direction, mt5Entry, slPct) {
  return calcSLFromDerivedPct(direction, mt5Entry, slPct);
}

function enforceMinStop(mt5Symbol, direction, entry, sl) {
  const minD = MIN_STOP[mt5Symbol] ?? 0;
  const dist = Math.abs(entry - sl);
  if (dist >= minD) return sl;
  return direction === "buy"
    ? parseFloat((entry - minD).toFixed(5))
    : parseFloat((entry + minD).toFixed(5));
}

// ── TP calculation ────────────────────────────────────────────────
const DEFAULT_TP_RR = 2.0;

// v11.0: Geen cap per asset type — DEFAULT_TP_RR = 2.0R voor alle assets
// zolang er nog geen EV-data is (< GHOST_MIN_TRADES_FOR_TP ghosts).
// Zodra er voldoende data is, pakt de EV optimizer het beste RR niveau
// en wordt dat gelockt via updateTPLock(). De TP lock is de enige
// bron van truth voor EV+ combos — geen externe cap nodig.
async function getOptimalTP(optimizerKey, assetType = null) {
  const locked = tpLocks[optimizerKey];
  if (locked) return locked.lockedRR;
  // Fix 2: check evCache first — voorkomt live DB query per inkomende trade
  // evCache wordt elke 5min rebuilt en na elke ghost finalize
  const cached = evCache.data.find(e => e.key === optimizerKey);
  if (cached) {
    if ((cached.count ?? 0) < GHOST_MIN_TRADES_FOR_TP) return DEFAULT_TP_RR;
    return cached.bestRR ?? DEFAULT_TP_RR;
  }
  // Fallback: directe DB query als cache nog leeg is (eerste start)
  const ev = await computeEVStats(optimizerKey);
  if (!ev || ev.count < GHOST_MIN_TRADES_FOR_TP) return DEFAULT_TP_RR;
  return ev.bestRR ?? DEFAULT_TP_RR;
}

function calcTPPrice(direction, entry, sl, rrTarget) {
  const dist = Math.abs(entry - sl);
  return direction === "buy"
    ? parseFloat((entry + dist * rrTarget).toFixed(5))
    : parseFloat((entry - dist * rrTarget).toFixed(5));
}

// FIX D: TP Floor Guard — TP moet minimaal MIN_TP_RR_FLOOR × SL-afstand zijn.
// Basis = werkelijke MT5 SL afstand na enforceMinStop().
// Retourneert gecorrigeerde TP prijs (onveranderd als floor OK is).
function applyTPFloorGuard(direction, executionPrice, mt5SL, tp) {
  const slDist    = Math.abs(executionPrice - mt5SL);
  const minTPDist = slDist * MIN_TP_RR_FLOOR;
  if (direction === "buy") {
    const minTP = parseFloat((executionPrice + minTPDist).toFixed(5));
    if (tp < minTP) {
      console.log(`[TPFloor] BUY TP ${tp} < floor ${minTP} → gecorrigeerd`);
      return minTP;
    }
  } else {
    const minTP = parseFloat((executionPrice - minTPDist).toFixed(5));
    if (tp > minTP) {
      console.log(`[TPFloor] SELL TP ${tp} > floor ${minTP} → gecorrigeerd`);
      return minTP;
    }
  }
  return tp;
}

// ── FIX E: RR Verificatie met echte MT5 data ─────────────────────
// Controleert na TP Floor Guard of SL/TP op de juiste kant liggen.
// Retourneert { ok, slWrongSide, slTooWide, tpRRTooLow, actualSLPct, actualTPRR }
function verifyRR(direction, executionPrice, mt5SL, mt5TP) {
  const result = {
    ok: true, slWrongSide: false, slTooWide: false, tpRRTooLow: false,
    actualSLPct: null, actualTPRR: null,
  };

  // Bereken actuele SL afstand %
  if (executionPrice > 0 && mt5SL > 0) {
    result.actualSLPct = Math.abs(executionPrice - mt5SL) / executionPrice;
  }

  // SL op verkeerde kant?
  if (direction === "buy"  && mt5SL >= executionPrice) { result.slWrongSide = true; result.ok = false; }
  if (direction === "sell" && mt5SL <= executionPrice) { result.slWrongSide = true; result.ok = false; }

  // SL te breed? (> 5%) — log only
  if (result.actualSLPct != null && result.actualSLPct > 0.05) result.slTooWide = true;

  // Bereken TP RR t.o.v. werkelijke SL afstand
  if (mt5SL > 0 && mt5TP != null) {
    const slDist = Math.abs(executionPrice - mt5SL);
    const tpDist = direction === "buy"
      ? mt5TP - executionPrice
      : executionPrice - mt5TP;
    result.actualTPRR = slDist > 0 ? parseFloat((tpDist / slDist).toFixed(3)) : null;
  }

  // TP RR te laag? (< 0.3R) — log only
  if (result.actualTPRR != null && result.actualTPRR < 0.3) result.tpRRTooLow = true;

  return result;
}

// ── TP Lock Engine ────────────────────────────────────────────────
async function updateTPLock(optimizerKey, symbol, session, direction, vwapPos) {
  try {
    const ev = await computeEVStats(optimizerKey);
    if (!ev || ev.count < GHOST_MIN_TRADES_FOR_TP) return;
    const prev  = tpLocks[optimizerKey];
    const newRR = ev.bestRR;
    const evPos = (ev.bestEV ?? 0) > 0;
    tpLocks[optimizerKey] = { lockedRR: newRR, lockedGhosts: ev.count, evAtLock: ev.bestEV, evPositive: evPos, lockedAt: new Date().toISOString() };
    await saveTPConfig(optimizerKey, symbol, session, direction, vwapPos, newRR, ev.count, ev.bestEV, prev?.lockedRR ?? null);
    console.log(`[TP Lock] ${optimizerKey}: ${prev?.lockedRR ?? "new"}R → ${newRR}R (EV=${ev.bestEV?.toFixed(3)}, n=${ev.count})`);
  } catch (e) { console.warn("[!] updateTPLock:", e.message); }
}

// ── MaxRR helpers ─────────────────────────────────────────────────
function calcMaxRR(direction, entry, sl, maxPrice) {
  const dist = Math.abs(entry - sl);
  if (!dist || maxPrice == null) return 0;
  const fav = direction === "buy" ? maxPrice - entry : entry - maxPrice;
  // 3 decimalen — 2dp roundt 1.996R → 1.99 waardoor het als verlies telt bij TP sweep op 2.0R
  return parseFloat((Math.max(0, fav) / dist).toFixed(3));
}

function calcPctSlUsed(direction, entry, sl, currentPrice) {
  const dist = Math.abs(entry - sl);
  if (!dist) return 0;
  const adverse = direction === "buy" ? entry - currentPrice : currentPrice - entry;
  return parseFloat((Math.max(0, Math.min(100, (adverse / dist) * 100)).toFixed(2)));
}

// ── Anti-consolidation helpers (FIX 3) ───────────────────────────
function sharesCurrency(a, b) {
  if (!a || !b || a.length < 6 || b.length < 6) return false;
  const aBase = a.slice(0, 3), aQuote = a.slice(3, 6);
  const bBase = b.slice(0, 3), bQuote = b.slice(3, 6);
  return aBase === bBase || aBase === bQuote || aQuote === bBase || aQuote === bQuote;
}

// FIX 3: Find duplicate — zelfde symbol + richting, ongeacht sessie.
// Een open trade leeft over sessies heen, sessie mag niet als escape gelden.
// Returns de OUDSTE open positie (voor SL widen), of null als geen bestaat.
function findExactDuplicate(symKey, session, direction) {
  const matches = Object.values(openPositions).filter(p =>
    p.symbol === symKey && p.direction === direction
  );
  if (!matches.length) return null;
  // Oudste eerst — SL widen op de langst lopende positie
  matches.sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
  return matches[0];
}

// Hard cap: max 1 open positie per symbol+richting.
// MetaApi REST ondersteunt geen positie modify — SL widen is niet mogelijk.
// Bij >= 1 open in zelfde richting → trade geblokkeerd.
const MAX_SAME_DIRECTION = 1;
function countSameDirection(symKey, direction) {
  return Object.values(openPositions).filter(p =>
    p.symbol === symKey && p.direction === direction
  ).length;
}

// FIX 3: Count same-currency pairs open in same direction (excluding exact duplicate).
function countRelatedForex(symKey, direction) {
  return Object.values(openPositions).filter(p =>
    p.direction === direction &&
    p.symbol !== symKey &&
    sharesCurrency(p.symbol, symKey)
  ).length;
}

// FIX 3: Widen SL × 1.5 on existing trade and adjust TP proportionally.
// ── Ghost Optimizer ───────────────────────────────────────────────
// Ghost tracker volgt de live prijs en berekent maxRR op de VASTE
// SL die bij trade-open is gezet. SL en TP wijzigen niet meer mid-trade.
function startGhostTracker(pos, restoreData = null) {
  // Guard: ghost is nutteloos zonder SL (geen price tracking mogelijk)
  // en zonder vwapPosition (kan nooit in EV tabel terechtkomen)
  if (!pos.sl || pos.sl <= 0) {
    console.warn(`[Ghost] ${pos.positionId}: sl=0, ghost NOT started — wacht op SL sync`);
    return;
  }
  if (!pos.vwapPosition || pos.vwapPosition === "unknown") {
    console.warn(`[Ghost] ${pos.positionId}: vwapPosition=unknown, ghost NOT started — data incompleet voor EV`);
    return;
  }
  if (ghostTrackers[pos.positionId]) return;

  const { positionId, symbol, session, direction, vwapPosition,
          optimizerKey, entry, sl, slPct, tpRRUsed, openedAt } = pos;
  // FIX 10: mt5Symbol fallback
  const mt5Symbol = pos.mt5Symbol || getSymbolInfo(symbol)?.mt5 || symbol;

  // Restore maxPrice from persisted ghost_state if available (survives restarts)
  let maxPrice       = restoreData?.maxPrice  ?? entry;
  let maxSlPctUsed   = restoreData?.maxSlPctUsed ?? 0;
  let timer          = null;
  const startTs      = Date.now() - (restoreData ? (Date.now() - new Date(openedAt ?? 0).getTime()) : 0);
  const originalSL   = sl;
  const originalSlPct  = slPct;
  const originalTpRR   = tpRRUsed;
  let   lastStateSaveTs = Date.now();

  ghostTrackers[positionId] = {
    positionId, symbol, mt5Symbol, session, direction,
    vwapPosition, optimizerKey, entry,
    sl: originalSL,
    slPct: originalSlPct,
    tpRRUsed: originalTpRR,
    openedAt, maxPrice, maxSlPctUsed,
    maxRR: restoreData?.maxRR ?? 0,
    startTs, timer,
  };

  // Write initial state to DB (or update if restored)
  saveGhostState({ positionId, optimizerKey, symbol, mt5Symbol, session, direction,
    vwapPosition, entry, sl: originalSL, slPct: originalSlPct, tpRRUsed: originalTpRR,
    maxPrice, maxRR: restoreData?.maxRR ?? 0, maxSlPctUsed, openedAt }).catch(() => {});

  async function tick() {
    try {
      if (!ghostTrackers[positionId]) return;
      const g       = ghostTrackers[positionId];
      const elapsed = Date.now() - new Date(openedAt ?? startTs).getTime();
      if (elapsed >= GHOST_MAX_MS) { await finalizeGhost(positionId, "timeout_2w", elapsed, maxPrice); return; }
      const { day } = getBrusselsComponents();
      if (day === 0 || day === 6) {
        timer = setTimeout(tick, 10 * 60 * 1000);
        g.timer = timer;
        return;
      }

      const phantomSL = g.sl;  // fixed at trade-open, never changes

      const priceData = await fetchCurrentPrice(mt5Symbol);
      const price     = priceData?.mid ?? null;
      if (price !== null) {
        // Track max favorable movement
        const better = direction === "buy" ? price > maxPrice : price < maxPrice;
        if (better) {
          maxPrice = price;
          g.maxPrice = price;
          g.maxRR = calcMaxRR(direction, entry, phantomSL, price);
        }
        // Track max adverse excursion as % of SL (MAE)
        const slDist = Math.abs(entry - phantomSL);
        if (slDist > 0) {
          const adverse = direction === "buy" ? entry - price : price - entry;
          const slPctNow = parseFloat((Math.max(0, Math.min(100, (adverse / slDist) * 100)).toFixed(2)));
          if (slPctNow > maxSlPctUsed) {
            maxSlPctUsed = slPctNow;
            g.maxSlPctUsed = maxSlPctUsed;
          }
        }
        // Cap at 15RR — ghost has done its job at this point
        if (g.maxRR >= GHOST_MAX_RR) {
          await finalizeGhost(positionId, "max_rr_15", elapsed, maxPrice); return;
        }
        // Ghost is FULLY INDEPENDENT of the actual trade outcome.
        // It only stops when the PHANTOM SL (original entry SL) is hit.
        // Even if the real trade was closed at TP or manually, the ghost
        // keeps running until the phantom SL is touched — this gives the
        // true maxRR the market was willing to give for this setup.
        const slHit = direction === "buy" ? price <= phantomSL : price >= phantomSL;
        if (slHit) { await finalizeGhost(positionId, "phantom_sl", elapsed, maxPrice); return; }
      }

      // Persist ghost state every 5 minutes (not every tick — don't hammer DB)
      if (Date.now() - lastStateSaveTs > 5 * 60 * 1000) {
        saveGhostState({ positionId, optimizerKey, symbol, mt5Symbol, session, direction,
          vwapPosition, entry, sl: g.sl, slPct: originalSlPct, tpRRUsed: originalTpRR,
          maxPrice, maxRR: g.maxRR, maxSlPctUsed, openedAt }).catch(() => {});
        lastStateSaveTs = Date.now();
      }

      timer = setTimeout(tick, GHOST_POLL_MS);
      g.timer = timer;
    } catch (e) {
      console.warn(`[Ghost] ${positionId} tick error:`, e.message);
      const g = ghostTrackers[positionId];
      timer = setTimeout(tick, GHOST_POLL_MS * 2);
      if (g) g.timer = timer;
    }
  }
  // FIX 2: initiële delay van 3s vóór eerste tick.
  // MetaApi registreert de positie na placeOrder() met een lichte vertraging.
  // Zonder deze delay faalt de eerste SL/TP modify met HTTP 404 (positie niet gevonden).
  // 3s is ruim voldoende voor MetaApi om de positie in zijn systeem te hebben.
  const GHOST_INITIAL_DELAY_MS = 3000;
  timer = setTimeout(tick, GHOST_INITIAL_DELAY_MS);
  ghostTrackers[positionId].timer = timer;
  console.log(`[Ghost] Started: ${positionId} | ${optimizerKey} | sl=${sl} | eerste tick over ${GHOST_INITIAL_DELAY_MS}ms`);
}

async function finalizeGhost(positionId, stopReason, elapsedMs, finalMaxPrice) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];

  const finalSL       = g.sl;
  const maxRRBeforeSL = calcMaxRR(g.direction, g.entry, finalSL, finalMaxPrice);
  const timeToSLMin   = Math.round(elapsedMs / 60000);
  const phantomSLHit  = stopReason === "phantom_sl";

  const ghostRow = {
    positionId: g.positionId, symbol: g.symbol, session: g.session,
    direction: g.direction, vwapPosition: g.vwapPosition, optimizerKey: g.optimizerKey,
    entry: g.entry, sl: finalSL, slPct: g.slPct, phantomSL: finalSL, tpRRUsed: g.tpRRUsed,
    maxPrice: finalMaxPrice, maxRRBeforeSL, phantomSLHit, stopReason,
    timeToSLMin: phantomSLHit ? timeToSLMin : null,
    maxSlPctUsed: g.maxSlPctUsed ?? 0,
    openedAt: g.openedAt, closedAt: new Date().toISOString(),
  };

  await saveGhostTrade(ghostRow);
  await deleteGhostState(g.positionId).catch(() => {});
  // Rebuild EV cache in background — new ghost data is now available
  rebuildEVCache().catch(() => {});
  await updateTPLock(g.optimizerKey, g.symbol, g.session, g.direction, g.vwapPosition);
  await runShadowOptimizer(g.optimizerKey).catch(() => {});

  // FIX 6: If this ghost belongs to a manually-closed position, write trueMaxRR back to DB.
  const closedTrade = closedTrades.find(t => t.positionId === g.positionId);
  if (closedTrade && closedTrade.closeReason === "manual") {
    closedTrade.trueMaxRR    = maxRRBeforeSL;
    closedTrade.trueMaxPrice = finalMaxPrice;
    await saveTrade(closedTrade).catch(() => {});
    console.log(`[Ghost] ${positionId}: trueMaxRR=${maxRRBeforeSL}R written back (manual close)`);
  }

  console.log(`[Ghost] Finalized: ${positionId} | key=${g.optimizerKey} | sl=${finalSL} | maxRR=${maxRRBeforeSL}R | slHit=${phantomSLHit}`);
}

function cancelGhost(positionId) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];
}

// ── Band Ghost Tracker (Ghost 2.0) ───────────────────────────────
// Tracks VWAP-exhausted rejected signals to see what would have happened.
// Completely separate from ghostTrackers and main EV data.
// Stops at: phantom SL hit / 15RR / 2-week timeout.
const bandGhostTrackers = {};

function startBandGhostTracker(pos) {
  const id = `band_${pos.symbol}_${pos.session}_${pos.direction}_${Date.now()}`;
  if (!pos.sl || pos.sl <= 0 || !pos.entry) return;

  const { optimizerKey, symbol, mt5Symbol, session, direction, vwapPosition,
          bandTier, bandPct, entry, sl, slPct, openedAt, signalId } = pos;
  let maxPrice     = entry;
  let maxSlPctUsed = 0;
  let maxRR        = 0;
  let timer        = null;
  const startTs    = Date.now();

  bandGhostTrackers[id] = { id, optimizerKey, symbol, mt5Symbol, session, direction,
    vwapPosition, bandTier, bandPct, entry, sl, slPct, openedAt, signalId,
    maxPrice, maxRR, maxSlPctUsed, timer, startTs };

  async function tick() {
    try {
      const g = bandGhostTrackers[id];
      if (!g) return;
      const elapsed = Date.now() - startTs;
      if (elapsed >= GHOST_MAX_MS) {
        await finalizeBandGhost(id, "timeout_2w", elapsed, maxPrice); return;
      }
      const { day } = getBrusselsComponents();
      if (day === 0 || day === 6) { timer = setTimeout(tick, 10*60*1000); g.timer = timer; return; }

      const priceData = await fetchCurrentPrice(mt5Symbol ?? symbol);
      const price     = priceData?.mid ?? null;
      if (price !== null) {
        const better = direction === "buy" ? price > maxPrice : price < maxPrice;
        if (better) { maxPrice = price; g.maxPrice = price; g.maxRR = calcMaxRR(direction, entry, sl, price); maxRR = g.maxRR; }
        const slDist = Math.abs(entry - sl);
        if (slDist > 0) {
          const adv = direction === "buy" ? entry - price : price - entry;
          const pct = Math.max(0, Math.min(100, (adv / slDist) * 100));
          if (pct > maxSlPctUsed) { maxSlPctUsed = pct; g.maxSlPctUsed = pct; }
        }
        if (maxRR >= GHOST_MAX_RR) { await finalizeBandGhost(id, "max_rr_15", elapsed, maxPrice); return; }
        const slHit = direction === "buy" ? price <= sl : price >= sl;
        if (slHit) { await finalizeBandGhost(id, "phantom_sl", elapsed, maxPrice); return; }
      }
      timer = setTimeout(tick, GHOST_POLL_MS);
      g.timer = timer;
    } catch (e) {
      const g = bandGhostTrackers[id];
      timer = setTimeout(tick, GHOST_POLL_MS * 2);
      if (g) g.timer = timer;
    }
  }
  timer = setTimeout(tick, 3000);
  bandGhostTrackers[id].timer = timer;
  console.log(`[BandGhost] Started ${id} | ${bandTier} ${(bandPct*100).toFixed(0)}% | entry=${entry}`);
}

async function finalizeBandGhost(id, stopReason, elapsedMs, finalMaxPrice) {
  const g = bandGhostTrackers[id];
  if (!g) return;
  clearTimeout(g.timer);
  delete bandGhostTrackers[id];
  const finalMaxRR   = calcMaxRR(g.direction, g.entry, g.sl, finalMaxPrice);
  const timeToSLMin  = Math.round(elapsedMs / 60000);
  await saveBandGhost({
    signalId: g.signalId, optimizerKey: g.optimizerKey,
    symbol: g.symbol, session: g.session, direction: g.direction,
    vwapPosition: g.vwapPosition, bandTier: g.bandTier, bandPct: g.bandPct,
    entry: g.entry, sl: g.sl, slPct: g.slPct,
    maxPrice: finalMaxPrice, maxRR: finalMaxRR, maxSlPctUsed: g.maxSlPctUsed ?? 0,
    phantomSLHit: stopReason === "phantom_sl",
    stopReason, timeToSLMin: stopReason === "phantom_sl" ? timeToSLMin : null,
    openedAt: g.openedAt, closedAt: new Date().toISOString(),
  }).catch(() => {});
  console.log(`[BandGhost] Finalized ${id} | maxRR=${finalMaxRR}R | reason=${stopReason}`);
}

// ── SL Reduction Optimizer ────────────────────────────────────────
// Uses finalized ghost trades to analyse if SL can be tightened.
// Requires 30 ghosts. Sweeps SL from 10%→100% of original distance.
// At each level: ghosts where maxSlPctUsed > level survive (SL not hit early).
// Shows EV change + WR drop so you can make an informed cut decision.
async function runShadowOptimizer(optimizerKey) {
  try {
    const ghosts = await loadGhostTrades(optimizerKey, 2000);
    const valid  = ghosts.filter(g => g.phantomSLHit && (g.maxRRBeforeSL ?? 0) > 0 && g.maxSlPctUsed != null);
    const n      = valid.length;
    const MIN_GHOSTS = 30;
    if (n < MIN_GHOSTS) {
      shadowResults[optimizerKey] = { optimizerKey, n, ready: false,
        message: `Need ${MIN_GHOSTS - n} more ghosts (have ${n}/${MIN_GHOSTS})` };
      return;
    }
    const evData = await computeEVStats(optimizerKey);
    const baseEV = evData?.bestEV ?? null;
    const baseRR = evData?.bestRR ?? 2.0;
    const baseWR = baseRR ? valid.filter(g => g.maxRRBeforeSL >= baseRR).length / n : 0;

    const slPcts = valid.map(g => g.maxSlPctUsed).sort((a, b) => a - b);
    const pctile = (p) => slPcts[Math.min(n - 1, Math.floor(p / 100 * n))];
    const p50 = pctile(50), p75 = pctile(75), p90 = pctile(90), p99 = pctile(99);
    const maxUsed = slPcts[n - 1];

    // Sweep: at SL tightness X%, ghosts where maxSlPctUsed > X would have been stopped early
    // Those become losses at the tighter SL. Survivors: maxSlPctUsed <= X (never touched tighter SL)
    const levels = [];
    for (let sl = 10; sl <= 100; sl += 5) {
      const hitTighter  = valid.filter(g => g.maxSlPctUsed > sl).length; // stopped early by tighter SL
      const stillHitTP  = valid.filter(g => g.maxSlPctUsed <= sl && g.maxRRBeforeSL >= baseRR).length;
      const newWR       = (valid.filter(g => g.maxRRBeforeSL >= baseRR && g.maxSlPctUsed <= sl).length +
                           valid.filter(g => g.maxRRBeforeSL >= baseRR && g.maxSlPctUsed > sl).length * 0) / n;
      // Simpler: at tighter SL, any ghost that reached baseRR AND didn't get knocked out is a win
      const wins  = valid.filter(g => g.maxRRBeforeSL >= baseRR && g.maxSlPctUsed <= sl).length;
      const newWRfinal = wins / n;
      const newEV = parseFloat((newWRfinal * baseRR - (1 - newWRfinal)).toFixed(4));
      const wrDrop = parseFloat(((newWRfinal - baseWR) * 100).toFixed(1));
      levels.push({ sl, wins, hitTighter, newWR: parseFloat((newWRfinal * 100).toFixed(1)), newEV, wrDrop });
    }

    // Best reduction: tightest SL where EV > 0 and WR drops < 10 percentage points
    const safeLevels = levels.filter(l => l.newEV > 0 && l.wrDrop > -10.0);
    const recommendation = safeLevels.length
      ? { reduceTo: safeLevels[0].sl, saving: 100 - safeLevels[0].sl,
          newEV: safeLevels[0].newEV, newWR: safeLevels[0].newWR, wrDrop: safeLevels[0].wrDrop }
      : null;

    const analysis = {
      optimizerKey, n, ready: true,
      symbol: optimizerKey.split("_")[0], session: optimizerKey.split("_")[1] ?? "",
      direction: optimizerKey.split("_")[2] ?? "", vwapPosition: optimizerKey.split("_")[3] ?? "unknown",
      p50, p75, p90, p99, maxUsed, baseEV, baseRR, baseWR: parseFloat((baseWR * 100).toFixed(1)),
      levels, recommendation,
      message: recommendation
        ? `Reduce SL to ${recommendation.reduceTo}% — saves ${recommendation.saving}% width, EV ${recommendation.newEV > 0 ? "+" : ""}${recommendation.newEV}, WR ${recommendation.wrDrop}%`
        : "No safe SL reduction — keep current SL",
    };
    shadowResults[optimizerKey] = analysis;
    await saveShadowAnalysis(analysis);
    console.log(`[SL-Opt] ${optimizerKey}: n=${n} maxUsed=${maxUsed}% rec=${recommendation?.reduceTo ?? "none"}%`);
  } catch (e) { console.warn(`[SL-Opt] ${optimizerKey}:`, e.message); }
}

async function runAllShadowOptimizers() {
  const keys = new Set(Object.values(openPositions).map(p => p.optimizerKey).filter(Boolean));
  for (const key of Object.keys(shadowResults)) keys.add(key);
  for (const key of keys) await runShadowOptimizer(key).catch(() => {});
}

// ── Position sync (FIX 9: rate-limited, FIX 13: clear restore flag) ──
// ── Position sync ─────────────────────────────────────────────────
// Syncs price, PnL and close events from MT5 every ~55s.
async function syncOpenPositions() {
  const now = Date.now();
  if (now - lastSyncAt < SYNC_MIN_INTERVAL_MS) return;
  lastSyncAt = now;
  try {
    const live    = await fetchOpenPositions();
    const liveIds = new Set((Array.isArray(live) ? live : []).map(p => String(p.id)));
    for (const [id, pos] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) { await handlePositionClosed(pos); delete openPositions[id]; }
    }
    for (const livePos of (Array.isArray(live) ? live : [])) {
      const id    = String(livePos.id);
      const local = openPositions[id];
      if (!local) continue;
      const cur    = livePos.currentPrice ?? livePos.openPrice ?? local.entry;
      const better = local.direction === "buy" ? cur > (local.maxPrice ?? cur) : cur < (local.maxPrice ?? cur);
      if (better) { local.maxPrice = cur; local.maxRR = calcMaxRR(local.direction, local.entry, local.sl, cur); }
      local.currentPrice = cur;
      local.currentPnL   = livePos.unrealizedProfit ?? 0;
      local.lastSync     = new Date().toISOString();

      // FIX 13: clear restore flag after first live sync
      if (local.restoredAfterRestart) {
        local.restoredAfterRestart = false;
        console.log(`[Sync] ${id}: restoredAfterRestart cleared`);
      }
    }
    await fetchAccountInfo().catch(() => {});
  } catch (e) { console.warn("[Sync]", e.message); }
}

// ── handlePositionClosed (FIX 6: price-based closeReason, FIX 4: realPnl) ──
async function handlePositionClosed(pos) {
  const lastPrice = pos.currentPrice ?? pos.maxPrice ?? pos.entry;
  let closeReason;
  if (pos.tp != null) {
    const tpHit = pos.direction === "buy" ? lastPrice >= pos.tp : lastPrice <= pos.tp;
    if (tpHit) closeReason = "tp";
  }
  if (!closeReason && pos.sl > 0) {
    const slHit = pos.direction === "buy" ? lastPrice <= pos.sl : lastPrice >= pos.sl;
    if (slHit) closeReason = "sl";
  }
  if (!closeReason) closeReason = "manual";

  const hitTP = closeReason === "tp";
  const maxRR = pos.maxRR ?? calcMaxRR(pos.direction, pos.entry, pos.sl, pos.maxPrice ?? pos.entry);
  const now   = new Date().toISOString();

  // FIX 4: fetch actual realized P&L from MT5 for sl/tp; use currentPnL for manual
  let realizedPnl = pos.currentPnL ?? 0;
  if (closeReason !== "manual") {
    try {
      const fetched = await fetchRealizedPnl(pos.positionId);
      if (fetched != null) realizedPnl = fetched;
    } catch { /* fallback to currentPnL */ }
  }

  const closed = {
    ...pos, maxRR, hitTP, closeReason, closedAt: now,
    realizedPnlEUR: realizedPnl,
    spreadAtEntry:  pos.spread ?? null,
    vwapBandPct:    pos.vwapBandPct ?? null,
    // FIX 6: trueMaxRR filled later by ghost for manual closes
    trueMaxRR:   closeReason === "manual" ? null : maxRR,
    trueMaxPrice: closeReason === "manual" ? null : pos.maxPrice,
  };

  // FIX 16: cap array
  closedTrades.push(closed);
  if (closedTrades.length > MAX_CLOSED_TRADES) closedTrades.splice(0, closedTrades.length - MAX_CLOSED_TRADES);

  await saveTrade(closed).catch(() => {});
  await savePnlLog(pos.symbol, pos.session, pos.direction, pos.vwapPosition, maxRR, hitTP, realizedPnl).catch(() => {});
  logEvent({ type: "POSITION_CLOSED", symbol: pos.symbol, direction: pos.direction, maxRR, closeReason, realizedPnl });

  // FIX A: ghost continues after manual close
  if (closeReason === "manual") {
    console.log(`[Ghost] ${pos.positionId}: manual close — ghost continues (trueMaxRR will be written on finalize)`);
  }
  if (closeReason === "sl") {
    await recalcLotsAfterSL(pos.symbol, pos.entry, pos.sl).catch(() => {});
  }

  // FIX C: rebuild currency exposure na close van EV-neutrale forex positie
  const posInfo = getSymbolInfo(pos.symbol);
  if (posInfo?.type === "forex" && !(pos.evMult > 1.0)) {
    rebuildCurrencyExposure();
  }
}

// ── Restore positions from MT5 ────────────────────────────────────
// FIX 1: vwapPosition wordt geparsed uit de MT5 comment string.
// Comment formaat: "NV-B-XAUUSD-A-2R-LON" → vpShort 'A'=above, 'B'=below, 'U'=unknown.
// Fallback: "unknown" als comment ontbreekt of geen vpShort heeft.
function parseVwapFromComment(comment) {
  if (!comment) return "unknown";
  const parts = comment.split("-");
  if (parts.length < 3) return "unknown";
  // Nieuw formaat (v16+): NV-{dir}-{sym}-{sess}-{rr}-{vp} — vp is altijd LAATSTE onderdeel
  const last = parts[parts.length - 1];
  if (last === "A") return "above";
  // "B" kan de dir zijn (parts[1]) of de vp — check of het het laatste deel is EN niet ook parts[1]
  if (last === "B" && parts.length > 2) return "below";
  if (last === "U") return "unknown";
  // Oud formaat fallback: NV-{dir}-{sym}-{vp}-{rr}-{sess} — vp op parts[length-3]
  if (parts.length >= 5) {
    const vp = parts[parts.length - 3];
    if (vp === "A") return "above";
    if (vp === "B") return "below";
  }
  return "unknown";
}

async function restorePositionsFromMT5() {
  try {
    const live = await fetchOpenPositions();
    if (!Array.isArray(live) || !live.length) return;

    // Load persisted ghost states so maxPrice/maxSlPctUsed survive restarts
    const ghostStates = await loadAllGhostStates();
    const ghostStateMap = {};
    for (const gs of ghostStates) ghostStateMap[gs.positionId] = gs;

    let restored = 0;
    for (const lp of live) {
      const id = String(lp.id);
      if (openPositions[id]) continue;
      const sym    = normalizeSymbol(lp.symbol) ?? lp.symbol;
      const dir    = lp.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
      const entry  = lp.openPrice ?? lp.currentPrice ?? 0;
      const sess   = getSession(lp.time ? new Date(lp.time) : null);
      // Fix 13: ghost_state is de primaire bron voor vwapPosition — betrouwbaarder dan
      // het MT5 comment parsen. Comment is fallback voor posities zonder ghost_state.
      const gs = ghostStateMap[id] ?? null;
      const vpFromGhostState = gs?.vwapPosition;
      const vpFromComment    = parseVwapFromComment(lp.comment ?? lp.reason ?? "");
      const vpPos = (vpFromGhostState && vpFromGhostState !== "unknown")
        ? vpFromGhostState
        : vpFromComment;
      const optKey = buildOptimizerKey(sym, sess, dir, vpPos);
      openPositions[id] = {
        positionId: id, symbol: sym, mt5Symbol: lp.symbol,
        direction: dir, vwapPosition: vpPos, optimizerKey: optKey,
        entry, sl: lp.stopLoss ?? 0, tp: lp.takeProfit ?? null,
        lots: lp.volume ?? 0.01, riskEUR: 0, riskPct: FIXED_RISK_PCT,
        session: sess, openedAt: lp.time ?? new Date().toISOString(),
        maxPrice: entry, maxRR: 0, currentPnL: lp.unrealizedProfit ?? 0,
        slPct: null, restoredAfterRestart: true,
      };
      console.log(`[Restart] ${sym} (${id}): vwapPosition='${vpPos}' (comment='${lp.comment ?? ""}')`);
      if (openPositions[id].sl > 0) {
        // Pass persisted ghost state if available — preserves maxPrice across deploys
        const gs = ghostStateMap[id] ?? null;
        if (gs) console.log(`[Restart] Ghost ${sym} (${id}): restoring maxPrice=${gs.maxPrice} maxRR=${gs.maxRR}R maxSlPct=${gs.maxSlPctUsed}%`);
        startGhostTracker(openPositions[id], gs);
      }
      restored++;
    }

    // Clean up ghost_state rows for positions no longer open on MT5
    const liveIds = new Set(live.map(p => String(p.id)));
    for (const gs of ghostStates) {
      if (!liveIds.has(gs.positionId)) {
        await deleteGhostState(gs.positionId).catch(() => {});
        console.log(`[Restart] Cleaned stale ghost_state for ${gs.positionId}`);
      }
    }

    console.log(`[Restart] ${restored} position(s) restored from MT5`);
  } catch (e) { console.warn("[Restart]", e.message); }
}

// ── Shadow snapshot cron ──────────────────────────────────────────
// Takes a snapshot of each open position's SL% used every cron tick.
async function takeShadowSnapshots() {
  const positions = Object.values(openPositions).filter(p => p.sl > 0 && !p.restoredAfterRestart);
  for (const pos of positions) {
    try {
      const mt5Sym = pos.mt5Symbol || getSymbolInfo(pos.symbol)?.mt5 || pos.symbol;
      const pd = await fetchCurrentPrice(mt5Sym);
      if (!pd) continue;
      const liveSL  = pos.sl;
      const pct     = calcPctSlUsed(pos.direction, pos.entry, liveSL, pd.mid);
      await saveShadowSnapshot({
        positionId: pos.positionId, optimizerKey: pos.optimizerKey,
        symbol: pos.symbol, session: pos.session, direction: pos.direction,
        vwapPosition: pos.vwapPosition, entry: pos.entry,
        sl: liveSL,   // actuele SL, niet originele
        currentPrice: pd.mid, pctSlUsed: pct,
      });
    } catch (e) { /* non-critical */ }
  }
}

// ── Daily risk evaluation (FIX 7+11 + v10.6 mult correctie) ─────
async function evaluateDailyRisk() {
  try {
    const todayStr = getBrusselsDateOnly();
    const todayT   = closedTrades.filter(t =>
      t.closedAt &&
      getBrusselsDateOnly(t.closedAt) === todayStr &&
      new Date(t.closedAt).getTime() >= COMPLIANCE_DATE_MS &&
      (t.vwapPosition === "above" || t.vwapPosition === "below")
    );
    // FIX 7: use realizedPnlEUR
    const totalPnl = todayT.reduce((s, t) => s + (t.realizedPnlEUR ?? t.currentPnL ?? 0), 0);

    const keyGroups = {};
    for (const t of todayT) {
      const k = t.optimizerKey ?? buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown");
      if (!keyGroups[k]) keyGroups[k] = { pnl: 0, count: 0 };
      keyGroups[k].pnl   += t.realizedPnlEUR ?? t.currentPnL ?? 0;
      keyGroups[k].count += 1;
    }

    // FIX 11: evaluate ALL known keys — reset streak for those without trades today
    const allKeys = new Set([...Object.keys(keyRiskMult), ...Object.keys(tpLocks), ...Object.keys(keyGroups)]);

    for (const key of allKeys) {
      const data         = keyGroups[key];
      const ev           = await computeEVStats(key);
      const isEvPositive = (ev?.bestEV ?? 0) > 0;
      const hasSample    = (ev?.count  ?? 0) >= MULT_MIN_SAMPLE;
      const isDayPositive = (data?.pnl ?? 0) > 0;
      const hadTrades     = !!data;

      const prev = keyRiskMult[key] ?? { streak: 0, evMult: 1.0, dayMult: 1.0 };

      if (hadTrades && isEvPositive && hasSample && isDayPositive) {
        // v10.6 MULT CORRECTIE:
        //   evMult  → uitsluitend bepaald door EV kwaliteit (max ×4), groeit via EV score.
        //   dayMult → groeit ×1.2 per positieve dag (cumulatief streak).
        // Beide multipliers werken uitsluitend op LOTS, NIET op riskEUR.
        const evScore    = ev.bestEV ?? 0;
        const newEvMult  = Math.min(4.0, parseFloat((1.0 + evScore * 10).toFixed(4))); // EV-gedreven
        const newDayMult = Math.min(2.0, parseFloat((prev.dayMult * 1.2).toFixed(4)));
        keyRiskMult[key] = { streak: prev.streak + 1, evMult: newEvMult, dayMult: newDayMult };
        await saveKeyRiskMult(key, keyRiskMult[key]).catch(() => {});
        console.log(`[DailyRisk] ${key}: day+ → evMult=${newEvMult.toFixed(2)}× dayMult=${newDayMult.toFixed(2)}×`);
      } else {
        keyRiskMult[key] = { streak: 0, evMult: 1.0, dayMult: 1.0 };
        await saveKeyRiskMult(key, keyRiskMult[key]).catch(() => {});
        if ((prev.dayMult ?? 1.0) > 1.0 || (prev.evMult ?? 1.0) > 1.0) {
          console.log(`[DailyRisk] ${key}: reset → ×1.0 (hadTrades=${hadTrades}, evPos=${isEvPositive}, dayPos=${isDayPositive})`);
        }
      }
    }

    await saveDailyRisk(todayStr, totalPnl, todayT.length, 1.0, 1.0);
  } catch (e) { console.warn("[DailyRisk]", e.message); }
}

// ── CRON JOBS ─────────────────────────────────────────────────────
cron.schedule("*/1 * * * *", async () => { await syncOpenPositions().catch(() => {}); }, { timezone: "Europe/Brussels" });
cron.schedule("*/1 * * * *", async () => { await takeShadowSnapshots().catch(() => {}); }, { timezone: "Europe/Brussels" });

// FIX 20: dupGuard cleanup every 5 min
cron.schedule("*/5 * * * *", () => {
  const cutoff = Date.now() - DUP_GUARD_TTL_MS;
  for (const [k, ts] of Object.entries(global._dupGuard)) { if (ts < cutoff) delete global._dupGuard[k]; }
}, { timezone: "Europe/Brussels" });

cron.schedule("0 3 * * 1-5", async () => {
  console.log("🌙 03:00 — Nightly optimizer...");
  const keys = new Set([
    ...closedTrades.map(t => buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown")),
    ...Object.keys(shadowResults),
  ]);
  // FIX F: skip keys with active ghosts
  const activeGhostKeys = new Set(Object.values(ghostTrackers).map(g => g.optimizerKey).filter(Boolean));
  let updated = 0, skipped = 0;
  for (const key of keys) {
    const parts = key.split("_");
    if (parts.length < 4) continue;
    if (activeGhostKeys.has(key)) { skipped++; continue; }
    const [sym, sess, dir, vp] = parts;
    await updateTPLock(key, sym, sess, dir, vp).catch(() => {});
    await runShadowOptimizer(key).catch(() => {});
    updated++;
  }
  await runAllShadowOptimizers().catch(() => {});
  console.log(`[OK] Nightly optimizer done — ${updated} keys updated, ${skipped} skipped (active ghosts)`);
  logEvent({ type: "NIGHTLY_OPTIMIZER", keys: keys.size, updated, skipped });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 2 * * 1-5", async () => {
  console.log("🔄 02:00 — daily reset...");
  await evaluateDailyRisk().catch(() => {});
  await restorePositionsFromMT5().catch(() => {});
  logEvent({ type: "DAILY_RESET", keyMultipliers: Object.keys(keyRiskMult).length });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 4 * * 1-5", async () => {
  const cutoff = Date.now() - GHOST_MAX_MS;
  let cleaned = 0;
  for (const [id, g] of Object.entries(ghostTrackers)) {
    if (g.startTs < cutoff) {
      clearTimeout(g.timer);
      await saveGhostTrade({
        positionId: g.positionId, symbol: g.symbol, session: g.session,
        direction: g.direction, vwapPosition: g.vwapPosition,
        optimizerKey: g.optimizerKey, entry: g.entry, sl: g.sl, slPct: g.slPct,
        phantomSL: g.sl, tpRRUsed: g.tpRRUsed,
        maxPrice: g.maxPrice, maxRRBeforeSL: calcMaxRR(g.direction, g.entry, g.sl, g.maxPrice),
        phantomSLHit: false, stopReason: "timeout_72h",
        timeToSLMin: null, openedAt: g.openedAt, closedAt: new Date().toISOString(),
      }).catch(() => {});
      delete ghostTrackers[id];
      cleaned++;
    }
  }
  if (cleaned > 0) { console.log(`[04:00] ${cleaned} ghost(s) cleaned up`); logEvent({ type: "GHOST_CLEANUP_72H", count: cleaned }); }
}, { timezone: "Europe/Brussels" });


// ── Detailed reject logger ────────────────────────────────────────
// Prints timestamp, symbol, reject reason, and ALL relevant payload values
// at every reject path so Railway logs have full context for debugging.
function logReject(label, { symbol, direction, session, optimizerKey, reason, payload = {} } = {}) {
  const ts = new Date().toISOString();
  console.log(`[REJECT][${ts}] ──────────────────────────────────────────`);
  console.log(`  Label    : ${label}`);
  console.log(`  Symbol   : ${symbol ?? '?'}`);
  console.log(`  Direction: ${direction ?? '?'}`);
  console.log(`  Session  : ${session ?? '?'}`);
  console.log(`  OptKey   : ${optimizerKey ?? '?'}`);
  console.log(`  Reason   : ${reason}`);
  if (Object.keys(payload).length) {
    console.log(`  Payload  :`);
    for (const [k, v] of Object.entries(payload)) {
      console.log(`    ${String(k).padEnd(22)}: ${v}`);
    }
  }
  console.log(`[REJECT] ────────────────────────────────────────────────`);
}

// ── Webhook handler ───────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const webhookReceivedAt = Date.now();

  // ── Debug log: elke inkomende webhook request zichtbaar in Railway logs ──
  console.log(`[WebhookIN][${new Date().toISOString()}] ─────────────────────────`);
  console.log(`  Method       : ${req.method}`);
  console.log(`  Content-Type : ${req.headers["content-type"] ?? "(geen)"}`);
  console.log(`  Body type    : ${typeof req.body}`);
  console.log(`  Body preview : ${JSON.stringify(req.body)?.slice(0, 300) ?? "(leeg)"}`);
  console.log(`  Query secret : ${req.query.secret ? "aanwezig" : "(geen query secret)"}`);
  console.log(`[WebhookIN] ─────────────────────────────────────────────────────`);

  const secret = req.query.secret || req.body?.secret;
  if (secret !== WEBHOOK_SECRET) {
    console.warn(`[WebhookIN] 401 UNAUTHORIZED — secret mismatch. Query: "${req.query.secret ?? "(geen)"}" Body.secret: "${req.body?.secret ?? "(geen)"}"`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const { action, symbol: rawSymbol, vwap, vwap_upper, vwap_lower } = body;

  // session_high / session_low kunnen NaN zijn vanuit TradingView Pine Script.
  // Sanitize: NaN → null zodat ze nooit DB of log vervuilen.
  const rawSessionHigh = parseFloat(body.session_high);
  const rawSessionLow  = parseFloat(body.session_low);
  const sessionHigh = isNaN(rawSessionHigh) ? null : rawSessionHigh;
  const sessionLow  = isNaN(rawSessionLow)  ? null : rawSessionLow;

  // TV stuurt entry + sl (absolute prijzen) + sl_pct (genegeerd).
  // Server berekent derivedSlPct zelf: |entry - sl| / entry
  // Pine Script hoeft NIETS te wijzigen.
  const tvEntry = parseFloat(body.entry ?? body.entry_price) || 0;
  const tvSL    = parseFloat(body.sl    ?? body.sl_price)    || 0;

  const direction = action === "buy" ? "buy" : action === "sell" ? "sell" : null;
  if (!direction) return res.status(400).json({ error: "action must be buy or sell" });

  const symKey  = normalizeSymbol(rawSymbol);
  const symInfo = symKey ? getSymbolInfo(symKey) : null;
  if (!symKey || !symInfo) {
    const _r1 = `Symbol not in catalog: ${rawSymbol}`;
    logReject("SYMBOL_NOT_IN_CATALOG", { symbol: rawSymbol, direction, reason: _r1, payload: {
      rawSymbol, action, tvEntry, tvSL,
      sessionHigh, sessionLow,
    }});
    logEvent({ type: "REJECTED", reason: _r1 });
    await logSignal({ symbol: rawSymbol, direction, outcome: "REJECTED", rejectReason: _r1 }).catch(() => {});
    return res.status(400).json({ error: `Symbol not allowed: ${rawSymbol}` });
  }
  const { type: assetType, mt5: mt5Symbol } = symInfo;

  // Server berekent derivedSlPct — sl_pct van TV volledig genegeerd.
  const derivedSlPct = deriveSLPct(tvEntry, tvSL);
  if (!derivedSlPct || derivedSlPct <= 0 || derivedSlPct > 0.05) {
    const slPctHuman = derivedSlPct ? (derivedSlPct * 100).toFixed(3) + "%" : "invalid";
    const reason = `SL_INVALID: derivedSlPct=${slPctHuman} (entry=${tvEntry}, sl=${tvSL}). Moet > 0 en <= 5%.`;
    logReject("SL_INVALID", { symbol: symKey, direction, reason, payload: {
      tvEntry, tvSL, derivedSlPct: derivedSlPct ?? "null",
      slPctHuman, assetType, mt5Symbol,
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "REJECTED", reason, symbol: symKey, direction });
    await logSignal({ symbol: symKey, direction, tvEntry, slPct: derivedSlPct ?? null, outcome: "REJECTED", rejectReason: reason }).catch(() => {});
    return res.status(400).json({ error: reason });
  }
  const slPctHuman = (derivedSlPct * 100).toFixed(3) + "%";

  const session     = getSession();
  const closePrice  = tvEntry;
  const vwapMid      = parseFloat(vwap)       || 0;
  const vwapUpper    = parseFloat(vwap_upper) || 0;
  const vwapLower    = parseFloat(vwap_lower) || 0;
  const vwapPosition = getVwapPosition(closePrice, vwapMid);
  const optimizerKey = buildOptimizerKey(symKey, session, direction, vwapPosition);

  // VWAP band exhaustion filter
  let vwapBandPct = null;
  const bandWidth = vwapUpper - vwapLower;

  // Fix 9: Als vwapMid aanwezig is maar bandWidth = 0 → VWAP data ontbreekt.
  // Vroeger werd de check overgeslagen, waardoor trades zonder VWAP band altijd doorkwamen.
  // Risico: Pine Script stuurt soms 0 voor band waarden bij herinitialisatie.
  if (vwapMid > 0 && bandWidth <= 0) {
    const reason = "VWAP_BAND_MISSING: vwap_upper/lower zijn 0 of ontbreken — mogelijk indicator niet geïnitialiseerd";
    logReject("VWAP_BAND_MISSING", { symbol: symKey, direction, reason, payload: { vwapMid, vwapUpper, vwapLower } });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct: null, outcome: "REJECTED", rejectReason: reason }).catch(() => {});
    return res.status(200).json({ status: "VWAP_BAND_MISSING", vwapMid, vwapUpper, vwapLower });
  }

  if (bandWidth > 0 && vwapMid > 0) {
    const distFromMid = Math.abs(closePrice - vwapMid);
    vwapBandPct = parseFloat((distFromMid / (bandWidth / 2)).toFixed(3));
    if (vwapBandPct > 1.5) {
      const reason = `VWAP_BAND_EXHAUSTED: ${(vwapBandPct * 100).toFixed(0)}% into band`;
      logReject("VWAP_BAND_EXHAUSTED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        closePrice, vwapMid, vwapUpper, vwapLower,
        vwapBandPct: (vwapBandPct * 100).toFixed(1) + "%",
        vwapPosition, derivedSlPct: slPctHuman,
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "REJECTED", reason, symbol: symKey, direction, optimizerKey, vwapBandPct });
      const signalLogRow = await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "REJECTED", rejectReason: reason }).catch(() => null);

      // ── Ghost 2.0: start a band ghost for this rejected signal ──────
      const pct = vwapBandPct;
      const bandTier = pct >= 2.5 ? "250_350" : "150_250";
      if (pct < 3.5) {
        const tempSLForBand   = calcSLFromDerivedPct(direction, closePrice, derivedSlPct);
        const enforcedSLBand  = enforceMinStop(mt5Symbol, direction, closePrice, tempSLForBand);
        startBandGhostTracker({
          signalId:      signalLogRow?.id ?? null,
          optimizerKey, symbol: symKey, mt5Symbol, session, direction, vwapPosition,
          bandTier, bandPct: pct,
          entry: closePrice, sl: enforcedSLBand, slPct: derivedSlPct,
          openedAt: new Date().toISOString(),
        });
      }
      return res.status(200).json({ status: "VWAP_BAND_EXHAUSTED", vwapBandPct });
    }
  }

  // Trade window check
  const tradeWindow = canOpenNewTrade(symKey);
  if (!tradeWindow.allowed) {
    logReject("OUTSIDE_TRADE_WINDOW", { symbol: symKey, direction, session, optimizerKey, reason: tradeWindow.reason, payload: {
      assetType, closePrice, derivedSlPct: slPctHuman,
      vwapPosition, vwapBandPct: vwapBandPct ?? "n/a",
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "REJECTED", reason: tradeWindow.reason, symbol: symKey, direction, assetType });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "OUTSIDE_WINDOW", rejectReason: tradeWindow.reason }).catch(() => {});
    return res.status(200).json({ status: "OUTSIDE_TRADE_WINDOW", reason: tradeWindow.reason, assetType });
  }

  // Duplicate guard
  const dupKey  = `${symKey}_${direction}`;
  const dupLast = global._dupGuard?.[dupKey];
  if (dupLast && (Date.now() - dupLast) < DUP_GUARD_TTL_MS) {
    const _dupAge = Math.round((Date.now() - dupLast) / 1000);
    logReject("DUPLICATE_BLOCKED", { symbol: symKey, direction, session, optimizerKey, reason: `Duplicate within TTL (${_dupAge}s ago, TTL=${DUP_GUARD_TTL_MS/1000}s)`, payload: {
      dupKey, dupAgeSeconds: _dupAge, ttlSeconds: DUP_GUARD_TTL_MS / 1000,
      closePrice, derivedSlPct: slPctHuman,
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "DUPLICATE_BLOCKED", symbol: symKey, direction, optimizerKey });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "DUPLICATE_BLOCKED" }).catch(() => {});
    return res.status(200).json({ status: "DUPLICATE_BLOCKED" });
  }
  global._dupGuard[dupKey] = Date.now();

  // ── Anti-consolidation ────────────────────────────────────────────
  // MetaApi REST ondersteunt geen positie modify (SL/TP aanpassen na open).
  // Enige optie: blokkeren als zelfde symbol+richting al open staat.
  // Ongeacht sessie — een open trade leeft over sessies heen.
  {
    const sameCount = countSameDirection(symKey, direction);
    if (sameCount >= MAX_SAME_DIRECTION) {
      const existing = Object.values(openPositions).find(p => p.symbol === symKey && p.direction === direction);
      const reason = `DUPLICATE_BLOCKED: ${symKey} ${direction} al open (pos=${existing?.positionId} sess=${existing?.session}) — MetaApi ondersteunt geen SL modify`;
      logReject("DUPLICATE_BLOCKED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        existingPositionId: existing?.positionId, existingSession: existing?.session,
        existingEntry: existing?.entry, existingOpenedAt: existing?.openedAt,
        closePrice, derivedSlPct: slPctHuman,
      }});
      logEvent({ type: "DUPLICATE_BLOCKED", symbol: symKey, direction, session, optimizerKey,
        existingPositionId: existing?.positionId });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey,
        tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct,
        outcome: "DUPLICATE_BLOCKED", rejectReason: reason }).catch(() => {});
      return res.status(200).json({ status: "DUPLICATE_BLOCKED", reason,
        existingPositionId: existing?.positionId });
    }
  }

  // ── Risk & lots ───────────────────────────────────────────────────
  // v10.6 MULT CORRECTIE:
  //   riskEUR = balance × pct (puur, geen evMult).
  //   EV+ (evMult > 1.0): finalLots = baseLots × evMult × dayMult.
  //     → tellen NIET mee in currency budget.
  //   EV neutraal (evMult = 1.0): finalLots = baseLots × scaleFactor.
  //     → tellen WEL mee in currency budget.
  const riskPct  = getSymbolRiskPct(symKey);
  const evMult   = getKeyEvMult(optimizerKey);
  const dayMult  = getKeyDayMult(optimizerKey);
  const isEvPlus = evMult > 1.0;

  // Puur riskEUR — geen multipliers
  const riskEUR  = await calcRiskEUR(symKey);
  const balance  = await getLiveBalance();

  // FIX R4 (v11.0): lotDivisor anti-consolidation VERWIJDERD.
  // Was bedoeld voor currency correlatie maar zorgde voor inconsistente
  // lotgroottes per pair. Uniform 0.15% risk per trade ongeacht correlatie.
  const lotDivisor = 1; // altijd 1 — geen divisie meer

  // FIX R1 (v11.0): DEFAULT_TP_RR=2.0R bij geen data, EV lock zodra ≥5 ghosts
  const tpRR    = await getOptimalTP(optimizerKey);
  const rrLabel = tpRR % 1 === 0 ? `${tpRR}R` : `${tpRR.toFixed(1)}R`;

  // Voorlopige SL voor lot berekening (op closePrice) — lotVal wordt live bijgewerkt
  // FIX DAX: enforceMinStop wordt NU ook op tempSL toegepast zodat lots berekend worden
  // op dezelfde SL-afstand die straks naar MT5 gaat. Zonder dit: bij een krappe TV SL
  // (bijv. 2pt DAX) rekende calcLots op 2pt, maar MT5 SL werd 10pt → werkelijk risk 5×
  // hoger dan bedoeld. Nu is tempSL altijd ≥ minStop afstand, consistente lot sizing.
  const tempSLRaw = calcSLFromDerivedPct(direction, closePrice || 1, derivedSlPct);
  const tempSL    = enforceMinStop(mt5Symbol, direction, closePrice || 1, tempSLRaw);
  const symInfoL = getSymbolInfo(symKey);
  let   lotVal   = LOT_VALUE[symInfoL?.type || "stock"] ?? 1; // fallback, overschreven door live MT5 spec
  const tempDist = Math.abs((closePrice || 1) - tempSL);

  let lots;
  if (lotOverrides[symKey]) {
    // Lot override: baseLots × evMult × dayMult (of ×1 voor neutraal)
    const base = lotOverrides[symKey];
    lots = isEvPlus
      ? parseFloat((base * evMult * dayMult).toFixed(2))
      : parseFloat((base).toFixed(2));
    console.log(`[Lots] ${symKey}: override=${base} evMult=${evMult.toFixed(2)} dayMult=${dayMult.toFixed(2)} = ${lots}`);
  } else {
    // Live lotVal van MT5 spec — gecached na eerste keer
    const calcResult = await calcLots(symKey, mt5Symbol, assetType, closePrice || 1, tempSL, riskEUR, evMult, dayMult);
    lots = calcResult.lots;
    lotVal = calcResult.lotVal; // update lotVal met live waarde voor currency budget check
    console.log(`[Lots] ${symKey}: ${calcResult.source} lotVal=${lotVal} baseLots→${lots}`);
  }

  // FIX C: currency exposure budget check (alleen voor EV neutraal + forex)
  let scaleFactor = 1.0;
  if (!isEvPlus && assetType === "forex") {
    scaleFactor = await calcCurrencyScaleFactor(symKey, lots, tempDist, lotVal);
    if (scaleFactor <= 0) {
      const reason = `CURRENCY_BUDGET_EXHAUSTED: ${symKey} — beide valuta's op budget ceiling`;
      logReject("CURRENCY_BUDGET_EXHAUSTED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        lots, tempDist, lotVal, scaleFactor: 0,
        evMult, isEvPlus, assetType,
        currencies: getPairCurrencies(symKey).join("/"),
        currentExposure: JSON.stringify(Object.fromEntries(getPairCurrencies(symKey).map(c => [c, (currencyExposure[c] ?? 0).toFixed(2)]))),
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "REJECTED", reason, symbol: symKey, direction, optimizerKey, evMult, scaleFactor: 0 });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "CURRENCY_BUDGET_EXHAUSTED", rejectReason: reason }).catch(() => {});
      return res.status(200).json({ status: "CURRENCY_BUDGET_EXHAUSTED", reason });
    }
    if (scaleFactor < 1.0) {
      lots = Math.max(0.01, parseFloat((lots * scaleFactor).toFixed(2)));
      console.log(`[CurrBudget] ${symKey}: scaleFactor=${scaleFactor.toFixed(3)} → lots=${lots}`);
      logEvent({ type: "LOTS_SCALED_CURRENCY_BUDGET", symbol: symKey, direction, scaleFactor, lots });
    }
  }

  if (!lots || lots <= 0) {
    logReject("LOT_CALC_FAILED", { symbol: symKey, direction, session, optimizerKey, reason: "calcLots returned 0 or undefined", payload: {
      lots, lotVal, riskEUR: riskEUR?.toFixed(2), tempDist, closePrice,
      derivedSlPct: slPctHuman, assetType, mt5Symbol,
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "REJECTED", reason: "calcLots returned 0", symbol: symKey, direction });
    return res.status(200).json({ status: "LOT_CALC_FAILED" });
  }

  // Step A: Place market order
  const sessShort = session === "london" ? "LON" : session === "ny" ? "NY" : "AS";
  const dirShort  = direction === "buy" ? "B" : "S";
  const vpShort   = vwapPosition === "above" ? "A" : vwapPosition === "below" ? "B" : "U";
  // Fix 1: vpShort staat ALTIJD als laatste karakter — parseVwapFromComment leest last char.
  // Geen .slice(0,26) meer — decimale RR in midden (bijv "1.5R") telt extra "-" mee als
  // scheidingsteken waardoor de positie van vpShort onbetrouwbaar werd.
  // Nieuw formaat: NV-{dir}-{sym}-{sess}-{rr}-{vp}  → vpShort altijd op positie -1
  const comment = `NV-${dirShort}-${symKey.slice(0, 8)}-${sessShort}-${rrLabel}-${vpShort}`;
  // Resultaat: NV-B-USDCHF-A-2R-LON (buy, above VWAP, london)
  //            NV-S-XAUUSD-B-2R-LON (sell, below VWAP, london)
  // Fix 1: Haal live MT5 prijs op VOOR de order.
  // TV entry + TV SL → derivedSlPct al bekend. Nu: live MT5 bid/ask ophalen,
  // zelfde % eraf/erbij zetten voor SL (×1.5 buffer), TP berekenen op die prijs.
  // Alles meegestuurd in de orderPayload — geen aparte modify nodig als fallback.
  let preBid = null, preAsk = null, preSpread = 0;
  let preExecPrice = closePrice; // fallback op TV entry als MT5 niet bereikbaar
  try {
    const prePd = await fetchCurrentPrice(mt5Symbol);
    if (prePd) {
      preBid    = prePd.bid;
      preAsk    = prePd.ask;
      preSpread = prePd.spread ?? 0;
      // Gebruik bid voor sell, ask voor buy — dit is de realistische executieprijs
      preExecPrice = direction === "buy"
        ? (prePd.ask ?? prePd.mid ?? closePrice)
        : (prePd.bid ?? prePd.mid ?? closePrice);
      console.log(`[PreOrder] ${mt5Symbol}: bid=${preBid} ask=${preAsk} spread=${preSpread} → preExec=${preExecPrice}`);
    }
  } catch (e) {
    console.warn(`[PreOrder] fetchCurrentPrice failed (${e.message}) — fallback op TV entry ${closePrice}`);
  }

  // Bereken SL/TP op live MT5 prijs vóór de order
  // derivedSlPct = |tvEntry - tvSL| / tvEntry (al berekend bovenaan)
  // Zelfde % op MT5 live prijs toepassen, met ×1.5 buffer
  const preMt5SL = enforceMinStop(mt5Symbol, direction,
    preExecPrice, calcSLFromDerivedPct(direction, preExecPrice, derivedSlPct));
  const preMt5TP = applyTPFloorGuard(direction, preExecPrice, preMt5SL,
    calcTPPrice(direction, preExecPrice, preMt5SL, tpRR));
  console.log(`[PreOrder] SL=${preMt5SL} TP=${preMt5TP} (${tpRR}R) op preExec=${preExecPrice} | derivedSlPct=${slPctHuman}`);

  const orderPayload = {
    symbol: mt5Symbol,
    actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    volume: lots, comment,
    stopLoss:   preMt5SL,  // Fix 1: direct in order — werkt ook als modify later faalt
    takeProfit: preMt5TP,  // Fix 1: direct in order
  };

  let result, positionId;
  try {
    result     = await placeOrder(orderPayload);
    positionId = String(result?.positionId ?? result?.orderId ?? `local_${Date.now()}`);
  } catch (e) {
    const errMsg = e.message;
    const latencyMs = Date.now() - webhookReceivedAt;
    logEvent({ type: "ERROR", symbol: symKey, direction, reason: errMsg, optimizerKey });
    await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition, action, status: "ERROR", reason: errMsg, optimizerKey, entry: closePrice, sl: null, tp: null, lots, riskPct, latencyMs, tvEntry: closePrice, vwapBandPct });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "ORDER_FAILED", rejectReason: errMsg, latencyMs }).catch(() => {});
    return res.status(200).json({ status: "ORDER_FAILED", error: errMsg });
  }

  // Step B: Read back real execution price
  // Pre-order SL/TP al actief in MT5. Nu verfijnen op werkelijke fill prijs.
  let executionPrice = preExecPrice; // start van live MT5 prijs, niet TV entry
  let spread = preSpread, bid = preBid, ask = preAsk;
  try {
    await new Promise(r => setTimeout(r, 2500));
    const positions = await fetchOpenPositions();

    // FIX C1 (v11.3): local_ positionId guard.
    // Als MetaApi geen positionId gaf na placeOrder() → fake ID gegenereerd.
    // Zoek de echte positie op basis van symbol + richting + recent geopend (<30s).
    if (positionId.startsWith("local_")) {
      const nowMs   = Date.now();
      const matched = Array.isArray(positions)
        ? positions.find(p =>
            p.symbol === mt5Symbol &&
            (direction === "buy"
              ? p.type === "POSITION_TYPE_BUY"
              : p.type === "POSITION_TYPE_SELL") &&
            (p.time ? nowMs - new Date(p.time).getTime() < 30000 : true)
          )
        : null;
      if (matched) {
        console.log(`[Order] local_ ID opgelost → echte positionId=${matched.id} (${mt5Symbol} ${direction})`);
        positionId = String(matched.id);
      } else {
        // Positie bestaat niet op MT5 — niet opslaan in DB
        const errMsg = `ORDER_NOT_CONFIRMED: geen positionId van MetaApi en positie niet gevonden op MT5 (${mt5Symbol} ${direction})`;
        console.warn(`[Order] ${errMsg}`);
        logEvent({ type: "ERROR", symbol: symKey, direction, reason: errMsg, optimizerKey });
        await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition, action,
          status: "ORDER_NOT_CONFIRMED", reason: errMsg, optimizerKey,
          entry: closePrice, sl: null, tp: null, lots, riskPct,
          latencyMs: Date.now() - webhookReceivedAt, tvEntry: closePrice, vwapBandPct });
        await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey,
          tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct,
          outcome: "ORDER_NOT_CONFIRMED", rejectReason: errMsg,
          latencyMs: Date.now() - webhookReceivedAt }).catch(() => {});
        return res.status(200).json({ status: "ORDER_NOT_CONFIRMED", error: errMsg });
      }
    }

    const realPos = Array.isArray(positions) ? positions.find(p => String(p.id) === positionId) : null;
    if (realPos?.openPrice) executionPrice = parseFloat(realPos.openPrice);
    // Refresh spread na fill
    const pd = await fetchCurrentPrice(mt5Symbol);
    if (pd) { bid = pd.bid; ask = pd.ask; spread = pd.spread ?? 0; }
  } catch { /* pre-order waarden blijven actief als fallback */ }

  const slippage = parseFloat((executionPrice - closePrice).toFixed(5));

  // v10.7 FIX 3: Spread opslaan in spread_log voor tijdzone analyse
  if (bid != null && ask != null) {
    const spreadAbs = parseFloat((ask - bid).toFixed(8));
    const spreadPct = bid > 0 ? parseFloat((spreadAbs / bid * 100).toFixed(6)) : null;
    const { hour, minute, day } = getBrusselsComponents();
    saveSpreadLog({
      symbol: symKey, mt5Symbol, session,
      hourBrussels: hour, minuteBrussels: minute, dayOfWeek: day,
      bid, ask, spreadAbs, spreadPct, assetType, positionId,
    }).catch(() => {});
  }

  // FIX 5: spread guard uses buffered SL distance
  if (assetType === "stock" && spread > 0) {
    const guardSLDist = Math.abs(executionPrice - calcSLFromDerivedPct(direction, executionPrice, derivedSlPct));
    if (guardSLDist > 0 && spread > 0.25 * guardSLDist) {
      const reason = `SPREAD_GUARD: spread ${spread.toFixed(5)} > 25% of buffered SL dist ${guardSLDist.toFixed(5)}`;
      logReject("SPREAD_GUARD_CLOSE", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        positionId, spread: spread.toFixed(5), guardSLDist: guardSLDist.toFixed(5),
        spreadPct: (spread / guardSLDist * 100).toFixed(1) + "% of SL dist",
        executionPrice, lots, assetType,
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "SPREAD_GUARD_CLOSE", symbol: symKey, direction, positionId, spread, slDist: guardSLDist, reason });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "SPREAD_GUARD_CLOSE", rejectReason: reason }).catch(() => {});
      try { await closePosition(positionId); } catch {}
      return res.status(200).json({ status: "SPREAD_GUARD_CLOSE", reason, positionId });
    }
  }

  // Step C: FIX A — SL berekening op executionPrice met derivedSlPct × 1.5 buffer.
  // derivedSlPct komt van server (TV absolute prijzen), NIET van TV payload.
  let mt5SL = calcSLFromDerivedPct(direction, executionPrice, derivedSlPct);
  mt5SL     = enforceMinStop(mt5Symbol, direction, executionPrice, mt5SL);

  // Fix 6: Log the full SL conversion chain for audit
  {
    const slDist = Math.abs(executionPrice - mt5SL);
    const slPctActual = executionPrice > 0 ? (slDist / executionPrice * 100).toFixed(4) : "?";
    console.log(`[SL-CHAIN] ${symKey} ${direction}: TV entry=${closePrice} TV SL=${tvSL ?? "n/a"} → slPct=${(derivedSlPct*100).toFixed(4)}% → MT5 exec=${executionPrice} → MT5 SL=${mt5SL} (dist=${slDist.toFixed(5)} = ${slPctActual}%)`);
  }

  // Step C2: Recalculate lots op executionPrice (als geen override) — nu met live lotVal
  // FIX R5 (v11.0): lotDivisor verwijderd — uniform risk per trade.
  if (!lotOverrides[symKey]) {
    const calcResult2 = await calcLots(symKey, mt5Symbol, assetType, executionPrice, mt5SL, riskEUR, evMult, dayMult);
    lots   = calcResult2.lots;
    lotVal = calcResult2.lotVal; // live lotVal na executie (spec al gecached)
    // FIX C: herbereken scaleFactor op echte dist met live lotVal (alleen forex EV-neutraal)
    if (!isEvPlus && assetType === "forex") {
      const realDist = Math.abs(executionPrice - mt5SL);
      scaleFactor = await calcCurrencyScaleFactor(symKey, lots, realDist, lotVal);
      if (scaleFactor <= 0) {
        try { await closePosition(positionId); } catch {}
        const reason = `CURRENCY_BUDGET_EXHAUSTED post-execution: ${symKey}`;
        logEvent({ type: "CURRENCY_BUDGET_EXHAUSTED_POSTEXEC", symbol: symKey, direction, positionId, reason });
        return res.status(200).json({ status: "CURRENCY_BUDGET_EXHAUSTED", reason, positionId });
      }
      if (scaleFactor < 1.0) {
        lots = Math.max(0.01, parseFloat((lots * scaleFactor).toFixed(2)));
      }
    }
  }

  // Step D: TP berekening
  let mt5TP = calcTPPrice(direction, executionPrice, mt5SL, tpRR);

  // FIX D: TP Floor Guard — vóór order naar MT5
  const mt5TPBeforeFloor = mt5TP;
  mt5TP = applyTPFloorGuard(direction, executionPrice, mt5SL, mt5TP);
  if (mt5TP !== mt5TPBeforeFloor) {
    logEvent({ type: "TP_FLOOR_APPLIED", symbol: symKey, direction, positionId,
      tpBefore: mt5TPBeforeFloor, tpAfter: mt5TP, executionPrice, mt5SL });
  }
  // Fix 6: Log final TP placement
  {
    const slDist = Math.abs(executionPrice - mt5SL);
    const tpDist = Math.abs(mt5TP - executionPrice);
    const rrActual = slDist > 0 ? (tpDist / slDist).toFixed(3) : "?";
    console.log(`[TP-CHAIN] ${symKey} ${direction}: MT5 TP=${mt5TP} → actual RR=${rrActual}R (target=${tpRR}R) lots=${lots}`);
  }

  // FIX E: RR Verificatie met werkelijke MT5 waarden
  const rrCheck = verifyRR(direction, executionPrice, mt5SL, mt5TP);
  if (rrCheck.slWrongSide) {
    // Emergency close + ghost tracker start (Optie A)
    console.error(`[RR_VERIFY_FAILED] ${positionId}: SL op VERKEERDE KANT! exec=${executionPrice} sl=${mt5SL} dir=${direction}`);
    logReject("RR_VERIFY_FAILED", { symbol: symKey, direction, session, optimizerKey, reason: `SL on wrong side: exec=${executionPrice} sl=${mt5SL}`, payload: {
      positionId, executionPrice, mt5SL, mt5TP, direction,
      actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR,
      derivedSlPct: slPctHuman, lots, riskEUR: riskEUR?.toFixed(2),
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({
      type: "RR_VERIFY_FAILED", positionId, symbol: symKey, direction,
      executionPrice, mt5SL, mt5TP,
      actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR,
    });
    // Sluit positie
    try { await closePosition(positionId); } catch (ce) {
      console.error(`[RR_VERIFY_FAILED] closePosition ${positionId} mislukt: ${ce.message}`);
    }
    // Register gesloten trade met excludeFromEV flag
    const failedTrade = {
      positionId, symbol: symKey, mt5Symbol, direction, vwapPosition,
      optimizerKey, entry: executionPrice, sl: mt5SL, tp: mt5TP,
      lots, riskEUR, riskPct, evMult, dayMult, balance,
      session, openedAt: new Date().toISOString(), closedAt: new Date().toISOString(),
      closeReason: "RR_VERIFY_FAILED", excludeFromEV: true,
      maxRR: 0, hitTP: false, realizedPnlEUR: 0,
      tvEntry: closePrice, executionPrice, slippage, vwapBandPct,
      spread, derivedSlPct,
    };
    closedTrades.push(failedTrade);
    if (closedTrades.length > MAX_CLOSED_TRADES) closedTrades.splice(0, closedTrades.length - MAX_CLOSED_TRADES);
    await saveTrade(failedTrade).catch(() => {});
    // Start ghost tracker zodat MAE + trueMaxRR bijgehouden worden
    openPositions[positionId] = { ...failedTrade, maxPrice: executionPrice, currentPnL: 0 };
    startGhostTracker(openPositions[positionId]);
    // Positie direct verwijderen uit openPositions (al gesloten)
    delete openPositions[positionId];
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, outcome: "RR_VERIFY_FAILED", latencyMs: Date.now() - webhookReceivedAt, positionId }).catch(() => {});
    return res.status(200).json({ status: "RR_VERIFY_FAILED", positionId, executionPrice, mt5SL, mt5TP });
  }

  // FIX E: log-only checks (niet blokkeren)
  if (rrCheck.slTooWide) {
    logEvent({ type: "SL_TOO_WIDE", positionId, symbol: symKey, actualSLPct: rrCheck.actualSLPct });
    console.warn(`[SL_TOO_WIDE] ${positionId}: actualSLPct=${(rrCheck.actualSLPct * 100).toFixed(3)}%`);
  }
  if (rrCheck.tpRRTooLow) {
    logEvent({ type: "TP_RR_TOO_LOW", positionId, symbol: symKey, actualTPRR: rrCheck.actualTPRR });
    console.warn(`[TP_RR_TOO_LOW] ${positionId}: actualTPRR=${rrCheck.actualTPRR}R`);
  }

  // Step D: Verfijn SL + TP op werkelijke executionPrice — retry 3×
  // Pre-order SL/TP (preMt5SL/preMt5TP) zijn al actief als fallback in MT5.
  let slTpSet = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await metaFetch(`/positions/${positionId}`, { method: "PUT", body: JSON.stringify({ stopLoss: mt5SL, takeProfit: mt5TP }) }, 8000);
      console.log(`[SL/TP] ✓ ${positionId} → SL=${mt5SL} TP=${mt5TP} (${tpRR}R) exec=${executionPrice} attempt=${attempt}`);
      if (preMt5SL !== mt5SL || preMt5TP !== mt5TP) {
        console.log(`[SL/TP] Verfijnd t.o.v. pre-order: SL ${preMt5SL}→${mt5SL} TP ${preMt5TP}→${mt5TP} (slippage=${slippage})`);
      }
      slTpSet = true; break;
    } catch (e) {
      console.warn(`[SL/TP] attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  if (!slTpSet) {
    // Pre-order SL/TP (preMt5SL/preMt5TP) zijn nog steeds actief in MT5 — trade heeft SL/TP
    console.warn(`[SL/TP] Modify mislukt na 3 pogingen — pre-order SL=${preMt5SL} TP=${preMt5TP} blijft actief`);
    logEvent({ type: "SL_TP_MODIFY_FAILED_USING_PRE", positionId, symbol: symKey,
      preSL: preMt5SL, preTP: preMt5TP, refinedSL: mt5SL, refinedTP: mt5TP,
      executionPrice, slippage, note: "pre-order SL/TP actief als fallback" });
    // Gebruik pre-order waarden zodat openPositions correct is
    mt5SL = preMt5SL;
    mt5TP = preMt5TP;
  }

  // Register position
  const latencyMs = Date.now() - webhookReceivedAt;
  const now = new Date().toISOString();
  openPositions[positionId] = {
    positionId, symbol: symKey, mt5Symbol, direction, vwapPosition,
    optimizerKey, entry: executionPrice, sl: mt5SL, tp: mt5TP, slPct: derivedSlPct,
    lots, riskEUR, riskPct, evMult, dayMult, balance,
    spread, bid, ask, session, openedAt: now,
    maxPrice: executionPrice, maxRR: 0, currentPnL: 0,
    vwapAtEntry: vwapMid, tpRRUsed: tpRR,
    tvEntry: closePrice, executionPrice, slippage, vwapBandPct, slPctHuman,
    lotDivisor, isEvPlus, scaleFactor, derivedSlPct,
  };

  // FIX C: currency exposure bijwerken voor EV-neutrale forex trades
  if (!isEvPlus && assetType === "forex") {
    rebuildCurrencyExposure();
  }

  startGhostTracker(openPositions[positionId]);

  // FIX E: ORDER_PLACED log uitgebreid met derivedSlPct, actualSLPct, actualTPRR
  logEvent({
    type: "ORDER_PLACED", symbol: symKey, direction, session, vwapPosition, optimizerKey,
    executionPrice, slippage, sl: mt5SL, tp: mt5TP, tpRR, rrLabel,
    lots, riskPct, riskEUR: riskEUR.toFixed(2), evMult, dayMult, lotDivisor,
    spread: spread.toFixed(5), bid, ask, balance: balance.toFixed(2),
    positionId, comment, derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, latencyMs,
    actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR,
    isEvPlus, scaleFactor,
    tpFloorApplied: mt5TP !== mt5TPBeforeFloor,
  });

  await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition, action, status: "PLACED", positionId, optimizerKey, entry: executionPrice, sl: mt5SL, tp: mt5TP, lots, riskPct, latencyMs, tvEntry: closePrice, executionPrice, slippage, vwapBandPct });
  await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "PLACED", latencyMs, positionId }).catch(() => {});

  console.log(`[✓] ${direction.toUpperCase()} ${symKey} | key=${optimizerKey} | exec=${executionPrice} | sl=${mt5SL} tp=${mt5TP} (${rrLabel}) | lots=${lots} | riskEUR=€${riskEUR.toFixed(2)} evMult=×${evMult.toFixed(2)} dayMult=×${dayMult.toFixed(2)} derivedSlPct=${slPctHuman} | latency=${latencyMs}ms`);

  return res.status(200).json({
    status: "PLACED", positionId, symbol: symKey, direction,
    executionPrice, slippage, sl: mt5SL, tp: mt5TP, tpRR, rrLabel,
    lots, riskPct, riskEUR, evMult, dayMult, lotDivisor, optimizerKey,
    spread, bid, ask, balance, latencyMs, derivedSlPct, slPctHuman, vwapBandPct,
    actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR, isEvPlus, scaleFactor,
  });
});

// ── REST API ──────────────────────────────────────────────────────
app.get("/live/positions", async (req, res) => {
  const balance = await getLiveBalance();
  const positions = Object.values(openPositions).map(p => {
    // ── Werkelijke EUR exposure (eerlijk) ─────────────────────────
    // riskEUR in het object is de PUUR berekende basis (balance × pct).
    // Door evMult en dayMult wordt de werkelijke positiegrootte groter,
    // waardoor ook de werkelijke exposure groter is.
    const info      = getSymbolInfo(p.symbol);
    const type      = info?.type || "stock";
    const mt5SymL   = info?.mt5 || p.mt5Symbol || p.symbol;
    // FIX R3 (v11.0): gebruik live symbolSpecCache voor correcte lotVal.
    // Statische LOT_VALUE[index]=20 is FOUT voor indexes (echte waarde ≈0.85).
    // symbolSpecCache bevat de live MT5 spec opgehaald bij startup + eerste trade.
    const cachedSpecL = symbolSpecCache[mt5SymL];
    const lotVal    = cachedSpecL?.lotVal ?? LOT_VALUE[type] ?? 1;
    const slDist    = p.sl > 0 ? Math.abs(p.entry - p.sl) : 0;
    // actualRiskEUR = werkelijke verlies bij SL hit (lots × slDist × lotVal)
    const actualRiskEUR = slDist > 0 ? parseFloat((p.lots * slDist * lotVal).toFixed(2)) : null;
    // actualRiskPct = actualRiskEUR als % van balance
    const actualRiskPct = actualRiskEUR && balance > 0
      ? parseFloat((actualRiskEUR / balance * 100).toFixed(4)) : null;
    // SL distance % op basis van huidige MT5 SL (live, niet origineel)
    const slDistPct = p.sl && p.entry
      ? parseFloat((Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(3)) : null;
    // TP RR op basis van huidige MT5 SL/TP (live)
    const tpRRActual = p.tp && p.sl && p.entry && slDist > 0
      ? parseFloat((Math.abs(p.tp - p.entry) / slDist).toFixed(3)) : null;

    return {
      positionId: p.positionId, symbol: p.symbol, direction: p.direction,
      session: p.session, vwapPosition: p.vwapPosition, optimizerKey: p.optimizerKey,
      entry: p.entry, sl: p.sl, tp: p.tp, lots: p.lots,
      riskPct: p.riskPct,
      riskEUR: p.riskEUR,          // basis puur (balance × pct)
      actualRiskEUR,               // werkelijk bij SL: lots × dist × lotVal
      actualRiskPct,               // werkelijk % van balance
      evMult: p.evMult ?? 1.0, dayMult: p.dayMult ?? 1.0,
      spread: p.spread ?? 0, bid: p.bid, ask: p.ask,
      currentPrice: p.currentPrice, currentPnL: p.currentPnL,
      maxRR: p.maxRR, tpRR: p.tpRRUsed,
      tpRRActual,                  // live TP RR op basis van huidige MT5 SL
      openedAt: p.openedAt, balance: p.balance,
      slDistPct,
      slPctUsed: p.currentPrice ? calcPctSlUsed(p.direction, p.entry, p.sl, p.currentPrice) : null,
      isGhosted: !!ghostTrackers[p.positionId],
      lotDivisor: p.lotDivisor ?? 1,
      isEvPlus: p.isEvPlus ?? false,
      scaleFactor: p.scaleFactor ?? 1.0,
    };
  });
  res.json({ count: positions.length, balance, positions });
});

app.get("/live/ghosts", (req, res) => {
  const ghosts = Object.values(ghostTrackers).map(g => {
    const livePos  = openPositions[g.positionId];
    const liveSL   = livePos?.sl ?? g.sl;
    const livePrice = livePos?.currentPrice ?? g.maxPrice;
    return {
      positionId: g.positionId, symbol: g.symbol, optimizerKey: g.optimizerKey,
      direction: g.direction, session: g.session, vwapPosition: g.vwapPosition,
      entry: g.entry, sl: liveSL, maxPrice: g.maxPrice,
      phantomSL: liveSL,
      maxRR: calcMaxRR(g.direction, g.entry, liveSL, g.maxPrice),
      tpRRUsed: g.tpRRUsed,
      elapsedMin: Math.round((Date.now() - g.startTs) / 60000),
      openedAt: g.openedAt,
      slPctUsed: liveSL && g.entry && livePrice
        ? calcPctSlUsed(g.direction, g.entry, liveSL, livePrice) : 0,
    };
  });
  res.json({ count: ghosts.length, ghosts });
});

// ── POST /admin/ghosts/cancel-all ─────────────────────────────────
// Annuleert alle actieve ghost trackers zonder ze op te slaan in de DB.
// Gebruik dit na manueel sluiten van alle trades voor een schone herstart.
// Vereist: ?secret=WEBHOOK_SECRET (zelfde als webhook secret).
app.post("/admin/ghosts/cancel-all", (req, res) => {
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized — geef ?secret= mee" });
  }
  const ids      = Object.keys(ghostTrackers);
  const count    = ids.length;
  if (count === 0) {
    return res.json({ status: "OK", cancelled: 0, message: "Geen actieve ghosts." });
  }
  for (const id of ids) {
    cancelGhost(id);
  }
  console.log(`[Admin] /admin/ghosts/cancel-all: ${count} ghost(s) geannuleerd`);
  logEvent({ type: "ADMIN_GHOSTS_CANCELLED", count, ids });
  res.json({ status: "OK", cancelled: count, ids, message: `${count} ghost(s) geannuleerd (niet opgeslagen in DB).` });
});

// ── PRE-DEPLOY: finalize all active ghosts with reason "manual_deploy" ──
// This saves their maxRR data to DB before a restart wipes memory.
// Use via the dashboard PREPARE DEPLOY button or directly with curl.
app.post("/admin/finalize-all-ghosts", async (req, res) => {
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const ids = Object.keys(ghostTrackers);
  if (!ids.length) return res.json({ status: "OK", finalized: 0, message: "No active ghosts." });
  const results = [];
  for (const id of ids) {
    const g = ghostTrackers[id];
    if (!g) continue;
    const elapsed = Date.now() - new Date(g.openedAt ?? g.startTs ?? 0).getTime();
    try {
      await finalizeGhost(id, "manual_deploy", elapsed, g.maxPrice ?? g.entry);
      results.push({ id, symbol: g.symbol, maxRR: g.maxRR ?? 0, status: "finalized" });
    } catch (e) {
      results.push({ id, symbol: g.symbol, status: "error", error: e.message });
    }
  }
  console.log(`[Admin] finalize-all-ghosts: ${results.length} ghost(s) finalized for deploy`);
  logEvent({ type: "ADMIN_GHOSTS_FINALIZED_DEPLOY", count: results.length });
  res.json({ status: "OK", finalized: results.length, results });
});

// ── PRE-DEPLOY: close all open MT5 positions ──────────────────────────
app.post("/admin/close-all-positions", async (req, res) => {
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const positions = Object.values(openPositions);
  if (!positions.length) return res.json({ status: "OK", closed: 0, message: "No open positions." });
  const results = [];
  for (const pos of positions) {
    try {
      await metaFetch(`/positions/${pos.positionId}`, { method: "DELETE" }, 8000);
      results.push({ positionId: pos.positionId, symbol: pos.symbol, status: "closed" });
      console.log(`[Admin] Closed position ${pos.positionId} (${pos.symbol})`);
    } catch (e) {
      results.push({ positionId: pos.positionId, symbol: pos.symbol, status: "error", error: e.message });
    }
  }
  logEvent({ type: "ADMIN_POSITIONS_CLOSED_DEPLOY", count: results.filter(r => r.status === "closed").length });
  res.json({ status: "OK", closed: results.filter(r => r.status === "closed").length, results });
});

// ── GET /admin/deploy-status — check if safe to deploy ───────────────
app.get("/admin/deploy-status", (req, res) => {
  const openCount  = Object.keys(openPositions).length;
  const ghostCount = Object.keys(ghostTrackers).length;
  const { day, hhmm } = getBrusselsComponents();
  const outsideWindow = day === 0 || day === 6 || hhmm < 200 || hhmm >= 2100;
  res.json({
    safeToDeployNow: openCount === 0 && ghostCount === 0,
    outsideMarketWindow: outsideWindow,
    openPositions: openCount,
    activeGhosts: ghostCount,
    recommendation: openCount === 0 && ghostCount === 0
      ? "✓ Safe to deploy — no open positions or active ghosts"
      : openCount > 0
        ? `⚠ Close ${openCount} open position(s) first, then finalize ${ghostCount} ghost(s)`
        : `⚠ Finalize ${ghostCount} active ghost(s) before deploy`,
  });
});

app.get("/ghosts/history", async (req, res) => {
  const { key, limit = 100 } = req.query;
  const rows = await loadGhostTrades(key || null, parseInt(limit));
  res.json({ count: rows.length, rows });
});

// EV cache — rebuilt after each ghost finalizes and on demand
// Prevents the dashboard from timing out on 500+ serial DB queries
const evCache = { data: [], lastBuilt: 0, building: false };
const EV_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min stale-while-revalidate

async function rebuildEVCache() {
  if (evCache.building) return;
  evCache.building = true;
  try {
    const { SYMBOL_CATALOG } = require("./session");
    const sessions = { stock: ["ny"], forex: ["asia","london","ny"], index: ["asia","london","ny"], commodity: ["asia","london","ny"] };
    const allKeys = new Set([...Object.keys(tpLocks)]);
    for (const [sym, info] of Object.entries(SYMBOL_CATALOG)) {
      for (const sess of (sessions[info.type] ?? ["london"])) {
        for (const dir of ["buy","sell"]) {
          for (const vwap of ["above","below"]) {
            allKeys.add(`${sym}_${sess}_${dir}_${vwap}`);
          }
        }
      }
    }
    closedTrades.forEach(t => {
      const k = buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown");
      allKeys.add(k);
    });

    // Fix 12: Haal ook alle optimizer_keys op uit ghost_trades DB — onafhankelijk van
    // closedTrades in-memory array. Als closedTrades boven MAX_CLOSED_TRADES gaat worden
    // oude trades verwijderd maar hun ghost data is nog in de DB aanwezig.
    try {
      const { pool } = require("./db");
      const r = await pool.query(`SELECT DISTINCT optimizer_key FROM ghost_trades WHERE optimizer_key IS NOT NULL AND optimizer_key != ''`);
      r.rows.forEach(row => allKeys.add(row.optimizer_key));
    } catch (e) {
      console.warn("[EV Cache] ghost_trades key scan failed:", e.message);
    }

    const keyArr = [...allKeys];
    const results = [];
    // Process in chunks of 20 concurrent DB queries — avoids pool exhaustion
    const CHUNK = 20;
    for (let i = 0; i < keyArr.length; i += CHUNK) {
      const chunk = keyArr.slice(i, i + CHUNK);
      const evs   = await Promise.all(chunk.map(k => computeEVStats(k).catch(() => null)));
      for (let j = 0; j < chunk.length; j++) {
        const ev = evs[j];
        results.push(ev && ev.count > 0
          ? { key: chunk[j], ...ev }
          : { key: chunk[j], count: 0, bestRR: null, bestEV: null, avgRR: null, avgTimeToSLMin: null, avgMaxSlPct: null, bestWinnerSlPct: null });
      }
    }
    results.sort((a, b) => (b.bestEV ?? -99) - (a.bestEV ?? -99));
    evCache.data      = results;
    evCache.lastBuilt = Date.now();
    console.log(`[EV Cache] rebuilt: ${results.filter(r => r.count > 0).length} combos with data / ${results.length} total`);
  } catch (e) {
    console.warn("[EV Cache] rebuild failed:", e.message);
  } finally {
    evCache.building = false;
  }
}

app.get("/ev/:key", async (req, res) => {
  const ev = await computeEVStats(decodeURIComponent(req.params.key));
  res.json(ev);
});

app.get("/ev", (req, res) => {
  // ALTIJD onmiddellijk antwoorden — nooit wachten op cache rebuild.
  // Als cache leeg is: stuur lege array + header zodat dashboard weet dat het bezig is.
  const age = Date.now() - evCache.lastBuilt;
  if (!evCache.building && (age > EV_CACHE_TTL_MS || evCache.data.length === 0)) {
    rebuildEVCache().catch(() => {});  // altijd fire-and-forget
  }
  res.setHeader("X-Cache-Status", evCache.data.length === 0 ? "building" : "ready");
  res.setHeader("X-Cache-Age-Ms", String(age));
  res.json(evCache.data);  // [] als nog leeg — dashboard herlaadt na 5s
});

// GET /ev/status — dashboard pollt dit om te weten wanneer cache klaar is
app.get("/ev/status", (req, res) => {
  res.json({
    ready:      evCache.data.length > 0,
    building:   evCache.building,
    count:      evCache.data.length,
    withData:   evCache.data.filter(r => r.count > 0).length,
    lastBuiltMs: evCache.lastBuilt,
    ageMs:      Date.now() - evCache.lastBuilt,
  });
});

app.get("/shadow", (req, res) => {
  const results = Object.values(shadowResults).sort((a, b) => a.optimizerKey.localeCompare(b.optimizerKey));
  res.json({ count: results.length, results });
});

// GET /shadow/sl-warning
// Returns open positions that have hit 50%, 75%, or 90%+ of their SL distance.
// For each, compares to the SL distribution from ghost data for that combo:
// if the current SL% used exceeds p75 of historical MAE for winners on that combo,
// it means the trade is behaving like a loser — early close consideration flag.
app.get("/shadow/sl-warning", async (req, res) => {
  const warnings = [];
  for (const pos of Object.values(openPositions)) {
    if (!pos.sl || !pos.entry || !pos.currentPrice) continue;
    const slDist  = Math.abs(pos.entry - pos.sl);
    if (!slDist) continue;
    const adverse = pos.direction === "buy"
      ? pos.entry - pos.currentPrice
      : pos.currentPrice - pos.entry;
    const slPctNow = Math.max(0, Math.min(100, (adverse / slDist) * 100));

    // Thresholds: 50% / 75% / 90% of SL used
    const tier = slPctNow >= 90 ? 3 : slPctNow >= 75 ? 2 : slPctNow >= 50 ? 1 : 0;
    if (tier === 0) continue;

    // Compare to ghost data for this combo
    const sr = shadowResults[pos.optimizerKey];
    let historicalContext = null;
    if (sr?.ready && sr.p75 != null) {
      // If current SL% used > p75 of ALL ghosts → most ghosts didn't go this deep
      const beyondP75 = slPctNow > sr.p75;
      const beyondP90 = slPctNow > sr.p90;
      historicalContext = {
        p50: sr.p50, p75: sr.p75, p90: sr.p90, maxUsed: sr.maxUsed,
        beyondP75, beyondP90,
        signal: beyondP90
          ? "STRONG: deeper than 90% of historical moves — consider closing"
          : beyondP75
            ? "MODERATE: deeper than 75% of historical moves — watch closely"
            : "NORMAL: within typical range",
      };
    }

    warnings.push({
      positionId:  pos.positionId,
      symbol:      pos.symbol,
      direction:   pos.direction,
      session:     pos.session,
      vwapPosition: pos.vwapPosition,
      optimizerKey: pos.optimizerKey,
      entry:       pos.entry,
      sl:          pos.sl,
      currentPrice: pos.currentPrice,
      slPctUsed:   parseFloat(slPctNow.toFixed(1)),
      tier,         // 1=50%+ 2=75%+ 3=90%+
      tierLabel:   tier === 3 ? "90%+ — DANGER" : tier === 2 ? "75%+" : "50%+",
      currentPnL:  pos.currentPnL ?? 0,
      historicalContext,
    });
  }
  warnings.sort((a, b) => b.slPctUsed - a.slPctUsed);
  res.json({ count: warnings.length, warnings });
});

app.get("/shadow/winners", async (req, res) => {
  const data = await loadShadowWinners();
  const rows = Object.entries(data).map(([key, v]) => ({ optimizerKey: key, ...v }));
  rows.sort((a, b) => a.optimizerKey.localeCompare(b.optimizerKey));
  res.json({ count: rows.length, winners: rows });
});

app.get("/shadow/:key", async (req, res) => {
  const key   = decodeURIComponent(req.params.key);
  const local = shadowResults[key];
  if (local) return res.json(local);
  const rows = await loadShadowAnalysis(key);
  res.json(rows[0] ?? { error: "No data yet for this key" });
});

app.get("/tp-locks", (req, res) => {
  const entries = Object.entries(tpLocks).map(([key, v]) => ({ key, ...v }));
  entries.sort((a, b) => (b.evAtLock ?? 0) - (a.evAtLock ?? 0));
  res.json(entries);
});

app.get("/risk-config", async (req, res) => {
  const balance = await getLiveBalance();
  const config = Object.keys(SYMBOL_CATALOG).map(sym => ({
    symbol:  sym, type: SYMBOL_CATALOG[sym].type,
    riskPct: getSymbolRiskPct(sym),
    riskEUR: parseFloat((getSymbolRiskPct(sym) * balance).toFixed(2)),
    evMult:  getKeyEvMult(sym), dayMult: getKeyDayMult(sym),
    envVar:  `RISK_${sym}`, lotOverride: lotOverrides[sym] ?? null,
  }));
  res.json({ balance, fixedRiskPct: FIXED_RISK_PCT, config });
});

// FIX 15: return full MAX_HISTORY (200), not just 100
app.get("/history", (req, res) => { res.json(webhookLog); });

// FIX 17: default limit 5000
app.get("/trades", (req, res) => {
  const { symbol, session, direction, vwap_pos, limit = 5000 } = req.query;
  let filtered = closedTrades;
  if (symbol)    filtered = filtered.filter(t => t.symbol === symbol);
  if (session)   filtered = filtered.filter(t => t.session === session);
  if (direction) filtered = filtered.filter(t => t.direction === direction);
  if (vwap_pos)  filtered = filtered.filter(t => t.vwapPosition === vwap_pos);
  res.json({ count: filtered.length, trades: filtered.slice(0, parseInt(limit)) });
});

app.get("/lot-overrides", (req, res) => {
  const entries = Object.entries(lotOverrides).map(([sym, lots]) => ({
    symbol: sym, lots, envVar: `LOTS_${sym}`,
    riskPct: getSymbolRiskPct(sym),
    note: "Loaded from DB — persists across restarts",
  }));
  res.json({ count: entries.length, overrides: entries });
});

app.get("/risk-multipliers", (req, res) => {
  const entries = Object.entries(keyRiskMult).map(([key, v]) => ({ key, ...v }));
  entries.sort((a, b) => (b.evMult ?? 1) - (a.evMult ?? 1));
  res.json({ fixedRiskPct: FIXED_RISK_PCT, multipliers: entries });
});

app.get("/signal-stats", async (req, res) => {
  const stats = await loadSignalStats();
  if (!stats) return res.status(500).json({ error: "Could not compute signal stats" });
  res.json(stats);
});

// GET /stats — dashboard KPI totals
app.get("/stats", (req, res) => {
  res.json({
    totalClosedTrades: closedTrades.length,
    totalOpenPositions: Object.keys(openPositions).length,
    totalActiveGhosts: Object.keys(ghostTrackers).length,
  });
});

// ── Spread statistieken (v10.7 Fix 3) ────────────────────────────
// GET /spread-stats?symbol=EURUSD&session=london&hourMin=8&hourMax=16&dayOfWeek=1
app.get("/spread-stats", async (req, res) => {
  const { symbol, session, hourMin, hourMax, dayOfWeek } = req.query;
  const stats = await loadSpreadStats({
    symbol:    symbol    || undefined,
    session:   session   || undefined,
    hourMin:   hourMin   != null ? parseInt(hourMin)   : undefined,
    hourMax:   hourMax   != null ? parseInt(hourMax)   : undefined,
    dayOfWeek: dayOfWeek != null ? parseInt(dayOfWeek) : undefined,
  });
  res.json({ count: stats.length, stats });
});

// GET /spread-log?symbol=EURUSD&session=london&limit=200
app.get("/spread-log", async (req, res) => {
  const { symbol, session, limit = 200 } = req.query;
  const rows = await loadSpreadLog({ symbol, session, limit: parseInt(limit) });
  res.json({ count: rows.length, rows });
});

// GET /vwap-band-signals?minPct=150&maxPct=250&limit=200
// Returns rejected signals from signal_log where vwap_band_pct is in [minPct, maxPct].
// Used by the dashboard VWAP Band Ghost tab to evaluate whether widening the band makes sense.
app.get("/vwap-band-signals", async (req, res) => {
  const minPct  = parseFloat(req.query.minPct  ?? 1.5);  // ratio (not %)
  const maxPct  = parseFloat(req.query.maxPct  ?? 2.5);
  const limit   = parseInt(req.query.limit    ?? 300);
  try {
    const { pool } = require("./db");
    const r = await pool.query(`
      SELECT symbol, direction, session, vwap_position, optimizer_key,
             tv_entry, sl_pct_human, vwap_band_pct, outcome, reject_reason, received_at
      FROM signal_log
      WHERE vwap_band_pct >= $1 AND vwap_band_pct < $2
        AND outcome IN ('REJECTED','VWAP_BAND_EXHAUSTED')
      ORDER BY received_at DESC
      LIMIT $3
    `, [minPct, maxPct, limit]);
    res.json({ count: r.rows.length, rows: r.rows, minPct, maxPct });
  } catch (e) {
    res.json({ count: 0, rows: [], error: e.message });
  }
});

// GET /vwap-band-signals — raw rejected signals for dashboard band tabs
// GET /band-ghosts?tier=150_250&limit=200 — finalized band ghost trades
app.get("/band-ghosts", async (req, res) => {
  const { tier, symbol, limit = 200 } = req.query;
  const rows = await loadBandGhosts({ bandTier: tier, symbol, limit: parseInt(limit) });
  res.json({ count: rows.length, rows });
});

// GET /band-ghost-stats?tier=150_250 — aggregated stats per combo for EV preview
app.get("/band-ghost-stats", async (req, res) => {
  const { tier = "150_250" } = req.query;
  const rows = await loadBandGhostStats(tier);
  res.json({ count: rows.length, tier, rows });
});

// GET /band-ghosts/active — currently running band ghost count
app.get("/band-ghosts/active", (req, res) => {
  const active = Object.values(bandGhostTrackers).map(g => ({
    id: g.id, symbol: g.symbol, bandTier: g.bandTier,
    bandPct: g.bandPct ? parseFloat((g.bandPct * 100).toFixed(0)) : null,
    maxRR: g.maxRR ?? 0, elapsedMin: Math.round((Date.now() - g.startTs) / 60000),
  }));
  res.json({ count: active.length, active });
});

// ── TEST endpoint — gebruik dit om Railway connectie te verifiëren ──
// GET  /test           → bevestigt dat Railway draait
// POST /test           → echo's de body terug zodat je TV webhook kunt testen
// Gebruik: curl -X POST https://JOUW-URL/test -H "Content-Type: application/json" -d '{"hello":"world"}'
// Of in TV webhook URL: https://JOUW-URL/test (geen secret nodig)
app.get("/test", (req, res) => {
  res.json({
    status: "Railway is bereikbaar",
    version: "11.0.0",
    time: new Date().toISOString(),
    headers: {
      "content-type": req.headers["content-type"] ?? "(geen)",
      "user-agent":   (req.headers["user-agent"] ?? "(geen)").slice(0, 80),
    },
  });
});

app.post("/test", (req, res) => {
  const ts = new Date().toISOString();
  console.log(`[TEST POST][${ts}] Content-Type: ${req.headers["content-type"] ?? "(geen)"}`);
  console.log(`[TEST POST] Body type: ${typeof req.body}`);
  console.log(`[TEST POST] Body: ${JSON.stringify(req.body)?.slice(0, 500)}`);
  res.json({
    status: "POST ontvangen",
    time: ts,
    contentType: req.headers["content-type"] ?? "(geen)",
    bodyType: typeof req.body,
    bodyReceived: req.body,
    note: "Als bodyReceived leeg/null is → Content-Type probleem. Als bodyReceived gevuld is → webhook URL of secret probleem.",
  });
});

app.get("/health", async (req, res) => {
  const balance = await getLiveBalance();
  const tradeWindowForex = canOpenNewTrade("EURUSD");
  const tradeWindowStock = canOpenNewTrade("AAPL");
  res.json({
    status: "ok", version: "11.0.0", time: getBrusselsDateStr(),
    openPos: Object.keys(openPositions).length, ghosts: Object.keys(ghostTrackers).length,
    tpLocks: Object.keys(tpLocks).length, closedT: closedTrades.length, balance,
    fixedRiskPct: FIXED_RISK_PCT, marketOpen: isMarketOpen(), session: getSession(),
    tradeWindowForex: tradeWindowForex.allowed, tradeWindowStocks: tradeWindowStock.allowed,
    lotOverrides: Object.keys(lotOverrides).length, evKeyMults: Object.keys(keyRiskMult).length,
    multMinSample: MULT_MIN_SAMPLE, slBufferMult: SL_BUFFER_MULT,
  });
});

// ── Dashboard — clean minimal layout ─────────────────────────────
app.get(["/", "/dashboard"], async (req, res) => {
  const balance = await getLiveBalance();
  res.setHeader("Content-Type", "text/html");

  const FOREX_SYMBOLS     = ["AUDCAD","AUDCHF","AUDNZD","AUDUSD","CADCHF","EURAUD","EURCHF","EURUSD","GBPAUD","GBPNZD","GBPUSD","NZDCAD","NZDCHF","NZDUSD","USDCAD","USDCHF"];
  const INDEX_SYMBOLS     = ["DE30EUR","NAS100USD","UK100GBP","US30USD"];
  const COMMODITY_SYMBOLS = ["XAUUSD"];
  const STOCK_SYMBOLS     = ["AAPL","AMD","AMZN","ARM","ASML","AVGO","AZN","BA","BABA","BAC","BRKB","CSCO","CVX","DIS","FDX","GE","GM","GME","GOOGL","IBM","INTC","JNJ","JPM","KO","LMT","MCD","META","MSFT","MSTR","NFLX","NKE","NVDA","PFE","PLTR","QCOM","SBUX","SNOW","T","TSLA","V","WMT","XOM","ZM"];

  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v11</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#060810;--bg1:#090c15;--bg2:#0c1020;--card:#0e1428;
  --bdr:#141e33;--bdr2:#1c2a42;--txt:#a8c0dc;--dim:#2e4060;--dim2:#162030;
  --g:#00e8a0;--r:#ff2d55;--b:#28b4f0;--y:#f0be20;--p:#a878ff;--c:#00dcd4;--o:#ff8020;
  --fn:'IBM Plex Mono',monospace;--fh:'IBM Plex Sans Condensed',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--txt);font-family:var(--fn);font-size:11px;line-height:1.4;overflow-x:hidden}
.hdr{position:sticky;top:0;z-index:100;background:var(--bg1);border-bottom:1px solid var(--bdr2);padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.logo{font-family:var(--fh);font-size:19px;font-weight:700;letter-spacing:3px;color:var(--b);text-shadow:0 0 18px rgba(40,180,240,.3)}
.ver{font-size:9px;color:var(--dim);letter-spacing:.4px;margin-top:1px}
.hdr-r{display:flex;align-items:center;gap:10px}
.clock{font-size:15px;font-weight:600;color:var(--c);letter-spacing:2px;min-width:76px;text-align:right}
.sb{padding:3px 9px;border-radius:2px;font-size:10px;font-weight:700;letter-spacing:.8px;font-family:var(--fh)}
.s-asia{background:#001e2a;color:var(--c);border:1px solid var(--c)}.s-london{background:#001c18;color:var(--g);border:1px solid var(--g)}.s-ny{background:#1e0018;color:var(--p);border:1px solid var(--p)}.s-outside{background:#111;color:var(--dim);border:1px solid var(--bdr2)}
.rbtn{background:none;border:1px solid var(--bdr2);color:var(--dim);padding:4px 10px;border-radius:2px;cursor:pointer;font-family:var(--fn);font-size:10px;transition:all .15s}
.rbtn:hover{color:var(--b);border-color:var(--b)}
/* KPI BAR */
.kbar{display:grid;grid-template-columns:repeat(10,1fr);border-bottom:1px solid var(--bdr2);background:var(--bdr)}
.kpi{background:var(--bg1);padding:8px 12px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px}
.k0::after{background:var(--g)}.k1::after{background:var(--b)}.k2::after{background:var(--p)}.k3::after{background:var(--p)}.k4::after{background:var(--y)}.k5::after{background:var(--c)}.k6::after{background:var(--o)}.k7::after{background:var(--c)}.k8::after{background:var(--b)}.k9::after{background:var(--r)}
.kl{font-size:8px;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:3px;font-family:var(--fh)}
.kv{font-size:16px;font-weight:700;line-height:1;font-family:var(--fh);letter-spacing:.5px}
/* MAIN */
.main{padding:12px 16px;display:flex;flex-direction:column;gap:12px}
.sec{border:1px solid var(--bdr2);border-radius:3px;overflow:hidden}
.sh{padding:7px 12px;background:var(--bg2);border-bottom:1px solid var(--bdr2);display:flex;align-items:center;justify-content:space-between;gap:8px}
.st{font-family:var(--fh);font-size:12px;font-weight:700;letter-spacing:.8px}
.sm{font-size:9px;color:var(--dim);letter-spacing:.4px}
/* TABLE */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:10.5px}
thead tr{background:var(--bg2);border-bottom:1px solid var(--bdr2)}
th{padding:5px 7px;text-align:left;font-size:8.5px;letter-spacing:.7px;color:var(--dim);text-transform:uppercase;white-space:nowrap;font-family:var(--fh);font-weight:600;user-select:none}
th.s{cursor:pointer}th.s:hover{color:var(--b)}
th.s.asc::after{content:' ↑';color:var(--b)}th.s.desc::after{content:' ↓';color:var(--b)}
td{padding:4px 7px;border-bottom:1px solid var(--bdr);white-space:nowrap;vertical-align:middle}
tbody tr:hover{background:rgba(40,180,240,.035)}
tbody tr:last-child td{border-bottom:none}
.nodata{text-align:center;padding:14px;color:var(--dim);font-size:10px;letter-spacing:.4px}
/* BADGES */
.bd{display:inline-block;padding:2px 5px;border-radius:2px;font-size:8.5px;font-weight:700;letter-spacing:.4px;font-family:var(--fh)}
.bd-buy{background:rgba(0,232,160,.12);color:var(--g);border:1px solid rgba(0,232,160,.25)}.bd-sell{background:rgba(255,45,85,.12);color:var(--r);border:1px solid rgba(255,45,85,.25)}
.bd-ab{background:rgba(40,180,240,.12);color:var(--b);border:1px solid rgba(40,180,240,.25)}.bd-bw{background:rgba(168,120,255,.12);color:var(--p);border:1px solid rgba(168,120,255,.25)}
.bd-tp{background:rgba(0,232,160,.15);color:var(--g)}.bd-sl{background:rgba(255,45,85,.15);color:var(--r)}.bd-mn{background:rgba(240,190,32,.12);color:var(--y)}
.bd-as{background:rgba(0,220,212,.1);color:var(--c)}.bd-lo{background:rgba(0,232,160,.1);color:var(--g)}.bd-ny{background:rgba(168,120,255,.1);color:var(--p)}.bd-out{background:rgba(46,64,96,.15);color:var(--dim)}
.bd-evp{background:rgba(0,232,160,.18);color:var(--g);border:1px solid rgba(0,232,160,.3)}.bd-evn{background:rgba(255,45,85,.15);color:var(--r);border:1px solid rgba(255,45,85,.25)}
.bd-lck{background:rgba(240,190,32,.18);color:var(--y);border:1px solid rgba(240,190,32,.3)}
.bd-fx{background:rgba(0,220,212,.1);color:var(--c)}.bd-ix{background:rgba(240,190,32,.1);color:var(--y)}.bd-cm{background:rgba(255,128,32,.1);color:var(--o)}.bd-sk{background:rgba(40,180,240,.1);color:var(--b)}
.bd-mr{background:rgba(168,120,255,.15);color:var(--p);border:1px solid rgba(168,120,255,.3)}
/* COLORS */
.g{color:var(--g)}.r{color:var(--r)}.b{color:var(--b)}.y{color:var(--y)}.p{color:var(--p)}.c{color:var(--c)}.o{color:var(--o)}.d{color:var(--dim)}.fw{font-weight:700}
/* TYPE BORDER */
tr.ts td:first-child{border-left:2px solid rgba(40,180,240,.3)}tr.tf td:first-child{border-left:2px solid rgba(0,220,212,.3)}tr.ti td:first-child{border-left:2px solid rgba(240,190,32,.3)}tr.tc td:first-child{border-left:2px solid rgba(255,128,32,.3)}
/* SL BAR */
.slbar{display:flex;align-items:center;gap:4px;min-width:66px}
.slbg{height:4px;flex:1;background:var(--dim2);border-radius:2px;overflow:hidden}
.slfi{height:100%;border-radius:2px;background:var(--g);transition:width .3s}
.slfi.w{background:var(--o)}.slfi.d{background:var(--r)}
/* FILTER BAR */
.fbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:7px 10px;border-bottom:1px solid var(--bdr2);background:var(--bg1)}
.fl{font-size:9px;color:var(--dim);letter-spacing:.4px;margin-right:2px;font-family:var(--fh)}
.fb{background:none;border:1px solid var(--bdr2);color:var(--dim);padding:2px 7px;border-radius:2px;cursor:pointer;font-family:var(--fn);font-size:9px;transition:all .12s}
.fb.on{background:rgba(40,180,240,.1);color:var(--b);border-color:var(--b)}
/* STATS STRIP */
.strip{display:flex;gap:14px;padding:7px 12px;border-bottom:1px solid var(--bdr2);background:var(--bg2);flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:1px}
.sl2{font-size:8px;color:var(--dim);letter-spacing:.7px;text-transform:uppercase;font-family:var(--fh)}
.sv2{font-size:12px;font-weight:700;font-family:var(--fh)}
/* EV MATRIX */
.mxg{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px 12px;background:var(--bg2)}
.mxt{font-family:var(--fh);font-size:10px;font-weight:700;letter-spacing:.7px;color:var(--dim);padding:0 0 4px;border-bottom:1px solid var(--bdr2);margin-bottom:4px}
.mx table{font-size:9.5px}.mx th{font-size:8px;padding:3px 5px}.mx td{padding:3px 6px;text-align:center;border-right:1px solid var(--bdr)}
.mx td:last-child{border-right:none}.mx td.sym{text-align:left;font-weight:700;color:var(--y);font-family:var(--fh);font-size:10px;position:sticky;left:0;background:var(--bg2);z-index:1;border-right:1px solid var(--bdr2)}
.ep{color:var(--g)}.en{color:var(--r)}.ez{color:var(--dim)}
/* TABS */
.tabs{display:flex;gap:0;border-bottom:1px solid var(--bdr2)}
.tab{padding:7px 14px;cursor:pointer;font-size:10px;font-family:var(--fh);font-weight:600;letter-spacing:.6px;color:var(--dim);border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:var(--b)}.tab.on{color:var(--b);border-bottom-color:var(--b);background:rgba(40,180,240,.04)}
.tpane{display:none}.tpane.on{display:block}
/* COMBO FILTER TABLE */
.cfbox{padding:10px 12px;background:var(--bg2);display:flex;flex-direction:column;gap:10px}
.cftitle{font-family:var(--fh);font-size:10px;font-weight:700;color:var(--dim);letter-spacing:.6px;padding-bottom:5px;border-bottom:1px solid var(--bdr2)}
.empty{display:flex;align-items:center;gap:10px;padding:12px 14px;color:var(--dim);font-size:10px}
.sec-err{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--r);margin-left:6px;vertical-align:middle;animation:pulse 1.5s infinite}
.sec-ok{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--g);margin-left:6px;vertical-align:middle}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.eline{flex:1;height:1px;background:var(--bdr2)}
@media(max-width:900px){.kbar{grid-template-columns:repeat(5,1fr)}.mxg{grid-template-columns:1fr}}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="logo">PRONTO-AI</div>
    <div class="ver">v11 · TradingView → MetaApi → FTMO MT5 · Risk ${(FIXED_RISK_PCT*100).toFixed(3)}% · SL×${SL_BUFFER_MULT} · DAX Fix active</div>
  </div>
  <div class="hdr-r">
    <span class="sb s-outside" id="hdr-sess">—</span>
    <span class="clock" id="clock">--:--:--</span>
    <button class="rbtn" onclick="loadAll()">↻ REFRESH</button>
    <button class="rbtn" id="deploy-btn" onclick="prepareDeploy()" style="border-color:var(--r);color:var(--r)">⚡ PREPARE DEPLOY</button>
    <span id="deploy-status" style="font-size:9px;color:var(--dim)"></span>
  </div>
</div>

<div class="kbar">
  <div class="kpi k0"><div class="kl">Balance MT5</div><div class="kv g">€<span id="k-bal">${balance.toFixed(0)}</span></div></div>
  <div class="kpi k1"><div class="kl">Open Trades</div><div class="kv b" id="k-pos">—</div></div>
  <div class="kpi k2"><div class="kl">Open P&amp;L</div><div class="kv" id="k-pnl">—</div></div>
  <div class="kpi k3"><div class="kl">Ghosts Active</div><div class="kv p" id="k-gh">—</div></div>
  <div class="kpi k4"><div class="kl">TP Locks EV+</div><div class="kv y" id="k-tp">—</div></div>
  <div class="kpi k5"><div class="kl">SL Optimizer</div><div class="kv c" id="k-sl">—</div></div>
  <div class="kpi k6"><div class="kl">Session</div><div class="kv o" id="k-sess" style="font-size:13px">—</div></div>
  <div class="kpi k7"><div class="kl">Base Risk % / Actual</div><div class="kv c" style="font-size:13px">${(FIXED_RISK_PCT*100).toFixed(3)}% <span style="color:var(--o);font-size:10px">~${(FIXED_RISK_PCT*SL_BUFFER_MULT*100).toFixed(3)}%</span></div></div>
  <div class="kpi k8"><div class="kl">Trades / Sess</div><div class="kv b" id="k-tps">—</div></div>
  <div class="kpi k9"><div class="kl">Logged Trades</div><div class="kv b" id="k-err">—</div></div>
</div>

<div id="global-status" style="padding:4px 20px;background:var(--bg1);border-bottom:1px solid var(--bdr2);display:flex;align-items:center;justify-content:space-between;font-size:9px;color:var(--dim)">
  <span id="gs-text">Initializing...</span>
  <span><span id="gs-err" style="color:var(--r)"></span> <span id="gs-time"></span></span>
</div>

<div class="main">

<!-- 1. OPEN POSITIONS -->
<div class="sec">
  <div class="sh"><span class="st g">▸ OPEN POSITIONS</span><span class="sm" id="pos-meta">loading…</span><span id="pos-dot" class="sec-err" title="Loading..."></span></div>
  <div id="pos-empty" class="empty" style="display:none"><div class="eline"></div><span>0 open trades</span><div class="eline"></div></div>
  <div class="tw" id="pos-wrap">
    <table id="pos-tbl">
      <thead><tr>
        <th class="s" data-col="0">Pair</th><th class="s" data-col="1">Dir</th><th class="s" data-col="2">VWAP</th><th class="s" data-col="3">Session</th>
        <th class="s" data-col="4">Entry MT5</th><th class="s" data-col="5">SL MT5</th><th class="s" data-col="6">TP MT5</th>
        <th class="s" data-col="7" title="Current RR: (price-entry)/SL dist">RR Now</th>
        <th class="s" data-col="8" title="Highest RR reached since open">Max RR</th>
        <th title="% of SL already consumed">SL Used</th>
        <th class="s" data-col="10" title="TP RR: (TP-entry)/SL dist">Entry→TP RR</th>
        <th class="s" data-col="11">P&amp;L €</th>
        <th class="s" data-col="12">Lots</th>
        <th class="s" data-col="13" title="Actual risk at SL: lots×dist×lotVal as % of balance">Risk %</th>
        <th class="s" data-col="14">Opened</th>
      </tr></thead>
      <tbody id="pos-body"><tr><td colspan="15" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 2. ACTIVE GHOSTS -->
<div class="sec">
  <div class="sh"><span class="st p">▸ GHOST TRACKER</span><span id="gh-dot" class="sec-err" title="Loading..."></span><span class="sm" id="gh-meta">active ghosts — tracking until MT5 SL hit, max 15R or 2 weeks</span></div>
  <div class="tw">
    <table id="gh-tbl">
      <thead><tr>
        <th class="s" data-col="0">Symbol</th><th>Type</th><th class="s" data-col="2">Session</th>
        <th class="s" data-col="3">Dir</th><th class="s" data-col="4">VWAP</th>
        <th class="s" data-col="5" title="Highest RR reached">Max RR</th>
        <th title="% of original SL distance consumed so far">SL Used%</th>
        <th class="s" data-col="7">Elapsed</th><th class="s" data-col="8">Opened</th>
      </tr></thead>
      <tbody id="gh-body"><tr><td colspan="9" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 3. EV / TP + SL OPTIMISER (only combos with trades) -->
<div class="sec">
  <div class="sh">
    <span class="st y">▸ EV / TP + SL OPTIMISER</span><span id="ev-dot" class="sec-err" title="Loading..."></span>
    <span class="sm" id="ev-meta">only combos with ≥1 trade · EV locked at ≥5</span>
  </div>
  <div class="fbar">
    <span class="fl">Type:</span>
    <button class="fb on" onclick="setEVF('type','all',this)">All</button>
    <button class="fb" onclick="setEVF('type','forex',this)">Forex</button>
    <button class="fb" onclick="setEVF('type','index',this)">Index</button>
    <button class="fb" onclick="setEVF('type','commodity',this)">Commodity</button>
    <button class="fb" onclick="setEVF('type','stock',this)">Stock</button>
    &nbsp;<span class="fl">Session:</span>
    <button class="fb on" onclick="setEVF('sess','all',this)">All</button>
    <button class="fb" onclick="setEVF('sess','asia',this)">Asia</button>
    <button class="fb" onclick="setEVF('sess','london',this)">London</button>
    <button class="fb" onclick="setEVF('sess','ny',this)">NY</button>
    &nbsp;<span class="fl">Dir:</span>
    <button class="fb on" onclick="setEVF('dir','all',this)">All</button>
    <button class="fb" onclick="setEVF('dir','buy',this)">Buy</button>
    <button class="fb" onclick="setEVF('dir','sell',this)">Sell</button>
    &nbsp;<span class="fl">VWAP:</span>
    <button class="fb on" onclick="setEVF('vwap','all',this)">All</button>
    <button class="fb" onclick="setEVF('vwap','above',this)">Above</button>
    <button class="fb" onclick="setEVF('vwap','below',this)">Below</button>
    &nbsp;<span class="fl">Min ghosts:</span>
    <button class="fb on" onclick="setEVF('min','1',this)">1+</button>
    <button class="fb" onclick="setEVF('min','5',this)">5+ (EV ready)</button>
    <button class="fb" onclick="setEVF('min','10',this)">10+</button>
  </div>
  <div class="strip">
    <div class="stat"><span class="sl2">Combos w/ data</span><span class="sv2 b" id="ev-count">—</span></div>
    <div class="stat"><span class="sl2">Total trades</span><span class="sv2 c" id="ev-trades">—</span></div>
    <div class="stat"><span class="sl2">With ghost data</span><span class="sv2 b" id="ev-winpct">—</span></div>
    <div class="stat"><span class="sl2">Total P&amp;L</span><span class="sv2" id="ev-pnl">—</span></div>
    <div class="stat"><span class="sl2">EV+ locked</span><span class="sv2 y" id="ev-locked">—</span></div>
  </div>
  <div class="tw">
    <table id="ev-tbl">
      <thead><tr>
        <th class="s" data-col="0">Symbol</th><th>Type</th><th class="s" data-col="2">Session</th>
        <th class="s" data-col="3">Dir</th><th class="s" data-col="4">VWAP</th>
        <th class="s" data-col="5" title="Closed ghost trades with maxRR>0"># Ghosts</th>
        <th class="s" data-col="6">Best TP RR</th>
        <th class="s" data-col="7">Avg RR</th>
        <th class="s" data-col="8">EV</th>
        <th>EV Status</th>
        <th class="s" data-col="10">TP Lock</th>
        <th class="s" data-col="11" title="Avg minutes from open to phantom SL hit">Avg T→SL</th>
        <th class="s" data-col="12" title="Avg max SL% used — basis for SL tightening (read only)">Avg SL%</th>
        <th class="s" data-col="13" title="Best SL% from winning ghost trades (read only)">Best SL% (W)</th>
        <th class="s" data-col="14">Total P&amp;L</th>
      </tr></thead>
      <tbody id="ev-body"><tr><td colspan="15" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 4. GHOST HISTORY / SL SHADOW LOG -->
<div class="sec">
  <div class="sh"><span class="st c">▸ GHOST HISTORY — CLOSED GHOSTS LOG</span><span id="ghh-dot" class="sec-err" title="Loading..."></span><span class="sm" id="ghh-meta">loading…</span></div>
  <div class="tw">
    <table id="ghh-tbl">
      <thead><tr>
        <th class="s" data-col="0">Symbol</th><th>Type</th><th class="s" data-col="2">Session</th>
        <th class="s" data-col="3">Dir</th><th class="s" data-col="4">VWAP</th>
        <th class="s" data-col="5" title="Highest RR reached before phantom SL">Max RR</th>
        <th class="s" data-col="6" title="Max SL% used (adverse excursion)">Max SL%</th>
        <th class="s" data-col="7" title="Minutes from open to phantom SL hit">T→SL min</th>
        <th>Close Reason</th>
        <th class="s" data-col="9">Opened</th>
      </tr></thead>
      <tbody id="ghh-body"><tr><td colspan="10" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 5. WEBHOOK ERRORS + VWAP BAND ANALYSIS -->
<div class="sec">
  <div class="sh"><span class="st r">▸ WEBHOOK ERRORS &amp; VWAP BAND ANALYSIS</span><span id="whe-dot" class="sec-err" title="Loading..."></span><span class="sm" id="whe-meta">loading…</span></div>
  <div class="tabs">
    <div class="tab on" onclick="showTab('wh','errors')">Errors</div>
    <div class="tab" onclick="showTab('wh','band150')">Band 150–250%</div>
    <div class="tab" onclick="showTab('wh','band250')">Band 250–350%</div>
  </div>
  <!-- Errors tab -->
  <div class="tpane on" id="wh-tab-errors">
    <div class="tw">
      <table id="whe-tbl">
        <thead><tr>
          <th class="s" data-col="0">Time</th><th class="s" data-col="1">Type</th><th class="s" data-col="2">Symbol</th>
          <th class="s" data-col="3">Dir</th><th class="s" data-col="4">Session</th><th class="s" data-col="5">VWAP</th>
          <th>Entry</th><th>SL%</th><th>Band%</th><th>Detail / Reason</th>
        </tr></thead>
        <tbody id="whe-body"><tr><td colspan="10" class="nodata">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>
  <!-- Band 150-250% tab -->
  <div class="tpane" id="wh-tab-band150">
    <div style="padding:7px 12px;background:var(--bg2);font-size:9px;color:var(--dim);border-bottom:1px solid var(--bdr2)">
      <b class="o">Ghost 2.0 — Band 150%–250%.</b> Each rejected signal spawns a ghost tracker that runs until phantom SL / 15RR / 2 weeks.
      Aggregated stats show what these trades would have earned. Data is read-only — never merged into main EV optimizer.
    </div>
    <div class="strip" id="band150-strip" style="display:none">
      <div class="stat"><span class="sl2">Ghosts</span><span class="sv2 b" id="b150-n">—</span></div>
      <div class="stat"><span class="sl2">Avg Max RR</span><span class="sv2 g" id="b150-rr">—</span></div>
      <div class="stat"><span class="sl2">Avg SL%</span><span class="sv2 o" id="b150-sl">—</span></div>
    </div>
    <div class="tw">
      <table id="band150-tbl">
        <thead><tr>
          <th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th>
          <th>n Ghosts</th><th>Avg Max RR</th><th>Max RR</th><th>Avg SL%</th><th>Avg T→SL</th>
        </tr></thead>
        <tbody id="band150-body"><tr><td colspan="9" class="nodata">Loading tab to see data…</td></tr></tbody>
      </table>
    </div>
  </div>
  <!-- Band 250-350% tab -->
  <div class="tpane" id="wh-tab-band250">
    <div style="padding:7px 12px;background:var(--bg2);font-size:9px;color:var(--dim);border-bottom:1px solid var(--bdr2)">
      <b class="r">Ghost 2.0 — Band 250%–350%.</b> Extreme outliers tracked separately. Read-only — never added to main optimizer.
    </div>
    <div class="strip" id="band250-strip" style="display:none">
      <div class="stat"><span class="sl2">Ghosts</span><span class="sv2 b" id="b250-n">—</span></div>
      <div class="stat"><span class="sl2">Avg Max RR</span><span class="sv2 g" id="b250-rr">—</span></div>
      <div class="stat"><span class="sl2">Avg SL%</span><span class="sv2 o" id="b250-sl">—</span></div>
    </div>
    <div class="tw">
      <table id="band250-tbl">
        <thead><tr>
          <th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th>
          <th>n Ghosts</th><th>Avg Max RR</th><th>Max RR</th><th>Avg SL%</th><th>Avg T→SL</th>
        </tr></thead>
        <tbody id="band250-body"><tr><td colspan="9" class="nodata">Loading tab to see data…</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- 6. EV MATRIX -->
<div class="sec">
  <div class="sh"><span class="st y">▸ EV MATRIX</span><span class="sm">bestRR · EV · n · ★ = EV+ locked (n≥5) &nbsp;|&nbsp; grey = no data</span></div>
  <div class="mxg mx" style="overflow-x:auto">
    <div>
      <div class="mxt">FOREX</div>
      <table id="mx-fx"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-fx"></tbody></table>
    </div>
    <div>
      <div class="mxt">INDEXES</div>
      <table id="mx-ix"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-ix"></tbody></table>
      <div class="mxt" style="margin-top:10px">COMMODITIES</div>
      <table id="mx-cm"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-cm"></tbody></table>
    </div>
    <div style="grid-column:1/-1">
      <div class="mxt">STOCKS (NY only)</div>
      <table id="mx-sk"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-sk"></tbody></table>
    </div>
  </div>
</div>

<!-- 7. COMBO SELECTION TABLE (replaces Optimisation Suggestions) -->
<div class="sec">
  <div class="sh"><span class="st p">▸ COMBO SELECTION — CUT &amp; UPGRADE</span><span class="sm">all traded combos ranked · use to decide what to keep, cut, or focus on</span></div>
  <div class="fbar">
    <span class="fl">Show:</span>
    <button class="fb on" onclick="setCF('show','all',this)">All traded</button>
    <button class="fb" onclick="setCF('show','ev+',this)">EV+ only</button>
    <button class="fb" onclick="setCF('show','ev-',this)">EV- (cut?)</button>
    <button class="fb" onclick="setCF('show','min5',this)">≥5 trades</button>
    &nbsp;<span class="fl">Sort:</span>
    <button class="fb on" onclick="setCF('sort','ev',this)">By EV</button>
    <button class="fb" onclick="setCF('sort','pnl',this)">By P&amp;L</button>
    <button class="fb" onclick="setCF('sort','winpct',this)">By Win%</button>
    <button class="fb" onclick="setCF('sort','trades',this)">By # Trades</button>
  </div>
  <div class="tw">
    <table id="cf-tbl">
      <thead><tr>
        <th>#</th><th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
        <th># Ghosts</th><th>Avg RR</th><th>EV</th><th>Total P&amp;L</th><th>Action</th>
      </tr></thead>
      <tbody id="cf-body"><tr><td colspan="12" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

</div><!-- /main -->

<script>
const FOREX  = ${JSON.stringify(FOREX_SYMBOLS)};
const INDEX  = ${JSON.stringify(INDEX_SYMBOLS)};
const COMM   = ${JSON.stringify(COMMODITY_SYMBOLS)};
const STOCKS = ${JSON.stringify(STOCK_SYMBOLS)};
const TP_OPT_DATE = new Date('2026-04-20T23:00:00.000Z');

let _allTrades=[],_evData=[],_tpMap={},_evMap={};
const evF={type:'all',sess:'all',dir:'all',vwap:'all',min:'1'};
const cfF={show:'all',sort:'ev'};

// ── helpers ──────────────────────────────────────────────
const f=(v,d=2)=>v==null?'—':(+v).toFixed(d);
const eu=v=>v==null?'—':(v>=0?'+':'')+\`€\${(+v).toFixed(2)}\`;
const pC=v=>v>0?'g':v<0?'r':'d';
const ts=s=>s?new Date(s).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit'}):'—';
const dt=s=>s?new Date(s).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',month:'2-digit',day:'2-digit'}):'—';
const dtTs=s=>s?dt(s)+' '+ts(s):'—';
function sType(s){if(FOREX.includes(s))return'f';if(INDEX.includes(s))return'i';if(COMM.includes(s))return'c';return's';}
function sTypeName(s){if(FOREX.includes(s))return'forex';if(INDEX.includes(s))return'index';if(COMM.includes(s))return'commodity';return'stock';}
function tClass(s){return{f:'tf',i:'ti',c:'tc'}[sType(s)]||'ts';}
function evC(v){return v>0?'ep':v<0?'en':'ez';}
function dBadge(d){return d==='buy'?'<span class="bd bd-buy">BUY</span>':d==='sell'?'<span class="bd bd-sell">SELL</span>':'—';}
function vBadge(v){return v==='above'?'<span class="bd bd-ab">ABOVE</span>':v==='below'?'<span class="bd bd-bw">BELOW</span>':'<span class="bd d">?</span>';}
function sBadge(s){const m={asia:'bd-as',london:'bd-lo',ny:'bd-ny',outside:'bd-out'};const n={asia:'ASIA',london:'LON',ny:'NY',outside:'OUT'};return\`<span class="bd \${m[s]||'bd-out'}">\${n[s]||s||'—'}</span>\`;}
function tyBadge(t){const m={forex:'bd-fx',index:'bd-ix',commodity:'bd-cm',stock:'bd-sk'};const n={forex:'FX',index:'IDX',commodity:'COM',stock:'STK'};return\`<span class="bd \${m[t]||'bd-sk'}">\${n[t]||t}</span>\`;}
function cBadge(r){if(r==='tp')return'<span class="bd bd-tp">TP</span>';if(r==='sl')return'<span class="bd bd-sl">SL</span>';if(r==='maxRR')return'<span class="bd bd-mr">MAX-RR</span>';if(r==='timeout')return'<span class="bd bd-mn">TIMEOUT</span>';if(r==='manual')return'<span class="bd bd-mn">MAN</span>';return r?\`<span class="bd d">\${r}</span>\`:'—';}
function slBar(p){const w=Math.min(100,Math.max(0,p||0));const c=w<50?'':w<80?' w':' d';return\`<div class="slbar"><div class="slbg"><div class="slfi\${c}" style="width:\${w}%"></div></div><span class="\${c.trim()||'g'}">\${f(p,0)}%</span></div>\`;}
async function api(path){try{const r=await fetch(path);if(!r.ok){console.error('[API] '+path+' returned '+r.status);return null;}return r.json();}catch(e){console.error('[API] '+path+' failed:',e.message);return null;}}
function setDot(id,ok,msg){const el=document.getElementById(id);if(!el)return;el.className=ok?'sec-ok':'sec-err';el.title=msg||'';}

// ── tab switching ─────────────────────────────────────────
function showTab(group,name){
  document.querySelectorAll(\`.tab[onclick*="'\${group}'"]\`).forEach(t=>t.classList.remove('on'));
  document.querySelectorAll(\`[id^="\${group}-tab-"]\`).forEach(p=>p.classList.remove('on'));
  document.querySelector(\`.tab[onclick="showTab('\${group}','\${name}')"]\`).classList.add('on');
  document.getElementById(\`\${group}-tab-\${name}\`).classList.add('on');
  if(group==='wh'&&name==='band150')loadBandSignals(1.5,2.5,'band150');
  if(group==='wh'&&name==='band250')loadBandSignals(2.5,3.5,'band250');
}

// ── sort ─────────────────────────────────────────────────
const sState={};
function initSort(id){const t=document.getElementById(id);if(!t)return;t.querySelectorAll('th.s').forEach(th=>th.addEventListener('click',()=>sortBy(id,+th.dataset.col)));}
function sortBy(id,col){
  const t=document.getElementById(id);if(!t)return;
  const k=id+'_'+col;const asc=sState[k]!=='asc';sState[k]=asc?'asc':'desc';
  t.querySelectorAll('th.s').forEach(th=>th.classList.remove('asc','desc'));
  const th=t.querySelector(\`th.s[data-col="\${col}"]\`);if(th)th.classList.add(asc?'asc':'desc');
  const tb=t.querySelector('tbody');const rows=Array.from(tb.rows);
  rows.sort((a,b)=>{
    const av=a.cells[col]?.dataset.val??a.cells[col]?.textContent??'';
    const bv=b.cells[col]?.dataset.val??b.cells[col]?.textContent??'';
    const an=parseFloat(av),bn=parseFloat(bv);
    const cmp=!isNaN(an)&&!isNaN(bn)?an-bn:av.localeCompare(bv);
    return asc?cmp:-cmp;
  });
  rows.forEach(r=>tb.appendChild(r));
}
function initAll(){['pos-tbl','ev-tbl','gh-tbl','ghh-tbl','whe-tbl','cf-tbl','mx-fx','mx-ix','mx-cm','mx-sk'].forEach(initSort);}

// ── clock ─────────────────────────────────────────────────
const SESS_LABELS={asia:'ASIA',london:'LONDON',ny:'NY',outside:'OUTSIDE'};
const SESS_CLS={asia:'s-asia',london:'s-london',ny:'s-ny',outside:'s-outside'};
function updateClock(){
  const d=new Date();
  const bx=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(d);
  const get=t=>bx.find(p=>p.type===t)?.value??'00';
  let h=parseInt(get('hour'));const mi=parseInt(get('minute'));
  if(h===24)h=0;
  document.getElementById('clock').textContent=\`\${String(h).padStart(2,'0')}:\${get('minute')}:\${get('second')}\`;
  const hhmm=h*100+mi;
  const day=new Date(d.toLocaleDateString('en-CA',{timeZone:'Europe/Brussels'})).getDay();
  let sess='outside';
  if(day>0&&day<6){if(hhmm>=200&&hhmm<800)sess='asia';else if(hhmm>=800&&hhmm<1530)sess='london';else if(hhmm>=1530&&hhmm<2100)sess='ny';}
  const hdrEl=document.getElementById('hdr-sess');
  hdrEl.textContent=SESS_LABELS[sess];hdrEl.className='sb '+SESS_CLS[sess];
  document.getElementById('k-sess').textContent=SESS_LABELS[sess];
}
setInterval(updateClock,1000);updateClock();

// ── 1. OPEN POSITIONS ────────────────────────────────────
async function loadPositions(){
  const d=await api('/live/positions');
  const tb=document.getElementById('pos-body');
  const em=document.getElementById('pos-empty');
  const pw=document.getElementById('pos-wrap');
  if(!d){
    setDot('pos-dot',false,'Failed — server error or timeout');
    document.getElementById('pos-meta').textContent='error — will retry';
    if(tb)tb.innerHTML='<tr><td colspan="15" class="nodata r">⚠ Failed to load — auto-retry in 10s</td></tr>';
    setTimeout(loadPositions,10000);return;
  }
  document.getElementById('pos-meta').textContent=d.count+' open';
  setDot('pos-dot',true,'OK');
  document.getElementById('k-pos').textContent=d?.count??'?';
  const pnlTotal=d?.positions?.reduce((s,p)=>s+(p.currentPnL??0),0)??null;
  const pnlEl=document.getElementById('k-pnl');
  if(pnlTotal!=null){pnlEl.textContent=(pnlTotal>=0?'+':'')+'€'+pnlTotal.toFixed(0);pnlEl.className='kv '+pC(pnlTotal);}
  if(!d||!d.positions?.length){em.style.display='flex';pw.style.display='none';return;}
  em.style.display='none';pw.style.display='';
  const bal=d.balance||1;
  tb.innerHTML=d.positions.map(p=>{
    const slU=p.slPctUsed||0;
    // RR now: distance traveled in direction / SL distance
    const slDist=p.sl&&p.entry?Math.abs(p.entry-p.sl):0;
    const priceDist=p.currentPrice&&p.entry?
      (p.direction==='buy'?(p.currentPrice-p.entry):(p.entry-p.currentPrice)):null;
    const rrNow=slDist>0&&priceDist!=null?parseFloat((priceDist/slDist).toFixed(2)):null;
    const rrNowCls=rrNow==null?'d':rrNow>=1?'g':rrNow>=0?'y':'r';
    const tpRR=p.tpRRActual??p.tpRR;
    // actualRiskPct directly from API — falls back to riskPct if null
    const riskPctShow=p.actualRiskPct??p.riskPct;
    const riskPctCls=riskPctShow==null?'d':riskPctShow>0.35?'r':riskPctShow>0.25?'o':'g';
    // price decimals by type
    const isFx=FOREX.includes(p.symbol);const isIdx=INDEX.includes(p.symbol);
    const dec=isFx?5:isIdx?2:2;
    return\`<tr class="\${tClass(p.symbol)}">
      <td data-val="\${p.symbol}" class="b fw">\${p.symbol}</td>
      <td>\${dBadge(p.direction)}</td><td>\${vBadge(p.vwapPosition)}</td><td>\${sBadge(p.session)}</td>
      <td data-val="\${p.entry}" class="d">\${f(p.entry,dec)}</td>
      <td data-val="\${p.sl}" class="r">\${f(p.sl,dec)}</td>
      <td data-val="\${p.tp}" class="g">\${f(p.tp,dec)}</td>
      <td data-val="\${rrNow??-99}" class="\${rrNowCls} fw">\${rrNow!=null?rrNow+'R':'—'}</td>
      <td data-val="\${p.maxRR??-99}" class="\${(p.maxRR??0)>0?'g':'d'} fw">\${f(p.maxRR,2)}R</td>
      <td>\${slBar(slU)}</td>
      <td data-val="\${tpRR??-99}" class="y">\${tpRR!=null?f(tpRR,2)+'R':'—'}</td>
      <td data-val="\${p.currentPnL??-99999}" class="\${pC(p.currentPnL)} fw">\${eu(p.currentPnL)}</td>
      <td data-val="\${p.lots}" class="c">\${f(p.lots,2)}</td>
      <td data-val="\${riskPctShow??-1}" class="\${riskPctCls} fw">\${riskPctShow!=null?f(riskPctShow,3)+'%':'—'}</td>
      <td data-val="\${p.openedAt}" class="d" style="font-size:9px">\${dtTs(p.openedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── 2. ACTIVE GHOSTS ─────────────────────────────────────
async function loadGhosts(){
  const d=await api('/live/ghosts');
  if(!d){
    setDot('gh-dot',false,'Failed — retrying in 10s');
    document.getElementById('gh-meta').textContent='error — retrying';
    setTimeout(loadGhosts,10000);return;
  }
  document.getElementById('gh-meta').textContent=d.count+' active';
  setDot('gh-dot',true,'OK');
  document.getElementById('k-gh').textContent=d?.count??'?';
  const tb=document.getElementById('gh-body');
  if(!d||!d.ghosts?.length){tb.innerHTML='<tr><td colspan="9" class="nodata">No active ghosts</td></tr>';return;}
  tb.innerHTML=d.ghosts.map(g=>{
    const type=sTypeName(g.symbol);
    return\`<tr class="\${tClass(g.symbol)}">
      <td data-val="\${g.symbol}" class="b fw">\${g.symbol}</td>
      <td>\${tyBadge(type)}</td>
      <td>\${sBadge(g.session)}</td>
      <td>\${dBadge(g.direction)}</td>
      <td>\${vBadge(g.vwapPosition)}</td>
      <td data-val="\${g.maxRR??-99}" class="\${(g.maxRR??0)>0?'g':'d'} fw">\${f(g.maxRR,2)}R</td>
      <td>\${slBar(g.slPctUsed)}</td>
      <td data-val="\${g.elapsedMin}" class="d">\${g.elapsedMin}min</td>
      <td data-val="\${g.openedAt}" class="d" style="font-size:9px">\${dtTs(g.openedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── 3. EV / TP + SL OPTIMISER ────────────────────────────
// EV cache op server kan 10-30s nodig hebben bij eerste start.
// loadEV laadt trades en TP locks onmiddellijk.
// EV data wordt apart opgehaald — als cache nog leeg is, wordt na 5s opnieuw geprobeerd (max 12×).
async function loadEV(){
  const countD=await api('/trades?limit=1');
  const realLimit=countD?.count??5000;
  const [trD,tpD]=await Promise.all([api('/trades?limit='+Math.max(realLimit,5000)),api('/tp-locks')]);
  if(!trD){setDot('ev-dot',false,'Failed to load trades');return;}
  _allTrades=trD.trades||[];
  _tpMap={};if(tpD)tpD.forEach(t=>{_tpMap[t.key]=t;});
  document.getElementById('k-tp').textContent=Object.values(_tpMap).filter(t=>(t.evAtLock??0)>0).length;
  // Bouw alle combos onmiddellijk op — EV data wordt apart ingeladen
  _buildCombos();
  // Laad EV data met retry totdat cache klaar is
  await _loadEVWithRetry();
}

async function _loadEVWithRetry(attempt=0){
  const MAX=12, INTERVAL=5000;
  const evD=await api('/ev');
  const status=await api('/ev/status');
  _evMap={};if(evD&&evD.length>0)evD.forEach(e=>{_evMap[e.key]=e;});
  if(evD&&evD.length>0){
    setDot('ev-dot',true,'EV cache ready — '+evD.filter(e=>e.count>0).length+' combos with data');
    _buildCombos();// re-render with EV data
    return;
  }
  // Cache nog leeg — toon status en retry
  if(attempt<MAX){
    const remaining=Math.round(((MAX-attempt)*INTERVAL)/1000);
    setDot('ev-dot',false,status?.building?'EV cache building on server...':'EV cache empty — retrying');
    document.getElementById('ev-meta').textContent=
      status?.building?('EV cache wordt gebouwd op server... retry '+(attempt+1)+'/'+MAX+' (nog ~'+remaining+'s)'):'Retrying...';
    setTimeout(()=>_loadEVWithRetry(attempt+1),INTERVAL);
  } else {
    setDot('ev-dot',false,'EV cache niet beschikbaar na '+MAX+' pogingen — refresh handmatig');
  }
}

function _buildCombos(){
  document.getElementById('k-tp').textContent=Object.values(_tpMap).filter(t=>(t.evAtLock??0)>0).length;
  // Build combos — ALL symbol/session/dir/vwap combos, even with 0 closed trades
  const combos=[];
  const allSyms=[...FOREX,...INDEX,...COMM,...STOCKS];
  for(const sym of allSyms){
    const type=sTypeName(sym);
    const sessions=type==='stock'?['ny']:['asia','london','ny'];
    for(const sess of sessions){
      for(const dir of['buy','sell']){
        for(const vwap of['above','below']){
          const key=sym+'_'+sess+'_'+dir+'_'+vwap;
          // Closed MT5 trades — for P&L and combo activity indicator
          const trades=_allTrades.filter(t=>
            t.symbol===sym&&t.session===sess&&t.direction===dir&&
            t.vwapPosition===vwap&&t.closedAt!=null&&
            t.openedAt&&new Date(t.openedAt)>=TP_OPT_DATE
          );
          const totalPnl=trades.reduce((s,t)=>s+(t.realizedPnlEUR??t.currentPnL??0),0);
          // EV data comes from ghost_trades via server /ev endpoint
          const ev=_evMap[key]??null;
          const tp=_tpMap[key]??null;
          // avgRR from ghosts (server-computed ev.rrLevels[0].winRate is for all RR levels)
          // Just use ev.bestRR and ev.avgMaxSlPct from server
          const avgRR=ev?.avgRR??null;
          combos.push({sym,sess,dir,vwap,key,trades,totalPnl,type,ev,tp});
        }
      }
    }
  }
  _evData=combos;renderEV();
  loadGhostHistory();
  buildMatrix(combos);
  renderComboFilter(combos);
}

function renderEV(){
  let d=_evData;
  if(evF.type!=='all')d=d.filter(c=>c.type===evF.type);
  if(evF.sess!=='all')d=d.filter(c=>c.sess===evF.sess);
  if(evF.dir!=='all')d=d.filter(c=>c.dir===evF.dir);
  if(evF.vwap!=='all')d=d.filter(c=>c.vwap===evF.vwap);
  // min filter: based on ghost count from EV data
  if(evF.min==='5')d=d.filter(c=>(c.ev?.count??0)>=5);
  else if(evF.min==='10')d=d.filter(c=>(c.ev?.count??0)>=10);
  else if(evF.min!=='1')d=d.filter(c=>(c.ev?.count??0)>=parseInt(evF.min));
  // Sort: EV+ first, then by EV desc, then by ghost count
  d.sort((a,b)=>{
    const ea=a.ev?.bestEV??-999,eb=b.ev?.bestEV??-999;
    if(eb!==ea)return eb-ea;
    return (b.ev?.count??0)-(a.ev?.count??0);
  });
  const withData=d.filter(c=>c.ev&&c.ev.count>0);
  const pnl=d.reduce((s,c)=>s+c.totalPnl,0);
  document.getElementById('ev-meta').textContent=d.length+' combos · '+withData.length+' met ghost data'+(_evMap&&Object.keys(_evMap).length===0?' · ⏳ EV data laden...':'');
  document.getElementById('ev-count').textContent=d.length;
  document.getElementById('ev-trades').textContent=withData.length+'/'+d.length;
  document.getElementById('ev-winpct').textContent='—'; // win% is ghost-based (see EV column)
  const pEl=document.getElementById('ev-pnl');pEl.textContent=(pnl>=0?'+':'')+'€'+pnl.toFixed(0);pEl.className='sv2 '+pC(pnl);
  document.getElementById('ev-locked').textContent=d.filter(c=>c.tp&&(c.ev?.bestEV??0)>0).length;
  const tb=document.getElementById('ev-body');
  if(!d.length){
    const evBuilding=Object.keys(_evMap).length===0;
    tb.innerHTML='<tr><td colspan="15" class="nodata '+(evBuilding?'y':'d')+'">'+(evBuilding?'⏳ EV cache wordt gebouwd op server — secties verschijnen automatisch...':'Geen combos met huidige filters')+' </td></tr>';
    return;
  }
  tb.innerHTML=d.map(c=>{
    const ev=c.ev;const tp=c.tp;
    const evV=ev?.bestEV??null;
    const ghostN=ev?.count??0;
    const ready=ghostN>=5;
    // bestTP: locked RR from TP lock > server EV bestRR > null (never show 1.0R default)
    const bestTP=tp?tp.lockedRR:(ev?.bestRR??null);
    const avgTimeMin=ev?.avgTimeToSLMin??null;
    const avgSlPct=ev?.avgMaxSlPct??null;
    // Best SL% from winners: from ev data (server computes this)
    const bestSlW=ev?.bestWinnerSlPct??null;
    return\`<tr class="\${tClass(c.sym)}\${ghostN===0?' opacity:0.45':''}">
      <td data-val="\${c.sym}" class="b fw">\${c.sym}</td>
      <td>\${tyBadge(c.type)}</td>
      <td>\${sBadge(c.sess)}</td>
      <td>\${dBadge(c.dir)}</td>
      <td>\${vBadge(c.vwap)}</td>
      <td data-val="\${ghostN}" class="\${ready?'y fw':ghostN>0?'c':'d'}">\${ghostN===0?'<span class="d">—</span>':ghostN+(ready?'':' <span class="d" style="font-size:8px">('+(5-ghostN)+'→5)</span>')}</td>
      <td data-val="\${bestTP??-99}" class="\${bestTP?'g fw':'d'}">\${bestTP!=null?f(bestTP,1)+'R':'—'}</td>
      <td data-val="\${ev?.avgRR??-99}" class="\${(ev?.avgRR??0)>=1?'g':'d'}">\${ev?.avgRR!=null?f(ev.avgRR,2)+'R':'—'}</td>
      <td data-val="\${evV??-999}" class="\${evC(evV)} fw">\${evV!=null?evV.toFixed(3):'—'}</td>
      <td>\${ready?(evV!=null?(evV>0?'<span class="bd bd-evp">EV+ ✓</span>':'<span class="bd bd-evn">EV-</span>'):'<span class="bd d">pending</span>'):'<span class="d" style="font-size:9px">\${ghostN>0?'need '+(5-ghostN)+' more':'no data'}</span>'}</td>
      <td>\${tp?\`<span class="bd bd-lck">★ \${tp.lockedRR.toFixed(1)}R</span>\`:'<span class="d">—</span>'}</td>
      <td data-val="\${avgTimeMin??9999}" class="d">\${avgTimeMin!=null?avgTimeMin+'min':'—'}</td>
      <td data-val="\${avgSlPct??-1}" class="\${avgSlPct!=null?(avgSlPct<50?'g':avgSlPct<80?'y':'o'):'d'}" title="Avg max SL% used — lower = can tighten">\${avgSlPct!=null?f(avgSlPct,1)+'%':'—'}</td>
      <td data-val="\${bestSlW??-1}" class="g" title="Best SL% from winning ghosts (read only)">\${bestSlW!=null?f(bestSlW,1)+'%':'—'}</td>
      <td data-val="\${c.totalPnl}" class="\${pC(c.totalPnl)} fw">\${eu(c.totalPnl)}</td>
    </tr>\`;
  }).join('');
}

function setEVF(k,v,btn){evF[k]=v;btn.closest('.fbar').querySelectorAll('.fb').forEach(b=>{if(b.getAttribute('onclick')?.includes("'"+k+"'"))b.classList.remove('on');});btn.classList.add('on');renderEV();}


// ── 4. GHOST HISTORY ─────────────────────────────────────
async function loadGhostHistory(){
  const d=await api('/ghosts/history?limit=200');
  const rows=d?.rows||d||[];
  document.getElementById('ghh-meta').textContent=rows.length+' closed ghosts';
  setDot('ghh-dot',true,'OK');
  const tb=document.getElementById('ghh-body');
  if(!rows.length){tb.innerHTML='<tr><td colspan="10" class="nodata">No closed ghost data yet</td></tr>';return;}
  tb.innerHTML=rows.map(g=>{
    const type=sTypeName(g.symbol||'');
    const maxRR=g.maxRRBeforeSL??g.maxRR??0;
    const maxSlP=g.maxSlPctUsed??g.slPctUsed??null;
    const tMin=g.timeToSLMin??null;
    let cr=g.stopReason||g.closeReason||'sl';
    if(maxRR>=15)cr='maxRR';
    else if(tMin!=null&&tMin>=20160)cr='timeout';
    else if(cr==='phantom_sl'||cr==='sl')cr='sl';
    else if(cr==='timeout_72h')cr='timeout';
    return\`<tr class="\${tClass(g.symbol||'')}">
      <td data-val="\${g.symbol}" class="b fw">\${g.symbol||'—'}</td>
      <td>\${tyBadge(type)}</td>
      <td>\${sBadge(g.session)}</td>
      <td>\${dBadge(g.direction)}</td>
      <td>\${vBadge(g.vwapPosition)}</td>
      <td data-val="\${maxRR}" class="\${maxRR>0?'g':'d'} fw">\${f(maxRR,2)}R</td>
      <td data-val="\${maxSlP??-1}" class="\${maxSlP!=null?(maxSlP<50?'g':maxSlP<80?'y':'o'):'d'}">\${maxSlP!=null?f(maxSlP,0)+'%':'—'}</td>
      <td data-val="\${tMin??9999}" class="d">\${tMin!=null?tMin+'min':'—'}</td>
      <td>\${cBadge(cr)}</td>
      <td data-val="\${g.openedAt||''}" class="d" style="font-size:9px">\${dtTs(g.openedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── 5. WEBHOOK ERRORS ────────────────────────────────────
async function loadErrors(){
  const d=await api('/history');
  if(d===null){
    setDot('whe-dot',false,'Failed — retrying in 10s');
    document.getElementById('whe-meta').textContent='error — retrying';
    setTimeout(loadErrors,10000);return;
  }
  const all=Array.isArray(d)?d:[];
  const errs=all.filter(e=>['REJECTED','SL_TP_SET_FAILED','LOT_CALC_FAILED','ORDER_NOT_CONFIRMED','VWAP_BAND_EXHAUSTED','SPREAD_GUARD_CLOSE','RR_VERIFY_FAILED','CURRENCY_BUDGET_EXHAUSTED','OUTSIDE_WINDOW'].includes(e.type));
  document.getElementById('whe-meta').textContent=errs.length+' errors';
  setDot('whe-dot',true,'OK — '+errs.length+' errors');
  document.getElementById('k-err').textContent=errs.length;
  const tb=document.getElementById('whe-body');
  if(!errs.length){tb.innerHTML='<tr><td colspan="10" class="nodata g">✓ No errors</td></tr>';return;}
  tb.innerHTML=errs.slice(0,80).map(e=>{
    const p=e.payload||{};
    const bandPct=p.vwapBandPct||e.vwapBandPct;
    const bandStr=bandPct!=null?((+bandPct)*100).toFixed(0)+'%':'—';
    return\`<tr>
      <td class="d" style="font-size:9px">\${ts(e.ts)}</td>
      <td><span class="r" style="font-size:9px;font-weight:700">\${e.type}</span></td>
      <td class="b">\${e.symbol||p.symbol||'—'}</td>
      <td>\${dBadge(e.direction||p.direction)}</td>
      <td>\${sBadge(e.session||p.session)}</td>
      <td>\${vBadge(e.vwapPos||p.vwapPosition)}</td>
      <td class="d">\${e.entry?f(e.entry,5):'—'}</td>
      <td class="o">\${p.slPctHuman||p.derivedSlPct||'—'}</td>
      <td class="\${bandPct&&(+bandPct)>1.5?'r':'d'}">\${bandStr}</td>
      <td class="d" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;font-size:9px">\${e.reason||p.reason||''}</td>
    </tr>\`;
  }).join('');
}

async function loadBandSignals(minPct,maxPct,prefix){
  const tier=prefix==='band150'?'150_250':'250_350';
  const d=await api(\`/band-ghost-stats?tier=\${tier}\`);
  const rows=d?.rows||[];
  const tb=document.getElementById(prefix+'-body');
  const strip=document.getElementById(prefix+'-strip');
  if(!rows.length){
    tb.innerHTML=\`<tr><td colspan="9" class="nodata">No ghost data yet for \${tier.replace('_','%–')}% — ghosts start on next rejected signal</td></tr>\`;
    if(strip)strip.style.display='none';return;
  }
  const totalN=rows.reduce((s,r)=>s+(+r.n||0),0);
  const rrRows=rows.filter(r=>r.avgMaxRR!=null);
  const avgRR=rrRows.length?rrRows.reduce((s,r)=>s+(+r.avgMaxRR),0)/rrRows.length:0;
  const slRows=rows.filter(r=>r.avgSlPct!=null);
  const avgSL=slRows.length?slRows.reduce((s,r)=>s+(+r.avgSlPct),0)/slRows.length:0;
  if(strip)strip.style.display='flex';
  const pfx=prefix==='band150'?'b150':'b250';
  const nEl=document.getElementById(pfx+'-n');const rrEl=document.getElementById(pfx+'-rr');const slEl=document.getElementById(pfx+'-sl');
  if(nEl)nEl.textContent=totalN;
  if(rrEl)rrEl.textContent=avgRR?f(avgRR,2)+'R':'—';
  if(slEl)slEl.textContent=avgSL?f(avgSL,1)+'%':'—';
  tb.innerHTML=rows.map(r=>\`<tr class="\${tClass(r.symbol||'')}">
    <td class="b fw">\${r.symbol||'—'}</td>
    <td>\${sBadge(r.session)}</td>
    <td>\${dBadge(r.direction)}</td>
    <td>\${vBadge(r.vwapPosition)}</td>
    <td class="\${(+r.n||0)>=5?'y fw':'c'}">\${r.n||0}</td>
    <td class="\${(+r.avgMaxRR||0)>=2?'g fw':(+r.avgMaxRR||0)>=1?'y fw':'d'}">\${r.avgMaxRR!=null?f(r.avgMaxRR,2)+'R':'—'}</td>
    <td class="g">\${r.maxMaxRR!=null?f(r.maxMaxRR,2)+'R':'—'}</td>
    <td class="\${(+r.avgSlPct||0)<50?'g':(+r.avgSlPct||0)<80?'y':'o'}">\${r.avgSlPct!=null?f(r.avgSlPct,1)+'%':'—'}</td>
    <td class="d">\${r.avgTimeMin!=null?r.avgTimeMin+'min':'—'}</td>
  </tr>\`).join('');
}

// ── 6. EV MATRIX ─────────────────────────────────────────
function buildMatrix(combos){
  const make=(syms,tid)=>{
    const byKey={};combos.forEach(c=>{byKey[c.key]=c;});
    const body=document.getElementById('mxb-'+tid);
    if(!body)return;
    body.innerHTML=syms.map(sym=>{
      return'<tr>'+[
        \`<td class="sym">\${sym}</td>\`,
        ...[['buy','above'],['buy','below'],['sell','above'],['sell','below']].map(([dir,vwap])=>{
          const sess=STOCKS.includes(sym)?'ny':null; // for stocks show ny only
          const keys=sess?[sym+'_'+sess+'_'+dir+'_'+vwap]:
            ['asia','london','ny'].map(s=>sym+'_'+s+'_'+dir+'_'+vwap);
          // aggregate across sessions for non-stocks
          const cs=keys.map(k=>byKey[k]).filter(Boolean);
          const n=cs.reduce((s,c)=>s+c.trades.length,0);
          if(!n)return\`<td class="ez">—</td>\`;
          const allEV=cs.map(c=>c.ev?.bestEV).filter(v=>v!=null);
          const evV=allEV.length?allEV.reduce((s,v)=>s+v,0)/allEV.length:null;
          const allTPs=cs.map(c=>c.tp?.lockedRR).filter(v=>v!=null);
          const tpV=allTPs.length?Math.max(...allTPs):null;
          const cls=evV==null?'ez':evV>0?'ep':'en';
          const star=tpV?'★':'';
          return\`<td class="\${cls}" title="n=\${n} EV=\${evV!=null?evV.toFixed(3):'?'}">\${star}\${evV!=null?evV.toFixed(2):'?'}<br><span style="font-size:8px;color:var(--dim)">n=\${n}</span></td>\`;
        })
      ].join('')+'</tr>';
    }).join('');
  };
  make(FOREX,'fx');make(INDEX,'ix');make(COMM,'cm');make(STOCKS,'sk');
}

// ── 7. COMBO SELECTION ────────────────────────────────────
function renderComboFilter(combos){
  let d=[...combos];
  // Only show combos with ghost data or closed trades for combo filter
  if(cfF.show==='all')d=d.filter(c=>(c.ev?.count??0)>0||c.trades?.length>0||c.totalPnl!==0);
  else if(cfF.show==='ev+')d=d.filter(c=>(c.ev?.bestEV??0)>0);
  else if(cfF.show==='ev-')d=d.filter(c=>c.ev?.bestEV!=null&&c.ev.bestEV<0);
  else if(cfF.show==='min5')d=d.filter(c=>(c.ev?.count??0)>=5);
  if(cfF.sort==='ev')d.sort((a,b)=>(b.ev?.bestEV??-999)-(a.ev?.bestEV??-999));
  else if(cfF.sort==='pnl')d.sort((a,b)=>b.totalPnl-a.totalPnl);
  else if(cfF.sort==='winpct')d.sort((a,b)=>(b.ev?.bestEV??-999)-(a.ev?.bestEV??-999));
  else if(cfF.sort==='trades')d.sort((a,b)=>(b.ev?.count??0)-(a.ev?.count??0));
  const tb=document.getElementById('cf-body');
  if(!d.length){tb.innerHTML='<tr><td colspan="11" class="nodata">No traded combos yet</td></tr>';return;}
  tb.innerHTML=d.map((c,i)=>{
    const evV=c.ev?.bestEV??null;
    const ghostN=c.ev?.count??0;
    const ready=ghostN>=5;
    let action='—',aCls='d';
    if(ready){
      if(evV!=null&&evV>0.05){action='⬆ KEEP / SCALE';aCls='g';}
      else if(evV!=null&&evV<-0.05){action='⬇ CONSIDER CUT';aCls='r';}
      else{action='↔ NEUTRAL';aCls='y';}
    } else if(ghostN>0){action=\`need \${5-ghostN} more ghosts\`;aCls='d';}
    else{action='no data yet';aCls='d';}
    return\`<tr class="\${tClass(c.sym)}">
      <td class="d">\${i+1}</td>
      <td class="b fw">\${c.sym}</td>
      <td>\${tyBadge(c.type)}</td>
      <td>\${sBadge(c.sess)}</td>
      <td>\${dBadge(c.dir)}</td>
      <td>\${vBadge(c.vwap)}</td>
      <td class="\${ready?'y fw':ghostN>0?'c':'d'}">\${ghostN||'—'}</td>
      <td class="\${(c.ev?.avgRR??0)>=1?'g':c.ev?.avgRR!=null?'r':'d'}">\${c.ev?.avgRR!=null?f(c.ev.avgRR,2)+'R':'—'}</td>
      <td class="\${evC(evV)} fw">\${evV!=null?evV.toFixed(3):'—'}</td>
      <td class="\${pC(c.totalPnl)}">\${eu(c.totalPnl)}</td>
      <td class="\${aCls} fw" style="font-size:9.5px">\${action}</td>
    </tr>\`;
  }).join('');
}

function setCF(k,v,btn){cfF[k]=v;btn.closest('.fbar').querySelectorAll('.fb').forEach(b=>{if(b.getAttribute('onclick')?.includes("'"+k+"'"))b.classList.remove('on');});btn.classList.add('on');renderComboFilter(_evData);}

// ── SIGNAL STATS for session trades KPI ──────────────────
async function loadSignalStats(){
  const [sigD,statsD]=await Promise.all([api('/signal-stats'),api('/stats')]);
  if(sigD){
    const total=sigD.total||0;const placed=sigD.placed||0;
    const pct=total>0?((placed/total)*100).toFixed(0):'?';
    document.getElementById('k-tps').textContent=placed+' ('+pct+'%)';
  }
  if(statsD){
    document.getElementById('k-err').textContent=statsD.totalClosedTrades??'?';
  }
}

// ── SHADOW SL key count for KPI ──────────────────────────
async function prepareDeploy(){
  const statusEl=document.getElementById('deploy-status');
  const btn=document.getElementById('deploy-btn');
  // Step 1: Check status
  const st=await api('/admin/deploy-status');
  if(!st){statusEl.textContent='Error checking status';return;}
  if(st.safeToDeployNow){statusEl.textContent='✓ Already safe to deploy — 0 positions, 0 ghosts';return;}
  // Step 2: Confirm
  const msg='PREPARE DEPLOY\n\n'+(st.recommendation||'')+'\n\nThis will:\n1. Close '+st.openPositions+' open MT5 position(s)\n2. Finalize '+st.activeGhosts+' active ghost(s) to DB\n\nContinue?'
  if(!confirm(msg))return;
  btn.disabled=true;statusEl.textContent='Closing positions...';
  // Step 3: Close positions
  const secret=prompt('Enter WEBHOOK_SECRET:');
  if(!secret){btn.disabled=false;return;}
  const r1=await fetch(\`/admin/close-all-positions?secret=\${encodeURIComponent(secret)}\`,{method:'POST'});
  const d1=await r1.json().catch(()=>({}));
  if(d1.status!=='OK'){statusEl.textContent='Error closing positions: '+(d1.error||'unknown');btn.disabled=false;return;}
  statusEl.textContent=\`Closed \${d1.closed} position(s). Finalizing ghosts...\`;
  // Step 4: Finalize ghosts
  const r2=await fetch(\`/admin/finalize-all-ghosts?secret=\${encodeURIComponent(secret)}\`,{method:'POST'});
  const d2=await r2.json().catch(()=>({}));
  if(d2.status!=='OK'){statusEl.textContent='Error finalizing ghosts: '+(d2.error||'unknown');btn.disabled=false;return;}
  statusEl.textContent=\`✓ SAFE TO DEPLOY — Closed \${d1.closed} position(s), finalized \${d2.finalized} ghost(s). Push now.\`;
  btn.style.borderColor='var(--g)';btn.style.color='var(--g)';btn.textContent='✓ READY TO DEPLOY';
  await loadAll();
}

async function loadShadowCount(){
  const d=await api('/shadow');
  document.getElementById('k-sl').textContent=d?.results?.length??'?';
}

let _loadErrors=0,_lastLoad=null;
async function loadAll(){
  const tasks=[
    {name:'positions', fn:loadPositions},
    {name:'ghosts',    fn:loadGhosts},
    {name:'ev',        fn:loadEV},
    {name:'errors',    fn:loadErrors},
    {name:'stats',     fn:loadSignalStats},
    {name:'shadow',    fn:loadShadowCount},
  ];
  const t0=Date.now();
  const results=await Promise.allSettled(tasks.map(t=>
    t.fn().catch(e=>{console.error('[Dashboard] '+t.name+' failed:',e?.message||e);return null;})
  ));
  const failed=results.filter((r,i)=>r.status==='rejected'||(r.status==='fulfilled'&&r.value===null));
  _loadErrors=failed.length;_lastLoad=new Date();
  const elapsed=Date.now()-t0;
  const gsText=document.getElementById('gs-text');
  const gsErr=document.getElementById('gs-err');
  const gsTime=document.getElementById('gs-time');
  if(gsText)gsText.textContent=_loadErrors===0?'All sections loaded OK':''+_loadErrors+' section(s) failed — check dots above';
  if(gsErr)gsErr.textContent=_loadErrors>0?'⚠ '+_loadErrors+' error(s)':'';
  if(gsTime)gsTime.textContent='Last refresh: '+_lastLoad.toLocaleTimeString('nl-BE',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+' ('+elapsed+'ms)';
}

document.addEventListener('DOMContentLoaded',async()=>{
  initAll();
  // Check EV cache status first — show user what's happening
  const status=await api('/ev/status').catch(()=>null);
  const gsText=document.getElementById('gs-text');
  if(gsText){
    if(status?.building)gsText.textContent='EV cache wordt gebouwd op server — secties laden zodra klaar...';
    else if(status?.ready)gsText.textContent='EV cache klaar ('+status.count+' combos) — laden...';
    else gsText.textContent='Server starten — laden...';
  }
  loadAll();
  setInterval(loadAll,30000);
});
</script>
</body>
</html>`);
});


// 404
app.use((req, res) => res.status(404).json({ error: "Route not found", route: `${req.method} ${req.originalUrl}` }));

// ── Startup ───────────────────────────────────────────────────────
async function start() {
  const missing = ["META_API_TOKEN", "META_ACCOUNT_ID", "WEBHOOK_SECRET"].filter(k => !process.env[k]);
  if (missing.length) { console.error(`[ERR] Missing env: ${missing.join(", ")}`); process.exit(1); }

  console.log("🚀 PRONTO-AI v11.1 starting...");
  await initDB();

  // Load closed trades
  const trades = await loadAllTrades();
  closedTrades.push(...trades);
  console.log(`📂 ${trades.length} closed trades loaded`);

  // Load TP locks
  const savedTP = await loadTPConfig();
  Object.assign(tpLocks, savedTP);
  console.log(`🔒 ${Object.keys(tpLocks).length} TP locks loaded`);

  // FIX 12: Load ALL shadow analyses at startup
  const shadowRows = await loadAllShadowAnalysis();
  for (const row of shadowRows) shadowResults[row.optimizerKey] = row;
  console.log(`🌑 ${shadowRows.length} shadow analyses loaded`);

  // FIX 2: Load lot overrides from DB
  const dbLotOverrides = await loadLotOverrides();
  Object.assign(lotOverrides, dbLotOverrides);
  console.log(`📦 ${Object.keys(lotOverrides).length} lot overrides loaded from DB`);

  // FIX 19: Load key risk multipliers from DB
  const dbKeyMults = await loadKeyRiskMults();
  Object.assign(keyRiskMult, dbKeyMults);
  console.log(`📈 ${Object.keys(keyRiskMult).length} key risk multipliers loaded from DB`);

  // Load symbol risk overrides from DB + env
  const dbRisk = await loadSymbolRiskConfig();
  Object.assign(symbolRiskMap, dbRisk);
  for (const sym of Object.keys(SYMBOL_CATALOG)) {
    const envKey = `RISK_${sym}`;
    if (process.env[envKey]) {
      const pct = parseFloat(process.env[envKey]);
      symbolRiskMap[sym] = pct;
      await upsertSymbolRisk(sym, pct);
    }
    // Env lot overrides still supported (override DB value)
    const lotKey = `LOTS_${sym}`;
    if (process.env[lotKey]) lotOverrides[sym] = parseFloat(process.env[lotKey]);
  }
  console.log(`💰 Symbol risk overrides: ${Object.keys(symbolRiskMap).length}`);

  try {
    await fetchAccountInfo();
    console.log(`💵 Live MT5 balance: €${liveBalance.toFixed(2)}`);
  } catch (e) { console.warn(`[!] Could not fetch live balance: ${e.message}`); }

  const dr = await loadLatestDailyRisk();
  if (dr) console.log(`📊 Last daily risk record: ${dr.tradeDate}`);

  await restorePositionsFromMT5();

  // STARTUP: prefetch MT5 symbol specs voor alle catalog symbolen
  // Zo is de lotVal cache gevuld voor de eerste trade - geen fallback meer.
  console.log("Prefetching MT5 symbol specs...");
  const prefetchResults = { ok: 0, fallback: 0 };
  await Promise.allSettled(
    Object.entries(SYMBOL_CATALOG).map(async ([sym, info]) => {
      try {
        const spec = await fetchSymbolLotValue(info.mt5, info.type);
        if (spec.source === "mt5") prefetchResults.ok++;
        else prefetchResults.fallback++;
        console.log(`[SymSpec] ${sym} (${info.mt5}): lotVal=${spec.lotVal} source=${spec.source}`);
      } catch (e) {
        prefetchResults.fallback++;
        console.warn(`[SymSpec] ${sym}: prefetch failed - ${e.message}`);
      }
    })
  );
  console.log(`[SymSpec] Done: ${prefetchResults.ok} live van MT5, ${prefetchResults.fallback} fallback`);

  // FIX C: rebuild currency exposure na restore van open posities
  rebuildCurrencyExposure();
  console.log(`💱 Currency exposure rebuilt: ${JSON.stringify(Object.fromEntries(Object.entries(currencyExposure).map(([k,v])=>[k,v.toFixed(2)])))}`);

  // Pre-build EV cache in background — don't block server start
  console.log("[EV Cache] Starting background build...");
  rebuildEVCache().catch(() => {});

  app.listen(PORT, () => {
    console.log(`[✓] PRONTO-AI v11.0 on port ${PORT}`);
    console.log(`   🔹 Dashboard:      /`);
    console.log(`   🔹 Health:         /health`);
    console.log(`   🔹 EV Table:       /ev`);
    console.log(`   🔹 Shadow SL:      /shadow`);
    console.log(`   🔹 TP Locks:       /tp-locks`);
    console.log(`   🔹 Risk Config:    /risk-config`);
    console.log(`   🔹 Lot Overrides:  /lot-overrides`);
    console.log(`   🔹 Risk Mults:     /risk-multipliers`);
    console.log(`   🔹 Signal Stats:   /signal-stats`);
    console.log(`   🔹 Spread Stats:   /spread-stats?symbol=EURUSD&session=london`);
    console.log(`   🔹 Spread Log:     /spread-log?symbol=EURUSD&limit=200`);
    console.log(`   🔹 Webhook:        POST /webhook?secret=<secret>`);
    console.log(`   💵 Fixed risk:     ${(FIXED_RISK_PCT*100).toFixed(3)}% | Balance: €${liveBalance.toFixed(2)}`);
    console.log(`   🌍 MetaApi regio:  ${META_REGION} (wijzig via META_API_REGION env als 504 errors)`);
    console.log(`   💰 Curr budget:    ${(CURRENCY_BUDGET_PCT*100).toFixed(1)}% per valuta | TP floor: ${MIN_TP_RR_FLOOR}R`);
    console.log(`   🕐 Ghost max:      72h | SL buffer: ×${SL_BUFFER_MULT}`);
    console.log(`   📊 Mult threshold: ${MULT_MIN_SAMPLE} ghost samples`);
  });
}

start().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
