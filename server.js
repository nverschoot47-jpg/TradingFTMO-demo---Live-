"use strict";
// ================================================================
// server.js  v2.0.0  |  PRONTO-AI
//
// Flow:
// 1. TradingView webhook → /webhook
//    - symbol filter (XAUUSD / US100 only)
//    - SL + TP calculation (sl_pct × 1.5 × execPrice)
//    - lot calculation (riskEUR / slDist)
//    - placeOrder on MT5 via MetaAPI
//    - start ghost tracker
//    - log to signal_log
//
// 2. syncPositions() every 5s
//    - poll MT5 for open positions
//    - update ghost tracker with current price
//    - track 0.1R milestones (-1.0 → +max)
//    - detect MT5 close (TP or SL)
//    - if MT5 SL: finalize ghost (phantom SL = MT5 SL)
//    - if MT5 TP: keep ghost running until phantom SL
//
// 3. Ghost phantom SL:
//    - price crosses SL level
//    - backfill all ADV milestones proportionally
//    - save to ghost_trades
//    - delete from ghost_state
//
// 4. Dashboard: server.js contains all HTML/JS inline
// ================================================================

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const db = require("./db");
const {
  DEFAULT_RISK_PCT, SL_BUFFER_MULT,
  getBrusselsDateStr, getSession,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey,
  buildDailyLabel, canOpenNewTrade,
} = require("./session");

const VERSION = "2.0.0";

// ── Safe numeric parser (handles NaN, null, undefined, "") ────────
function safeNum(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ── Config from Railway env vars ─────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const META_API_TOKEN = process.env.META_API_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT   || "";
const META_BASE      = process.env.META_BASE
  || "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

// ── App state ────────────────────────────────────────────────────
let dbReady       = false;
let openPositions = new Map();  // positionId → position+ghost object
let latestEquity  = 50000;
let latestCurrency = "USD";
let _acctCache    = null;
let _acctCacheTs  = 0;
let _syncRunning  = false;
let _lastEquitySave = 0;

// ── Express: start immediately so Railway health check passes ────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
// Raw body parser handles NaN from TradingView (invalid JSON)
app.use((req, res, next) => {
  if (req.method === "POST" && req.headers["content-type"]?.includes("application/json")) {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      try {
        const sanitized = raw.replace(/: *NaN/g, ": null").replace(/: *nan/g, ": null");
        req.body = JSON.parse(sanitized);
      } catch { try { req.body = JSON.parse(raw); } catch { req.body = {}; } }
      next();
    });
  } else {
    express.json({ limit: "1mb" })(req, res, next);
  }
});

const server = app.listen(PORT, () => {
  console.log(`[PRONTO-AI v${VERSION}] port ${PORT}`);
});

// ── MetaAPI helpers ───────────────────────────────────────────────
let _metaFails = 0;
let _circuitOpen = false;
let _circuitOpenAt = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS  = 120000;

function circuitOpen() {
  if (!_circuitOpen) return false;
  if (Date.now() - _circuitOpenAt > CIRCUIT_RESET_MS) {
    _circuitOpen = false; _metaFails = 0;
    console.log("[MetaAPI] Circuit reset");
    return false;
  }
  return true;
}

async function metaFetch(path, method = "GET", body = null, retries = 2) {
  if (circuitOpen()) throw new Error("MetaAPI circuit open");
  const url  = `${META_BASE}${path}`;
  const opts = {
    method,
    headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000),
  };
  if (body) opts.body = JSON.stringify(body);
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`${res.status} ${txt.slice(0, 100)}`);
      }
      _metaFails = 0;
      return res.json().catch(() => null);
    } catch (e) {
      if (i < retries) { await new Promise(r => setTimeout(r, 1000 * (i + 1))); continue; }
      _metaFails++;
      if (_metaFails >= CIRCUIT_THRESHOLD) { _circuitOpen = true; _circuitOpenAt = Date.now(); console.error("[MetaAPI] Circuit OPEN"); }
      throw e;
    }
  }
}

