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
<title>PRONTO-AI v10.2</title>
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
    <div class="ver">v10.2 · TradingView → MetaApi → FTMO MT5 · Fixed Risk ${(FIXED_RISK_PCT*100).toFixed(3)}%</div>
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
        <th class="s" data-col="8">Max RR</th><th class="s" data-col="9">TP</th><th class="s" data-col="10">TP RR</th>
        <th class="s" data-col="11">PnL €</th><th class="s" data-col="12">PnL %</th><th class="s" data-col="13">Lots</th><th class="s" data-col="14">Risk €</th>
        <th>Ghost</th><th class="s" data-col="16">Opened</th>
      </tr></thead>
      <tbody id="pos-body"><tr><td colspan="17" class="nodata">Loading…</td></tr></tbody>
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
        <th class="s" data-col="16">TP Hits</th><th class="s" data-col="17">SL Hits</th>
      </tr></thead>
      <tbody id="ov-body"><tr><td colspan="18" class="nodata">Loading…</td></tr></tbody>
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
  <div class="sh"><span class="st o">▸ LOT SIZE CALCULATOR</span><span class="sm">formula · what to change · live config</span></div>
  <div class="lotbox">
    <div class="lc">
      <div class="lct b">Formula</div>
      <div class="lcf">
        Every trade risks the same <b style="color:var(--b)">€ amount</b> regardless of SL distance.
        <div class="formula">riskEUR = balance × riskPct × mult<br>dist    = |entry − SL|<br>lots    = riskEUR ÷ (dist × lotValue)</div>
        <b style="color:var(--b)">lotValue:</b> Forex=<code>10</code> Index=<code>20</code> Commodity=<code>100</code> Stock=<code>1</code><br><br>
        Stocks capped at <b style="color:var(--o)">20% of balance</b> as max notional.
      </div>
    </div>
    <div class="lc">
      <div class="lct g">Variables to Change</div>
      <ul class="chlist">
        <li><b>FIXED_RISK_PCT</b> — master risk%. Set in Railway: <code>FIXED_RISK_PCT=0.002</code></li>
        <li><b>RISK_&lt;SYM&gt;</b> — per-symbol override: <code>RISK_EURUSD=0.002</code></li>
        <li><b>LOTS_&lt;SYM&gt;</b> — hard lot override after SL recalc: <code>LOTS_NVDA=0.05</code></li>
        <li><b>LOT_VALUE</b> in server.js — lot value per type if broker differs</li>
        <li><b>MIN_STOP</b> in server.js — min SL distance per symbol</li>
        <li><b>Risk mult</b> — auto ×1.2/day up to ×4 after EV+ streak (needs 30 ghost samples)</li>
      </ul>
    </div>
    <div class="lc">
      <div class="lct y">Live Config &amp; Lot Overrides</div>
      <div class="tw" style="border:none">
        <table id="risk-tbl" style="font-size:10px">
          <thead><tr><th>Symbol</th><th>Type</th><th>Risk%</th><th>Risk €</th><th>Mult</th><th>Lot OV</th></tr></thead>
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
        <th class="s" data-col="5">Max RR</th><th>SL Used%</th>
        <th class="s" data-col="7">Elapsed (min)</th><th>Status</th>
      </tr></thead>
      <tbody id="gh-body"><tr><td colspan="9" class="nodata">Loading…</td></tr></tbody>
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
    return\`<tr class="\${tClass(p.symbol)}">
      <td data-val="\${p.symbol}" class="b fw">\${p.symbol}</td>
      <td>\${dBadge(p.direction)}</td><td>\${vBadge(p.vwapPosition)}</td><td>\${sBadge(p.session)}</td>
      <td data-val="\${p.entry}" class="d">\${f(p.entry,5)}</td>
      <td data-val="\${p.sl}" class="r">\${f(p.sl,5)}</td>
      <td data-val="\${p.slDistPct}" class="o">\${p.slDistPct!=null?p.slDistPct+'%':'—'}</td>
      <td>\${slBar(slU)}</td>
      <td data-val="\${p.maxRR}" class="\${p.maxRR>0?'g':'d'} fw">\${f(p.maxRR,2)}R</td>
      <td data-val="\${p.tp}" class="g">\${f(p.tp,5)}</td>
      <td data-val="\${p.tpRR}" class="y">\${f(p.tpRR,1)}R</td>
      <td data-val="\${p.currentPnL}" class="\${pC(p.currentPnL)} fw">\${eu(p.currentPnL)}</td>
      <td data-val="\${pnlP}" class="\${pC(p.currentPnL)}">\${pnlP!=null?(pnlP>=0?'+':'')+pnlP+'%':'—'}</td>
      <td data-val="\${p.lots}" class="c">\${f(p.lots,2)}</td>
      <td data-val="\${p.riskEUR}" class="o">€\${f(p.riskEUR,0)}</td>
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
          const trades=_allTrades.filter(t=>t.symbol===sym&&t.session===sess&&t.direction===dir&&(t.vwapPosition||'unknown')===vwap);
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
          const wSlP=wins.map(t=>t.slDistPct??null).filter(v=>v!=null);
          const avgWSlP=wSlP.length?wSlP.reduce((a,b)=>a+b,0)/wSlP.length:null;
          combos.push({sym,sess,dir,vwap,key,trades,wins,sls,winPct,avgRR,bestRR,totalPnl,avgPnl:trades.length?totalPnl/trades.length:null,ev:evMap[key],tp:tpMap[key],type,avgSlP,avgWSlP});
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
  if(!rows.length){tb.innerHTML='<tr><td colspan="9" class="nodata">No ghost data</td></tr>';return;}
  tb.innerHTML=rows.map(g=>{
    const isA=g.status==='ACTIVE';
    const rr=g.maxRR??g.maxRRBeforeSL;
    return\`<tr class="\${tClass(g.symbol||'')}">
      <td class="d" style="font-size:9px">\${(g.optimizerKey||'—').slice(0,28)}</td>
      <td class="b fw">\${g.symbol||'—'}</td><td>\${dBadge(g.direction)}</td><td>\${sBadge(g.session)}</td>
      <td data-val="\${g.entry}" class="d">\${f(g.entry,5)}</td>
      <td data-val="\${rr??-99}" class="\${rr>0?'g':'d'}">\${f(rr,2)}R</td>
      <td>\${slBar(g.slPctUsed??0)}</td>
      <td data-val="\${g.elapsedMin??g.timeToSLMin??0}" class="d">\${g.elapsedMin??g.timeToSLMin??'—'}</td>
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
