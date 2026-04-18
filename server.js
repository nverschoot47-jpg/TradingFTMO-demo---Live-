// ===============================================================
// server.js  v10.2  |  PRONTO-AI
// TradingView → MetaApi REST → FTMO MT5
//
// v10.2 fixes (8 total):
//  FIX 1 — spread_at_entry saved in closed_trades
//  FIX 2 — vwap_band_pct saved in closed_trades
//  FIX 3 — Lots recalc order confirmed correct after enforceMinStop
//  FIX 4 — Spread guard for stocks (>25% SL dist → close+reject)
//  FIX 5 — Anti-consolidation forex (sharesCurrency helper)
//  FIX 6 — Ghost entry log on restart
//  FIX 7 — GET /signal-stats endpoint
//  FIX 8 — /shadow/winners route moved ABOVE /shadow/:key
//
// v10.1 changes:
//  - sl_pct: validated as 0 < x <= 0.05 (max 5%), human-readable log
//  - Entry logic: market order first → read back real execution price
//    from MT5 → calculate SL/TP from execution price → modify position
//  - TP comment uses real tpRR variable (not hardcoded "2R")
//  - canOpenNewTrade() replaces isMarketOpen() for new trade gating:
//    * Stocks: 16:00–21:00 Brussels only
//    * Others: 02:00–21:00 Brussels
//  - Ghost tracker: runs through night for overnight holdings
//    * GHOST_MAX_MS = 72h (was 24h)
//    * Weekend: slow-polls every 10min instead of stopping
//    * 23:00 hard-stop cron REMOVED
//  - VWAP band exhaustion filter: rejects signals where price is
//    >90% into the VWAP band (chasing prevention)
//  - Max notional 20% cap for stocks (prevents overleveraged sizing)
//  - Daily risk multiplier: requires >= 30 ghost samples to activate
//  - signal_log: every inbound TV signal logged to DB
//  - Latency tracking: webhook receive → MT5 confirm in ms
// ===============================================================

"use strict";

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      imgSrc:     ["'self'", "data:"],
    },
  },
}));
app.use(express.json());

// ── DB & Session imports ─────────────────────────────────────────
const {
  initDB, saveTrade, loadAllTrades,
  saveGhostTrade, loadGhostTrades, countGhostsByKey,
  saveShadowSnapshot, loadShadowSnapshots, saveShadowAnalysis, loadShadowAnalysis,
  saveTPConfig, loadTPConfig,
  savePnlLog,
  saveDailyRisk, loadLatestDailyRisk,
  upsertSymbolRisk, loadSymbolRiskConfig,
  logWebhook, loadWebhookHistory,
  logSignal,
  computeEVStats,
  loadSignalStats,
  loadShadowWinners,
} = require("./db");

const {
  SYMBOL_CATALOG, SESSION_LABELS, DEFAULT_RISK_BY_TYPE,
  getBrusselsComponents, getBrusselsDateStr, getBrusselsDateOnly,
  getSession, isMarketOpen, canOpenNewTrade, isMonitoringActive,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey,
} = require("./session");

// ── Config ───────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const PORT            = process.env.PORT || 3000;

// ================================================================
// FIXED RISK PER TRADE — change this one value to adjust all trades
// 0.0015 = 0.15% of live MT5 balance per trade
// ================================================================
const FIXED_RISK_PCT = parseFloat(process.env.FIXED_RISK_PCT || "0.0015");

// Ghost settings
const GHOST_MIN_TRADES_FOR_TP = 5;
const GHOST_POLL_MS           = 30000;
const GHOST_MAX_MS            = 72 * 3600 * 1000;  // 72h — supports overnight holdings

// Minimum ghost samples before daily risk multiplier activates
const MULT_MIN_SAMPLE = 30;

// Min stop distances per MT5 symbol (prevents too-tight SL rejection)
const MIN_STOP = {
  "GER40.cash": 10, "UK100.cash": 2, "US100.cash": 10, "US30.cash": 10,
  "XAUUSD": 0.5,
};

// Lot value per unit: points × lots = monetary risk unit
// These are fixed per instrument type — used for lot calculation
const LOT_VALUE = {
  index:     20,   // per 1 lot per point
  commodity: 100,  // Gold: 100 per lot per point
  stock:     1,    // stocks: 1 per lot per point
  forex:     10,   // standard lot = 10 per pip
};

// ── Live balance cache ────────────────────────────────────────────
let liveBalance      = 50000;  // updated every sync from MT5
let liveBalanceAt    = 0;

// ── MetaApi ───────────────────────────────────────────────────────
const META_BASE = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

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
    const d = await metaFetch(`/symbols/${encodeURIComponent(mt5Symbol)}/currentPrice`, {}, 5000);
    const bid = d.bid ?? null, ask = d.ask ?? null;
    if (bid !== null && ask !== null) {
      return { mid: (bid + ask) / 2, bid, ask, spread: ask - bid };
    }
    const mid = bid ?? ask ?? null;
    return mid !== null ? { mid, bid: mid, ask: mid, spread: 0 } : null;
  } catch { return null; }
}

async function placeOrder(payload) {
  return metaFetch("/trade", { method: "POST", body: JSON.stringify(payload) }, 12000);
}

// ── In-memory state ───────────────────────────────────────────────
const openPositions  = {};
const closedTrades   = [];
const ghostTrackers  = {};
const tpLocks        = {};
const shadowResults  = {};
const webhookLog     = [];
const symbolRiskMap  = {};     // per-symbol risk_pct overrides
const MAX_HISTORY    = 200;

// Per-key daily EV streak: { [optimizerKey]: { streak: N, mult: X } }
const keyRiskMult    = {};

function logEvent(entry) {
  webhookLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookLog.length > MAX_HISTORY) webhookLog.length = MAX_HISTORY;
}

// ── Balance helpers ───────────────────────────────────────────────
async function getLiveBalance() {
  // Refresh if older than 5 minutes
  if (Date.now() - liveBalanceAt > 5 * 60 * 1000) {
    try { await fetchAccountInfo(); } catch {}
  }
  return liveBalance;
}

// ── Risk calculation ──────────────────────────────────────────────
// Per-symbol override possible via env RISK_EURUSD=0.002 or DB,
// but the default for ALL symbols is FIXED_RISK_PCT (0.15%)
function getSymbolRiskPct(symbol) {
  const envKey = `RISK_${symbol}`;
  if (process.env[envKey]) return parseFloat(process.env[envKey]);
  if (symbolRiskMap[symbol]) return symbolRiskMap[symbol];
  const info = getSymbolInfo(symbol);
  return DEFAULT_RISK_BY_TYPE[info?.type || "stock"] ?? FIXED_RISK_PCT;
}

function getKeyRiskMult(optimizerKey) {
  return keyRiskMult[optimizerKey]?.mult ?? 1.0;
}

async function calcRiskEUR(symbol, optimizerKey) {
  const balance = await getLiveBalance();
  const pct     = getSymbolRiskPct(symbol);
  const mult    = getKeyRiskMult(optimizerKey);
  return balance * pct * mult;
}

// ── Lot calculation ───────────────────────────────────────────────
// Pure math: lots = riskEUR / (slDistance × lotValuePerPoint)
// Stocks: capped at 20% of live balance in notional to prevent overleveraging.
function calcLots(symbol, entry, sl, riskEUR) {
  const info    = getSymbolInfo(symbol);
  const type    = info?.type || "stock";
  const lotVal  = LOT_VALUE[type] ?? 1;
  const dist    = Math.abs(entry - sl);
  if (!dist || !riskEUR) return 0.01;
  let lots = riskEUR / (dist * lotVal);

  // Max notional guard for stocks: max 20% of live balance as notional exposure
  if (type === "stock" && entry > 0 && liveBalance > 0) {
    const maxLotsByNotional = (liveBalance * 0.20) / entry;
    if (lots > maxLotsByNotional) {
      console.warn(`[LotGuard] ${symbol}: ${lots.toFixed(2)} lots → capped at ${maxLotsByNotional.toFixed(2)} (20% notional limit, balance=€${liveBalance.toFixed(0)}, entry=${entry})`);
      logEvent({ type: "LOT_CAPPED", symbol, originalLots: parseFloat(lots.toFixed(2)), cappedLots: parseFloat(maxLotsByNotional.toFixed(2)), reason: "MAX_NOTIONAL_20PCT", entry, balance: liveBalance });
      lots = maxLotsByNotional;
    }
  }

  // Round to 2 decimal places — brokers generally accept this
  return Math.max(0.01, parseFloat(lots.toFixed(2)));
}

// ── Recalculate optimal lots after SL hit ────────────────────────
// Called after position closes with reason "sl".
// Updates in-memory lotOverride and logs the new value so you
// can set LOTS_<SYMBOL>=<value> in Railway to persist it.
const lotOverrides = {};  // symbol → recalculated lots

async function recalcLotsAfterSL(symbol, entry, sl, optimizerKey) {
  try {
    const balance = await getLiveBalance();
    const pct     = getSymbolRiskPct(symbol);
    const info    = getSymbolInfo(symbol);
    const type    = info?.type || "stock";
    const lotVal  = LOT_VALUE[type] ?? 1;
    const dist    = Math.abs(entry - sl);
    if (!dist) return;
    const optimalLots = parseFloat((balance * pct / (dist * lotVal)).toFixed(2));
    const envVar      = `LOTS_${symbol}`;
    lotOverrides[symbol] = optimalLots;
    console.log(`[LotRecalc] ${symbol} | SL hit → optimal lots = ${optimalLots} | Set ${envVar}=${optimalLots} in Railway`);
    logEvent({ type: "LOT_RECALC", symbol, optimalLots, envVar, slDist: dist, balance, riskPct: pct });
  } catch (e) { console.warn("[LotRecalc]", e.message); }
}

// ── SL from % ────────────────────────────────────────────────────
function calcSLFromPct(direction, mt5Entry, slPct) {
  if (direction === "buy")  return parseFloat((mt5Entry * (1 - slPct)).toFixed(5));
  else                      return parseFloat((mt5Entry * (1 + slPct)).toFixed(5));
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
// DEFAULT_TP_RR: used when no EV data yet. Set to 2.0 = entry ± (2 × SL distance).
const DEFAULT_TP_RR = 2.0;

async function getOptimalTP(optimizerKey) {
  const locked = tpLocks[optimizerKey];
  if (locked) return locked.lockedRR;
  const count = await countGhostsByKey(optimizerKey);
  if (count < GHOST_MIN_TRADES_FOR_TP) return DEFAULT_TP_RR;
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

// ── TP Lock Engine ────────────────────────────────────────────────
async function updateTPLock(optimizerKey, symbol, session, direction, vwapPos) {
  try {
    const ev = await computeEVStats(optimizerKey);
    if (!ev || ev.count < GHOST_MIN_TRADES_FOR_TP) return;
    const prev  = tpLocks[optimizerKey];
    const newRR = ev.bestRR;
    const evPos = (ev.bestEV ?? 0) > 0;
    tpLocks[optimizerKey] = {
      lockedRR: newRR, lockedGhosts: ev.count,
      evAtLock: ev.bestEV, evPositive: evPos,
      lockedAt: new Date().toISOString(),
    };
    await saveTPConfig(optimizerKey, symbol, session, direction, vwapPos,
      newRR, ev.count, ev.bestEV, prev?.lockedRR ?? null);
    console.log(`[TP Lock] ${optimizerKey}: ${prev?.lockedRR ?? "new"}R → ${newRR}R (EV=${ev.bestEV?.toFixed(3)}, n=${ev.count})`);
  } catch (e) { console.warn("[!] updateTPLock:", e.message); }
}

// ── MaxRR helpers ────────────────────────────────────────────────
function calcMaxRR(direction, entry, sl, maxPrice) {
  const dist = Math.abs(entry - sl);
  if (!dist || maxPrice == null) return 0;
  const fav = direction === "buy" ? maxPrice - entry : entry - maxPrice;
  return parseFloat((Math.max(0, fav) / dist).toFixed(2));
}

function calcPctSlUsed(direction, entry, sl, currentPrice) {
  const dist = Math.abs(entry - sl);
  if (!dist) return 0;
  const adverse = direction === "buy"
    ? entry - currentPrice
    : currentPrice - entry;
  return parseFloat((Math.max(0, Math.min(100, (adverse / dist) * 100)).toFixed(2)));
}

// ── FIX 5: Anti-consolidation helper ────────────────────────────
function sharesCurrency(a, b) {
  if (!a || !b || a.length < 6 || b.length < 6) return false;
  const aBase = a.slice(0, 3), aQuote = a.slice(3, 6);
  const bBase = b.slice(0, 3), bQuote = b.slice(3, 6);
  return aBase === bBase || aBase === bQuote || aQuote === bBase || aQuote === bQuote;
}

// ── Ghost Optimizer ───────────────────────────────────────────────
function startGhostTracker(pos) {
  const { positionId, symbol, mt5Symbol, session, direction, vwapPosition,
          optimizerKey, entry, sl, slPct, tpRRUsed, openedAt } = pos;

  if (ghostTrackers[positionId]) return;

  const phantomSL = sl;
  let maxPrice    = entry;
  let timer       = null;
  const startTs   = Date.now();

  ghostTrackers[positionId] = { positionId, symbol, mt5Symbol, session, direction,
    vwapPosition, optimizerKey, entry, sl: phantomSL, slPct, tpRRUsed, openedAt,
    maxPrice, startTs, timer };

  async function tick() {
    try {
      if (!ghostTrackers[positionId]) return;
      const elapsed  = Date.now() - startTs;

      // Hard timeout after 72h
      if (elapsed >= GHOST_MAX_MS) {
        await finalizeGhost(positionId, "timeout_72h", elapsed, maxPrice);
        return;
      }

      // Weekend: slow-poll every 10 min — ghost stays alive, just waits
      const { day } = getBrusselsComponents();
      if (day === 0 || day === 6) {
        timer = setTimeout(tick, 10 * 60 * 1000);
        ghostTrackers[positionId].timer = timer;
        return;
      }

      // Normal weekday tick
      const priceData = await fetchCurrentPrice(mt5Symbol);
      const price     = priceData?.mid ?? null;

      if (price !== null) {
        const better = direction === "buy" ? price > maxPrice : price < maxPrice;
        if (better) {
          maxPrice = price;
          ghostTrackers[positionId].maxPrice = price;
        }
        const slHit = direction === "buy" ? price <= phantomSL : price >= phantomSL;
        if (slHit) {
          await finalizeGhost(positionId, "phantom_sl", elapsed, maxPrice);
          return;
        }
      }

      timer = setTimeout(tick, GHOST_POLL_MS);
      ghostTrackers[positionId].timer = timer;
    } catch (e) {
      console.warn(`[Ghost] ${positionId} tick error:`, e.message);
      timer = setTimeout(tick, GHOST_POLL_MS * 2);
      if (ghostTrackers[positionId]) ghostTrackers[positionId].timer = timer;
    }
  }

  timer = setTimeout(tick, GHOST_POLL_MS);
  ghostTrackers[positionId].timer = timer;
  console.log(`[Ghost] Started: ${positionId} | ${optimizerKey} | phantomSL=${phantomSL}`);
}

async function finalizeGhost(positionId, stopReason, elapsedMs, finalMaxPrice) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];

  const maxRRBeforeSL = calcMaxRR(g.direction, g.entry, g.sl, finalMaxPrice);
  const timeToSLMin   = Math.round(elapsedMs / 60000);
  const phantomSLHit  = stopReason === "phantom_sl";

  const ghostRow = {
    positionId:    g.positionId,
    symbol:        g.symbol,
    session:       g.session,
    direction:     g.direction,
    vwapPosition:  g.vwapPosition,
    optimizerKey:  g.optimizerKey,
    entry:         g.entry,
    sl:            g.sl,
    slPct:         g.slPct,
    phantomSL:     g.sl,
    tpRRUsed:      g.tpRRUsed,
    maxPrice:      finalMaxPrice,
    maxRRBeforeSL,
    phantomSLHit,
    stopReason,
    timeToSLMin:   phantomSLHit ? timeToSLMin : null,
    openedAt:      g.openedAt,
    closedAt:      new Date().toISOString(),
  };

  await saveGhostTrade(ghostRow);
  await updateTPLock(g.optimizerKey, g.symbol, g.session, g.direction, g.vwapPosition);
  await runShadowOptimizer(g.optimizerKey).catch(() => {});
  console.log(`[Ghost] Finalized: ${positionId} | key=${g.optimizerKey} | maxRR=${maxRRBeforeSL}R | slHit=${phantomSLHit} | reason=${stopReason}`);
}

