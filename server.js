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

  // Symbol catalogs
  const FOREX_SYMBOLS    = ["AUDCAD","AUDCHF","AUDNZD","AUDUSD","CADCHF","EURAUD","EURCHF","EURUSD","GBPAUD","GBPNZD","GBPUSD","NZDCAD","NZDCHF","NZDUSD","USDCAD","USDCHF"];
  const INDEX_SYMBOLS    = ["DE30EUR","NAS100USD","UK100GBP","US30USD"];
  const COMMODITY_SYMBOLS= ["XAUUSD"];
  const STOCK_SYMBOLS    = ["AAPL","AMD","AMZN","ARM","ASML","AVGO","AZN","BA","BABA","BAC","BRKB","CSCO","CVX","DIS","FDX","GE","GM","GME","GOOGL","IBM","INTC","JNJ","JPM","KO","LMT","MCD","META","MSFT","MSTR","NFLX","NKE","NVDA","PFE","PLTR","QCOM","SBUX","SNOW","T","TSLA","V","WMT","XOM","ZM"];

  res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v10.0 — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#080c10;--bg2:#0c1117;--card:#0f151c;--border:#1a2535;--border2:#243348;--text:#c8d8e8;--dim:#4a6080;--dim2:#2a3d55;--green:#00e5a0;--red:#ff3d5a;--gold:#f0c040;--purple:#b08cff;--blue:#38c0f8;--cyan:#00e5d8;--orange:#ff8c42}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;width:100%;height:100%;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.1) 2px,rgba(0,0,0,0.1) 4px);pointer-events:none;z-index:9999;opacity:.25}

