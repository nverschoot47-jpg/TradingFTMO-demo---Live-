// ===============================================================
// server.js  v9.0  |  PRONTO-AI
// TradingView → MetaApi REST → FTMO MT5
//
// v9.0 changes:
//  - Symbol whitelist: only SYMBOL_CATALOG symbols accepted
//  - Per-symbol risk: RISK_AAPL=0.002 → 0.2% of balance
//    fallback: RISK_PCT_STOCK / RISK_PCT_FOREX / RISK_PCT_INDEX /
//              RISK_PCT_COMMODITY / RISK_PCT_CRYPTO
//  - SL always calculated as: mt5_entry × sl_pct from TV payload
//    → broker-agnostic, correct for delayed/different charts
//  - VWAP position tracked: close vs vwap → above | below
//  - Ghost optimizer: starts at trade placement, tracks until
//    phantom SL hit, records max_rr_before_sl
//  - TP: 1.0R default until 5 ghost closes per key, then
//    optimal EV from RR table (0.5→15.0, step 0.1)
//  - Shadow optimizer: per-key (symbol/session/direction/vwap)
//    READ ONLY — logs % SL distance used via price snapshots
//  - No time-based blocking: all BUYS and SELLS pass through
//  - No auto-close: positions held overnight with MT5 SL/TP
//  - Hold stocks through the night — no EOD forced close
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
  SYMBOL_CATALOG, SESSION_LABELS,
  getBrusselsComponents, getBrusselsDateStr, getBrusselsDateOnly,
  getSession, isMarketOpen, isGhostActive,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey,
} = require("./session");

// ── Config ───────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || "50000");
const PORT            = process.env.PORT || 3000;

// Default risk % per type (fallback when no symbol-specific env var)
const DEFAULT_RISK_BY_TYPE = {
  stock:     parseFloat(process.env.RISK_PCT_STOCK     || "0.002"),  // 0.2%
  forex:     parseFloat(process.env.RISK_PCT_FOREX     || "0.001"),  // 0.1%
  index:     parseFloat(process.env.RISK_PCT_INDEX     || "0.004"),  // 0.4%
  commodity: parseFloat(process.env.RISK_PCT_COMMODITY || "0.002"),  // 0.2%
  crypto:    parseFloat(process.env.RISK_PCT_CRYPTO    || "0.002"),  // 0.2%
};

// Ghost settings
const GHOST_MIN_TRADES_FOR_TP = 5;     // ghost closes needed before TP optimization kicks in
const GHOST_POLL_MS           = 30000; // check phantom SL every 30s
const GHOST_MAX_MS            = 24 * 3600 * 1000; // ghost max lifetime 24h

// Lot value per unit (points × lots = monetary risk unit)
const LOT_VALUE = { index: 20, commodity: 100, crypto: 1, stock: 1, forex: 10 };
const MAX_LOTS  = { index: 10, commodity: 2,   crypto: 1, stock: 50, forex: 0.25 };
const LOT_STEP  = { index: 0.01, commodity: 0.01, crypto: 0.01, stock: 1, forex: 0.01 };

// Min stop distances per MT5 symbol
const MIN_STOP = {
  "GER40.cash": 10, "UK100.cash": 2, "US100.cash": 10, "US30.cash": 10,
  "XAUUSD": 0.5, "BTCUSD": 50,
};

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
async function fetchAccountInfo()           { return metaFetch("/accountInformation"); }
async function closePosition(id)            { return metaFetch(`/positions/${id}/close`, { method: "POST" }); }
async function fetchCurrentPrice(mt5Symbol) {
  try {
    const d = await metaFetch(`/symbols/${encodeURIComponent(mt5Symbol)}/currentPrice`, {}, 5000);
    const bid = d.bid ?? null, ask = d.ask ?? null;
    if (bid !== null && ask !== null) return { mid: (bid + ask) / 2, bid, ask, spread: ask - bid };
    const mid = bid ?? ask ?? null;
    return mid !== null ? { mid, bid: mid, ask: mid, spread: 0 } : null;
  } catch { return null; }
}

async function placeOrder(payload) {
  return metaFetch("/trade", { method: "POST", body: JSON.stringify(payload) }, 12000);
}

// ── In-memory state ───────────────────────────────────────────────
const openPositions  = {};   // positionId → position object
const closedTrades   = [];   // all closed trades (loaded from DB at startup)
const ghostTrackers  = {};   // positionId → ghost state
const tpLocks        = {};   // optimizerKey → { lockedRR, lockedGhosts, evAtLock, evPositive }
const shadowResults  = {};   // optimizerKey → shadow analysis
const webhookLog     = [];   // in-memory webhook log (last 200)
const symbolRiskMap  = {};   // symbol → risk_pct (loaded from DB + env)
const MAX_HISTORY    = 200;
let   dailyRiskMult  = 1.0;

function logEvent(entry) {
  webhookLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookLog.length > MAX_HISTORY) webhookLog.length = MAX_HISTORY;
}

// ── Risk calculation ───────────────────────────────────────────────
function getSymbolRiskPct(symbol) {
  // Priority: symbol-specific env > symbol map from DB > type default
  const envKey = `RISK_${symbol}`;
  if (process.env[envKey]) return parseFloat(process.env[envKey]);
  if (symbolRiskMap[symbol]) return symbolRiskMap[symbol];
  const info = getSymbolInfo(symbol);
  return DEFAULT_RISK_BY_TYPE[info?.type || "stock"] ?? 0.002;
}

function calcRiskEUR(symbol) {
  return getSymbolRiskPct(symbol) * ACCOUNT_BALANCE * dailyRiskMult;
}

// ── Lot calculation ───────────────────────────────────────────────
function calcLots(symbol, entry, sl, riskEUR) {
  const info    = getSymbolInfo(symbol);
  const type    = info?.type || "stock";
  const lotVal  = LOT_VALUE[type]  ?? 1;
  const maxLots = MAX_LOTS[type]   ?? 50;
  const lotStep = LOT_STEP[type]   ?? 1;
  const dist    = Math.abs(entry - sl);
  if (!dist) return lotStep;
  let lots = Math.floor((riskEUR / (dist * lotVal)) / lotStep) * lotStep;
  lots = Math.max(lotStep, Math.min(maxLots, lots));
  return parseFloat(lots.toFixed(2));
}

// ── SL from % ────────────────────────────────────────────────────
// Recalculates SL from MT5 execution price using sl_pct from TV.
// This is the core broker-agnostic SL placement.
function calcSLFromPct(direction, mt5Entry, slPct) {
  if (direction === "buy")  return parseFloat((mt5Entry * (1 - slPct)).toFixed(5));
  else                      return parseFloat((mt5Entry * (1 + slPct)).toFixed(5));
}

// Enforce minimum stop distance for indices/commodities
function enforceMinStop(mt5Symbol, direction, entry, sl) {
  const minD = MIN_STOP[mt5Symbol] ?? 0;
  const dist = Math.abs(entry - sl);
  if (dist >= minD) return sl;
  return direction === "buy"
    ? parseFloat((entry - minD).toFixed(5))
    : parseFloat((entry + minD).toFixed(5));
}

// ── TP calculation ────────────────────────────────────────────────
// Returns optimal RR for this key. Default 1.0R until 5 ghost closes.
async function getOptimalTP(optimizerKey) {
  const locked = tpLocks[optimizerKey];
  if (locked) return locked.lockedRR;
  // Check DB ghost count
  const count = await countGhostsByKey(optimizerKey);
  if (count < GHOST_MIN_TRADES_FOR_TP) return 1.0;
  // Compute EV and find best TP
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
// Runs after every ghost close. Updates tpLocks for this key.
async function updateTPLock(optimizerKey, symbol, session, direction, vwapPos) {
  try {
    const ev = await computeEVStats(optimizerKey);
    if (!ev || ev.count < GHOST_MIN_TRADES_FOR_TP) return;
    const prev     = tpLocks[optimizerKey];
    const newRR    = ev.bestRR;
    const evPos    = (ev.bestEV ?? 0) > 0;
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
// Starts when trade is placed. Phantom SL = same as real SL.
// Closes when phantom SL is hit. Records max_rr_before_sl.
function startGhostTracker(pos) {
  const { positionId, symbol, mt5Symbol, session, direction, vwapPosition,
          optimizerKey, entry, sl, slPct, tpRRUsed, openedAt } = pos;

  if (ghostTrackers[positionId]) return; // already tracking

  const phantomSL = sl;
  let maxPrice    = entry;
  let timer       = null;
  const startTs   = Date.now();

  ghostTrackers[positionId] = { positionId, symbol, mt5Symbol, session, direction,
    vwapPosition, optimizerKey, entry, sl: phantomSL, slPct, tpRRUsed, openedAt,
    maxPrice, startTs, timer };

  async function tick() {
    try {
      if (!ghostTrackers[positionId]) return; // cancelled

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

        // Phantom SL hit?
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
  // Also update shadow optimizer for this key
  await runShadowOptimizer(g.optimizerKey).catch(() => {});

  console.log(`[Ghost] Finalized: ${positionId} | key=${g.optimizerKey} | maxRR=${maxRRBeforeSL}R | slHit=${phantomSLHit} | reason=${stopReason}`);
}

// Cancel ghost if positionId no longer relevant
function cancelGhost(positionId) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];
  console.log(`[Ghost] Cancelled: ${positionId}`);
}

// ── Shadow Optimizer ───────────────────────────────────────────────
// READ ONLY — analyzes snapshots to compute % SL used per key.
// Recommendation: tighten SL to p99 of used distance.
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

    // Recommended SL tightening: use p99 as required % of original SL
    const recommendedSlPct = parseFloat((p99 / 100).toFixed(4));
    const tooWide          = p99 < 70; // if price never came within 70% of SL → SL too wide
    const potentialSaving  = tooWide ? parseFloat((100 - p99).toFixed(1)) : 0;

    // Unique position IDs for this key
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
  // Also run for any key that has snapshots
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

    // Detect closed positions
    for (const [id, pos] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        await handlePositionClosed(pos);
        delete openPositions[id];
      }
    }

    // Update open positions
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
    ...pos,
    maxRR, hitTP, closeReason,
    closedAt: now,
    trueMaxRR: null, trueMaxPrice: null,
  };

  closedTrades.push(closed);
  await saveTrade(closed).catch(() => {});
  await savePnlLog(pos.symbol, pos.session, pos.direction, pos.vwapPosition, maxRR, hitTP, pos.currentPnL ?? 0).catch(() => {});
  logEvent({ type: "POSITION_CLOSED", symbol: pos.symbol, direction: pos.direction, maxRR, closeReason });
}