async function getAccountInfo() {
  const now = Date.now();
  if (_acctCache && now - _acctCacheTs < 60000) return _acctCache;
  if (!META_API_TOKEN || !META_ACCOUNT) return null;
  try {
    const d = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`);
    if (d?.balance !== undefined) {
      _acctCache = d; _acctCacheTs = now;
      latestEquity   = parseFloat(d.equity ?? d.balance ?? latestEquity);
      latestCurrency = d.currency ?? latestCurrency;
    }
    return d;
  } catch (e) { return _acctCache ?? null; }
}

async function getPositions() {
  if (!META_API_TOKEN || !META_ACCOUNT) return [];
  try {
    const d = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions`);
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function placeOrder(order) {
  return metaFetch(`/users/current/accounts/${META_ACCOUNT}/trade`, "POST", order);
}

async function getDeals(positionId) {
  if (!META_API_TOKEN || !META_ACCOUNT) return [];
  try {
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const to   = new Date().toISOString();
    const d    = await metaFetch(
      `/users/current/accounts/${META_ACCOUNT}/history-deals/position/${positionId}?from=${from}&to=${to}`
    );
    return Array.isArray(d) ? d : (d?.deals ?? []);
  } catch { return []; }
}

// ── Ghost tracker ─────────────────────────────────────────────────
function initGhost(pos) {
  return {
    positionId:    pos.positionId,
    dailyLabel:    pos.dailyLabel,
    optimizerKey:  pos.optimizerKey,
    symbol:        pos.symbol,
    assetType:     pos.assetType,
    direction:     pos.direction,
    session:       pos.session,
    vwapPosition:  pos.vwapPosition,
    entry:         pos.entry,
    sl:            pos.sl,
    tp:            pos.tp,
    lots:          pos.lots,
    riskEur:       pos.riskEur,
    slPct:         pos.slPct,
    slDist:        pos.slDist,
    vwapMid:       pos.vwapMid,
    vwapUpper:     pos.vwapUpper,
    vwapLower:     pos.vwapLower,
    vwapBandPct:   pos.vwapBandPct,
    sessionHigh:   pos.sessionHigh,
    sessionLow:    pos.sessionLow,
    dayHigh:       pos.dayHigh,
    dayLow:        pos.dayLow,
    tvEntry:       pos.tvEntry,
    mt5Comment:    pos.mt5Comment,
    openedAt:      pos.openedAt,
    maxRR:         0,
    peakRRPos:     0,
    peakRRNeg:     0,
    rrMilestones:  {},
    mt5ClosedTP:   false,
    mt5CloseAt:    null,
    mt5CloseReason: null,
    phantomSLHit:  false,
    slHitAt:       null,
    timeToSLMin:   null,
  };
}

function updateGhost(ghost, currentPrice) {
  if (ghost.phantomSLHit) return false; // already done
  const price  = parseFloat(currentPrice);
  const entry  = parseFloat(ghost.entry);
  const sl     = parseFloat(ghost.sl);
  const slDist = Math.abs(entry - sl);
  if (slDist <= 0) return false;
  const isBuy  = ghost.direction === "buy";

  // Favorable RR
  const fav = isBuy ? price - entry : entry - price;
  const rr  = fav / slDist;
  if (rr > ghost.maxRR)     ghost.maxRR     = rr;
  if (rr > ghost.peakRRPos) ghost.peakRRPos = rr;

  // Adverse % (0-100 where 100 = SL hit)
  const adv    = isBuy ? entry - price : price - entry;
  const advPct = Math.max(0, adv / slDist * 100);
  if (advPct > ghost.peakRRNeg) ghost.peakRRNeg = advPct;

  // FAV milestones: +0.1R per step up to 20R
  for (let v = 0.1; v <= 20.0 + 1e-9; v = Math.round((v + 0.1) * 10) / 10) {
    const key = "+" + v.toFixed(1);
    if (!ghost.rrMilestones[key] && rr >= v - 1e-9) {
      ghost.rrMilestones[key] = Date.now();
    }
  }

  // ADV milestones: -0.1R per step
  const advRR = isBuy ? (entry - price) / slDist : (price - entry) / slDist;
  for (let v = 0.1; v <= 1.0 + 1e-9; v = Math.round((v + 0.1) * 10) / 10) {
    const key = "-" + v.toFixed(1);
    if (!ghost.rrMilestones[key] && advRR >= v - 1e-9) {
      ghost.rrMilestones[key] = Date.now();
    }
  }

  // Phantom SL hit?
  const hitSL = isBuy ? price <= sl : price >= sl;
  if (hitSL) {
    ghost.phantomSLHit = true;
    ghost.slHitAt      = new Date().toISOString();
    const openedTs     = ghost.openedAt ? new Date(ghost.openedAt).getTime() : Date.now() - 60000;
    ghost.timeToSLMin  = Math.round((Date.now() - openedTs) / 60000);
    // Backfill all ADV milestones proportionally
    const elapsed = Math.max(1, ghost.timeToSLMin);
    for (let v = 1.0; v >= 0.1 - 1e-9; v = Math.round((v - 0.1) * 10) / 10) {
      const key = "-" + v.toFixed(1);
      if (!ghost.rrMilestones[key]) {
        const ts = openedTs + Math.round(elapsed * v * 60000);
        ghost.rrMilestones[key] = ts;
      }
    }
    return true; // phantom SL just hit
  }
  return false;
}

// Convert milestone timestamps to elapsed strings (e.g. "45m", "1h04m")
function msToElapsed(rrMilestones, openedAt) {
  const openedTs = openedAt ? new Date(openedAt).getTime() : null;
  if (!openedTs) return rrMilestones;
  const result = {};
  for (const [key, val] of Object.entries(rrMilestones)) {
    const tsMs = typeof val === "number" ? val : new Date(val).getTime();
    const elMin = Math.round((tsMs - openedTs) / 60000);
    const el = Math.max(0, elMin);
    if (el < 60) result[key] = el + "m";
    else {
      const h = Math.floor(el / 60), m = el % 60;
      result[key] = h + "h" + (m ? String(m).padStart(2, "0") + "m" : "");
    }
  }
  return result;
}

async function finalizeGhost(ghost) {
  // Convert timestamps to elapsed strings before saving
  const elapsedMilestones = msToElapsed(ghost.rrMilestones, ghost.openedAt);
  await db.saveGhostTrade({
    positionId:     ghost.positionId,
    dailyLabel:     ghost.dailyLabel,
    optimizerKey:   ghost.optimizerKey,
    symbol:         ghost.symbol,
    assetType:      ghost.assetType,
    direction:      ghost.direction,
    session:        ghost.session,
    vwapPosition:   ghost.vwapPosition,
    entry:          ghost.entry,
    sl:             ghost.sl,
    tp:             ghost.tp,
    lots:           ghost.lots,
    riskEur:        ghost.riskEur,
    slPct:          ghost.slPct,
    slDist:         ghost.slDist,
    vwapMid:        ghost.vwapMid,
    vwapUpper:      ghost.vwapUpper,
    vwapLower:      ghost.vwapLower,
    vwapBandPct:    ghost.vwapBandPct,
    sessionHigh:    ghost.sessionHigh,
    sessionLow:     ghost.sessionLow,
    dayHigh:        ghost.dayHigh,
    dayLow:         ghost.dayLow,
    tvEntry:        ghost.tvEntry,
    mt5Comment:     ghost.mt5Comment,
    peakRRPos:      ghost.peakRRPos,
    rrMilestones:   elapsedMilestones,
    timeToSLMin:    ghost.timeToSLMin,
    mt5CloseReason: ghost.mt5CloseReason,
    openedAt:       ghost.openedAt,
    closedAt:       ghost.slHitAt ?? new Date().toISOString(),
  });
  await db.deleteGhostState(ghost.positionId);
  // Keep finalized ghost in memory so dashboard still shows it with SL badge + all milestones
  // It will be removed from memory after 30 minutes (cleanup cron)
  const pos = openPositions.get(ghost.positionId);
  if (pos) {
    pos.finalizedAt = Date.now();
    pos.ghostFinalized = true;
    pos.ghost.finalizedAt = Date.now();
  }
  console.log(`[Ghost] Finalized ${ghost.positionId} ${ghost.symbol} peakRR=${ghost.peakRRPos.toFixed(2)}R SL=${ghost.timeToSLMin}m`);
}

// Finalized ghosts stay in memory until server restarts
// No auto-cleanup — they show as FINISHED in the ghost tracker
// On page reload, ghost history tab loads them from DB
function cleanupFinalizedGhosts() {
  // Intentionally does nothing — FINISHED rows stay visible
}

// ── syncPositions ─────────────────────────────────────────────────
async function syncPositions() {
  if (!dbReady || _syncRunning || circuitOpen()) return;
  _syncRunning = true;
  try {
    // Update equity every ~60s
    const now = Date.now();
    if (now - _acctCacheTs > 60000) {
      const acct = await getAccountInfo();
      if (acct?.equity) {
        latestEquity = parseFloat(acct.equity);
        // Save equity curve every 5 min
        if (now - _lastEquitySave > 300000) {
          _lastEquitySave = now;
          const openPnl = [...openPositions.values()]
            .reduce((s, p) => s + (p.livePnl ?? 0), 0);
          db.saveEquity(acct.balance, acct.equity, openPnl, openPositions.size).catch(() => {});
        }
      }
    }

    const liveMT5 = await getPositions();
    const liveIds = new Set(liveMT5.map(p => String(p.id)));

    // 1. Detect closed MT5 positions — process in parallel for speed
    const closedIds = [...openPositions.keys()].filter(id => !liveIds.has(id));
    await Promise.all(closedIds.map(async id => {
      const pos = openPositions.get(id);
      if (!pos) return;
      let closeReason = "sl";
      try {
        const deals = await getDeals(id);
        const closing = deals
          .filter(d => (d.entryType || "").includes("OUT") || (d.type || "").includes("OUT"))
          .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))[0]
          ?? deals[deals.length - 1];
        if (closing) {
          const r = (closing.reason || "").toUpperCase();
          if (r.includes("TP") || r.includes("TAKE_PROFIT")) {
            closeReason = "tp";
          } else if (r.includes("SL") || r.includes("STOP_LOSS")) {
            closeReason = "sl";
          } else if (closing.profit != null) {
            closeReason = parseFloat(closing.profit) > 0 ? "tp" : "sl";
          }
          if (closing.price) pos._exitPrice = parseFloat(closing.price);
        }
      } catch {}

      // Fallback: compare exit price to TP/SL levels if deals gave no clear answer
      // This is the most reliable method — TP was hit if exit price is near TP
      if (pos._exitPrice && pos.tp && pos.sl) {
        const exitP = pos._exitPrice;
        const tp    = parseFloat(pos.tp);
        const sl    = parseFloat(pos.sl);
        const entry = parseFloat(pos.entry);
        const slDist = Math.abs(entry - sl);
        const tpDist = Math.abs(entry - tp);
        const distToTP = Math.abs(exitP - tp);
        const distToSL = Math.abs(exitP - sl);
        // If exit price is within 10% of SL distance from TP → it was TP
        // If exit price is within 10% of SL distance from SL → it was SL
        if (distToTP < slDist * 0.10) closeReason = "tp";
        else if (distToSL < slDist * 0.10) closeReason = "sl";
        // Also check ghost peak: if peak >= TP RR it definitely hit TP
        const ghost = pos.ghost;
        if (ghost && ghost.peakRRPos >= 1.30) closeReason = "tp";
      } else if (pos.ghost && pos.ghost.peakRRPos >= 1.30) {
        // Peak RR >= 1.45R means TP (set at 1.5R) was almost certainly hit
        closeReason = "tp";
      }

      // Save to closed_trades
      const ghost = pos.ghost;
      await db.saveClosedTrade({
        positionId:     id,
        dailyLabel:     pos.dailyLabel,
        symbol:         pos.symbol,
        assetType:      pos.assetType,
        direction:      pos.direction,
        session:        pos.session,
        vwapPosition:   pos.vwapPosition,
        optimizerKey:   pos.optimizerKey,
        entry:          pos.entry,
        sl:             pos.sl,
        tp:             pos.tp,
        lots:           pos.lots,
        riskPct:        pos.riskPct,
        riskEur:        pos.riskEur,
        slPct:          pos.slPct,
        slPoints:       pos.slPoints,
        slDist:         pos.slDist,
        vwapMid:        pos.vwapMid,
        vwapUpper:      pos.vwapUpper,
        vwapLower:      pos.vwapLower,
        vwapBandPct:    pos.vwapBandPct,
        sessionHigh:    pos.sessionHigh,
        sessionLow:     pos.sessionLow,
        dayHigh:        pos.dayHigh,
        dayLow:         pos.dayLow,
        tvEntry:        pos.tvEntry,
        executionPrice: pos.executionPrice,
        slippage:       pos.slippage,
        exitPrice:      pos._exitPrice ?? null,
        closeReason,
        peakRRPos:      ghost?.peakRRPos ?? 0,
        peakRRNeg:      ghost?.peakRRNeg ?? 0,
        mt5Comment:     pos.mt5Comment,
        openedAt:       pos.openedAt,
        closedAt:       new Date().toISOString(),
      });

      if (closeReason === "sl") {
        // MT5 SL = phantom SL. Force hit and finalize.
        if (ghost && !ghost.phantomSLHit) {
          ghost.phantomSLHit  = true;
          ghost.slHitAt       = new Date().toISOString();
          ghost.timeToSLMin   = Math.round((Date.now() - new Date(ghost.openedAt).getTime()) / 60000);
          const elapsed       = Math.max(1, ghost.timeToSLMin);
          const openedTs      = new Date(ghost.openedAt).getTime();
          for (let v = 1.0; v >= 0.1 - 1e-9; v = Math.round((v - 0.1) * 10) / 10) {
            const key = "-" + v.toFixed(1);
            if (!ghost.rrMilestones[key])
              ghost.rrMilestones[key] = openedTs + Math.round(elapsed * v * 60000);
          }
        }
        ghost.mt5CloseReason = "sl";
        await finalizeGhost(ghost);
      } else {
        // MT5 TP: ghost keeps running, track to phantom SL
        if (ghost) {
          ghost.mt5ClosedTP    = true;
          ghost.mt5CloseAt     = new Date().toISOString();
          ghost.mt5CloseReason = "tp";
          pos.mt5Closed = true;
          await db.saveGhostState(ghost);
          console.log(`[Ghost] MT5 TP hit for ${id} ${pos.symbol} — ghost tracking on`);
        } else {
          openPositions.delete(id);
        }
      }
    })); // end Promise.all closedIds

    // 2. Update existing + adopt new MT5 positions
    for (const lp of liveMT5) {
      const id  = String(lp.id);
      const pos = openPositions.get(id);

      if (!pos) {
        // New position not in memory — adopt it
        await adoptPosition(lp);
        continue;
      }

      // Update live data
      if (lp.volume != null) pos.lots = parseFloat(lp.volume);
      if (lp.currentPrice)   pos.currentPrice = parseFloat(lp.currentPrice);
      const rawPnl = lp.profit ?? lp.unrealizedProfit ?? null;
      if (rawPnl != null) pos.livePnl = parseFloat(rawPnl);

      // Update ghost with current price
      if (pos.ghost && lp.currentPrice) {
        const prevPeak = pos.ghost.peakRRPos;
        const prevMsCount = Object.keys(pos.ghost.rrMilestones).length;
        const justHit = updateGhost(pos.ghost, lp.currentPrice);
        if (justHit) {
          pos.ghost.mt5CloseReason = pos.mt5Closed ? "tp" : "sl";
          await finalizeGhost(pos.ghost);
          continue;
        }
        // Only persist if something changed — avoid hammering DB every 5s
        const changed = pos.ghost.peakRRPos !== prevPeak
          || Object.keys(pos.ghost.rrMilestones).length !== prevMsCount;
        if (changed) await db.saveGhostState(pos.ghost);
      }
    }

    // 3. Ghost-only positions: MT5 TP hit, ghost still tracking to phantom SL
    // Fetch current price via symbol endpoint — works even without open MT5 position
    const ghostOnlySyms = new Set(
      [...openPositions.values()]
        .filter(p => p.mt5Closed && p.ghost && !p.ghost.phantomSLHit)
        .map(p => p.symbol)
    );
    const symPrices = new Map();
    for (const sym of ghostOnlySyms) {
      try {
        const symInfo = getSymbolInfo(sym);
        if (!symInfo) continue;
        const q = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/symbols/${symInfo.mt5}/current-price`);
        if (q?.bid && q?.ask) symPrices.set(sym, { bid: parseFloat(q.bid), ask: parseFloat(q.ask) });
      } catch {}
    }
    for (const [id, pos] of openPositions) {
      if (!pos.mt5Closed || !pos.ghost || pos.ghost.phantomSLHit) continue;
      const prices = symPrices.get(pos.symbol);
      if (!prices) continue;
      const curPrice = pos.direction === "buy" ? prices.bid : prices.ask;
      pos.currentPrice = curPrice;
      const justHit = updateGhost(pos.ghost, curPrice);
      if (justHit) {
        pos.ghost.mt5CloseReason = "tp";
        await finalizeGhost(pos.ghost);
      } else {
        await db.saveGhostState(pos.ghost);
      }
    }

  } finally {
    _syncRunning = false;
  }
}

// ── Adopt MT5 position not in memory ─────────────────────────────
async function adoptPosition(lp) {
  const id     = String(lp.id);
  const rawSym = lp.symbol || "";
  const symbol = normalizeSymbol(rawSym) ?? rawSym;
  const symInfo = getSymbolInfo(symbol);
  if (!symInfo) return; // not one of our pairs

  const lpType  = (lp.type || lp.positionType || "").toString().toUpperCase();
  const isBuy   = lpType.includes("BUY") || lpType === "POSITION_TYPE_BUY";
  const direction = isBuy ? "buy" : "sell";
  const entry   = parseFloat(lp.openPrice ?? lp.currentPrice ?? 0);
  const sl      = parseFloat(lp.stopLoss ?? 0);
  const tp      = parseFloat(lp.takeProfit ?? 0) || null;
  const lots    = parseFloat(lp.volume ?? 0);
  const openedAt = lp.time ? new Date(lp.time).toISOString() : new Date().toISOString();
  const session  = getSession(new Date(openedAt));
  const slDist   = Math.abs(entry - sl);
  const slPct    = entry > 0 && slDist > 0 ? slDist / entry : 0.003;
  // Try to extract vwap position from MT5 comment (e.g. "XAUUSD B-LD-ABV 01/06-#3")
  let vwapPos = "unknown";
  if (lp.comment) {
    if (lp.comment.includes("ABV")) vwapPos = "above";
    else if (lp.comment.includes("BLW")) vwapPos = "below";
  }
  const optimizerKey = buildOptimizerKey(symbol, session, direction, vwapPos);

  const pos = {
    positionId: id,
    dailyLabel:  lp.comment?.match(/\d{2}\/\d{2}-#\d+/)?.[0] ?? null,
    symbol, assetType: symInfo.type, direction,
    session, vwapPosition: "unknown", optimizerKey,
    entry, sl, tp, lots,
    riskPct: DEFAULT_RISK_PCT, riskEur: null,
    slPct, slDist, slPoints: null,
    vwapMid: null, vwapUpper: null, vwapLower: null, vwapBandPct: null,
    sessionHigh: null, sessionLow: null, dayHigh: null, dayLow: null,
    tvEntry: entry, executionPrice: entry, slippage: 0,
    mt5Comment: lp.comment ?? null,
    openedAt,
    currentPrice: parseFloat(lp.currentPrice ?? entry),
    livePnl: parseFloat(lp.profit ?? 0),
    mt5Closed: false,
  };
  pos.ghost = initGhost(pos);
  openPositions.set(id, pos);
  if (dbReady) await db.saveGhostState(pos.ghost);
  console.log(`[Adopt] ${id} ${symbol} ${direction} entry=${entry}`);
}

// ── Webhook secret check ──────────────────────────────────────────
function checkSecret(req, res) {
  if (!WEBHOOK_SECRET) { res.status(401).json({ error: "WEBHOOK_SECRET not set" }); return false; }
  const provided = req.headers["x-webhook-secret"] || req.headers["x-secret"]
    || req.body?.secret || req.query?.secret;
  if (provided !== WEBHOOK_SECRET) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

// Health check (Railway needs this on /)
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHTML());
});
app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHTML());
});
app.get("/health", (req, res) => {
  res.json({
    ok: true, version: VERSION, dbReady,
    openPositions: openPositions.size,
    circuitOpen: _circuitOpen,
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
});
app.get("/status", async (req, res) => {
  const acct = circuitOpen() ? _acctCache : await getAccountInfo().catch(() => _acctCache);
  res.json({
    version: VERSION, dbReady,
    openPositions: openPositions.size,
    account: acct ? { balance: acct.balance, equity: acct.equity, currency: acct.currency } : null,
    ts: new Date().toISOString(),
  });
});

// ── Main webhook ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const t0 = Date.now();
  if (!checkSecret(req, res)) return;
  if (!dbReady) return res.status(503).json({ error: "DB not ready, retry shortly" });

  // Parse all webhook fields
  const body = req.body ?? {};
  const {
    symbol: rawSym,
    direction: _dir, action: _action,
    sl_pct, sl_points,
    vwap, vwap_upper, vwap_lower,
    session_high, session_low,
    day_high, day_low,
  } = body;
  const tvClose = body.close ?? body.entry ?? null;

  const direction = (_dir ?? _action ?? "").toLowerCase().trim();
  if (direction !== "buy" && direction !== "sell") {
    return res.status(400).json({ error: `Invalid direction: "${direction}"` });
  }

  // Symbol filter
  const { allowed, reason: blockReason } = canOpenNewTrade(rawSym);
  if (!allowed) {
    await db.logSignal({
      symbol: rawSym, direction, session: getSession(),
      outcome: blockReason.startsWith("SYMBOL") ? "SYMBOL_NOT_ALLOWED" : "WEEKEND",
      rejectReason: blockReason,
      tvEntry: safeNum(tvClose),
      slPct: safeNum(sl_pct),
      latencyMs: Date.now() - t0,
      slPoints:    safeNum(sl_points),
      vwapMid:     safeNum(vwap),
      vwapUpper:   safeNum(vwap_upper),
      vwapLower:   safeNum(vwap_lower),
      sessionHigh: safeNum(session_high),
      sessionLow:  safeNum(session_low),
      dayHigh:     safeNum(day_high),
      dayLow:      safeNum(day_low),
    });
    return res.json({ ok: false, reason: blockReason });
  }

  const symbol   = normalizeSymbol(rawSym);
  const symInfo  = getSymbolInfo(symbol);
  const session  = getSession();
  const tvEntry  = safeNum(tvClose);
  const vwapMid  = safeNum(vwap);
  const vwapPos  = getVwapPosition(tvEntry, vwapMid);
  const optKey   = buildOptimizerKey(symbol, session, direction, vwapPos);
  const slPct    = safeNum(sl_pct) ?? 0.003;

  // All webhook numeric fields
  // Fallback: session_high/low NaN during Asia → use day_high/low
  const _sH = safeNum(session_high), _sL = safeNum(session_low);
  const wh = {
    slPoints:    safeNum(sl_points),
    vwapUpper:   safeNum(vwap_upper),
    vwapLower:   safeNum(vwap_lower),
    sessionHigh: _sH ?? safeNum(day_high),
    sessionLow:  _sL ?? safeNum(day_low),
    dayHigh:     safeNum(day_high),
    dayLow:      safeNum(day_low),
  };

  // Band%
  let vwapBandPct = null;
  if (tvEntry != null && vwapMid != null && wh.vwapUpper != null) {
    const halfBand = Math.abs(wh.vwapUpper - vwapMid);
    if (halfBand > 0) vwapBandPct = parseFloat(((Math.abs(tvEntry - vwapMid) / halfBand) * 100).toFixed(2));
  }

  // No position limit — unlimited trades allowed

  // Get live equity
  if (!circuitOpen()) {
    const acct = await Promise.race([getAccountInfo(), new Promise(r => setTimeout(() => r(null), 5000))]);
    if (acct?.equity) latestEquity = parseFloat(acct.equity);
  }

  // ── Live MT5 quote ─────────────────────────────────────────────
  let execPrice   = tvEntry ?? 0;
  let spreadAtEntry = null;
  try {
    const q = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/symbols/${symInfo.mt5}/current-price`);
    if (q?.bid && q?.ask) {
      spreadAtEntry = parseFloat((q.ask - q.bid).toFixed(6));
      execPrice     = direction === "buy" ? parseFloat(q.ask) : parseFloat(q.bid);
    }
  } catch {}
  if (!execPrice && tvEntry) execPrice = tvEntry;
  const slippage = tvEntry && execPrice ? Math.abs(execPrice - tvEntry) : 0;

  // ── SL & TP calculation ────────────────────────────────────────
  // slDist = sl_pct × SL_BUFFER_MULT × execPrice
  const slDist  = parseFloat((slPct * SL_BUFFER_MULT * execPrice).toFixed(6));
  const slPrice = direction === "buy"
    ? parseFloat((execPrice - slDist).toFixed(6))
    : parseFloat((execPrice + slDist).toFixed(6));
  const tpRR    = 1.5;
  const tpPrice = direction === "buy"
    ? parseFloat((execPrice + slDist * tpRR).toFixed(6))
    : parseFloat((execPrice - slDist * tpRR).toFixed(6));

  // Lot calculation
  const riskEur  = parseFloat((latestEquity * DEFAULT_RISK_PCT).toFixed(2));
  const lotNom   = slDist > 0 ? riskEur / slDist : 0.01;
  const lots     = symInfo.type === "index"
    ? Math.max(0.01, parseFloat(lotNom.toFixed(2)))
    : Math.max(0.01, parseFloat((lotNom / 100).toFixed(2)));

  // Daily trade number
  const dateStr    = getBrusselsDateStr();
  const dailyCount = await db.getNextDailyCount(dateStr).catch(() => 1);
  const dailyLabel = buildDailyLabel(null, dailyCount);

  // MT5 comment: "XAUUSD B-LD-ABV 01/06-#3"
  const sessMap = { ny: "NY", london: "LD", asia: "AS" };
  const vwapMap = { above: "ABV", below: "BLW", unknown: "UNK" };
  const mt5Comment = `${symbol.slice(0, 6)} ${direction === "buy" ? "B" : "S"}-${sessMap[session] ?? "NY"}-${vwapMap[vwapPos] ?? "UNK"} ${dailyLabel}`;

  console.log(`[Webhook] ${symbol} ${direction.toUpperCase()} | exec=${execPrice} slDist=${slDist.toFixed(4)} (${(slPct * 100).toFixed(3)}%×${SL_BUFFER_MULT}) | lots=${lots} riskEur=${riskEur} | ${dailyLabel}`);

  // ── Place order on MT5 ────────────────────────────────────────
  let positionId;
  try {
    const r = await placeOrder({
      symbol: symInfo.mt5,
      actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume: lots,
      stopLoss: slPrice,
      takeProfit: tpPrice,
      comment: mt5Comment,
    });
    positionId = r?.positionId ?? r?.orderId ?? null;

    // Poll for positionId if not returned
    if (!positionId) {
      const placeTime = Date.now();
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(res => setTimeout(res, 2000));
        const liveNow = await getPositions();
        const match   = liveNow.find(lp => {
          const lpDir = (lp.type || "").includes("BUY") ? "buy" : "sell";
          const ot    = lp.time ? new Date(lp.time).getTime() : 0;
          return lp.symbol === symInfo.mt5 && lpDir === direction
            && ot >= placeTime - 30000 && !openPositions.has(String(lp.id));
        });
        if (match) { positionId = String(match.id); break; }
      }
    }
    if (!positionId) {
      await db.logSignal({ dailyLabel: null, symbol, assetType: symInfo.type, direction, session,
        vwapPosition: vwapPos, optimizerKey: optKey, tvEntry, slPct, vwapMid, vwapBandPct, ...wh,
        outcome: "ORDER_NOT_CONFIRMED", rejectReason: "No positionId from MetaAPI",
        latencyMs: Date.now() - t0 });
      return res.status(202).json({ ok: false, reason: "ORDER_NOT_CONFIRMED" });
    }
  } catch (e) {
    console.error(`[Webhook] placeOrder error: ${e.message}`);
    await db.logSignal({ symbol, assetType: symInfo.type, direction, session,
      vwapPosition: vwapPos, optimizerKey: optKey, tvEntry, slPct, vwapMid, vwapBandPct, ...wh,
      outcome: "ERROR", rejectReason: e.message, latencyMs: Date.now() - t0 });
    return res.status(500).json({ error: e.message });
  }

  // ── Build position + ghost ────────────────────────────────────
  const pos = {
    positionId, dailyLabel, symbol, assetType: symInfo.type,
    direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
    entry: execPrice, sl: slPrice, tp: tpPrice, lots,
    riskPct: DEFAULT_RISK_PCT, riskEur, slPct, slDist,
    tvEntry, executionPrice: execPrice, slippage,
    vwapMid, vwapBandPct, ...wh,
    mt5Comment, openedAt: new Date().toISOString(),
    currentPrice: execPrice, livePnl: 0, mt5Closed: false,
  };
  pos.ghost = initGhost(pos);
  openPositions.set(positionId, pos);

  // Persist ghost state
  await db.saveGhostState(pos.ghost);

  // Log signal as PLACED
  await db.logSignal({
    dailyLabel, symbol, assetType: symInfo.type, direction, session,
    vwapPosition: vwapPos, optimizerKey: optKey,
    tvEntry, slPct, vwapMid, vwapBandPct, ...wh,
    outcome: "PLACED", latencyMs: Date.now() - t0, positionId,
  });

  console.log(`[Placed] ${positionId} ${symbol} ${direction} lots=${lots} entry=${execPrice} sl=${slPrice} tp=${tpPrice} ${dailyLabel}`);
  res.json({
    ok: true, positionId, symbol, direction, lots,
    entry: execPrice, sl: slPrice, tp: tpPrice,
    riskEur, dailyLabel, mt5Comment,
    latencyMs: Date.now() - t0,
  });
});

