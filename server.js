// ===============================================================
// server.js  v10.8  |  PRONTO-AI
// TradingView → MetaApi REST → FTMO MT5
//
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
app.use((req, res, next) => {
  if (typeof req.body === "string" && req.body.trim().startsWith("{")) {
    try {
      req.body = JSON.parse(req.body);
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
const GHOST_MAX_MS            = 72 * 3600 * 1000;
const MULT_MIN_SAMPLE         = 30;

// FIX 16
const MAX_CLOSED_TRADES = 5000;
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
    const lotVal = cachedSpec?.lotVal ?? LOT_VALUE["forex"] ?? 100000;
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
    if (contractSize && tickSize && tickValue && tickSize > 0) {
      // lotValue = hoeveel account-currency verandert per 1 prijspunt per lot
      const lotVal = parseFloat((tickValue / tickSize).toFixed(6));
      symbolSpecCache[mt5Symbol] = { lotVal, contractSize, tickSize, tickValue, source: "mt5" };
      console.log(`[SymSpec] ${mt5Symbol}: contractSize=${contractSize} tickSize=${tickSize} tickValue=${tickValue} -> lotVal=${lotVal}`);
      return symbolSpecCache[mt5Symbol];
    }
  } catch (e) {
    console.warn(`[SymSpec] ${mt5Symbol}: kon spec niet ophalen (${e.message}) — gebruik fallback`);
  }
  // Fallback op statische LOT_VALUE
  const lotVal = LOT_VALUE[assetType] ?? 1;
  symbolSpecCache[mt5Symbol] = { lotVal, source: "fallback" };
  return symbolSpecCache[mt5Symbol];
}
// ── Lot calculation ───────────────────────────────────────────────
// v10.7: lotVal live opgehaald van MT5 via fetchSymbolLotValue().
// Fallback op statische LOT_VALUE als MetaApi spec niet beschikbaar.
// Retourneert object: { lots, lotVal, source }
async function calcLots(symbol, mt5Sym, assetType, entry, sl, riskEUR, evMult, dayMult) {
  const spec   = await fetchSymbolLotValue(mt5Sym, assetType);
  const lotVal = spec.lotVal;
  const dist   = Math.abs(entry - sl);
  if (!dist || !riskEUR) return { lots: 0.01, lotVal, source: spec.source };
  const baseLots = riskEUR / (dist * lotVal);
  const em       = (evMult  && evMult  > 0) ? evMult  : 1.0;
  const dm       = (dayMult && dayMult > 0) ? dayMult : 1.0;
  const lots     = Math.max(0.01, parseFloat((baseLots * em * dm).toFixed(2)));
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
    const lotVal  = cachedSpec?.lotVal ?? LOT_VALUE[type] ?? 1;
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

// Backwards compat alias (gebruikt door widenExistingTradeSL intern)
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

// FIX 14: single computeEVStats call
async function getOptimalTP(optimizerKey) {
  const locked = tpLocks[optimizerKey];
  if (locked) return locked.lockedRR;
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
  return parseFloat((Math.max(0, fav) / dist).toFixed(2));
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

// FIX 3: Find exact duplicate (same symbol + session + direction).
// Returns the existing position object or null.
function findExactDuplicate(symKey, session, direction) {
  return Object.values(openPositions).find(p =>
    p.symbol === symKey && p.session === session && p.direction === direction
  ) ?? null;
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
async function widenExistingTradeSL(pos, tpRR) {
  try {
    const newDist  = Math.abs(pos.entry - pos.sl) * 1.5;
    const newSL    = pos.direction === "buy"
      ? parseFloat((pos.entry - newDist).toFixed(5))
      : parseFloat((pos.entry + newDist).toFixed(5));
    const newTP    = calcTPPrice(pos.direction, pos.entry, newSL, tpRR);
    await metaFetch(`/positions/${pos.positionId}`, {
      method: "PUT",
      body:   JSON.stringify({ stopLoss: newSL, takeProfit: newTP }),
    }, 8000);
    pos.sl = newSL;
    pos.tp = newTP;
    console.log(`[AntiConsolid] ${pos.symbol} ${pos.positionId}: SL widened ${pos.sl}→${newSL}, TP→${newTP}`);
    logEvent({ type: "SL_WIDENED", symbol: pos.symbol, positionId: pos.positionId, oldSL: pos.sl, newSL, newTP, reason: "DUPLICATE_SIGNAL_STRENGTHENS_EXISTING" });
    return { newSL, newTP };
  } catch (e) {
    console.warn(`[AntiConsolid] widenSL failed for ${pos.positionId}: ${e.message}`);
    return null;
  }
}

// ── Ghost Optimizer ───────────────────────────────────────────────
// v10.7: Ghost tracker volgt de LIVE SL/TP uit openPositions, niet de
// gefixeerde waarden bij start. Als SL wijzigt (anti-consolidation,
// handmatig, of synced van MT5), worden phantomSL en tpRRUsed bijgewerkt.
// maxRR wordt altijd herberekend op de ACTUELE SL afstand op dat moment.
function startGhostTracker(pos) {
  // FIX 18: guard sl=0
  if (!pos.sl || pos.sl <= 0) {
    console.warn(`[Ghost] ${pos.positionId}: sl=0, ghost NOT started`);
    return;
  }
  if (ghostTrackers[pos.positionId]) return;

  const { positionId, symbol, session, direction, vwapPosition,
          optimizerKey, entry, sl, slPct, tpRRUsed, openedAt } = pos;
  // FIX 10: mt5Symbol fallback
  const mt5Symbol = pos.mt5Symbol || getSymbolInfo(symbol)?.mt5 || symbol;

  let maxPrice    = entry;
  let timer       = null;
  const startTs   = Date.now();

  // v10.7: sla GEEN vaste phantomSL op — lees live uit openPositions elke tick
  // zodat SL wijzigingen automatisch worden meegenomen.
  // Bewaar wel de originele SL voor logging/fallback (als positie al gesloten is).
  const originalSL     = sl;
  const originalSlPct  = slPct;
  const originalTpRR   = tpRRUsed;

  ghostTrackers[positionId] = {
    positionId, symbol, mt5Symbol, session, direction,
    vwapPosition, optimizerKey, entry,
    sl: originalSL,           // wordt live bijgehouden in tick()
    slPct: originalSlPct,
    tpRRUsed: originalTpRR,   // wordt live bijgehouden in tick()
    openedAt, maxPrice, startTs, timer,
    slChanges: 0,             // teller: hoe vaak SL gewijzigd is
    tpChanges: 0,
  };

  async function tick() {
    try {
      if (!ghostTrackers[positionId]) return;
      const g       = ghostTrackers[positionId];
      const elapsed = Date.now() - startTs;
      if (elapsed >= GHOST_MAX_MS) { await finalizeGhost(positionId, "timeout_72h", elapsed, maxPrice); return; }
      const { day } = getBrusselsComponents();
      if (day === 0 || day === 6) {
        timer = setTimeout(tick, 10 * 60 * 1000);
        g.timer = timer;
        return;
      }

      // v10.7: lees LIVE SL/TP uit openPositions als positie nog open is
      const livePos = openPositions[positionId];
      if (livePos) {
        const liveSL = livePos.sl;
        const liveTP = livePos.tp;
        const liveTpRR = livePos.tpRRUsed;

        // Detecteer SL wijziging en update ghost
        if (liveSL && liveSL > 0 && liveSL !== g.sl) {
          console.log(`[Ghost] ${positionId}: SL bijgewerkt ${g.sl}→${liveSL} (wijziging #${g.slChanges + 1})`);
          g.sl = liveSL;
          g.slChanges++;
        }
        // Detecteer TP wijziging en update ghost tpRRUsed
        if (liveTpRR && liveTpRR !== g.tpRRUsed) {
          g.tpRRUsed = liveTpRR;
          g.tpChanges++;
        }
      }

      const phantomSL = g.sl;  // altijd de meest actuele SL

      const priceData = await fetchCurrentPrice(mt5Symbol);
      const price     = priceData?.mid ?? null;
      if (price !== null) {
        // maxRR altijd berekend op ACTUELE SL afstand
        const better = direction === "buy" ? price > maxPrice : price < maxPrice;
        if (better) {
          maxPrice = price;
          g.maxPrice = price;
          g.maxRR = calcMaxRR(direction, entry, phantomSL, price);
        }
        const slHit = direction === "buy" ? price <= phantomSL : price >= phantomSL;
        if (slHit) { await finalizeGhost(positionId, "phantom_sl", elapsed, maxPrice); return; }
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
  timer = setTimeout(tick, GHOST_POLL_MS);
  ghostTrackers[positionId].timer = timer;
  console.log(`[Ghost] Started: ${positionId} | ${optimizerKey} | sl=${sl} (live tracking actief)`);
}

async function finalizeGhost(positionId, stopReason, elapsedMs, finalMaxPrice) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];

  // v10.7: maxRR berekend op de FINALE actuele SL (inclusief alle wijzigingen)
  const finalSL       = g.sl;   // is de meest recente SL na live tracking
  const maxRRBeforeSL = calcMaxRR(g.direction, g.entry, finalSL, finalMaxPrice);
  const timeToSLMin   = Math.round(elapsedMs / 60000);
  const phantomSLHit  = stopReason === "phantom_sl";

  const ghostRow = {
    positionId: g.positionId, symbol: g.symbol, session: g.session,
    direction: g.direction, vwapPosition: g.vwapPosition, optimizerKey: g.optimizerKey,
    entry: g.entry, sl: finalSL, slPct: g.slPct, phantomSL: finalSL, tpRRUsed: g.tpRRUsed,
    maxPrice: finalMaxPrice, maxRRBeforeSL, phantomSLHit, stopReason,
    timeToSLMin: phantomSLHit ? timeToSLMin : null,
    openedAt: g.openedAt, closedAt: new Date().toISOString(),
    slChanges: g.slChanges ?? 0,    // v10.7: aantal SL wijzigingen tijdens trade
    tpChanges: g.tpChanges ?? 0,    // v10.7: aantal TP wijzigingen tijdens trade
  };

  await saveGhostTrade(ghostRow);
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

  console.log(`[Ghost] Finalized: ${positionId} | key=${g.optimizerKey} | finalSL=${finalSL} | maxRR=${maxRRBeforeSL}R | slChanges=${ghostRow.slChanges} | slHit=${phantomSLHit}`);
}

function cancelGhost(positionId) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];
}

// ── Shadow Optimizer ──────────────────────────────────────────────
async function runShadowOptimizer(optimizerKey) {
  try {
    const snaps = await loadShadowSnapshots(optimizerKey, 10000);
    if (snaps.length < 10) return;
    const vals   = snaps.map(s => s.pctSlUsed).sort((a, b) => a - b);
    const n      = vals.length;
    const pct    = (p) => vals[Math.min(n - 1, Math.floor(p / 100 * n))];
    const p50    = pct(50), p90 = pct(90), p99 = pct(99);
    const maxUsed = vals[n - 1];
    const recommendedSlPct = parseFloat((p99 / 100).toFixed(4));
    const tooWide          = p99 < 70;
    const potentialSaving  = tooWide ? parseFloat((100 - p99).toFixed(1)) : 0;
    const uniquePos        = new Set(snaps.map(s => s.positionId)).size;
    const analysis = {
      optimizerKey,
      symbol:        optimizerKey.split("_")[0],
      session:       optimizerKey.split("_")[1] ?? "",
      direction:     optimizerKey.split("_")[2] ?? "",
      vwapPosition:  optimizerKey.split("_")[3] ?? "unknown",
      snapshotsCount: n, positionsCount: uniquePos,
      p50, p90, p99, maxUsed, recommendedSlPct,
      currentSlTooWide: tooWide, potentialSavingPct: potentialSaving,
    };
    shadowResults[optimizerKey] = analysis;
    await saveShadowAnalysis(analysis);
    console.log(`[Shadow] ${optimizerKey}: p99=${p99}% tooWide=${tooWide}`);
  } catch (e) { console.warn(`[Shadow] ${optimizerKey}:`, e.message); }
}

async function runAllShadowOptimizers() {
  const keys = new Set(Object.values(openPositions).map(p => p.optimizerKey).filter(Boolean));
  for (const key of Object.keys(shadowResults)) keys.add(key);
  for (const key of keys) await runShadowOptimizer(key).catch(() => {});
}

// ── Position sync (FIX 9: rate-limited, FIX 13: clear restore flag) ──
// v10.7: live SL/TP wijzigingen van MT5 worden opgepikt en dashboard
// waarden (slDistPct, tpRRActual) worden automatisch herberekend.
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

      // v10.7 FIX 2: Oppikken van SL/TP wijzigingen die in MT5 zijn gedaan
      // (handmatig of via anti-consolidation). RR en slDistPct worden live herberekend.
      const liveSL = livePos.stopLoss  ?? local.sl;
      const liveTP = livePos.takeProfit ?? local.tp;
      if (liveSL !== local.sl || liveTP !== local.tp) {
        const oldSL = local.sl, oldTP = local.tp;
        local.sl = liveSL;
        local.tp = liveTP;
        // Herbereken slDist en tpRR op basis van nieuwe SL/TP
        const slDist = local.sl > 0 ? Math.abs(local.entry - local.sl) : 0;
        if (slDist > 0) {
          local.tpRRUsed = local.tp
            ? parseFloat((Math.abs(local.tp - local.entry) / slDist).toFixed(3))
            : local.tpRRUsed;
        }
        console.log(`[Sync] ${id}: SL/TP gewijzigd in MT5 — SL ${oldSL}→${liveSL} TP ${oldTP}→${liveTP} tpRR→${local.tpRRUsed}`);
        logEvent({ type: "SL_TP_SYNCED_FROM_MT5", positionId: id, symbol: local.symbol,
          oldSL, newSL: liveSL, oldTP, newTP: liveTP, tpRRNew: local.tpRRUsed });
      }

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
async function restorePositionsFromMT5() {
  try {
    const live = await fetchOpenPositions();
    if (!Array.isArray(live) || !live.length) return;
    let restored = 0;
    for (const lp of live) {
      const id = String(lp.id);
      if (openPositions[id]) continue;
      const sym    = normalizeSymbol(lp.symbol) ?? lp.symbol;
      const dir    = lp.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
      const entry  = lp.openPrice ?? lp.currentPrice ?? 0;
      const sess   = getSession(lp.time ? new Date(lp.time) : null);
      const vpPos  = "unknown";
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
      if (openPositions[id].sl > 0) {
        console.log(`[Restart] Ghost for ${sym} (${id}): entry=${entry}`);
        startGhostTracker(openPositions[id]);
      }
      restored++;
    }
    console.log(`[Restart] ${restored} position(s) restored from MT5`);
  } catch (e) { console.warn("[Restart]", e.message); }
}

// ── Shadow snapshot cron ──────────────────────────────────────────
// v10.7: snapshots gebruiken altijd de LIVE sl uit openPositions
// (gesynchet via syncOpenPositions elke 55s). pctSlUsed is dus altijd
// berekend op de actuele SL, ook na anti-consolidation widenings.
// De snapshot slaat ook de actuele sl waarde op voor later terugkijken.
async function takeShadowSnapshots() {
  const positions = Object.values(openPositions).filter(p => p.sl > 0 && !p.restoredAfterRestart);
  for (const pos of positions) {
    try {
      const mt5Sym = pos.mt5Symbol || getSymbolInfo(pos.symbol)?.mt5 || pos.symbol;
      const pd = await fetchCurrentPrice(mt5Sym);
      if (!pd) continue;
      // Gebruik altijd de LIVE sl (kan gewijzigd zijn door sync of anti-consolidation)
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
        const newDayMult = parseFloat((prev.dayMult * 1.2).toFixed(4));
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
  if (bandWidth > 0 && vwapMid > 0) {
    const distFromMid = Math.abs(closePrice - vwapMid);
    vwapBandPct = parseFloat((distFromMid / (bandWidth / 2)).toFixed(3));
    if (vwapBandPct > 0.9) {
      const reason = `VWAP_BAND_EXHAUSTED: ${(vwapBandPct * 100).toFixed(0)}% into band`;
      logReject("VWAP_BAND_EXHAUSTED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        closePrice, vwapMid, vwapUpper, vwapLower,
        vwapBandPct: (vwapBandPct * 100).toFixed(1) + "%",
        vwapPosition, derivedSlPct: slPctHuman,
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "REJECTED", reason, symbol: symKey, direction, optimizerKey, vwapBandPct });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "REJECTED", rejectReason: reason }).catch(() => {});
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

  // ── FIX C: Anti-consolidation ─────────────────────────────────────
  // Zelfde symbol + sessie + richting al open → modifyPosition() SL ×1.5
  // cumulatief op huidige MT5 SL + TP herberekend. Geen nieuwe trade.
  // Geldt voor ALLE asset types (niet alleen forex).
  {
    const exactDup = findExactDuplicate(symKey, session, direction);
    if (exactDup) {
      const tpRRForDup = await getOptimalTP(exactDup.optimizerKey);
      await widenExistingTradeSL(exactDup, tpRRForDup);
      const reason = `ANTI_CONSOLIDATION: ${symKey} ${session} ${direction} al open — SL ×1.5 cumulatief op bestaande trade`;
      logReject("CONSOLIDATION_SL_WIDENED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        existingPositionId: exactDup.positionId,
        existingEntry: exactDup.entry, existingSlBefore: exactDup.sl,
        closePrice, derivedSlPct: slPctHuman,
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "CONSOLIDATION_SL_WIDENED", symbol: symKey, direction, session, positionId: exactDup.positionId, reason });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "CONSOLIDATION_SL_WIDENED", rejectReason: reason }).catch(() => {});
      return res.status(200).json({ status: "CONSOLIDATION_SL_WIDENED", reason, existingPositionId: exactDup.positionId });
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

  // FIX 3 Rule B: same-currency other pairs (forex only)
  const relatedCount = (assetType === "forex") ? countRelatedForex(symKey, direction) : 0;
  const lotDivisor   = relatedCount > 0 ? (relatedCount + 1) : 1;
  if (relatedCount > 0) {
    console.log(`[AntiConsolid] ${symKey}: ${relatedCount} related ${direction} pairs → lots ÷${lotDivisor}`);
    logEvent({ type: "LOTS_DIVIDED_FOREX", symbol: symKey, direction, relatedCount, lotDivisor });
  }

  const tpRR    = await getOptimalTP(optimizerKey);
  const rrLabel = tpRR % 1 === 0 ? `${tpRR}R` : `${tpRR.toFixed(1)}R`;

  // Voorlopige SL voor lot berekening (op closePrice) — lotVal wordt live bijgewerkt
  const tempSL   = calcSLFromDerivedPct(direction, closePrice || 1, derivedSlPct);
  const symInfoL = getSymbolInfo(symKey);
  let   lotVal   = LOT_VALUE[symInfoL?.type || "stock"] ?? 1; // fallback, overschreven door live MT5 spec
  const tempDist = Math.abs((closePrice || 1) - tempSL);

  let lots;
  if (lotOverrides[symKey]) {
    // Lot override: baseLots × evMult × dayMult (of ×1 voor neutraal)
    const base = lotOverrides[symKey];
    lots = isEvPlus
      ? parseFloat((base * evMult * dayMult / lotDivisor).toFixed(2))
      : parseFloat((base / lotDivisor).toFixed(2));
    console.log(`[Lots] ${symKey}: override=${base} evMult=${evMult.toFixed(2)} dayMult=${dayMult.toFixed(2)} ÷${lotDivisor} = ${lots}`);
  } else {
    // Live lotVal van MT5 spec — gecached na eerste keer
    const calcResult = await calcLots(symKey, mt5Symbol, assetType, closePrice || 1, tempSL, riskEUR, evMult, dayMult);
    lots = calcResult.lots;
    lotVal = calcResult.lotVal; // update lotVal met live waarde voor currency budget check
    if (lotDivisor > 1) lots = Math.max(0.01, parseFloat((lots / lotDivisor).toFixed(2)));
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
  const comment   = `NV-${dirShort}-${symKey.slice(0, 6)}-${rrLabel}-${sessShort}`.slice(0, 26);
  const orderPayload = {
    symbol: mt5Symbol,
    actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    volume: lots, comment,
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
  let executionPrice = closePrice;
  let spread = 0, bid = null, ask = null;
  try {
    await new Promise(r => setTimeout(r, 2500)); // verhoogd van 600ms → 2500ms (MetaApi positie beschikbaarheid)
    const positions = await fetchOpenPositions();
    const thisPos   = Array.isArray(positions) ? positions.find(p => String(p.id) === positionId) : null;
    if (thisPos?.openPrice) executionPrice = parseFloat(thisPos.openPrice);
    const pd = await fetchCurrentPrice(mt5Symbol);
    if (pd) { bid = pd.bid; ask = pd.ask; spread = pd.spread ?? 0; }
  } catch { /* fallback */ }

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

  // Step C2: Recalculate lots op executionPrice (als geen override) — nu met live lotVal
  if (!lotOverrides[symKey]) {
    const calcResult2 = await calcLots(symKey, mt5Symbol, assetType, executionPrice, mt5SL, riskEUR, evMult, dayMult);
    lots   = calcResult2.lots;
    lotVal = calcResult2.lotVal; // live lotVal na executie (spec al gecached)
    if (lotDivisor > 1) lots = Math.max(0.01, parseFloat((lots / lotDivisor).toFixed(2)));
    // FIX C: herbereken scaleFactor op echte dist met live lotVal
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

  // Step D: Set SL + TP — retry up to 3×
  let slTpSet = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await metaFetch(`/positions/${positionId}`, { method: "PUT", body: JSON.stringify({ stopLoss: mt5SL, takeProfit: mt5TP }) }, 8000);
      console.log(`[SL/TP] ${positionId} → SL=${mt5SL} TP=${mt5TP} (${tpRR}R) exec=${executionPrice} attempt=${attempt}`);
      slTpSet = true; break;
    } catch (e) {
      console.warn(`[!] SL/TP attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt < 5) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  if (!slTpSet) {
    logEvent({ type: "SL_TP_SET_FAILED", positionId, symbol: symKey, executionPrice, mt5SL, mt5TP, note: "5 retries exhausted" });
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
    const info    = getSymbolInfo(p.symbol);
    const type    = info?.type || "stock";
    const lotVal  = LOT_VALUE[type] ?? 1;
    const slDist  = p.sl > 0 ? Math.abs(p.entry - p.sl) : 0;
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
  const ghosts = Object.values(ghostTrackers).map(g => ({
    positionId: g.positionId, symbol: g.symbol, optimizerKey: g.optimizerKey,
    direction: g.direction, session: g.session, vwapPosition: g.vwapPosition,
    entry: g.entry, sl: g.sl, maxPrice: g.maxPrice,
    phantomSL: g.sl,   // alias zodat dashboard code consistent is met history
    maxRR: calcMaxRR(g.direction, g.entry, g.sl, g.maxPrice),
    tpRRUsed: g.tpRRUsed,
    elapsedMin: Math.round((Date.now() - g.startTs) / 60000),
    slChanges: g.slChanges ?? 0,
    tpChanges: g.tpChanges ?? 0,
  }));
  res.json({ count: ghosts.length, ghosts });
});

app.get("/ghosts/history", async (req, res) => {
  const { key, limit = 100 } = req.query;
  const rows = await loadGhostTrades(key || null, parseInt(limit));
  res.json({ count: rows.length, rows });
});

app.get("/ev/:key", async (req, res) => {
  const ev = await computeEVStats(decodeURIComponent(req.params.key));
  res.json(ev);
});

app.get("/ev", async (req, res) => {
  const keys = new Set([...Object.keys(tpLocks), ...closedTrades.map(t => buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown"))]);
  const results = [];
  for (const key of keys) { const ev = await computeEVStats(key); results.push({ key, ...ev }); }
  results.sort((a, b) => (b.bestEV ?? -99) - (a.bestEV ?? -99));
  res.json(results);
});

app.get("/shadow", (req, res) => {
  const results = Object.values(shadowResults).sort((a, b) => a.optimizerKey.localeCompare(b.optimizerKey));
  res.json({ count: results.length, results });
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

// ── TEST endpoint — gebruik dit om Railway connectie te verifiëren ──
// GET  /test           → bevestigt dat Railway draait
// POST /test           → echo's de body terug zodat je TV webhook kunt testen
// Gebruik: curl -X POST https://JOUW-URL/test -H "Content-Type: application/json" -d '{"hello":"world"}'
// Of in TV webhook URL: https://JOUW-URL/test (geen secret nodig)
app.get("/test", (req, res) => {
  res.json({
    status: "Railway is bereikbaar",
    version: "10.8.0",
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
    status: "ok", version: "10.8.0", time: getBrusselsDateStr(),
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
<title>PRONTO-AI v10.8</title>
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
/* HEADER */
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
.kbar{display:grid;grid-template-columns:repeat(8,1fr);border-bottom:1px solid var(--bdr2);background:var(--bdr)}
.kpi{background:var(--bg1);padding:10px 14px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px}
.k0::after{background:var(--g)}.k1::after{background:var(--b)}.k2::after{background:var(--p)}.k3::after{background:var(--y)}.k4::after{background:var(--c)}.k5::after{background:var(--o)}.k6::after{background:var(--o)}.k7::after{background:var(--r)}
.kl{font-size:8px;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:4px;font-family:var(--fh)}
.kv{font-size:18px;font-weight:700;line-height:1;font-family:var(--fh);letter-spacing:.5px}
/* MAIN */
.main{padding:14px 18px;display:flex;flex-direction:column;gap:14px}
/* SECTION */
.sec{border:1px solid var(--bdr2);border-radius:3px;overflow:hidden}
.sh{padding:8px 14px;background:var(--bg2);border-bottom:1px solid var(--bdr2);display:flex;align-items:center;justify-content:space-between;gap:8px}
.st{font-family:var(--fh);font-size:13px;font-weight:700;letter-spacing:.8px}
.sm{font-size:9px;color:var(--dim);letter-spacing:.4px}
/* TABLE */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:10.5px}
thead tr{background:var(--bg2);border-bottom:1px solid var(--bdr2)}
th{padding:6px 8px;text-align:left;font-size:8.5px;letter-spacing:.7px;color:var(--dim);text-transform:uppercase;white-space:nowrap;font-family:var(--fh);font-weight:600;user-select:none}
th.s{cursor:pointer}th.s:hover{color:var(--b)}
th.s.asc::after{content:' ↑';color:var(--b)}th.s.desc::after{content:' ↓';color:var(--b)}
td{padding:5px 8px;border-bottom:1px solid var(--bdr);white-space:nowrap;vertical-align:middle}
tbody tr:hover{background:rgba(40,180,240,.035)}
tbody tr:last-child td{border-bottom:none}
.nodata{text-align:center;padding:16px;color:var(--dim);font-size:10px;letter-spacing:.4px}
.zrow{opacity:.32}.zrow:hover{opacity:.6}
/* BADGES */
.bd{display:inline-block;padding:2px 5px;border-radius:2px;font-size:8.5px;font-weight:700;letter-spacing:.4px;font-family:var(--fh)}
.bd-buy{background:rgba(0,232,160,.12);color:var(--g);border:1px solid rgba(0,232,160,.25)}.bd-sell{background:rgba(255,45,85,.12);color:var(--r);border:1px solid rgba(255,45,85,.25)}
.bd-ab{background:rgba(40,180,240,.12);color:var(--b);border:1px solid rgba(40,180,240,.25)}.bd-bw{background:rgba(168,120,255,.12);color:var(--p);border:1px solid rgba(168,120,255,.25)}
.bd-tp{background:rgba(0,232,160,.15);color:var(--g)}.bd-sl{background:rgba(255,45,85,.15);color:var(--r)}.bd-mn{background:rgba(240,190,32,.12);color:var(--y)}
.bd-as{background:rgba(0,220,212,.1);color:var(--c)}.bd-lo{background:rgba(0,232,160,.1);color:var(--g)}.bd-ny{background:rgba(168,120,255,.1);color:var(--p)}.bd-out{background:rgba(46,64,96,.15);color:var(--dim)}
.bd-evp{background:rgba(0,232,160,.18);color:var(--g);border:1px solid rgba(0,232,160,.3)}.bd-evn{background:rgba(255,45,85,.15);color:var(--r);border:1px solid rgba(255,45,85,.25)}
.bd-lck{background:rgba(240,190,32,.18);color:var(--y);border:1px solid rgba(240,190,32,.3)}
.bd-fx{background:rgba(0,220,212,.1);color:var(--c)}.bd-ix{background:rgba(240,190,32,.1);color:var(--y)}.bd-cm{background:rgba(255,128,32,.1);color:var(--o)}.bd-sk{background:rgba(40,180,240,.1);color:var(--b)}
.bd-er{background:rgba(255,45,85,.18);color:var(--r);border:1px solid rgba(255,45,85,.3);font-size:8px;padding:1px 4px}
/* COLORS */
.g{color:var(--g)}.r{color:var(--r)}.b{color:var(--b)}.y{color:var(--y)}.p{color:var(--p)}.c{color:var(--c)}.o{color:var(--o)}.d{color:var(--dim)}.fw{font-weight:700}
/* TYPE BORDER */
tr.ts td:first-child{border-left:2px solid rgba(40,180,240,.3)}tr.tf td:first-child{border-left:2px solid rgba(0,220,212,.3)}tr.ti td:first-child{border-left:2px solid rgba(240,190,32,.3)}tr.tc td:first-child{border-left:2px solid rgba(255,128,32,.3)}
/* SL BAR */
.slbar{display:flex;align-items:center;gap:4px;min-width:66px}
.slbg{height:3px;flex:1;background:var(--dim2);border-radius:2px;overflow:hidden}
.slfi{height:100%;border-radius:2px;background:var(--g);transition:width .3s}
.slfi.w{background:var(--o)}.slfi.d{background:var(--r)}
/* FILTER BAR */
.fbar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:8px 12px;border-bottom:1px solid var(--bdr2);background:var(--card,var(--bg1))}
.fl{font-size:9px;color:var(--dim);letter-spacing:.4px;margin-right:2px;font-family:var(--fh)}
.fb{background:none;border:1px solid var(--bdr2);color:var(--dim);padding:3px 8px;border-radius:2px;cursor:pointer;font-family:var(--fn);font-size:9px;transition:all .12s}
.fb.on{background:rgba(40,180,240,.1);color:var(--b);border-color:var(--b)}
/* STATS STRIP */
.strip{display:flex;gap:18px;padding:8px 14px;border-bottom:1px solid var(--bdr2);background:var(--bg2);flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:1px}
.sl2{font-size:8px;color:var(--dim);letter-spacing:.7px;text-transform:uppercase;font-family:var(--fh)}
.sv2{font-size:13px;font-weight:700;font-family:var(--fh)}
/* EV MATRIX */
.mxw{overflow-x:auto;padding:10px 14px;background:var(--bg2)}
.mxg{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-width:680px}
.mxt{font-family:var(--fh);font-size:10px;font-weight:700;letter-spacing:.7px;color:var(--dim);padding:0 0 4px;border-bottom:1px solid var(--bdr2);margin-bottom:4px}
.mx table{font-size:10px}.mx th{font-size:8px;padding:4px 6px}.mx td{padding:4px 7px;text-align:center;border-right:1px solid var(--bdr)}
.mx td:last-child{border-right:none}.mx td.sym{text-align:left;font-weight:700;color:var(--y);font-family:var(--fh);font-size:10px;position:sticky;left:0;background:var(--bg2);z-index:1;border-right:1px solid var(--bdr2)}
.ep{color:var(--g)}.en{color:var(--r)}.ez{color:var(--dim)}
/* LOT CALC */
.lotbox{padding:14px;background:var(--bg2);display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.lc{border:1px solid var(--bdr2);border-radius:3px;padding:12px 14px}
.lct{font-family:var(--fh);font-size:11px;font-weight:700;letter-spacing:.6px;margin-bottom:8px}
.lcf{font-size:10.5px;line-height:1.75}
.lcf code{color:var(--y);background:var(--bg);padding:1px 4px;border-radius:2px;font-size:10px}
.formula{background:var(--bg);border:1px solid var(--bdr2);border-radius:3px;padding:10px 12px;margin:8px 0;font-size:10px;color:var(--g);line-height:1.8}
.chlist{margin:0;padding-left:14px;line-height:1.9}
.chlist li{font-size:10px}.chlist li b{color:var(--o)}
/* OPT TIPS */
.tips{padding:12px 14px;background:var(--bg2);display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px}
.tip{border:1px solid var(--bdr2);border-radius:3px;padding:10px 12px}
.tipt{font-family:var(--fh);font-size:10px;font-weight:700;letter-spacing:.4px;margin-bottom:5px}
.tipb{font-size:9.5px;line-height:1.65}
.tip-g{border-color:rgba(0,232,160,.3)}.tip-g .tipt{color:var(--g)}
.tip-y{border-color:rgba(240,190,32,.3)}.tip-y .tipt{color:var(--y)}
.tip-r{border-color:rgba(255,45,85,.3)}.tip-r .tipt{color:var(--r)}
.tip-b{border-color:rgba(40,180,240,.3)}.tip-b .tipt{color:var(--b)}
/* EMPTY STATE */
.empty{display:flex;align-items:center;gap:10px;padding:14px 16px;color:var(--dim);font-size:10px}
.eline{flex:1;height:1px;background:var(--bdr2)}
@media(max-width:900px){.kbar{grid-template-columns:repeat(4,1fr)}.lotbox{grid-template-columns:1fr}.mxg{grid-template-columns:1fr}}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="logo">PRONTO-AI</div>
    <div class="ver">v10.8 · TradingView → MetaApi → FTMO MT5 · Fixed Risk ${(FIXED_RISK_PCT*100).toFixed(3)}% · SL Buffer ×${SL_BUFFER_MULT} · Fix A/C/D/E actief</div>
  </div>
  <div class="hdr-r">
    <span class="sb s-outside" id="hdr-sess">—</span>
    <span class="clock" id="clock">--:--:--</span>
    <button class="rbtn" onclick="loadAll()">↻ REFRESH</button>
  </div>
</div>

<div class="kbar">
  <div class="kpi k0"><div class="kl">Balance MT5</div><div class="kv g">€<span id="k-bal">${balance.toFixed(0)}</span></div></div>
  <div class="kpi k1"><div class="kl">Open Trades</div><div class="kv b" id="k-pos">—</div></div>
  <div class="kpi k2"><div class="kl">Ghosts</div><div class="kv p" id="k-gh">—</div></div>
  <div class="kpi k3"><div class="kl">TP Locks EV+</div><div class="kv y" id="k-tp">—</div></div>
  <div class="kpi k4"><div class="kl">Session</div><div class="kv c" id="k-sess" style="font-size:14px">—</div></div>
  <div class="kpi k5"><div class="kl">Risk %</div><div class="kv o">${(FIXED_RISK_PCT*100).toFixed(3)}%</div></div>
  <div class="kpi k6"><div class="kl">Lot Overrides</div><div class="kv o" id="k-lots">—</div></div>
  <div class="kpi k7"><div class="kl">Errors</div><div class="kv r" id="k-err">—</div></div>
</div>

<div class="main">

<!-- 1. OPEN POSITIONS -->
<div class="sec">
  <div class="sh"><span class="st g">▸ OPEN POSITIONS</span><span class="sm" id="pos-meta">loading…</span></div>
  <div id="pos-empty" class="empty" style="display:none"><div class="eline"></div><span>0 open trades</span><div class="eline"></div></div>
  <div class="tw" id="pos-wrap">
    <table id="pos-tbl">
      <thead><tr>
        <th class="s" data-col="0">Pair</th><th class="s" data-col="1">Dir</th><th class="s" data-col="2">VWAP</th><th class="s" data-col="3">Session</th>
        <th class="s" data-col="4">Entry</th><th class="s" data-col="5">SL</th><th class="s" data-col="6">SL Dist%</th><th>SL Used%</th>
        <th class="s" data-col="8">Max RR</th><th class="s" data-col="9">TP</th><th class="s" data-col="10">TP RR live</th>
        <th class="s" data-col="11">PnL €</th><th class="s" data-col="12">PnL %</th><th class="s" data-col="13">Lots</th>
        <th class="s" data-col="14" title="Basis riskEUR = balance x pct (puur)">Risk € basis</th>
        <th class="s" data-col="15" title="Werkelijk verlies bij SL: lots x dist x lotVal">Risk € echt</th>
        <th class="s" data-col="16" title="Werkelijk risico als % van balance">Risk % echt</th>
        <th>EV+</th><th>Ghost</th><th class="s" data-col="19">Opened</th>
      </tr></thead>
      <tbody id="pos-body"><tr><td colspan="20" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 2. TP OPTIMISER -->
<div class="sec">
  <div class="sh"><span class="st y">▸ TP OPTIMISER</span><span class="sm" id="ov-meta">loading…</span></div>
  <div class="fbar">
    <span class="fl">Type:</span>
    <button class="fb on" onclick="setOF('type','all',this)">All</button>
    <button class="fb" onclick="setOF('type','forex',this)">Forex</button>
    <button class="fb" onclick="setOF('type','index',this)">Index</button>
    <button class="fb" onclick="setOF('type','commodity',this)">Commodity</button>
    <button class="fb" onclick="setOF('type','stock',this)">Stock</button>
    &nbsp;<span class="fl">Session:</span>
    <button class="fb on" onclick="setOF('sess','all',this)">All</button>
    <button class="fb" onclick="setOF('sess','asia',this)">Asia</button>
    <button class="fb" onclick="setOF('sess','london',this)">London</button>
    <button class="fb" onclick="setOF('sess','ny',this)">NY</button>
    &nbsp;<span class="fl">Dir:</span>
    <button class="fb on" onclick="setOF('dir','all',this)">All</button>
    <button class="fb" onclick="setOF('dir','buy',this)">Buy</button>
    <button class="fb" onclick="setOF('dir','sell',this)">Sell</button>
    &nbsp;<span class="fl">VWAP:</span>
    <button class="fb on" onclick="setOF('vwap','all',this)">All</button>
    <button class="fb" onclick="setOF('vwap','above',this)">Above</button>
    <button class="fb" onclick="setOF('vwap','below',this)">Below</button>
    &nbsp;<span class="fl">Show:</span>
    <button class="fb on" onclick="setOF('show','all',this)">All rows</button>
    <button class="fb" onclick="setOF('show','traded',this)">Traded only</button>
  </div>
  <div class="strip">
    <div class="stat"><span class="sl2">Combos</span><span class="sv2 b" id="ov-count">—</span></div>
    <div class="stat"><span class="sl2">Trades</span><span class="sv2 c" id="ov-trades">—</span></div>
    <div class="stat"><span class="sl2">Wins</span><span class="sv2 g" id="ov-wins">—</span></div>
    <div class="stat"><span class="sl2">Win%</span><span class="sv2 g" id="ov-winpct">—</span></div>
    <div class="stat"><span class="sl2">Total PnL</span><span class="sv2" id="ov-pnl">—</span></div>
    <div class="stat"><span class="sl2">EV+ Combos</span><span class="sv2 y" id="ov-evp">—</span></div>
  </div>
  <div class="tw">
    <table id="ov-tbl">
      <thead><tr>
        <th class="s" data-col="0">Symbol</th><th class="s" data-col="1">Type</th><th class="s" data-col="2">Session</th>
        <th class="s" data-col="3">Dir</th><th class="s" data-col="4">VWAP</th><th class="s" data-col="5">#Trades</th>
        <th class="s" data-col="6">Win%</th><th class="s" data-col="7">Avg RR</th><th class="s" data-col="8">Best RR</th>
        <th class="s" data-col="9">EV</th><th>EV+</th><th class="s" data-col="11">TP Lock</th>
        <th class="s" data-col="12">Total PnL</th><th class="s" data-col="13">Avg PnL</th>
        <th class="s" data-col="14">SL%(all)</th><th class="s" data-col="15">SL%(W)</th>
        <th class="s" data-col="16">Max SL%</th>
        <th class="s" data-col="17">TP Hits</th><th class="s" data-col="18">SL Hits</th>
      </tr></thead>
      <tbody id="ov-body"><tr><td colspan="19" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 3. SL SHADOW -->
<div class="sec">
  <div class="sh"><span class="st c">▸ SL SHADOW — READ ONLY</span><span class="sm" id="sl-meta">loading…</span></div>
  <div class="tw">
    <table id="sl-tbl">
      <thead><tr>
        <th class="s" data-col="0">Key</th><th class="s" data-col="1">Symbol</th><th class="s" data-col="2">Session</th>
        <th class="s" data-col="3">Dir</th><th class="s" data-col="4">VWAP</th><th class="s" data-col="5">Snaps</th>
        <th class="s" data-col="6">p50%</th><th class="s" data-col="7">p90%</th><th class="s" data-col="8">p99%</th>
        <th class="s" data-col="9">Max%</th><th class="s" data-col="10">Rec SL%</th><th>Too Wide?</th>
        <th class="s" data-col="12">Save%</th><th class="s" data-col="13">SL%(W) p90</th><th class="s" data-col="14">Winners</th>
      </tr></thead>
      <tbody id="sl-body"><tr><td colspan="15" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 4. WEBHOOK ERRORS + HISTORY -->
<div class="sec">
  <div class="sh"><span class="st r">▸ WEBHOOK ERRORS</span><span class="sm" id="whe-meta">loading…</span></div>
  <div class="tw">
    <table id="whe-tbl">
      <thead><tr>
        <th class="s" data-col="0">Time</th><th class="s" data-col="1">Type</th><th class="s" data-col="2">Symbol</th>
        <th class="s" data-col="3">Dir</th><th class="s" data-col="4">Session</th><th class="s" data-col="5">VWAP</th>
        <th>Entry</th><th>SL</th><th>TP</th><th>Lots</th><th>Risk%</th><th>Detail / Reason</th>
      </tr></thead>
      <tbody id="whe-body"><tr><td colspan="12" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
  <div class="sh" style="border-top:1px solid var(--bdr2);margin-top:0;border-bottom:none">
    <span class="st d" style="font-size:11px">ALL EVENTS (last 100)</span>
    <div style="display:flex;gap:5px">
      <button class="fb on" onclick="setWHF('all',this)">All</button>
      <button class="fb" onclick="setWHF('placed',this)">Placed</button>
      <button class="fb" onclick="setWHF('closed',this)">Closed</button>
      <button class="fb" onclick="setWHF('rejected',this)">Rejected</button>
      <button class="fb" onclick="setWHF('errors',this)">Errors only</button>
    </div>
  </div>
  <div class="tw">
    <table id="wh-tbl">
      <thead><tr>
        <th class="s" data-col="0">Time</th><th class="s" data-col="1">Type</th><th class="s" data-col="2">Symbol</th>
        <th class="s" data-col="3">Dir</th><th class="s" data-col="4">Session</th><th class="s" data-col="5">VWAP</th>
        <th>Entry</th><th>SL</th><th>TP</th><th>Lots</th><th>Risk%</th>
        <th>Optimizer Key</th><th>Pos ID</th><th>Detail</th>
      </tr></thead>
      <tbody id="wh-body"><tr><td colspan="14" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 5. EV MATRIX -->
<div class="sec">
  <div class="sh"><span class="st y">▸ EV MATRIX</span><span class="sm">bestRR · EV · n &nbsp;|&nbsp; ★ = EV+ &amp; n≥5 → TP locked</span></div>
  <div class="mxw">
    <div class="mxg mx">
      <div>
        <div class="mxt">FOREX</div>
        <table id="mx-fx"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-fx"></tbody></table>
      </div>
      <div>
        <div class="mxt">INDEXES</div>
        <table id="mx-ix"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-ix"></tbody></table>
        <div class="mxt" style="margin-top:12px">COMMODITIES</div>
        <table id="mx-cm"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-cm"></tbody></table>
      </div>
      <div style="grid-column:1/-1">
        <div class="mxt">STOCKS (NY only)</div>
        <table id="mx-sk"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-sk"></tbody></table>
      </div>
    </div>
  </div>
</div>

<!-- 6. FLAGGED TRADES -->
<div class="sec">
  <div class="sh"><span class="st r">▸ FLAGGED TRADES</span><span class="sm" id="fl-meta">loading…</span></div>
  <div class="tw">
    <table id="fl-tbl">
      <thead><tr>
        <th>Pos ID</th><th class="s" data-col="1">Symbol</th><th class="s" data-col="2">Dir</th>
        <th class="s" data-col="3">VWAP</th><th class="s" data-col="4">Session</th>
        <th class="s" data-col="5">Entry</th><th class="s" data-col="6">SL</th>
        <th class="s" data-col="7">Max RR</th><th>Close</th><th class="s" data-col="9">PnL €</th>
        <th>Lots</th><th>Flags</th><th class="s" data-col="12">Closed</th>
      </tr></thead>
      <tbody id="fl-body"><tr><td colspan="13" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<!-- 7. OPTIMISATION SUGGESTIONS -->
<div class="sec">
  <div class="sh"><span class="st p">▸ OPTIMISATION SUGGESTIONS</span><span class="sm" id="opt-meta">auto-generated</span></div>
  <div class="tips" id="opt-tips"><div class="tip tip-b"><div class="tipt">Loading…</div></div></div>
</div>

<!-- 8. LOT SIZE CALCULATOR -->
<div class="sec">
  <div class="sh"><span class="st o">▸ LOT SIZE CALCULATOR</span><span class="sm">formule · wat te wijzigen · live config</span></div>
  <div class="lotbox">
    <div class="lc">
      <div class="lct b">Formule — v10.7</div>
      <div class="lcf">
        Elke trade riskeert exact hetzelfde <b style="color:var(--b)">€ bedrag</b> ongeacht SL afstand. <b style="color:var(--o)">evMult en dayMult werken alleen op lotsize, NIET op riskEUR.</b>
        <div class="formula">riskEUR  = balance × riskPct  <span style="color:#888">← puur, geen multipliers</span><br>dist     = |entry_price − sl_price| / entry_price × 1.5 buffer<br>baseLots = riskEUR ÷ (dist × lotValue)<br>finalLots= baseLots × evMult × dayMult  <span style="color:#888">← EV+ trades</span><br>finalLots= baseLots × scaleFactor        <span style="color:#888">← EV neutraal</span></div>
        <b style="color:var(--b)">lotValue:</b> Forex=<code>10</code> Index=<code>20</code> Commodity=<code>100</code> Stock=<code>1</code><br><br>
        <b style="color:var(--g)">Fix A:</b> SL% wordt server-side berekend van <code>entry_price</code> + <code>sl_price</code> (absolute MT5 prijzen uit TV payload). TV <code>sl_pct</code> veld wordt niet meer vertrouwd.<br><br>
        <b style="color:var(--b)">Fix C:</b> EV+ trades (evMult &gt; 1.0) tellen <b>niet</b> mee in currency budget. EV neutraal: max <code>CURRENCY_BUDGET_PCT</code> (2%) per valuta.
      </div>
    </div>
    <div class="lc">
      <div class="lct g">Wat te Wijzigen</div>
      <ul class="chlist">
        <li><b>FIXED_RISK_PCT</b> — basis risk%. Stel in Railway: <code>FIXED_RISK_PCT=0.002</code>. <span style="color:var(--r)">Wijzig alleen buiten trading uren of weekend.</span></li>
        <li><b>RISK_&lt;SYM&gt;</b> — per-symbool override: <code>RISK_EURUSD=0.002</code></li>
        <li><b>LOTS_&lt;SYM&gt;</b> — hard lot override na SL herberekening: <code>LOTS_NVDA=0.05</code></li>
        <li><b>CURRENCY_BUDGET_PCT</b> — max EUR exposure per valuta voor EV neutrale forex. Default: <code>0.02</code> (2%)</li>
        <li><b>MIN_TP_RR_FLOOR</b> — minimum TP afstand als factor van SL. Default: <code>0.5</code> (0.5R)</li>
        <li><b>LOT_VALUE</b> in server.js — lot waarde per type als broker afwijkt</li>
        <li><b>MIN_STOP</b> in server.js — min SL afstand per MT5 symbool</li>
        <li><b>evMult</b> — automatisch via EV score (max ×4). Werkt op <b>lots</b>, niet riskEUR</li>
        <li><b>dayMult</b> — automatisch ×1.2/dag bij positieve EV streak (min 30 ghost samples). Werkt op <b>lots</b></li>
      </ul>
    </div>
    <div class="lc">
      <div class="lct y">Live Config &amp; Lot Overrides</div>
      <div class="tw" style="border:none">
        <table id="risk-tbl" style="font-size:10px">
          <thead><tr><th>Symbol</th><th>Type</th><th>Risk%</th><th>Risk € (puur)</th><th>evMult (lots)</th><th>Lot OV</th></tr></thead>
          <tbody id="risk-body"><tr><td colspan="6" class="nodata">Loading…</td></tr></tbody>
        </table>
      </div>
      <div style="margin-top:10px;font-family:var(--fh);font-size:9px;color:var(--dim);letter-spacing:.5px;margin-bottom:4px">PENDING LOT OVERRIDES → SET IN RAILWAY</div>
      <table style="font-size:10px;width:100%">
        <thead><tr><th>Symbol</th><th>Optimal Lots</th><th>Env Var</th></tr></thead>
        <tbody id="lots-body"><tr><td colspan="3" class="nodata d">No SL recalcs yet</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- 9. GHOSTS -->
<div class="sec">
  <div class="sh"><span class="st p">▸ GHOSTS</span><span class="sm" id="gh-meta">active + history</span></div>
  <div class="tw">
    <table id="gh-tbl">
      <thead><tr>
        <th>Key</th><th class="s" data-col="1">Symbol</th><th class="s" data-col="2">Dir</th>
        <th class="s" data-col="3">Session</th><th class="s" data-col="4">Entry</th>
        <th class="s" data-col="5">Finale SL</th>
        <th class="s" data-col="6">Max RR</th><th>SL Used%</th>
        <th class="s" data-col="8">Elapsed (min)</th>
        <th class="s" data-col="9" title="SL wijzigingen tijdens trade">SL Chg</th>
        <th class="s" data-col="10" title="TP wijzigingen tijdens trade">TP Chg</th>
        <th>Status</th>
      </tr></thead>
      <tbody id="gh-body"><tr><td colspan="12" class="nodata">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

</div><!-- /main -->

<script>
const FOREX  = ${JSON.stringify(FOREX_SYMBOLS)};
const INDEX  = ${JSON.stringify(INDEX_SYMBOLS)};
const COMM   = ${JSON.stringify(COMMODITY_SYMBOLS)};
const STOCKS = ${JSON.stringify(STOCK_SYMBOLS)};

let _allTrades=[],_ovData=[],_whData=[];
const ovF={type:'all',sess:'all',dir:'all',vwap:'all',show:'all'};
let whF='all';

// ── helpers ──────────────────────────────────────────────
const f=(v,d=2)=>v==null?'—':(+v).toFixed(d);
const eu=v=>v==null?'—':(v>=0?'+':'')+\`€\${(+v).toFixed(2)}\`;
const pC=v=>v>0?'g':v<0?'r':'d';
const ts=s=>s?new Date(s).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit'}):'—';
const dt=s=>s?new Date(s).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',month:'2-digit',day:'2-digit'}):'—';
function sType(s){if(FOREX.includes(s))return'f';if(INDEX.includes(s))return'i';if(COMM.includes(s))return'c';return's';}
function tClass(s){return{f:'tf',i:'ti',c:'tc'}[sType(s)]||'ts';}
function evC(v){return v>0?'ep':v<0?'en':'ez';}
function dBadge(d){return d==='buy'?'<span class="bd bd-buy">BUY</span>':d==='sell'?'<span class="bd bd-sell">SELL</span>':'—';}
function vBadge(v){return v==='above'?'<span class="bd bd-ab">ABOVE</span>':v==='below'?'<span class="bd bd-bw">BELOW</span>':'<span class="bd d">?</span>';}
function sBadge(s){const m={asia:'bd-as',london:'bd-lo',ny:'bd-ny',outside:'bd-out'};const n={asia:'ASIA',london:'LON',ny:'NY',outside:'OUT'};return\`<span class="bd \${m[s]||'bd-out'}">\${n[s]||s||'—'}</span>\`;}
function tyBadge(t){const m={forex:'bd-fx',index:'bd-ix',commodity:'bd-cm',stock:'bd-sk'};const n={forex:'FX',index:'IDX',commodity:'COM',stock:'STK'};return\`<span class="bd \${m[t]||'bd-sk'}">\${n[t]||t}</span>\`;}
function cBadge(r){return r==='tp'?'<span class="bd bd-tp">TP</span>':r==='sl'?'<span class="bd bd-sl">SL</span>':r==='manual'?'<span class="bd bd-mn">MAN</span>':r?\`<span class="bd d">\${r}</span>\`:'—';}
function slBar(p){const w=Math.min(100,Math.max(0,p||0));const c=w<50?'':w<80?' w':' d';return\`<div class="slbar"><div class="slbg"><div class="slfi\${c}" style="width:\${w}%"></div></div><span class="\${c.trim()||'g'}">\${f(p,0)}%</span></div>\`;}
async function api(path){try{const r=await fetch(path);if(!r.ok)return null;return r.json();}catch{return null;}}

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
function initAll(){['pos-tbl','ov-tbl','sl-tbl','whe-tbl','wh-tbl','fl-tbl','gh-tbl','risk-tbl'].forEach(initSort);}

// ── 1. OPEN POSITIONS ────────────────────────────────────
async function loadPositions(){
  const d=await api('/live/positions');
  const tb=document.getElementById('pos-body');
  const em=document.getElementById('pos-empty');
  const pw=document.getElementById('pos-wrap');
  document.getElementById('pos-meta').textContent=d?d.count+' open':'error';
  document.getElementById('k-pos').textContent=d?.count??'?';
  if(!d||!d.positions?.length){em.style.display='flex';pw.style.display='none';return;}
  em.style.display='none';pw.style.display='';
  const bal=d.balance||1;
  tb.innerHTML=d.positions.map(p=>{
    const slU=p.slPctUsed||0;
    const pnlP=p.currentPnL!=null?((p.currentPnL/bal)*100).toFixed(2):null;
    // Werkelijk risico kleur: rood als >2x basis riskEUR (multipliers hebben fors effect)
    const riskRatio=p.actualRiskEUR&&p.riskEUR?p.actualRiskEUR/p.riskEUR:1;
    const riskCls=riskRatio>2.5?'r':riskRatio>1.5?'o':'g';
    // Live TP RR (na eventuele SL wijiging in MT5)
    const tpRRShow=p.tpRRActual??p.tpRR;
    return\`<tr class="\${tClass(p.symbol)}">
      <td data-val="\${p.symbol}" class="b fw">\${p.symbol}</td>
      <td>\${dBadge(p.direction)}</td><td>\${vBadge(p.vwapPosition)}</td><td>\${sBadge(p.session)}</td>
      <td data-val="\${p.entry}" class="d">\${f(p.entry,5)}</td>
      <td data-val="\${p.sl}" class="r">\${f(p.sl,5)}</td>
      <td data-val="\${p.slDistPct}" class="o">\${p.slDistPct!=null?p.slDistPct+'%':'—'}</td>
      <td>\${slBar(slU)}</td>
      <td data-val="\${p.maxRR}" class="\${p.maxRR>0?'g':'d'} fw">\${f(p.maxRR,2)}R</td>
      <td data-val="\${p.tp}" class="g">\${f(p.tp,5)}</td>
      <td data-val="\${tpRRShow}" class="y" title="Live TP RR op basis van huidige MT5 SL/TP">\${f(tpRRShow,2)}R\${p.tpRRActual&&p.tpRRActual!==p.tpRR?' ✎':''}</td>
      <td data-val="\${p.currentPnL}" class="\${pC(p.currentPnL)} fw">\${eu(p.currentPnL)}</td>
      <td data-val="\${pnlP}" class="\${pC(p.currentPnL)}">\${pnlP!=null?(pnlP>=0?'+':'')+pnlP+'%':'—'}</td>
      <td data-val="\${p.lots}" class="c">\${f(p.lots,2)}</td>
      <td data-val="\${p.riskEUR}" class="d" title="Basis: balance x pct (puur, zonder multipliers)">€\${f(p.riskEUR,0)}</td>
      <td data-val="\${p.actualRiskEUR}" class="\${riskCls} fw" title="Werkelijk verlies bij SL: \${p.lots} lots x dist x lotVal. evMult=\${f(p.evMult,2)}x dayMult=\${f(p.dayMult,2)}x">€\${p.actualRiskEUR!=null?f(p.actualRiskEUR,0):'—'}</td>
      <td data-val="\${p.actualRiskPct}" class="\${riskCls}" title="Werkelijk % van balance bij SL">\${p.actualRiskPct!=null?f(p.actualRiskPct,3)+'%':'—'}</td>
      <td>\${p.isEvPlus?'<span class="bd bd-evp" title="EV+ trade: evMult>1, geen currency budget check">EV+</span>':'<span class="bd d">EV0</span>'}</td>
      <td>\${p.isGhosted?'<span class="bd" style="color:var(--p);border-color:rgba(168,120,255,.3)">👻</span>':'<span class="d">—</span>'}</td>
      <td data-val="\${p.openedAt}" class="d" style="font-size:9px">\${dt(p.openedAt)} \${ts(p.openedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── 2. TP OPTIMISER ──────────────────────────────────────
async function loadOverview(){
  const [trD,evD,tpD]=await Promise.all([api('/trades?limit=2000'),api('/ev'),api('/tp-locks')]);
  if(!trD)return;
  _allTrades=trD.trades||[];
  const tpMap={};if(tpD)tpD.forEach(t=>{tpMap[t.key]=t;});
  const evMap={};if(evD)evD.forEach(e=>{evMap[e.key]=e;});
  const combos=[];
  const allSyms=[...FOREX,...INDEX,...COMM,...STOCKS];
  for(const sym of allSyms){
    const type=FOREX.includes(sym)?'forex':INDEX.includes(sym)?'index':COMM.includes(sym)?'commodity':'stock';
    const sessions=type==='stock'?['ny']:['asia','london','ny'];
    for(const sess of sessions){
      for(const dir of['buy','sell']){
        for(const vwap of['above','below']){
          const key=sym+'_'+sess+'_'+dir+'_'+vwap;
// COMPLIANCE: only trades from 18-Apr-2026 onward with valid VWAP.
// vwap is always 'above'|'below' here, so the vwapPosition===vwap
// check automatically excludes 'unknown' positions.
const COMPLIANCE_DATE=new Date('2026-04-18T00:00:00.000Z');
          const trades=_allTrades.filter(t=>t.symbol===sym&&t.session===sess&&t.direction===dir&&t.vwapPosition===vwap&&t.closedAt&&new Date(t.closedAt)>=COMPLIANCE_DATE);
          const wins=trades.filter(t=>t.closeReason==='tp');
          const sls=trades.filter(t=>t.closeReason==='sl');
          const pnls=trades.map(t=>t.realizedPnlEUR??t.currentPnL??0);
          const totalPnl=pnls.reduce((a,b)=>a+b,0);
          const winPct=trades.length?(wins.length/trades.length*100):null;
          const rrs=trades.map(t=>t.maxRR).filter(v=>v!=null);
          const avgRR=rrs.length?rrs.reduce((a,b)=>a+b,0)/rrs.length:null;
          const bestRR=rrs.length?Math.max(...rrs):null;
          const slP=trades.map(t=>t.slDistPct??(t.entry&&t.sl?Math.abs(t.entry-t.sl)/t.entry*100:null)).filter(v=>v!=null);
          const avgSlP=slP.length?slP.reduce((a,b)=>a+b,0)/slP.length:null;
          const maxSlP=slP.length?Math.max(...slP):null;
          const wSlP=wins.map(t=>t.slDistPct??null).filter(v=>v!=null);
          const avgWSlP=wSlP.length?wSlP.reduce((a,b)=>a+b,0)/wSlP.length:null;
          combos.push({sym,sess,dir,vwap,key,trades,wins,sls,winPct,avgRR,bestRR,totalPnl,avgPnl:trades.length?totalPnl/trades.length:null,ev:evMap[key],tp:tpMap[key],type,avgSlP,avgWSlP,maxSlP});
        }
      }
    }
  }
  _ovData=combos;renderOv();
}
function renderOv(){
  let d=_ovData;
  if(ovF.type!=='all')d=d.filter(c=>c.type===ovF.type);
  if(ovF.sess!=='all')d=d.filter(c=>c.sess===ovF.sess);
  if(ovF.dir!=='all')d=d.filter(c=>c.dir===ovF.dir);
  if(ovF.vwap!=='all')d=d.filter(c=>c.vwap===ovF.vwap);
  if(ovF.show==='traded')d=d.filter(c=>c.trades.length>0);
  d.sort((a,b)=>{const ea=a.ev?.bestEV??-99,eb=b.ev?.bestEV??-99;return eb!==ea?eb-ea:b.trades.length-a.trades.length;});
  const tr=d.filter(c=>c.trades.length>0);
  const tot=tr.reduce((s,c)=>s+c.trades.length,0);
  const wins=tr.reduce((s,c)=>s+c.wins.length,0);
  const pnl=tr.reduce((s,c)=>s+c.totalPnl,0);
  document.getElementById('ov-meta').textContent=d.length+' combos';
  document.getElementById('ov-count').textContent=d.length;
  document.getElementById('ov-trades').textContent=tot;
  document.getElementById('ov-wins').textContent=wins;
  document.getElementById('ov-winpct').textContent=tot?(wins/tot*100).toFixed(1)+'%':'—';
  const pEl=document.getElementById('ov-pnl');pEl.textContent=(pnl>=0?'+':'')+'€'+pnl.toFixed(0);pEl.className='sv2 '+pC(pnl);
  document.getElementById('ov-evp').textContent=d.filter(c=>(c.ev?.bestEV??0)>0).length;
  const tb=document.getElementById('ov-body');
  tb.innerHTML=d.map(c=>{
    const nd=c.trades.length===0;
    const ev=c.ev;const tp=c.tp;const evV=ev?.bestEV??null;
    return\`<tr class="\${tClass(c.sym)}\${nd?' zrow':''}">
      <td data-val="\${c.sym}" class="\${nd?'d':'b fw'}">\${c.sym}</td>
      <td>\${tyBadge(c.type)}</td><td>\${sBadge(c.sess)}</td><td>\${dBadge(c.dir)}</td><td>\${vBadge(c.vwap)}</td>
      <td data-val="\${c.trades.length}" class="\${nd?'d':'c fw'}">\${c.trades.length}</td>
      <td data-val="\${c.winPct??-1}" class="\${c.winPct==null?'d':c.winPct>=50?'g':'r'}">\${c.winPct!=null?c.winPct.toFixed(0)+'%':'—'}</td>
      <td data-val="\${c.avgRR??-99}" class="\${c.avgRR==null?'d':c.avgRR>=1?'g':'r'}">\${c.avgRR!=null?c.avgRR.toFixed(2)+'R':'—'}</td>
      <td data-val="\${c.bestRR??-99}" class="y">\${c.bestRR!=null?c.bestRR.toFixed(2)+'R':'—'}</td>
      <td data-val="\${evV??-99}" class="\${evC(evV)} fw">\${evV!=null?evV.toFixed(3):'—'}</td>
      <td>\${evV!=null?(evV>0?'<span class="bd bd-evp">EV+</span>':'<span class="bd bd-evn">EV-</span>'):'—'}</td>
      <td data-val="\${tp?tp.lockedRR:-99}">\${tp?\`<span class="bd bd-lck">★ \${tp.lockedRR.toFixed(1)}R</span>\`:'—'}</td>
      <td data-val="\${c.totalPnl}" class="\${pC(c.totalPnl)} fw">\${c.trades.length?eu(c.totalPnl):'—'}</td>
      <td data-val="\${c.avgPnl??-99}" class="\${pC(c.avgPnl)}">\${c.avgPnl!=null?eu(c.avgPnl):'—'}</td>
      <td data-val="\${c.avgSlP??-1}" class="d">\${c.avgSlP!=null?c.avgSlP.toFixed(2)+'%':'—'}</td>
      <td data-val="\${c.avgWSlP??-1}" class="g">\${c.avgWSlP!=null?c.avgWSlP.toFixed(2)+'%':'—'}</td>
      <td data-val="\${c.maxSlP??-1}" class="r">\${c.maxSlP!=null?c.maxSlP.toFixed(2)+'%':'—'}</td>
      <td data-val="\${c.wins.length}" class="g">\${c.wins.length}</td>
      <td data-val="\${c.sls.length}" class="r">\${c.sls.length}</td>
    </tr>\`;
  }).join('');
}
function setOF(key,val,btn){
  ovF[key]=val;
  btn.closest('.fbar').querySelectorAll('.fb').forEach(b=>{if(b.getAttribute('onclick')?.includes("'"+key+"'"))b.classList.remove('on');});
  btn.classList.add('on');renderOv();
}

// ── 3. SL SHADOW ─────────────────────────────────────────
async function loadShadow(){
  const [sd,wd]=await Promise.all([api('/shadow'),api('/shadow/winners')]);
  const tb=document.getElementById('sl-body');
  const res=sd?.results||[];
  const wmap={};if(wd)wd.winners.forEach(w=>{wmap[w.optimizerKey]=w;});
  document.getElementById('sl-meta').textContent=res.length+' keys';
  if(!res.length){tb.innerHTML='<tr><td colspan="15" class="nodata">No shadow SL data yet</td></tr>';return;}
  res.sort((a,b)=>(b.potentialSavingPct??0)-(a.potentialSavingPct??0));
  tb.innerHTML=res.map(s=>{
    const w=wmap[s.optimizerKey];
    const parts=s.optimizerKey.split('_');
    return\`<tr class="\${tClass(parts[0]||'')}">
      <td data-val="\${s.optimizerKey}" class="d" style="font-size:9px">\${s.optimizerKey}</td>
      <td class="b fw">\${s.symbol||'—'}</td><td>\${sBadge(s.session)}</td><td>\${dBadge(s.direction)}</td><td>\${vBadge(s.vwapPosition)}</td>
      <td data-val="\${s.snapshotsCount||0}" class="c">\${s.snapshotsCount||0}</td>
      <td data-val="\${s.p50??-1}" class="g">\${s.p50!=null?s.p50.toFixed(1)+'%':'—'}</td>
      <td data-val="\${s.p90??-1}" class="y">\${s.p90!=null?s.p90.toFixed(1)+'%':'—'}</td>
      <td data-val="\${s.p99??-1}" class="o">\${s.p99!=null?s.p99.toFixed(1)+'%':'—'}</td>
      <td data-val="\${s.maxUsed??-1}" class="r">\${s.maxUsed!=null?s.maxUsed.toFixed(1)+'%':'—'}</td>
      <td data-val="\${s.recommendedSlPct??-1}" class="g fw">\${s.recommendedSlPct!=null?s.recommendedSlPct.toFixed(2)+'%':'—'}</td>
      <td>\${s.currentSlTooWide?'<span class="r">⚠ WIDE</span>':'<span class="g">OK</span>'}</td>
      <td data-val="\${s.potentialSavingPct??-1}" class="g">\${s.potentialSavingPct!=null?s.potentialSavingPct+'%':'—'}</td>
      <td data-val="\${w?.p90??-1}" class="g">\${w?.p90!=null?w.p90.toFixed(1)+'%':'—'}</td>
      <td data-val="\${w?.winnerCount??0}" class="c">\${w?.winnerCount||'—'}</td>
    </tr>\`;
  }).join('');
}

// ── 4. WEBHOOK ────────────────────────────────────────────
function whRow(e,cols){
  const isErr=['REJECTED','SL_TP_SET_FAILED','LOT_CALC_FAILED'].includes(e.type);
  const tc=e.type==='ORDER_PLACED'?'g':e.type==='POSITION_CLOSED'?'b':isErr?'r':'d';
  return\`<tr>
    <td data-val="\${e.ts}" class="d" style="font-size:9px">\${dt(e.ts)} \${ts(e.ts)}</td>
    <td class="\${tc} fw" style="font-size:9px">\${e.type||'—'}</td>
    <td class="b">\${e.symbol||'—'}</td>
    <td>\${e.direction?dBadge(e.direction):'—'}</td>
    <td>\${sBadge(e.session)}</td>
    <td>\${vBadge(e.vwapPosition||e.vwap_pos)}</td>
    <td class="d">\${e.executionPrice||e.entry?f(e.executionPrice||e.entry,5):'—'}</td>
    <td class="r">\${e.sl?f(e.sl,5):'—'}</td>
    <td class="g">\${e.tp?f(e.tp,5):'—'}</td>
    <td class="c">\${e.lots?f(e.lots,2):'—'}</td>
    <td class="o">\${e.riskPct?(e.riskPct*100).toFixed(3)+'%':'—'}</td>
    \${cols===14?\`<td class="d" style="font-size:9px">\${e.optimizerKey||'—'}</td><td class="d" style="font-size:9px">\${(e.positionId||'—').toString().slice(-10)}</td>\`:''}
    <td class="\${isErr?'r':'d'}" style="font-size:9px;max-width:200px;overflow:hidden;text-overflow:ellipsis">\${e.reason||e.detail||''}</td>
  </tr>\`;
}
async function loadWebhook(){
  const d=await api('/history');if(!d)return;
  _whData=d;
  const errs=d.filter(e=>['REJECTED','SL_TP_SET_FAILED','LOT_CALC_FAILED'].includes(e.type));
  document.getElementById('whe-meta').textContent=errs.length+' errors';
  const etb=document.getElementById('whe-body');
  etb.innerHTML=errs.length?errs.map(e=>whRow(e,12)).join(''):'<tr><td colspan="12" class="nodata g">✓ No errors</td></tr>';
  renderWH();
}
function renderWH(){
  let d=_whData;
  if(whF==='placed')d=d.filter(e=>e.type==='ORDER_PLACED');
  else if(whF==='closed')d=d.filter(e=>e.type==='POSITION_CLOSED');
  else if(whF==='rejected')d=d.filter(e=>e.type==='REJECTED');
  else if(whF==='errors')d=d.filter(e=>['REJECTED','SL_TP_SET_FAILED','LOT_CALC_FAILED'].includes(e.type));
  const tb=document.getElementById('wh-body');
  tb.innerHTML=d.length?d.map(e=>whRow(e,14)).join(''):'<tr><td colspan="14" class="nodata">No events</td></tr>';
}
function setWHF(v,btn){whF=v;btn.closest('div').querySelectorAll('.fb').forEach(b=>b.classList.remove('on'));btn.classList.add('on');renderWH();}

// ── 5. EV MATRIX ─────────────────────────────────────────
async function loadEV(){
  const d=await api('/ev');if(!d)return;
  const em={};d.forEach(e=>{em[e.key]=e;});
  document.getElementById('k-tp').textContent=d.filter(e=>(e.bestEV||0)>0&&(e.count||0)>=5).length;
  const C=[{dir:'buy',vwap:'above'},{dir:'buy',vwap:'below'},{dir:'sell',vwap:'above'},{dir:'sell',vwap:'below'}];
  function renderMx(syms,bid,sessions){
    const tb=document.getElementById(bid);if(!tb)return;
    tb.innerHTML=syms.map(sym=>{
      const ss=STOCKS.includes(sym)?['ny']:(sessions||['asia','london','ny']);
      return ss.map(sess=>{
        const cells=C.map(c=>{
          const key=sym+'_'+sess+'_'+c.dir+'_'+c.vwap;
          const ev=em[key];
          if(!ev||!ev.count)return'<td class="ez">—</td>';
          const lk=(ev.bestEV||0)>0&&ev.count>=5;
          return\`<td class="\${evC(ev.bestEV)}">\${lk?'★':''}\${(ev.bestRR||0).toFixed(1)}R<br><span style="font-size:8px">\${(ev.bestEV||0).toFixed(2)} n=\${ev.count}</span></td>\`;
        }).join('');
        return\`<tr class="\${tClass(sym)}"><td class="sym">\${sym} <span style="font-size:8px;color:var(--dim)">\${sess.toUpperCase()}</span></td>\${cells}</tr>\`;
      }).join('');
    }).join('');
  }
  renderMx(FOREX,'mxb-fx');renderMx(INDEX,'mxb-ix');renderMx(COMM,'mxb-cm');renderMx(STOCKS,'mxb-sk',['ny']);
}

// ── 6. FLAGGED TRADES ────────────────────────────────────
function flagT(t){
  const f=[];
  if(!t.entry||t.entry===0)f.push('ZERO_ENTRY');
  if(!t.sl||t.sl===0)f.push('ZERO_SL');
  if(!t.vwapPosition||t.vwapPosition==='unknown')f.push('NO_VWAP');
  if(t.realizedPnlEUR==null&&t.currentPnL==null)f.push('NULL_PNL');
  if(t.closeReason&&!['tp','sl','manual'].includes(t.closeReason))f.push('BAD_CLOSE');
  if(t.maxRR!=null&&t.maxRR<0)f.push('NEG_RR');
  return f;
}
function loadErrors(){
  const errs=_allTrades.map(t=>({...t,flags:flagT(t)})).filter(t=>t.flags.length>0);
  document.getElementById('k-err').textContent=errs.length;
  document.getElementById('fl-meta').textContent=errs.length+' flagged';
  const tb=document.getElementById('fl-body');
  if(!errs.length){tb.innerHTML='<tr><td colspan="13" class="nodata g">✓ No flagged trades</td></tr>';return;}
  errs.sort((a,b)=>new Date(b.closedAt||0)-new Date(a.closedAt||0));
  tb.innerHTML=errs.map(t=>{
    const pnl=t.realizedPnlEUR??t.currentPnL;
    return\`<tr class="\${tClass(t.symbol||'')}">
      <td class="d" style="font-size:9px">\${(t.positionId||t.id||'—').toString().slice(-8)}</td>
      <td class="b fw">\${t.symbol||'<span class="r">?</span>'}</td>
      <td>\${dBadge(t.direction)}</td><td>\${vBadge(t.vwapPosition)}</td><td>\${sBadge(t.session)}</td>
      <td data-val="\${t.entry}" class="d">\${t.entry?f(t.entry,5):'<span class="r">0</span>'}</td>
      <td data-val="\${t.sl}" class="r">\${t.sl?f(t.sl,5):'<span class="r">0</span>'}</td>
      <td data-val="\${t.maxRR}" class="\${(t.maxRR||0)<0?'r':'c'}">\${f(t.maxRR,2)}R</td>
      <td>\${cBadge(t.closeReason)}</td>
      <td data-val="\${pnl}" class="\${pC(pnl)} fw">\${pnl!=null?eu(pnl):'<span class="r">NULL</span>'}</td>
      <td class="c">\${f(t.lots,2)}</td>
      <td>\${t.flags.map(fl=>\`<span class="bd bd-er">\${fl}</span>\`).join(' ')}</td>
      <td data-val="\${t.closedAt}" class="d" style="font-size:9px">\${dt(t.closedAt)} \${ts(t.closedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── 7. OPTIMISATION SUGGESTIONS ──────────────────────────
async function loadOpts(){
  const [sd,sigD]=await Promise.all([api('/shadow'),api('/signal-stats')]);
  const tips=[];
  if(sd?.results){
    const wide=sd.results.filter(r=>r.currentSlTooWide&&(r.potentialSavingPct??0)>5);
    if(wide.length)tips.push({cls:'tip-g',title:'🎯 SL Tightening Opportunity',body:wide.slice(0,5).map(w=>\`<b>\${w.symbol}</b> \${w.session}/\${w.direction}: rec \${w.recommendedSlPct?.toFixed(2)||'?'}% → save <b>\${w.potentialSavingPct}%</b>\`).join('<br>')});
  }
  if(_ovData.length){
    const ev0=_ovData.filter(c=>(c.ev?.bestEV||0)>0&&!c.tp&&c.trades.length>=3);
    if(ev0.length)tips.push({cls:'tip-y',title:'⚡ EV+ Combos — TP Not Locked Yet',body:ev0.slice(0,6).map(c=>\`<b>\${c.sym}</b> \${c.sess} \${c.dir} \${c.vwap} — EV=\${(c.ev.bestEV||0).toFixed(3)} n=\${c.trades.length}\`).join('<br>')});
    const bad=_ovData.filter(c=>(c.ev?.bestEV||0)<-0.1&&c.trades.length>=5).sort((a,b)=>(a.ev?.bestEV||0)-(b.ev?.bestEV||0));
    if(bad.length)tips.push({cls:'tip-r',title:'⛔ Underperforming Combos',body:bad.slice(0,6).map(c=>\`<b>\${c.sym}</b> \${c.sess} \${c.dir} \${c.vwap} — EV=\${(c.ev.bestEV||0).toFixed(3)} n=\${c.trades.length}\`).join('<br>')});
    const best=_ovData.filter(c=>c.trades.length>=3&&c.winPct!=null).sort((a,b)=>b.winPct-a.winPct).slice(0,5);
    if(best.length)tips.push({cls:'tip-b',title:'🏆 Best Win Rate Combos',body:best.map(c=>\`<b>\${c.sym}</b> \${c.sess} \${c.dir} \${c.vwap} — \${c.winPct.toFixed(0)}% (\${c.wins.length}/\${c.trades.length})\`).join('<br>')});
  }
  if(sigD){
    const rate=sigD.conversionPct??null;
    if(rate!=null){const cls=rate>=80?'tip-g':rate>=50?'tip-y':'tip-r';tips.push({cls,title:'📡 Signal Conversion: '+rate+'%',body:\`\${sigD.placed||0} placed / \${sigD.total||0} total<br>\${(sigD.topRejectReasons||[]).slice(0,4).map(r=>\`\${r.reason}: \${r.count}\`).join(' · ')}\`});}
  }
  if(!tips.length)tips.push({cls:'tip-b',title:'ℹ️ No Suggestions Yet',body:'Need more trades to generate tips.'});
  document.getElementById('opt-meta').textContent=tips.length+' suggestions';
  document.getElementById('opt-tips').innerHTML=tips.map(t=>\`<div class="tip \${t.cls}"><div class="tipt">\${t.title}</div><div class="tipb">\${t.body}</div></div>\`).join('');
}

// ── 8. RISK CONFIG ────────────────────────────────────────
async function loadRisk(){
  const [rd,ld]=await Promise.all([api('/risk-config'),api('/lot-overrides')]);
  if(rd){
    const overridden=(rd.config||[]).filter(c=>c.lotOverride!=null||c.riskMult>1);
    document.getElementById('k-lots').textContent=overridden.length;
    const tb=document.getElementById('risk-body');
    tb.innerHTML=overridden.length?overridden.map(c=>\`<tr class="\${tClass(c.symbol)}">
      <td class="b fw">\${c.symbol}</td><td>\${tyBadge(c.type)}</td>
      <td class="y">\${(c.riskPct*100).toFixed(3)}%</td><td class="g">€\${c.riskEUR}</td>
      <td class="\${c.riskMult>1?'g':'d'}">×\${(c.riskMult||1).toFixed(2)}</td>
      <td class="o">\${c.lotOverride!=null?c.lotOverride:'—'}</td>
    </tr>\`).join(''):'<tr><td colspan="6" class="nodata d">All default 0.150% — no overrides active</td></tr>';
  }
  if(ld){
    const tb2=document.getElementById('lots-body');
    tb2.innerHTML=ld.overrides.length?ld.overrides.map(o=>\`<tr>
      <td class="b fw">\${o.symbol}</td><td class="g fw">\${o.lots}</td>
      <td class="o" style="font-size:9px">\${o.envVar}=\${o.lots}</td>
    </tr>\`).join(''):'<tr><td colspan="3" class="nodata d">No SL recalcs yet</td></tr>';
  }
}

// ── 9. GHOSTS ─────────────────────────────────────────────
async function loadGhosts(){
  const [lv,hi]=await Promise.all([api('/live/ghosts'),api('/ghosts/history?limit=30')]);
  document.getElementById('k-gh').textContent=lv?.count??0;
  document.getElementById('gh-meta').textContent=(lv?.count||0)+' active · '+(hi?.count||0)+' history';
  const rows=[];
  if(lv?.ghosts)lv.ghosts.forEach(g=>rows.push({...g,status:'ACTIVE'}));
  if(hi?.rows)hi.rows.forEach(r=>rows.push({...r,status:r.phantomSLHit?'SL HIT':r.stopReason||'closed'}));
  const tb=document.getElementById('gh-body');
  if(!rows.length){tb.innerHTML='<tr><td colspan="12" class="nodata">No ghost data</td></tr>';return;}
  tb.innerHTML=rows.map(g=>{
    const isA=g.status==='ACTIVE';
    const rr=g.maxRR??g.maxRRBeforeSL;
    const slChg=g.slChanges??0;
    const tpChg=g.tpChanges??0;
    // Actieve ghosts tonen live SL; history toont finale SL (phantom_sl)
    const finalSL=g.phantomSL??g.sl;
    return\`<tr class="\${tClass(g.symbol||'')}">
      <td class="d" style="font-size:9px">\${(g.optimizerKey||'—').slice(0,28)}</td>
      <td class="b fw">\${g.symbol||'—'}</td><td>\${dBadge(g.direction)}</td><td>\${sBadge(g.session)}</td>
      <td data-val="\${g.entry}" class="d">\${f(g.entry,5)}</td>
      <td data-val="\${finalSL}" class="\${slChg>0?'o':'r'}" title="\${slChg>0?slChg+' wijziging(en)':'geen wijziging'}">\${f(finalSL,5)}\${slChg>0?' ✎':''}</td>
      <td data-val="\${rr??-99}" class="\${rr>0?'g':'d'}">\${f(rr,2)}R</td>
      <td>\${slBar(g.slPctUsed??0)}</td>
      <td data-val="\${g.elapsedMin??g.timeToSLMin??0}" class="d">\${g.elapsedMin??g.timeToSLMin??'—'}</td>
      <td data-val="\${slChg}" class="\${slChg>0?'o':'d'}" title="SL gewijzigd \${slChg}x tijdens trade">\${slChg>0?slChg+'x':'—'}</td>
      <td data-val="\${tpChg}" class="\${tpChg>0?'y':'d'}" title="TP gewijzigd \${tpChg}x tijdens trade">\${tpChg>0?tpChg+'x':'—'}</td>
      <td>\${isA?'<span class="bd bd-evp">ACTIVE</span>':g.status==='SL HIT'?'<span class="bd bd-sl">SL HIT</span>':\`<span class="bd d">\${g.status}</span>\`}</td>
    </tr>\`;
  }).join('');
}

// ── CLOCK + HEALTH ────────────────────────────────────────
function tick(){document.getElementById('clock').textContent=new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
setInterval(tick,1000);tick();

async function loadHealth(){
  const h=await api('/health');if(!h)return;
  const s=h.session||'outside';
  document.getElementById('k-sess').textContent=s.toUpperCase();
  document.getElementById('k-bal').textContent=(h.balance||0).toFixed(0);
  const hb=document.getElementById('hdr-sess');
  hb.className='sb s-'+s;
  hb.textContent={asia:'⛩ ASIA',london:'🇬🇧 LONDON',ny:'🇺🇸 NY',outside:'⏸ OUT'}[s]||s.toUpperCase();
}

async function loadAll(){
  await Promise.all([
    loadHealth(),
    loadPositions(),
    loadOverview().then(()=>{loadErrors();loadOpts();}),
    loadWebhook(),
    loadEV(),
    loadShadow(),
    loadRisk(),
    loadGhosts(),
  ]);
}

document.addEventListener('DOMContentLoaded',()=>{initAll();loadAll();setInterval(loadAll,30000);});
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

  console.log("🚀 PRONTO-AI v10.8 starting...");
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

  app.listen(PORT, () => {
    console.log(`[✓] PRONTO-AI v10.8 on port ${PORT}`);
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