async function restorePositionsFromMT5() {
  try {
    const live = await fetchOpenPositions();
    if (!Array.isArray(live) || !live.length) return;
    let restored = 0;
    for (const lp of live) {
      const id = String(lp.id);
      if (openPositions[id]) continue;
      const sym     = normalizeSymbol(lp.symbol) ?? lp.symbol;
      const info    = getSymbolInfo(sym);
      const dir     = lp.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
      const entry   = lp.openPrice ?? lp.currentPrice ?? 0;
      const sess    = getSession(lp.time ? new Date(lp.time) : null);
      const vpPos   = "unknown"; // can't know vwap at open after restart
      const optKey  = buildOptimizerKey(sym, sess, dir, vpPos);
      openPositions[id] = {
        positionId: id, symbol: sym, mt5Symbol: lp.symbol,
        direction: dir, vwapPosition: vpPos, optimizerKey: optKey,
        entry, sl: lp.stopLoss ?? 0, tp: lp.takeProfit ?? null,
        lots: lp.volume ?? 0.01, riskEUR: 0, riskPct: 0,
        session: sess, openedAt: lp.time ?? now, maxPrice: entry,
        maxRR: 0, currentPnL: lp.unrealizedProfit ?? 0,
        slPct: null, restoredAfterRestart: true,
      };
      // Restart ghost tracker for restored positions
      if (openPositions[id].sl > 0) {
        startGhostTracker(openPositions[id]);
      }
      restored++;
    }
    console.log(`[Restart] ${restored} position(s) restored from MT5`);
  } catch (e) { console.warn("[Restart]", e.message); }
}

// ── Shadow snapshot cron ──────────────────────────────────────────
// Every minute: for each open position, fetch price & save snapshot
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

// ── Daily risk evaluation ─────────────────────────────────────────
async function evaluateDailyRisk() {
  try {
    const todayStr  = getBrusselsDateOnly();
    const todayT    = closedTrades.filter(t => t.closedAt && getBrusselsDateOnly(t.closedAt) === todayStr);
    const totalPnl  = todayT.reduce((s, t) => s + (t.currentPnL ?? 0), 0);
    const nextMult  = totalPnl > 0
      ? parseFloat((dailyRiskMult * 1.2).toFixed(4))
      : 1.0;
    await saveDailyRisk(todayStr, totalPnl, todayT.length, dailyRiskMult, nextMult);
    dailyRiskMult = nextMult;
  } catch (e) { console.warn("[DailyRisk]", e.message); }
}

// ── CRON JOBS ─────────────────────────────────────────────────────

// Position sync every 60 seconds
cron.schedule("*/1 * * * *", async () => {
  await syncOpenPositions().catch(() => {});
}, { timezone: "Europe/Brussels" });

// Shadow snapshots every 1 minute
cron.schedule("*/1 * * * *", async () => {
  await takeShadowSnapshots().catch(() => {});
}, { timezone: "Europe/Brussels" });

// Nightly optimizer at 03:00 — recompute all TP locks & shadow analyses
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

// Daily risk reset at 02:00
cron.schedule("0 2 * * 1-5", async () => {
  console.log("🔄 02:00 — daily reset...");
  await evaluateDailyRisk().catch(() => {});
  await restorePositionsFromMT5().catch(() => {});
  logEvent({ type: "DAILY_RESET", riskMult: dailyRiskMult });
}, { timezone: "Europe/Brussels" });

// Hard stop all ghosts at 23:00 (outside ghost window)
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
    entry: tvEntry,
    sl_pct,
    vwap,
    vwap_upper,
    vwap_lower,
    session_high,
    session_low,
    day_high,
    day_low,
  } = body;

  // ── Validate action ───────────────────────────────────────────
  const direction = action === "buy" ? "buy" : action === "sell" ? "sell" : null;
  if (!direction) {
    return res.status(400).json({ error: "action must be buy or sell" });
  }

  // ── Normalize & validate symbol ───────────────────────────────
  const symKey  = normalizeSymbol(rawSymbol);
  const symInfo = symKey ? getSymbolInfo(symKey) : null;
  if (!symKey || !symInfo) {
    logEvent({ type: "REJECTED", reason: `Symbol not in catalog: ${rawSymbol}` });
    return res.status(400).json({ error: `Symbol not allowed: ${rawSymbol}` });
  }

  const { type: assetType, mt5: mt5Symbol } = symInfo;

  // ── Market hours check (02:00-21:00 mon-fri, NO symbol blocking) ─
  if (!isMarketOpen()) {
    const { hhmm, day } = getBrusselsComponents();
    logEvent({ type: "REJECTED", reason: `Outside window ${hhmm} day=${day}`, symbol: symKey, direction });
    return res.status(200).json({ status: "OUTSIDE_WINDOW", hhmm });
  }

  // ── Session & VWAP position ───────────────────────────────────
  const session      = getSession();
  const closePrice   = parseFloat(tvEntry) || 0;
  const vwapMid      = parseFloat(vwap)    || 0;
  const vwapPosition = getVwapPosition(closePrice, vwapMid);
  const optimizerKey = buildOptimizerKey(symKey, session, direction, vwapPosition);

  // ── Parse sl_pct ──────────────────────────────────────────────
  const slPctRaw = parseFloat(sl_pct);
  if (!slPctRaw || slPctRaw <= 0 || slPctRaw > 0.1) {
    return res.status(400).json({ error: `Invalid sl_pct: ${sl_pct}` });
  }

  // ── Duplicate guard (same symbol+direction within 60s) ────────
  const dupKey  = `${symKey}_${direction}`;
  const dupLast = global._dupGuard?.[dupKey];
  if (dupLast && (Date.now() - dupLast) < 60000) {
    logEvent({ type: "DUPLICATE_BLOCKED", symbol: symKey, direction, optimizerKey });
    return res.status(200).json({ status: "DUPLICATE_BLOCKED" });
  }
  if (!global._dupGuard) global._dupGuard = {};
  global._dupGuard[dupKey] = Date.now();

  // ── Fetch MT5 execution price ─────────────────────────────────
  let mt5Entry = closePrice;
  try {
    const pd = await fetchCurrentPrice(mt5Symbol);
    if (pd) {
      mt5Entry = direction === "buy" ? pd.ask : pd.bid;
    }
  } catch {}

  // ── Calculate SL from MT5 entry using TV sl_pct ───────────────
  let mt5SL = calcSLFromPct(direction, mt5Entry, slPctRaw);
  mt5SL     = enforceMinStop(mt5Symbol, direction, mt5Entry, mt5SL);

  // ── Get optimal TP ────────────────────────────────────────────
  const tpRR = await getOptimalTP(optimizerKey);
  const mt5TP = calcTPPrice(direction, mt5Entry, mt5SL, tpRR);

  // ── Risk & lots ───────────────────────────────────────────────
  const riskPct = getSymbolRiskPct(symKey);
  const riskEUR = calcRiskEUR(symKey);
  const lots    = calcLots(symKey, mt5Entry, mt5SL, riskEUR);

  if (!lots || lots <= 0) {
    logEvent({ type: "REJECTED", reason: "calcLots returned 0", symbol: symKey, direction });
    return res.status(200).json({ status: "LOT_CALC_FAILED" });
  }

  // ── Build MT5 comment (max 26 chars) ─────────────────────────
  const sessShort = session === "london" ? "LON" : session === "ny" ? "NY" : "AS";
  const dirShort  = direction === "buy" ? "B" : "S";
  const comment   = `NV-${dirShort}-${symKey.slice(0,8)}-${tpRR}R-${sessShort}`.slice(0, 26);

  // ── Build MetaApi order ───────────────────────────────────────
  const orderType    = direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
  const orderPayload = {
    symbol:     mt5Symbol,
    actionType: orderType,
    volume:     lots,
    stopLoss:   mt5SL,
    takeProfit: mt5TP,
    comment,
  };

  // ── Place order ───────────────────────────────────────────────
  let result, positionId;
  try {
    result     = await placeOrder(orderPayload);
    positionId = String(result?.positionId ?? result?.orderId ?? `local_${Date.now()}`);
  } catch (e) {
    const errMsg = e.message;
    logEvent({ type: "ERROR", symbol: symKey, direction, reason: errMsg, optimizerKey });
    await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition,
      action, status: "ERROR", reason: errMsg, optimizerKey, entry: mt5Entry,
      sl: mt5SL, tp: mt5TP, lots, riskPct });
    return res.status(200).json({ status: "ORDER_FAILED", error: errMsg });
  }

  // ── Register open position ────────────────────────────────────
  const now = new Date().toISOString();
  openPositions[positionId] = {
    positionId, symbol: symKey, mt5Symbol, direction, vwapPosition,
    optimizerKey, entry: mt5Entry, sl: mt5SL, tp: mt5TP, slPct: slPctRaw,
    lots, riskEUR, riskPct, session, openedAt: now,
    maxPrice: mt5Entry, maxRR: 0, currentPnL: 0,
    vwapAtEntry: vwapMid, tpRRUsed: tpRR,
  };

  // ── Start ghost tracker ───────────────────────────────────────
  startGhostTracker(openPositions[positionId]);

  // ── Log ───────────────────────────────────────────────────────
  const logEntry = {
    type: "ORDER_PLACED", symbol: symKey, direction, session,
    vwapPosition, optimizerKey,
    entry: mt5Entry, sl: mt5SL, tp: mt5TP, tpRR,
    lots, riskPct, riskEUR: riskEUR.toFixed(2),
    positionId, comment,
    tvEntry: closePrice, tvSlPct: slPctRaw, vwap: vwapMid, vwapUpper: vwap_upper, vwapLower: vwap_lower,
  };
  logEvent(logEntry);
  await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition,
    action, status: "PLACED", positionId, optimizerKey,
    entry: mt5Entry, sl: mt5SL, tp: mt5TP, lots, riskPct });

  console.log(`[✓] ${direction.toUpperCase()} ${symKey} | key=${optimizerKey} | entry=${mt5Entry} sl=${mt5SL} tp=${mt5TP} (${tpRR}R) | lots=${lots} | risk=${(riskPct*100).toFixed(2)}%`);

  return res.status(200).json({
    status: "PLACED", positionId, symbol: symKey, direction,
    entry: mt5Entry, sl: mt5SL, tp: mt5TP, tpRR,
    lots, riskPct, riskEUR, optimizerKey,
  });
});