/* ── Header ── */
.header{padding:11px 20px;background:linear-gradient(90deg,#080e18,#0d1828);border-bottom:1px solid var(--border2);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;backdrop-filter:blur(10px)}
.brand-logo{font-family:'Barlow Condensed',sans-serif;font-size:21px;font-weight:800;letter-spacing:2px;color:var(--blue);text-shadow:0 0 20px rgba(56,192,248,.5)}
.brand-ver{font-size:9px;color:var(--dim);letter-spacing:1px;margin-top:1px}
.header-right{display:flex;align-items:center;gap:14px}
.clock{font-size:14px;color:var(--cyan);letter-spacing:2px;font-weight:500}
.session-badge{padding:3px 11px;border-radius:3px;font-size:11px;font-weight:700;letter-spacing:1px;font-family:'Barlow Condensed',sans-serif}
.s-asia{background:#003344;color:var(--cyan);border:1px solid var(--cyan)}.s-london{background:#002a00;color:var(--green);border:1px solid var(--green)}.s-ny{background:#330022;color:var(--purple);border:1px solid var(--purple)}.s-outside{background:#1a1a1a;color:var(--dim);border:1px solid var(--border2)}
.btn-sm{background:none;border:1px solid var(--border2);color:var(--dim);padding:4px 11px;border-radius:3px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10px;transition:all .2s}
.btn-sm:hover{color:var(--blue);border-color:var(--blue)}

/* ── KPI bar ── */
.kpi-bar{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border2);overflow-x:auto}
.kpi{flex:1;min-width:100px;padding:9px 13px;background:var(--bg2);position:relative}
.kpi::after{content:'';position:absolute;bottom:0;left:0;width:100%;height:2px}
.kpi-bal::after{background:var(--green)}.kpi-pos::after{background:var(--blue)}.kpi-gh::after{background:var(--purple)}.kpi-tp::after{background:var(--gold)}.kpi-sess::after{background:var(--cyan)}.kpi-risk::after{background:var(--orange)}.kpi-err::after{background:var(--red)}
.kpi-label{font-size:9px;letter-spacing:1.4px;color:var(--dim);text-transform:uppercase;margin-bottom:4px;font-family:'Barlow Condensed',sans-serif}
.kpi-val{font-size:18px;font-weight:700;line-height:1;font-family:'Barlow Condensed',sans-serif;letter-spacing:1px}
.kv-g{color:var(--green)}.kv-b{color:var(--blue)}.kv-p{color:var(--purple)}.kv-gd{color:var(--gold)}.kv-c{color:var(--cyan)}.kv-o{color:var(--orange)}.kv-r{color:var(--red)}

/* ── Page layout ── */
.page{padding:14px 18px;max-width:100%}
.section{margin-bottom:20px}
.sec-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:linear-gradient(90deg,#0d1828,#0a1218);border:1px solid var(--border2);border-radius:4px 4px 0 0;cursor:pointer;user-select:none}
.sec-title{font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;letter-spacing:1px}
.sec-meta{font-size:10px;color:var(--dim)}
.sec-body{border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;overflow:hidden;background:var(--card)}
.sec-collapsed .sec-body{display:none}
.collapse-icon{font-size:11px;color:var(--dim);transition:transform .2s}
.sec-collapsed .collapse-icon{transform:rotate(-90deg)}

/* ── Tables ── */
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:11px}
th{padding:6px 9px;text-align:left;font-size:9px;letter-spacing:1.2px;color:var(--dim);background:var(--bg2);border-bottom:1px solid var(--border);text-transform:uppercase;font-family:'Barlow Condensed',sans-serif;font-weight:600;white-space:nowrap;user-select:none}
th.srt{cursor:pointer}th.srt:hover{color:var(--text)}
th.asc::after{content:' ↑';color:var(--blue)}th.desc::after{content:' ↓';color:var(--blue)}
td{padding:5px 9px;border-bottom:1px solid var(--dim2);vertical-align:middle;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(56,192,248,.035)}
tr.zero-row td{opacity:.3}
tr.zero-row:hover td{opacity:.55}
tr.err-row td{background:rgba(255,61,90,.03)}
.no-data{text-align:center;padding:20px;color:var(--dim);font-size:11px;letter-spacing:1px}

/* ── Filter bar ── */
.filter-bar{display:flex;flex-wrap:wrap;gap:5px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--bg2);align-items:center}
.fl{font-size:9px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;margin-right:1px}
.fb{padding:2px 9px;border:1px solid var(--border);background:none;color:var(--dim);border-radius:2px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10px;transition:all .15s}
.fb.on{border-color:var(--blue);color:var(--blue);background:rgba(56,192,248,.08)}
.fb:hover{color:var(--text)}
.sym-input{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 8px;border-radius:2px;font-family:'JetBrains Mono',monospace;font-size:10px;width:110px}
.sym-input:focus{outline:none;border-color:var(--blue)}
.sym-input::placeholder{color:var(--dim)}

/* ── Stats row ── */
.stats-row{display:flex;flex-wrap:wrap;gap:16px;padding:8px 12px;border-bottom:1px solid var(--border);background:rgba(56,192,248,.03);font-size:10px;color:var(--dim)}
.stats-row span{color:var(--text);font-weight:600}

/* ── Badges ── */
.badge{display:inline-block;padding:2px 6px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.8px;font-family:'Barlow Condensed',sans-serif}
.b-buy{background:rgba(0,229,160,.15);color:var(--green);border:1px solid rgba(0,229,160,.3)}
.b-sell{background:rgba(255,61,90,.15);color:var(--red);border:1px solid rgba(255,61,90,.3)}
.b-above{background:rgba(56,192,248,.15);color:var(--blue);border:1px solid rgba(56,192,248,.3)}
.b-below{background:rgba(176,140,255,.15);color:var(--purple);border:1px solid rgba(176,140,255,.3)}
.b-unknown{background:rgba(74,96,128,.15);color:var(--dim);border:1px solid var(--border)}
.b-sl{background:rgba(255,61,90,.2);color:var(--red)}.b-tp{background:rgba(0,229,160,.2);color:var(--green)}.b-manual{background:rgba(240,192,64,.15);color:var(--gold)}
.b-asia{background:rgba(0,229,216,.12);color:var(--cyan)}.b-london{background:rgba(0,229,160,.12);color:var(--green)}.b-ny{background:rgba(176,140,255,.12);color:var(--purple)}
.b-outside{background:rgba(74,96,128,.12);color:var(--dim)}
.b-ghost{background:rgba(176,140,255,.2);color:var(--purple);border:1px solid rgba(176,140,255,.4)}
.b-evpos{background:rgba(0,229,160,.2);color:var(--green);border:1px solid rgba(0,229,160,.3)}
.b-evneg{background:rgba(255,61,90,.2);color:var(--red);border:1px solid rgba(255,61,90,.3)}
.b-err{background:rgba(255,61,90,.2);color:var(--red);border:1px solid rgba(255,61,90,.4);font-size:8px;padding:1px 4px}
.b-placed{background:rgba(0,229,160,.15);color:var(--green)}.b-closed{background:rgba(56,192,248,.12);color:var(--blue)}.b-rejected{background:rgba(255,61,90,.15);color:var(--red)}.b-error{background:rgba(255,61,90,.2);color:var(--red)}.b-default{background:rgba(74,96,128,.2);color:var(--dim);border:1px solid var(--border)}

/* ── Cat pills ── */
.cat{display:inline-block;padding:1px 5px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.5px;font-family:'Barlow Condensed',sans-serif}
.cat-stock{background:rgba(56,192,248,.12);color:var(--blue)}.cat-forex{background:rgba(0,229,216,.12);color:var(--cyan)}.cat-index{background:rgba(240,192,64,.12);color:var(--gold)}.cat-commodity{background:rgba(255,140,66,.12);color:var(--orange)}

/* ── SL bar ── */
.slb{display:flex;align-items:center;gap:5px;min-width:75px}
.slb-bg{height:4px;flex:1;background:var(--dim2);border-radius:2px;overflow:hidden}
.slb-fill{height:100%;border-radius:2px;background:var(--green)}
.slb-fill.w{background:var(--orange)}.slb-fill.d{background:var(--red)}

/* ── Colors ── */
.cg{color:var(--green)}.cr{color:var(--red)}.cgd{color:var(--gold)}.cb{color:var(--blue)}.cd{color:var(--dim)}.cp{color:var(--purple)}.cc{color:var(--cyan)}.co{color:var(--orange)}
.pnl+{color:var(--green);font-weight:600}.pnl-neg{color:var(--red);font-weight:600}
.fw{font-weight:700}

/* ── Type borders ── */
tr.t-stock{border-left:2px solid rgba(56,192,248,.25)}tr.t-forex{border-left:2px solid rgba(0,229,216,.25)}tr.t-index{border-left:2px solid rgba(240,192,64,.25)}tr.t-commodity{border-left:2px solid rgba(255,140,66,.25)}

/* ── EV matrix ── */
.mx-wrap{overflow-x:auto}
.mx{min-width:900px;font-size:10px}
.mx td.ml{font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;color:var(--gold);background:var(--bg2);border-right:1px solid var(--border2);white-space:nowrap;min-width:140px;padding:6px 12px;position:sticky;left:0;z-index:1}
.mx td.mc{text-align:center;padding:4px 5px;border-right:1px solid var(--dim2)}
.ev+{color:var(--green)}.ev-neg{color:var(--red)}.ev0{color:var(--dim)}
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div>
    <div class="brand-logo">PRONTO-AI</div>
    <div class="brand-ver">v10.0 · TradingView → MetaApi → FTMO MT5 · Balance from MT5 · Fixed Risk ${(FIXED_RISK_PCT*100).toFixed(3)}%</div>
  </div>
  <div class="header-right">
    <span class="session-badge s-outside" id="hdr-sess">—</span>
    <span class="clock" id="clock">--:--:--</span>
    <button class="btn-sm" onclick="loadAll()">↻ REFRESH</button>
  </div>
</div>

<!-- KPI BAR -->
<div class="kpi-bar">
  <div class="kpi kpi-bal"><div class="kpi-label">Live MT5 Balance</div><div class="kpi-val kv-g">€<span id="k-bal">${balance.toFixed(0)}</span></div></div>
  <div class="kpi kpi-pos"><div class="kpi-label">Open Positions</div><div class="kpi-val kv-b" id="k-pos">—</div></div>
  <div class="kpi kpi-gh"><div class="kpi-label">Active Ghosts</div><div class="kpi-val kv-p" id="k-gh">—</div></div>
  <div class="kpi kpi-tp"><div class="kpi-label">TP Locks EV+</div><div class="kpi-val kv-gd" id="k-tp">—</div></div>
  <div class="kpi kpi-sess"><div class="kpi-label">Session</div><div class="kpi-val kv-c" id="k-sess" style="font-size:14px;letter-spacing:2px">—</div></div>
  <div class="kpi kpi-risk"><div class="kpi-label">Fixed Risk/Trade</div><div class="kpi-val kv-o">${(FIXED_RISK_PCT*100).toFixed(3)}%</div></div>
  <div class="kpi kpi-risk"><div class="kpi-label">Lot Overrides</div><div class="kpi-val kv-o" id="k-lots">—</div></div>
  <div class="kpi kpi-err"><div class="kpi-label">Trade Errors</div><div class="kpi-val kv-r" id="k-err">—</div></div>
</div>

<div class="page">

<!-- ════════════════════════════════════════════════════════════
     1. OPEN POSITIONS
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-positions">
  <div class="sec-header" onclick="toggleSec('positions')">
    <span class="sec-title" style="color:var(--green)">🟢 OPEN POSITIONS</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="pos-meta">Loading...</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Pair</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th style="text-align:right">Entry</th>
          <th style="text-align:right">SL</th>
          <th style="text-align:right">SL Dist%</th>
          <th>SL Used%</th>
          <th style="text-align:right">Best RR</th>
          <th style="text-align:right">TP Price</th>
          <th style="text-align:right">TP RR</th>
          <th>Ghost</th>
          <th style="text-align:right">PnL €</th>
          <th style="text-align:right">PnL %bal</th>
          <th style="text-align:right">Spread</th>
          <th style="text-align:right">Lots</th>
          <th style="text-align:right">Risk €</th>
          <th style="text-align:right">Opened</th>
        </tr></thead>
        <tbody id="pos-body"><tr><td colspan="18" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════
     2. TRADE OVERVIEW — all combos, sortable, filterable
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-overview">
  <div class="sec-header" onclick="toggleSec('overview')">
    <span class="sec-title" style="color:var(--blue)">📊 TRADE OVERVIEW — All Combinations (Apr 18+)</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="ov-meta">Loading...</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="filter-bar">
      <span class="fl">Type:</span>
      <button class="fb on" onclick="setF('type','all',this,'ov-type')">All</button>
      <button class="fb" onclick="setF('type','forex',this,'ov-type')">Forex</button>
      <button class="fb" onclick="setF('type','index',this,'ov-type')">Index</button>
      <button class="fb" onclick="setF('type','commodity',this,'ov-type')">Commodity</button>
      <button class="fb" onclick="setF('type','stock',this,'ov-type')">Stocks</button>
      <span class="fl" style="margin-left:6px">Session:</span>
      <button class="fb on" onclick="setF('sess','all',this,'ov-sess')">All</button>
      <button class="fb" onclick="setF('sess','asia',this,'ov-sess')">Asia</button>
      <button class="fb" onclick="setF('sess','london',this,'ov-sess')">London</button>
      <button class="fb" onclick="setF('sess','ny',this,'ov-sess')">NY</button>
      <span class="fl" style="margin-left:6px">Dir:</span>
      <button class="fb on" onclick="setF('dir','all',this,'ov-dir')">All</button>
      <button class="fb" onclick="setF('dir','buy',this,'ov-dir')">Buy</button>
      <button class="fb" onclick="setF('dir','sell',this,'ov-dir')">Sell</button>
      <span class="fl" style="margin-left:6px">VWAP:</span>
      <button class="fb on" onclick="setF('vwap','all',this,'ov-vwap')">All</button>
      <button class="fb" onclick="setF('vwap','above',this,'ov-vwap')">Above</button>
      <button class="fb" onclick="setF('vwap','below',this,'ov-vwap')">Below</button>
      <span class="fl" style="margin-left:6px">Show:</span>
      <button class="fb on" onclick="setF('zeros','all',this,'ov-zeros')">All rows</button>
      <button class="fb" onclick="setF('zeros','traded',this,'ov-zeros')">Traded only</button>
      <span class="fl" style="margin-left:6px">Symbol:</span>
      <input class="sym-input" id="ov-sym" placeholder="type symbol…" oninput="renderOv()" />
    </div>
    <div class="stats-row">
      Trades: <span id="ov-n">—</span> &nbsp;
      Wins: <span id="ov-w">—</span> &nbsp;
      Win%: <span id="ov-wr">—</span> &nbsp;
      Total PnL: <span id="ov-pnl">—</span> &nbsp;
      EV+ combos: <span id="ov-evp">—</span> &nbsp;
      Combos w/data: <span id="ov-cd">—</span>
    </div>
    <div class="tbl-wrap">
      <table id="ov-tbl">
        <thead><tr>
          <th class="srt" onclick="sortOv('sym')">Symbol</th>
          <th class="srt" onclick="sortOv('type')">Type</th>
          <th class="srt" onclick="sortOv('sess')">Session</th>
          <th class="srt" onclick="sortOv('dir')">Dir</th>
          <th class="srt" onclick="sortOv('vwap')">VWAP</th>
          <th class="srt" onclick="sortOv('n')" style="text-align:right">#Trades</th>
          <th class="srt" onclick="sortOv('wr')" style="text-align:right">Win%</th>
          <th class="srt" onclick="sortOv('avgRR')" style="text-align:right">Avg RR</th>
          <th class="srt" onclick="sortOv('bestRR')" style="text-align:right">Best RR</th>
          <th class="srt" onclick="sortOv('ev')" style="text-align:right">EV</th>
          <th class="srt" onclick="sortOv('evPos')">EV+?</th>
          <th class="srt" onclick="sortOv('tpn')" style="text-align:right">Total PnL</th>
          <th class="srt" onclick="sortOv('apnl')" style="text-align:right">Avg PnL</th>
          <th class="srt" onclick="sortOv('asl')" style="text-align:right">Avg SL%</th>
          <th class="srt" onclick="sortOv('tplrr')" style="text-align:right">TP Lock RR</th>
          <th class="srt" onclick="sortOv('tp')" style="text-align:right">TP Hits</th>
          <th class="srt" onclick="sortOv('sl')" style="text-align:right">SL Hits</th>
        </tr></thead>
        <tbody id="ov-body"><tr><td colspan="17" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════
     3. WEBHOOK HISTORY — all events
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-history">
  <div class="sec-header" onclick="toggleSec('history')">
    <span class="sec-title" style="color:var(--cyan)">📋 WEBHOOK HISTORY — Last 100 Events</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="hist-meta">—</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="filter-bar">
      <span class="fl">Filter:</span>
      <button class="fb on" onclick="setHistF('all',this)">All</button>
      <button class="fb" onclick="setHistF('ORDER_PLACED',this)">Placed</button>
      <button class="fb" onclick="setHistF('POSITION_CLOSED',this)">Closed</button>
      <button class="fb" onclick="setHistF('MARKET_CLOSED',this)">Mkt Closed</button>
      <button class="fb" onclick="setHistF('LOT_RECALC',this)">Lot Recalc</button>
      <button class="fb" onclick="setHistF('REJECTED',this)">Rejected</button>
      <button class="fb" onclick="setHistF('ERROR',this)">Errors</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Time</th><th>Type</th><th>Symbol</th><th>Cat</th>
          <th>Dir</th><th>VWAP</th><th>Session</th>
          <th style="text-align:right">Entry</th>
          <th style="text-align:right">SL</th>
          <th style="text-align:right">TP</th>
          <th style="text-align:right">Lots</th>
          <th style="text-align:right">Risk%</th>
          <th>Optimizer Key</th>
          <th>Position ID</th>
          <th>Detail / Reason</th>
        </tr></thead>
        <tbody id="hist-body"><tr><td colspan="15" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════
     4. GHOST HISTORY
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-ghosts">
  <div class="sec-header" onclick="toggleSec('ghosts')">
    <span class="sec-title" style="color:var(--purple)">👻 GHOSTS — Active + History</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="gh-meta">—</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div style="padding:8px 12px;font-size:9px;color:var(--dim);border-bottom:1px solid var(--border);background:var(--bg2)">ACTIVE GHOSTS</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Optimizer Key</th><th>Dir</th><th>Session</th><th style="text-align:right">Entry</th><th style="text-align:right">Phantom SL</th><th style="text-align:right">Max Price</th><th style="text-align:right">MaxRR</th><th>SL Used%</th><th style="text-align:right">Elapsed</th></tr></thead>
        <tbody id="gh-body"><tr><td colspan="9" class="no-data">No active ghosts</td></tr></tbody>
      </table>
    </div>
    <div style="padding:8px 12px;font-size:9px;color:var(--dim);border-top:1px solid var(--border2);border-bottom:1px solid var(--border);background:var(--bg2)">GHOST HISTORY (last 30)</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Key</th><th>Dir</th><th>Session</th><th style="text-align:right">MaxRR</th><th style="text-align:right">TP RR Used</th><th>SL Hit?</th><th>Reason</th><th style="text-align:right">Time(min)</th><th>Closed</th></tr></thead>
        <tbody id="ghh-body"><tr><td colspan="9" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════
     5. EV MATRIX
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-ev">
  <div class="sec-header" onclick="toggleSec('ev')">
    <span class="sec-title" style="color:var(--gold)">📈 EV MATRIX — by Symbol × Session × Dir × VWAP</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="ev-meta">—</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div style="padding:8px 12px;font-size:9px;color:var(--dim);border-bottom:1px solid var(--border);background:var(--bg2)">FOREX</div>
    <div class="mx-wrap"><table class="mx" id="mx-forex"></table></div>
    <div style="padding:8px 12px;font-size:9px;color:var(--dim);border-bottom:1px solid var(--border);border-top:1px solid var(--border2);background:var(--bg2)">INDEXES</div>
    <div class="mx-wrap"><table class="mx" id="mx-index"></table></div>
    <div style="padding:8px 12px;font-size:9px;color:var(--dim);border-bottom:1px solid var(--border);border-top:1px solid var(--border2);background:var(--bg2)">COMMODITIES</div>
    <div class="mx-wrap"><table class="mx" id="mx-comm"></table></div>
    <div style="padding:8px 12px;font-size:9px;color:var(--dim);border-bottom:1px solid var(--border);border-top:1px solid var(--border2);background:var(--bg2)">STOCKS (NY only)</div>
    <div class="mx-wrap"><table class="mx" id="mx-stocks"></table></div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════
     6. SHADOW SL
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-shadow">
  <div class="sec-header" onclick="toggleSec('shadow')">
    <span class="sec-title" style="color:var(--purple)">🌑 SHADOW SL OPTIMIZER — READ ONLY</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="sh-meta">—</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Optimizer Key</th><th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th>
          <th style="text-align:right">Snaps</th><th style="text-align:right">Positions</th>
          <th style="text-align:right">p50%</th><th style="text-align:right">p90%</th>
          <th style="text-align:right">p99%</th><th style="text-align:right">Max%</th>
          <th style="text-align:right">Rec SL%</th><th>Too Wide?</th><th style="text-align:right">Save%</th>
        </tr></thead>
        <tbody id="sh-body"><tr><td colspan="14" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════
     7. FLAGGED TRADES (ERRORS)
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-errors">
  <div class="sec-header" onclick="toggleSec('errors')">
    <span class="sec-title" style="color:var(--red)">⚠ FLAGGED TRADES — Data Errors</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="err-meta">—</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Position ID</th><th>Symbol</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th style="text-align:right">Entry</th><th style="text-align:right">SL</th>
          <th style="text-align:right">MaxRR</th><th>Close</th><th style="text-align:right">PnL</th>
          <th style="text-align:right">Lots</th><th>Flags</th><th>Closed</th>
        </tr></thead>
        <tbody id="err-body"><tr><td colspan="13" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════
     8. RISK CONFIG + LOT OVERRIDES
════════════════════════════════════════════════════════════ -->
<div class="section" id="s-risk">
  <div class="sec-header" onclick="toggleSec('risk')">
    <span class="sec-title" style="color:var(--gold)">💰 RISK CONFIG & LOT OVERRIDES</span>
    <span style="display:flex;align-items:center;gap:10px"><span class="sec-meta" id="risk-meta">—</span><span class="collapse-icon">▼</span></span>
  </div>
  <div class="sec-body">
    <div class="filter-bar">
      <span class="fl">Type:</span>
      <button class="fb on" onclick="setF('rtype','all',this,'r-type')">All</button>
      <button class="fb" onclick="setF('rtype','forex',this,'r-type')">Forex</button>
      <button class="fb" onclick="setF('rtype','index',this,'r-type')">Index</button>
      <button class="fb" onclick="setF('rtype','commodity',this,'r-type')">Commodity</button>
      <button class="fb" onclick="setF('rtype','stock',this,'r-type')">Stocks</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Symbol</th><th>Type</th><th>Risk%</th><th style="text-align:right">Risk € live</th><th>Mult</th><th>Lot Override</th><th>Env Var</th></tr></thead>
        <tbody id="risk-body"><tr><td colspan="7" class="no-data">Loading...</td></tr></tbody>
      </table>
    </div>
    <div style="padding:8px 12px;font-size:9px;color:var(--dim);border-top:1px solid var(--border2);border-bottom:1px solid var(--border);background:var(--bg2)">LOT OVERRIDES — set these in Railway after SL recalc</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Symbol</th><th>Optimal Lots</th><th>Railway Env Var</th><th>Risk%</th><th>Instruction</th></tr></thead>
        <tbody id="lots-body"><tr><td colspan="5" class="no-data">No SL recalcs yet</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

</div><!-- /page -->

<script>
// ── Catalogs ──────────────────────────────────────────────────────
const FOREX=['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
const INDEX=['DE30EUR','NAS100USD','UK100GBP','US30USD'];
const COMM=['XAUUSD'];
const STOCKS=['AAPL','AMD','AMZN','ARM','ASML','AVGO','AZN','BA','BABA','BAC','BRKB','CSCO','CVX','DIS','FDX','GE','GM','GME','GOOGL','IBM','INTC','JNJ','JPM','KO','LMT','MCD','META','MSFT','MSTR','NFLX','NKE','NVDA','PFE','PLTR','QCOM','SBUX','SNOW','T','TSLA','V','WMT','XOM','ZM'];
const ALL_SYM=[...FOREX,...INDEX,...COMM,...STOCKS];
const SESS_ALL=['asia','london','ny'];
const SESS_STOCK=['ny'];  // stocks only NY
const DIRS=['buy','sell'];
const VWAPS=['above','below'];
const CUTOFF=new Date('2026-04-18T00:00:00+02:00'); // Brussels Apr 18 00:00

function symType(s){if(FOREX.includes(s))return'forex';if(INDEX.includes(s))return'index';if(COMM.includes(s))return'commodity';return'stock';}

// ── Utils ──────────────────────────────────────────────────────────
function fmt(v,d=2){return v!=null&&!isNaN(v)?Number(v).toFixed(d):'—';}
function fmtPct(v){return v!=null?(v*100).toFixed(3)+'%':'—';}
function shortTs(iso){if(!iso)return'—';return new Date(iso).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function shortDate(iso){if(!iso)return'—';return new Date(iso).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',year:'2-digit'});}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;}
async function api(url){try{const r=await fetch(url,{cache:'no-store'});return r.ok?r.json():null;}catch{return null;}}
function catPill(t){return t?'<span class="cat cat-'+t+'">'+t.toUpperCase()+'</span>':'';}
function sessBadge(s){const m={asia:'b-asia',london:'b-london',ny:'b-ny',outside:'b-outside'};return'<span class="badge '+(m[s]||'b-default')+'">'+(s||'—').toUpperCase()+'</span>';}
function closeBadge(r){const m={tp:'b-tp',sl:'b-sl',manual:'b-manual'};return'<span class="badge '+(m[r]||'b-default')+'">'+(r||'—').toUpperCase()+'</span>';}
function slBar(pct){if(pct==null)return'—';const cls=pct>=80?' d':pct>=50?' w':'';return'<div class="slb"><div class="slb-bg"><div class="slb-fill'+cls+'" style="width:'+Math.min(100,pct)+'%"></div></div><span class="'+(pct>=80?'cr':pct>=50?'co':'cg')+'">'+Number(pct).toFixed(0)+'%</span></div>';}
function histTypeBadge(t){if(!t)return'<span class="badge b-default">—</span>';if(t.includes('PLACED')||t==='ORDER_PLACED')return'<span class="badge b-placed">PLACED</span>';if(t.includes('CLOSED'))return'<span class="badge b-closed">CLOSED</span>';if(t.includes('REJECTED'))return'<span class="badge b-rejected">REJECTED</span>';if(t.includes('ERROR'))return'<span class="badge b-error">ERROR</span>';if(t.includes('MARKET_CLOSED'))return'<span class="badge" style="background:rgba(74,96,128,.2);color:var(--dim)">MKT CLOSED</span>';return'<span class="badge b-default">'+t.replace(/_/g,' ')+'</span>';}

// ── Section collapse ───────────────────────────────────────────────
function toggleSec(id){document.getElementById('s-'+id).classList.toggle('sec-collapsed');}

// ── Filter state ───────────────────────────────────────────────────
const F={type:'all',sess:'all',dir:'all',vwap:'all',zeros:'all',rtype:'all'};
let histFilter='all';

function setF(key,val,el,grp){
  F[key]=val;
  document.querySelectorAll('[onclick*="'+grp+'"]').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  if(key==='rtype')renderRisk();else renderOv();
}
function setHistF(val,el){
  histFilter=val;
  document.querySelectorAll('#s-history .fb').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  renderHist();
}

// ── Overview ───────────────────────────────────────────────────────
let _ovData=[], _ovSort={col:'n',dir:-1};
let _allTrades=[], _evMap={}, _shadowMap={}, _tpMap={};

async function loadOverview(){
  const [tradesRes,evRes,shadowRes,tpRes]=await Promise.all([
    api('/trades?limit=5000'),
    api('/ev'),
    api('/shadow'),
    api('/tp-locks'),
  ]);

  // Only trades from April 18 2026+
  const allT=(tradesRes?.trades||[]).filter(t=>t.closedAt&&new Date(t.closedAt)>=CUTOFF);
  _allTrades=allT;
  _evMap={};(evRes||[]).forEach(e=>_evMap[e.key]=e);
  _shadowMap={};(shadowRes?.results||[]).forEach(s=>_shadowMap[s.optimizerKey]=s);
  _tpMap={};(tpRes||[]).forEach(t=>_tpMap[t.key]=t);

  // Build combo rows
  // Stocks: NY only. Forex/Index/Commodity: all sessions
  _ovData=[];
  for(const sym of ALL_SYM){
    const type=symType(sym);
    const sessions=type==='stock'?SESS_STOCK:SESS_ALL;
    for(const sess of sessions){
      for(const dir of DIRS){
        for(const vwap of VWAPS){
          const key=sym+'_'+sess+'_'+dir+'_'+vwap;
          const ct=allT.filter(t=>t.symbol===sym&&t.session===sess&&t.direction===dir&&(t.vwapPosition||'unknown')===vwap);
          const n=ct.length;
          const wins=ct.filter(t=>t.hitTP||t.closeReason==='tp').length;
          const slHits=ct.filter(t=>t.closeReason==='sl').length;
          const tpHits=wins;
          const rrArr=ct.map(t=>t.maxRR||0).filter(v=>!isNaN(v));
          const pnlArr=ct.map(t=>t.realizedPnlEUR??t.currentPnL??0).filter(v=>v!=null&&!isNaN(v));
          const totalPnl=pnlArr.reduce((a,b)=>a+b,0);
          const ev=_evMap[key];
          const shadow=_shadowMap[key];
          const tp=_tpMap[key];
          _ovData.push({
            key,sym,type,sess,dir,vwap,n,wins,slHits,tpHits,
            wr:n>0?wins/n*100:null,
            avgRR:rrArr.length>0?avg(rrArr):null,
            bestRR:rrArr.length>0?Math.max(...rrArr):null,
            ev:ev?.bestEV??null,
            evPos:ev&&(ev.bestEV||0)>0,
            tpn:n>0?totalPnl:null,
            apnl:n>0?totalPnl/n:null,
            asl:shadow?.p90??null,
            tplrr:tp?.lockedRR??ev?.bestRR??null,
          });
        }
      }
    }
  }
  renderOv();
}

function sortOv(col){
  if(_ovSort.col===col)_ovSort.dir*=-1;else _ovSort={col,dir:-1};
  document.querySelectorAll('#ov-tbl th').forEach(th=>th.classList.remove('asc','desc'));
  const names=['sym','type','sess','dir','vwap','n','wr','avgRR','bestRR','ev','evPos','tpn','apnl','asl','tplrr','tp','sl'];
  const i=names.indexOf(_ovSort.col);
  const ths=[...document.querySelectorAll('#ov-tbl th')];
  if(ths[i])ths[i].classList.add(_ovSort.dir===-1?'desc':'asc');
  renderOv();
}

function renderOv(){
  const symSearch=(document.getElementById('ov-sym')?.value||'').toUpperCase().trim();
  let d=[..._ovData];
  if(F.type!=='all')d=d.filter(r=>r.type===F.type);
  if(F.sess!=='all')d=d.filter(r=>r.sess===F.sess);
  if(F.dir!=='all')d=d.filter(r=>r.dir===F.dir);
  if(F.vwap!=='all')d=d.filter(r=>r.vwap===F.vwap);
  if(F.zeros==='traded')d=d.filter(r=>r.n>0);
  if(symSearch)d=d.filter(r=>r.sym.includes(symSearch));

  // Sort
  const col=_ovSort.col,dir=_ovSort.dir;
  d.sort((a,b)=>{
    const av=a[col],bv=b[col];
    if(av==null&&bv==null)return 0;
    if(av==null)return 1;if(bv==null)return -1;
    if(typeof av==='string')return dir*av.localeCompare(bv);
    return dir*(av-bv);
  });

  const traded=d.filter(r=>r.n>0);
  const totalN=traded.reduce((s,r)=>s+r.n,0);
  const totalW=traded.reduce((s,r)=>s+r.wins,0);
  const totalPnl=traded.reduce((s,r)=>s+(r.tpn||0),0);
  const evpCnt=traded.filter(r=>r.evPos&&r.ev!=null).length;
  document.getElementById('ov-n').textContent=totalN;
  document.getElementById('ov-w').textContent=totalW;
  document.getElementById('ov-wr').textContent=totalN>0?(totalW/totalN*100).toFixed(1)+'%':'—';
  document.getElementById('ov-pnl').textContent=(totalPnl>=0?'€+':'€')+totalPnl.toFixed(2);
  document.getElementById('ov-evp').textContent=evpCnt;
  document.getElementById('ov-cd').textContent=traded.length;
  document.getElementById('ov-meta').textContent=d.length+' combos ('+(F.zeros==='traded'?traded.length+' traded':'includes zeros')+')';

  const b=document.getElementById('ov-body');
  if(!d.length){b.innerHTML='<tr><td colspan="17" class="no-data">No combinations match filters</td></tr>';return;}
  b.innerHTML=d.map(r=>{
    const z=r.n===0;
    const pnlCls=r.tpn>0?'cg':r.tpn<0?'cr':'cd';
    const ecls=r.evPos?'cg':r.ev!=null&&r.ev<0?'cr':'cd';
    const evBadge=r.ev==null?'<span class="cd">—</span>':r.evPos?'<span class="badge b-evpos">YES ★</span>':'<span class="badge b-evneg">NO</span>';
    return \`<tr class="t-\${r.type}\${z?' zero-row':''}">
      <td class="cb fw">\${r.sym}</td>
      <td>\${catPill(r.type)}</td>
      <td>\${sessBadge(r.sess)}</td>
      <td><span class="badge b-\${r.dir}">\${r.dir.toUpperCase()}</span></td>
      <td><span class="badge b-\${r.vwap}">\${r.vwap}</span></td>
      <td style="text-align:right;font-weight:600">\${z?'<span class="cd">0</span>':r.n}</td>
      <td style="text-align:right">\${r.wr!=null?r.wr.toFixed(1)+'%':'—'}</td>
      <td style="text-align:right">\${r.avgRR!=null?fmt(r.avgRR,2)+'R':'—'}</td>
      <td style="text-align:right" class="cc">\${r.bestRR!=null?fmt(r.bestRR,2)+'R':'—'}</td>
      <td style="text-align:right" class="\${ecls}">\${r.ev!=null?fmt(r.ev,3):'—'}</td>
      <td>\${evBadge}</td>
      <td style="text-align:right" class="\${pnlCls}">\${r.tpn!=null?'€'+fmt(r.tpn,2):'—'}</td>
      <td style="text-align:right" class="\${r.apnl>0?'cg':r.apnl<0?'cr':'cd'}">\${r.apnl!=null?'€'+fmt(r.apnl,2):'—'}</td>
      <td style="text-align:right">\${r.asl!=null?fmt(r.asl,1)+'%':'—'}</td>
      <td style="text-align:right" class="cgd">\${r.tplrr!=null?fmt(r.tplrr,1)+'R':'—'}</td>
      <td style="text-align:right" class="cg">\${r.n>0?r.tpHits:'—'}</td>
      <td style="text-align:right" class="cr">\${r.n>0?r.slHits:'—'}</td>
    </tr>\`;
  }).join('');
}

// ── Open Positions ─────────────────────────────────────────────────
let _liveBalance=0;
async function loadPositions(){
  const d=await api('/live/positions');if(!d)return;
  _liveBalance=d.balance||0;
  document.getElementById('k-pos').textContent=d.count;
  document.getElementById('k-bal').textContent=(_liveBalance).toFixed(0);
  document.getElementById('pos-meta').textContent=d.count+' open | balance €'+_liveBalance.toFixed(0);
  const b=document.getElementById('pos-body');
  if(!d.positions.length){b.innerHTML='<tr><td colspan="18" class="no-data">No open positions</td></tr>';return;}
  b.innerHTML=d.positions.map(p=>{
    const t=symType(p.symbol);
    const pnlPct=_liveBalance>0&&p.currentPnL!=null?(p.currentPnL/_liveBalance*100):null;
    const pnlCls=(p.currentPnL||0)>=0?'cg':'cr';
    const spread=p.spread??((p.ask&&p.bid)?p.ask-p.bid:null);
    return \`<tr class="t-\${t}">
      <td class="cb fw">\${p.symbol}</td>
      <td><span class="badge b-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
      <td><span class="badge b-\${p.vwapPosition||'unknown'}">\${p.vwapPosition||'?'}</span></td>
      <td>\${sessBadge(p.session)}</td>
      <td style="text-align:right">\${fmt(p.entry,5)}</td>
      <td style="text-align:right" class="cr">\${fmt(p.sl,5)}</td>
      <td style="text-align:right" class="co">\${p.slDistPct!=null?p.slDistPct+'%':'—'}</td>
      <td>\${slBar(p.slPctUsed)}</td>
      <td style="text-align:right" class="cc">\${fmt(p.maxRR,2)}R</td>
      <td style="text-align:right" class="cg">\${fmt(p.tp,5)}</td>
      <td style="text-align:right" class="cgd">\${p.tpRR||'—'}R</td>
      <td>\${p.isGhosted?'<span class="badge b-ghost">👻 YES</span>':'<span class="cd">—</span>'}</td>
      <td style="text-align:right" class="\${pnlCls} fw">\${p.currentPnL!=null?'€'+fmt(p.currentPnL,2):'—'}</td>
      <td style="text-align:right" class="\${pnlCls}">\${pnlPct!=null?(pnlPct>=0?'+':'')+pnlPct.toFixed(3)+'%':'—'}</td>
      <td style="text-align:right" class="co">\${spread!=null?spread.toFixed(5):'—'}</td>
      <td style="text-align:right">\${fmt(p.lots,2)}</td>
      <td style="text-align:right" class="cg">\${p.riskEUR?'€'+p.riskEUR.toFixed(2):'—'}</td>
      <td style="text-align:right" class="cd">\${shortTs(p.openedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── Webhook History ────────────────────────────────────────────────
let _histData=[];
async function loadHistory(){
  const d=await api('/history');if(!d)return;
  _histData=Array.isArray(d)?d:[];
  document.getElementById('hist-meta').textContent=_histData.length+' events';
  renderHist();
}
function renderHist(){
  const data=histFilter==='all'?_histData:_histData.filter(h=>(h.type||'').includes(histFilter));
  const b=document.getElementById('hist-body');
  if(!data.length){b.innerHTML='<tr><td colspan="15" class="no-data">No events</td></tr>';return;}
  b.innerHTML=data.slice(0,100).map(h=>{
    const t=symType(h.symbol||'');
    const pnlCls=(h.pnl||0)>=0?'cg':'cr';
    return \`<tr class="t-\${t}">
      <td class="cd" style="font-size:10px;white-space:nowrap">\${shortDate(h.ts)} \${shortTs(h.ts)}</td>
      <td>\${histTypeBadge(h.type)}</td>
      <td class="cb">\${h.symbol||'<span class="cd">—</span>'}</td>
      <td>\${catPill(t)}</td>
      <td>\${h.direction?'<span class="badge b-'+h.direction+'">'+h.direction.toUpperCase()+'</span>':'<span class="cd">—</span>'}</td>
      <td>\${h.vwapPosition?'<span class="badge b-'+h.vwapPosition+'">'+h.vwapPosition+'</span>':h.vwap_pos?'<span class="badge b-'+h.vwap_pos+'">'+h.vwap_pos+'</span>':'<span class="cd">—</span>'}</td>
      <td>\${sessBadge(h.session)}</td>
      <td style="text-align:right">\${h.entry?fmt(h.entry,5):'<span class="cd">—</span>'}</td>
      <td style="text-align:right" class="cr">\${h.sl?fmt(h.sl,5):'<span class="cd">—</span>'}</td>
      <td style="text-align:right" class="cg">\${h.tp?fmt(h.tp,5):'<span class="cd">—</span>'}</td>
      <td style="text-align:right">\${h.lots?fmt(h.lots,2):'<span class="cd">—</span>'}</td>
      <td style="text-align:right" class="cgd">\${h.riskPct?fmtPct(h.riskPct):'<span class="cd">—</span>'}</td>
      <td style="font-size:9px;color:var(--dim);max-width:160px;overflow:hidden;text-overflow:ellipsis">\${h.optimizer_key||h.optimizerKey||'—'}</td>
      <td style="font-size:9px;color:var(--dim)">\${h.position_id||h.positionId||'—'}</td>
      <td style="font-size:9px;color:var(--dim)">\${h.reason||h.optimalLots!=null?'lots='+h.optimalLots:''}</td>
    </tr>\`;
  }).join('');
}

// ── Ghosts ────────────────────────────────────────────────────────
async function loadGhosts(){
  const [live,hist]=await Promise.all([api('/live/ghosts'),api('/ghosts/history?limit=30')]);
  document.getElementById('k-gh').textContent=live?.count??0;
  document.getElementById('gh-meta').textContent=(live?.count??0)+' active';
  const b=document.getElementById('gh-body');
  if(!live?.ghosts?.length){b.innerHTML='<tr><td colspan="9" class="no-data">No active ghosts</td></tr>';}
  else b.innerHTML=live.ghosts.map(g=>{
    const slUsed=g.entry&&g.sl&&g.maxPrice?(Math.abs(g.entry-g.maxPrice)/Math.abs(g.entry-g.sl)*100):null;
    return \`<tr><td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
      <td><span class="badge b-\${g.direction}">\${g.direction?.toUpperCase()}</span></td>
      <td>\${sessBadge(g.session)}</td>
      <td style="text-align:right">\${fmt(g.entry,5)}</td><td style="text-align:right" class="cr">\${fmt(g.sl,5)}</td>
      <td style="text-align:right">\${fmt(g.maxPrice,5)}</td><td style="text-align:right" class="cc">\${fmt(g.maxRR,2)}R</td>
      <td>\${slBar(slUsed)}</td><td style="text-align:right" class="cd">\${g.elapsedMin}m</td></tr>\`;
  }).join('');

  const bh=document.getElementById('ghh-body');
  if(!hist?.rows?.length){bh.innerHTML='<tr><td colspan="9" class="no-data">No ghost history</td></tr>';}
  else bh.innerHTML=hist.rows.map(g=>\`<tr>
    <td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
    <td><span class="badge b-\${g.direction||'default'}">\${(g.direction||'?').toUpperCase()}</span></td>
    <td>\${sessBadge(g.session)}</td>
    <td style="text-align:right" class="cc">\${fmt(g.maxRRBeforeSL,2)}R</td>
    <td style="text-align:right" class="cgd">\${fmt(g.tpRRUsed,1)}R</td>
    <td>\${g.phantomSLHit?'<span class="cr">✓ SL</span>':'<span class="cd">—</span>'}</td>
    <td class="cd">\${g.stopReason||'—'}</td>
    <td style="text-align:right" class="cd">\${g.timeToSLMin!=null?g.timeToSLMin+'m':'—'}</td>
    <td class="cd" style="font-size:9px">\${shortDate(g.closedAt)} \${shortTs(g.closedAt)}</td>
  </tr>\`).join('');
}

// ── EV Matrix ─────────────────────────────────────────────────────
async function loadEV(){
  const d=await api('/ev');if(!d)return;
  document.getElementById('k-tp').textContent=d.filter(x=>(x.count||0)>=5&&(x.bestEV||0)>0).length;
  document.getElementById('ev-meta').textContent=d.length+' keys';
  const lk={};for(const e of d)lk[e.key]=e;

  function mx(symbols,tableId,sessions,names){
    const el=document.getElementById(tableId);if(!el)return;
    let h='<thead><tr><th style="position:sticky;left:0;z-index:2;min-width:130px;background:var(--bg2)">Symbol</th>';
    for(const s of sessions){const lbl={asia:'🌏 ASIA',london:'🇬🇧 LON',ny:'🇺🇸 NY'}[s];h+=\`<th colspan="4" style="text-align:center;border-left:1px solid var(--border2);background:var(--bg2);font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700">\${lbl}</th>\`;}
    h+='</tr><tr><th style="position:sticky;left:0;z-index:2;background:var(--bg2);font-size:9px">bestRR / EV / n</th>';
    for(const s of sessions)for(const dr of DIRS){const dc=dr==='buy'?'cg':'cr';for(const vw of VWAPS){const vc=vw==='above'?'cb':'cp';h+=\`<th style="text-align:center;font-size:9px;border-left:\${vw==='above'?'1px solid var(--border2)':'none'}"><span class="\${dc}">\${dr[0].toUpperCase()}</span><span class="\${vc}" style="font-size:8px">/\${vw[0]}</span></th>\`;}}
    h+='</tr></thead><tbody>';
    for(const sym of symbols){
      const label=(names&&names[sym])||sym;
      h+=\`<tr><td class="ml">\${label}</td>\`;
      for(const s of sessions)for(const dr of DIRS)for(const vw of VWAPS){
        const key=sym+'_'+s+'_'+dr+'_'+vw,ev=lk[key];
        const bl=vw==='above'?'border-left:1px solid var(--border2);':'';
        if(!ev||!ev.count){h+=\`<td class="mc" style="\${bl}"><span class="cd" style="font-size:8px">—</span></td>\`;}
        else{
          const ep=(ev.bestEV||0)>0,en=(ev.bestEV||0)<0,lcked=ev.count>=5&&ep;
          h+=\`<td class="mc" style="\${bl}\${lcked?'background:rgba(240,192,64,.06);':''}"><div style="font-size:12px;font-family:'Barlow Condensed';font-weight:700" class="\${ep?'ev+':en?'ev-neg':'ev0'}">\${ev.bestRR!=null?fmt(ev.bestRR,1)+'R':'—'}</div><div style="font-size:9px" class="\${ep?'ev+':en?'ev-neg':'ev0'}">\${ev.bestEV!=null?fmt(ev.bestEV,3):'—'}</div><div style="font-size:9px" class="cd">n=\${ev.count||0}\${lcked?'<span class="cgd"> ★</span>':''}</div></td>\`;
        }
      }
      h+='</tr>';
    }
    el.innerHTML=h+'</tbody>';
  }
  mx(FOREX,'mx-forex',SESS_ALL,null);
  mx(INDEX,'mx-index',SESS_ALL,{DE30EUR:'DAX40',NAS100USD:'NAS100',UK100GBP:'UK100',US30USD:'US30'});
  mx(COMM,'mx-comm',SESS_ALL,{XAUUSD:'Gold (XAUUSD)'});
  mx(STOCKS,'mx-stocks',['ny'],null);  // stocks NY only
}

// ── Shadow ────────────────────────────────────────────────────────
async function loadShadow(){
  const d=await api('/shadow');if(!d)return;
  document.getElementById('sh-meta').textContent=d.count+' keys';
  const b=document.getElementById('sh-body');
  if(!d.results.length){b.innerHTML='<tr><td colspan="14" class="no-data">No shadow data yet</td></tr>';return;}
  b.innerHTML=d.results.map(s=>\`<tr>
    <td style="font-size:9px;color:var(--dim)">\${s.optimizerKey}</td>
    <td class="cb">\${s.symbol||'—'}</td><td>\${sessBadge(s.session)}</td>
    <td><span class="badge b-\${s.direction}">\${(s.direction||'').toUpperCase()}</span></td>
    <td><span class="badge b-\${s.vwapPosition||'unknown'}">\${s.vwapPosition||'?'}</span></td>
    <td style="text-align:right">\${s.snapshotsCount||0}</td><td style="text-align:right">\${s.positionsCount||0}</td>
    <td style="text-align:right">\${fmt(s.p50,1)}%</td><td style="text-align:right">\${fmt(s.p90,1)}%</td>
    <td style="text-align:right" class="cgd">\${fmt(s.p99,1)}%</td><td style="text-align:right" class="cr">\${fmt(s.maxUsed,1)}%</td>
    <td style="text-align:right" class="cc">\${s.recommendedSlPct!=null?(s.recommendedSlPct*100).toFixed(0)+'%':'—'}</td>
    <td>\${s.currentSlTooWide?'<span class="cr">⚠ TOO WIDE</span>':'<span class="cg">OK</span>'}</td>
    <td style="text-align:right" class="cgd">\${s.potentialSavingPct!=null?s.potentialSavingPct+'%':'—'}</td>
  </tr>\`).join('');
}

// ── Errors ────────────────────────────────────────────────────────
function flagTrade(t){
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
  const errs=_allTrades.map(t=>({...t,flags:flagTrade(t)})).filter(t=>t.flags.length>0);
  document.getElementById('k-err').textContent=errs.length;
  document.getElementById('err-meta').textContent=errs.length+' flagged';
  const b=document.getElementById('err-body');
  if(!errs.length){b.innerHTML='<tr><td colspan="13" class="no-data">✓ No errors — all trades look clean</td></tr>';return;}
  b.innerHTML=errs.map(t=>{
    const pnl=t.realizedPnlEUR??t.currentPnL;
    const pnlCls=pnl>0?'cg':pnl<0?'cr':'cd';
    return \`<tr class="err-row t-\${symType(t.symbol||'')}">
      <td class="cd" style="font-size:9px">\${t.positionId||t.id||'—'}</td>
      <td class="cb">\${t.symbol||'<span class="cr">MISSING</span>'}</td>
      <td>\${t.direction?'<span class="badge b-'+t.direction+'">'+t.direction.toUpperCase()+'</span>':'<span class="cr">?</span>'}</td>
      <td><span class="badge b-\${t.vwapPosition||'unknown'}">\${t.vwapPosition||'unknown'}</span></td>
      <td>\${sessBadge(t.session)}</td>
      <td style="text-align:right">\${t.entry?fmt(t.entry,5):'<span class="cr">0</span>'}</td>
      <td style="text-align:right" class="cr">\${t.sl?fmt(t.sl,5):'<span class="cr">0</span>'}</td>
      <td style="text-align:right" class="\${(t.maxRR||0)<0?'cr':'cc'}">\${fmt(t.maxRR,2)}R</td>
      <td>\${closeBadge(t.closeReason)}</td>
      <td style="text-align:right" class="\${pnlCls}">\${pnl!=null?'€'+fmt(pnl,2):'<span class="cr">NULL</span>'}</td>
      <td style="text-align:right">\${fmt(t.lots,2)}</td>
      <td>\${t.flags.map(f=>'<span class="badge b-err">'+f+'</span>').join(' ')}</td>
      <td class="cd" style="font-size:9px">\${shortDate(t.closedAt)} \${shortTs(t.closedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── Risk & Lots ───────────────────────────────────────────────────
let _riskData=[];
async function loadRisk(){
  const [rd,ld]=await Promise.all([api('/risk-config'),api('/lot-overrides')]);
  if(rd){
    _riskData=rd.config||[];
    document.getElementById('risk-meta').textContent='Balance: €'+(rd.balance||0).toFixed(0)+' | Fixed risk: '+(rd.fixedRiskPct*100).toFixed(3)+'%';
    document.getElementById('k-lots').textContent=ld?.count||0;
    renderRisk();
  }
  if(ld){
    const b=document.getElementById('lots-body');
    if(!ld.overrides.length){b.innerHTML='<tr><td colspan="5" class="no-data">No SL recalcs yet</td></tr>';return;}
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
  let d=_riskData;
  if(F.rtype!=='all')d=d.filter(r=>r.type===F.rtype);
  const b=document.getElementById('risk-body');
  b.innerHTML=d.map(c=>\`<tr>
    <td class="cb">\${c.symbol}</td><td>\${catPill(c.type)}</td>
    <td class="cgd">\${(c.riskPct*100).toFixed(3)}%</td>
    <td style="text-align:right" class="cg">€\${c.riskEUR}</td>
    <td class="\${c.riskMult>1?'cg':'cd'}">x\${(c.riskMult||1).toFixed(2)}</td>
    <td class="co">\${c.lotOverride!=null?c.lotOverride:'—'}</td>
    <td style="font-size:9px;color:var(--dim)">\${c.envVar}</td>
  </tr>\`).join('');
}

// ── Clock ──────────────────────────────────────────────────────────
function updateClock(){document.getElementById('clock').textContent=new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
setInterval(updateClock,1000);updateClock();

// ── Global load ────────────────────────────────────────────────────
async function loadAll(){
  const h=await api('/health');
  if(h){
    const s=h.session||'outside';
    document.getElementById('k-sess').textContent=s.toUpperCase();
    document.getElementById('k-bal').textContent=(h.balance||0).toFixed(0);
    document.getElementById('k-lots').textContent=h.lotOverrides||0;
    document.getElementById('k-gh').textContent=h.ghosts||0;
    const hb=document.getElementById('hdr-sess');
    hb.className='session-badge s-'+s;
    hb.textContent={asia:'⛩ ASIA',london:'🇬🇧 LONDON',ny:'🇺🇸 NEW YORK',outside:'⏸ OUTSIDE'}[s]||s.toUpperCase();
  }
  await Promise.all([
    loadPositions(),
    loadOverview(),
    loadHistory(),
    loadGhosts(),
    loadEV(),
    loadShadow(),
    loadRisk(),
  ]);
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