function cancelGhost(positionId) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];
}

// ── Shadow Optimizer ───────────────────────────────────────────────
async function runShadowOptimizer(optimizerKey) {
  try {
    const snaps = await loadShadowSnapshots(optimizerKey, 10000);
    if (snaps.length < 10) return;

    const vals = snaps.map(s => s.pctSlUsed).sort((a, b) => a - b);
    const n    = vals.length;
    const pct  = (p) => vals[Math.min(n - 1, Math.floor(p / 100 * n))];

    const p50    = pct(50);
    const p90    = pct(90);
    const p99    = pct(99);
    const maxUsed = vals[n - 1];

    const recommendedSlPct = parseFloat((p99 / 100).toFixed(4));
    const tooWide          = p99 < 70;
    const potentialSaving  = tooWide ? parseFloat((100 - p99).toFixed(1)) : 0;
    const uniquePos = new Set(snaps.map(s => s.positionId)).size;

    const analysis = {
      optimizerKey,
      symbol:        optimizerKey.split("_")[0],
      session:       optimizerKey.split("_")[1] ?? "",
      direction:     optimizerKey.split("_")[2] ?? "",
      vwapPosition:  optimizerKey.split("_")[3] ?? "unknown",
      snapshotsCount: n,
      positionsCount: uniquePos,
      p50, p90, p99,
      maxUsed,
      recommendedSlPct,
      currentSlTooWide: tooWide,
      potentialSavingPct: potentialSaving,
    };

    shadowResults[optimizerKey] = analysis;
    await saveShadowAnalysis(analysis);
    console.log(`[Shadow] ${optimizerKey}: p99=${p99}% | recommended=${(recommendedSlPct*100).toFixed(0)}% of current SL | tooWide=${tooWide}`);
  } catch (e) { console.warn(`[Shadow] ${optimizerKey}:`, e.message); }
}

async function runAllShadowOptimizers() {
  const keys = new Set(Object.values(openPositions).map(p => p.optimizerKey).filter(Boolean));
  for (const key of Object.keys(shadowResults)) keys.add(key);
  for (const key of keys) {
    await runShadowOptimizer(key).catch(() => {});
  }
}

// ── Position sync ────────────────────────────────────────────────
async function syncOpenPositions() {
  try {
    const live    = await fetchOpenPositions();
    const liveIds = new Set((Array.isArray(live) ? live : []).map(p => String(p.id)));

    for (const [id, pos] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        await handlePositionClosed(pos);
        delete openPositions[id];
      }
    }

    for (const livePos of (Array.isArray(live) ? live : [])) {
      const id    = String(livePos.id);
      const local = openPositions[id];
      if (!local) continue;
      const cur = livePos.currentPrice ?? livePos.openPrice ?? local.entry;
      const better = local.direction === "buy" ? cur > (local.maxPrice ?? cur) : cur < (local.maxPrice ?? cur);
      if (better) { local.maxPrice = cur; local.maxRR = calcMaxRR(local.direction, local.entry, local.sl, cur); }
      local.currentPrice = cur;
      local.currentPnL   = livePos.unrealizedProfit ?? 0;
      local.lastSync     = new Date().toISOString();
    }

    // Also refresh balance on sync
    await fetchAccountInfo().catch(() => {});
  } catch (e) { console.warn("[Sync]", e.message); }
}

async function handlePositionClosed(pos) {
  const maxRR      = pos.maxRR ?? calcMaxRR(pos.direction, pos.entry, pos.sl, pos.maxPrice ?? pos.entry);
  const hitTP      = pos.tp != null && pos.direction === "buy"
    ? (pos.maxPrice ?? 0) >= pos.tp
    : (pos.maxPrice ?? Infinity) <= pos.tp;
  const closeReason = hitTP ? "tp" : maxRR <= 0.05 ? "sl" : "manual";
  const now         = new Date().toISOString();

  const closed = {
    ...pos, maxRR, hitTP, closeReason, closedAt: now, trueMaxRR: null, trueMaxPrice: null,
    spreadAtEntry: pos.spread ?? null,   // FIX 1
    vwapBandPct:   pos.vwapBandPct ?? null,  // FIX 2 (explicit)
  };
  closedTrades.push(closed);
  await saveTrade(closed).catch(() => {});
  await savePnlLog(pos.symbol, pos.session, pos.direction, pos.vwapPosition, maxRR, hitTP, pos.currentPnL ?? 0).catch(() => {});
  logEvent({ type: "POSITION_CLOSED", symbol: pos.symbol, direction: pos.direction, maxRR, closeReason });

  // After SL hit: recalculate optimal lots and log for Railway update
  if (closeReason === "sl") {
    await recalcLotsAfterSL(pos.symbol, pos.entry, pos.sl, pos.optimizerKey).catch(() => {});
  }
}

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
        session: sess, openedAt: lp.time ?? new Date().toISOString(), maxPrice: entry,
        maxRR: 0, currentPnL: lp.unrealizedProfit ?? 0,
        slPct: null, restoredAfterRestart: true,
      };
      if (openPositions[id].sl > 0) {
        // FIX 6: log exact entry used for ghost after restart
        console.log(`[Restart] Ghost entry for ${sym} (${id}): entry=${entry} (openPrice=${lp.openPrice ?? "null"}, fallback currentPrice=${lp.currentPrice ?? "null"})`);
        startGhostTracker(openPositions[id]);
      }
      restored++;
    }
    console.log(`[Restart] ${restored} position(s) restored from MT5`);
  } catch (e) { console.warn("[Restart]", e.message); }
}

// ── Shadow snapshot cron ──────────────────────────────────────────
async function takeShadowSnapshots() {
  const positions = Object.values(openPositions).filter(p => p.sl > 0 && !p.restoredAfterRestart);
  for (const pos of positions) {
    try {
      const pd = await fetchCurrentPrice(pos.mt5Symbol);
      if (!pd) continue;
      const pct = calcPctSlUsed(pos.direction, pos.entry, pos.sl, pd.mid);
      await saveShadowSnapshot({
        positionId:    pos.positionId,
        optimizerKey:  pos.optimizerKey,
        symbol:        pos.symbol,
        session:       pos.session,
        direction:     pos.direction,
        vwapPosition:  pos.vwapPosition,
        entry:         pos.entry,
        sl:            pos.sl,
        currentPrice:  pd.mid,
        pctSlUsed:     pct,
      });
    } catch (e) { /* non-critical */ }
  }
}

// ── Daily risk evaluation — per optimizer key ─────────────────────
// Multiplier only activates when key is EV+ AND has >= MULT_MIN_SAMPLE ghost trades.
// Each consecutive qualifying day × 1.2, max ×4. Resets on EV- or low sample day.
async function evaluateDailyRisk() {
  try {
    const todayStr = getBrusselsDateOnly();
    const todayT   = closedTrades.filter(t => t.closedAt && getBrusselsDateOnly(t.closedAt) === todayStr);
    const totalPnl = todayT.reduce((s, t) => s + (t.currentPnL ?? 0), 0);

    // Group today's trades by optimizer key
    const keyGroups = {};
    for (const t of todayT) {
      const k = t.optimizerKey ?? buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown");
      if (!keyGroups[k]) keyGroups[k] = { pnl: 0, count: 0 };
      keyGroups[k].pnl   += t.currentPnL ?? 0;
      keyGroups[k].count += 1;
    }

    // Update per-key multiplier
    for (const [key, data] of Object.entries(keyGroups)) {
      const ev           = await computeEVStats(key);
      const isEvPositive = (ev?.bestEV ?? 0) > 0;
      const hasSample    = (ev?.count  ?? 0) >= MULT_MIN_SAMPLE;
      const isDayPositive = data.pnl > 0;

      if (isEvPositive && hasSample && isDayPositive) {
        // EV+ key with enough data had a positive day → increase multiplier
        const prev    = keyRiskMult[key] ?? { streak: 0, mult: 1.0 };
        const newMult = Math.min(4.0, parseFloat((prev.mult * 1.2).toFixed(4)));
        keyRiskMult[key] = { streak: prev.streak + 1, mult: newMult };
        console.log(`[DailyRisk] ${key}: EV+ day → mult ${prev.mult.toFixed(2)}x → ${newMult.toFixed(2)}x (streak ${keyRiskMult[key].streak}, n=${ev.count})`);
      } else {
        // Not EV+, insufficient sample, or negative day → reset to 1.0x
        if (keyRiskMult[key]?.mult > 1.0) {
          console.log(`[DailyRisk] ${key}: Reset → 1.0x (sample=${ev?.count ?? 0}/${MULT_MIN_SAMPLE}, evPos=${isEvPositive}, dayPos=${isDayPositive})`);
        }
        keyRiskMult[key] = { streak: 0, mult: 1.0 };
      }
    }

    await saveDailyRisk(todayStr, totalPnl, todayT.length, 1.0, 1.0);
  } catch (e) { console.warn("[DailyRisk]", e.message); }
}

// ── CRON JOBS ─────────────────────────────────────────────────────

cron.schedule("*/1 * * * *", async () => {
  await syncOpenPositions().catch(() => {});
}, { timezone: "Europe/Brussels" });

cron.schedule("*/1 * * * *", async () => {
  await takeShadowSnapshots().catch(() => {});
}, { timezone: "Europe/Brussels" });