// ── REST API ─────────────────────────────────────────────────────

// Live positions
app.get("/live/positions", async (req, res) => {
  let balance = ACCOUNT_BALANCE;
  try { const info = await fetchAccountInfo(); balance = info?.balance ?? ACCOUNT_BALANCE; } catch {}
  const positions = Object.values(openPositions).map(p => ({
    positionId: p.positionId, symbol: p.symbol, direction: p.direction,
    session: p.session, vwapPosition: p.vwapPosition, optimizerKey: p.optimizerKey,
    entry: p.entry, sl: p.sl, tp: p.tp, lots: p.lots,
    riskPct: p.riskPct, riskEUR: p.riskEUR,
    currentPrice: p.currentPrice, currentPnL: p.currentPnL,
    maxRR: p.maxRR, tpRR: p.tpRRUsed, openedAt: p.openedAt,
    slDistPct: p.sl && p.entry ? parseFloat((Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(2)) : null,
    isGhosted: !!ghostTrackers[p.positionId],
  }));
  res.json({ count: positions.length, balance, positions });
});

// Live ghosts
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

// Ghost trades history
app.get("/ghosts/history", async (req, res) => {
  const { key, limit = 100 } = req.query;
  const rows = await loadGhostTrades(key || null, parseInt(limit));
  res.json({ count: rows.length, rows });
});

// EV table for a key
app.get("/ev/:key", async (req, res) => {
  const ev = await computeEVStats(decodeURIComponent(req.params.key));
  res.json(ev);
});

// EV table for all known keys
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

// Shadow optimizer results
app.get("/shadow", (req, res) => {
  const results = Object.values(shadowResults)
    .sort((a, b) => a.optimizerKey.localeCompare(b.optimizerKey));
  res.json({ count: results.length, results });
});

app.get("/shadow/:key", async (req, res) => {
  const key   = decodeURIComponent(req.params.key);
  const local = shadowResults[key];
  if (local) return res.json(local);
  const rows = await loadShadowAnalysis(key);
  res.json(rows[0] ?? { error: "No data yet for this key" });
});

// TP locks
app.get("/tp-locks", (req, res) => {
  const entries = Object.entries(tpLocks).map(([key, v]) => ({ key, ...v }));
  entries.sort((a, b) => (b.evAtLock ?? 0) - (a.evAtLock ?? 0));
  res.json(entries);
});

// Per-symbol risk config
app.get("/risk-config", (req, res) => {
  const config = Object.keys(SYMBOL_CATALOG).map(sym => ({
    symbol: sym,
    type:   SYMBOL_CATALOG[sym].type,
    riskPct: getSymbolRiskPct(sym),
    riskEUR: parseFloat((getSymbolRiskPct(sym) * ACCOUNT_BALANCE).toFixed(2)),
    envVar:  `RISK_${sym}`,
  }));
  res.json({ balance: ACCOUNT_BALANCE, config });
});

// Webhook history
app.get("/history", (req, res) => {
  res.json(webhookLog.slice(0, 100));
});

// Closed trades
app.get("/trades", (req, res) => {
  const { symbol, session, direction, vwap_pos, limit = 100 } = req.query;
  let filtered = closedTrades;
  if (symbol)    filtered = filtered.filter(t => t.symbol === symbol);
  if (session)   filtered = filtered.filter(t => t.session === session);
  if (direction) filtered = filtered.filter(t => t.direction === direction);
  if (vwap_pos)  filtered = filtered.filter(t => t.vwapPosition === vwap_pos);
  res.json({ count: filtered.length, trades: filtered.slice(0, parseInt(limit)) });
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    version:   "9.0.0",
    time:      getBrusselsDateStr(),
    openPos:   Object.keys(openPositions).length,
    ghosts:    Object.keys(ghostTrackers).length,
    tpLocks:   Object.keys(tpLocks).length,
    closedT:   closedTrades.length,
    balance:   ACCOUNT_BALANCE,
    riskMult:  dailyRiskMult,
    marketOpen: isMarketOpen(),
    session:   getSession(),
  });
});

// ── Dashboard HTML v9.1 ─────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html");

  // Build category matrix for the EV analysis table
  const SESSIONS = ["asia","london","ny"];
  const DIRS     = ["buy","sell"];
  const VWAPS    = ["above","below"];

  const FOREX_SYMBOLS = ["AUDCAD","AUDCHF","AUDNZD","AUDUSD","CADCHF","EURAUD","EURCHF","EURUSD","GBPAUD","GBPNZD","GBPUSD","NZDCAD","NZDCHF","NZDUSD","USDCAD","USDCHF"];
  const INDEX_SYMBOLS = ["DE30EUR","NAS100USD","UK100GBP","US30USD"];
  const COMMODITY_SYMBOLS = ["XAUUSD"];
  const CRYPTO_SYMBOLS = ["BTCUSD"];
  const STOCK_SYMBOLS = ["AAPL","AMD","AMZN","ARM","ASML","AVGO","AZN","BA","BABA","BAC","BRKB","CSCO","CVX","DIS","FDX","GE","GM","GME","GOOGL","IBM","INTC","JNJ","JPM","KO","LMT","MCD","META","MSFT","MSTR","NFLX","NKE","NVDA","PFE","PLTR","QCOM","SBUX","SNOW","T","TSLA","V","WMT","XOM","ZM"];

  const SESSION_LABEL = { asia: "Asia 02-08", london: "London 08-15:30", ny: "NY 15:30-21" };
  const SYMBOL_DISPLAY = {
    DE30EUR:"DAX40 (GER40)", NAS100USD:"NAS100 (US100)", UK100GBP:"UK100 (FTSE)", US30USD:"US30 (Dow)",
    XAUUSD:"Gold (XAUUSD)", BTCUSD:"Bitcoin (BTC)"
  };

  res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v9.1 — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg:      #080c10;
  --bg2:     #0c1117;
  --card:    #0f151c;
  --border:  #1a2535;
  --border2: #243348;
  --text:    #c8d8e8;
  --dim:     #4a6080;
  --dim2:    #2a3d55;
  --green:   #00e5a0;
  --red:     #ff3d5a;
  --gold:    #f0c040;
  --purple:  #b08cff;
  --blue:    #38c0f8;
  --cyan:    #00e5d8;
  --orange:  #ff8c42;
  --scanline: rgba(0,0,0,0.12);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'JetBrains Mono',monospace;font-size:12px;overflow-x:hidden}

/* scanline overlay */
body::before{content:'';position:fixed;top:0;left:0;width:100%;height:100%;background:repeating-linear-gradient(0deg,transparent,transparent 2px,var(--scanline) 2px,var(--scanline) 4px);pointer-events:none;z-index:9999;opacity:.35}

.layout{display:grid;grid-template-rows:auto auto 1fr;min-height:100vh}

/* ── HEADER ── */
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

/* ── KPI BAR ── */
.kpi-bar{display:flex;gap:1px;background:var(--border);border-bottom:1px solid var(--border2);overflow-x:auto}
.kpi{flex:1;min-width:130px;padding:14px 18px;background:var(--bg2);position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;bottom:0;left:0;width:100%;height:2px}
.kpi-open::after{background:var(--blue)}
.kpi-ghosts::after{background:var(--purple)}
.kpi-locks::after{background:var(--gold)}
.kpi-balance::after{background:var(--green)}
.kpi-session::after{background:var(--cyan)}
.kpi-risk::after{background:var(--orange)}
.kpi-label{font-size:9px;letter-spacing:1.5px;color:var(--dim);text-transform:uppercase;margin-bottom:6px;font-family:'Barlow Condensed',sans-serif}
.kpi-val{font-size:22px;font-weight:700;line-height:1;font-family:'Barlow Condensed',sans-serif;letter-spacing:1px}
.kv-blue{color:var(--blue)} .kv-purple{color:var(--purple)} .kv-gold{color:var(--gold)} .kv-green{color:var(--green)} .kv-cyan{color:var(--cyan)} .kv-orange{color:var(--orange)}

