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

// ── Dashboard HTML ────────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v9.0</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0a0f1a;--card:#111827;--border:#1e2d42;--text:#e2e8f0;--dim:#64748b;--green:#00e396;--red:#ff4560;--gold:#f0c040;--purple:#a78bfa;--blue:#38bdf8;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--text);font-family:"Inter",sans-serif;font-size:13px;padding:20px;}
  h1{font-size:20px;font-weight:700;margin-bottom:4px;}
  .sub{color:var(--dim);font-size:11px;margin-bottom:20px;}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;}
  .kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px 20px;min-width:140px;}
  .kpi-val{font-size:24px;font-weight:700;margin-top:4px;}
  .kpi-label{color:var(--dim);font-size:11px;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;overflow-x:auto;}
  .card h2{font-size:14px;font-weight:600;margin-bottom:12px;color:var(--blue);}
  table{width:100%;border-collapse:collapse;}
  th{background:#0d1829;padding:7px 10px;text-align:left;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border);}
  td{padding:6px 10px;border-bottom:1px solid var(--border);}
  tr:hover td{background:#131f30;}
  .c-green{color:var(--green);} .c-red{color:var(--red);} .c-gold{color:var(--gold);} .c-blue{color:var(--blue);} .c-dim{color:var(--dim);}
  .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;}
  .b-buy{background:#00e39620;color:var(--green);} .b-sell{background:#ff456020;color:var(--red);}
  .b-above{background:#38bdf820;color:var(--blue);} .b-below{background:#a78bfa20;color:var(--purple);}
  .tabs{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
  .tab{padding:6px 14px;border-radius:6px;border:1px solid var(--border);cursor:pointer;font-size:12px;background:var(--card);}
  .tab.active{background:var(--blue);color:#0a0f1a;border-color:var(--blue);}
  #clock{font-size:11px;color:var(--dim);float:right;}
  .progress{height:4px;background:#1e2d42;border-radius:2px;margin-top:3px;}
  .progress-bar{height:100%;border-radius:2px;background:var(--green);}
  .no-data{text-align:center;padding:20px;color:var(--dim);}
  .section{display:none;} .section.active{display:block;}
  .refresh{background:none;border:1px solid var(--border);color:var(--dim);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;}
  .refresh:hover{color:var(--text);}
</style>
</head>
<body>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
  <div>
    <h1>🤖 PRONTO-AI v9.0</h1>
    <div class="sub">TradingView → MetaApi → FTMO MT5 | Ghost + Shadow Optimizer</div>
  </div>
  <div><span id="clock">--:--:--</span> &nbsp;<button class="refresh" onclick="loadAll()">↻ Refresh</button></div>
</div>

<div class="kpi-row">
  <div class="kpi"><div class="kpi-label">Open Positions</div><div class="kpi-val c-blue" id="kpi-open">-</div></div>
  <div class="kpi"><div class="kpi-label">Active Ghosts</div><div class="kpi-val c-purple" id="kpi-ghosts">-</div></div>
  <div class="kpi"><div class="kpi-label">TP Locks</div><div class="kpi-val c-gold" id="kpi-locks">-</div></div>
  <div class="kpi"><div class="kpi-label">Balance</div><div class="kpi-val c-green">€<span id="kpi-balance">-</span></div></div>
  <div class="kpi"><div class="kpi-label">Session</div><div class="kpi-val" id="kpi-session" style="font-size:15px">-</div></div>
  <div class="kpi"><div class="kpi-label">Risk Mult</div><div class="kpi-val c-gold" id="kpi-riskMult">-</div></div>
</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('positions')">Positions</button>
  <button class="tab" onclick="showTab('ghosts')">Ghosts</button>
  <button class="tab" onclick="showTab('ev')">EV Table</button>
  <button class="tab" onclick="showTab('shadow')">Shadow SL</button>
  <button class="tab" onclick="showTab('history')">History</button>
  <button class="tab" onclick="showTab('risk')">Risk Config</button>
</div>

<!-- Positions -->
<div id="sec-positions" class="section active">
  <div class="card">
    <h2>📊 Open Positions</h2>
    <table><thead>
      <tr><th>Symbol</th><th>Dir</th><th>VWAP</th><th>Session</th><th>Entry</th><th>SL</th><th>TP (RR)</th><th>Lots</th><th>Risk%</th><th>PnL</th><th>MaxRR</th><th>Ghost</th></tr>
    </thead><tbody id="pos-body"><tr><td colspan="12" class="no-data">Loading...</td></tr></tbody></table>
  </div>
</div>

<!-- Ghosts -->
<div id="sec-ghosts" class="section">
  <div class="card">
    <h2>👻 Active Ghost Trackers</h2>
    <table><thead>
      <tr><th>Key</th><th>Entry</th><th>Phantom SL</th><th>Max Price</th><th>Max RR</th><th>Elapsed</th></tr>
    </thead><tbody id="ghost-body"><tr><td colspan="6" class="no-data">Loading...</td></tr></tbody></table>
  </div>
</div>

<!-- EV Table -->
<div id="sec-ev" class="section">
  <div class="card">
    <h2>📈 EV Table — Ghost Optimizer Results</h2>
    <table><thead>
      <tr><th>Key</th><th>Ghosts</th><th>Best RR</th><th>Best EV</th><th>TP Lock</th><th>EV+</th></tr>
    </thead><tbody id="ev-body"><tr><td colspan="6" class="no-data">Loading...</td></tr></tbody></table>
  </div>
</div>

<!-- Shadow SL -->
<div id="sec-shadow" class="section">
  <div class="card">
    <h2>🌑 Shadow SL Optimizer — READ ONLY</h2>
    <table><thead>
      <tr><th>Key</th><th>Snaps</th><th>Pos</th><th>p50%</th><th>p90%</th><th>p99%</th><th>Max%</th><th>Rec. SL%</th><th>Too Wide?</th><th>Saving%</th></tr>
    </thead><tbody id="shadow-body"><tr><td colspan="10" class="no-data">Loading...</td></tr></tbody></table>
  </div>
</div>

<!-- History -->
<div id="sec-history" class="section">
  <div class="card">
    <h2>📋 Webhook History</h2>
    <table><thead>
      <tr><th>Time</th><th>Type</th><th>Symbol</th><th>Dir</th><th>VWAP</th><th>Session</th><th>Key</th><th>Status/Detail</th></tr>
    </thead><tbody id="hist-body"><tr><td colspan="8" class="no-data">Loading...</td></tr></tbody></table>
  </div>
</div>

<!-- Risk Config -->
<div id="sec-risk" class="section">
  <div class="card">
    <h2>💰 Per-Symbol Risk Config (Railway env vars)</h2>
    <p style="color:var(--dim);font-size:11px;margin-bottom:10px;">Set <code>RISK_EURUSD=0.002</code> in Railway to override. Shows current effective risk%.</p>
    <table><thead>
      <tr><th>Symbol</th><th>Type</th><th>Risk %</th><th>Risk €</th><th>Env Var</th></tr>
    </thead><tbody id="risk-body"><tr><td colspan="5" class="no-data">Loading...</td></tr></tbody></table>
  </div>
</div>

<script>
window.__CONFIG__ = ${JSON.stringify({ balance: ACCOUNT_BALANCE, session: getSession(), riskMult: dailyRiskMult })};

function showTab(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('sec-' + name).classList.add('active');
  event.target.classList.add('active');
  loadSection(name);
}

function fmt(v, d=2) { return v != null ? Number(v).toFixed(d) : '-'; }
function fmtPct(v)   { return v != null ? (v*100).toFixed(2)+'%' : '-'; }

async function sf(url) {
  try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
}

async function loadSection(name) {
  if (name === 'positions') await loadPositions();
  if (name === 'ghosts')    await loadGhosts();
  if (name === 'ev')        await loadEV();
  if (name === 'shadow')    await loadShadow();
  if (name === 'history')   await loadHistory();
  if (name === 'risk')      await loadRisk();
}

async function loadPositions() {
  const d = await sf('/live/positions'); if (!d) return;
  document.getElementById('kpi-open').textContent = d.count;
  document.getElementById('kpi-balance').textContent = (d.balance||0).toFixed(0);
  const b = document.getElementById('pos-body');
  if (!d.positions.length) { b.innerHTML='<tr><td colspan="12" class="no-data">No open positions</td></tr>'; return; }
  b.innerHTML = d.positions.map(p => \`<tr>
    <td class="c-blue">\${p.symbol}</td>
    <td><span class="badge b-\${p.direction}">\${p.direction.toUpperCase()}</span></td>
    <td><span class="badge b-\${p.vwapPosition}">\${p.vwapPosition}</span></td>
    <td>\${p.session}</td>
    <td>\${fmt(p.entry,5)}</td>
    <td class="c-red">\${fmt(p.sl,5)}</td>
    <td class="c-green">\${fmt(p.tp,5)} (\${p.tpRR}R)</td>
    <td>\${p.lots}</td>
    <td>\${fmtPct(p.riskPct)}</td>
    <td class="\${(p.currentPnL||0)>=0?'c-green':'c-red'}">\${fmt(p.currentPnL,2)}€</td>
    <td>\${fmt(p.maxRR,2)}R</td>
    <td>\${p.isGhosted?'<span class="c-purple">👻</span>':'-'}</td>
  </tr>\`).join('');
}

async function loadGhosts() {
  const d = await sf('/live/ghosts'); if (!d) return;
  document.getElementById('kpi-ghosts').textContent = d.count;
  const b = document.getElementById('ghost-body');
  if (!d.ghosts.length) { b.innerHTML='<tr><td colspan="6" class="no-data">No active ghosts</td></tr>'; return; }
  b.innerHTML = d.ghosts.map(g => \`<tr>
    <td style="font-size:10px">\${g.optimizerKey}</td>
    <td>\${fmt(g.entry,5)}</td>
    <td class="c-red">\${fmt(g.sl,5)}</td>
    <td>\${fmt(g.maxPrice,5)}</td>
    <td class="c-green">\${fmt(g.maxRR,2)}R</td>
    <td class="c-dim">\${g.elapsedMin}m</td>
  </tr>\`).join('');
}

async function loadEV() {
  const d = await sf('/ev'); if (!d) return;
  document.getElementById('kpi-locks').textContent = d.filter(x=>x.count>=5).length;
  const b = document.getElementById('ev-body');
  if (!d.length) { b.innerHTML='<tr><td colspan="6" class="no-data">No ghost data yet</td></tr>'; return; }
  b.innerHTML = d.map(ev => {
    const lock = ev.bestRR != null ? (ev.bestEV>0?'<span class="c-green">✓ LOCKED</span>':'<span class="c-gold">Locked</span>') : '<span class="c-dim">Default 1R</span>';
    const evCls = (ev.bestEV??0)>0?'c-green':(ev.bestEV??0)<0?'c-red':'c-dim';
    return \`<tr>
      <td style="font-size:10px">\${ev.key}</td>
      <td>\${ev.count}</td>
      <td class="c-gold">\${fmt(ev.bestRR,1)}R</td>
      <td class="\${evCls}">\${fmt(ev.bestEV,4)}</td>
      <td>\${lock}</td>
      <td>\${(ev.bestEV??0)>0?'<span class="c-green">✓</span>':'<span class="c-red">✗</span>'}</td>
    </tr>\`;
  }).join('');
}

async function loadShadow() {
  const d = await sf('/shadow'); if (!d) return;
  const b = document.getElementById('shadow-body');
  if (!d.results.length) { b.innerHTML='<tr><td colspan="10" class="no-data">No shadow data yet — needs open positions with snapshots</td></tr>'; return; }
  b.innerHTML = d.results.map(s => \`<tr>
    <td style="font-size:10px">\${s.optimizerKey}</td>
    <td>\${s.snapshotsCount}</td>
    <td>\${s.positionsCount}</td>
    <td>\${fmt(s.p50,1)}%</td>
    <td>\${fmt(s.p90,1)}%</td>
    <td>\${fmt(s.p99,1)}%</td>
    <td>\${fmt(s.maxUsed,1)}%</td>
    <td class="c-gold">\${s.recommendedSlPct!=null?(s.recommendedSlPct*100).toFixed(0)+'%':'-'}</td>
    <td>\${s.currentSlTooWide?'<span class="c-red">YES ⚠</span>':'<span class="c-green">OK</span>'}</td>
    <td>\${s.potentialSavingPct!=null?s.potentialSavingPct+'%':'-'}</td>
  </tr>\`).join('');
}

async function loadHistory() {
  const d = await sf('/history'); if (!d) return;
  const b = document.getElementById('hist-body');
  b.innerHTML = d.slice(0,50).map(h => {
    const t = new Date(h.ts).toLocaleTimeString('nl-BE');
    return \`<tr>
      <td class="c-dim">\${t}</td>
      <td>\${h.type||'-'}</td>
      <td class="c-blue">\${h.symbol||'-'}</td>
      <td>\${h.direction?'<span class="badge b-'+h.direction+'">'+h.direction.toUpperCase()+'</span>':'-'}</td>
      <td>\${h.vwapPosition?'<span class="badge b-'+h.vwapPosition+'">'+h.vwapPosition+'</span>':'-'}</td>
      <td>\${h.session||'-'}</td>
      <td style="font-size:9px">\${h.optimizerKey||'-'}</td>
      <td class="c-dim" style="font-size:10px">\${h.reason||h.entry||''}</td>
    </tr>\`;
  }).join('');
}

async function loadRisk() {
  const d = await sf('/risk-config'); if (!d) return;
  const b = document.getElementById('risk-body');
  b.innerHTML = d.config.map(c => \`<tr>
    <td class="c-blue">\${c.symbol}</td>
    <td class="c-dim">\${c.type}</td>
    <td class="c-gold">\${(c.riskPct*100).toFixed(3)}%</td>
    <td>\${c.riskEUR}€</td>
    <td style="font-size:10px;color:var(--dim)">\${c.envVar}</td>
  </tr>\`).join('');
}

async function loadAll() {
  const h = await sf('/health'); if (h) {
    document.getElementById('kpi-session').textContent = h.session?.toUpperCase()||'-';
    document.getElementById('kpi-riskMult').textContent = 'x'+(h.riskMult||1).toFixed(2);
    document.getElementById('kpi-locks').textContent = h.tpLocks;
  }
  const activeSection = document.querySelector('.section.active')?.id?.replace('sec-','');
  if (activeSection) await loadSection(activeSection);
}

function updateClock() {
  const d = new Date().toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  document.getElementById('clock').textContent = d;
}
setInterval(updateClock, 1000); updateClock();
document.addEventListener('DOMContentLoaded', () => { loadAll(); setInterval(loadAll, 30000); });
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