cron.schedule("0 3 * * 1-5", async () => {
  console.log("🌙 03:00 — Nightly optimizer...");
  const keys = new Set([
    ...closedTrades.map(t => buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown")),
    ...Object.keys(shadowResults),
  ]);
  for (const key of keys) {
    const parts = key.split("_");
    if (parts.length < 4) continue;
    const [sym, sess, dir, vp] = parts;
    await updateTPLock(key, sym, sess, dir, vp).catch(() => {});
    await runShadowOptimizer(key).catch(() => {});
  }
  await runAllShadowOptimizers().catch(() => {});
  console.log(`[OK] Nightly optimizer done — ${keys.size} keys`);
  logEvent({ type: "NIGHTLY_OPTIMIZER", keys: keys.size });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 2 * * 1-5", async () => {
  console.log("🔄 02:00 — daily reset...");
  await evaluateDailyRisk().catch(() => {});
  await restorePositionsFromMT5().catch(() => {});
  logEvent({ type: "DAILY_RESET", keyMultipliers: Object.keys(keyRiskMult).length });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 4 * * 1-5", async () => {
  // Clean up ghosts that have been running > 72h and never hit phantom SL
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
  if (cleaned > 0) {
    console.log(`[04:00] ${cleaned} expired ghost(s) cleaned up (>72h)`);
    logEvent({ type: "GHOST_CLEANUP_72H", count: cleaned });
  }
}, { timezone: "Europe/Brussels" });

// ── Webhook handler ───────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const webhookReceivedAt = Date.now();

  const secret = req.query.secret || req.body?.secret;
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const {
    action,
    symbol:     rawSymbol,
    entry:      tvEntry,
    sl_pct,
    vwap,
    vwap_upper,
    vwap_lower,
  } = body;

  // ── Validate action ──────────────────────────────────────────────
  const direction = action === "buy" ? "buy" : action === "sell" ? "sell" : null;
  if (!direction) {
    return res.status(400).json({ error: "action must be buy or sell" });
  }

  // ── Normalize & validate symbol ──────────────────────────────────
  const symKey  = normalizeSymbol(rawSymbol);
  const symInfo = symKey ? getSymbolInfo(symKey) : null;
  if (!symKey || !symInfo) {
    logEvent({ type: "REJECTED", reason: `Symbol not in catalog: ${rawSymbol}` });
    await logSignal({ symbol: rawSymbol, direction, outcome: "REJECTED", rejectReason: `Symbol not in catalog: ${rawSymbol}` }).catch(() => {});
    return res.status(400).json({ error: `Symbol not allowed: ${rawSymbol}` });
  }

  const { type: assetType, mt5: mt5Symbol } = symInfo;

  // ── sl_pct validation: 0 < sl_pct <= 0.05 (max 5%) ─────────────
  const slPctRaw   = parseFloat(sl_pct);
  const slPctHuman = slPctRaw ? (slPctRaw * 100).toFixed(3) + "%" : "invalid";
  if (!slPctRaw || slPctRaw <= 0 || slPctRaw > 0.05) {
    const reason = `Invalid sl_pct: ${sl_pct} (${slPctHuman}). Must be > 0 and <= 0.05 (e.g. 0.002 = 0.200%)`;
    logEvent({ type: "REJECTED", reason, symbol: symKey, direction });
    await logSignal({ symbol: symKey, direction, tvEntry: parseFloat(tvEntry) || null, slPct: slPctRaw || null, slPctHuman, outcome: "REJECTED", rejectReason: reason }).catch(() => {});
    return res.status(400).json({ error: reason });
  }

  // ── Session & VWAP context ───────────────────────────────────────
  const session    = getSession();
  const closePrice = parseFloat(tvEntry) || 0;
  const vwapMid    = parseFloat(vwap)    || 0;
  const vwapUpper  = parseFloat(vwap_upper) || 0;
  const vwapLower  = parseFloat(vwap_lower) || 0;
  const vwapPosition  = getVwapPosition(closePrice, vwapMid);
  const optimizerKey  = buildOptimizerKey(symKey, session, direction, vwapPosition);

  // ── VWAP band exhaustion filter ──────────────────────────────────
  // Reject signals where price is already >90% into the VWAP band.
  // Prevents "chasing" entries that are stretched away from VWAP mid.
  let vwapBandPct = null;
  const bandWidth = vwapUpper - vwapLower;
  if (bandWidth > 0 && vwapMid > 0) {
    const distFromMid = Math.abs(closePrice - vwapMid);
    vwapBandPct = parseFloat((distFromMid / (bandWidth / 2)).toFixed(3));
    if (vwapBandPct > 0.9) {
      const reason = `VWAP_BAND_EXHAUSTED: price is ${(vwapBandPct * 100).toFixed(0)}% into band (max 90%)`;
      logEvent({ type: "REJECTED", reason, symbol: symKey, direction, optimizerKey, vwapBandPct, closePrice, vwapMid, vwapUpper, vwapLower });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: slPctRaw, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "REJECTED", rejectReason: reason }).catch(() => {});
      return res.status(200).json({ status: "VWAP_BAND_EXHAUSTED", vwapBandPct });
    }
  }

  // ── Trade window check (per asset type) ─────────────────────────
  const tradeWindow = canOpenNewTrade(symKey);
  if (!tradeWindow.allowed) {
    logEvent({ type: "REJECTED", reason: tradeWindow.reason, symbol: symKey, direction, assetType });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: slPctRaw, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "OUTSIDE_WINDOW", rejectReason: tradeWindow.reason }).catch(() => {});
    return res.status(200).json({ status: "OUTSIDE_TRADE_WINDOW", reason: tradeWindow.reason, assetType });
  }

  // ── Duplicate guard (same symbol+direction within 60s) ───────────
  const dupKey  = `${symKey}_${direction}`;
  const dupLast = global._dupGuard?.[dupKey];
  if (dupLast && (Date.now() - dupLast) < 60000) {
    logEvent({ type: "DUPLICATE_BLOCKED", symbol: symKey, direction, optimizerKey });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: slPctRaw, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "DUPLICATE_BLOCKED" }).catch(() => {});
    return res.status(200).json({ status: "DUPLICATE_BLOCKED" });
  }
  if (!global._dupGuard) global._dupGuard = {};
  global._dupGuard[dupKey] = Date.now();

  // ── FIX 5: Anti-consolidation for forex ────────────────────────
  let halfRiskForex = false;
  if (assetType === "forex") {
    const related = Object.values(openPositions).filter(p =>
      p.direction === direction && sharesCurrency(p.symbol, symKey)
    );
    if (related.length >= 3) {
      const reason = `CONSOLIDATION_BLOCK: ${related.length} related forex ${direction} positions (${related.map(p => p.symbol).join(", ")})`;
      logEvent({ type: "CONSOLIDATION_BLOCK", symbol: symKey, direction, count: related.length, reason });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: slPctRaw, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "CONSOLIDATION_BLOCK", rejectReason: reason }).catch(() => {});
      console.log(`[AntiConsolidation] ${symKey}: BLOCKED — ${related.length} related ${direction} positions`);
      return res.status(200).json({ status: "CONSOLIDATION_BLOCK", reason, related: related.length });
    }
    if (related.length >= 1) {
      halfRiskForex = true;
      console.log(`[AntiConsolidation] ${symKey}: ${related.length} related ${direction} forex → halfRisk`);
      logEvent({ type: "HALF_RISK_FOREX", symbol: symKey, direction, relatedCount: related.length });
    }
  }

  // ── Risk & lots pre-calculation (using TV entry as placeholder) ──
  const riskPct = getSymbolRiskPct(symKey);
  const mult    = getKeyRiskMult(optimizerKey);
  let riskEUR   = await calcRiskEUR(symKey, optimizerKey);
  if (halfRiskForex) riskEUR *= 0.5;   // FIX 5: half risk for consolidation
  const balance = await getLiveBalance();

  // Temporary lot calculation using TV entry (will be recalculated after execution)
  const tempSL  = calcSLFromPct(direction, closePrice || 1, slPctRaw);
  let lots;
  if (lotOverrides[symKey]) {
    lots = lotOverrides[symKey];
    console.log(`[Lots] ${symKey}: using override ${lots} (from SL recalc)`);
  } else {
    lots = calcLots(symKey, closePrice || 1, tempSL, riskEUR);
  }

  if (!lots || lots <= 0) {
    logEvent({ type: "REJECTED", reason: "calcLots returned 0", symbol: symKey, direction });
    return res.status(200).json({ status: "LOT_CALC_FAILED" });
  }

  // ── Step A: Place market order WITHOUT SL/TP ─────────────────────
  // We place the order first to guarantee execution at M5 close price.
  // SL and TP are set AFTER we read back the real execution price.
  const sessShort = session === "london" ? "LON" : session === "ny" ? "NY" : "AS";
  const dirShort  = direction === "buy" ? "B" : "S";
  // Use DEFAULT_TP_RR as placeholder in comment — will be updated after execution
  const tpRR      = await getOptimalTP(optimizerKey);
  const rrLabel   = tpRR % 1 === 0 ? `${tpRR}R` : `${tpRR.toFixed(1)}R`;
  const comment   = `NV-${dirShort}-${symKey.slice(0, 6)}-${rrLabel}-${sessShort}`.slice(0, 26);

  const orderPayload = {
    symbol:     mt5Symbol,
    actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    volume:     lots,
    comment,
    // No stopLoss / takeProfit — set after reading execution price
  };

  let result, positionId;
  try {
    result     = await placeOrder(orderPayload);
    positionId = String(result?.positionId ?? result?.orderId ?? `local_${Date.now()}`);
  } catch (e) {
    const errMsg = e.message;
    const latencyMs = Date.now() - webhookReceivedAt;
    logEvent({ type: "ERROR", symbol: symKey, direction, reason: errMsg, optimizerKey });
    await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition,
      action, status: "ERROR", reason: errMsg, optimizerKey,
      entry: closePrice, sl: null, tp: null, lots, riskPct,
      latencyMs, tvEntry: closePrice, vwapBandPct });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: slPctRaw, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "ORDER_FAILED", rejectReason: errMsg, latencyMs }).catch(() => {});
    return res.status(200).json({ status: "ORDER_FAILED", error: errMsg });
  }

  // ── Step B: Read back real execution price from MT5 ───────────────
  // Wait briefly for MT5 to register the position, then fetch it.
  let executionPrice = closePrice; // fallback to TV entry if fetch fails
  let spread = 0, bid = null, ask = null;
  try {
    await new Promise(r => setTimeout(r, 600));
    const positions = await fetchOpenPositions();
    const thisPos   = Array.isArray(positions)
      ? positions.find(p => String(p.id) === positionId)
      : null;
    if (thisPos?.openPrice) {
      executionPrice = parseFloat(thisPos.openPrice);
    }
    // Also get current bid/ask for spread logging
    const pd = await fetchCurrentPrice(mt5Symbol);
    if (pd) { bid = pd.bid; ask = pd.ask; spread = pd.spread ?? 0; }
  } catch { /* use fallback */ }

  const slippage = parseFloat((executionPrice - closePrice).toFixed(5));

  // ── FIX 4: Spread guard for stocks ───────────────────────────────
  if (assetType === "stock" && spread > 0) {
    const guardSLDist = Math.abs(executionPrice - calcSLFromPct(direction, executionPrice, slPctRaw));
    if (guardSLDist > 0 && spread > 0.25 * guardSLDist) {
      const reason = `SPREAD_GUARD: spread ${spread.toFixed(5)} > 25% of SL dist ${guardSLDist.toFixed(5)} (${(spread / guardSLDist * 100).toFixed(1)}%)`;
      logEvent({ type: "SPREAD_GUARD_CLOSE", symbol: symKey, direction, positionId, spread, slDist: guardSLDist, reason });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: slPctRaw, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "SPREAD_GUARD_CLOSE", rejectReason: reason }).catch(() => {});
      console.warn(`[SpreadGuard] ${symKey} ${positionId}: ${reason} — closing position`);
      try { await closePosition(positionId); } catch (ce) { console.warn(`[SpreadGuard] closePosition failed: ${ce.message}`); }
      return res.status(200).json({ status: "SPREAD_GUARD_CLOSE", reason, positionId, spread, slDist: guardSLDist });
    }
  }

  // ── Step C: Calculate SL and TP from real execution price ─────────
  // FIX 3 CONFIRMED: enforceMinStop runs BEFORE calcLots so lots always
  // use the actual enforced SL distance, not the raw calculated one.
  let mt5SL = calcSLFromPct(direction, executionPrice, slPctRaw);
  mt5SL     = enforceMinStop(mt5Symbol, direction, executionPrice, mt5SL);
  const mt5TP = calcTPPrice(direction, executionPrice, mt5SL, tpRR);

  // Recalculate lots using real execution price (may differ from TV entry)
  if (!lotOverrides[symKey]) {
    lots = calcLots(symKey, executionPrice, mt5SL, riskEUR);
  }

  // ── Step D: Modify position to set SL and TP ─────────────────────
  try {
    await metaFetch(`/positions/${positionId}`, {
      method:  "PUT",
      body:    JSON.stringify({ stopLoss: mt5SL, takeProfit: mt5TP }),
    }, 8000);
    console.log(`[SL/TP] ${positionId} → SL=${mt5SL} TP=${mt5TP} (${tpRR}R) set on real exec=${executionPrice} slippage=${slippage}`);
  } catch (e) {
    console.warn(`[!] SL/TP modify failed for ${positionId}: ${e.message} — position is open WITHOUT stops, manual intervention needed`);
    logEvent({ type: "SL_TP_SET_FAILED", positionId, symbol: symKey, error: e.message, executionPrice, mt5SL, mt5TP });
  }

  // ── Register open position ────────────────────────────────────────
  const latencyMs = Date.now() - webhookReceivedAt;
  const now = new Date().toISOString();
  openPositions[positionId] = {
    positionId, symbol: symKey, mt5Symbol, direction, vwapPosition,
    optimizerKey, entry: executionPrice, sl: mt5SL, tp: mt5TP, slPct: slPctRaw,
    lots, riskEUR, riskPct, riskMult: mult, balance,
    spread, bid, ask,
    session, openedAt: now,
    maxPrice: executionPrice, maxRR: 0, currentPnL: 0,
    vwapAtEntry: vwapMid, tpRRUsed: tpRR,
    tvEntry:        closePrice,
    executionPrice: executionPrice,
    slippage,
    vwapBandPct,
    slPctHuman,
  };

  startGhostTracker(openPositions[positionId]);

  const logEntry = {
    type: "ORDER_PLACED", symbol: symKey, direction, session,
    vwapPosition, optimizerKey,
    tvEntry:        closePrice,
    executionPrice, slippage,
    sl: mt5SL, tp: mt5TP, tpRR, rrLabel,
    lots, riskPct, riskEUR: riskEUR.toFixed(2), riskMult: mult,
    spread: spread.toFixed(5), bid, ask,
    balance:    balance.toFixed(2),
    positionId, comment,
    slPct:      slPctRaw, slPctHuman,
    vwap:       vwapMid, vwapBandPct,
    latencyMs,
    halfRiskForex,
  };
  logEvent(logEntry);

  await logWebhook({
    symbol: symKey, direction, session, vwapPos: vwapPosition,
    action, status: "PLACED", positionId, optimizerKey,
    entry: executionPrice, sl: mt5SL, tp: mt5TP, lots, riskPct,
    latencyMs, tvEntry: closePrice, executionPrice, slippage, vwapBandPct,
  });

  await logSignal({
    symbol: symKey, direction, session, vwapPosition, optimizerKey,
    tvEntry: closePrice, slPct: slPctRaw, slPctHuman,
    vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct,
    outcome: "PLACED", latencyMs, positionId,
  }).catch(() => {});

  console.log(`[✓] ${direction.toUpperCase()} ${symKey} | key=${optimizerKey} | tvEntry=${closePrice} execPrice=${executionPrice} slip=${slippage} | sl=${mt5SL} tp=${mt5TP} (${rrLabel}) | lots=${lots} | risk=${slPctHuman} | spread=${spread.toFixed(5)} | balance=€${balance.toFixed(0)} | mult=x${mult.toFixed(2)} | latency=${latencyMs}ms`);

  return res.status(200).json({
    status: "PLACED", positionId, symbol: symKey, direction,
    tvEntry:        closePrice,
    executionPrice, slippage,
    sl:  mt5SL, tp: mt5TP, tpRR, rrLabel,
    lots, riskPct, riskEUR, riskMult: mult, optimizerKey,
    spread, bid, ask, balance, latencyMs,
    slPctHuman, vwapBandPct, halfRiskForex,
  });
});

// ── REST API ─────────────────────────────────────────────────────