// ── API endpoints ─────────────────────────────────────────────────
app.get("/api/open-positions", (req, res) => {
  const out = [];
  for (const [id, pos] of openPositions) {
    const g = pos.ghost;
    out.push({
      positionId:    id,
      dailyLabel:    pos.dailyLabel,
      symbol:        pos.symbol,
      assetType:     pos.assetType,
      direction:     pos.direction,
      session:       pos.session,
      vwapPosition:  pos.vwapPosition,
      optimizerKey:  pos.optimizerKey,
      entry:         pos.entry,
      sl:            pos.sl,
      tp:            pos.tp,
      lots:          pos.lots,
      riskEur:       pos.riskEur,
      slPct:         pos.slPct,
      slDist:        pos.slDist,
      tvEntry:       pos.tvEntry,
      vwapMid:       pos.vwapMid,
      vwapUpper:     pos.vwapUpper,
      vwapLower:     pos.vwapLower,
      vwapBandPct:   pos.vwapBandPct,
      sessionHigh:   pos.sessionHigh,
      sessionLow:    pos.sessionLow,
      dayHigh:       pos.dayHigh,
      dayLow:        pos.dayLow,
      mt5Comment:    pos.mt5Comment,
      openedAt:      pos.openedAt,
      currentPrice:  pos.currentPrice ?? null,
      livePnl:       pos.livePnl ?? null,
      mt5Closed:     pos.mt5Closed ?? false,
      ghostFinalized:   pos.ghostFinalized ?? false,
      mt5CloseReason:   pos.ghost?.mt5CloseReason ?? null,
      ghost: g ? {
        maxRR:          g.maxRR,
        peakRRPos:      g.peakRRPos,
        peakRRNeg:      g.peakRRNeg,
        rrMilestones:   msToElapsed(g.rrMilestones, g.openedAt),
        mt5ClosedTP:    g.mt5ClosedTP ?? false,
        phantomSLHit:   g.phantomSLHit,
        mt5CloseReason: g.mt5CloseReason ?? null,
        timeToSLMin:    g.timeToSLMin ?? null,
        slHitAt:        g.slHitAt ?? null,
      } : null,
    });
  }
  res.json(out);
});

app.get("/api/closed-trades", async (req, res) => {
  if (!dbReady) return res.json([]);
  const data = await db.loadClosedTrades(parseInt(req.query.limit) || 200);
  res.json(data);
});

app.get("/api/signal-log", async (req, res) => {
  if (!dbReady) return res.json([]);
  const data = await db.loadSignalLog(parseInt(req.query.limit) || 200);
  res.json(data);
});

app.get("/api/ghost-active", (req, res) => {
  // Same as open-positions but ghost-focused
  res.redirect("/api/open-positions");
});