/* ── NAV TABS ── */
.nav{display:flex;gap:2px;padding:10px 16px;background:var(--bg2);border-bottom:1px solid var(--border);overflow-x:auto;flex-wrap:nowrap}
.nav-tab{padding:6px 16px;border:1px solid var(--border);border-radius:3px;cursor:pointer;font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:600;letter-spacing:.5px;color:var(--dim);background:none;transition:all .15s;white-space:nowrap}
.nav-tab:hover{color:var(--text);border-color:var(--border2)}
.nav-tab.active{background:var(--blue);color:#060b12;border-color:var(--blue)}
.nav-tab.active-ev{background:var(--gold);color:#060b12;border-color:var(--gold)}

/* ── MAIN CONTENT ── */
.main{padding:16px 20px;overflow-y:auto}
.section{display:none}.section.active{display:block}

/* ── CARDS ── */
.card{background:var(--card);border:1px solid var(--border);border-radius:4px;margin-bottom:14px;overflow:hidden}
.card-head{padding:10px 16px;background:linear-gradient(90deg,#0d1828,#0c1520);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.card-title{font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;letter-spacing:1px;color:var(--blue)}
.card-title.gold{color:var(--gold)}
.card-title.green{color:var(--green)}
.card-title.purple{color:var(--purple)}
.card-meta{font-size:10px;color:var(--dim);letter-spacing:.5px}
.card-body{overflow-x:auto;padding:0}

/* ── TABLES ── */
table{width:100%;border-collapse:collapse;font-size:11px}
th{padding:7px 10px;text-align:left;font-size:9px;letter-spacing:1.2px;color:var(--dim);background:var(--bg2);border-bottom:1px solid var(--border);text-transform:uppercase;font-family:'Barlow Condensed',sans-serif;font-weight:600;white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid var(--dim2);vertical-align:middle;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(56,192,248,0.04)}
.no-data{text-align:center;padding:30px;color:var(--dim);font-size:11px;letter-spacing:1px}

/* ── COLOR CLASSES ── */
.c-green{color:var(--green)} .c-red{color:var(--red)} .c-gold{color:var(--gold)} .c-blue{color:var(--blue)} .c-dim{color:var(--dim)} .c-purple{color:var(--purple)} .c-cyan{color:var(--cyan)} .c-orange{color:var(--orange)}

/* ── BADGES ── */
.badge{display:inline-block;padding:2px 8px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.8px;font-family:'Barlow Condensed',sans-serif}
.b-buy{background:rgba(0,229,160,.15);color:var(--green);border:1px solid rgba(0,229,160,.3)}
.b-sell{background:rgba(255,61,90,.15);color:var(--red);border:1px solid rgba(255,61,90,.3)}
.b-above{background:rgba(56,192,248,.15);color:var(--blue);border:1px solid rgba(56,192,248,.3)}
.b-below{background:rgba(176,140,255,.15);color:var(--purple);border:1px solid rgba(176,140,255,.3)}
.b-sl{background:rgba(255,61,90,.2);color:var(--red)}
.b-tp{background:rgba(0,229,160,.2);color:var(--green)}
.b-manual{background:rgba(240,192,64,.15);color:var(--gold)}
.b-asia{background:rgba(0,229,216,.1);color:var(--cyan)}
.b-london{background:rgba(0,229,160,.1);color:var(--green)}
.b-ny{background:rgba(176,140,255,.1);color:var(--purple)}
.b-ghost{background:rgba(176,140,255,.2);color:var(--purple);border:1px solid rgba(176,140,255,.4)}
.b-locked{background:rgba(240,192,64,.2);color:var(--gold);border:1px solid rgba(240,192,64,.4)}
.b-default{background:rgba(74,96,128,.2);color:var(--dim);border:1px solid var(--border)}

/* ── SL USAGE BAR ── */
.sl-bar-wrap{display:flex;align-items:center;gap:6px;min-width:100px}
.sl-bar-bg{height:4px;flex:1;background:var(--dim2);border-radius:2px;overflow:hidden}
.sl-bar-fill{height:100%;border-radius:2px;background:var(--green);transition:width .3s}
.sl-bar-fill.warn{background:var(--orange)}
.sl-bar-fill.danger{background:var(--red)}

/* ── EV MATRIX TABLE (big category table) ── */
.matrix-wrap{overflow-x:auto;padding:0}
.matrix-table{min-width:900px;font-size:10px}
.matrix-table th.grp{background:var(--bg);border-right:1px solid var(--border2)}
.matrix-table td.cat-label{font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;color:var(--gold);background:var(--bg2);border-right:1px solid var(--border2);white-space:nowrap;min-width:180px;padding:8px 12px}
.matrix-table td.sub-label{font-size:10px;color:var(--blue);background:var(--bg2);border-right:1px solid var(--border2);padding:6px 12px;padding-left:20px}
.matrix-table td.combo{text-align:center;padding:5px 6px;border-right:1px solid var(--dim2)}
.combo-best-rr{font-size:12px;font-family:'Barlow Condensed',sans-serif;font-weight:700}
.combo-wr{font-size:9px;color:var(--dim)}
.combo-ev{font-size:10px;font-weight:600}
.combo-n{font-size:9px;color:var(--dim)}
.ev-pos{color:var(--green)} .ev-neg{color:var(--red)} .ev-zero{color:var(--dim)}
.col-session{text-align:center;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;letter-spacing:.5px;padding:6px 8px}

/* ── OPEN TRADES SPECIFIC ── */
.type-stock{border-left:3px solid var(--blue)}
.type-forex{border-left:3px solid var(--cyan)}
.type-index{border-left:3px solid var(--gold)}
.type-commodity{border-left:3px solid var(--orange)}
.type-crypto{border-left:3px solid var(--purple)}

/* ── CATEGORY PILL ── */
.cat-pill{display:inline-block;padding:1px 7px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.5px;font-family:'Barlow Condensed',sans-serif}
.cat-stock{background:rgba(56,192,248,.12);color:var(--blue)}
.cat-forex{background:rgba(0,229,216,.12);color:var(--cyan)}
.cat-index{background:rgba(240,192,64,.12);color:var(--gold)}
.cat-commodity{background:rgba(255,140,66,.12);color:var(--orange)}
.cat-crypto{background:rgba(176,140,255,.12);color:var(--purple)}

/* ── PNL COLOR ── */
.pnl-pos{color:var(--green);font-weight:600}
.pnl-neg{color:var(--red);font-weight:600}

/* ── SECTION GRID ── */
.section-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:900px){.section-grid{grid-template-columns:1fr}}

/* ── INFO CALLOUT ── */
.callout{background:rgba(56,192,248,.07);border:1px solid rgba(56,192,248,.2);border-radius:3px;padding:10px 14px;font-size:10px;color:var(--dim);margin-bottom:12px;letter-spacing:.3px}
.callout strong{color:var(--blue)}

/* ── FILTER ROW ── */
.filter-row{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center}
.filter-label{font-size:9px;color:var(--dim);letter-spacing:1px;text-transform:uppercase}
.filter-btn{padding:3px 10px;border:1px solid var(--border);background:none;color:var(--dim);border-radius:2px;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10px;transition:all .15s}
.filter-btn.active{border-color:var(--blue);color:var(--blue);background:rgba(56,192,248,.08)}
.filter-btn:hover{color:var(--text)}

/* ── HISTORY TYPE COLORS ── */
.ht-placed{color:var(--green)} .ht-closed{color:var(--blue)} .ht-rejected{color:var(--red)} .ht-error{color:var(--red)} .ht-ghost{color:var(--purple)} .ht-reset{color:var(--gold)} .ht-default{color:var(--dim)}
</style>
</head>
<body>
<div class="layout">

<!-- HEADER -->
<div class="header">
  <div class="header-brand">
    <div>
      <div class="brand-logo">PRONTO-AI</div>
      <div class="brand-ver">v9.1 · TradingView → MetaApi → FTMO MT5</div>
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
  <div class="kpi kpi-open"><div class="kpi-label">Open Pos</div><div class="kpi-val kv-blue" id="kpi-open">—</div></div>
  <div class="kpi kpi-ghosts"><div class="kpi-label">Active Ghosts</div><div class="kpi-val kv-purple" id="kpi-ghosts">—</div></div>
  <div class="kpi kpi-locks"><div class="kpi-label">TP Locks</div><div class="kpi-val kv-gold" id="kpi-locks">—</div></div>
  <div class="kpi kpi-balance"><div class="kpi-label">Balance</div><div class="kpi-val kv-green">€<span id="kpi-balance">—</span></div></div>
  <div class="kpi kpi-session"><div class="kpi-label">Session</div><div class="kpi-val kv-cyan" id="kpi-session" style="font-size:16px;letter-spacing:2px">—</div></div>
  <div class="kpi kpi-risk"><div class="kpi-label">Risk Mult</div><div class="kpi-val kv-orange" id="kpi-riskMult">—</div></div>
</div>

<!-- NAV -->
<div class="nav">
  <button class="nav-tab active" onclick="showTab('positions',this)">📊 OPEN TRADES</button>
  <button class="nav-tab" onclick="showTab('ghosts',this)">👻 GHOSTS</button>
  <button class="nav-tab" onclick="showTab('ev',this)">📈 EV MATRIX</button>
  <button class="nav-tab" onclick="showTab('shadow',this)">🌑 SHADOW SL</button>
  <button class="nav-tab" onclick="showTab('history',this)">📋 HISTORY</button>
  <button class="nav-tab" onclick="showTab('closed',this)">🗂️ CLOSED TRADES</button>
  <button class="nav-tab" onclick="showTab('risk',this)">💰 RISK CONFIG</button>
</div>

<!-- ══════════════════════════════════════════════════════════════ -->
<!-- SECTION: OPEN POSITIONS -->
<!-- ══════════════════════════════════════════════════════════════ -->
<div class="main">

<div id="sec-positions" class="section active">
  <div class="callout">
    <strong>Open Trades</strong> — Categorie, beste TP RR (ghost EV), actieve ghost delta, % SL gebruikt vanaf entry. Entry/SL van TradingView vs MT5 uitvoering getoond als slippage %.
  </div>
  <div class="card">
    <div class="card-head">
      <span class="card-title">📊 OPEN POSITIONS</span>
      <span class="card-meta" id="pos-count">Loading...</span>
    </div>
    <div class="card-body">
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Cat</th>
            <th>Dir</th>
            <th>VWAP</th>
            <th>Session</th>
            <th>TV Entry</th>
            <th>MT5 Entry</th>
            <th>Slip%</th>
            <th>SL</th>
            <th>SL Dist%</th>
            <th>TP (RR)</th>
            <th>Best TP Ghost</th>
            <th>SL Used%</th>
            <th>PnL</th>
            <th>MaxRR Live</th>
            <th>Risk%/Bal</th>
            <th>Ghost?</th>
          </tr>
        </thead>
        <tbody id="pos-body">
          <tr><td colspan="17" class="no-data">Loading positions...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- History section below open trades -->
  <div class="card" style="margin-top:6px">
    <div class="card-head">
      <span class="card-title green">🗂️ RECENT CLOSED TRADES (laatste 20)</span>
      <span class="card-meta">Auto-updated · na close → historiek voor EV matrix</span>
    </div>
    <div class="card-body">
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Cat</th><th>Dir</th><th>VWAP</th><th>Session</th>
            <th>Entry</th><th>SL</th><th>TP RR</th><th>MaxRR</th><th>Ghost MaxRR</th>
            <th>Close Reason</th><th>PnL</th><th>Closed At</th>
          </tr>
        </thead>
        <tbody id="recent-closed-body">
          <tr><td colspan="13" class="no-data">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════ -->
<!-- SECTION: GHOSTS -->
<!-- ══════════════════════════════════════════════════════════════ -->
<div id="sec-ghosts" class="section">
  <div class="callout">
    <strong>Ghost Tracker</strong> — Phantom prijs tracking na trade open. Sluit op phantom SL hit of 23:00. Delta = trueRR − maxRR@close toont hoeveel prijs bewoog NA sluiting.
  </div>
  <div class="section-grid">
    <div class="card">
      <div class="card-head">
        <span class="card-title purple">👻 ACTIVE GHOSTS</span>
        <span class="card-meta" id="ghost-count">—</span>
      </div>
      <div class="card-body">
        <table>
          <thead>
            <tr><th>Optimizer Key</th><th>Dir</th><th>Session</th><th>Entry</th><th>Phantom SL</th><th>Max Price</th><th>MaxRR</th><th>% SL Used</th><th>Elapsed</th></tr>
          </thead>
          <tbody id="ghost-body">
            <tr><td colspan="9" class="no-data">No active ghosts</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-head">
        <span class="card-title gold">📜 GHOST HISTORY (laatste 30)</span>
        <span class="card-meta">phantom_sl · timeout · outside_window</span>
      </div>
      <div class="card-body">
        <table>
          <thead>
            <tr><th>Key</th><th>MaxRR</th><th>TP RR Used</th><th>SL Hit?</th><th>Reden</th><th>Tijd (min)</th><th>Closed</th></tr>
          </thead>
          <tbody id="ghost-hist-body">
            <tr><td colspan="7" class="no-data">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════ -->
<!-- SECTION: EV MATRIX (grote tabel) -->
<!-- ══════════════════════════════════════════════════════════════ -->
<div id="sec-ev" class="section">
  <div class="callout">
    <strong>EV Matrix</strong> — Per categorie (Forex, Index, Commodity, Crypto, Stocks) × sessie (Asia/London/NY) × direction (Buy/Sell) × VWAP positie (Above/Below).
    Toont beste EV RR, winrate, n trades. <strong style="color:var(--gold)">Geel = EV positief en gelockt als TP.</strong>
  </div>

  <!-- FOREX -->
  <div class="card">
    <div class="card-head">
      <span class="card-title">🔷 FOREX — Alle Pairs</span>
      <span class="card-meta">AUDCAD · AUDCHF · AUDNZD · AUDUSD · CADCHF · EURAUD · EURCHF · EURUSD · GBPAUD · GBPNZD · GBPUSD · NZDCAD · NZDCHF · NZDUSD · USDCAD · USDCHF</span>
    </div>
    <div class="matrix-wrap">
      <table class="matrix-table" id="ev-forex"></table>
    </div>
  </div>

  <!-- INDEXES -->
  <div class="card">
    <div class="card-head">
      <span class="card-title gold">📊 INDEXEN</span>
      <span class="card-meta">DAX40 (GER40) · NAS100 (US100) · UK100 (FTSE) · US30 (Dow)</span>
    </div>
    <div class="matrix-wrap">
      <table class="matrix-table" id="ev-index"></table>
    </div>
  </div>

  <!-- COMMODITIES -->
  <div class="card">
    <div class="card-head">
      <span class="card-title" style="color:var(--orange)">🥇 COMMODITIES — GOLD (XAUUSD)</span>
      <span class="card-meta">Asia Buy/Sell × Above/Below VWAP | London Buy/Sell × Above/Below | NY Buy/Sell × Above/Below</span>
    </div>
    <div class="matrix-wrap">
      <table class="matrix-table" id="ev-commodity"></table>
    </div>
  </div>

  <!-- CRYPTO -->
  <div class="card">
    <div class="card-head">
      <span class="card-title purple">₿ CRYPTO — BTCUSD</span>
      <span class="card-meta">Bitcoin · alle sessies</span>
    </div>
    <div class="matrix-wrap">
      <table class="matrix-table" id="ev-crypto"></table>
    </div>
  </div>

  <!-- STOCKS -->
  <div class="card">
    <div class="card-head">
      <span class="card-title">📈 STOCKS — Alle Aandelen</span>
      <span class="card-meta">AAPL · AMD · AMZN · ARM · ASML · AVGO · AZN · BA · BABA · BAC · BRKB · CSCO · CVX · DIS · FDX · GE · GM · GME · GOOGL · IBM · INTC · JNJ · JPM · KO · LMT · MCD · META · MSFT · MSTR · NFLX · NKE · NVDA · PFE · PLTR · QCOM · SBUX · SNOW · T · TSLA · V · WMT · XOM · ZM</span>
    </div>
    <div class="matrix-wrap">
      <table class="matrix-table" id="ev-stocks"></table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════ -->
<!-- SECTION: SHADOW SL -->
<!-- ══════════════════════════════════════════════════════════════ -->
<div id="sec-shadow" class="section">
  <div class="callout">
    <strong>Shadow SL Optimizer</strong> — READ ONLY. Analyseert hoe diep de prijs naar SL bewoog (% gebruikt). p99 = aanbevolen SL grootte. Als prijs nooit binnen 70% van SL came → SL te wijd.
  </div>
  <div class="card">
    <div class="card-head">
      <span class="card-title purple">🌑 SHADOW SL ANALYSE — per Optimizer Key</span>
      <span class="card-meta">Per key: symbol × session × direction × vwap_pos</span>
    </div>
    <div class="card-body">
      <table>
        <thead>
          <tr>
            <th>Optimizer Key</th><th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th>Snapshots</th><th>Posities</th>
            <th>p50 SL%</th><th>p90 SL%</th><th>p99 SL%</th><th>Max SL%</th>
            <th>Rec. SL%</th><th>Te Wijd?</th><th>Besparing%</th>
          </tr>
        </thead>
        <tbody id="shadow-body">
          <tr><td colspan="14" class="no-data">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════ -->
<!-- SECTION: HISTORY (webhook log) -->
<!-- ══════════════════════════════════════════════════════════════ -->
<div id="sec-history" class="section">
  <div class="card">
    <div class="card-head">
      <span class="card-title">📋 WEBHOOK HISTORY (laatste 100)</span>
      <span class="card-meta">ORDER_PLACED · REJECTED · ERROR · POSITION_CLOSED · NIGHTLY_OPTIMIZER</span>
    </div>
    <div class="filter-row">
      <span class="filter-label">Filter:</span>
      <button class="filter-btn active" onclick="filterHistory('all',this)">Alle</button>
      <button class="filter-btn" onclick="filterHistory('ORDER_PLACED',this)">Placed</button>
      <button class="filter-btn" onclick="filterHistory('POSITION_CLOSED',this)">Closed</button>
      <button class="filter-btn" onclick="filterHistory('REJECTED',this)">Rejected</button>
      <button class="filter-btn" onclick="filterHistory('ERROR',this)">Errors</button>
    </div>
    <div class="card-body">
      <table>
        <thead>
          <tr><th>Tijd</th><th>Type</th><th>Symbol</th><th>Cat</th><th>Dir</th><th>VWAP</th><th>Session</th><th>Optimizer Key</th><th>Detail</th></tr>
        </thead>
        <tbody id="hist-body">
          <tr><td colspan="9" class="no-data">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════ -->
<!-- SECTION: CLOSED TRADES (full table) -->
<!-- ══════════════════════════════════════════════════════════════ -->
<div id="sec-closed" class="section">
  <div class="callout">
    <strong>Closed Trades</strong> — Alle afgesloten trades. Reden: tp / sl / manual. MaxRR = beste prijs bereikt voor close. Na close gaan ghost data naar EV matrix.
  </div>
  <div class="card">
    <div class="card-head">
      <span class="card-title green">🗂️ CLOSED TRADES</span>
      <span class="card-meta" id="closed-count">—</span>
    </div>
    <div class="filter-row">
      <span class="filter-label">Sessie:</span>
      <button class="filter-btn active" onclick="filterClosed('session','all',this)">Alle</button>
      <button class="filter-btn" onclick="filterClosed('session','asia',this)">Asia</button>
      <button class="filter-btn" onclick="filterClosed('session','london',this)">London</button>
      <button class="filter-btn" onclick="filterClosed('session','ny',this)">NY</button>
      &nbsp;
      <span class="filter-label">Dir:</span>
      <button class="filter-btn active" onclick="filterClosed('dir','all',this)">Alle</button>
      <button class="filter-btn" onclick="filterClosed('dir','buy',this)">Buy</button>
      <button class="filter-btn" onclick="filterClosed('dir','sell',this)">Sell</button>
    </div>
    <div class="card-body">
      <table>
        <thead>
          <tr>
            <th>Symbol</th><th>Cat</th><th>Dir</th><th>VWAP</th><th>Session</th>
            <th>Entry</th><th>SL</th><th>TP(RR)</th><th>Lots</th><th>Risk%</th>
            <th>MaxRR</th><th>Close</th><th>PnL</th><th>Opened</th><th>Closed</th>
          </tr>
        </thead>
        <tbody id="closed-body">
          <tr><td colspan="15" class="no-data">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════ -->
<!-- SECTION: RISK CONFIG -->
<!-- ══════════════════════════════════════════════════════════════ -->
<div id="sec-risk" class="section">
  <div class="callout">
    Stel <strong>RISK_EURUSD=0.002</strong> in als Railway env var om per symbol te overschrijven. Fallback: RISK_PCT_FOREX / RISK_PCT_STOCK / RISK_PCT_INDEX / RISK_PCT_COMMODITY / RISK_PCT_CRYPTO.
  </div>
  <div class="card">
    <div class="card-head">
      <span class="card-title gold">💰 PER-SYMBOL RISK CONFIG</span>
      <span class="card-meta" id="risk-balance">Balance: —</span>
    </div>
    <div class="filter-row">
      <span class="filter-label">Type:</span>
      <button class="filter-btn active" onclick="filterRisk('all',this)">Alle</button>
      <button class="filter-btn" onclick="filterRisk('forex',this)">Forex</button>
      <button class="filter-btn" onclick="filterRisk('index',this)">Index</button>
      <button class="filter-btn" onclick="filterRisk('commodity',this)">Commodity</button>
      <button class="filter-btn" onclick="filterRisk('crypto',this)">Crypto</button>
      <button class="filter-btn" onclick="filterRisk('stock',this)">Stocks</button>
    </div>
    <div class="card-body">
      <table>
        <thead>
          <tr><th>Symbol</th><th>Type</th><th>Risk %</th><th>Risk €</th><th>Env Var</th></tr>
        </thead>
        <tbody id="risk-body">
          <tr><td colspan="5" class="no-data">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

</div><!-- /main -->
</div><!-- /layout -->

<script>
// ── Config injected from server ──────────────────────────────────
const __CFG__ = \${JSON.stringify({ balance: ACCOUNT_BALANCE, session: getSession(), riskMult: dailyRiskMult })};

// ── State ─────────────────────────────────────────────────────────
let _historyData = [];
let _closedData  = [];
let _riskData    = [];
let _closedFilter = { session: 'all', dir: 'all' };
let _histFilter   = 'all';
let _riskFilter   = 'all';
let _evData       = [];

// ── Helpers ───────────────────────────────────────────────────────
function fmt(v, d=2) { return v != null && !isNaN(v) ? Number(v).toFixed(d) : '—'; }
function fmtPct(v)   { return v != null ? (v*100).toFixed(2)+'%' : '—'; }
function fmtN(v)     { return v != null ? Number(v).toLocaleString('nl-BE') : '—'; }

async function sf(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

function catPill(type) {
  if (!type) return '';
  return '<span class="cat-pill cat-'+type+'">'+type.toUpperCase()+'</span>';
}

function symType(symbol) {
  const FOREX=['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
  const INDEX=['DE30EUR','NAS100USD','UK100GBP','US30USD'];
  const COMM=['XAUUSD'];
  const CRYPT=['BTCUSD'];
  if (FOREX.includes(symbol)) return 'forex';
  if (INDEX.includes(symbol)) return 'index';
  if (COMM.includes(symbol))  return 'commodity';
  if (CRYPT.includes(symbol)) return 'crypto';
  return 'stock';
}

function slBar(pct) {
  if (pct == null) return '—';
  const cls = pct >= 80 ? 'danger' : pct >= 50 ? 'warn' : '';
  return '<div class="sl-bar-wrap"><div class="sl-bar-bg"><div class="sl-bar-fill '+cls+'" style="width:'+Math.min(100,pct)+'%"></div></div><span>'+(+pct).toFixed(0)+'%</span></div>';
}

function sessionBadge(s) {
  const m={'asia':'b-asia','london':'b-london','ny':'b-ny'};
  return '<span class="badge '+(m[s]||'b-default')+'">'+(s||'—').toUpperCase()+'</span>';
}

function closeReasonBadge(r) {
  const m={'tp':'b-tp','sl':'b-sl','manual':'b-manual'};
  return '<span class="badge '+(m[r]||'b-default')+'">'+(r||'—').toUpperCase()+'</span>';
}

function histType(t) {
  if (!t) return '<span class="ht-default">—</span>';
  const m={'ORDER_PLACED':'ht-placed','POSITION_CLOSED':'ht-closed','REJECTED':'ht-rejected','ERROR':'ht-error','GHOST':'ht-ghost','DAILY_RESET':'ht-reset','NIGHTLY_OPTIMIZER':'ht-reset','DUPLICATE_BLOCKED':'ht-ghost'};
  const cls = Object.keys(m).find(k => t.includes(k));
  return '<span class="'+(m[cls]||'ht-default')+'">'+t+'</span>';
}

function shortTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function shortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit'});
}

// ── Tab switching ─────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active','active-ev'));
  document.getElementById('sec-'+name).classList.add('active');
  if (el) el.classList.add(name==='ev' ? 'active-ev' : 'active');
  loadSection(name);
}

async function loadSection(name) {
  if (name==='positions') { await loadPositions(); await loadRecentClosed(); }
  if (name==='ghosts')    { await loadGhosts(); await loadGhostHistory(); }
  if (name==='ev')        await loadEV();
  if (name==='shadow')    await loadShadow();
  if (name==='history')   await loadHistory();
  if (name==='closed')    await loadClosed();
  if (name==='risk')      await loadRisk();
}

// ── POSITIONS ─────────────────────────────────────────────────────
async function loadPositions() {
  const d = await sf('/live/positions');
  if (!d) return;
  document.getElementById('kpi-open').textContent  = d.count;
  document.getElementById('kpi-balance').textContent= (d.balance||0).toFixed(0);
  document.getElementById('pos-count').textContent  = d.count + ' open';

  // Fetch EV data to show best ghost TP
  const evAll = await sf('/ev') || [];

  const b = document.getElementById('pos-body');
  if (!d.positions.length) {
    b.innerHTML='<tr><td colspan="17" class="no-data">Geen open posities</td></tr>';
    return;
  }
  b.innerHTML = d.positions.map(p => {
    const t    = symType(p.symbol);
    const ev   = evAll.find(e => e.key === p.optimizerKey);
    const bestGhostTP = ev?.bestRR != null ? '<span class="c-gold">'+fmt(ev.bestRR,1)+'R</span><br><span class="c-dim" style="font-size:9px">EV='+fmt(ev.bestEV,3)+'</span>' : '<span class="c-dim">< 5 ghosts</span>';
    const slDistPct = p.slDistPct != null ? p.slDistPct+'%' : '—';
    const slip = (p.tvEntry && p.entry) ? ((Math.abs(p.entry - p.tvEntry) / p.tvEntry)*100).toFixed(3)+'%' : '—';
    const tvEntry = p.tvEntry != null ? fmt(p.tvEntry,5) : '—';
    const pnlCls  = (p.currentPnL||0)>=0 ? 'pnl-pos' : 'pnl-neg';
    const slUsed  = p.slPctUsed != null ? slBar(p.slPctUsed) : slBar(null);

    return \`<tr class="type-\${t}">
      <td class="c-blue" style="font-weight:600">\${p.symbol}</td>
      <td>\${catPill(t)}</td>
      <td><span class="badge b-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
      <td><span class="badge b-\${p.vwapPosition}">\${p.vwapPosition}</span></td>
      <td>\${sessionBadge(p.session)}</td>
      <td class="c-dim">\${tvEntry}</td>
      <td>\${fmt(p.entry,5)}</td>
      <td class="c-dim">\${slip}</td>
      <td class="c-red">\${fmt(p.sl,5)}</td>
      <td class="c-dim">\${slDistPct}</td>
      <td class="c-green">\${fmt(p.tp,5)} <span class="c-gold">(\${p.tpRR||'—'}R)</span></td>
      <td>\${bestGhostTP}</td>
      <td>\${slBar(p.slPctUsed)}</td>
      <td class="\${pnlCls}">\${fmt(p.currentPnL,2)}€</td>
      <td class="c-cyan">\${fmt(p.maxRR,2)}R</td>
      <td class="c-gold">\${fmtPct(p.riskPct)}</td>
      <td>\${p.isGhosted?'<span class="badge b-ghost">👻 GHOST</span>':'<span class="c-dim">—</span>'}</td>
    </tr>\`;
  }).join('');
}

// ── RECENT CLOSED (under open trades) ─────────────────────────────
async function loadRecentClosed() {
  const d = await sf('/trades?limit=20');
  if (!d) return;
  const b = document.getElementById('recent-closed-body');
  if (!d.trades.length) { b.innerHTML='<tr><td colspan="13" class="no-data">Geen gesloten trades</td></tr>'; return; }
  b.innerHTML = d.trades.map(h => {
    const t = symType(h.symbol);
    const pnlCls = (h.currentPnL||0)>=0?'pnl-pos':'pnl-neg';
    return \`<tr class="type-\${t}">
      <td class="c-blue">\${h.symbol}</td>
      <td>\${catPill(t)}</td>
      <td><span class="badge b-\${h.direction}">\${h.direction?.toUpperCase()}</span></td>
      <td><span class="badge b-\${h.vwapPosition||'unknown'}">\${h.vwapPosition||'?'}</span></td>
      <td>\${sessionBadge(h.session)}</td>
      <td>\${fmt(h.entry,5)}</td>
      <td class="c-red">\${fmt(h.sl,5)}</td>
      <td class="c-gold">\${h.tpRRUsed||h.tp||'—'}R</td>
      <td class="c-cyan">\${fmt(h.maxRR,2)}R</td>
      <td class="c-purple">\${fmt(h.trueMaxRR,2)}R</td>
      <td>\${closeReasonBadge(h.closeReason)}</td>
      <td class="\${pnlCls}">\${fmt(h.currentPnL,2)}€</td>
      <td class="c-dim">\${shortDate(h.closedAt)} \${shortTs(h.closedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── GHOSTS ────────────────────────────────────────────────────────
async function loadGhosts() {
  const d = await sf('/live/ghosts');
  if (!d) return;
  document.getElementById('kpi-ghosts').textContent = d.count;
  document.getElementById('ghost-count').textContent = d.count + ' actief';
  const b = document.getElementById('ghost-body');
  if (!d.ghosts.length) { b.innerHTML='<tr><td colspan="9" class="no-data">Geen actieve ghosts</td></tr>'; return; }
  b.innerHTML = d.ghosts.map(g => {
    const slPct = g.entry && g.sl ? Math.abs((g.entry-g.sl)/g.entry*100).toFixed(2)+'%' : '—';
    const maxUsed = g.entry && g.sl && g.maxPrice ? 
      (Math.abs(g.entry - g.maxPrice) / Math.abs(g.entry - g.sl) * 100).toFixed(0) + '%' : '—';
    return \`<tr>
      <td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
      <td><span class="badge b-\${g.direction}">\${g.direction?.toUpperCase()}</span></td>
      <td>\${sessionBadge(g.session)}</td>
      <td>\${fmt(g.entry,5)}</td>
      <td class="c-red">\${fmt(g.sl,5)}</td>
      <td>\${fmt(g.maxPrice,5)}</td>
      <td class="c-cyan">\${fmt(g.maxRR,2)}R</td>
      <td>\${slBar(parseFloat(maxUsed))}</td>
      <td class="c-dim">\${g.elapsedMin}m</td>
    </tr>\`;
  }).join('');
}

async function loadGhostHistory() {
  const d = await sf('/ghosts/history?limit=30');
  if (!d) return;
  const b = document.getElementById('ghost-hist-body');
  if (!d.rows.length) { b.innerHTML='<tr><td colspan="7" class="no-data">Geen ghost history</td></tr>'; return; }
  b.innerHTML = d.rows.map(g => {
    const slHit = g.phantomSLHit ? '<span class="c-red">✓ SL</span>' : '<span class="c-dim">—</span>';
    return \`<tr>
      <td style="font-size:9px;color:var(--dim)">\${g.optimizerKey}</td>
      <td class="c-cyan">\${fmt(g.maxRRBeforeSL,2)}R</td>
      <td class="c-gold">\${fmt(g.tpRRUsed,1)}R</td>
      <td>\${slHit}</td>
      <td class="c-dim">\${g.stopReason||'—'}</td>
      <td class="c-dim">\${g.timeToSLMin!=null?g.timeToSLMin+'m':'—'}</td>
      <td class="c-dim" style="font-size:9px">\${shortDate(g.closedAt)} \${shortTs(g.closedAt)}</td>
    </tr>\`;
  }).join('');
}

// ── EV MATRIX ─────────────────────────────────────────────────────
const SESSIONS_M  = ['asia','london','ny'];
const DIRS_M      = ['buy','sell'];
const VWAPS_M     = ['above','below'];
const SESSION_LBL = { asia:'Asia<br>02–08', london:'London<br>08–15:30', ny:'NY<br>15:30–21' };

async function loadEV() {
  const d = await sf('/ev');
  if (!d) return;
  _evData = d;
  document.getElementById('kpi-locks').textContent = d.filter(x=>(x.count||0)>=5 && (x.bestEV||0)>0).length;

  const FOREX=['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
  const INDEX=['DE30EUR','NAS100USD','UK100GBP','US30USD'];
  const COMM=['XAUUSD'];
  const CRYPT=['BTCUSD'];
  const STOCKS=['AAPL','AMD','AMZN','ARM','ASML','AVGO','AZN','BA','BABA','BAC','BRKB','CSCO','CVX','DIS','FDX','GE','GM','GME','GOOGL','IBM','INTC','JNJ','JPM','KO','LMT','MCD','META','MSFT','MSTR','NFLX','NKE','NVDA','PFE','PLTR','QCOM','SBUX','SNOW','T','TSLA','V','WMT','XOM','ZM'];
  const INDEX_DISPLAY = {DE30EUR:'DAX40',NAS100USD:'NAS100',UK100GBP:'UK100',US30USD:'US30'};

  function renderMatrix(symbols, tableId, displayNames) {
    const el = document.getElementById(tableId);
    if (!el) return;

    // Build EV lookup: key -> ev data
    const lookup = {};
    for (const ev of _evData) lookup[ev.key] = ev;

    // Header: symbol | buy-above | buy-below | sell-above | sell-below per session
    const colGroups = [];
    for (const s of SESSIONS_M) {
      for (const dr of DIRS_M) {
        for (const vw of VWAPS_M) {
          colGroups.push({s,dr,vw});
        }
      }
    }

    // Simplified 2-level header
    let thead = '<thead>';
    // Row 1: sessions spanning 4 cols each
    thead += '<tr><th class="grp" style="min-width:160px;position:sticky;left:0;z-index:2">Symbol</th>';
    for (const s of SESSIONS_M) {
      const lbl = {asia:'🌏 ASIA',london:'🇬🇧 LONDON',ny:'🇺🇸 NY'}[s];
      thead += \`<th colspan="4" class="col-session" style="border-left:1px solid var(--border2);background:var(--bg2)">\${lbl}</th>\`;
    }
    thead += '</tr>';
    // Row 2: buy/sell × above/below per session
    thead += '<tr><th class="grp" style="position:sticky;left:0;z-index:2;background:var(--bg2)">↳ bestRR / WR% / EV / n</th>';
    for (const s of SESSIONS_M) {
      for (const dr of DIRS_M) {
        const dc = dr==='buy'?'c-green':'c-red';
        for (const vw of VWAPS_M) {
          const vc = vw==='above'?'c-blue':'c-purple';
          thead += \`<th style="text-align:center;font-size:9px;border-left:\${vw==='above'?'1px solid var(--border2)':'none'}">
            <span class="\${dc}">\${dr.toUpperCase()}</span><br>
            <span class="\${vc}" style="font-size:8px">\${vw}</span>
          </th>\`;
        }
      }
    }
    thead += '</tr></thead>';

    let tbody = '<tbody>';
    for (const sym of symbols) {
      const label = (displayNames && displayNames[sym]) ? displayNames[sym] : sym;
      tbody += \`<tr><td class="cat-label" style="position:sticky;left:0;z-index:1">\${label}</td>\`;
      for (const {s,dr,vw} of colGroups) {
        const key  = sym+'_'+s+'_'+dr+'_'+vw;
        const ev   = lookup[key];
        const borderLeft = vw==='above' ? 'border-left:1px solid var(--border2);' : '';
        if (!ev || !ev.count) {
          tbody += \`<td class="combo" style="\${borderLeft}"><span class="c-dim" style="font-size:9px">—</span></td>\`;
        } else {
          const evPos = (ev.bestEV||0) > 0;
          const evNeg = (ev.bestEV||0) < 0;
          const evCls = evPos ? 'ev-pos' : evNeg ? 'ev-neg' : 'ev-zero';
          const locked = ev.count >= 5 && evPos;
          const bg = locked ? 'background:rgba(240,192,64,0.07);' : '';
          const wr = ev.bestRR != null && ev.count > 0 ? '—' : '—'; // WR not in ev endpoint directly
          tbody += \`<td class="combo" style="\${borderLeft}\${bg}">
            <div class="combo-best-rr \${evCls}">\${ev.bestRR!=null?fmt(ev.bestRR,1)+'R':'—'}</div>
            <div class="combo-ev \${evCls}">\${ev.bestEV!=null?fmt(ev.bestEV,3):'—'}</div>
            <div class="combo-n c-dim">n=\${ev.count||0}\${locked?'<span class="c-gold"> ★</span>':''}</div>
          </td>\`;
        }
      }
      tbody += '</tr>';
    }
    tbody += '</tbody>';

    el.innerHTML = thead + tbody;
  }

  renderMatrix(FOREX,  'ev-forex',     null);
  renderMatrix(INDEX,  'ev-index',     {DE30EUR:'DAX40 (GER40)',NAS100USD:'NAS100 (US100)',UK100GBP:'UK100 (FTSE)',US30USD:'US30 (Dow)'});
  renderMatrix(COMM,   'ev-commodity', {XAUUSD:'Gold (XAUUSD)'});
  renderMatrix(CRYPT,  'ev-crypto',    {BTCUSD:'Bitcoin (BTCUSD)'});
  renderMatrix(STOCKS, 'ev-stocks',    null);
}

// ── SHADOW ────────────────────────────────────────────────────────
async function loadShadow() {
  const d = await sf('/shadow');
  if (!d) return;
  const b = document.getElementById('shadow-body');
  if (!d.results.length) { b.innerHTML='<tr><td colspan="14" class="no-data">Geen shadow data — open posities met snapshots nodig</td></tr>'; return; }
  b.innerHTML = d.results.map(s => {
    const tooWide = s.currentSlTooWide;
    return \`<tr>
      <td style="font-size:9px;color:var(--dim)">\${s.optimizerKey}</td>
      <td class="c-blue">\${s.symbol||'—'}</td>
      <td>\${sessionBadge(s.session)}</td>
      <td><span class="badge b-\${s.direction}">\${(s.direction||'').toUpperCase()}</span></td>
      <td><span class="badge b-\${s.vwapPosition||'unknown'}">\${s.vwapPosition||'?'}</span></td>
      <td>\${fmtN(s.snapshotsCount)}</td>
      <td>\${fmtN(s.positionsCount)}</td>
      <td>\${fmt(s.p50,1)}%</td>
      <td>\${fmt(s.p90,1)}%</td>
      <td class="c-gold">\${fmt(s.p99,1)}%</td>
      <td class="c-red">\${fmt(s.maxUsed,1)}%</td>
      <td class="c-cyan">\${s.recommendedSlPct!=null?(s.recommendedSlPct*100).toFixed(0)+'%':'—'}</td>
      <td>\${tooWide?'<span class="c-red">⚠ TE WIJD</span>':'<span class="c-green">OK</span>'}</td>
      <td class="c-gold">\${s.potentialSavingPct!=null?s.potentialSavingPct+'%':'—'}</td>
    </tr>\`;
  }).join('');
}

// ── HISTORY ───────────────────────────────────────────────────────
async function loadHistory() {
  const d = await sf('/history');
  if (!d) return;
  _historyData = d;
  renderHistory();
}

function filterHistory(f, el) {
  _histFilter = f;
  document.querySelectorAll('#sec-history .filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderHistory();
}

function renderHistory() {
  const data = _histFilter === 'all' ? _historyData : _historyData.filter(h => (h.type||'').includes(_histFilter));
  const b = document.getElementById('hist-body');
  if (!data.length) { b.innerHTML='<tr><td colspan="9" class="no-data">Geen events</td></tr>'; return; }
  b.innerHTML = data.slice(0,100).map(h => {
    const t = symType(h.symbol||'');
    return \`<tr>
      <td class="c-dim">\${shortTs(h.ts)}</td>
      <td>\${histType(h.type)}</td>
      <td class="c-blue">\${h.symbol||'—'}</td>
      <td>\${catPill(t)}</td>
      <td>\${h.direction?'<span class="badge b-'+h.direction+'">'+h.direction.toUpperCase()+'</span>':'—'}</td>
      <td>\${h.vwapPosition?'<span class="badge b-'+h.vwapPosition+'">'+h.vwapPosition+'</span>':'—'}</td>
      <td>\${sessionBadge(h.session)}</td>
      <td style="font-size:9px;color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis">\${h.optimizerKey||'—'}</td>
      <td style="font-size:9px;color:var(--dim)">\${h.reason||h.entry||''}</td>
    </tr>\`;
  }).join('');
}

// ── CLOSED TRADES ─────────────────────────────────────────────────
async function loadClosed() {
  const d = await sf('/trades?limit=200');
  if (!d) return;
  _closedData = d.trades || [];
  document.getElementById('closed-count').textContent = d.count + ' trades';
  renderClosed();
}

function filterClosed(type, val, el) {
  _closedFilter[type] = val;
  // reset active on sibling buttons of same group
  el.parentElement.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderClosed();
}

function renderClosed() {
  let data = _closedData;
  if (_closedFilter.session !== 'all') data = data.filter(t => t.session === _closedFilter.session);
  if (_closedFilter.dir    !== 'all') data = data.filter(t => t.direction === _closedFilter.dir);
  const b = document.getElementById('closed-body');
  if (!data.length) { b.innerHTML='<tr><td colspan="15" class="no-data">Geen trades</td></tr>'; return; }
  b.innerHTML = data.map(h => {
    const t = symType(h.symbol);
    const pnlCls = (h.currentPnL||0)>=0?'pnl-pos':'pnl-neg';
    return \`<tr class="type-\${t}">
      <td class="c-blue" style="font-weight:600">\${h.symbol}</td>
      <td>\${catPill(t)}</td>
      <td><span class="badge b-\${h.direction}">\${h.direction?.toUpperCase()}</span></td>
      <td><span class="badge b-\${h.vwapPosition||'unknown'}">\${h.vwapPosition||'?'}</span></td>
      <td>\${sessionBadge(h.session)}</td>
      <td>\${fmt(h.entry,5)}</td>
      <td class="c-red">\${fmt(h.sl,5)}</td>
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

// ── RISK CONFIG ───────────────────────────────────────────────────
async function loadRisk() {
  const d = await sf('/risk-config');
  if (!d) return;
  _riskData = d.config || [];
  document.getElementById('risk-balance').textContent = 'Balance: €' + (d.balance||0).toLocaleString('nl-BE');
  renderRisk();
}

function filterRisk(f, el) {
  _riskFilter = f;
  document.querySelectorAll('#sec-risk .filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderRisk();
}

function renderRisk() {
  let data = _riskData;
  if (_riskFilter !== 'all') data = data.filter(r => r.type === _riskFilter);
  const b = document.getElementById('risk-body');
  b.innerHTML = data.map(c => \`<tr>
    <td class="c-blue">\${c.symbol}</td>
    <td>\${catPill(c.type)}</td>
    <td class="c-gold">\${(c.riskPct*100).toFixed(3)}%</td>
    <td class="c-green">€\${c.riskEUR}</td>
    <td style="font-size:9px;color:var(--dim)">\${c.envVar}</td>
  </tr>\`).join('');
}

// ── CLOCK & SESSION BADGE ─────────────────────────────────────────
function updateClock() {
  const d = new Date().toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('clock').textContent = d;
}
setInterval(updateClock, 1000);
updateClock();

// ── GLOBAL LOAD ───────────────────────────────────────────────────
async function loadAll() {
  const h = await sf('/health');
  if (h) {
    const s = h.session || 'outside';
    document.getElementById('kpi-session').textContent  = s.toUpperCase();
    document.getElementById('kpi-riskMult').textContent = 'x' + (h.riskMult||1).toFixed(2);
    document.getElementById('kpi-locks').textContent    = h.tpLocks;
    document.getElementById('kpi-ghosts').textContent   = h.ghosts;
    document.getElementById('kpi-open').textContent     = h.openPos;

    // Session badge in header
    const hdrBadge = document.getElementById('hdr-session');
    hdrBadge.className = 'session-badge s-' + s;
    hdrBadge.textContent = {asia:'⛩ ASIA',london:'🇬🇧 LONDON',ny:'🇺🇸 NEW YORK',outside:'⏸ OUTSIDE'}[s] || s.toUpperCase();
  }
  const active = document.querySelector('.section.active')?.id?.replace('sec-','');
  if (active) await loadSection(active);
}

document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  setInterval(loadAll, 30000);
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

  console.log("🚀 PRONTO-AI v9.0 starting...");
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

  // Load + seed symbol risk config from env vars
  const dbRisk = await loadSymbolRiskConfig();
  Object.assign(symbolRiskMap, dbRisk);
  for (const sym of Object.keys(SYMBOL_CATALOG)) {
    const envKey = `RISK_${sym}`;
    if (process.env[envKey]) {
      const pct = parseFloat(process.env[envKey]);
      symbolRiskMap[sym] = pct;
      await upsertSymbolRisk(sym, pct);
    }
  }
  console.log(`💰 Symbol risk config: ${Object.keys(symbolRiskMap).length} overrides`);

  // Load daily risk multiplier
  const dr = await loadLatestDailyRisk();
  if (dr) { dailyRiskMult = dr.riskMultNext ?? 1.0; }
  console.log(`📊 Daily risk multiplier: x${dailyRiskMult.toFixed(2)}`);

  // Restore positions from MT5
  await restorePositionsFromMT5();

  app.listen(PORT, () => {
    console.log(`[✓] Server v9.0 on port ${PORT}`);
    console.log(`   🔹 Dashboard:   /dashboard`);
    console.log(`   🔹 Health:      /health`);
    console.log(`   🔹 EV Table:    /ev`);
    console.log(`   🔹 Shadow SL:   /shadow`);
    console.log(`   🔹 TP Locks:    /tp-locks`);
    console.log(`   🔹 Risk Config: /risk-config`);
    console.log(`   🔹 Webhook:     POST /webhook?secret=<secret>`);
  });
}

start().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