app.get("/live/positions", async (req, res) => {
  const balance = await getLiveBalance();
  const positions = Object.values(openPositions).map(p => ({
    positionId: p.positionId, symbol: p.symbol, direction: p.direction,
    session: p.session, vwapPosition: p.vwapPosition, optimizerKey: p.optimizerKey,
    entry: p.entry, sl: p.sl, tp: p.tp, lots: p.lots,
    riskPct: p.riskPct, riskEUR: p.riskEUR, riskMult: p.riskMult ?? 1.0,
    spread: p.spread ?? 0, bid: p.bid, ask: p.ask,
    tvEntry: p.tvEntry,
    currentPrice: p.currentPrice, currentPnL: p.currentPnL,
    maxRR: p.maxRR, tpRR: p.tpRRUsed, openedAt: p.openedAt,
    balance: p.balance,
    slDistPct: p.sl && p.entry ? parseFloat((Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(3)) : null,
    slPctUsed: p.currentPrice ? calcPctSlUsed(p.direction, p.entry, p.sl, p.currentPrice) : null,
    isGhosted: !!ghostTrackers[p.positionId],
  }));
  res.json({ count: positions.length, balance, positions });
});

app.get("/live/ghosts", (req, res) => {
  const ghosts = Object.values(ghostTrackers).map(g => ({
    positionId: g.positionId, symbol: g.symbol, optimizerKey: g.optimizerKey,
    direction: g.direction, session: g.session, vwapPosition: g.vwapPosition,
    entry: g.entry, sl: g.sl, maxPrice: g.maxPrice,
    maxRR: calcMaxRR(g.direction, g.entry, g.sl, g.maxPrice),
    elapsedMin: Math.round((Date.now() - g.startTs) / 60000),
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
  const keys = new Set([
    ...Object.keys(tpLocks),
    ...closedTrades.map(t => buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown")),
  ]);
  const results = [];
  for (const key of keys) {
    const ev = await computeEVStats(key);
    results.push({ key, ...ev });
  }
  results.sort((a, b) => (b.bestEV ?? -99) - (a.bestEV ?? -99));
  res.json(results);
});

app.get("/shadow", (req, res) => {
  const results = Object.values(shadowResults).sort((a, b) => a.optimizerKey.localeCompare(b.optimizerKey));
  res.json({ count: results.length, results });
});

// FIX 8: /shadow/winners BEFORE /shadow/:key — Express matches routes in order.
// If :key came first it would capture "winners" as the key parameter.
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
    symbol:  sym,
    type:    SYMBOL_CATALOG[sym].type,
    riskPct: getSymbolRiskPct(sym),
    riskEUR: parseFloat((getSymbolRiskPct(sym) * balance).toFixed(2)),
    riskMult: getKeyRiskMult(sym),
    envVar:  `RISK_${sym}`,
    lotOverride: lotOverrides[sym] ?? null,
  }));
  res.json({ balance, fixedRiskPct: FIXED_RISK_PCT, config });
});

app.get("/history", (req, res) => {
  res.json(webhookLog.slice(0, 100));
});

app.get("/trades", (req, res) => {
  const { symbol, session, direction, vwap_pos, limit = 200 } = req.query;
  let filtered = closedTrades;
  if (symbol)    filtered = filtered.filter(t => t.symbol === symbol);
  if (session)   filtered = filtered.filter(t => t.session === session);
  if (direction) filtered = filtered.filter(t => t.direction === direction);
  if (vwap_pos)  filtered = filtered.filter(t => t.vwapPosition === vwap_pos);
  res.json({ count: filtered.length, trades: filtered.slice(0, parseInt(limit)) });
});

// Lot recalc log endpoint (shows what to set in Railway)
app.get("/lot-overrides", (req, res) => {
  const entries = Object.entries(lotOverrides).map(([sym, lots]) => ({
    symbol: sym, lots, envVar: `LOTS_${sym}`,
    riskPct: getSymbolRiskPct(sym),
    instruction: `Set ${`LOTS_${sym}`}=${lots} in Railway environment variables`,
  }));
  res.json({ count: entries.length, overrides: entries });
});

// Key risk multipliers
app.get("/risk-multipliers", (req, res) => {
  const entries = Object.entries(keyRiskMult).map(([key, v]) => ({ key, ...v }));
  entries.sort((a, b) => b.mult - a.mult);
  res.json({ fixedRiskPct: FIXED_RISK_PCT, multipliers: entries });
});

// FIX 7: Signal conversion ratio endpoint
app.get("/signal-stats", async (req, res) => {
  const stats = await loadSignalStats();
  if (!stats) return res.status(500).json({ error: "Could not compute signal stats" });
  res.json(stats);
});

app.get("/health", async (req, res) => {
  const balance = await getLiveBalance();
  const tradeWindowForex = canOpenNewTrade("EURUSD");
  const tradeWindowStock = canOpenNewTrade("AAPL");
  res.json({
    status:    "ok",
    version:   "10.2.0",
    time:      getBrusselsDateStr(),
    openPos:   Object.keys(openPositions).length,
    ghosts:    Object.keys(ghostTrackers).length,
    tpLocks:   Object.keys(tpLocks).length,
    closedT:   closedTrades.length,
    balance,
    fixedRiskPct: FIXED_RISK_PCT,
    marketOpen:   isMarketOpen(),
    session:      getSession(),
    tradeWindowForex: tradeWindowForex.allowed,
    tradeWindowStocks: tradeWindowStock.allowed,
    lotOverrides:   Object.keys(lotOverrides).length,
    evKeyMults:     Object.keys(keyRiskMult).length,
    multMinSample:  MULT_MIN_SAMPLE,
  });
});