app.get("/api/ghost-history", async (req, res) => {
  if (!dbReady) return res.json([]);
  const data = await db.loadGhostTrades(req.query.from ?? null, req.query.to ?? null, parseInt(req.query.limit) || 300);
  res.json(data);
});

app.get("/api/equity-curve", async (req, res) => {
  if (!dbReady) return res.json([]);
  res.json(await db.loadEquityCurve(200));
});

app.get("/api/performance", async (req, res) => {
  if (!dbReady) return res.json({});
  const trades = await db.loadClosedTrades(500);
  const tp  = trades.filter(t => t.closeReason === "tp").length;
  const sl  = trades.filter(t => t.closeReason === "sl").length;
  const wr  = trades.length ? (tp / trades.length * 100).toFixed(1) : "0.0";
  const peakAvg = trades.length
    ? (trades.reduce((s, t) => s + (t.peakRRPos || 0), 0) / trades.length).toFixed(2)
    : "0.00";
  res.json({
    total: trades.length, tp, sl, winRate: parseFloat(wr),
    avgPeakRR: parseFloat(peakAvg),
    balance:  latestEquity, currency: latestCurrency,
  });
});

app.get("/api/performance-by-key", async (req, res) => {
  if (!dbReady) return res.json([]);
  res.json(await db.loadPerformanceByKey());
});

// ── DB inspect: check what tables and rows exist ─────────────────
app.get("/api/db-inspect", async (req, res) => {
  try {
    // List all tables
    const tables = await db.pool.query(`
      SELECT tablename, 
        (SELECT COUNT(*) FROM information_schema.columns 
         WHERE table_name = tablename AND table_schema = 'public') AS cols
      FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    const counts = {};
    for (const t of tables.rows) {
      try {
        const r = await db.pool.query(`SELECT COUNT(*) AS n FROM "${t.tablename}"`);
        counts[t.tablename] = parseInt(r.rows[0].n);
      } catch { counts[t.tablename] = -1; }
    }
    // Check if old v14 tables exist
    const oldTables = ['signal_log','closed_trades','ghost_state','ghost_trades',
      'equity_curve','daily_counter',
      // possible old table names from v14:
      'trades','open_positions','ghost_positions','signals','position_log'
    ];
    const existing = {};
    for (const t of oldTables) {
      try {
        const r = await db.pool.query(`SELECT COUNT(*) AS n FROM "${t}" LIMIT 1`);
        existing[t] = parseInt(r.rows[0].n);
      } catch { existing[t] = null; }
    }
    res.json({ tables: counts, oldTableCheck: existing, openPositionsInMemory: openPositions.size });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Migration: pull old ghost data into new schema ────────────────
app.post("/api/migrate-old-data", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const report = { migrated: {}, errors: [] };
  try {
    // Try to read old ghost_state format (v14 had different columns)
    // Check if rr_milestones column exists in ghost_state
    const colCheck = await db.pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ghost_state' AND table_schema = 'public'
    `);
    const cols = colCheck.rows.map(r => r.column_name);
    report.ghost_state_columns = cols;

    // Try to read existing ghost_state rows regardless of schema
    const gs = await db.pool.query(`SELECT * FROM ghost_state LIMIT 200`).catch(() => ({ rows: [] }));
    report.migrated.ghost_state_rows = gs.rows.length;

    // Try to read closed_trades
    const ct = await db.pool.query(`SELECT * FROM closed_trades LIMIT 500`).catch(() => ({ rows: [] }));
    report.migrated.closed_trades_rows = ct.rows.length;

    // Try signal_log
    const sl = await db.pool.query(`SELECT COUNT(*) AS n FROM signal_log`).catch(() => ({ rows: [{ n: 0 }] }));
    report.migrated.signal_log_rows = parseInt(sl.rows[0].n);

    // Try ghost_trades
    const gt = await db.pool.query(`SELECT COUNT(*) AS n FROM ghost_trades`).catch(() => ({ rows: [{ n: 0 }] }));
    report.migrated.ghost_trades_rows = parseInt(gt.rows[0].n);

    // Re-populate openPositions from ghost_state if possible
    let restored = 0;
    for (const row of gs.rows) {
      const id = row.position_id;
      if (!id || openPositions.has(id)) continue;
      try {
        const pos = {
          positionId:   id,
          dailyLabel:   row.daily_label ?? null,
          symbol:       row.symbol ?? "XAUUSD",
          assetType:    row.asset_type ?? "commodity",
          direction:    row.direction ?? "buy",
          session:      row.session ?? "ny",
          vwapPosition: row.vwap_position ?? "unknown",
          optimizerKey: row.optimizer_key ?? "unknown",
          entry:        parseFloat(row.entry ?? 0),
          sl:           parseFloat(row.sl ?? 0),
          tp:           parseFloat(row.tp ?? 0) || null,
          lots:         parseFloat(row.lots ?? 0) || null,
          riskEur:      parseFloat(row.risk_eur ?? 0) || null,
          slPct:        parseFloat(row.sl_pct ?? 0) || null,
          slDist:       parseFloat(row.sl_dist ?? 0) || null,
          vwapMid:      parseFloat(row.vwap_mid ?? 0) || null,
          vwapUpper:    parseFloat(row.vwap_upper ?? 0) || null,
          vwapLower:    parseFloat(row.vwap_lower ?? 0) || null,
          vwapBandPct:  parseFloat(row.vwap_band_pct ?? 0) || null,
          sessionHigh:  parseFloat(row.session_high ?? 0) || null,
          sessionLow:   parseFloat(row.session_low ?? 0) || null,
          dayHigh:      parseFloat(row.day_high ?? 0) || null,
          dayLow:       parseFloat(row.day_low ?? 0) || null,
          tvEntry:      parseFloat(row.tv_entry ?? 0) || null,
          mt5Comment:   row.mt5_comment ?? null,
          openedAt:     row.opened_at?.toISOString?.() ?? new Date().toISOString(),
          currentPrice: parseFloat(row.entry ?? 0),
          livePnl:      0, mt5Closed: row.mt5_closed_tp ?? false,
        };
        pos.ghost = {
          positionId:    id, dailyLabel: pos.dailyLabel,
          optimizerKey:  pos.optimizerKey, symbol: pos.symbol,
          assetType:     pos.assetType, direction: pos.direction,
          session:       pos.session, vwapPosition: pos.vwapPosition,
          entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: pos.lots,
          riskEur: pos.riskEur, slPct: pos.slPct, slDist: pos.slDist,
          vwapMid: pos.vwapMid, vwapUpper: pos.vwapUpper, vwapLower: pos.vwapLower,
          vwapBandPct: pos.vwapBandPct, sessionHigh: pos.sessionHigh,
          sessionLow: pos.sessionLow, dayHigh: pos.dayHigh, dayLow: pos.dayLow,
          tvEntry: pos.tvEntry, mt5Comment: pos.mt5Comment, openedAt: pos.openedAt,
          maxRR:         parseFloat(row.max_rr ?? 0),
          peakRRPos:     parseFloat(row.peak_rr_pos ?? 0),
          peakRRNeg:     parseFloat(row.peak_rr_neg ?? 0),
          rrMilestones:  typeof row.rr_milestones === "object" ? row.rr_milestones : {},
          mt5ClosedTP:   row.mt5_closed_tp ?? false,
          mt5CloseAt:    row.mt5_close_at ?? null,
          mt5CloseReason: row.mt5_closed_tp ? "tp" : null,
          phantomSLHit:  row.phantom_sl_hit ?? false,
          slHitAt:       row.sl_hit_at ?? null,
          timeToSLMin:   row.time_to_sl_min ?? null,
        };
        openPositions.set(id, pos);
        restored++;
      } catch(e) { report.errors.push(`${id}: ${e.message}`); }
    }
    report.restoredToMemory = restored;
    res.json({ ok: true, report });
  } catch(e) {
    res.status(500).json({ error: e.message, report });
  }
});

app.post("/api/force-sync", async (req, res) => {
  if (!checkSecret(req, res)) return;
  await syncPositions();
  res.json({ ok: true, openPositions: openPositions.size });
});

app.post("/api/recover", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const live = await getPositions();
  let adopted = 0;
  for (const lp of live) {
    if (!openPositions.has(String(lp.id))) { await adoptPosition(lp); adopted++; }
  }
  res.json({ ok: true, adopted, total: openPositions.size });
});

