// ===============================================================
// server.js  v10.0  |  PRONTO-AI
// TradingView → MetaApi REST → FTMO MT5
//
// v10.0 changes:
//  - Balance always fetched LIVE from MT5 (fetchAccountInfo)
//  - Fixed risk at 0.15% per trade (FIXED_RISK_PCT in config)
//  - No ACCOUNT_BALANCE env needed — comes from MT5 live
//  - Crypto (BTCUSD) removed entirely
//  - No LOT_STEP / MAX_LOTS — lots auto-calculated from SL distance
//  - After every SL hit: Railway env LOTS_<SYMBOL> updated via
//    /admin/update-lots API so future trades use corrected lot size
//  - Spread (ask-bid) logged on every trade placement
//  - Daily risk multiplier ONLY activates when optimizer key is EV+:
//    +1.2x each consecutive EV+ day per key, max x4 total
//  - PORT always uses process.env.PORT (Railway auto-assigns)
//  - Dashboard: single-page full UI, no extra clicking
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
  computeEVStats,
} = require("./db");

const {
  SYMBOL_CATALOG, SESSION_LABELS, DEFAULT_RISK_BY_TYPE,
  getBrusselsComponents, getBrusselsDateStr, getBrusselsDateOnly,
  getSession, isMarketOpen, isGhostActive,
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
const GHOST_MAX_MS            = 24 * 3600 * 1000;

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
// No LOT_STEP snapping, no MAX_LOTS — broker handles min/max.
// After SL hit, we re-derive optimal lots and update Railway env.
function calcLots(symbol, entry, sl, riskEUR) {
  const info    = getSymbolInfo(symbol);
  const type    = info?.type || "stock";
  const lotVal  = LOT_VALUE[type] ?? 1;
  const dist    = Math.abs(entry - sl);
  if (!dist || !riskEUR) return 0.01;
  const lots = riskEUR / (dist * lotVal);
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
async function getOptimalTP(optimizerKey) {
  const locked = tpLocks[optimizerKey];
  if (locked) return locked.lockedRR;
  const count = await countGhostsByKey(optimizerKey);
  if (count < GHOST_MIN_TRADES_FOR_TP) return 1.0;
  const ev = await computeEVStats(optimizerKey);
  if (!ev || ev.count < GHOST_MIN_TRADES_FOR_TP) return 1.0;
  return ev.bestRR ?? 1.0;
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
      const ghostOK  = isGhostActive();
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

      if (elapsed >= GHOST_MAX_MS || !ghostOK) {
        await finalizeGhost(positionId, elapsed >= GHOST_MAX_MS ? "timeout" : "outside_window", elapsed, maxPrice);
        return;
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

  const closed = { ...pos, maxRR, hitTP, closeReason, closedAt: now, trueMaxRR: null, trueMaxPrice: null };
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
      if (openPositions[id].sl > 0) startGhostTracker(openPositions[id]);
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
// Only applies multiplier when a specific key is EV+.
// Each consecutive EV+ day × 1.2, max ×4. Resets to 1.0 on EV- day.
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
      const ev = await computeEVStats(key);
      const isEvPositive = (ev?.bestEV ?? 0) > 0;
      const isDayPositive = data.pnl > 0;

      if (isEvPositive && isDayPositive) {
        // EV+ key had a positive day → increase multiplier
        const prev = keyRiskMult[key] ?? { streak: 0, mult: 1.0 };
        const newMult = Math.min(4.0, parseFloat((prev.mult * 1.2).toFixed(4)));
        keyRiskMult[key] = { streak: prev.streak + 1, mult: newMult };
        console.log(`[DailyRisk] ${key}: EV+ day → mult ${prev.mult.toFixed(2)}x → ${newMult.toFixed(2)}x (streak ${keyRiskMult[key].streak})`);
      } else {
        // Not EV+ or negative day → reset
        if (keyRiskMult[key]) {
          console.log(`[DailyRisk] ${key}: Reset → mult 1.0x`);
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

cron.schedule("0 23 * * 1-5", async () => {
  let stopped = 0;
  for (const [id, g] of Object.entries(ghostTrackers)) {
    clearTimeout(g.timer);
    await saveGhostTrade({
      positionId: g.positionId, symbol: g.symbol, session: g.session,
      direction: g.direction, vwapPosition: g.vwapPosition,
      optimizerKey: g.optimizerKey, entry: g.entry, sl: g.sl, slPct: g.slPct,
      phantomSL: g.sl, tpRRUsed: g.tpRRUsed,
      maxPrice: g.maxPrice, maxRRBeforeSL: calcMaxRR(g.direction, g.entry, g.sl, g.maxPrice),
      phantomSLHit: false, stopReason: "23:00_hard_stop",
      timeToSLMin: null, openedAt: g.openedAt, closedAt: new Date().toISOString(),
    }).catch(() => {});
    delete ghostTrackers[id];
    stopped++;
  }
  if (stopped > 0) {
    console.log(`[23:00] ${stopped} ghost(s) stopped`);
    logEvent({ type: "GHOST_HARD_STOP", count: stopped });
  }
}, { timezone: "Europe/Brussels" });

// ── Webhook handler ───────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const {
    action,
    symbol: rawSymbol,
    entry:  tvEntry,
    sl_pct,
    vwap,
    vwap_upper,
    vwap_lower,
  } = body;

  // Validate action
  const direction = action === "buy" ? "buy" : action === "sell" ? "sell" : null;
  if (!direction) {
    return res.status(400).json({ error: "action must be buy or sell" });
  }

  // Normalize & validate symbol
  const symKey  = normalizeSymbol(rawSymbol);
  const symInfo = symKey ? getSymbolInfo(symKey) : null;
  if (!symKey || !symInfo) {
    logEvent({ type: "REJECTED", reason: `Symbol not in catalog: ${rawSymbol}` });
    return res.status(400).json({ error: `Symbol not allowed: ${rawSymbol}` });
  }

  const { type: assetType, mt5: mt5Symbol } = symInfo;

  // Market hours check
  if (!isMarketOpen()) {
    const { hhmm, day } = getBrusselsComponents();
    logEvent({ type: "REJECTED", reason: `Outside window ${hhmm} day=${day}`, symbol: symKey, direction });
    return res.status(200).json({ status: "OUTSIDE_WINDOW", hhmm });
  }

  // Session & VWAP
  const session      = getSession();
  const closePrice   = parseFloat(tvEntry) || 0;
  const vwapMid      = parseFloat(vwap)    || 0;
  const vwapPosition = getVwapPosition(closePrice, vwapMid);
  const optimizerKey = buildOptimizerKey(symKey, session, direction, vwapPosition);

  // Parse sl_pct from TradingView
  const slPctRaw = parseFloat(sl_pct);
  if (!slPctRaw || slPctRaw <= 0 || slPctRaw > 0.1) {
    return res.status(400).json({ error: `Invalid sl_pct: ${sl_pct}` });
  }

  // Duplicate guard (same symbol+direction within 60s)
  const dupKey  = `${symKey}_${direction}`;
  const dupLast = global._dupGuard?.[dupKey];
  if (dupLast && (Date.now() - dupLast) < 60000) {
    logEvent({ type: "DUPLICATE_BLOCKED", symbol: symKey, direction, optimizerKey });
    return res.status(200).json({ status: "DUPLICATE_BLOCKED" });
  }
  if (!global._dupGuard) global._dupGuard = {};
  global._dupGuard[dupKey] = Date.now();

  // ── Fetch MT5 execution price — all data from MT5, not TV ────────
  let mt5Entry = closePrice;
  let spread   = 0;
  let bid      = null;
  let ask      = null;
  try {
    const pd = await fetchCurrentPrice(mt5Symbol);
    if (pd) {
      bid      = pd.bid;
      ask      = pd.ask;
      spread   = pd.spread ?? 0;
      mt5Entry = direction === "buy" ? pd.ask : pd.bid;
    }
  } catch {}

  // Calculate SL from MT5 execution price using sl_pct from TV
  let mt5SL = calcSLFromPct(direction, mt5Entry, slPctRaw);
  mt5SL     = enforceMinStop(mt5Symbol, direction, mt5Entry, mt5SL);

  // Get optimal TP
  const tpRR  = await getOptimalTP(optimizerKey);
  const mt5TP = calcTPPrice(direction, mt5Entry, mt5SL, tpRR);

  // Risk & lots using LIVE MT5 balance
  const riskPct = getSymbolRiskPct(symKey);
  const mult    = getKeyRiskMult(optimizerKey);
  const riskEUR = await calcRiskEUR(symKey, optimizerKey);
  const balance = await getLiveBalance();

  // Use lot override if available (set after SL recalc), else calculate fresh
  let lots;
  if (lotOverrides[symKey]) {
    lots = lotOverrides[symKey];
    console.log(`[Lots] ${symKey}: using override ${lots} (from SL recalc)`);
  } else {
    lots = calcLots(symKey, mt5Entry, mt5SL, riskEUR);
  }

  if (!lots || lots <= 0) {
    logEvent({ type: "REJECTED", reason: "calcLots returned 0", symbol: symKey, direction });
    return res.status(200).json({ status: "LOT_CALC_FAILED" });
  }

  // Build MT5 comment (max 26 chars)
  const sessShort = session === "london" ? "LON" : session === "ny" ? "NY" : "AS";
  const dirShort  = direction === "buy" ? "B" : "S";
  const comment   = `NV-${dirShort}-${symKey.slice(0,8)}-${tpRR}R-${sessShort}`.slice(0, 26);

  // Build MetaApi order
  const orderPayload = {
    symbol:     mt5Symbol,
    actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    volume:     lots,
    stopLoss:   mt5SL,
    takeProfit: mt5TP,
    comment,
  };

  // Place order
  let result, positionId;
  try {
    result     = await placeOrder(orderPayload);
    positionId = String(result?.positionId ?? result?.orderId ?? `local_${Date.now()}`);
  } catch (e) {
    const errMsg = e.message;
    logEvent({ type: "ERROR", symbol: symKey, direction, reason: errMsg, optimizerKey });
    await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition,
      action, status: "ERROR", reason: errMsg, optimizerKey,
      entry: mt5Entry, sl: mt5SL, tp: mt5TP, lots, riskPct });
    return res.status(200).json({ status: "ORDER_FAILED", error: errMsg });
  }

  // Register open position
  const now = new Date().toISOString();
  openPositions[positionId] = {
    positionId, symbol: symKey, mt5Symbol, direction, vwapPosition,
    optimizerKey, entry: mt5Entry, sl: mt5SL, tp: mt5TP, slPct: slPctRaw,
    lots, riskEUR, riskPct, riskMult: mult, balance,
    spread, bid, ask,
    session, openedAt: now,
    maxPrice: mt5Entry, maxRR: 0, currentPnL: 0,
    vwapAtEntry: vwapMid, tpRRUsed: tpRR,
    tvEntry: closePrice,  // keep TV entry for slippage display
  };

  startGhostTracker(openPositions[positionId]);

  const logEntry = {
    type: "ORDER_PLACED", symbol: symKey, direction, session,
    vwapPosition, optimizerKey,
    entry: mt5Entry, sl: mt5SL, tp: mt5TP, tpRR,
    lots, riskPct, riskEUR: riskEUR.toFixed(2), riskMult: mult,
    spread: spread.toFixed(5), bid, ask,
    balance: balance.toFixed(2),
    positionId, comment,
    tvEntry: closePrice, tvSlPct: slPctRaw, vwap: vwapMid,
  };
  logEvent(logEntry);
  await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition,
    action, status: "PLACED", positionId, optimizerKey,
    entry: mt5Entry, sl: mt5SL, tp: mt5TP, lots, riskPct });

  console.log(`[✓] ${direction.toUpperCase()} ${symKey} | key=${optimizerKey} | entry=${mt5Entry} sl=${mt5SL} tp=${mt5TP} (${tpRR}R) | lots=${lots} | risk=${(riskPct*100).toFixed(3)}% | spread=${spread.toFixed(5)} | balance=€${balance.toFixed(0)} | mult=x${mult.toFixed(2)}`);

  return res.status(200).json({
    status: "PLACED", positionId, symbol: symKey, direction,
    entry: mt5Entry, sl: mt5SL, tp: mt5TP, tpRR,
    lots, riskPct, riskEUR, riskMult: mult, optimizerKey,
    spread, bid, ask, balance,
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

app.get("/health", async (req, res) => {
  const balance = await getLiveBalance();
  res.json({
    status:    "ok",
    version:   "10.0.0",
    time:      getBrusselsDateStr(),
    openPos:   Object.keys(openPositions).length,
    ghosts:    Object.keys(ghostTrackers).length,
    tpLocks:   Object.keys(tpLocks).length,
    closedT:   closedTrades.length,
    balance,
    fixedRiskPct: FIXED_RISK_PCT,
    marketOpen: isMarketOpen(),
    session:   getSession(),
    lotOverrides: Object.keys(lotOverrides).length,
    evKeyMults: Object.keys(keyRiskMult).length,
  });
});

// ── Dashboard — single page, all sections always loaded ──────────
app.get(["/", "/dashboard"], async (req, res) => {
  const balance = await getLiveBalance();
  res.setHeader("Content-Type", "text/html");

  const FOREX_SYMBOLS   = ["AUDCAD","AUDCHF","AUDNZD","AUDUSD","CADCHF","EURAUD","EURCHF","EURUSD","GBPAUD","GBPNZD","GBPUSD","NZDCAD","NZDCHF","NZDUSD","USDCAD","USDCHF"];
  const INDEX_SYMBOLS   = ["DE30EUR","NAS100USD","UK100GBP","US30USD"];
  const COMMODITY_SYMBOLS = ["XAUUSD"];
  const STOCK_SYMBOLS   = ["AAPL","AMD","AMZN","ARM","ASML","AVGO","AZN","BA","BABA","BAC","BRKB","CSCO","CVX","DIS","FDX","GE","GM","GME","GOOGL","IBM","INTC","JNJ","JPM","KO","LMT","MCD","META","MSFT","MSTR","NFLX","NKE","NVDA","PFE","PLTR","QCOM","SBUX","SNOW","T","TSLA","V","WMT","XOM","ZM"];

  res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v10.0 — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#080c10;--bg2:#0c1117;--card:#0f151c;--border:#1a2535;--border2:#243348;--text:#c8d8e8;--dim:#4a6080;--dim2:#2a3d55;--green:#00e5a0;--red:#ff3d5a;--gold:#f0c040;--purple:#b08cff;--blue:#38c0f8;--cyan:#00e5d8;--orange:#ff8c42;--scanline:rgba(0,0,0,0.12)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;width:100%;height:100%;background:repeating-linear-gradient(0deg,transparent,transparent 2px,var(--scanline) 2px,var(--scanline) 4px);pointer-events:none;z-index:9999;opacity:.35}
.layout{display:grid;grid-template-rows:auto auto auto 1fr;min-height:100vh}
.header{padding:14px 24px;background:linear-gradient(90deg,#0a1020,#0d1828);border-bottom:1px solid var(--border2);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;backdrop-filter:blur(8px)}
.header-brand{display:flex;align-items:center;gap:14px}
.brand-logo{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;letter-spacing:2px;color:var(--blue);text-shadow:0 0 24px rgba(56,192,248,0.5)}
.brand-ver{font-size:10px;color:var(--dim);letter-spacing:1px;margin-top:2px}
.header-right{display:flex;align-items:center;gap:20px}
.clock{font-size:14px;color:var(--cyan);letter-spacing:2px;font-weight:500;text-shadow:0 0 12px rgba(0,229,216,0.4)}
.session-badge{padding:4px 12px;border-radius:3px;font-size:11px;font-weight:700;letter-spacing:1px;font-family:'Barlow Condensed',sans-serif}
.s-asia{background:#003344;color:var(--cyan);border:1px solid var(--cyan)}
.s-london{background:#002a00;color:var(--green);border:1px solid var(--green)}
.s-ny{background:#330022;color:var(--purple);border:1px solid var(--purple)}
.s-outside{background:#1a1a1a;color:var(--dim);border:1px solid var(--border2)}
.btn-refresh{background:none;border:1px solid var(--border2);color:var(--dim);padding:5px 12px;border-radius:3px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:11px;transition:all .2s}
.btn-refresh:hover{color:var(--blue);border-color:var(--blue)}
.kpi-bar{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border2);overflow-x:auto}
.kpi{flex:1;min-width:120px;padding:12px 16px;background:var(--bg2);position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;width:100%;height:2px}
.kpi-open::after{background:var(--blue)} .kpi-ghosts::after{background:var(--purple)} .kpi-locks::after{background:var(--gold)} .kpi-balance::after{background:var(--green)} .kpi-session::after{background:var(--cyan)} .kpi-risk::after{background:var(--orange)}
.kpi-label{font-size:9px;letter-spacing:1.5px;color:var(--dim);text-transform:uppercase;margin-bottom:6px;font-family:'Barlow Condensed',sans-serif}
.kpi-val{font-size:20px;font-weight:700;line-height:1;font-family:'Barlow Condensed',sans-serif;letter-spacing:1px}
.kv-blue{color:var(--blue)} .kv-purple{color:var(--purple)} .kv-gold{color:var(--gold)} .kv-green{color:var(--green)} .kv-cyan{color:var(--cyan)} .kv-orange{color:var(--orange)}
.nav{display:flex;gap:2px;padding:8px 16px;background:var(--bg2);border-bottom:1px solid var(--border);overflow-x:auto;flex-wrap:nowrap}
.nav-tab{padding:5px 14px;border:1px solid var(--border);border-radius:3px;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;letter-spacing:.5px;color:var(--dim);background:none;transition:all .15s;white-space:nowrap}
.nav-tab:hover{color:var(--text);border-color:var(--border2)}
.nav-tab.active{background:var(--blue);color:#060b12;border-color:var(--blue)}
.nav-tab.active-ev{background:var(--gold);color:#060b12;border-color:var(--gold)}
.main{padding:16px 20px;overflow-y:auto}
.section{display:none}.section.active{display:block}
.card{background:var(--card);border:1px solid var(--border);border-radius:4px;margin-bottom:14px;overflow:hidden}
.card-head{padding:10px 16px;background:linear-gradient(90deg,#0d1828,#0c1520);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.card-title{font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;letter-spacing:1px;color:var(--blue)}
.card-title.gold{color:var(--gold)}.card-title.green{color:var(--green)}.card-title.purple{color:var(--purple)}.card-title.orange{color:var(--orange)}
.card-meta{font-size:10px;color:var(--dim);letter-spacing:.5px}
.card-body{overflow-x:auto;padding:0}
table{width:100%;border-collapse:collapse;font-size:11px}
th{padding:6px 10px;text-align:left;font-size:9px;letter-spacing:1.2px;color:var(--dim);background:var(--bg2);border-bottom:1px solid var(--border);text-transform:uppercase;font-family:'Barlow Condensed',sans-serif;font-weight:600;white-space:nowrap}
td{padding:6px 10px;border-bottom:1px solid var(--dim2);vertical-align:middle;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(56,192,248,0.04)}
.no-data{text-align:center;padding:24px;color:var(--dim);font-size:11px;letter-spacing:1px}
.c-green{color:var(--green)}.c-red{color:var(--red)}.c-gold{color:var(--gold)}.c-blue{color:var(--blue)}.c-dim{color:var(--dim)}.c-purple{color:var(--purple)}.c-cyan{color:var(--cyan)}.c-orange{color:var(--orange)}
.badge{display:inline-block;padding:2px 7px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.8px;font-family:'Barlow Condensed',sans-serif}
.b-buy{background:rgba(0,229,160,.15);color:var(--green);border:1px solid rgba(0,229,160,.3)}
.b-sell{background:rgba(255,61,90,.15);color:var(--red);border:1px solid rgba(255,61,90,.3)}
.b-above{background:rgba(56,192,248,.15);color:var(--blue);border:1px solid rgba(56,192,248,.3)}
.b-below{background:rgba(176,140,255,.15);color:var(--purple);border:1px solid rgba(176,140,255,.3)}
.b-sl{background:rgba(255,61,90,.2);color:var(--red)}.b-tp{background:rgba(0,229,160,.2);color:var(--green)}.b-manual{background:rgba(240,192,64,.15);color:var(--gold)}
.b-asia{background:rgba(0,229,216,.1);color:var(--cyan)}.b-london{background:rgba(0,229,160,.1);color:var(--green)}.b-ny{background:rgba(176,140,255,.1);color:var(--purple)}
.b-ghost{background:rgba(176,140,255,.2);color:var(--purple);border:1px solid rgba(176,140,255,.4)}
.b-locked{background:rgba(240,192,64,.2);color:var(--gold);border:1px solid rgba(240,192,64,.4)}
.b-default{background:rgba(74,96,128,.2);color:var(--dim);border:1px solid var(--border)}
.sl-bar-wrap{display:flex;align-items:center;gap:6px;min-width:90px}
.sl-bar-bg{height:4px;flex:1;background:var(--dim2);border-radius:2px;overflow:hidden}
.sl-bar-fill{height:100%;border-radius:2px;background:var(--green);transition:width .3s}
.sl-bar-fill.warn{background:var(--orange)}.sl-bar-fill.danger{background:var(--red)}
.matrix-wrap{overflow-x:auto;padding:0}
.matrix-table{min-width:900px;font-size:10px}
.matrix-table th.grp{background:var(--bg);border-right:1px solid var(--border2)}
.matrix-table td.cat-label{font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;color:var(--gold);background:var(--bg2);border-right:1px solid var(--border2);white-space:nowrap;min-width:160px;padding:8px 12px}
.matrix-table td.combo{text-align:center;padding:5px 6px;border-right:1px solid var(--dim2)}
.ev-pos{color:var(--green)}.ev-neg{color:var(--red)}.ev-zero{color:var(--dim)}
.col-session{text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:.5px;padding:6px 8px}
.type-stock{border-left:3px solid var(--blue)}.type-forex{border-left:3px solid var(--cyan)}.type-index{border-left:3px solid var(--gold)}.type-commodity{border-left:3px solid var(--orange)}
.cat-pill{display:inline-block;padding:1px 7px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.5px;font-family:'Barlow Condensed',sans-serif}
.cat-stock{background:rgba(56,192,248,.12);color:var(--blue)}.cat-forex{background:rgba(0,229,216,.12);color:var(--cyan)}.cat-index{background:rgba(240,192,64,.12);color:var(--gold)}.cat-commodity{background:rgba(255,140,66,.12);color:var(--orange)}
.pnl-pos{color:var(--green);font-weight:600}.pnl-neg{color:var(--red);font-weight:600}
.section-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:900px){.section-grid{grid-template-columns:1fr}}
.callout{background:rgba(56,192,248,.07);border:1px solid rgba(56,192,248,.2);border-radius:3px;padding:10px 14px;font-size:10px;color:var(--dim);margin-bottom:12px;letter-spacing:.3px}
.callout strong{color:var(--blue)}
.filter-row{display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center}
.filter-label{font-size:9px;color:var(--dim);letter-spacing:1px;text-transform:uppercase}
.filter-btn{padding:3px 10px;border:1px solid var(--border);background:none;color:var(--dim);border-radius:2px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10px;transition:all .15s}
.filter-btn.active{border-color:var(--blue);color:var(--blue);background:rgba(56,192,248,.08)}
.filter-btn:hover{color:var(--text)}
.ht-placed{color:var(--green)}.ht-closed{color:var(--blue)}.ht-rejected{color:var(--red)}.ht-error{color:var(--red)}.ht-ghost{color:var(--purple)}.ht-reset{color:var(--gold)}.ht-default{color:var(--dim)}
.lot-recalc{background:rgba(255,140,66,.1);border:1px solid rgba(255,140,66,.3);border-radius:3px;padding:10px 14px;font-size:10px;color:var(--orange);margin-bottom:12px}
.lot-recalc strong{color:var(--orange)}
</style>
</head>
<body>
<div class="layout">

<!-- HEADER -->
<div class="header">
  <div class="header-brand">
    <div>
      <div class="brand-logo">PRONTO-AI</div>
      <div class="brand-ver">v10.0 · TradingView → MetaApi → FTMO MT5 · Balance from MT5 · Fixed Risk ${(FIXED_RISK_PCT*100).toFixed(3)}%</div>
    </div>
  </div>
  <div class="header-right">
    <span class="session-badge s-outside" id="hdr-session">—</span>
    <span class="clock" id="clock">--:--:--</span>
    <button class="btn-refresh" onclick="loadAll()">↻ REFRESH</button>
  </div>
</div>

<!-- KPI BAR -->
<div class="kpi-bar">
  <div class="kpi kpi-balance"><div class="kpi-label">Live MT5 Balance</div><div class="kpi-val kv-green">€<span id="kpi-balance">${balance.toFixed(0)}</span></div></div>
  <div class="kpi kpi-open"><div class="kpi-label">Open Positions</div><div class="kpi-val kv-blue" id="kpi-open">—</div></div>
  <div class="kpi kpi-ghosts"><div class="kpi-label">Active Ghosts</div><div class="kpi-val kv-purple" id="kpi-ghosts">—</div></div>
  <div class="kpi kpi-locks"><div class="kpi-label">TP Locks (EV+)</div><div class="kpi-val kv-gold" id="kpi-locks">—</div></div>
  <div class="kpi kpi-session"><div class="kpi-label">Session</div><div class="kpi-val kv-cyan" id="kpi-session" style="font-size:15px;letter-spacing:2px">—</div></div>
  <div class="kpi kpi-risk"><div class="kpi-label">Fixed Risk/Trade</div><div class="kpi-val kv-orange">${(FIXED_RISK_PCT*100).toFixed(3)}%</div></div>
  <div class="kpi kpi-risk"><div class="kpi-label">Lot Overrides</div><div class="kpi-val kv-orange" id="kpi-lots">—</div></div>
</div>

<!-- NAV -->
<div class="nav">
  <button class="nav-tab active" onclick="showTab('positions',this)">📊 OPEN TRADES</button>
  <button class="nav-tab" onclick="showTab('ghosts',this)">👻 GHOSTS</button>
  <button class="nav-tab" onclick="showTab('ev',this)">📈 EV MATRIX</button>
  <button class="nav-tab" onclick="showTab('shadow',this)">🌑 SHADOW SL</button>
  <button class="nav-tab" onclick="showTab('history',this)">📋 HISTORY</button>
  <button class="nav-tab" onclick="showTab('closed',this)">🗂️ CLOSED</button>
  <button class="nav-tab" onclick="showTab('risk',this)">💰 RISK CONFIG</button>
  <button class="nav-tab" onclick="showTab('lots',this)">🔢 LOT RECALC</button>
</div>

<div class="main">

<!-- SECTION: OPEN POSITIONS -->
<div id="sec-positions" class="section active">
  <div class="callout"><strong>Open Trades</strong> — Balance from MT5 live. Risk fixed at ${(FIXED_RISK_PCT*100).toFixed(3)}% per trade. Spread = ask-bid shown at placement. EV+ keys show x multiplier.</div>
  <div class="card">
    <div class="card-head">
      <span class="card-title">📊 OPEN POSITIONS</span>
      <span class="card-meta" id="pos-count">Loading...</span>
    </div>
    <div class="card-body">
      <table>
        <thead><tr>
          <th>Symbol</th><th>Cat</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th>TV Entry</th><th>MT5 Entry</th><th>Spread</th><th>Slip%</th>
          <th>SL</th><th>SL Dist%</th><th>TP (RR)</th><th>SL Used%</th>
          <th>PnL</th><th>MaxRR</th><th>Risk%</th><th>Risk€</th><th>Mult</th><th>Ghost?</th>
        </tr></thead>
        <tbody id="pos-body"><tr><td colspan="19" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <div class="card-head">
      <span class="card-title green">🗂️ RECENT CLOSED (last 20)</span>
    </div>
    <div class="card-body">
      <table>
        <thead><tr>
          <th>Symbol</th><th>Cat</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th>Entry</th><th>SL</th><th>TP RR</th><th>MaxRR</th><th>Close</th><th>PnL</th><th>Closed</th>
        </tr></thead>
        <tbody id="recent-closed-body"><tr><td colspan="12" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- SECTION: GHOSTS -->
<div id="sec-ghosts" class="section">
  <div class="section-grid">
    <div class="card">
      <div class="card-head"><span class="card-title purple">👻 ACTIVE GHOSTS</span><span class="card-meta" id="ghost-count">—</span></div>
      <div class="card-body">
        <table>
          <thead><tr><th>Optimizer Key</th><th>Dir</th><th>Session</th><th>Entry</th><th>Phantom SL</th><th>Max Price</th><th>MaxRR</th><th>% SL Used</th><th>Elapsed</th></tr></thead>
          <tbody id="ghost-body"><tr><td colspan="9" class="no-data">No active ghosts</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><span class="card-title gold">📜 GHOST HISTORY (last 30)</span></div>
      <div class="card-body">
        <table>
          <thead><tr><th>Key</th><th>MaxRR</th><th>TP RR Used</th><th>SL Hit?</th><th>Reason</th><th>Time (min)</th><th>Closed</th></tr></thead>
          <tbody id="ghost-hist-body"><tr><td colspan="7" class="no-data">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- SECTION: EV MATRIX -->
<div id="sec-ev" class="section">
  <div class="callout"><strong>EV Matrix</strong> — Per symbol × session × direction × VWAP. <strong style="color:var(--gold)">★ = EV+ locked TP. EV+ keys get risk multiplier on consecutive positive days (max ×4).</strong></div>
  <div class="card">
    <div class="card-head"><span class="card-title">🔷 FOREX</span><span class="card-meta">AUDCAD · AUDCHF · AUDNZD · AUDUSD · CADCHF · EURAUD · EURCHF · EURUSD · GBPAUD · GBPNZD · GBPUSD · NZDCAD · NZDCHF · NZDUSD · USDCAD · USDCHF</span></div>
    <div class="matrix-wrap"><table class="matrix-table" id="ev-forex"></table></div>
  </div>
  <div class="card">
    <div class="card-head"><span class="card-title gold">📊 INDEXES</span><span class="card-meta">DAX40 (GER40) · NAS100 (US100) · UK100 (FTSE) · US30 (Dow)</span></div>
    <div class="matrix-wrap"><table class="matrix-table" id="ev-index"></table></div>
  </div>
  <div class="card">
    <div class="card-head"><span class="card-title orange">🥇 COMMODITIES — Gold (XAUUSD)</span></div>
    <div class="matrix-wrap"><table class="matrix-table" id="ev-commodity"></table></div>
  </div>
  <div class="card">
    <div class="card-head"><span class="card-title">📈 STOCKS</span><span class="card-meta">AAPL · AMD · AMZN · ARM · ASML · AVGO · BA · BABA · BAC · BRKB · CSCO · CVX · DIS · FDX · GE · GM · GME · GOOGL · IBM · INTC · JNJ · JPM · KO · LMT · MCD · META · MSFT · MSTR · NFLX · NKE · NVDA · PFE · PLTR · QCOM · SBUX · SNOW · T · TSLA · V · WMT · XOM · ZM</span></div>
    <div class="matrix-wrap"><table class="matrix-table" id="ev-stocks"></table></div>
  </div>
</div>

<!-- SECTION: SHADOW SL -->
<div id="sec-shadow" class="section">
  <div class="callout"><strong>Shadow SL Optimizer</strong> — READ ONLY. How far price moved toward SL (% used). p99 = recommended SL size. SL too wide if price never came within 70% of it.</div>
  <div class="card">
    <div class="card-head"><span class="card-title purple">🌑 SHADOW SL ANALYSIS — per Optimizer Key</span></div>
    <div class="card-body">
      <table>
        <thead><tr>
          <th>Optimizer Key</th><th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th>
          <th>Snapshots</th><th>Positions</th><th>p50 SL%</th><th>p90 SL%</th><th>p99 SL%</th><th>Max SL%</th>
          <th>Rec. SL%</th><th>Too Wide?</th><th>Saving%</th>
        </tr></thead>
        <tbody id="shadow-body"><tr><td colspan="14" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- SECTION: HISTORY -->
<div id="sec-history" class="section">
  <div class="card">
    <div class="card-head"><span class="card-title">📋 WEBHOOK HISTORY (last 100)</span></div>
    <div class="filter-row">
      <span class="filter-label">Filter:</span>
      <button class="filter-btn active" onclick="filterHistory('all',this)">All</button>
      <button class="filter-btn" onclick="filterHistory('ORDER_PLACED',this)">Placed</button>
      <button class="filter-btn" onclick="filterHistory('POSITION_CLOSED',this)">Closed</button>
      <button class="filter-btn" onclick="filterHistory('LOT_RECALC',this)">Lot Recalc</button>
      <button class="filter-btn" onclick="filterHistory('REJECTED',this)">Rejected</button>
      <button class="filter-btn" onclick="filterHistory('ERROR',this)">Errors</button>
    </div>
    <div class="card-body">
      <table>
        <thead><tr><th>Time</th><th>Type</th><th>Symbol</th><th>Cat</th><th>Dir</th><th>VWAP</th><th>Session</th><th>Optimizer Key</th><th>Detail</th></tr></thead>
        <tbody id="hist-body"><tr><td colspan="9" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- SECTION: CLOSED TRADES -->
<div id="sec-closed" class="section">
  <div class="card">
    <div class="card-head"><span class="card-title green">🗂️ CLOSED TRADES</span><span class="card-meta" id="closed-count">—</span></div>
    <div class="filter-row">
      <span class="filter-label">Session:</span>
      <button class="filter-btn active" onclick="filterClosed('session','all',this)">All</button>
      <button class="filter-btn" onclick="filterClosed('session','asia',this)">Asia</button>
      <button class="filter-btn" onclick="filterClosed('session','london',this)">London</button>
      <button class="filter-btn" onclick="filterClosed('session','ny',this)">NY</button>
      &nbsp;<span class="filter-label">Dir:</span>
      <button class="filter-btn active" onclick="filterClosed('dir','all',this)">All</button>
      <button class="filter-btn" onclick="filterClosed('dir','buy',this)">Buy</button>
      <button class="filter-btn" onclick="filterClosed('dir','sell',this)">Sell</button>
    </div>
    <div class="card-body">
      <table>
        <thead><tr>
          <th>Symbol</th><th>Cat</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th>Entry</th><th>SL</th><th>TP(RR)</th><th>Lots</th><th>Risk%</th>
          <th>MaxRR</th><th>Close</th><th>PnL</th><th>Opened</th><th>Closed</th>
        </tr></thead>
        <tbody id="closed-body"><tr><td colspan="15" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- SECTION: RISK CONFIG -->
<div id="sec-risk" class="section">
  <div class="callout">Fixed risk: <strong>${(FIXED_RISK_PCT*100).toFixed(3)}%</strong> per trade from live MT5 balance. Set <strong>RISK_EURUSD=0.002</strong> in Railway env to override per symbol. EV+ keys get multiplier (max ×4).</div>
  <div class="card">
    <div class="card-head"><span class="card-title gold">💰 PER-SYMBOL RISK CONFIG</span><span class="card-meta" id="risk-balance">—</span></div>
    <div class="filter-row">
      <span class="filter-label">Type:</span>
      <button class="filter-btn active" onclick="filterRisk('all',this)">All</button>
      <button class="filter-btn" onclick="filterRisk('forex',this)">Forex</button>
      <button class="filter-btn" onclick="filterRisk('index',this)">Index</button>
      <button class="filter-btn" onclick="filterRisk('commodity',this)">Commodity</button>
      <button class="filter-btn" onclick="filterRisk('stock',this)">Stocks</button>
    </div>
    <div class="card-body">
      <table>
        <thead><tr><th>Symbol</th><th>Type</th><th>Risk %</th><th>Risk € (live bal)</th><th>Risk Mult</th><th>Lot Override</th><th>Env Var</th></tr></thead>
        <tbody id="risk-body"><tr><td colspan="7" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- SECTION: LOT RECALC -->
<div id="sec-lots" class="section">
  <div class="lot-recalc">
    <strong>⚙️ Lot Recalculation</strong> — After every SL hit, the system recalculates optimal lots for that symbol based on live balance × risk% ÷ SL distance × lot value. Set the values below as Railway environment variables to persist across restarts.
  </div>
  <div class="card">
    <div class="card-head"><span class="card-title orange">🔢 LOT OVERRIDES — Set in Railway</span><span class="card-meta" id="lots-count">—</span></div>
    <div class="card-body">
      <table>
        <thead><tr><th>Symbol</th><th>Optimal Lots</th><th>Railway Env Var</th><th>Risk %</th><th>Instruction</th></tr></thead>
        <tbody id="lots-body"><tr><td colspan="5" class="no-data">No SL recalculations yet</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

</div><!-- /main -->
</div><!-- /layout -->

<script>
let _historyData=[],_closedData=[],_riskData=[],_lotsData=[];
let _closedFilter={session:'all',dir:'all'},_histFilter='all',_riskFilter='all';
let _evData=[];

function fmt(v,d=2){return v!=null&&!isNaN(v)?Number(v).toFixed(d):'—'}
function fmtPct(v){return v!=null?(v*100).toFixed(3)+'%':'—'}
function fmtN(v){return v!=null?Number(v).toLocaleString('nl-BE'):'—'}

async function sf(url){try{const r=await fetch(url,{cache:'no-store'});return r.ok?r.json():null}catch{return null}}

function catPill(type){if(!type)return '';return '<span class="cat-pill cat-'+type+'">'+type.toUpperCase()+'</span>'}

function symType(symbol){
  const F=['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
  const I=['DE30EUR','NAS100USD','UK100GBP','US30USD'];
  const C=['XAUUSD'];
  if(F.includes(symbol))return 'forex';
  if(I.includes(symbol))return 'index';
  if(C.includes(symbol))return 'commodity';
  return 'stock';
}

function slBar(pct){
  if(pct==null)return '—';
  const cls=pct>=80?'danger':pct>=50?'warn':'';
  return '<div class="sl-bar-wrap"><div class="sl-bar-bg"><div class="sl-bar-fill '+cls+'" style="width:'+Math.min(100,pct)+'%"></div></div><span>'+(+pct).toFixed(0)+'%</span></div>';
}
function sessionBadge(s){const m={asia:'b-asia',london:'b-london',ny:'b-ny'};return '<span class="badge '+(m[s]||'b-default')+'">'+(s||'—').toUpperCase()+'</span>'}
function closeReasonBadge(r){const m={tp:'b-tp',sl:'b-sl',manual:'b-manual'};return '<span class="badge '+(m[r]||'b-default')+'">'+(r||'—').toUpperCase()+'</span>'}
function histType(t){
  if(!t)return '<span class="ht-default">—</span>';
  const m={'ORDER_PLACED':'ht-placed','POSITION_CLOSED':'ht-closed','LOT_RECALC':'ht-ghost','REJECTED':'ht-rejected','ERROR':'ht-error','DAILY_RESET':'ht-reset','NIGHTLY_OPTIMIZER':'ht-reset','DUPLICATE_BLOCKED':'ht-ghost'};
  const cls=Object.keys(m).find(k=>t.includes(k));
  return '<span class="'+(m[cls]||'ht-default')+'">'+t+'</span>';
}
function shortTs(iso){if(!iso)return '—';const d=new Date(iso);return d.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function shortDate(iso){if(!iso)return '—';return new Date(iso).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit'})}

function showTab(name,el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active','active-ev'));
  document.getElementById('sec-'+name).classList.add('active');
  if(el)el.classList.add(name==='ev'?'active-ev':'active');
  loadSection(name);
}

async function loadSection(name){
  if(name==='positions'){await loadPositions();await loadRecentClosed();}
  if(name==='ghosts'){await loadGhosts();await loadGhostHistory();}
  if(name==='ev')await loadEV();
  if(name==='shadow')await loadShadow();
  if(name==='history')await loadHistory();
  if(name==='closed')await loadClosed();
  if(name==='risk')await loadRisk();
  if(name==='lots')await loadLots();
}

// ── POSITIONS ────────────────────────────────────────────────────
async function loadPositions(){
  const d=await sf('/live/positions');if(!d)return;
  document.getElementById('kpi-open').textContent=d.count;
  document.getElementById('kpi-balance').textContent=(d.balance||0).toFixed(0);
  document.getElementById('pos-count').textContent=d.count+' open';
  const evAll=await sf('/ev')||[];
  const b=document.getElementById('pos-body');
  if(!d.positions.length){b.innerHTML='<tr><td colspan="19" class="no-data">No open positions</td></tr>';return;}
  b.innerHTML=d.positions.map(p=>{
    const t=symType(p.symbol);
    const ev=evAll.find(e=>e.key===p.optimizerKey);
    const slip=(p.tvEntry&&p.entry)?((Math.abs(p.entry-p.tvEntry)/p.tvEntry)*100).toFixed(3)+'%':'—';
    const pnlCls=(p.currentPnL||0)>=0?'pnl-pos':'pnl-neg';
    const multCls=p.riskMult>1?'c-green':'c-dim';
    return \`<tr class="type-\${t}">
      <td class="c-blue" style="font-weight:600">\${p.symbol}</td>
      <td>\${catPill(t)}</td>
      <td><span class="badge b-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
      <td><span class="badge b-\${p.vwapPosition}">\${p.vwapPosition}</span></td>
      <td>\${sessionBadge(p.session)}</td>
      <td class="c-dim">\${p.tvEntry?fmt(p.tvEntry,5):'—'}</td>
      <td>\${fmt(p.entry,5)}</td>
      <td class="c-orange">\${p.spread?p.spread.toFixed(5):'—'}</td>
      <td class="c-dim">\${slip}</td>
      <td class="c-red">\${fmt(p.sl,5)}</td>
      <td class="c-dim">\${p.slDistPct!=null?p.slDistPct+'%':'—'}</td>
      <td class="c-green">\${fmt(p.tp,5)} <span class="c-gold">(\${p.tpRR||'—'}R)</span></td>
      <td>\${slBar(p.slPctUsed)}</td>
      <td class="\${pnlCls}">\${fmt(p.currentPnL,2)}€</td>
      <td class="c-cyan">\${fmt(p.maxRR,2)}R</td>
      <td class="c-gold">\${fmtPct(p.riskPct)}</td>
      <td class="c-green">€\${p.riskEUR?p.riskEUR.toFixed(2):'—'}</td>
      <td class="\${multCls}">x\${(p.riskMult||1).toFixed(2)}</td>
      <td>\${p.isGhosted?'<span class="badge b-ghost">👻</span>':'<span class="c-dim">—</span>'}</td>
    </tr>\`;
  }).join('');
}

async function loadRecentClosed(){
  const d=await sf('/trades?limit=20');if(!d)return;
  const b=document.getElementById('recent-closed-body');
  if(!d.trades.length){b.innerHTML='<tr><td colspan="12" class="no-data">No closed trades</td></tr>';return;}
  b.innerHTML=d.trades.map(h=>{
    const t=symType(h.symbol);
    const pnlCls=(h.currentPnL||0)>=0?'pnl-pos':'pnl-neg';
    return \`<tr class="type-\${t}">
      <td class="c-blue">\${h.symbol}</td><td>\${catPill(t)}</td>
      <td><span class="badge b-\${h.direction}">\${h.direction?.toUpperCase()}</span></td>
      <td><span class="badge b-\${h.vwapPosition||'unknown'}">\${h.vwapPosition||'?'}</span></td>
      <td>\${sessionBadge(h.session)}</td>
      <td>\${fmt(h.entry,5)}</td><td class="c-red">\${fmt(h.sl,5)}</td>
      <td class="c-gold">\${h.tpRRUsed||'—'}R</td>
      <td class="c-cyan">\${fmt(h.maxRR,2)}R</td>
      <td>\${closeReasonBadge(h.closeReason)}</td>
      <td class="\${pnlCls}">\${fmt(h.currentPnL,2)}€</td>
      <td class="c-dim">\${shortDate(h.closedAt)} \${shortTs(h.closedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── GHOSTS ───────────────────────────────────────────────────────
async function loadGhosts(){
  const d=await sf('/live/ghosts');if(!d)return;
  document.getElementById('kpi-ghosts').textContent=d.count;
  document.getElementById('ghost-count').textContent=d.count+' active';
  const b=document.getElementById('ghost-body');
  if(!d.ghosts.length){b.innerHTML='<tr><td colspan="9" class="no-data">No active ghosts</td></tr>';return;}
  b.innerHTML=d.ghosts.map(g=>{
    const maxUsedRaw=g.entry&&g.sl&&g.maxPrice?(Math.abs(g.entry-g.maxPrice)/Math.abs(g.entry-g.sl)*100):null;
    return \`<tr>
      <td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
      <td><span class="badge b-\${g.direction}">\${g.direction?.toUpperCase()}</span></td>
      <td>\${sessionBadge(g.session)}</td>
      <td>\${fmt(g.entry,5)}</td><td class="c-red">\${fmt(g.sl,5)}</td>
      <td>\${fmt(g.maxPrice,5)}</td><td class="c-cyan">\${fmt(g.maxRR,2)}R</td>
      <td>\${slBar(maxUsedRaw)}</td>
      <td class="c-dim">\${g.elapsedMin}m</td>
    </tr>\`;
  }).join('');
}

async function loadGhostHistory(){
  const d=await sf('/ghosts/history?limit=30');if(!d)return;
  const b=document.getElementById('ghost-hist-body');
  if(!d.rows.length){b.innerHTML='<tr><td colspan="7" class="no-data">No ghost history</td></tr>';return;}
  b.innerHTML=d.rows.map(g=>\`<tr>
    <td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
    <td class="c-cyan">\${fmt(g.maxRRBeforeSL,2)}R</td>
    <td class="c-gold">\${fmt(g.tpRRUsed,1)}R</td>
    <td>\${g.phantomSLHit?'<span class="c-red">✓ SL</span>':'<span class="c-dim">—</span>'}</td>
    <td class="c-dim">\${g.stopReason||'—'}</td>
    <td class="c-dim">\${g.timeToSLMin!=null?g.timeToSLMin+'m':'—'}</td>
    <td class="c-dim" style="font-size:9px">\${shortDate(g.closedAt)} \${shortTs(g.closedAt)}</td>
  </tr>\`).join('');
}

// ── EV MATRIX ────────────────────────────────────────────────────
const SESSIONS_M=['asia','london','ny'];
const DIRS_M=['buy','sell'];
const VWAPS_M=['above','below'];

async function loadEV(){
  const d=await sf('/ev');if(!d)return;
  _evData=d;
  document.getElementById('kpi-locks').textContent=d.filter(x=>(x.count||0)>=5&&(x.bestEV||0)>0).length;
  const FOREX=['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
  const INDEX=['DE30EUR','NAS100USD','UK100GBP','US30USD'];
  const COMM=['XAUUSD'];
  const STOCKS=['AAPL','AMD','AMZN','ARM','ASML','AVGO','AZN','BA','BABA','BAC','BRKB','CSCO','CVX','DIS','FDX','GE','GM','GME','GOOGL','IBM','INTC','JNJ','JPM','KO','LMT','MCD','META','MSFT','MSTR','NFLX','NKE','NVDA','PFE','PLTR','QCOM','SBUX','SNOW','T','TSLA','V','WMT','XOM','ZM'];

  function renderMatrix(symbols,tableId,displayNames){
    const el=document.getElementById(tableId);if(!el)return;
    const lookup={};for(const ev of _evData)lookup[ev.key]=ev;
    let thead='<thead><tr><th class="grp" style="min-width:150px;position:sticky;left:0;z-index:2">Symbol</th>';
    for(const s of SESSIONS_M){const lbl={asia:'🌏 ASIA',london:'🇬🇧 LONDON',ny:'🇺🇸 NY'}[s];thead+=\`<th colspan="4" class="col-session" style="border-left:1px solid var(--border2);background:var(--bg2)">\${lbl}</th>\`;}
    thead+='</tr><tr><th class="grp" style="position:sticky;left:0;z-index:2;background:var(--bg2)">↳ bestRR / EV / n</th>';
    for(const s of SESSIONS_M)for(const dr of DIRS_M){const dc=dr==='buy'?'c-green':'c-red';for(const vw of VWAPS_M){const vc=vw==='above'?'c-blue':'c-purple';thead+=\`<th style="text-align:center;font-size:9px;border-left:\${vw==='above'?'1px solid var(--border2)':'none'}"><span class="\${dc}">\${dr.toUpperCase()}</span><br><span class="\${vc}" style="font-size:8px">\${vw}</span></th>\`;}}
    thead+='</tr></thead>';
    let tbody='<tbody>';
    for(const sym of symbols){
      const label=(displayNames&&displayNames[sym])?displayNames[sym]:sym;
      tbody+=\`<tr><td class="cat-label" style="position:sticky;left:0;z-index:1">\${label}</td>\`;
      for(const s of SESSIONS_M)for(const dr of DIRS_M)for(const vw of VWAPS_M){
        const key=sym+'_'+s+'_'+dr+'_'+vw;
        const ev=lookup[key];
        const bl=vw==='above'?'border-left:1px solid var(--border2);':'';
        if(!ev||!ev.count){tbody+=\`<td class="combo" style="\${bl}"><span class="c-dim" style="font-size:9px">—</span></td>\`;}
        else{
          const evPos=(ev.bestEV||0)>0,evNeg=(ev.bestEV||0)<0;
          const evCls=evPos?'ev-pos':evNeg?'ev-neg':'ev-zero';
          const locked=ev.count>=5&&evPos;
          const bg=locked?'background:rgba(240,192,64,0.07);':'';
          tbody+=\`<td class="combo" style="\${bl}\${bg}"><div style="font-size:12px;font-family:'Barlow Condensed';font-weight:700" class="\${evCls}">\${ev.bestRR!=null?fmt(ev.bestRR,1)+'R':'—'}</div><div style="font-size:10px;font-weight:600" class="\${evCls}">\${ev.bestEV!=null?fmt(ev.bestEV,3):'—'}</div><div style="font-size:9px;color:var(--dim)">n=\${ev.count||0}\${locked?'<span class="c-gold"> ★</span>':''}</div></td>\`;
        }
      }
      tbody+='</tr>';
    }
    tbody+='</tbody>';
    el.innerHTML=thead+tbody;
  }

  renderMatrix(FOREX,'ev-forex',null);
  renderMatrix(INDEX,'ev-index',{DE30EUR:'DAX40 (GER40)',NAS100USD:'NAS100 (US100)',UK100GBP:'UK100 (FTSE)',US30USD:'US30 (Dow)'});
  renderMatrix(COMM,'ev-commodity',{XAUUSD:'Gold (XAUUSD)'});
  renderMatrix(STOCKS,'ev-stocks',null);
}

// ── SHADOW ───────────────────────────────────────────────────────
async function loadShadow(){
  const d=await sf('/shadow');if(!d)return;
  const b=document.getElementById('shadow-body');
  if(!d.results.length){b.innerHTML='<tr><td colspan="14" class="no-data">No shadow data yet</td></tr>';return;}
  b.innerHTML=d.results.map(s=>\`<tr>
    <td style="font-size:9px;color:var(--dim)">\${s.optimizerKey}</td>
    <td class="c-blue">\${s.symbol||'—'}</td>
    <td>\${sessionBadge(s.session)}</td>
    <td><span class="badge b-\${s.direction}">\${(s.direction||'').toUpperCase()}</span></td>
    <td><span class="badge b-\${s.vwapPosition||'unknown'}">\${s.vwapPosition||'?'}</span></td>
    <td>\${fmtN(s.snapshotsCount)}</td><td>\${fmtN(s.positionsCount)}</td>
    <td>\${fmt(s.p50,1)}%</td><td>\${fmt(s.p90,1)}%</td>
    <td class="c-gold">\${fmt(s.p99,1)}%</td><td class="c-red">\${fmt(s.maxUsed,1)}%</td>
    <td class="c-cyan">\${s.recommendedSlPct!=null?(s.recommendedSlPct*100).toFixed(0)+'%':'—'}</td>
    <td>\${s.currentSlTooWide?'<span class="c-red">⚠ TOO WIDE</span>':'<span class="c-green">OK</span>'}</td>
    <td class="c-gold">\${s.potentialSavingPct!=null?s.potentialSavingPct+'%':'—'}</td>
  </tr>\`).join('');
}

// ── HISTORY ──────────────────────────────────────────────────────
async function loadHistory(){const d=await sf('/history');if(!d)return;_historyData=d;renderHistory();}
function filterHistory(f,el){_histFilter=f;document.querySelectorAll('#sec-history .filter-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');renderHistory();}
function renderHistory(){
  const data=_histFilter==='all'?_historyData:_historyData.filter(h=>(h.type||'').includes(_histFilter));
  const b=document.getElementById('hist-body');
  if(!data.length){b.innerHTML='<tr><td colspan="9" class="no-data">No events</td></tr>';return;}
  b.innerHTML=data.slice(0,100).map(h=>{
    const t=symType(h.symbol||'');
    return \`<tr>
      <td class="c-dim">\${shortTs(h.ts)}</td>
      <td>\${histType(h.type)}</td>
      <td class="c-blue">\${h.symbol||'—'}</td>
      <td>\${catPill(t)}</td>
      <td>\${h.direction?'<span class="badge b-'+h.direction+'">'+h.direction.toUpperCase()+'</span>':'—'}</td>
      <td>\${h.vwapPosition?'<span class="badge b-'+h.vwapPosition+'">'+h.vwapPosition+'</span>':'—'}</td>
      <td>\${sessionBadge(h.session)}</td>
      <td style="font-size:9px;color:var(--dim);max-width:180px;overflow:hidden;text-overflow:ellipsis">\${h.optimizerKey||h.envVar||'—'}</td>
      <td style="font-size:9px;color:var(--dim)">\${h.reason||h.optimalLots!=null?'lots='+h.optimalLots:'—'}</td>
    </tr>\`;
  }).join('');
}

// ── CLOSED TRADES ────────────────────────────────────────────────
async function loadClosed(){
  const d=await sf('/trades?limit=200');if(!d)return;
  _closedData=d.trades||[];
  document.getElementById('closed-count').textContent=d.count+' trades';
  renderClosed();
}
function filterClosed(type,val,el){
  _closedFilter[type]=val;
  el.parentElement.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  renderClosed();
}
function renderClosed(){
  let data=_closedData;
  if(_closedFilter.session!=='all')data=data.filter(t=>t.session===_closedFilter.session);
  if(_closedFilter.dir!=='all')data=data.filter(t=>t.direction===_closedFilter.dir);
  const b=document.getElementById('closed-body');
  if(!data.length){b.innerHTML='<tr><td colspan="15" class="no-data">No trades</td></tr>';return;}
  b.innerHTML=data.map(h=>{
    const t=symType(h.symbol);
    const pnlCls=(h.currentPnL||0)>=0?'pnl-pos':'pnl-neg';
    return \`<tr class="type-\${t}">
      <td class="c-blue" style="font-weight:600">\${h.symbol}</td>
      <td>\${catPill(t)}</td>
      <td><span class="badge b-\${h.direction}">\${h.direction?.toUpperCase()}</span></td>
      <td><span class="badge b-\${h.vwapPosition||'unknown'}">\${h.vwapPosition||'?'}</span></td>
      <td>\${sessionBadge(h.session)}</td>
      <td>\${fmt(h.entry,5)}</td><td class="c-red">\${fmt(h.sl,5)}</td>
      <td class="c-gold">\${h.tpRRUsed||'—'}R</td>
      <td>\${fmt(h.lots,2)}</td>
      <td class="c-gold">\${fmtPct(h.riskPct)}</td>
      <td class="c-cyan">\${fmt(h.maxRR,2)}R</td>
      <td>\${closeReasonBadge(h.closeReason)}</td>
      <td class="\${pnlCls}">\${fmt(h.currentPnL,2)}€</td>
      <td class="c-dim">\${shortDate(h.openedAt)}</td>
      <td class="c-dim">\${shortDate(h.closedAt)} \${shortTs(h.closedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── RISK CONFIG ──────────────────────────────────────────────────
async function loadRisk(){
  const d=await sf('/risk-config');if(!d)return;
  _riskData=d.config||[];
  document.getElementById('risk-balance').textContent='Live Balance: €'+(d.balance||0).toLocaleString('nl-BE')+' | Fixed Risk: '+(d.fixedRiskPct*100).toFixed(3)+'%';
  renderRisk();
}
function filterRisk(f,el){_riskFilter=f;document.querySelectorAll('#sec-risk .filter-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');renderRisk();}
function renderRisk(){
  let data=_riskData;
  if(_riskFilter!=='all')data=data.filter(r=>r.type===_riskFilter);
  const b=document.getElementById('risk-body');
  b.innerHTML=data.map(c=>\`<tr>
    <td class="c-blue">\${c.symbol}</td>
    <td>\${catPill(c.type)}</td>
    <td class="c-gold">\${(c.riskPct*100).toFixed(3)}%</td>
    <td class="c-green">€\${c.riskEUR}</td>
    <td class="\${c.riskMult>1?'c-green':'c-dim'}">x\${(c.riskMult||1).toFixed(2)}</td>
    <td class="c-orange">\${c.lotOverride!=null?c.lotOverride:'—'}</td>
    <td style="font-size:9px;color:var(--dim)">\${c.envVar}</td>
  </tr>\`).join('');
}

// ── LOT OVERRIDES ────────────────────────────────────────────────
async function loadLots(){
  const d=await sf('/lot-overrides');if(!d)return;
  document.getElementById('kpi-lots').textContent=d.count;
  document.getElementById('lots-count').textContent=d.count+' symbols';
  const b=document.getElementById('lots-body');
  if(!d.overrides.length){b.innerHTML='<tr><td colspan="5" class="no-data">No SL hits yet — lot overrides will appear here after first SL</td></tr>';return;}
  b.innerHTML=d.overrides.map(o=>\`<tr>
    <td class="c-blue" style="font-weight:600">\${o.symbol}</td>
    <td class="c-gold" style="font-size:14px;font-weight:700">\${o.lots}</td>
    <td class="c-orange">\${o.envVar}=\${o.lots}</td>
    <td class="c-dim">\${(o.riskPct*100).toFixed(3)}%</td>
    <td style="font-size:10px;color:var(--dim)">\${o.instruction}</td>
  </tr>\`).join('');
}

// ── CLOCK & SESSION ──────────────────────────────────────────────
function updateClock(){
  const d=new Date().toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('clock').textContent=d;
}
setInterval(updateClock,1000);updateClock();

// ── GLOBAL LOAD ──────────────────────────────────────────────────
async function loadAll(){
  const h=await sf('/health');
  if(h){
    const s=h.session||'outside';
    document.getElementById('kpi-session').textContent=s.toUpperCase();
    document.getElementById('kpi-balance').textContent=(h.balance||0).toFixed(0);
    document.getElementById('kpi-lots').textContent=h.lotOverrides||0;
    const hdrBadge=document.getElementById('hdr-session');
    hdrBadge.className='session-badge s-'+s;
    hdrBadge.textContent={asia:'⛩ ASIA',london:'🇬🇧 LONDON',ny:'🇺🇸 NEW YORK',outside:'⏸ OUTSIDE'}[s]||s.toUpperCase();
  }
  const active=document.querySelector('.section.active')?.id?.replace('sec-','');
  if(active)await loadSection(active);
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

  console.log("🚀 PRONTO-AI v10.0 starting...");
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
    console.log(`[✓] PRONTO-AI v10.0 on port ${PORT}`);
    console.log(`   🔹 Dashboard:      / or /dashboard`);
    console.log(`   🔹 Health:         /health`);
    console.log(`   🔹 EV Table:       /ev`);
    console.log(`   🔹 Shadow SL:      /shadow`);
    console.log(`   🔹 TP Locks:       /tp-locks`);
    console.log(`   🔹 Risk Config:    /risk-config`);
    console.log(`   🔹 Lot Overrides:  /lot-overrides`);
    console.log(`   🔹 Risk Mults:     /risk-multipliers`);
    console.log(`   🔹 Webhook:        POST /webhook?secret=<secret>`);
    console.log(`   💵 Fixed risk:     ${(FIXED_RISK_PCT*100).toFixed(3)}% | Balance: €${liveBalance.toFixed(2)}`);
  });
}

start().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