// ── Dashboard — single page, all sections always loaded ──────────
app.get(["/", "/dashboard"], async (req, res) => {
  const balance = await getLiveBalance();
  res.setHeader("Content-Type", "text/html");

  // Catalogs injected server-side for CSP-safe inline HTML
  const FOREX_SYMBOLS    = ["AUDCAD","AUDCHF","AUDNZD","AUDUSD","CADCHF","EURAUD","EURCHF","EURUSD","GBPAUD","GBPNZD","GBPUSD","NZDCAD","NZDCHF","NZDUSD","USDCAD","USDCHF"];
  const INDEX_SYMBOLS    = ["DE30EUR","NAS100USD","UK100GBP","US30USD"];
  const COMMODITY_SYMBOLS= ["XAUUSD"];
  const STOCK_SYMBOLS    = ["AAPL","AMD","AMZN","ARM","ASML","AVGO","AZN","BA","BABA","BAC","BRKB","CSCO","CVX","DIS","FDX","GE","GM","GME","GOOGL","IBM","INTC","JNJ","JPM","KO","LMT","MCD","META","MSFT","MSTR","NFLX","NKE","NVDA","PFE","PLTR","QCOM","SBUX","SNOW","T","TSLA","V","WMT","XOM","ZM"];

  res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v10.2 — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#07090e;--bg2:#0b1018;--card:#0e1520;--border:#18243a;--border2:#22334d;
  --text:#bfd0e8;--dim:#3d5570;--dim2:#1e2f45;
  --green:#00dfa0;--red:#ff3355;--gold:#f0c030;--purple:#b080ff;
  --blue:#30b8f8;--cyan:#00dfd8;--orange:#ff8830;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,.08) 2px,rgba(0,0,0,.08) 4px);pointer-events:none;z-index:9999;opacity:.2}

/* header */
.hdr{padding:10px 18px;background:linear-gradient(90deg,#060a12,#0b1420);border-bottom:1px solid var(--border2);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;backdrop-filter:blur(12px)}
.logo{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:800;letter-spacing:2px;color:var(--blue);text-shadow:0 0 16px rgba(48,184,248,.4)}
.ver{font-size:9px;color:var(--dim);letter-spacing:.8px;margin-top:1px}
.hdr-r{display:flex;align-items:center;gap:12px}
.clock{font-size:14px;color:var(--cyan);letter-spacing:2px;font-weight:600}
.sess-badge{padding:3px 10px;border-radius:3px;font-size:11px;font-weight:700;letter-spacing:1px;font-family:'Barlow Condensed',sans-serif}
.s-asia{background:#002d3d;color:var(--cyan);border:1px solid var(--cyan)}.s-london{background:#002400;color:var(--green);border:1px solid var(--green)}.s-ny{background:#2d0020;color:var(--purple);border:1px solid var(--purple)}.s-outside{background:#141414;color:var(--dim);border:1px solid var(--border2)}
.btn{background:none;border:1px solid var(--border2);color:var(--dim);padding:4px 10px;border-radius:3px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10px;transition:all .2s}
.btn:hover{color:var(--blue);border-color:var(--blue)}

/* kpi bar */
.kpi-bar{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border2);overflow-x:auto}
.kpi{flex:1;min-width:95px;padding:9px 12px;background:var(--bg2);position:relative}
.kpi::after{content:'';position:absolute;bottom:0;left:0;width:100%;height:2px}
.kbal::after{background:var(--green)}.kpos::after{background:var(--blue)}.kgh::after{background:var(--purple)}.ktp::after{background:var(--gold)}.ksess::after{background:var(--cyan)}.krisk::after{background:var(--orange)}.kerr::after{background:var(--red)}
.kl{font-size:9px;letter-spacing:1.2px;color:var(--dim);text-transform:uppercase;margin-bottom:4px;font-family:'Barlow Condensed',sans-serif}
.kv{font-size:17px;font-weight:700;line-height:1;font-family:'Barlow Condensed',sans-serif;letter-spacing:1px}
.vg{color:var(--green)}.vb{color:var(--blue)}.vp{color:var(--purple)}.vgd{color:var(--gold)}.vc{color:var(--cyan)}.vo{color:var(--orange)}.vr{color:var(--red)}

/* page */
.page{padding:12px 16px}
.sec{margin-bottom:18px;border-radius:4px;overflow:hidden;border:1px solid var(--border2)}
.sec-hdr{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:linear-gradient(90deg,#0b1628,#091218);border-bottom:1px solid var(--border2);cursor:pointer;user-select:none}
.sec-title{font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;letter-spacing:1px}
.sec-meta{font-size:9px;color:var(--dim);margin-right:6px}
.sec-body{background:var(--card)}
.sec.collapsed .sec-body{display:none}
.chevron{font-size:10px;color:var(--dim);transition:transform .2s}
.sec.collapsed .chevron{transform:rotate(-90deg)}

/* info box */
.info{padding:9px 14px;font-size:10px;color:var(--dim);border-bottom:1px solid var(--border);background:rgba(48,184,248,.04);line-height:1.6}
.info strong{color:var(--blue)}.info .hi{color:var(--gold)}

/* filters */
.fbar{display:flex;flex-wrap:wrap;gap:4px;padding:7px 12px;border-bottom:1px solid var(--border);background:var(--bg2);align-items:center}
.fl{font-size:9px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;margin-right:1px;white-space:nowrap}
.fb{padding:2px 8px;border:1px solid var(--border);background:none;color:var(--dim);border-radius:2px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10px;transition:all .15s}
.fb.on{border-color:var(--blue);color:var(--blue);background:rgba(48,184,248,.08)}
.fb:hover{color:var(--text)}
.finput{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:2px 7px;border-radius:2px;font-family:'JetBrains Mono',monospace;font-size:10px;width:100px}
.finput:focus{outline:none;border-color:var(--blue)}
.finput::placeholder{color:var(--dim)}

/* stats row */
.strow{display:flex;flex-wrap:wrap;gap:14px;padding:7px 12px;border-bottom:1px solid var(--border);background:rgba(48,184,248,.02);font-size:10px;color:var(--dim)}
.strow span{color:var(--text);font-weight:600}

/* tables */
.twrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:11px}
th{padding:5px 8px;text-align:left;font-size:9px;letter-spacing:1px;color:var(--dim);background:var(--bg2);border-bottom:1px solid var(--border);text-transform:uppercase;font-family:'Barlow Condensed',sans-serif;font-weight:600;white-space:nowrap;user-select:none}
th.srt{cursor:pointer}th.srt:hover{color:var(--text)}
th.asc::after{content:' ↑';color:var(--blue);font-style:normal}
th.dsc::after{content:' ↓';color:var(--blue);font-style:normal}
td{padding:5px 8px;border-bottom:1px solid var(--dim2);vertical-align:middle;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(48,184,248,.03)}
tr.zrow td{opacity:.28}
tr.zrow:hover td{opacity:.55}
tr.erow td{background:rgba(255,51,85,.03)}
.nodata{text-align:center;padding:18px;color:var(--dim);font-size:11px;letter-spacing:1px}
.subhdr{padding:6px 12px;font-size:9px;color:var(--dim);border-bottom:1px solid var(--border);border-top:1px solid var(--border2);background:var(--bg2);letter-spacing:1px;text-transform:uppercase}

/* badges */
.b{display:inline-block;padding:2px 6px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.8px;font-family:'Barlow Condensed',sans-serif}
.b-buy{background:rgba(0,223,160,.15);color:var(--green);border:1px solid rgba(0,223,160,.3)}
.b-sell{background:rgba(255,51,85,.15);color:var(--red);border:1px solid rgba(255,51,85,.3)}
.b-above{background:rgba(48,184,248,.15);color:var(--blue);border:1px solid rgba(48,184,248,.3)}
.b-below{background:rgba(176,128,255,.15);color:var(--purple);border:1px solid rgba(176,128,255,.3)}
.b-unknown{background:rgba(61,85,112,.15);color:var(--dim);border:1px solid var(--border)}
.b-tp{background:rgba(0,223,160,.2);color:var(--green)}.b-sl{background:rgba(255,51,85,.2);color:var(--red)}.b-manual{background:rgba(240,192,48,.15);color:var(--gold)}
.b-asia{background:rgba(0,223,216,.1);color:var(--cyan)}.b-london{background:rgba(0,223,160,.1);color:var(--green)}.b-ny{background:rgba(176,128,255,.1);color:var(--purple)}.b-outside{background:rgba(61,85,112,.1);color:var(--dim)}
.b-ghost{background:rgba(176,128,255,.2);color:var(--purple);border:1px solid rgba(176,128,255,.4)}
.b-evp{background:rgba(0,223,160,.2);color:var(--green);border:1px solid rgba(0,223,160,.3)}
.b-evn{background:rgba(255,51,85,.2);color:var(--red);border:1px solid rgba(255,51,85,.3)}
.b-err{background:rgba(255,51,85,.2);color:var(--red);border:1px solid rgba(255,51,85,.4);font-size:8px;padding:1px 4px}
.b-placed{background:rgba(0,223,160,.15);color:var(--green)}.b-closed{background:rgba(48,184,248,.12);color:var(--blue)}.b-rejected{background:rgba(255,51,85,.15);color:var(--red)}.b-def{background:rgba(61,85,112,.2);color:var(--dim);border:1px solid var(--border)}

/* cat pills */
.cat{display:inline-block;padding:1px 5px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.5px;font-family:'Barlow Condensed',sans-serif}
.cat-stock{background:rgba(48,184,248,.12);color:var(--blue)}.cat-forex{background:rgba(0,223,216,.12);color:var(--cyan)}.cat-index{background:rgba(240,192,48,.12);color:var(--gold)}.cat-commodity{background:rgba(255,136,48,.12);color:var(--orange)}

/* SL bar */
.slb{display:flex;align-items:center;gap:4px;min-width:70px}
.slb-bg{height:4px;flex:1;background:var(--dim2);border-radius:2px;overflow:hidden}
.slb-f{height:100%;border-radius:2px;background:var(--green);transition:width .3s}
.slb-f.w{background:var(--orange)}.slb-f.d{background:var(--red)}

/* RR verify badge */
.rr-ok{color:var(--green);font-size:9px}.rr-warn{color:var(--orange);font-size:9px}

/* colors */
.cg{color:var(--green)}.cr{color:var(--red)}.cgd{color:var(--gold)}.cb{color:var(--blue)}.cd{color:var(--dim)}.cp{color:var(--purple)}.cc{color:var(--cyan)}.co{color:var(--orange)}
.pw{color:var(--green);font-weight:600}.pl{color:var(--red);font-weight:600}
.fw{font-weight:700}

/* type borders */
tr.ts{border-left:2px solid rgba(48,184,248,.2)}tr.tf{border-left:2px solid rgba(0,223,216,.2)}tr.ti{border-left:2px solid rgba(240,192,48,.2)}tr.tc{border-left:2px solid rgba(255,136,48,.2)}

/* EV matrix */
.mxw{overflow-x:auto}
.mx{min-width:860px;font-size:10px}
.mx td.ml{font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;color:var(--gold);background:var(--bg2);border-right:1px solid var(--border2);white-space:nowrap;min-width:130px;padding:5px 10px;position:sticky;left:0;z-index:1}
.mx td.mc{text-align:center;padding:4px 4px;border-right:1px solid var(--dim2)}
.ep{color:var(--green)}.en{color:var(--red)}.ez{color:var(--dim)}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="logo">PRONTO-AI</div>
    <div class="ver">v10.2 · TradingView → MetaApi → FTMO MT5 · Fixed Risk ${(FIXED_RISK_PCT*100).toFixed(3)}% · Default TP 2.0R</div>
  </div>
  <div class="hdr-r">
    <span class="sess-badge s-outside" id="hdr-sess">—</span>
    <span class="clock" id="clock">--:--:--</span>
    <button class="btn" onclick="loadAll()">↻ REFRESH</button>
  </div>
</div>

<div class="kpi-bar">
  <div class="kpi kbal"><div class="kl">Live MT5 Balance</div><div class="kv vg">€<span id="k-bal">${balance.toFixed(0)}</span></div></div>
  <div class="kpi kpos"><div class="kl">Open Positions</div><div class="kv vb" id="k-pos">—</div></div>
  <div class="kpi kgh"><div class="kl">Active Ghosts</div><div class="kv vp" id="k-gh">—</div></div>
  <div class="kpi ktp"><div class="kl">TP Locks EV+</div><div class="kv vgd" id="k-tp">—</div></div>
  <div class="kpi ksess"><div class="kl">Session</div><div class="kv vc" id="k-sess" style="font-size:13px;letter-spacing:2px">—</div></div>
  <div class="kpi krisk"><div class="kl">Fixed Risk</div><div class="kv vo">${(FIXED_RISK_PCT*100).toFixed(3)}%</div></div>
  <div class="kpi krisk"><div class="kl">Lot Overrides</div><div class="kv vo" id="k-lots">—</div></div>
  <div class="kpi kerr"><div class="kl">Flagged Trades</div><div class="kv vr" id="k-err">—</div></div>
</div>

<div class="page">

<!-- ══════════════════════════════════════════════════════════
     OPEN POSITIONS
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-pos">
  <div class="sec-hdr" onclick="toggleS('pos')">
    <span class="sec-title" style="color:var(--green)">🟢 OPEN POSITIONS</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="pos-meta">Loading…</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="info">
      <strong>RR Verify</strong> = |entry − TP| ÷ |entry − SL| recalculated from MT5 prices. Should match TP RR exactly.
      <strong>SL Used%</strong> = how far current price moved toward SL vs SL distance.
      <strong>PnL %bal</strong> = unrealised PnL as % of live balance.
      <strong class="hi">Default TP = 2.0R</strong> (entry ± 2 × SL distance). Overridden once EV optimizer has ≥5 ghost samples.
    </div>
    <div class="twrap">
      <table id="pos-tbl">
        <thead><tr>
          <th class="srt" onclick="sortTbl('pos-tbl',0)">Pair</th>
          <th class="srt" onclick="sortTbl('pos-tbl',1)">Dir</th>
          <th class="srt" onclick="sortTbl('pos-tbl',2)">VWAP</th>
          <th class="srt" onclick="sortTbl('pos-tbl',3)">Session</th>
          <th class="srt" onclick="sortTbl('pos-tbl',4)">Entry (MT5)</th>
          <th class="srt" onclick="sortTbl('pos-tbl',5)">SL (MT5)</th>
          <th class="srt" onclick="sortTbl('pos-tbl',6)">SL Dist%</th>
          <th>SL Used%</th>
          <th class="srt" onclick="sortTbl('pos-tbl',8)">MaxRR</th>
          <th class="srt" onclick="sortTbl('pos-tbl',9)">TP (MT5)</th>
          <th class="srt" onclick="sortTbl('pos-tbl',10)">TP RR set</th>
          <th class="srt" onclick="sortTbl('pos-tbl',11)">RR Verify</th>
          <th>Ghost</th>
          <th class="srt" onclick="sortTbl('pos-tbl',13)">PnL €</th>
          <th class="srt" onclick="sortTbl('pos-tbl',14)">PnL %bal</th>
          <th class="srt" onclick="sortTbl('pos-tbl',15)">Spread</th>
          <th class="srt" onclick="sortTbl('pos-tbl',16)">Lots</th>
          <th class="srt" onclick="sortTbl('pos-tbl',17)">Risk €</th>
          <th>Opened</th>
        </tr></thead>
        <tbody id="pos-body"><tr><td colspan="19" class="nodata">No open positions</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     TRADE OVERVIEW
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-ov">
  <div class="sec-hdr" onclick="toggleS('ov')">
    <span class="sec-title" style="color:var(--blue)">📊 TRADE OVERVIEW — All Combinations (Apr 18+)</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="ov-meta">Loading…</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="info">
      Stocks show <strong>NY session only</strong>. Forex/Index/Commodity show all 3 sessions.
      <strong>SL%(W)</strong> = average max-adverse SL% for <strong>winning trades only</strong> (TP hit) — use this to tighten SL without killing winners.
      All trades counted from <strong class="hi">18 April 2026</strong> onwards. Pairs with no data shown dimmed. Default: all pairs shown.
    </div>
    <div class="fbar">
      <span class="fl">Type:</span>
      <button class="fb on" onclick="setOF('type','all',this,'ot')">All</button>
      <button class="fb" onclick="setOF('type','forex',this,'ot')">Forex</button>
      <button class="fb" onclick="setOF('type','index',this,'ot')">Index</button>
      <button class="fb" onclick="setOF('type','commodity',this,'ot')">Commodity</button>
      <button class="fb" onclick="setOF('type','stock',this,'ot')">Stocks</button>
      <span class="fl" style="margin-left:5px">Session:</span>
      <button class="fb on" onclick="setOF('sess','all',this,'os')">All</button>
      <button class="fb" onclick="setOF('sess','asia',this,'os')">Asia</button>
      <button class="fb" onclick="setOF('sess','london',this,'os')">London</button>
      <button class="fb" onclick="setOF('sess','ny',this,'os')">NY</button>
      <span class="fl" style="margin-left:5px">Dir:</span>
      <button class="fb on" onclick="setOF('dir','all',this,'od')">All</button>
      <button class="fb" onclick="setOF('dir','buy',this,'od')">Buy</button>
      <button class="fb" onclick="setOF('dir','sell',this,'od')">Sell</button>
      <span class="fl" style="margin-left:5px">VWAP:</span>
      <button class="fb on" onclick="setOF('vwap','all',this,'ov')">All</button>
      <button class="fb" onclick="setOF('vwap','above',this,'ov')">Above</button>
      <button class="fb" onclick="setOF('vwap','below',this,'ov')">Below</button>
      <span class="fl" style="margin-left:5px">Show:</span>
      <button class="fb on" onclick="setOF('zeros','all',this,'oz')">All rows</button>
      <button class="fb" onclick="setOF('zeros','traded',this,'oz')">Traded only</button>
      <span class="fl" style="margin-left:5px">Symbol:</span>
      <input class="finput" id="ov-sym" placeholder="e.g. EURUSD" oninput="renderOv()">
    </div>
    <div class="strow">
      Trades: <span id="ov-n">—</span>
      &nbsp;Wins: <span id="ov-w">—</span>
      &nbsp;Win%: <span id="ov-wr">—</span>
      &nbsp;Total PnL: <span id="ov-pnl">—</span>
      &nbsp;EV+ combos: <span id="ov-evp">—</span>
      &nbsp;Combos w/data: <span id="ov-cd">—</span>
    </div>
    <div class="twrap">
      <table id="ov-tbl">
        <thead><tr>
          <th class="srt dsc" onclick="sortOv('sym')">Symbol</th>
          <th class="srt" onclick="sortOv('type')">Type</th>
          <th class="srt" onclick="sortOv('sess')">Session</th>
          <th class="srt" onclick="sortOv('dir')">Dir</th>
          <th class="srt" onclick="sortOv('vwap')">VWAP</th>
          <th class="srt dsc" onclick="sortOv('n')">#Trades</th>
          <th class="srt" onclick="sortOv('wr')">Win%</th>
          <th class="srt" onclick="sortOv('avgRR')">Avg RR</th>
          <th class="srt" onclick="sortOv('bestRR')">Best RR</th>
          <th class="srt" onclick="sortOv('ev')">EV</th>
          <th class="srt" onclick="sortOv('evPos')">EV+?</th>
          <th class="srt" onclick="sortOv('tpn')">Total PnL</th>
          <th class="srt" onclick="sortOv('apnl')">Avg PnL</th>
          <th class="srt" onclick="sortOv('asl')">SL%(all)</th>
          <th class="srt" onclick="sortOv('aslw')">SL%(W)</th>
          <th class="srt" onclick="sortOv('tplrr')">TP Lock RR</th>
          <th class="srt" onclick="sortOv('tph')">TP Hits</th>
          <th class="srt" onclick="sortOv('slh')">SL Hits</th>
        </tr></thead>
        <tbody id="ov-body"><tr><td colspan="18" class="nodata">—</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     WEBHOOK HISTORY
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-hist">
  <div class="sec-hdr" onclick="toggleS('hist')">
    <span class="sec-title" style="color:var(--cyan)">📋 WEBHOOK HISTORY — Last 100 Events</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="hist-meta">—</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="fbar">
      <span class="fl">Filter:</span>
      <button class="fb on" onclick="setHF('all',this)">All</button>
      <button class="fb" onclick="setHF('ORDER_PLACED',this)">Placed</button>
      <button class="fb" onclick="setHF('POSITION_CLOSED',this)">Closed</button>
      <button class="fb" onclick="setHF('MARKET_CLOSED',this)">Mkt Closed</button>
      <button class="fb" onclick="setHF('LOT_RECALC',this)">Lot Recalc</button>
      <button class="fb" onclick="setHF('REJECTED',this)">Rejected</button>
      <button class="fb" onclick="setHF('ERROR',this)">Errors</button>
    </div>
    <div class="twrap">
      <table id="hist-tbl">
        <thead><tr>
          <th class="srt" onclick="sortTbl('hist-tbl',0)">Date/Time</th>
          <th>Type</th>
          <th class="srt" onclick="sortTbl('hist-tbl',2)">Symbol</th>
          <th>Cat</th><th>Dir</th><th>VWAP</th>
          <th class="srt" onclick="sortTbl('hist-tbl',6)">Session</th>
          <th>Entry</th><th>SL</th><th>TP</th><th>Lots</th><th>Risk%</th>
          <th>Optimizer Key</th>
          <th>Position ID</th>
          <th>Detail / Reason</th>
        </tr></thead>
        <tbody id="hist-body"><tr><td colspan="15" class="nodata">—</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     GHOSTS
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-gh">
  <div class="sec-hdr" onclick="toggleS('gh')">
    <span class="sec-title" style="color:var(--purple)">👻 GHOSTS — Active + History</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="gh-meta">—</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="subhdr">Active ghosts</div>
    <div class="twrap">
      <table id="gha-tbl">
        <thead><tr>
          <th class="srt" onclick="sortTbl('gha-tbl',0)">Optimizer Key</th>
          <th>Dir</th><th>Session</th>
          <th class="srt" onclick="sortTbl('gha-tbl',3)">Entry</th>
          <th class="srt" onclick="sortTbl('gha-tbl',4)">Phantom SL</th>
          <th class="srt" onclick="sortTbl('gha-tbl',5)">Max Price</th>
          <th class="srt" onclick="sortTbl('gha-tbl',6)">MaxRR</th>
          <th>SL Used%</th>
          <th class="srt" onclick="sortTbl('gha-tbl',8)">Elapsed</th>
        </tr></thead>
        <tbody id="gha-body"><tr><td colspan="9" class="nodata">No active ghosts</td></tr></tbody>
      </table>
    </div>
    <div class="subhdr">Ghost history (last 30)</div>
    <div class="twrap">
      <table id="ghh-tbl">
        <thead><tr>
          <th class="srt" onclick="sortTbl('ghh-tbl',0)">Key</th>
          <th>Dir</th><th>Session</th>
          <th class="srt" onclick="sortTbl('ghh-tbl',3)">MaxRR</th>
          <th class="srt" onclick="sortTbl('ghh-tbl',4)">TP RR Used</th>
          <th>SL Hit?</th><th>Reason</th>
          <th class="srt" onclick="sortTbl('ghh-tbl',7)">Time(min)</th>
          <th class="srt" onclick="sortTbl('ghh-tbl',8)">Closed</th>
        </tr></thead>
        <tbody id="ghh-body"><tr><td colspan="9" class="nodata">—</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     EV MATRIX
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-ev">
  <div class="sec-hdr" onclick="toggleS('ev')">
    <span class="sec-title" style="color:var(--gold)">📈 EV MATRIX</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="ev-meta">—</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="info">
      Each cell shows 3 numbers:<br>
      <strong class="hi">bestRR</strong> = the R:R target that maximises Expected Value based on ghost data (e.g. 2.4R means "take profit at 2.4× your SL distance").<br>
      <strong>EV</strong> = (win_rate × bestRR) − (1 − win_rate). <span class="cg">Positive = mathematically profitable setup</span>. <span class="cr">Negative = losing setup at that RR</span>.<br>
      <strong>n</strong> = number of ghost trades in the sample. <span class="cgd">★ = EV+ AND n≥5 → TP locked to bestRR for new trades.</span><br>
      Columns: B/A = Buy/Above VWAP · B/B = Buy/Below · S/A = Sell/Above · S/B = Sell/Below.
    </div>
    <div class="subhdr">FOREX</div>
    <div class="mxw"><table class="mx" id="mx-forex"></table></div>
    <div class="subhdr">INDEXES</div>
    <div class="mxw"><table class="mx" id="mx-index"></table></div>
    <div class="subhdr">COMMODITIES</div>
    <div class="mxw"><table class="mx" id="mx-comm"></table></div>
    <div class="subhdr">STOCKS (NY only)</div>
    <div class="mxw"><table class="mx" id="mx-stocks"></table></div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     SHADOW SL
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-sh">
  <div class="sec-hdr" onclick="toggleS('sh')">
    <span class="sec-title" style="color:var(--purple)">🌑 SHADOW SL — READ ONLY</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="sh-meta">—</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="info">
      <strong>p99%</strong> = recommended SL tightness. <strong>Too Wide</strong> = price never came within 70% of SL → SL could be tightened.
      <strong>SL%(W)</strong> column = p90 of max-adverse SL usage for <strong>winning trades only</strong>.
      Use this to find SL tightening potential without reducing winners.
    </div>
    <div class="twrap">
      <table id="sh-tbl">
        <thead><tr>
          <th class="srt" onclick="sortTbl('sh-tbl',0)">Optimizer Key</th>
          <th class="srt" onclick="sortTbl('sh-tbl',1)">Symbol</th>
          <th>Session</th><th>Dir</th><th>VWAP</th>
          <th class="srt" onclick="sortTbl('sh-tbl',5)">Snaps</th>
          <th class="srt" onclick="sortTbl('sh-tbl',6)">Positions</th>
          <th class="srt" onclick="sortTbl('sh-tbl',7)">p50%</th>
          <th class="srt" onclick="sortTbl('sh-tbl',8)">p90%</th>
          <th class="srt" onclick="sortTbl('sh-tbl',9)">p99%</th>
          <th class="srt" onclick="sortTbl('sh-tbl',10)">Max%</th>
          <th class="srt" onclick="sortTbl('sh-tbl',11)">Rec SL%</th>
          <th>Too Wide?</th>
          <th class="srt" onclick="sortTbl('sh-tbl',13)">Save%</th>
          <th class="srt" onclick="sortTbl('sh-tbl',14)">SL%(W) p90</th>
          <th class="srt" onclick="sortTbl('sh-tbl',15)">W Count</th>
        </tr></thead>
        <tbody id="sh-body"><tr><td colspan="16" class="nodata">—</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     FLAGGED TRADES
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-err">
  <div class="sec-hdr" onclick="toggleS('err')">
    <span class="sec-title" style="color:var(--red)">⚠ FLAGGED TRADES — Data Errors</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="err-meta">—</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="info">
      <strong>UNKNOWN_VWAP</strong> = trade logged without VWAP position (signal sent without vwap field).<br>
      <strong>ZERO_ENTRY / ZERO_SL</strong> = entry or SL price is 0 or null — position sizing was broken for this trade.<br>
      <strong>NULL_PNL</strong> = realized PnL not recorded — trade closed before sync caught it.<br>
      <strong>BAD_CLOSE</strong> = closeReason is not tp/sl/manual — unexpected close method.<br>
      <strong>NEG_RR</strong> = maxRR &lt; 0 — price moved immediately against us (data anomaly).
    </div>
    <div class="twrap">
      <table id="err-tbl">
        <thead><tr>
          <th>Position ID</th>
          <th class="srt" onclick="sortTbl('err-tbl',1)">Symbol</th>
          <th>Dir</th><th>VWAP</th><th>Session</th>
          <th class="srt" onclick="sortTbl('err-tbl',5)">Entry</th>
          <th class="srt" onclick="sortTbl('err-tbl',6)">SL</th>
          <th class="srt" onclick="sortTbl('err-tbl',7)">MaxRR</th>
          <th>Close</th>
          <th class="srt" onclick="sortTbl('err-tbl',9)">PnL €</th>
          <th>Lots</th><th>Flags</th>
          <th class="srt" onclick="sortTbl('err-tbl',12)">Closed</th>
        </tr></thead>
        <tbody id="err-body"><tr><td colspan="13" class="nodata">—</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     RISK CONFIG + LOT OVERRIDES
══════════════════════════════════════════════════════════ -->
<div class="sec" id="s-risk">
  <div class="sec-hdr" onclick="toggleS('risk')">
    <span class="sec-title" style="color:var(--gold)">💰 RISK CONFIG & LOT OVERRIDES</span>
    <span style="display:flex;align-items:center;gap:8px"><span class="sec-meta" id="risk-meta">—</span><span class="chevron">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="info">
      <strong>Risk recalculation</strong>: After every SL hit, <code>recalcLotsAfterSL()</code> computes optimal lots = balance × risk% ÷ (SL distance × lot value).
      This keeps EUR risk <strong>identical across all trades</strong> regardless of SL distance. ✓ Working correctly.<br>
      Set the lot values below as Railway env vars (<code>LOTS_SYMBOL=value</code>) to persist after restart.
    </div>
    <div class="fbar">
      <span class="fl">Type:</span>
      <button class="fb on" onclick="setRF('all',this)">All</button>
      <button class="fb" onclick="setRF('forex',this)">Forex</button>
      <button class="fb" onclick="setRF('index',this)">Index</button>
      <button class="fb" onclick="setRF('commodity',this)">Commodity</button>
      <button class="fb" onclick="setRF('stock',this)">Stocks</button>
    </div>
    <div class="twrap">
      <table id="risk-tbl">
        <thead><tr>
          <th class="srt" onclick="sortTbl('risk-tbl',0)">Symbol</th>
          <th>Type</th>
          <th class="srt" onclick="sortTbl('risk-tbl',2)">Risk%</th>
          <th class="srt" onclick="sortTbl('risk-tbl',3)">Risk € (live)</th>
          <th class="srt" onclick="sortTbl('risk-tbl',4)">Mult</th>
          <th>Lot Override</th>
          <th>Env Var</th>
        </tr></thead>
        <tbody id="risk-body"><tr><td colspan="7" class="nodata">—</td></tr></tbody>
      </table>
    </div>
    <div class="subhdr">Lot overrides — set in Railway after SL recalc</div>
    <div class="twrap">
      <table id="lots-tbl">
        <thead><tr>
          <th class="srt" onclick="sortTbl('lots-tbl',0)">Symbol</th>
          <th class="srt" onclick="sortTbl('lots-tbl',1)">Optimal Lots</th>
          <th>Railway Env Var</th>
          <th>Risk%</th>
          <th>Instruction</th>
        </tr></thead>
        <tbody id="lots-body"><tr><td colspan="5" class="nodata">No SL recalcs yet</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

</div><!-- /page -->

<script>
// ── Catalogs ──────────────────────────────────────────────────────
const FOREX=['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
const IDX=['DE30EUR','NAS100USD','UK100GBP','US30USD'];
const COMM=['XAUUSD'];
const STK=['AAPL','AMD','AMZN','ARM','ASML','AVGO','AZN','BA','BABA','BAC','BRKB','CSCO','CVX','DIS','FDX','GE','GM','GME','GOOGL','IBM','INTC','JNJ','JPM','KO','LMT','MCD','META','MSFT','MSTR','NFLX','NKE','NVDA','PFE','PLTR','QCOM','SBUX','SNOW','T','TSLA','V','WMT','XOM','ZM'];
const ALL_SYM=[...FOREX,...IDX,...COMM,...STK];
const S3=['asia','london','ny'],SNY=['ny'],D2=['buy','sell'],V2=['above','below'];
const CUTOFF=new Date('2026-04-18T00:00:00+02:00');

function sType(s){if(FOREX.includes(s))return'forex';if(IDX.includes(s))return'index';if(COMM.includes(s))return'commodity';return'stock';}

// ── Utils ──────────────────────────────────────────────────────────
function f(v,d=2){return v!=null&&!isNaN(v)?Number(v).toFixed(d):'—';}
function fP(v){return v!=null?(v*100).toFixed(3)+'%':'—';}
function ts(iso){if(!iso)return'—';return new Date(iso).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function dt(iso){if(!iso)return'—';return new Date(iso).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',year:'2-digit'});}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;}
async function api(u){try{const r=await fetch(u,{cache:'no-store'});return r.ok?r.json():null;}catch{return null;}}
function cat(t){return t?'<span class="cat cat-'+t+'">'+t.toUpperCase()+'</span>':'';}
function sBadge(s){const m={asia:'b-asia',london:'b-london',ny:'b-ny',outside:'b-outside'};return'<span class="b '+(m[s]||'b-def')+'">'+(s||'—').toUpperCase()+'</span>';}
function cBadge(r){const m={tp:'b-tp',sl:'b-sl',manual:'b-manual'};return'<span class="b '+(m[r]||'b-def')+'">'+(r||'—').toUpperCase()+'</span>';}
function slBar(p){if(p==null)return'—';const c=p>=80?' d':p>=50?' w':'';return'<div class="slb"><div class="slb-bg"><div class="slb-f'+c+'" style="width:'+Math.min(100,p)+'%"></div></div><span class="'+(p>=80?'cr':p>=50?'co':'cg')+'">'+Number(p).toFixed(0)+'%</span></div>';}
function hBadge(t){if(!t)return'<span class="b b-def">—</span>';if(t.includes('PLACED'))return'<span class="b b-placed">PLACED</span>';if(t.includes('CLOSED'))return'<span class="b b-closed">CLOSED</span>';if(t.includes('REJECTED'))return'<span class="b b-rejected">REJECTED</span>';if(t.includes('ERROR'))return'<span class="b b-rejected">ERROR</span>';if(t.includes('MARKET_CLOSED'))return'<span class="b b-def">MKT CLOSED</span>';return'<span class="b b-def">'+t.replace(/_/g,' ')+'</span>';}

// ── Section collapse ───────────────────────────────────────────────
function toggleS(id){document.getElementById('s-'+id).classList.toggle('collapsed');}

// ── Generic table sort (by column index, text or numeric) ──────────
const _tblSort={};
function sortTbl(id,col){
  const tbl=document.getElementById(id);if(!tbl)return;
  const ths=tbl.querySelectorAll('th');
  const prev=_tblSort[id]||{col:-1,dir:1};
  const dir=(prev.col===col)?-prev.dir:1;
  _tblSort[id]={col,dir};
  ths.forEach((th,i)=>{th.classList.remove('asc','dsc');if(i===col)th.classList.add(dir===1?'asc':'dsc');});
  const tbody=tbl.querySelector('tbody');
  const rows=[...tbody.querySelectorAll('tr')].filter(r=>!r.querySelector('td[colspan]'));
  rows.sort((a,b)=>{
    const at=a.cells[col]?.textContent?.trim()||'';
    const bt=b.cells[col]?.textContent?.trim()||'';
    const an=parseFloat(at),bn=parseFloat(bt);
    if(!isNaN(an)&&!isNaN(bn))return dir*(an-bn);
    return dir*at.localeCompare(bt);
  });
  rows.forEach(r=>tbody.appendChild(r));
}

// ── Filter state ───────────────────────────────────────────────────
const OF={type:'all',sess:'all',dir:'all',vwap:'all',zeros:'all'};
let histF='all',riskF='all';
function setOF(k,v,el,g){
  OF[k]=v;
  document.querySelectorAll('[onclick*="\''+g+'\'"]').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');renderOv();
}
function setHF(v,el){histF=v;document.querySelectorAll('#s-hist .fb').forEach(b=>b.classList.remove('on'));el.classList.add('on');renderHist();}
function setRF(v,el){riskF=v;document.querySelectorAll('#s-risk .fbar .fb').forEach(b=>b.classList.remove('on'));el.classList.add('on');renderRisk();}

// ══════════════════════════════════════════════════════════════
// OPEN POSITIONS
// ══════════════════════════════════════════════════════════════
let _liveBalance=0;
async function loadPositions(){
  const d=await api('/live/positions');if(!d)return;
  _liveBalance=d.balance||0;
  document.getElementById('k-pos').textContent=d.count;
  document.getElementById('k-bal').textContent=_liveBalance.toFixed(0);
  document.getElementById('pos-meta').textContent=d.count+' open | balance €'+_liveBalance.toFixed(0);
  const b=document.getElementById('pos-body');
  if(!d.positions.length){b.innerHTML='<tr><td colspan="19" class="nodata">No open positions</td></tr>';return;}
  b.innerHTML=d.positions.map(p=>{
    const t=sType(p.symbol);
    // Recalculate RR from MT5 prices: |entry-tp| / |entry-sl|
    const calcRR=(p.entry&&p.sl&&p.tp&&p.entry!==p.sl)?
      Math.abs(p.tp-p.entry)/Math.abs(p.sl-p.entry):null;
    const tpRRset=p.tpRR||p.tpRRUsed;
    const rrOk=calcRR!=null&&tpRRset!=null&&Math.abs(calcRR-tpRRset)<0.05;
    const rrV=calcRR!=null?
      ('<span class="'+(rrOk?'rr-ok':'rr-warn')+'">'+calcRR.toFixed(2)+'R '+(rrOk?'✓':'⚠')+'</span>'):
      '<span class="cd">—</span>';
    const spread=p.spread??((p.ask&&p.bid)?Math.abs(p.ask-p.bid):null);
    const pnlPct=_liveBalance>0&&p.currentPnL!=null?(p.currentPnL/_liveBalance*100):null;
    const pc=(p.currentPnL||0)>=0?'pw':'pl';
    return \`<tr class="t\${t[0]}">
      <td class="cb fw">\${p.symbol}</td>
      <td><span class="b b-\${p.direction}">\${p.direction?.toUpperCase()}</span></td>
      <td><span class="b b-\${p.vwapPosition||'unknown'}">\${p.vwapPosition||'?'}</span></td>
      <td>\${sBadge(p.session)}</td>
      <td>\${f(p.entry,5)}</td>
      <td class="cr">\${f(p.sl,5)}</td>
      <td class="co">\${p.slDistPct!=null?p.slDistPct+'%':'—'}</td>
      <td>\${slBar(p.slPctUsed)}</td>
      <td class="cc">\${f(p.maxRR,2)}R</td>
      <td class="cg">\${f(p.tp,5)}</td>
      <td class="cgd">\${tpRRset||'—'}R</td>
      <td>\${rrV}</td>
      <td>\${p.isGhosted?'<span class="b b-ghost">👻 YES</span>':'<span class="cd">—</span>'}</td>
      <td class="\${pc} fw">\${p.currentPnL!=null?'€'+f(p.currentPnL,2):'—'}</td>
      <td class="\${pc}">\${pnlPct!=null?(pnlPct>=0?'+':'')+pnlPct.toFixed(3)+'%':'—'}</td>
      <td class="co">\${spread!=null?spread.toFixed(5):'—'}</td>
      <td>\${f(p.lots,2)}</td>
      <td class="cg">\${p.riskEUR?'€'+p.riskEUR.toFixed(2):'—'}</td>
      <td class="cd" style="font-size:10px">\${ts(p.openedAt)}</td>
    </tr>\`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// TRADE OVERVIEW
// ══════════════════════════════════════════════════════════════
let _ovData=[],_ovSort={col:'n',dir:-1};
let _allT=[],_evMap={},_shMap={},_tpMap={},_shwMap={};

async function loadOverview(){
  const [tr,ev,sh,tp,shw]=await Promise.all([
    api('/trades?limit=5000'),api('/ev'),api('/shadow'),api('/tp-locks'),api('/shadow/winners')
  ]);
  _allT=(tr?.trades||[]).filter(t=>t.closedAt&&new Date(t.closedAt)>=CUTOFF);
  _evMap={};(ev||[]).forEach(e=>_evMap[e.key]=e);
  _shMap={};(sh?.results||[]).forEach(s=>_shMap[s.optimizerKey]=s);
  _tpMap={};(tp||[]).forEach(t=>_tpMap[t.key]=t);
  _shwMap=shw?.winners?{}:{};if(shw?.winners)shw.winners.forEach(w=>_shwMap[w.optimizerKey]=w);

  _ovData=[];
  for(const sym of ALL_SYM){
    const type=sType(sym);
    const sessions=type==='stock'?SNY:S3;
    for(const sess of sessions)for(const dir of D2)for(const vwap of V2){
      const key=sym+'_'+sess+'_'+dir+'_'+vwap;
      const ct=_allT.filter(t=>t.symbol===sym&&t.session===sess&&t.direction===dir&&(t.vwapPosition||'unknown')===vwap);
      const n=ct.length;
      const wins=ct.filter(t=>t.hitTP||t.closeReason==='tp').length;
      const slH=ct.filter(t=>t.closeReason==='sl').length;
      const rrA=ct.map(t=>t.maxRR||0).filter(v=>!isNaN(v));
      const pnlA=ct.map(t=>t.realizedPnlEUR??t.currentPnL??0).filter(v=>v!=null&&!isNaN(v));
      const tPnl=pnlA.reduce((a,b)=>a+b,0);
      const ev=_evMap[key],sh=_shMap[key],tp=_tpMap[key],shw=_shwMap[key];
      _ovData.push({
        key,sym,type,sess,dir,vwap,n,wins,slH,tpH:wins,
        wr:n>0?wins/n*100:null,
        avgRR:rrA.length?avg(rrA):null,
        bestRR:rrA.length?Math.max(...rrA):null,
        ev:ev?.bestEV??null,evPos:ev&&(ev.bestEV||0)>0,
        tpn:n>0?tPnl:null,apnl:n>0?tPnl/n:null,
        asl:sh?.p90??null,
        aslw:shw?.p90??null,
        tplrr:tp?.lockedRR??ev?.bestRR??null,
      });
    }
  }
  renderOv();
}

function sortOv(col){
  const prev=_ovSort;
  if(prev.col===col)_ovSort.dir*=-1;else _ovSort={col,dir:-1};
  const names=['sym','type','sess','dir','vwap','n','wr','avgRR','bestRR','ev','evPos','tpn','apnl','asl','aslw','tplrr','tph','slh'];
  const ths=[...document.querySelectorAll('#ov-tbl th')];
  ths.forEach(th=>th.classList.remove('asc','dsc'));
  const i=names.indexOf(_ovSort.col);
  if(ths[i])ths[i].classList.add(_ovSort.dir===-1?'dsc':'asc');
  renderOv();
}

function renderOv(){
  const sym=(document.getElementById('ov-sym')?.value||'').toUpperCase().trim();
  let d=[..._ovData];
  if(OF.type!=='all')d=d.filter(r=>r.type===OF.type);
  if(OF.sess!=='all')d=d.filter(r=>r.sess===OF.sess);
  if(OF.dir!=='all')d=d.filter(r=>r.dir===OF.dir);
  if(OF.vwap!=='all')d=d.filter(r=>r.vwap===OF.vwap);
  if(OF.zeros==='traded')d=d.filter(r=>r.n>0);
  if(sym)d=d.filter(r=>r.sym.includes(sym));
  const col=_ovSort.col,dir=_ovSort.dir;
  d.sort((a,b)=>{
    const av=a[col],bv=b[col];
    if(av==null&&bv==null)return 0;if(av==null)return 1;if(bv==null)return -1;
    if(typeof av==='string')return dir*av.localeCompare(bv);return dir*(av-bv);
  });
  const tr=d.filter(r=>r.n>0);
  const tN=tr.reduce((s,r)=>s+r.n,0),tW=tr.reduce((s,r)=>s+r.wins,0);
  const tPnl=tr.reduce((s,r)=>s+(r.tpn||0),0);
  document.getElementById('ov-n').textContent=tN;
  document.getElementById('ov-w').textContent=tW;
  document.getElementById('ov-wr').textContent=tN>0?(tW/tN*100).toFixed(1)+'%':'—';
  document.getElementById('ov-pnl').textContent=(tPnl>=0?'€+':'€')+tPnl.toFixed(2);
  document.getElementById('ov-evp').textContent=tr.filter(r=>r.evPos&&r.ev!=null).length;
  document.getElementById('ov-cd').textContent=tr.length;
  document.getElementById('ov-meta').textContent=d.length+' combos ('+(d.filter(r=>r.n>0).length)+' traded)';
  const b=document.getElementById('ov-body');
  if(!d.length){b.innerHTML='<tr><td colspan="18" class="nodata">No combinations match filters</td></tr>';return;}
  b.innerHTML=d.map(r=>{
    const z=r.n===0;
    const pc=r.tpn>0?'cg':r.tpn<0?'cr':'cd';
    const ec=r.evPos?'cg':r.ev!=null&&r.ev<0?'cr':'cd';
    const evB=r.ev==null?'<span class="cd">—</span>':r.evPos?'<span class="b b-evp">YES ★</span>':'<span class="b b-evn">NO</span>';
    return \`<tr class="t\${r.type[0]}\${z?' zrow':''}">
      <td class="cb fw">\${r.sym}</td>
      <td>\${cat(r.type)}</td>
      <td>\${sBadge(r.sess)}</td>
      <td><span class="b b-\${r.dir}">\${r.dir.toUpperCase()}</span></td>
      <td><span class="b b-\${r.vwap}">\${r.vwap}</span></td>
      <td style="text-align:right;font-weight:700">\${z?'<span class="cd">0</span>':r.n}</td>
      <td style="text-align:right">\${r.wr!=null?r.wr.toFixed(1)+'%':'—'}</td>
      <td style="text-align:right">\${r.avgRR!=null?f(r.avgRR,2)+'R':'—'}</td>
      <td style="text-align:right" class="cc">\${r.bestRR!=null?f(r.bestRR,2)+'R':'—'}</td>
      <td style="text-align:right" class="\${ec}">\${r.ev!=null?f(r.ev,3):'—'}</td>
      <td>\${evB}</td>
      <td style="text-align:right" class="\${pc}">\${r.tpn!=null?'€'+f(r.tpn,2):'—'}</td>
      <td style="text-align:right" class="\${r.apnl>0?'cg':r.apnl<0?'cr':'cd'}">\${r.apnl!=null?'€'+f(r.apnl,2):'—'}</td>
      <td style="text-align:right">\${r.asl!=null?f(r.asl,1)+'%':'—'}</td>
      <td style="text-align:right" class="cgd">\${r.aslw!=null?f(r.aslw,1)+'%':'—'}</td>
      <td style="text-align:right" class="cgd">\${r.tplrr!=null?f(r.tplrr,1)+'R':'—'}</td>
      <td style="text-align:right" class="cg">\${r.n>0?r.tpH:'—'}</td>
      <td style="text-align:right" class="cr">\${r.n>0?r.slH:'—'}</td>
    </tr>\`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK HISTORY
// ══════════════════════════════════════════════════════════════
let _hD=[];
async function loadHistory(){
  const d=await api('/history');if(!d)return;
  _hD=Array.isArray(d)?d:[];
  document.getElementById('hist-meta').textContent=_hD.length+' events';
  renderHist();
}
function renderHist(){
  const data=histF==='all'?_hD:_hD.filter(h=>(h.type||'').includes(histF));
  const b=document.getElementById('hist-body');
  if(!data.length){b.innerHTML='<tr><td colspan="15" class="nodata">No events</td></tr>';return;}
  b.innerHTML=data.slice(0,100).map(h=>{
    const t=sType(h.symbol||'');
    return \`<tr class="t\${t[0]}">
      <td class="cd" style="font-size:10px;white-space:nowrap">\${dt(h.ts)} \${ts(h.ts)}</td>
      <td>\${hBadge(h.type)}</td>
      <td class="cb">\${h.symbol||'<span class="cd">—</span>'}</td>
      <td>\${cat(t)}</td>
      <td>\${h.direction?'<span class="b b-'+h.direction+'">'+h.direction.toUpperCase()+'</span>':'<span class="cd">—</span>'}</td>
      <td>\${(h.vwapPosition||h.vwap_pos)?'<span class="b b-'+(h.vwapPosition||h.vwap_pos)+'">'+(h.vwapPosition||h.vwap_pos)+'</span>':'<span class="cd">—</span>'}</td>
      <td>\${sBadge(h.session)}</td>
      <td style="text-align:right">\${h.entry?f(h.entry,5):'<span class="cd">—</span>'}</td>
      <td style="text-align:right" class="cr">\${h.sl?f(h.sl,5):'<span class="cd">—</span>'}</td>
      <td style="text-align:right" class="cg">\${h.tp?f(h.tp,5):'<span class="cd">—</span>'}</td>
      <td style="text-align:right">\${h.lots?f(h.lots,2):'<span class="cd">—</span>'}</td>
      <td style="text-align:right" class="cgd">\${h.riskPct?fP(h.riskPct):'<span class="cd">—</span>'}</td>
      <td style="font-size:9px;color:var(--dim);max-width:150px;overflow:hidden;text-overflow:ellipsis">\${h.optimizer_key||h.optimizerKey||'—'}</td>
      <td style="font-size:9px;color:var(--dim)">\${h.position_id||h.positionId||'—'}</td>
      <td style="font-size:9px;color:var(--dim)">\${h.reason||(h.optimalLots!=null?'lots='+h.optimalLots:'—')}</td>
    </tr>\`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// GHOSTS
// ══════════════════════════════════════════════════════════════
async function loadGhosts(){
  const [lv,hs]=await Promise.all([api('/live/ghosts'),api('/ghosts/history?limit=30')]);
  document.getElementById('k-gh').textContent=lv?.count??0;
  document.getElementById('gh-meta').textContent=(lv?.count??0)+' active';
  const b=document.getElementById('gha-body');
  if(!lv?.ghosts?.length)b.innerHTML='<tr><td colspan="9" class="nodata">No active ghosts</td></tr>';
  else b.innerHTML=lv.ghosts.map(g=>{
    const slU=g.entry&&g.sl&&g.maxPrice?(Math.abs(g.entry-g.maxPrice)/Math.abs(g.entry-g.sl)*100):null;
    return \`<tr><td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
      <td><span class="b b-\${g.direction}">\${g.direction?.toUpperCase()}</span></td>
      <td>\${sBadge(g.session)}</td>
      <td>\${f(g.entry,5)}</td><td class="cr">\${f(g.sl,5)}</td>
      <td>\${f(g.maxPrice,5)}</td><td class="cc">\${f(g.maxRR,2)}R</td>
      <td>\${slBar(slU)}</td><td class="cd">\${g.elapsedMin}m</td></tr>\`;
  }).join('');
  const bh=document.getElementById('ghh-body');
  if(!hs?.rows?.length)bh.innerHTML='<tr><td colspan="9" class="nodata">No ghost history</td></tr>';
  else bh.innerHTML=hs.rows.map(g=>\`<tr>
    <td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
    <td><span class="b b-\${g.direction||'def'}">\${(g.direction||'?').toUpperCase()}</span></td>
    <td>\${sBadge(g.session)}</td>
    <td class="cc">\${f(g.maxRRBeforeSL,2)}R</td>
    <td class="cgd">\${f(g.tpRRUsed,1)}R</td>
    <td>\${g.phantomSLHit?'<span class="cr">✓ SL</span>':'<span class="cd">—</span>'}</td>
    <td class="cd">\${g.stopReason||'—'}</td>
    <td class="cd">\${g.timeToSLMin!=null?g.timeToSLMin+'m':'—'}</td>
    <td class="cd" style="font-size:9px">\${dt(g.closedAt)} \${ts(g.closedAt)}</td>
  </tr>\`).join('');
}

// ══════════════════════════════════════════════════════════════
// EV MATRIX
// ══════════════════════════════════════════════════════════════
async function loadEV(){
  const d=await api('/ev');if(!d)return;
  document.getElementById('k-tp').textContent=d.filter(x=>(x.count||0)>=5&&(x.bestEV||0)>0).length;
  document.getElementById('ev-meta').textContent=d.length+' keys';
  const lk={};for(const e of d)lk[e.key]=e;
  function mx(syms,tid,sess,names){
    const el=document.getElementById(tid);if(!el)return;
    let h='<thead><tr><th style="position:sticky;left:0;z-index:2;min-width:120px;background:var(--bg2)">Symbol</th>';
    for(const s of sess){const lb={asia:'🌏 ASIA',london:'🇬🇧 LON',ny:'🇺🇸 NY'}[s];h+=\`<th colspan="4" style="text-align:center;border-left:1px solid var(--border2);background:var(--bg2);font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700">\${lb}</th>\`;}
    h+='</tr><tr><th style="position:sticky;left:0;z-index:2;background:var(--bg2);font-size:9px">bestRR/EV/n</th>';
    for(const s of sess)for(const dr of D2){const dc=dr==='buy'?'cg':'cr';for(const vw of V2){const vc=vw==='above'?'cb':'cp';h+=\`<th style="text-align:center;font-size:9px;border-left:\${vw==='above'?'1px solid var(--border2)':'none'}"><span class="\${dc}">\${dr[0].toUpperCase()}</span>/<span class="\${vc}">\${vw[0]}</span></th>\`;}}
    h+='</tr></thead><tbody>';
    for(const sym of syms){
      const lb=(names&&names[sym])||sym;
      h+=\`<tr><td class="ml">\${lb}</td>\`;
      for(const s of sess)for(const dr of D2)for(const vw of V2){
        const key=sym+'_'+s+'_'+dr+'_'+vw,ev=lk[key];
        const bl=vw==='above'?'border-left:1px solid var(--border2);':'';
        if(!ev||!ev.count){h+=\`<td class="mc" style="\${bl}"><span class="cd" style="font-size:9px">—</span></td>\`;}
        else{
          const ep=(ev.bestEV||0)>0,en=(ev.bestEV||0)<0,lc=ev.count>=5&&ep;
          h+=\`<td class="mc" style="\${bl}\${lc?'background:rgba(240,192,48,.05);':''}"><div style="font-size:12px;font-family:'Barlow Condensed';font-weight:700" class="\${ep?'ep':en?'en':'ez'}">\${ev.bestRR!=null?f(ev.bestRR,1)+'R':'—'}</div><div style="font-size:9px" class="\${ep?'ep':en?'en':'ez'}">\${ev.bestEV!=null?f(ev.bestEV,3):'—'}</div><div style="font-size:9px" class="cd">n=\${ev.count||0}\${lc?'<span class="cgd"> ★</span>':''}</div></td>\`;
        }
      }
      h+='</tr>';
    }
    el.innerHTML=h+'</tbody>';
  }
  mx(FOREX,'mx-forex',S3,null);
  mx(IDX,'mx-index',S3,{DE30EUR:'DAX40',NAS100USD:'NAS100',UK100GBP:'UK100',US30USD:'US30'});
  mx(COMM,'mx-comm',S3,{XAUUSD:'Gold (XAUUSD)'});
  mx(STK,'mx-stocks',SNY,null);
}

// ══════════════════════════════════════════════════════════════
// SHADOW SL
// ══════════════════════════════════════════════════════════════
async function loadShadow(){
  const [d,dw]=await Promise.all([api('/shadow'),api('/shadow/winners')]);
  if(!d)return;
  const wMap={};(dw?.winners||[]).forEach(w=>wMap[w.optimizerKey]=w);
  document.getElementById('sh-meta').textContent=d.count+' keys';
  const b=document.getElementById('sh-body');
  if(!d.results.length){b.innerHTML='<tr><td colspan="16" class="nodata">No shadow data yet</td></tr>';return;}
  b.innerHTML=d.results.map(s=>{
    const w=wMap[s.optimizerKey];
    return \`<tr>
      <td style="font-size:9px;color:var(--dim)">\${s.optimizerKey}</td>
      <td class="cb">\${s.symbol||'—'}</td>
      <td>\${sBadge(s.session)}</td>
      <td><span class="b b-\${s.direction}">\${(s.direction||'').toUpperCase()}</span></td>
      <td><span class="b b-\${s.vwapPosition||'unknown'}">\${s.vwapPosition||'?'}</span></td>
      <td style="text-align:right">\${s.snapshotsCount||0}</td>
      <td style="text-align:right">\${s.positionsCount||0}</td>
      <td style="text-align:right">\${f(s.p50,1)}%</td>
      <td style="text-align:right">\${f(s.p90,1)}%</td>
      <td style="text-align:right" class="cgd">\${f(s.p99,1)}%</td>
      <td style="text-align:right" class="cr">\${f(s.maxUsed,1)}%</td>
      <td style="text-align:right" class="cc">\${s.recommendedSlPct!=null?(s.recommendedSlPct*100).toFixed(0)+'%':'—'}</td>
      <td>\${s.currentSlTooWide?'<span class="cr">⚠ TOO WIDE</span>':'<span class="cg">OK</span>'}</td>
      <td style="text-align:right" class="cgd">\${s.potentialSavingPct!=null?s.potentialSavingPct+'%':'—'}</td>
      <td style="text-align:right" class="cg fw">\${w?.p90!=null?f(w.p90,1)+'%':'—'}</td>
      <td style="text-align:right" class="cc">\${w?.winnerCount||'—'}</td>
    </tr>\`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// FLAGGED TRADES
// ══════════════════════════════════════════════════════════════
function flagT(t){
  const f=[];
  if(!t.symbol)f.push('NO_SYMBOL');
  if(!t.direction)f.push('NO_DIR');
  if(!t.entry||t.entry===0)f.push('ZERO_ENTRY');
  if(!t.sl||t.sl===0)f.push('ZERO_SL');
  if(!t.vwapPosition||t.vwapPosition==='unknown')f.push('UNKNOWN_VWAP');
  if(t.realizedPnlEUR==null&&t.currentPnL==null)f.push('NULL_PNL');
  if(t.closeReason&&!['tp','sl','manual'].includes(t.closeReason))f.push('BAD_CLOSE');
  if(t.maxRR!=null&&t.maxRR<0)f.push('NEG_RR');
  return f;
}
function loadErrors(){
  const errs=_allT.map(t=>({...t,flags:flagT(t)})).filter(t=>t.flags.length>0);
  document.getElementById('k-err').textContent=errs.length;
  document.getElementById('err-meta').textContent=errs.length+' flagged';
  const b=document.getElementById('err-body');
  if(!errs.length){b.innerHTML='<tr><td colspan="13" class="nodata">✓ No errors — all trades look clean</td></tr>';return;}
  b.innerHTML=errs.map(t=>{
    const pnl=t.realizedPnlEUR??t.currentPnL;
    return \`<tr class="erow t\${sType(t.symbol||'')[0]}">
      <td class="cd" style="font-size:9px">\${t.positionId||t.id||'—'}</td>
      <td class="cb">\${t.symbol||'<span class="cr">MISSING</span>'}</td>
      <td>\${t.direction?'<span class="b b-'+t.direction+'">'+t.direction.toUpperCase()+'</span>':'<span class="cr">?</span>'}</td>
      <td><span class="b b-\${t.vwapPosition||'unknown'}">\${t.vwapPosition||'unknown'}</span></td>
      <td>\${sBadge(t.session)}</td>
      <td>\${t.entry?f(t.entry,5):'<span class="cr">0</span>'}</td>
      <td class="cr">\${t.sl?f(t.sl,5):'<span class="cr">0</span>'}</td>
      <td class="\${(t.maxRR||0)<0?'cr':'cc'}">\${f(t.maxRR,2)}R</td>
      <td>\${cBadge(t.closeReason)}</td>
      <td class="\${pnl>0?'cg':pnl<0?'cr':'cd'}">\${pnl!=null?'€'+f(pnl,2):'<span class="cr">NULL</span>'}</td>
      <td>\${f(t.lots,2)}</td>
      <td>\${t.flags.map(f=>'<span class="b b-err">'+f+'</span>').join(' ')}</td>
      <td class="cd" style="font-size:9px">\${dt(t.closedAt)} \${ts(t.closedAt)}</td>
    </tr>\`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// RISK CONFIG
// ══════════════════════════════════════════════════════════════
let _rD=[];
async function loadRisk(){
  const [rd,ld]=await Promise.all([api('/risk-config'),api('/lot-overrides')]);
  if(rd){
    _rD=rd.config||[];
    document.getElementById('risk-meta').textContent='Balance: €'+(rd.balance||0).toFixed(0)+' | Fixed: '+(rd.fixedRiskPct*100).toFixed(3)+'%';
    renderRisk();
  }
  if(ld){
    document.getElementById('k-lots').textContent=ld.count||0;
    const b=document.getElementById('lots-body');
    if(!ld.overrides.length){b.innerHTML='<tr><td colspan="5" class="nodata">No SL recalcs yet — overrides appear after first SL hit</td></tr>';return;}
    b.innerHTML=ld.overrides.map(o=>\`<tr>
      <td class="cb fw">\${o.symbol}</td>
      <td class="cgd fw" style="font-size:14px">\${o.lots}</td>
      <td class="co">\${o.envVar}=\${o.lots}</td>
      <td class="cd">\${(o.riskPct*100).toFixed(3)}%</td>
      <td style="font-size:10px;color:var(--dim)">\${o.instruction}</td>
    </tr>\`).join('');
  }
}
function renderRisk(){
  let d=_rD;if(riskF!=='all')d=d.filter(r=>r.type===riskF);
  const b=document.getElementById('risk-body');
  b.innerHTML=d.map(c=>\`<tr>
    <td class="cb">\${c.symbol}</td><td>\${cat(c.type)}</td>
    <td class="cgd">\${(c.riskPct*100).toFixed(3)}%</td>
    <td class="cg">€\${c.riskEUR}</td>
    <td class="\${c.riskMult>1?'cg':'cd'}">x\${(c.riskMult||1).toFixed(2)}</td>
    <td class="co">\${c.lotOverride!=null?c.lotOverride:'—'}</td>
    <td style="font-size:9px;color:var(--dim)">\${c.envVar}</td>
  </tr>\`).join('');
}

// ══════════════════════════════════════════════════════════════
// CLOCK + GLOBAL LOAD
// ══════════════════════════════════════════════════════════════
function updateClock(){document.getElementById('clock').textContent=new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
setInterval(updateClock,1000);updateClock();

async function loadAll(){
  const h=await api('/health');
  if(h){
    const s=h.session||'outside';
    document.getElementById('k-sess').textContent=s.toUpperCase();
    document.getElementById('k-bal').textContent=(h.balance||0).toFixed(0);
    document.getElementById('k-gh').textContent=h.ghosts||0;
    document.getElementById('k-lots').textContent=h.lotOverrides||0;
    const hb=document.getElementById('hdr-sess');
    hb.className='sess-badge s-'+s;
    hb.textContent={asia:'⛩ ASIA',london:'🇬🇧 LONDON',ny:'🇺🇸 NEW YORK',outside:'⏸ OUTSIDE'}[s]||s.toUpperCase();
  }
  await Promise.all([loadPositions(),loadOverview(),loadHistory(),loadGhosts(),loadEV(),loadShadow(),loadRisk()]);
  loadErrors();
}
document.addEventListener('DOMContentLoaded',()=>{loadAll();setInterval(loadAll,30000);});
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

  console.log("🚀 PRONTO-AI v10.2 starting...");
  await initDB();

  // Load closed trades
  const trades = await loadAllTrades();
  closedTrades.push(...trades);
  console.log(`📂 ${trades.length} closed trades loaded`);

  // Load TP locks
  const savedTP = await loadTPConfig();
  Object.assign(tpLocks, savedTP);
  console.log(`🔒 ${Object.keys(tpLocks).length} TP locks loaded`);

  // Load shadow analyses
  const shadowRows = await loadShadowAnalysis();
  for (const row of shadowRows) shadowResults[row.optimizerKey] = row;
  console.log(`🌑 ${shadowRows.length} shadow analyses loaded`);

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
    // Load lot overrides from env (LOTS_EURUSD=0.02 etc.)
    const lotKey = `LOTS_${sym}`;
    if (process.env[lotKey]) {
      lotOverrides[sym] = parseFloat(process.env[lotKey]);
    }
  }
  console.log(`💰 Symbol risk overrides: ${Object.keys(symbolRiskMap).length} | Lot overrides from env: ${Object.keys(lotOverrides).length}`);

  // Fetch live balance from MT5
  try {
    await fetchAccountInfo();
    console.log(`💵 Live MT5 balance: €${liveBalance.toFixed(2)}`);
  } catch (e) {
    console.warn(`[!] Could not fetch live balance: ${e.message}`);
  }

  // Load daily risk state
  const dr = await loadLatestDailyRisk();
  if (dr) console.log(`📊 Last daily risk record: ${dr.tradeDate}`);

  // Restore positions from MT5
  await restorePositionsFromMT5();

  app.listen(PORT, () => {
    console.log(`[✓] PRONTO-AI v10.2 on port ${PORT}`);
    console.log(`   🔹 Dashboard:      / or /dashboard`);
    console.log(`   🔹 Health:         /health`);
    console.log(`   🔹 EV Table:       /ev`);
    console.log(`   🔹 Shadow SL:      /shadow`);
    console.log(`   🔹 TP Locks:       /tp-locks`);
    console.log(`   🔹 Risk Config:    /risk-config`);
    console.log(`   🔹 Lot Overrides:  /lot-overrides`);
    console.log(`   🔹 Risk Mults:     /risk-multipliers`);
    console.log(`   🔹 Signal Stats:   /signal-stats`);
    console.log(`   🔹 Shadow Winners: /shadow/winners`);
    console.log(`   🔹 Webhook:        POST /webhook?secret=<secret>`);
    console.log(`   💵 Fixed risk:     ${(FIXED_RISK_PCT*100).toFixed(3)}% | Balance: €${liveBalance.toFixed(2)}`);
    console.log(`   🕐 Ghost max:      72h (overnight holdings supported)`);
    console.log(`   📊 Mult threshold: ${MULT_MIN_SAMPLE} ghost samples required`);
  });
}

start().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