// ════════════════════════════════════════════════════════════════
// DASHBOARD HTML — exact structure from preview
// ════════════════════════════════════════════════════════════════
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO·AI v2.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#e6edf3;font-size:12px}
.hdr{background:#161b22;border-bottom:1px solid rgba(139,148,158,.15);padding:6px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;position:sticky;top:0;z-index:100}
.brand{font-size:13px;font-weight:700}.brand span{color:#bc8cff}
.hkv{font-size:10px;color:#8b949e;white-space:nowrap}.hkv b{color:#e6edf3}
.hkv.cg b{color:#3fb950}.hkv.cr b{color:#f85149}.hkv.cb b{color:#388bfd}.hkv.cp b{color:#bc8cff}
.hstat{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:10px}
.dot-g{width:7px;height:7px;border-radius:50%;background:#3fb950;display:inline-block;animation:blink 2s infinite}
.dot-r{width:7px;height:7px;border-radius:50%;background:#f85149;display:inline-block}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
.nav{background:#161b22;border-bottom:1px solid rgba(139,148,158,.15);display:flex;padding:0 14px;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.ntab{padding:9px 14px;font-size:11px;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.ntab:hover{color:#e6edf3}.ntab.on{color:#3fb950;border-bottom-color:#3fb950;font-weight:600}
.nbdg{background:rgba(139,148,158,.15);color:#8b949e;border-radius:8px;padding:1px 5px;font-size:9px;font-weight:600;margin-left:4px}
.pg{display:none;padding:12px 14px}.pg.on{display:block}
.card{background:#161b22;border:1px solid rgba(139,148,158,.15);border-radius:6px;margin-bottom:10px;overflow:hidden}
.chdr{padding:7px 10px;border-bottom:1px solid rgba(139,148,158,.1);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ctitle{font-size:11px;font-weight:600;color:#e6edf3;display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}.dot.g{background:#3fb950}.dot.r{background:#f85149}.dot.b{background:#388bfd}
.cm{margin-left:auto;font-size:9px;color:#6e7681}
.kst{display:grid;gap:6px;padding:8px 10px}
.ks{background:#0d1117;border-radius:4px;padding:6px 10px;border:1px solid rgba(139,148,158,.1)}
.ksl{font-size:9px;color:#8b949e;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.ksv{font-size:16px;font-weight:700;color:#e6edf3}
.balgrid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:10px}
.balcard{padding:10px 12px;background:#0d1117;border-radius:5px;border:1px solid rgba(139,148,158,.1)}
.balcard.eq{border-color:rgba(56,139,253,.3);background:rgba(56,139,253,.04)}
.bll{font-size:9px;color:#8b949e;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.blv{font-size:20px;font-weight:700;color:#e6edf3}.bls{font-size:9px;color:#6e7681;margin-top:2px}
.tw{width:100%;overflow-x:auto}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-size:9px;font-weight:500;color:#6e7681;padding:4px 5px;border-bottom:1px solid rgba(139,148,158,.15);white-space:nowrap;background:#161b22;position:sticky;top:0;z-index:10}
td{padding:4px 5px;border-bottom:1px solid rgba(139,148,158,.08);font-size:10px;vertical-align:middle;white-space:nowrap}
tr:hover td{background:rgba(139,148,158,.04)}
tr:last-child td{border-bottom:none}
.nd{text-align:center;color:#6e7681;padding:20px;font-size:11px}
.adv-th{background:rgba(248,81,73,.07)!important}.fav-th{background:rgba(63,185,80,.07)!important}
.adv-hit{background:rgba(248,81,73,.2)!important}.fav-hit{background:rgba(63,185,80,.2)!important}
.bd{display:inline-flex;align-items:center;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;white-space:nowrap}
.bd-buy{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
.bd-sell{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3)}
.bd-ab{background:rgba(63,185,80,.1);color:#3fb950}.bd-bw{background:rgba(248,81,73,.1);color:#f85149}
.bd-idx{background:rgba(57,211,242,.15);color:#39d3f2;border:1px solid rgba(57,211,242,.3)}
.bd-com{background:rgba(188,140,255,.15);color:#bc8cff;border:1px solid rgba(188,140,255,.3)}
.bd-sl{background:rgba(248,81,73,.2);color:#f85149;border:1px solid rgba(248,81,73,.4)}
.bd-tp{background:rgba(63,185,80,.2);color:#3fb950;border:1px solid rgba(63,185,80,.4)}
.bd-live{background:rgba(63,185,80,.12);color:#3fb950;border:1px solid rgba(63,185,80,.25);padding:2px 7px;font-size:9px;font-weight:700}
.bd-placed{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
.bd-nopos{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3)}
.bd-err{background:rgba(248,81,73,.3);color:#ff4444;border:1px solid #f85149;font-weight:700}
.bd-k{background:rgba(139,148,158,.1);color:#e6edf3;border:1px solid rgba(139,148,158,.25);font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;display:inline-flex}
.cg{color:#3fb950}.cr{color:#f85149}.cb{color:#388bfd}.cp{color:#bc8cff}.cy{color:#d29922}.cd{color:#8b949e}.cw{color:#e6edf3}.fw{font-weight:700}.cb2{color:#39d3f2}
.bd-ny{color:#f0883e;font-size:10px;font-weight:500}.bd-ld{color:#3fb950;font-size:10px;font-weight:500}.bd-as{color:#8b949e;font-size:10px;font-weight:500}
.row-open{background:rgba(56,139,253,.02)!important}.row-slhit{background:rgba(248,81,73,.04)!important}
.divider-label{font-size:9px;color:#6e7681;font-weight:600;text-transform:uppercase;letter-spacing:.4px;padding:5px 10px;display:flex;align-items:center;gap:6px;background:rgba(248,81,73,.05);border-top:1px solid rgba(139,148,158,.15);border-bottom:1px solid rgba(139,148,158,.15)}
.section-sep{display:flex;align-items:center;gap:10px;margin:14px 0 10px}
.section-sep-line{height:1px;flex:1;background:rgba(139,148,158,.15)}
.section-sep-lbl{font-size:9px;color:#6e7681;font-weight:600;text-transform:uppercase;letter-spacing:.4px;padding:0 8px;white-space:nowrap}
::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#0d1117}::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
.segs{display:flex;background:#0d1117;border:1px solid rgba(139,148,158,.2);border-radius:4px;overflow:hidden;margin-left:auto}
.seg{padding:3px 10px;background:none;border:none;color:#6e7681;cursor:pointer;font-size:10px}.seg.on{background:#21262d;color:#e6edf3}
.perf-key-tbl{width:100%;border-collapse:collapse}
.perf-key-tbl th{font-size:8px;color:#6e7681;padding:3px 4px;border-bottom:1px solid rgba(139,148,158,.15);white-space:nowrap;background:#161b22;text-align:center}
.perf-key-tbl td{padding:3px 4px;border-bottom:1px solid rgba(139,148,158,.06);text-align:center;font-size:9px}
.perf-key-tbl td:first-child{text-align:left}
</style>
</head>
<body>
<div class="hdr">
  <div class="brand">PRONTO<span>·</span>AI <span style="font-size:10px;color:#6e7681;font-weight:400">v${VERSION}</span></div>
  <div class="hkv">Balance <b id="h-bal">--</b></div>
  <div class="hkv cg">Unrealized <b id="h-upnl">--</b></div>
  <div class="hkv cg">Realized <b id="h-rpnl">--</b></div>
  <div class="hkv cb">Open MT5 <b id="h-open">--</b></div>
  <div class="hkv cp">Ghost Active <b id="h-ghost">--</b></div>
  <div class="hkv">Finalized <b id="h-fin">--</b></div>
  <div class="hkv cr">Errors <b id="h-err">0</b></div>
  <div class="hkv cb" id="h-db">DB init...</div>
  <div class="hstat">
    <span id="h-sess-dot" class="dot-g"></span>
    <span id="h-sess" style="font-size:10px;color:#8b949e">--</span>
    <span id="h-time" style="font-size:10px;color:#6e7681">--</span>
  </div>
</div>

<div class="nav">
  <div class="ntab on" onclick="go('ov',this)">Overview</div>
  <div class="ntab" onclick="go('sig',this)">Signals<span class="nbdg" id="nb-sig">0</span></div>
  <div class="ntab" onclick="go('gh',this)">Ghost Tracker<span class="nbdg" id="nb-gh" style="background:rgba(188,140,255,.15);color:#bc8cff">0</span></div>
  <div class="ntab" onclick="go('perf',this)">Performance</div>
</div>

<div class="main" style="padding:12px 14px">

<!-- OVERVIEW -->
<div class="pg on" id="p-ov">
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot g"></div>Account Balance</div></div>
    <div class="balgrid">
      <div class="balcard"><div class="bll">Start Balance</div><div class="blv" id="ov-start">--</div><div class="bls">at trading start</div></div>
      <div class="balcard"><div class="bll">+ Realized P&L</div><div class="blv cg" id="ov-real">--</div><div class="bls"><span id="ov-ct">--</span> closed trades</div></div>
      <div class="balcard"><div class="bll">= Cash Balance</div><div class="blv" id="ov-cash">--</div><div class="bls">start + closed</div></div>
      <div class="balcard"><div class="bll">+ Unrealized P&L</div><div class="blv cg" id="ov-unreal">--</div><div class="bls"><span id="ov-oc">--</span> open</div></div>
      <div class="balcard eq"><div class="bll">= Equity (MT5)</div><div class="blv cb" id="ov-equity">--</div></div>
    </div>
  </div>
  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot g"></div>Trades</div>
      <div style="display:flex;gap:6px;margin-left:8px">
        <span style="font-size:9px;background:rgba(56,139,253,.1);color:#388bfd;border:1px solid rgba(56,139,253,.25);padding:1px 6px;border-radius:3px" id="ov-open-badge">0 open</span>
        <span style="font-size:9px;background:rgba(139,148,158,.1);color:#6e7681;border:1px solid rgba(139,148,158,.2);padding:1px 6px;border-radius:3px" id="ov-closed-badge">0 closed</span>
      </div>
      <div class="cm">daily # per Brussels date · resets each day</div>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th>#</th><th>Symbol</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Session</th>
        <th>Entry</th><th style="color:#f85149">SL</th><th style="color:#3fb950">TP</th>
        <th style="color:#388bfd">RR Now</th><th style="color:#3fb950">Peak+</th><th style="color:#f85149">Peak−</th>
        <th>Lots</th><th>MT5 Comment</th><th>Opened</th><th>Closed</th>
      </tr></thead>
      <tbody id="ov-body"><tr><td colspan="16" class="nd">Loading...</td></tr></tbody>
    </table></div>
  </div>
</div>

<!-- SIGNALS -->
<div class="pg" id="p-sig">
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot b"></div>Signal Stats — XAUUSD & US100 only</div></div>
    <div class="kst" style="grid-template-columns:repeat(5,1fr)">
      <div class="ks"><div class="ksl">Total</div><div class="ksv" id="sg-total">0</div></div>
      <div class="ks"><div class="ksl">Placed</div><div class="ksv cg" id="sg-placed">0</div></div>
      <div class="ks"><div class="ksl">Conv%</div><div class="ksv cy" id="sg-conv">0%</div></div>
      <div class="ks"><div class="ksl">No Pos</div><div class="ksv cr" id="sg-nopos">0</div></div>
      <div class="ks" style="background:rgba(248,81,73,.06)"><div class="ksl" style="color:#f85149">Errors</div><div class="ksv cr fw" id="sg-err">0</div></div>
    </div>
  </div>
  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot g"></div>Signal Log</div>
      <div class="cm">Band% always present · Daily# only for PLACED</div>
      <div class="segs">
        <button class="seg on" onclick="filterSig('all',this)">All</button>
        <button class="seg" onclick="filterSig('placed',this)">Placed</button>
        <button class="seg" onclick="filterSig('errors',this)">Errors</button>
      </div>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th>Time</th><th>Daily#</th><th>Symbol</th><th>Type</th><th>Dir</th>
        <th>Session</th><th>VWAP</th>
        <th>TV Entry</th><th>SL%</th><th>SL pts</th>
        <th style="color:#d29922">Band%</th>
        <th>VWAP</th><th>VWAP+</th><th>VWAP-</th>
        <th style="color:#d29922">S.High</th><th style="color:#d29922">S.Low</th>
        <th style="color:#39d3f2">D.High</th><th style="color:#39d3f2">D.Low</th>
        <th>Outcome</th><th>Optimizer Key</th><th>Latency</th>
      </tr></thead>
      <tbody id="sig-body"><tr><td colspan="21" class="nd">Loading...</td></tr></tbody>
    </table></div>
  </div>
</div>

<!-- GHOST TRACKER -->
<div class="pg" id="p-gh">
  <div class="kst" style="grid-template-columns:repeat(8,1fr);margin-bottom:10px">
    <div class="ks"><div class="ksl">Active Ghost</div><div class="ksv" id="gh-active">0</div></div>
    <div class="ks"><div class="ksl">Best Peak+</div><div class="ksv cg fw" id="gh-best">--</div></div>
    <div class="ks"><div class="ksl">Avg Peak+</div><div class="ksv cy" id="gh-avg">--</div></div>
    <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="gh-buy">0</div></div>
    <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="gh-sell">0</div></div>
    <div class="ks"><div class="ksl">SL Today</div><div class="ksv cr" id="gh-sl-today">0</div></div>
    <div class="ks"><div class="ksl">Finalized</div><div class="ksv cp" id="gh-fin">0</div></div>
    <div class="ks"><div class="ksl">Sync</div><div class="ksv" style="font-size:12px;color:#3fb950">5s</div></div>
  </div>
  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot g"></div>Ghost Tracker — -1.0R to +20R per 0.1R · sync 5s</div>
      <div id="gh-badges" style="display:flex;gap:6px;margin-left:8px"></div>
      <div class="cm">● LIVE = MT5 open · GHOST = MT5 TP ghost door · FINISHED = phantom SL</div>
      <div style="display:flex;gap:6px;margin-left:4px">
        <input type="date" id="gh-from" style="background:#0d1117;border:1px solid rgba(139,148,158,.2);color:#e6edf3;padding:2px 6px;border-radius:4px;font-size:10px">
        <input type="date" id="gh-to"   style="background:#0d1117;border:1px solid rgba(139,148,158,.2);color:#e6edf3;padding:2px 6px;border-radius:4px;font-size:10px">
        <button onclick="loadGhostHistory()" style="background:#21262d;border:1px solid rgba(139,148,158,.2);color:#8b949e;padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer">Filter finalized</button>
      </div>
    </div>
    <div class="tw">
      <table id="gh-active-table" style="min-width:4000px">
        <thead><tr id="gh-ms-header"></tr></thead>
        <tbody id="gh-active-body"><tr><td colspan="50" class="nd">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- PERFORMANCE -->
<div class="pg" id="p-perf">
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot b"></div>Overall</div></div>
    <div class="kst" style="grid-template-columns:repeat(7,1fr)" id="perf-overall"></div>
  </div>
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot g"></div>XAUUSD — Milestone Hit Rates per Optimizer Key</div><div class="cm">% ghost trades reaching each 0.1R · from -1.0 to max peak · &lt;5 trades = grayed</div></div>
    <div style="padding:8px;overflow-x:auto" id="perf-xau"></div>
  </div>
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot b"></div>US100.cash — Milestone Hit Rates per Optimizer Key</div><div class="cm">% ghost trades reaching each 0.1R · from -1.0 to max peak · &lt;5 trades = grayed</div></div>
    <div style="padding:8px;overflow-x:auto" id="perf-us100"></div>
  </div>
</div>

</div><!-- /main -->

<script>
'use strict';
const $=id=>document.getElementById(id);
const fmt=(v,d=2)=>v==null||isNaN(v)?'--':Number(v).toFixed(d);
const fmtTs=s=>!s?'--':new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
function bdDir(d){return d==='buy'?'<span class="bd bd-buy">BUY</span>':'<span class="bd bd-sell">SELL</span>';}
function bdType(t){const s=(t||'').toLowerCase();if(s==='commodity'||s==='com')return '<span class="bd bd-com">COM</span>';if(s==='index'||s==='idx')return '<span class="bd bd-idx">IDX</span>';return '<span class="bd" style="background:rgba(139,148,158,.1);color:#8b949e">?</span>';}
function bdVwap(v){return v==='above'?'<span class="bd bd-ab">ABOVE</span>':'<span class="bd bd-bw">BELOW</span>';}
function bdSess(s){const m={ny:'NEW YORK',london:'LONDON',asia:'ASIA'};const c={ny:'bd-ny',london:'bd-ld',asia:'bd-as'};return '<span class="'+(c[s]||'cd')+'">'+(m[s]||s||'--')+'</span>';}
function rrHtml(v){if(v==null||isNaN(v))return '<span class="cd">--</span>';const f=parseFloat(v);if(f>0.005)return '<span class="cg fw">+'+f.toFixed(2)+'R</span>';if(f<-0.005)return '<span class="cr fw">'+f.toFixed(2)+'R</span>';return '<span class="cd">0.00R</span>';}
function rrFromPrice(entry,sl,cur,dir){if(!entry||!sl||!cur)return null;const d=Math.abs(entry-sl);if(!d)return null;return dir==='buy'?(cur-entry)/d:(entry-cur)/d;}
async function api(url){try{const r=await fetch(url);if(!r.ok)return null;return await r.json();}catch{return null;}}

// Clock
function tick(){
  const now=new Date();
  const t=now.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const h=parseInt(now.toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',hour12:false}));
  const m=now.getMinutes();
  const isNY=(h>=15&&h<21)||(h===15&&m>=30),isLD=(h>=8&&h<15)||(h===15&&m<30);
  const sess=isNY?'NEW YORK':isLD?'LONDON':'ASIA';
  if($('h-sess'))$('h-sess').textContent=sess;
  if($('h-time'))$('h-time').textContent=t;
}
setInterval(tick,1000);tick();

// Nav
function go(pg,el){document.querySelectorAll('.pg').forEach(p=>p.classList.remove('on'));document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));const p=$('p-'+pg);if(p)p.classList.add('on');if(el)el.classList.add('on');if(pg==='ov')loadOverview();if(pg==='sig')loadSignals();if(pg==='gh')loadGhostTracker();if(pg==='perf')loadPerf();}

// Milestone columns
const ADV=[];for(let v=1.0;v>=0.1-1e-9;v=Math.round((v-0.1)*10)/10)ADV.push('-'+v.toFixed(1));
const FAV=[];for(let v=0.1;v<=5.0+1e-9;v=Math.round((v+0.1)*10)/10)FAV.push('+'+v.toFixed(1));

function buildMsHeaders(maxFav){
  const f=FAV.filter(k=>parseFloat(k)<=maxFav+0.01);
  return ADV.map(k=>'<th class="adv-th" style="min-width:25px;font-size:7px;text-align:center">'+k+'</th>').join('')
    +f.map(k=>'<th class="fav-th" style="min-width:25px;font-size:7px;text-align:center'+(k==='+1.5'?';color:#bc8cff':'')+'">' +k+'</th>').join('');
}
function buildMsRow(ms,maxFav){
  const f=FAV.filter(k=>parseFloat(k)<=maxFav+0.01);
  return ADV.map(k=>ms[k]?'<td class="adv-hit" style="text-align:center"><span style="color:#f85149;font-size:8px;font-weight:600">'+ms[k]+'</span></td>':'<td class="adv-th" style="text-align:center;opacity:.2;font-size:9px">·</td>').join('')
    +f.map(k=>ms[k]?'<td class="fav-hit" style="text-align:center"><span style="color:#3fb950;font-size:8px;font-weight:600">'+ms[k]+'</span></td>':'<td class="fav-th" style="text-align:center;opacity:.2;font-size:9px">·</td>').join('');
}

// Header / status
async function loadHeader(){
  const [s,pos,fin]= await Promise.all([api('/status'),api('/api/open-positions'),api('/api/ghost-history?limit=1')]);
  if(s){
    if(s.dbReady&&$('h-db'))$('h-db').textContent='DB ready';
    if($('h-open'))$('h-open').textContent=s.openPositions||0;
    if($('nb-gh'))$('nb-gh').textContent=(pos||[]).length;
    if(s.account){
      const b=parseFloat(s.account.balance||0),e=parseFloat(s.account.equity||0);
      if($('h-bal'))$('h-bal').textContent='$'+Math.round(b).toLocaleString();
      const up=e-b;
      if($('h-upnl')){$('h-upnl').textContent=(up>=0?'+':'')+Math.round(up)+' EUR';$('h-upnl').closest('.hkv').className='hkv '+(up>=0?'cg':'cr');}
    }
  }
  if(pos){if($('h-ghost'))$('h-ghost').textContent=pos.length;}
}

// OVERVIEW
async function loadOverview(){
  const [pos,closed]= await Promise.all([api('/api/open-positions'),api('/api/closed-trades')]);
  const _pos=Array.isArray(pos)?pos:[];
  const _cl=Array.isArray(closed)?closed:[];
  if($('ov-open-badge'))$('ov-open-badge').textContent=_pos.length+' open';
  if($('ov-closed-badge'))$('ov-closed-badge').textContent=_cl.length+' closed';
  if($('ov-oc'))$('ov-oc').textContent=_pos.length;
  if($('ov-ct'))$('ov-ct').textContent=_cl.length;
  const body=$('ov-body');if(!body)return;
  const rows=[];
  // OPEN = only MT5 still open (mt5Closed=false)
  const _openMT5 = _pos.filter(p=>!p.mt5Closed && !p.ghostFinalized);
  // MT5 closed but ghost may still run — show in closed section
  const _closedMT5 = _pos.filter(p=>p.mt5Closed || p.ghostFinalized);
  if($('ov-open-badge'))$('ov-open-badge').textContent=_openMT5.length+' open';
  if($('ov-closed-badge'))$('ov-closed-badge').textContent=(_cl.length+_closedMT5.length)+' closed';
  if($('ov-oc'))$('ov-oc').textContent=_openMT5.length;

  for(const p of _openMT5){
    const g=p.ghost||{};
    const rr=rrFromPrice(p.entry,p.sl,p.currentPrice,p.direction);
    // Peak+ / Peak- from MT5 only: use live P&L converted to R
    const slDist=p.sl&&p.entry?Math.abs(p.entry-p.sl):null;
    const livePnlR=slDist&&p.lots&&p.livePnl!=null?(p.livePnl/(slDist*p.lots*(p.assetType==='index'?1:100))):null;
    rows.push('<tr class="row-open"><td><span class="bd-k">'+(p.dailyLabel||'--')+'</span></td><td class="cw fw">'+p.symbol+'</td><td>'+bdType(p.assetType)+'</td><td>'+bdDir(p.direction)+'</td><td>'+bdVwap(p.vwapPosition)+'</td><td>'+bdSess(p.session)+'</td><td class="cd">'+fmt(p.entry,p.assetType==='index'?2:4)+'</td><td class="cr">'+fmt(p.sl,p.assetType==='index'?2:4)+'</td><td class="cg">'+fmt(p.tp,p.assetType==='index'?2:4)+'</td><td>'+rrHtml(rr)+'</td><td>'+(rr!=null&&rr>0?'<span class="cg fw">+'+rr.toFixed(2)+'R</span>':'--')+'</td><td>'+(rr!=null&&rr<0?'<span class="cr">'+rr.toFixed(2)+'R</span>':'--')+'</td><td class="cd">'+fmt(p.lots,2)+'</td><td class="cd" style="font-size:8px">'+(p.mt5Comment||'--')+'</td><td class="cd" style="font-size:9px">'+fmtTs(p.openedAt)+'</td><td class="cd">—</td></tr>');
  }
  const totalClosed = _cl.length + _closedMT5.length;
  if(totalClosed)rows.push('<tr><td colspan="16" class="divider-label"><div class="dot r"></div>Closed — '+totalClosed+' trades</td></tr>');
  // MT5-closed positions still in memory (ghost may still run)
  for(const p of _closedMT5){
    const g=p.ghost||{};
    const isTP=p.mt5CloseReason==='tp'||(g.peakRRPos>=1.30);
    const isSL=!isTP;
    rows.push('<tr class="'+(isSL?'row-slhit':'')+'"><td><span class="bd-k">'+(p.dailyLabel||'--')+'</span></td><td class="cw fw">'+p.symbol+'</td><td>'+bdType(p.assetType)+'</td><td>'+bdDir(p.direction)+'</td><td>'+bdVwap(p.vwapPosition)+'</td><td>'+bdSess(p.session)+'</td><td class="cd">'+fmt(p.entry,p.assetType==='index'?2:4)+'</td><td class="cr">'+fmt(p.sl,p.assetType==='index'?2:4)+'</td><td class="cg">'+fmt(p.tp,p.assetType==='index'?2:4)+'</td><td>'+(isSL?'<span class="bd bd-sl">SL −1.00R</span>':'<span class="bd bd-tp">TP +1.50R</span>')+'</td><td>'+(g.peakRRPos>0?'<span class="cg fw">+'+g.peakRRPos.toFixed(2)+'R</span>':'--')+'</td><td>'+(g.peakRRNeg>0?'<span class="cr">-'+(g.peakRRNeg/100).toFixed(2)+'R</span>':'--')+'</td><td class="cd">'+fmt(p.lots,2)+'</td><td class="cd" style="font-size:8px">'+(p.mt5Comment||'--')+'</td><td class="cd" style="font-size:9px">'+fmtTs(p.openedAt)+'</td><td class="cd" style="font-size:9px">'+fmtTs(p.ghost?.mt5CloseAt||null)+'</td></tr>');
  }
  // DB closed trades
  for(const t of _cl){
    const isTP=t.closeReason==='tp'||(t.peakRRPos>=1.30);
    const isSL=!isTP;
    rows.push('<tr class="'+(isSL?'row-slhit':'')+'"><td><span class="bd-k">'+(t.dailyLabel||'--')+'</span></td><td class="cw fw">'+t.symbol+'</td><td>'+bdType(t.assetType)+'</td><td>'+bdDir(t.direction)+'</td><td>'+bdVwap(t.vwapPosition)+'</td><td>'+bdSess(t.session)+'</td><td class="cd">'+fmt(t.entry,t.assetType==='index'?2:4)+'</td><td class="cr">'+fmt(t.sl,t.assetType==='index'?2:4)+'</td><td class="cg">'+fmt(t.tp,t.assetType==='index'?2:4)+'</td><td>'+(isSL?'<span class="bd bd-sl">SL −1.00R</span>':'<span class="bd bd-tp">TP +1.50R</span>')+'</td><td>'+(t.peakRRPos>0?'<span class="cg fw">+'+t.peakRRPos.toFixed(2)+'R</span>':'--')+'</td><td>'+(t.peakRRNeg>0?'<span class="cr">-'+(t.peakRRNeg/100).toFixed(2)+'R</span>':'--')+'</td><td class="cd">'+fmt(t.lots,2)+'</td><td class="cd" style="font-size:8px">'+(t.mt5Comment||'--')+'</td><td class="cd" style="font-size:9px">'+fmtTs(t.openedAt)+'</td><td class="cd" style="font-size:9px">'+fmtTs(t.closedAt)+'</td></tr>');
  }
  body.innerHTML=rows.join('')||'<tr><td colspan="16" class="nd">No trades yet</td></tr>';
}

// SIGNALS
let _sigAll=[],_sigFilter='all';
async function loadSignals(){
  _sigAll=await api('/api/signal-log?limit=300')||[];
  if($('nb-sig'))$('nb-sig').textContent=_sigAll.length;
  const placed=_sigAll.filter(s=>s.outcome==='PLACED').length;
  const nopos=_sigAll.filter(s=>s.outcome==='ORDER_NOT_CONFIRMED').length;
  const errs=_sigAll.filter(s=>s.outcome==='ERROR').length;
  if($('sg-total'))$('sg-total').textContent=_sigAll.length;
  if($('sg-placed'))$('sg-placed').textContent=placed;
  if($('sg-conv'))$('sg-conv').textContent=_sigAll.length?(placed/_sigAll.length*100).toFixed(1)+'%':'0%';
  if($('sg-nopos'))$('sg-nopos').textContent=nopos;
  if($('sg-err'))$('sg-err').textContent=errs;
  renderSig();
}
function filterSig(f,el){_sigFilter=f;document.querySelectorAll('.seg').forEach(b=>b.classList.remove('on'));if(el)el.classList.add('on');renderSig();}
function renderSig(){
  const data=_sigFilter==='placed'?_sigAll.filter(s=>s.outcome==='PLACED'):_sigFilter==='errors'?_sigAll.filter(s=>['ERROR','ORDER_NOT_CONFIRMED'].includes(s.outcome)):_sigAll;
  const body=$('sig-body');if(!body)return;
  if(!data.length){body.innerHTML='<tr><td colspan="21" class="nd">No signals yet</td></tr>';return;}
  body.innerHTML=data.map(s=>{
    const isPlaced=s.outcome==='PLACED';
    const isErr=['ERROR','ORDER_NOT_CONFIRMED'].includes(s.outcome);
    const bg=isPlaced?'background:rgba(63,185,80,.03)':isErr?'background:rgba(248,81,73,.04)':'';
    const band=s.vwapBandPct!=null?'<span class="'+(s.vwapBandPct>=130?'co fw':'cd')+'">'+Number(s.vwapBandPct).toFixed(1)+'%</span>':'--';
    let outBd;
    if(s.outcome==='PLACED')outBd='<span class="bd bd-placed">PLACED</span>';
    else if(s.outcome==='ERROR')outBd='<span class="bd bd-err">ERROR</span>';
    else if(s.outcome==='ORDER_NOT_CONFIRMED')outBd='<span class="bd bd-nopos">No Pos</span>';
    else outBd='<span class="bd" style="background:rgba(240,136,62,.15);color:#f0883e;border:1px solid rgba(240,136,62,.3)">'+s.outcome+'</span>';
    return '<tr style="'+bg+'"><td class="cd" style="font-size:9px">'+fmtTs(s.receivedAt)+'</td><td class="'+(isPlaced?'cw fw':'cd')+'">'+(s.dailyLabel||'—')+'</td><td class="cw fw">'+(s.symbol||'--')+'</td><td>'+bdType(s.assetType)+'</td><td>'+bdDir(s.direction)+'</td><td>'+bdSess(s.session)+'</td><td>'+bdVwap(s.vwapPosition||'unknown')+'</td><td class="cd">'+fmt(s.tvEntry,s.assetType==='index'?2:5)+'</td><td class="cd">'+(s.slPct?(s.slPct*100).toFixed(3)+'%':'--')+'</td><td class="cd">'+(s.slPoints!=null?Number(s.slPoints).toFixed(2):'--')+'</td><td>'+band+'</td><td class="cd" style="font-size:9px">'+(s.vwapMid!=null?Number(s.vwapMid).toFixed(s.assetType==='index'?2:5):'--')+'</td><td class="cd" style="font-size:9px">'+(s.vwapUpper!=null?Number(s.vwapUpper).toFixed(s.assetType==='index'?2:5):'--')+'</td><td class="cd" style="font-size:9px">'+(s.vwapLower!=null?Number(s.vwapLower).toFixed(s.assetType==='index'?2:5):'--')+'</td><td class="cy" style="font-size:9px">'+(s.sessionHigh!=null?Number(s.sessionHigh).toFixed(s.assetType==='index'?2:5):'--')+'</td><td class="cy" style="font-size:9px">'+(s.sessionLow!=null?Number(s.sessionLow).toFixed(s.assetType==='index'?2:5):'--')+'</td><td class="cb2" style="font-size:9px">'+(s.dayHigh!=null?Number(s.dayHigh).toFixed(s.assetType==='index'?2:5):'--')+'</td><td class="cb2" style="font-size:9px">'+(s.dayLow!=null?Number(s.dayLow).toFixed(s.assetType==='index'?2:5):'--')+'</td><td>'+outBd+'</td><td class="cd" style="font-size:8px">'+(s.optimizerKey||'--')+'</td><td class="cd">'+(s.latencyMs!=null?s.latencyMs+'ms':'--')+'</td></tr>';
  }).join('');
}

// GHOST TRACKER
async function loadGhostTracker(){
  const [pos,hist]=await Promise.all([api('/api/open-positions'),api('/api/ghost-history?limit=1')]);
  const _pos=Array.isArray(pos)?pos:[];
  // KPIs
  if($('gh-active'))$('gh-active').textContent=_pos.length;
  if($('gh-buy'))$('gh-buy').textContent=_pos.filter(p=>p.direction==='buy').length;
  if($('gh-sell'))$('gh-sell').textContent=_pos.filter(p=>p.direction==='sell').length;
  const peaks=_pos.map(p=>p.ghost?.peakRRPos||0).filter(v=>v>0);
  if(peaks.length){if($('gh-best'))$('gh-best').textContent='+'+Math.max(...peaks).toFixed(2)+'R';if($('gh-avg'))$('gh-avg').textContent='+'+(peaks.reduce((a,b)=>a+b,0)/peaks.length).toFixed(2)+'R';}
  const MAX_FAV=5.0;
  // Build table header — same columns as overview trades + milestone columns
  const hdrCells='<th>Status</th><th>#</th><th>Symbol</th><th>MT5 Comment</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Session</th>'
    +'<th style="color:#388bfd">RR Now</th><th style="color:#3fb950">Peak+</th><th style="color:#f85149">Peak−</th><th>TP Set</th>'
    +buildMsHeaders(MAX_FAV)
    +'<th>TV Entry</th><th>Entry</th><th style="color:#f85149">SL</th><th style="color:#3fb950">TP</th>'
    +'<th>Lots</th><th>Opened</th>'
    +'<th style="color:#d29922">VWAP</th><th>VWAP+</th><th>VWAP−</th>'
    +'<th style="color:#d29922">S.High</th><th style="color:#d29922">S.Low</th>'
    +'<th style="color:#39d3f2">D.High</th><th style="color:#39d3f2">D.Low</th>'
    +'<th>Band%</th><th>SL%</th><th>SL pts</th>';
  const hdrEl=$('gh-ms-header');if(hdrEl)hdrEl.innerHTML=hdrCells;
  const body=$('gh-active-body');if(!body)return;

  // Split: active (not finalized) and finalized (stays 30min)
  // Active = not finalized. FINISHED always from DB section below.
  const activePOS = _pos.filter(p=>!p.ghostFinalized);
  const finalPOS  = []; // DB loads FINISHED — never from memory

  function ghostRowHtml(p, isFinalized) {
    const g=p.ghost||{};
    const ms=g.rrMilestones||{};
    const rr=rrFromPrice(p.entry,p.sl,p.currentPrice,p.direction);
    const pkp=g.peakRRPos||0, pkn=g.peakRRNeg||0;
    const isIdx=p.assetType==='index';
    let statusBadge;
    if(isFinalized){
      statusBadge='<span class="bd" style="background:rgba(139,148,158,.15);color:#e6edf3;border:1px solid rgba(139,148,158,.4);padding:2px 7px;font-size:9px;font-weight:700">FINISHED</span>';
    } else if(g.mt5ClosedTP){
      statusBadge='<span class="bd" style="background:rgba(188,140,255,.15);color:#bc8cff;border:1px solid rgba(188,140,255,.3);padding:2px 7px;font-size:9px;font-weight:700">GHOST</span>';
    } else {
      statusBadge='<span class="bd bd-live">● LIVE</span>';
    }
    const rowBg=isFinalized?'background:rgba(248,81,73,.04)':g.mt5ClosedTP?'background:rgba(188,140,255,.04)':'';
    return '<tr style="'+rowBg+'">'
      +'<td>'+statusBadge+'</td>'
      +'<td class="cw fw" style="font-size:9px">'+(p.dailyLabel||'--')+'</td>'
      +'<td class="cw fw">'+p.symbol+'</td>'
      +'<td class="cd" style="font-size:8px">'+(p.mt5Comment||'--')+'</td>'
      +'<td>'+bdType(p.assetType)+'</td>'
      +'<td>'+bdDir(p.direction)+'</td>'
      +'<td>'+bdVwap(p.vwapPosition)+'</td>'
      +'<td>'+bdSess(p.session)+'</td>'
      +'<td>'+(isFinalized?'<span class="cr fw">−1.00R</span>':rrHtml(rr))+'</td>'
      +'<td>'+(pkp>0?'<span class="cg fw">+'+pkp.toFixed(2)+'R</span>':'--')+'</td>'
      +'<td>'+(pkn>0?'<span class="cr">-'+(pkn/100).toFixed(2)+'R</span>':'--')+'</td>'
      +'<td class="cg">+1.50R</td>'
      +buildMsRow(ms,MAX_FAV)
      +'<td class="cd" style="font-size:9px">'+fmt(p.tvEntry,isIdx?2:5)+'</td>'
      +'<td class="cw">'+fmt(p.entry,isIdx?2:5)+'</td>'
      +'<td class="cr">'+fmt(p.sl,isIdx?2:5)+'</td>'
      +'<td class="cg">'+fmt(p.tp,isIdx?2:5)+'</td>'
      +'<td class="cd">'+fmt(p.lots,2)+'</td>'
      +'<td class="cd" style="font-size:9px">'+fmtTs(p.openedAt)+'</td>'
      +'<td class="cy" style="font-size:9px">'+(p.vwapMid!=null?fmt(p.vwapMid,isIdx?2:5):'--')+'</td>'
      +'<td class="cd" style="font-size:9px">'+(p.vwapUpper!=null?fmt(p.vwapUpper,isIdx?2:5):'--')+'</td>'
      +'<td class="cd" style="font-size:9px">'+(p.vwapLower!=null?fmt(p.vwapLower,isIdx?2:5):'--')+'</td>'
      +'<td class="cy" style="font-size:9px">'+(p.sessionHigh!=null?fmt(p.sessionHigh,isIdx?2:5):'--')+'</td>'
      +'<td class="cy" style="font-size:9px">'+(p.sessionLow!=null?fmt(p.sessionLow,isIdx?2:5):'--')+'</td>'
      +'<td class="cb2" style="font-size:9px">'+(p.dayHigh!=null?fmt(p.dayHigh,isIdx?2:5):'--')+'</td>'
      +'<td class="cb2" style="font-size:9px">'+(p.dayLow!=null?fmt(p.dayLow,isIdx?2:5):'--')+'</td>'
      +'<td class="cd">'+(p.vwapBandPct!=null?Number(p.vwapBandPct).toFixed(1)+'%':'--')+'</td>'
      +'<td class="cd">'+(p.slPct!=null?(p.slPct*100).toFixed(3)+'%':'--')+'</td>'
      +'<td class="cd">'+(p.slPoints!=null?Number(p.slPoints).toFixed(2):'--')+'</td>'
      +'</tr>';
  }

  // Build rows: active first, then divider, then finalized
  const activeRows = activePOS.length
    ? activePOS.map(p=>ghostRowHtml(p,false)).join('')
    : '<tr><td colspan="50" class="nd">No active ghost trades</td></tr>';

  const finRows = ''; // FINISHED rows always from DB — see finRows2 below

  // Load finalized from DB and append in same tbody
  const from=$('gh-from')?.value||'', to=$('gh-to')?.value||'';
  let histUrl='/api/ghost-history?limit=500';
  if(from)histUrl+='&from='+from; if(to)histUrl+='&to='+to;
  const histData = await api(histUrl)||[];
  if($('gh-fin-count'))$('gh-fin-count').textContent=histData.length+' finalized';
  if($('gh-fin'))$('gh-fin').textContent=histData.length;
  if($('nb-gh'))$('nb-gh').textContent=(_pos.length+histData.length)||0;

  // Update badges
  const bdg=$('gh-badges');
  if(bdg){
    const liveCnt=_pos.filter(p=>!p.ghostFinalized&&!p.ghost?.mt5ClosedTP).length;
    const ghostCnt=_pos.filter(p=>p.ghost?.mt5ClosedTP&&!p.ghostFinalized).length;
    const finMem=_pos.filter(p=>p.ghostFinalized).length;
    const s9='font-size:9px';
    bdg.innerHTML=
      (liveCnt?'<span style="'+s9+';background:rgba(63,185,80,.1);color:#3fb950;border:1px solid rgba(63,185,80,.25);padding:1px 6px;border-radius:3px">'+liveCnt+' LIVE</span>':'')
      +(ghostCnt?'<span style="'+s9+';background:rgba(188,140,255,.1);color:#bc8cff;border:1px solid rgba(188,140,255,.25);padding:1px 6px;border-radius:3px">'+ghostCnt+' GHOST</span>':'')
      +(finMem?'<span style="'+s9+';background:rgba(139,148,158,.1);color:#6e7681;border:1px solid rgba(139,148,158,.2);padding:1px 6px;border-radius:3px">'+finMem+' FINISHED</span>':'')
      +(histData.length?'<span style="'+s9+';background:rgba(248,81,73,.08);color:#f85149;border:1px solid rgba(248,81,73,.2);padding:1px 6px;border-radius:3px">'+histData.length+' in DB</span>':'');
  }

  const maxFavH=histData.length?Math.min(20,Math.max(1.5,...histData.map(g=>g.peakRRPos||0))):MAX_FAV;
  const finRows2=histData.length
    ?'<tr><td colspan="200" class="divider-label"><div class="dot r" style="flex-shrink:0"></div>Ghost Finalized — phantom SL geraakt · alle ADV milestones backfilled · data altijd bewaard in DB</td></tr>'
      +histData.map(g=>{
        const ms=g.rrMilestones||{};
        return '<tr>'
          +'<td><span class="bd bd-sl" style="padding:2px 7px;font-size:9px;font-weight:700">SL</span></td>'
          +'<td class="cw fw" style="font-size:9px">'+(g.dailyLabel||'--')+'</td>'
          +'<td class="cw fw">'+g.symbol+'</td>'
          +'<td class="cd" style="font-size:8px">'+(g.mt5Comment||'--')+'</td>'
          +'<td>'+bdType(g.assetType)+'</td>'
          +'<td>'+bdDir(g.direction)+'</td>'
          +'<td>'+bdVwap(g.vwapPosition||'unknown')+'</td>'
          +'<td>'+bdSess(g.session)+'</td>'
          +'<td class="cg fw">+'+(g.peakRRPos||0).toFixed(2)+'R</td>'
          +'<td class="cr fw">-1.00R</td>'
          +'<td class="cg">+1.50R</td>'
          +'<td class="cd">'+(g.timeToSLMin!=null?g.timeToSLMin+'m':'--')+'</td>'
          +buildMsRow(ms,Math.min(maxFavH,20))
          +'<td class="cd" style="font-size:9px">'+fmt(null,2)+'</td>'
          +'<td class="cd">'+fmt(g.entry,g.assetType==="index"?2:5)+'</td>'
          +'<td class="cr">'+fmt(g.sl,g.assetType==="index"?2:5)+'</td>'
          +'<td class="cg">--</td>'
          +'<td class="cd">'+fmt(g.lots,2)+'</td>'
          +'<td class="cd" style="font-size:9px">'+fmtTs(g.openedAt)+'</td>'
          +'<td class="cd">--</td><td class="cd">--</td><td class="cd">--</td>'
          +'<td class="cd">--</td><td class="cd">--</td><td class="cd">--</td><td class="cd">--</td>'
          +'<td class="cd">'+(g.vwapBandPct!=null?Number(g.vwapBandPct).toFixed(1)+'%':'--')+'</td>'
          +'<td class="cd">--</td><td class="cd">--</td>'
          +'</tr>';
      }).join('')
    :'';

  body.innerHTML = activeRows + finRows + finRows2;
}

async function loadGhostHistory(){
  // Alias — just reload the full ghost tracker
  await loadGhostTracker();
}

// PERFORMANCE
async function loadPerf(){
  const [perf,ghosts]=await Promise.all([api('/api/performance'),api('/api/ghost-history?limit=500')]);
  if(perf&&$('perf-overall')){
    const kpis=[['Total Trades',perf.total,'cw'],['MT5 TP',perf.tp,'cg'],['MT5 SL',perf.sl,'cr'],['Win Rate',(perf.winRate||0).toFixed(1)+'%','cy'],['Avg Ghost Peak+','+'+(perf.avgPeakRR||0).toFixed(2)+'R','cg'],['Balance',perf.balance?'$'+Math.round(perf.balance).toLocaleString():'--','cb'],['Currency',perf.currency||'USD','cd']];
    $('perf-overall').innerHTML=kpis.map(([l,v,c])=>'<div class="ks"><div class="ksl">'+l+'</div><div class="ksv '+c+'">'+(v??'--')+'</div></div>').join('');
  }
  if(!Array.isArray(ghosts)||!ghosts.length)return;
  function buildPerfTable(sym,maxFav){
    const advK=[];for(let v=1.0;v>=0.1-1e-9;v=Math.round((v-0.1)*10)/10)advK.push('-'+v.toFixed(1));
    const favK=[];for(let v=0.1;v<=maxFav+1e-9;v=Math.round((v+0.1)*10)/10)favK.push('+'+v.toFixed(1));
    // Get all 12 optimizer keys for this pair
    const sessions=['london','ny','asia'],dirs=['buy','sell'],vwaps=['above','below'];
    const keys=[];
    for(const s of sessions)for(const d of dirs)for(const v of vwaps)keys.push(sym+'_'+s+'_'+d+'_'+v);
    const hdr='<tr><th style="text-align:left;min-width:200px;font-size:9px">Optimizer Key</th><th>Trades</th>'+advK.map(k=>'<th class="adv-th" style="font-size:8px">'+k+'</th>').join('')+favK.map(k=>'<th class="fav-th" style="font-size:8px'+(k==='+1.5'?';color:#bc8cff':'')+'">' +k+'</th>').join('')+'<th>Avg Peak+</th></tr>';
    const rows=keys.map(key=>{
      const keyGhosts=ghosts.filter(g=>g.optimizerKey===key);
      const n=keyGhosts.length;
      if(n===0)return '<tr><td class="cd" style="font-size:9px">'+key+'</td><td class="cd">0</td>'+advK.map(()=>'<td class="cd">·</td>').join('')+favK.map(()=>'<td class="cd">·</td>').join('')+'<td class="cd">—</td></tr>';
      const noData=n<5;
      const avgPeak=(keyGhosts.reduce((s,g)=>s+(g.peakRRPos||0),0)/n).toFixed(2);
      const advRates=advK.map(k=>{
        const hit=keyGhosts.filter(g=>(g.rrMilestones||{})[k]).length;
        return noData?'·':hit+'/'+ n+' '+Math.round(hit/n*100)+'%';
      });
      const favRates=favK.map(k=>{
        const hit=keyGhosts.filter(g=>(g.rrMilestones||{})[k]).length;
        return noData?'·':hit+'/'+ n+' '+Math.round(hit/n*100)+'%';
      });
      return '<tr><td class="'+(noData?'cd':'cw')+'" style="font-size:9px">'+key+'</td><td class="'+(noData?'cd':'')+'">'+n+'</td>'+advRates.map(v=>'<td class="cr" style="font-size:9px">'+v+'</td>').join('')+favRates.map(v=>'<td class="cg" style="font-size:9px">'+v+'</td>').join('')+'<td class="cy">+'+(noData?'—':avgPeak+'R')+'</td></tr>';
    }).join('');
    return '<table class="perf-key-tbl"><thead>'+hdr+'</thead><tbody>'+rows+'</tbody></table>';
  }
  const maxXau=Math.max(1.5,...ghosts.filter(g=>g.symbol==='XAUUSD').map(g=>g.peakRRPos||0));
  const maxUs100=Math.max(1.5,...ghosts.filter(g=>g.symbol==='US100.cash').map(g=>g.peakRRPos||0));
  if($('perf-xau'))$('perf-xau').innerHTML=buildPerfTable('XAUUSD',maxXau);
  if($('perf-us100'))$('perf-us100').innerHTML=buildPerfTable('US100.cash',maxUs100);
}

// Init
loadHeader();loadOverview();loadGhostHistory();
setInterval(loadHeader,15000);
setInterval(()=>{
  const a=document.querySelector('.pg.on');if(!a)return;
  if(a.id==='p-ov')loadOverview();
  if(a.id==='p-gh')loadGhostTracker();
},5000);
setInterval(()=>{const a=document.querySelector('.pg.on');if(a?.id==='p-sig')loadSignals();},30000);
</script>
</body>
</html>`;
}

// ════════════════════════════════════════════════════════════════
// BACKGROUND INIT
// ════════════════════════════════════════════════════════════════
async function initBackground() {
  // DB
  let retries = 0;
  while (retries < 5) {
    try { await db.initDB(); break; }
    catch (e) {
      retries++;
      console.error(`[DB] init failed (${retries}/5): ${e.message}`);
      if (retries < 5) await new Promise(r => setTimeout(r, 5000 * retries));
      else throw e;
    }
  }

  // Restore ghost states from DB
  try {
    const states = await db.loadAllGhostStates();
    for (const g of states) {
      if (!g.positionId || !g.entry || !g.sl) continue;
      const pos = {
        positionId: g.positionId, dailyLabel: g.dailyLabel,
        symbol: g.symbol, assetType: g.assetType,
        direction: g.direction, session: g.session,
        vwapPosition: g.vwapPosition, optimizerKey: g.optimizerKey,
        entry: g.entry, sl: g.sl, tp: g.tp, lots: g.lots,
        riskEur: g.riskEur, slPct: g.slPct, slDist: g.slDist,
        vwapMid: g.vwapMid, vwapUpper: g.vwapUpper, vwapLower: g.vwapLower,
        vwapBandPct: g.vwapBandPct,
        sessionHigh: g.sessionHigh, sessionLow: g.sessionLow,
        dayHigh: g.dayHigh, dayLow: g.dayLow,
        tvEntry: g.tvEntry, mt5Comment: g.mt5Comment,
        openedAt: g.openedAt, mt5Closed: g.mt5ClosedTP ?? false,
        currentPrice: g.entry, livePnl: 0,
        ghost: {
          positionId:    g.positionId, dailyLabel: g.dailyLabel,
          optimizerKey:  g.optimizerKey, symbol: g.symbol, assetType: g.assetType,
          direction:     g.direction, session: g.session, vwapPosition: g.vwapPosition,
          entry: g.entry, sl: g.sl, tp: g.tp, lots: g.lots, riskEur: g.riskEur,
          slPct: g.slPct, slDist: g.slDist,
          vwapMid: g.vwapMid, vwapUpper: g.vwapUpper, vwapLower: g.vwapLower,
          vwapBandPct: g.vwapBandPct,
          sessionHigh: g.sessionHigh, sessionLow: g.sessionLow,
          dayHigh: g.dayHigh, dayLow: g.dayLow,
          tvEntry: g.tvEntry, mt5Comment: g.mt5Comment,
          openedAt: g.openedAt,
          maxRR:        g.maxRR    ?? 0,
          peakRRPos:    g.peakRRPos ?? 0,
          peakRRNeg:    g.peakRRNeg ?? 0,
          rrMilestones: g.rrMilestones ?? {},
          mt5ClosedTP:  g.mt5ClosedTP ?? false,
          mt5CloseAt:   g.mt5CloseAt ?? null,
          mt5CloseReason: g.mt5ClosedTP ? "tp" : null,
          phantomSLHit: g.phantomSLHit ?? false,
          slHitAt:      g.slHitAt ?? null,
          timeToSLMin:  g.timeToSLMin ?? null,
        },
      };
      openPositions.set(g.positionId, pos);
    }
    console.log(`[DB] Restored ${openPositions.size} ghost states`);
  } catch (e) { console.error("[DB] restore failed:", e.message); }

  dbReady = true;
  console.log("[PRONTO-AI] DB ready");

  // MetaAPI
  if (META_API_TOKEN && META_ACCOUNT) {
    try {
      try { await metaFetch(`/users/current/accounts/${META_ACCOUNT}/deploy`, "POST"); await new Promise(r => setTimeout(r, 5000)); } catch {}
      const acct = await Promise.race([
        metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
      ]);
      if (acct?.balance !== undefined) {
        latestEquity   = parseFloat(acct.equity ?? acct.balance);
        latestCurrency = acct.currency ?? "USD";
        _acctCache = acct; _acctCacheTs = Date.now();
        console.log(`[MetaAPI] Connected — ${acct.balance} ${acct.currency}`);
        // Adopt live MT5 positions not in memory
        const live = await getPositions();
        for (const lp of live) {
          if (!openPositions.has(String(lp.id))) await adoptPosition(lp);
        }
      }
    } catch (e) { console.error(`[MetaAPI] Startup failed: ${e.message}`); }
  } else {
    console.warn("[MetaAPI] META_API_TOKEN or META_ACCOUNT not set — no MetaAPI connection");
  }

  // Sync every 5s
  cron.schedule("*/5 * * * * *", syncPositions);
  // Cleanup finalized ghosts from memory every 5 min
  cron.schedule("*/5 * * * *", cleanupFinalizedGhosts);
  console.log("[PRONTO-AI] Cron active — 5s sync");
}

initBackground().catch(e => {
  console.error("[FATAL] initBackground:", e.message);
});
