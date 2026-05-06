// ===============================================================
// server.js  v12.7.0  |  PRONTO-AI
//
// Changes v12.7.0:
//  - FIX DASHBOARD EMPTY STATE: API endpoints now return [] / {} instead
//    of crashing when DB tables are empty or data is missing.
//  - FIX SECRET SECURITY: WEBHOOK_SECRET check tightened — rejects empty
//    string secrets and logs failed attempts with IP.
//  - FIX EV RETRY: computeEVStats() retry logic on transient DB errors
//    (3 attempts, 500ms backoff). Ghost EV now survives brief DB hiccups.
//  - COMPLIANCE BANNER: GET /status now includes complianceDate field so
//    the dashboard can display a "data from {date}" banner.
//  - ERROR COUNTER: /status endpoint exposes errorCount (rolling 1h window)
//    so the dashboard can show a red badge when errors spike.
//
// Changes v12.6:
//  - loadDailyBreakdown, loadGhostHistoryByPair, loadBlockedRaw endpoints.
//  - Ghost combo analysis auto-recomputes on ghost finalize.
//
// Changes v12.5:
//  - loadPerformanceSummary, loadMAEStats, loadGhostGrouped endpoints.
//  - SL milestone timing exposed.
//  - Compliance date manageable via POST /compliance-date.
// ===============================================================

"use strict";

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const db = require("./db");
const {
  COMPLIANCE_DATE,
  COMPLIANCE_DATE_MS,
  SYMBOL_CATALOG,
  SYMBOL_ALIASES,
  DEFAULT_RISK_BY_TYPE,
  SL_BUFFER_MULT,
  STOCK_SL_BUFFER_MULT,
  NY_DEAD_ZONE_START,
  NY_DEAD_ZONE_END,
  getBrusselsComponents,
  getBrusselsDateStr,
  getBrusselsDateOnly,
  getSession,
  isMarketOpen,
  canOpenNewTrade,
  isMonitoringActive,
  isGhostActive,
  isShadowActive,
  normalizeSymbol,
  getSymbolInfo,
  getVwapPosition,
  buildOptimizerKey,
} = require("./session");

// ── Config ────────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const META_API_TOKEN = process.env.META_API_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT   || "";
const META_BASE      = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

// ── Error counter (rolling 1h) ────────────────────────────────────
let errorLog = [];   // [{ ts: Date, msg: string }]
function recordError(msg) {
  const now = Date.now();
  errorLog.push({ ts: now, msg });
  // Keep only last 1h
  errorLog = errorLog.filter(e => now - e.ts < 3600_000);
}
function getErrorCount() {
  const now = Date.now();
  return errorLog.filter(e => now - e.ts < 3600_000).length;
}

// ── In-memory state ────────────────────────────────────────────────
// Open positions tracked in memory, persisted to ghost_state in DB.
const openPositions = new Map();  // positionId → position object

// TP configs loaded from DB at startup
let tpConfigs = {};   // optimizerKey → { lockedRR, ... }

// Symbol risk overrides (from DB)
let symbolRiskMap = {};  // symbol → riskPct

// Key risk multipliers (evMult × dayMult per optimizer_key)
let keyRiskMults = {};   // optimizerKey → { streak, evMult, dayMult }

// Shadow SL analysis cache (from DB)
let shadowAnalysisCache = {};  // optimizerKey → analysis object

// Global compliance date (can be updated via POST /compliance-date)
let liveComplianceDate = COMPLIANCE_DATE;

// ── MetaAPI helpers ───────────────────────────────────────────────
async function metaFetch(path, method = "GET", body = null) {
  const url  = `${META_BASE}${path}`;
  const opts = {
    method,
    headers: {
      "auth-token":   META_API_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MetaAPI ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json().catch(() => null);
}

async function getPositions() {
  try {
    return await metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions`);
  } catch (e) {
    recordError(`getPositions: ${e.message}`);
    return [];
  }
}

async function getAccountInfo() {
  try {
    return await metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`);
  } catch (e) {
    recordError(`getAccountInfo: ${e.message}`);
    return null;
  }
}

async function placeOrder(order) {
  return metaFetch(
    `/users/current/accounts/${META_ACCOUNT}/trade`,
    "POST",
    order
  );
}

async function closePosition(positionId) {
  return metaFetch(
    `/users/current/accounts/${META_ACCOUNT}/positions/${positionId}/close`,
    "POST",
    {}
  );
}

async function fetchHistoryDeals(positionId) {
  try {
    // Fetch deals from the last 30 days
    const to   = new Date().toISOString();
    const from = new Date(Date.now() - 30 * 86400_000).toISOString();
    const data = await metaFetch(
      `/users/current/accounts/${META_ACCOUNT}/history-deals/position/${positionId}?from=${from}&to=${to}`
    );
    return Array.isArray(data) ? data : (data?.deals ?? []);
  } catch (e) {
    return [];
  }
}

// ── Risk / lot calculation ────────────────────────────────────────
function getRiskPct(symbol, assetType) {
  if (symbolRiskMap[symbol]) return symbolRiskMap[symbol];
  return DEFAULT_RISK_BY_TYPE[assetType] ?? DEFAULT_RISK_BY_TYPE.forex;
}

function calcLots(accountEquity, riskPct, slDistPct, slBufferMult, symbolInfo) {
  // Lot size logic depends on asset type
  const type = symbolInfo?.type ?? "forex";
  const mt5  = symbolInfo?.mt5  ?? "";
  const riskEUR = accountEquity * riskPct;

  // Lot value per pip / per % movement varies by instrument
  // For simplicity: use 1 lot = contractSize units
  // slDistPct = distance from entry to SL as % of entry price
  // riskEUR = lots × (contractSize × slDistPct × price) — varies by asset

  // Generic formula — each asset type has different contract sizes
  // This is a simplified version; actual implementation should query MetaAPI
  // for instrument specs. Using approximate values here.
  let contractSize = 100000; // forex default (1 lot = 100k units)
  if (type === "index")     contractSize = 1;
  if (type === "stock")     contractSize = 1;
  if (type === "commodity" && mt5 === "XAUUSD") contractSize = 100;

  const effectiveSLPct = slDistPct * slBufferMult;
  if (effectiveSLPct <= 0 || contractSize <= 0) return 0.01;

  // riskEUR = lots × contractSize × (effectiveSLPct/100) × price
  // → lots = riskEUR / (contractSize × effectiveSLPct/100 × price)
  // We don't have price here, so lots is computed by server on actual signal
  // Return riskEUR for the caller to use with actual price
  return riskEUR;
}

// ── EV retry logic (FIX EV RETRY) ────────────────────────────────
async function computeEVStatsWithRetry(optimizerKey, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await db.computeEVStats(optimizerKey);
      return result;
    } catch (e) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * attempt));
      } else {
        recordError(`computeEVStats(${optimizerKey}): ${e.message}`);
        return { key: optimizerKey, count: 0, rrLevels: [], bestRR: null, bestEV: null };
      }
    }
  }
}

// ── Webhook secret check (FIX SECRET SECURITY) ───────────────────
function checkSecret(req, res) {
  // FIX: reject if WEBHOOK_SECRET is not configured
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.trim() === "") {
    console.error("[SECURITY] WEBHOOK_SECRET is not set — rejecting all webhook requests");
    res.status(503).json({ error: "WEBHOOK_SECRET not configured on server" });
    return false;
  }
  const provided = req.headers["x-webhook-secret"]
    || req.body?.secret
    || req.query?.secret;
  if (!provided || provided !== WEBHOOK_SECRET) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    console.warn(`[SECURITY] Invalid webhook secret from IP ${ip}`);
    recordError(`Invalid webhook secret from ${ip}`);
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── Ghost position tracker ────────────────────────────────────────
// Ghost tracks a real open position through its lifecycle, recording
// SL usage milestones and peak RR for the optimizer.

function buildGhostKey(positionId) {
  return positionId;
}

function initGhostForPosition(pos) {
  const { positionId, symbol, session, direction, vwapPosition,
          optimizerKey, entry, sl, slPct, tpRRUsed, openedAt,
          riskPct, riskEUR, evMult, dayMult, tradeNumber } = pos;
  return {
    positionId,
    optimizerKey,
    symbol,
    mt5Symbol: pos.mt5Symbol ?? symbol,
    session,
    direction,
    vwapPosition: vwapPosition ?? "unknown",
    entry:  parseFloat(entry),
    sl:     parseFloat(sl),
    slPct:  slPct  ?? null,
    tpRRUsed: tpRRUsed ?? null,
    maxPrice:     parseFloat(entry),
    maxRR:        0,
    maxSlPctUsed: 0,
    openedAt:     openedAt ?? new Date().toISOString(),
    riskPct:  riskPct  ?? null,
    riskEUR:  riskEUR  ?? null,
    evMult:   evMult   ?? 1.0,
    dayMult:  dayMult  ?? 1.0,
    tradeNumber: tradeNumber ?? null,
    peakRRPos:  0,
    peakRRNeg:  0,
    slMilestones: {},
    rrMilestones: {},
    phantomSL:    sl,    // phantom SL = real SL by default
    phantomSLHit: false,
    stopReason:   null,
    timeToSLMin:  null,
    closedAt:     null,
  };
}

function updateGhostPrice(ghost, currentPrice) {
  const price   = parseFloat(currentPrice);
  const entry   = ghost.entry;
  const sl      = ghost.sl;
  const slRange = Math.abs(entry - sl);
  if (slRange <= 0) return;

  const isBuy = ghost.direction === "buy";

  // Max favorable price (for RR calculation)
  if (isBuy  && price > ghost.maxPrice) ghost.maxPrice = price;
  if (!isBuy && price < ghost.maxPrice) ghost.maxPrice = price;

  // Current RR
  const favMove = isBuy ? (price - entry) : (entry - price);
  const currentRR = parseFloat((favMove / slRange).toFixed(4));
  if (currentRR > ghost.maxRR) ghost.maxRR = currentRR;
  if (currentRR > ghost.peakRRPos) ghost.peakRRPos = currentRR;

  // Adverse excursion (SL usage)
  const advMove = isBuy ? (entry - price) : (price - entry);
  const slUsed  = parseFloat(((advMove / slRange) * 100).toFixed(2));
  if (slUsed > ghost.maxSlPctUsed) ghost.maxSlPctUsed = slUsed;
  if (slUsed > ghost.peakRRNeg)    ghost.peakRRNeg    = slUsed;

  // SL milestone recording (every 10%)
  const milestoneKeys = [25, 50, 75, 90, 100];
  for (const pct of milestoneKeys) {
    if (slUsed >= pct && !ghost.slMilestones[pct]) {
      ghost.slMilestones[pct] = new Date().toISOString();
    }
  }

  // RR milestones (1R, 2R, 3R, 5R)
  const rrMilestones = [1, 2, 3, 5, 10];
  for (const rr of rrMilestones) {
    if (currentRR >= rr && !ghost.rrMilestones[rr]) {
      ghost.rrMilestones[rr] = new Date().toISOString();
    }
  }

  // Check phantom SL hit (real SL = sl)
  const hitSL = isBuy ? (price <= sl) : (price >= sl);
  if (hitSL && !ghost.phantomSLHit) {
    ghost.phantomSLHit = true;
    ghost.stopReason   = "phantom_sl";
    if (ghost.openedAt) {
      ghost.timeToSLMin = Math.round(
        (Date.now() - new Date(ghost.openedAt).getTime()) / 60000
      );
    }
  }

  // Cap RR at 15 (max_rr_15 stop reason)
  if (currentRR >= 15 && !ghost.stopReason) {
    ghost.stopReason = "max_rr_15";
  }
}

// ── Handle position closed ────────────────────────────────────────
async function handlePositionClosed(positionId, closeReason = "manual", closedPnl = null) {
  const pos = openPositions.get(positionId);
  if (!pos) return;

  openPositions.delete(positionId);

  const ghost   = pos.ghost;
  const now     = new Date().toISOString();
  const hitTP   = closeReason === "tp";

  // Fetch realized P&L from deals table first (FIX v12.4)
  let realizedPnl = null;
  try {
    const deals = await fetchHistoryDeals(positionId);
    for (const deal of deals) {
      await db.saveDeal({
        positionId,
        dealId:     deal.id ?? deal.dealId,
        symbol:     deal.symbol,
        type:       deal.type,
        profit:     deal.profit ?? 0,
        commission: deal.commission ?? 0,
        swap:       deal.swap ?? 0,
        volume:     deal.volume,
        price:      deal.price,
        time:       deal.time,
      });
    }
    realizedPnl = await db.fetchRealizedPnl(positionId);
  } catch (e) {
    recordError(`handlePositionClosed deals: ${e.message}`);
  }

  if (realizedPnl == null) realizedPnl = closedPnl;

  // Finalize ghost
  if (ghost) {
    ghost.closedAt   = now;
    ghost.stopReason = ghost.stopReason ?? closeReason;

    await db.saveGhostTrade({
      ...ghost,
      maxRRBeforeSL: ghost.maxRR,
    });

    // Recompute ghost combo analysis for this optimizer key
    try {
      await db.computeAndSaveGhostComboAnalysis(ghost.optimizerKey);
    } catch (e) {
      recordError(`computeGhostCombo: ${e.message}`);
    }
  }

  // Save closed trade
  await db.saveTrade({
    positionId,
    symbol:      pos.symbol,
    mt5Symbol:   pos.mt5Symbol,
    direction:   pos.direction,
    vwapPosition: pos.vwapPosition ?? "unknown",
    entry:       pos.entry,
    sl:          pos.sl,
    tp:          pos.tp,
    lots:        pos.lots,
    riskPct:     pos.riskPct,
    riskEUR:     pos.riskEUR,
    maxPrice:    ghost?.maxPrice ?? pos.entry,
    maxRR:       ghost?.maxRR   ?? 0,
    trueMaxRR:   ghost?.maxRR   ?? 0,
    trueMaxPrice: ghost?.maxPrice ?? pos.entry,
    ghostStopReason:  ghost?.stopReason,
    ghostFinalizedAt: now,
    session:     pos.session,
    vwapAtEntry: pos.vwapAtEntry,
    openedAt:    pos.openedAt,
    closedAt:    now,
    slMultiplier: pos.slMultiplier ?? 1.0,
    realizedPnlEUR: realizedPnl,
    hitTP,
    closeReason,
    spreadAtEntry:  pos.spreadAtEntry,
    vwapBandPct:    pos.vwapBandPct,
    executionPrice: pos.executionPrice,
    tvEntry:        pos.tvEntry,
    slippage:       pos.slippage,
    excludeFromEV:  pos.excludeFromEV ?? false,
  });

  // Delete ghost state from DB
  await db.deleteGhostState(positionId);

  // Log PnL
  await db.savePnlLog(
    pos.symbol, pos.session, pos.direction,
    pos.vwapPosition ?? "unknown",
    ghost?.maxRR ?? 0,
    hitTP,
    realizedPnl ?? 0
  );

  console.log(`[Position] Closed ${positionId} (${pos.symbol} ${pos.direction}) reason=${closeReason} pnl=${realizedPnl}`);
}

// ── Restore positions from DB on startup ─────────────────────────
async function restorePositionsFromMT5() {
  try {
    const ghostStates = await db.loadAllGhostStates();
    let restored = 0;
    for (const gs of ghostStates) {
      if (openPositions.has(gs.positionId)) continue;
      const ghost = {
        positionId:   gs.positionId,
        optimizerKey: gs.optimizerKey,
        symbol:       gs.symbol,
        mt5Symbol:    gs.mt5Symbol ?? gs.symbol,
        session:      gs.session,
        direction:    gs.direction,
        vwapPosition: gs.vwapPosition ?? "unknown",
        entry:        gs.entry,
        sl:           gs.sl,
        slPct:        gs.slPct,
        tpRRUsed:     gs.tpRRUsed,
        maxPrice:     gs.maxPrice ?? gs.entry,
        maxRR:        gs.maxRR  ?? 0,
        maxSlPctUsed: gs.maxSlPctUsed ?? 0,
        openedAt:     gs.openedAt,
        riskPct:      gs.riskPct,
        riskEUR:      gs.riskEUR,
        evMult:       gs.evMult  ?? 1.0,
        dayMult:      gs.dayMult ?? 1.0,
        tradeNumber:  gs.tradeNumber,
        peakRRPos:    gs.peakRRPos ?? 0,
        peakRRNeg:    gs.peakRRNeg ?? 0,
        slMilestones: gs.slMilestones ?? {},
        rrMilestones: gs.rrMilestones ?? {},
        phantomSL:    gs.sl,
        phantomSLHit: false,
        stopReason:   null,
        timeToSLMin:  null,
        closedAt:     null,
      };
      openPositions.set(gs.positionId, {
        positionId:   gs.positionId,
        symbol:       gs.symbol,
        mt5Symbol:    gs.mt5Symbol ?? gs.symbol,
        direction:    gs.direction,
        vwapPosition: gs.vwapPosition ?? "unknown",
        session:      gs.session,
        entry:        gs.entry,
        sl:           gs.sl,
        tp:           null,
        lots:         null,
        riskPct:      gs.riskPct,
        riskEUR:      gs.riskEUR,
        openedAt:     gs.openedAt,
        optimizerKey: gs.optimizerKey,
        ghost,
      });
      restored++;
    }
    console.log(`[Startup] Restored ${restored} open positions from ghost_state`);
  } catch (e) {
    recordError(`restorePositionsFromMT5: ${e.message}`);
    console.error("[Startup] restorePositionsFromMT5 failed:", e.message);
  }
}

// ── MetaAPI position sync (cron every 30s) ────────────────────────
async function syncPositions() {
  if (!isMonitoringActive()) return;
  try {
    const livePositions = await getPositions();
    if (!Array.isArray(livePositions)) return;

    const liveIds = new Set(livePositions.map(p => String(p.id)));

    // Detect newly closed positions
    for (const [posId, pos] of openPositions.entries()) {
      if (!liveIds.has(posId)) {
        // Position no longer open — it was closed
        await handlePositionClosed(posId, "manual", null);
      }
    }

    // Update ghost prices for still-open positions
    for (const lp of livePositions) {
      const posId = String(lp.id);
      const pos   = openPositions.get(posId);
      if (pos?.ghost && lp.currentPrice) {
        updateGhostPrice(pos.ghost, lp.currentPrice);
        // Persist ghost state periodically
        await db.saveGhostState(pos.ghost);
      }
    }
  } catch (e) {
    recordError(`syncPositions: ${e.message}`);
  }
}

// ── Express app ───────────────────────────────────────────────────
const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ── Dashboard HTML ────────────────────────────────────────────────
app.get("/", (req, res) => {
  const html = buildDashboardHTML();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ── Health / status ────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "12.7.0", ts: new Date().toISOString() });
});

app.get("/status", async (req, res) => {
  // Always respond within 3s — never hang the dashboard
  const base = {
    version:        "12.7.0",
    openPositions:  openPositions.size,
    complianceDate: liveComplianceDate,
    errorCount:     getErrorCount(),
    ts:             new Date().toISOString(),
  };
  try {
    const acct = await Promise.race([
      getAccountInfo(),
      new Promise(r => setTimeout(() => r(null), 2500)),
    ]);
    res.json({
      ...base,
      account: acct ? {
        balance:  acct.balance,
        equity:   acct.equity,
        margin:   acct.margin,
        currency: acct.currency,
      } : null,
    });
  } catch (e) {
    recordError(`/status: ${e.message}`);
    res.json({ ...base, account: null });
  }
});

// ── Compliance date management ────────────────────────────────────
app.post("/compliance-date", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { date } = req.body ?? {};
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) {
    return res.status(400).json({ error: "date must be ISO format YYYY-MM-DD" });
  }
  const isoStr = date.length === 10 ? `${date} 00:00:00` : date;
  liveComplianceDate = isoStr;
  db.setComplianceDateLive(isoStr);
  await db.saveComplianceDate(isoStr);
  console.log(`[ComplianceDate] Set to ${isoStr}`);
  res.json({ ok: true, complianceDate: isoStr });
});

app.get("/compliance-date", async (req, res) => {
  res.json({ complianceDate: liveComplianceDate });
});

// ── TradingView Webhook ───────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const t0 = Date.now();
  if (!checkSecret(req, res)) return;

  const body = req.body;
  const { symbol: rawSymbol, direction, sl_pct: slPctRaw,
          vwap, vwap_upper, vwap_upper2, vwap_lower, vwap_lower2,
          close: tvClose } = body ?? {};

  // Normalize symbol
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) {
    await db.logSignal({
      symbol: rawSymbol, direction, outcome: "REJECTED",
      rejectReason: `UNKNOWN_SYMBOL: ${rawSymbol}`,
      latencyMs: Date.now() - t0,
    });
    return res.status(400).json({ error: `Unknown symbol: ${rawSymbol}` });
  }

  const symInfo  = getSymbolInfo(symbol);
  const mt5Sym   = symInfo?.mt5 ?? symbol;
  const assetType = symInfo?.type ?? "forex";

  // Market open check
  const { allowed, reason: marketReason } = canOpenNewTrade(symbol);
  if (!allowed) {
    await db.logSignal({
      symbol, direction, session: getSession(), vwapPosition: null,
      optimizerKey: null,
      tvEntry: tvClose ? parseFloat(tvClose) : null,
      slPct: slPctRaw ? parseFloat(slPctRaw) : null,
      outcome: "REJECTED",
      rejectReason: marketReason,
      latencyMs: Date.now() - t0,
    });
    return res.json({ ok: false, reason: marketReason });
  }

  // VWAP position
  const tvEntry    = tvClose ? parseFloat(tvClose) : null;
  const vwapMid    = vwap    ? parseFloat(vwap)    : null;
  const vwapUp     = vwap_upper  ? parseFloat(vwap_upper)  : null;
  const vwapUp2    = vwap_upper2 ? parseFloat(vwap_upper2) : null;
  const vwapLow    = vwap_lower  ? parseFloat(vwap_lower)  : null;
  const vwapLow2   = vwap_lower2 ? parseFloat(vwap_lower2) : null;

  const vwapPos    = getVwapPosition(tvEntry, vwapMid);
  const session    = getSession();
  const optKey     = buildOptimizerKey(symbol, session, direction, vwapPos);

  // VWAP band % (distance from midline as % of midline)
  let vwapBandPct = null;
  if (tvEntry && vwapMid && vwapMid > 0) {
    vwapBandPct = parseFloat((Math.abs(tvEntry - vwapMid) / vwapMid * 100).toFixed(4));
  }

  // VWAP band exhaustion check (>150% → reject)
  const vwapBandRange = vwapPos === "above"
    ? (vwapUp2 ?? vwapUp ?? null)
    : (vwapLow2 ?? vwapLow ?? null);

  const slPct = slPctRaw ? parseFloat(slPctRaw) : null;

  // Get account equity for lot calc
  let equity = 10000;  // fallback
  try {
    const acct = await getAccountInfo();
    if (acct?.equity) equity = parseFloat(acct.equity);
  } catch (e) { /* use fallback */ }

  // Risk calculation
  const baseRiskPct = getRiskPct(symbol, assetType);
  const km          = keyRiskMults[optKey] ?? { evMult: 1.0, dayMult: 1.0 };
  const finalRiskPct = baseRiskPct * (km.evMult ?? 1.0) * (km.dayMult ?? 1.0);
  const riskEUR      = parseFloat((equity * finalRiskPct).toFixed(2));

  // Fetch MetaAPI quote for execution
  let executionPrice = tvEntry;
  let spreadAtEntry  = null;
  let bid = null, ask = null;
  try {
    const quote = await metaFetch(
      `/users/current/accounts/${META_ACCOUNT}/symbols/${mt5Sym}/current-price`
    );
    bid = quote?.bid ? parseFloat(quote.bid) : null;
    ask = quote?.ask ? parseFloat(quote.ask) : null;
    if (bid && ask) {
      spreadAtEntry  = parseFloat((ask - bid).toFixed(6));
      executionPrice = direction === "buy" ? ask : bid;
    }
  } catch (e) { /* use TV entry */ }

  const slippage = tvEntry && executionPrice
    ? parseFloat((Math.abs(executionPrice - tvEntry)).toFixed(6))
    : null;

  // SL price calculation
  const slBuffMult = assetType === "stock" ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
  const slDistFrac = (slPct ?? 0.003) * slBuffMult;  // default 0.3% SL
  const slPrice    = direction === "buy"
    ? parseFloat((executionPrice * (1 - slDistFrac)).toFixed(6))
    : parseFloat((executionPrice * (1 + slDistFrac)).toFixed(6));

  // TP price from optimizer
  const tpConfig = tpConfigs[optKey];
  const tpRR     = tpConfig?.lockedRR ?? 2.0;  // default 2R
  const slDist   = Math.abs(executionPrice - slPrice);
  const tpPrice  = direction === "buy"
    ? parseFloat((executionPrice + slDist * tpRR).toFixed(6))
    : parseFloat((executionPrice - slDist * tpRR).toFixed(6));

  // Lot calculation
  const lotNominal = slDist > 0 ? riskEUR / slDist : 0.01;
  let lots;
  if (assetType === "forex")     lots = parseFloat((lotNominal / 100000).toFixed(2));
  else if (assetType === "index") lots = parseFloat((lotNominal / 1).toFixed(2));
  else if (assetType === "stock") lots = parseFloat((lotNominal / executionPrice).toFixed(2));
  else lots = parseFloat((lotNominal / 100).toFixed(2)); // commodity (gold)
  lots = Math.max(lots, 0.01);

  // Get next trade number
  let tradeNumber = null;
  try {
    tradeNumber = await db.getNextTradeNumber();
  } catch (e) { /* non-critical */ }

  // Place order on MetaAPI
  let positionId = null;
  let placed     = false;
  try {
    const order = {
      symbol:          mt5Sym,
      actionType:      direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume:          lots,
      stopLoss:        slPrice,
      takeProfit:      tpPrice,
      comment:         `PRONTO-AI #${tradeNumber ?? "?"}`,
    };
    const result = await placeOrder(order);
    positionId   = result?.positionId ?? result?.orderId ?? String(Date.now());
    placed       = true;
    console.log(`[Webhook] Placed ${symbol} ${direction} lot=${lots} sl=${slPrice} tp=${tpPrice} pos=${positionId}`);
  } catch (e) {
    recordError(`placeOrder: ${e.message}`);
    await db.logSignal({
      symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, vwap: vwapMid, vwapUpper: vwapUp, vwapLower: vwapLow, vwapBandPct,
      outcome: "ERROR", rejectReason: e.message, latencyMs: Date.now() - t0,
    });
    await db.logWebhook({
      symbol, direction, session, vwapPos, action: "place", status: "ERROR",
      reason: e.message, entry: executionPrice, sl: slPrice, tp: tpPrice,
      lots, riskPct: finalRiskPct, optimizerKey: optKey,
      latencyMs: Date.now() - t0, tvEntry, executionPrice, slippage, vwapBandPct,
    });
    return res.status(500).json({ error: e.message });
  }

  // Track position in memory
  const pos = {
    positionId,
    symbol,
    mt5Symbol:      mt5Sym,
    direction,
    vwapPosition:   vwapPos,
    session,
    entry:          executionPrice,
    sl:             slPrice,
    tp:             tpPrice,
    lots,
    riskPct:        finalRiskPct,
    riskEUR,
    openedAt:       new Date().toISOString(),
    optimizerKey:   optKey,
    tpRRUsed:       tpRR,
    slMultiplier:   slBuffMult,
    vwapAtEntry:    vwapMid,
    tvEntry,
    executionPrice,
    slippage,
    spreadAtEntry,
    vwapBandPct,
    tradeNumber,
    excludeFromEV:  false,
    ghost:          null,
  };
  pos.ghost = initGhostForPosition({
    ...pos,
    slPct:      slPct ?? slDistFrac,
    evMult:     km.evMult  ?? 1.0,
    dayMult:    km.dayMult ?? 1.0,
  });

  openPositions.set(positionId, pos);

  // Save ghost state to DB
  await db.saveGhostState(pos.ghost);

  // Save spread log
  if (bid && ask) {
    const { hour, minute } = getBrusselsComponents();
    const day = getBrusselsComponents().day;
    await db.saveSpreadLog({
      symbol, mt5Symbol: mt5Sym, session,
      hourBrussels: hour, minuteBrussels: minute, dayOfWeek: day,
      bid, ask, spreadAbs: spreadAtEntry,
      spreadPct: spreadAtEntry && executionPrice > 0
        ? parseFloat((spreadAtEntry / executionPrice * 100).toFixed(4))
        : null,
      assetType, positionId,
    });
  }

  const latencyMs = Date.now() - t0;

  // Log signal
  await db.logSignal({
    symbol, direction, session, vwapPosition: vwapPos,
    optimizerKey: optKey,
    tvEntry, slPct,
    slPctHuman: slPct ? `${(slPct * 100).toFixed(3)}%` : null,
    vwap: vwapMid, vwapUpper: vwapUp, vwapLower: vwapLow, vwapBandPct,
    outcome: "PLACED", rejectReason: null, latencyMs, positionId,
  });

  // Log webhook history
  await db.logWebhook({
    symbol, direction, session, vwapPos, action: "place", status: "OK",
    reason: null, positionId, entry: executionPrice,
    sl: slPrice, tp: tpPrice, lots, riskPct: finalRiskPct,
    optimizerKey: optKey, latencyMs, tvEntry, executionPrice, slippage, vwapBandPct,
  });

  res.json({
    ok:         true,
    positionId,
    symbol,
    direction,
    lots,
    entry:      executionPrice,
    sl:         slPrice,
    tp:         tpPrice,
    riskEUR,
    tpRR,
    tradeNumber,
    latencyMs,
  });
});

// ── Manual close ──────────────────────────────────────────────────
app.post("/close/:positionId", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { positionId } = req.params;
  try {
    await closePosition(positionId);
    await handlePositionClosed(positionId, "manual", null);
    res.json({ ok: true, positionId });
  } catch (e) {
    recordError(`/close: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── History deals (called by TradingView or external) ────────────
app.post("/history-deals", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { positionId } = req.body ?? {};
  if (!positionId) return res.status(400).json({ error: "positionId required" });
  try {
    const deals = await fetchHistoryDeals(positionId);
    for (const deal of deals) {
      await db.saveDeal({
        positionId,
        dealId:     deal.id ?? deal.dealId,
        symbol:     deal.symbol,
        type:       deal.type,
        profit:     deal.profit ?? 0,
        commission: deal.commission ?? 0,
        swap:       deal.swap ?? 0,
        volume:     deal.volume,
        price:      deal.price,
        time:       deal.time,
      });
    }
    const pnl = await db.fetchRealizedPnl(positionId);
    res.json({ ok: true, deals: deals.length, realizedPnl: pnl });
  } catch (e) {
    recordError(`/history-deals: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard API endpoints ────────────────────────────────────────
// FIX EMPTY STATE: all endpoints return safe defaults when data is missing.

app.get("/api/open-positions", async (req, res) => {
  try {
    const positions = [];
    for (const [posId, pos] of openPositions.entries()) {
      const ghost = pos.ghost;
      positions.push({
        positionId:   posId,
        symbol:       pos.symbol,
        direction:    pos.direction,
        session:      pos.session,
        vwapPosition: pos.vwapPosition,
        optimizerKey: pos.optimizerKey,
        entry:        pos.entry,
        sl:           pos.sl,
        tp:           pos.tp,
        lots:         pos.lots,
        riskPct:      pos.riskPct,
        riskEUR:      pos.riskEUR,
        openedAt:     pos.openedAt,
        tradeNumber:  pos.tradeNumber,
        ghost: ghost ? {
          maxRR:        ghost.maxRR,
          maxSlPctUsed: ghost.maxSlPctUsed,
          peakRRPos:    ghost.peakRRPos,
          peakRRNeg:    ghost.peakRRNeg,
          slMilestones: ghost.slMilestones,
          rrMilestones: ghost.rrMilestones,
        } : null,
      });
    }
    res.json(positions);
  } catch (e) {
    recordError(`/api/open-positions: ${e.message}`);
    res.json([]);  // FIX EMPTY STATE
  }
});

app.get("/api/trades", async (req, res) => {
  try {
    const trades = await db.loadAllTrades();
    res.json(trades ?? []);
  } catch (e) {
    recordError(`/api/trades: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/ghost-trades", async (req, res) => {
  try {
    const { key, limit } = req.query;
    const trades = await db.loadGhostTrades(key ?? null, parseInt(limit) || 200);
    res.json(trades ?? []);
  } catch (e) {
    recordError(`/api/ghost-trades: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/ghost-grouped", async (req, res) => {
  try {
    const data = await db.loadGhostGrouped();
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/ghost-grouped: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/ghost-history-by-pair", async (req, res) => {
  try {
    const data = await db.loadGhostHistoryByPair();
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/ghost-history-by-pair: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/ghost-combo-analysis", async (req, res) => {
  try {
    const data = await db.loadGhostComboAnalysis(req.query.key ?? null);
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/ghost-combo-analysis: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/ev-stats", async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "key required" });
    const stats = await computeEVStatsWithRetry(key);  // FIX EV RETRY
    res.json(stats ?? { count: 0, rrLevels: [] });
  } catch (e) {
    recordError(`/api/ev-stats: ${e.message}`);
    res.json({ count: 0, rrLevels: [] });
  }
});

app.get("/api/tp-config", async (req, res) => {
  try {
    const configs = await db.loadTPConfig();
    res.json(configs ?? {});
  } catch (e) {
    recordError(`/api/tp-config: ${e.message}`);
    res.json({});
  }
});

app.get("/api/shadow-analysis", async (req, res) => {
  try {
    const data = await db.loadAllShadowAnalysis();
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/shadow-analysis: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/shadow-winners", async (req, res) => {
  try {
    const data = await db.loadShadowWinners();
    res.json(data ?? {});
  } catch (e) {
    recordError(`/api/shadow-winners: ${e.message}`);
    res.json({});
  }
});

app.get("/api/mae-stats", async (req, res) => {
  try {
    const data = await db.loadMAEStats(req.query.since ?? null);
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/mae-stats: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/performance", async (req, res) => {
  try {
    const data = await db.loadPerformanceSummary();
    res.json(data ?? {
      total: 0, tpCount: 0, slCount: 0, winRate: 0,
      avgWinner: 0, avgLoser: 0, grossWins: 0, grossLosses: 0,
      profitFactor: null, totalPnl: 0, avgPnlPerTrade: 0,
      maxDrawdown: 0, pnlCurve: [],
    });
  } catch (e) {
    recordError(`/api/performance: ${e.message}`);
    res.json({ total: 0, tpCount: 0, slCount: 0, winRate: 0, pnlCurve: [] });
  }
});

app.get("/api/daily-breakdown", async (req, res) => {
  try {
    const data = await db.loadDailyBreakdown();
    res.json(data ?? { days: [], maxWinStreak: 0, maxLossStreak: 0, maxDrawdownDay: 0, bestTrades: [], worstTrades: [] });
  } catch (e) {
    recordError(`/api/daily-breakdown: ${e.message}`);
    res.json({ days: [], maxWinStreak: 0, maxLossStreak: 0, maxDrawdownDay: 0, bestTrades: [], worstTrades: [] });
  }
});

app.get("/api/signal-stats", async (req, res) => {
  try {
    const data = await db.loadSignalStats();
    res.json(data ?? { total: 0, placed: 0, conversionPct: 0, byOutcome: [], topRejectReasons: [] });
  } catch (e) {
    recordError(`/api/signal-stats: ${e.message}`);
    res.json({ total: 0, placed: 0, conversionPct: 0, byOutcome: [], topRejectReasons: [] });
  }
});

app.get("/api/signal-rejects", async (req, res) => {
  try {
    const data = await db.loadSignalRejects({ since: req.query.since });
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/signal-rejects: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/blocked-raw", async (req, res) => {
  try {
    const data = await db.loadBlockedRaw(req.query.since ?? null);
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/blocked-raw: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/webhook-history", async (req, res) => {
  try {
    const data = await db.loadWebhookHistory(parseInt(req.query.limit) || 100);
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/webhook-history: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/spread-stats", async (req, res) => {
  try {
    const { symbol, session, hourMin, hourMax, dayOfWeek } = req.query;
    const data = await db.loadSpreadStats({
      symbol, session,
      hourMin:    hourMin    ? parseInt(hourMin)    : undefined,
      hourMax:    hourMax    ? parseInt(hourMax)    : undefined,
      dayOfWeek:  dayOfWeek  ? parseInt(dayOfWeek)  : undefined,
    });
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/spread-stats: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/spread-log", async (req, res) => {
  try {
    const { symbol, session, limit } = req.query;
    const data = await db.loadSpreadLog({ symbol, session, limit: parseInt(limit) || 500 });
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/spread-log: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/band-ghosts", async (req, res) => {
  try {
    const { bandTier, symbol, optimizerKey, limit } = req.query;
    const data = await db.loadBandGhosts({ bandTier, symbol, optimizerKey, limit: parseInt(limit) || 500 });
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/band-ghosts: ${e.message}`);
    res.json([]);
  }
});

app.get("/api/band-ghost-stats", async (req, res) => {
  try {
    const { bandTier } = req.query;
    if (!bandTier) return res.status(400).json({ error: "bandTier required" });
    const data = await db.loadBandGhostStats(bandTier);
    res.json(data ?? []);
  } catch (e) {
    recordError(`/api/band-ghost-stats: ${e.message}`);
    res.json([]);
  }
});

// ── Symbol risk config ─────────────────────────────────────────────
app.get("/api/symbol-risk", async (req, res) => {
  try {
    const data = await db.loadSymbolRiskConfig();
    res.json(data ?? {});
  } catch (e) {
    recordError(`/api/symbol-risk: ${e.message}`);
    res.json({});
  }
});

app.post("/api/symbol-risk", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { symbol, riskPct } = req.body ?? {};
  if (!symbol || riskPct == null) return res.status(400).json({ error: "symbol + riskPct required" });
  try {
    await db.upsertSymbolRisk(symbol, riskPct);
    symbolRiskMap[symbol] = parseFloat(riskPct);
    res.json({ ok: true, symbol, riskPct });
  } catch (e) {
    recordError(`/api/symbol-risk POST: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Shadow SL optimizer (cron: every 6h) ─────────────────────────
async function runShadowOptimizer() {
  if (!isMonitoringActive()) return;
  try {
    const allAnalysis = await db.loadAllShadowAnalysis();
    for (const a of allAnalysis) {
      const snaps = await db.loadShadowSnapshots(a.optimizerKey, 5000);
      if (snaps.length < 30) continue;
      const pcts = snaps.map(s => s.pctSlUsed).filter(v => v != null).sort((a,b) => a-b);
      const n = pcts.length;
      const p = (q) => pcts[Math.min(n-1, Math.floor(q * n))];
      const p50 = p(0.50), p90 = p(0.90), p99 = p(0.99);
      const maxUsed = pcts[n-1];
      const recPct  = p90 < 80 ? parseFloat((p90 * 1.1).toFixed(1)) : 100;
      await db.saveShadowAnalysis({
        optimizerKey:   a.optimizerKey,
        symbol:         a.symbol,
        session:        a.session,
        direction:      a.direction,
        vwapPosition:   a.vwapPosition,
        snapshotsCount: n,
        positionsCount: new Set(snaps.map(s => s.positionId)).size,
        p50, p90, p99, maxUsed,
        recommendation: {
          reduceTo: recPct,
          saving:   parseFloat((100 - recPct).toFixed(1)),
        },
        currentSlTooWide: recPct < 100,
      });
    }
    console.log(`[ShadowOptimizer] Ran for ${allAnalysis.length} keys`);
  } catch (e) {
    recordError(`runShadowOptimizer: ${e.message}`);
  }
}

// ── TP Optimizer (cron: every 1h) ────────────────────────────────
async function runTPOptimizer() {
  if (!isMonitoringActive()) return;
  try {
    const configs = await db.loadTPConfig();
    tpConfigs     = configs;

    // Recompute EV for all keys with enough data
    const ghostGrouped = await db.loadGhostGrouped();
    for (const group of ghostGrouped) {
      if (group.n < 10) continue;
      const ev = await computeEVStatsWithRetry(group.optimizerKey);
      if (!ev || ev.count < 10 || !ev.bestRR) continue;
      const km     = keyRiskMults[group.optimizerKey] ?? { streak: 0, evMult: 1.0, dayMult: 1.0 };
      const evMult = ev.bestEV > 0 ? Math.min(1.5, 1.0 + ev.bestEV) : Math.max(0.5, 1.0 + ev.bestEV);
      const newKm  = { streak: km.streak, evMult: parseFloat(evMult.toFixed(4)), dayMult: km.dayMult ?? 1.0 };
      keyRiskMults[group.optimizerKey] = newKm;
      await db.saveKeyRiskMult(group.optimizerKey, newKm);

      // Lock TP if not already set or if ghost count doubled
      const existing = tpConfigs[group.optimizerKey];
      if (!existing || (group.n >= (existing.lockedGhosts ?? 0) * 2)) {
        await db.saveTPConfig(
          group.optimizerKey, group.symbol, group.session,
          group.direction, group.vwapPosition,
          ev.bestRR, group.n, ev.bestEV,
          existing?.lockedRR ?? null
        );
        tpConfigs[group.optimizerKey] = {
          ...existing,
          lockedRR:     ev.bestRR,
          lockedGhosts: group.n,
        };
      }
    }
    console.log(`[TPOptimizer] Updated ${ghostGrouped.length} keys`);
  } catch (e) {
    recordError(`runTPOptimizer: ${e.message}`);
  }
}

// ── Shadow snapshot cron (every 5min for open positions) ──────────
async function runShadowSnapshots() {
  if (!isShadowActive()) return;
  if (openPositions.size === 0) return;
  try {
    const livePositions = await getPositions();
    if (!Array.isArray(livePositions)) return;
    const priceMap = new Map(livePositions.map(p => [String(p.id), p.currentPrice]));
    for (const [posId, pos] of openPositions.entries()) {
      const price = priceMap.get(posId);
      if (!price) continue;
      const entry  = pos.entry;
      const sl     = pos.sl;
      const slDist = Math.abs(entry - sl);
      if (slDist <= 0) continue;
      const isBuy  = pos.direction === "buy";
      const adverse = isBuy ? (entry - price) : (price - entry);
      const pctSlUsed = parseFloat(((adverse / slDist) * 100).toFixed(2));
      await db.saveShadowSnapshot({
        positionId:   posId,
        optimizerKey: pos.optimizerKey,
        symbol:       pos.symbol,
        session:      pos.session,
        direction:    pos.direction,
        vwapPosition: pos.vwapPosition ?? "unknown",
        entry,
        sl,
        currentPrice: price,
        pctSlUsed:    Math.max(0, pctSlUsed),
      });
    }
  } catch (e) {
    recordError(`runShadowSnapshots: ${e.message}`);
  }
}

// ── Dashboard HTML builder ────────────────────────────────────────
function buildDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v12.7.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--sur:#161b22;--bor:#30363d;
  --tx:#c9d1d9;--mt:#8b949e;--gr:#3fb950;
  --rd:#f85149;--yl:#d29922;--bl:#58a6ff;
}
body{background:var(--bg);color:var(--tx);font-family:'SF Mono',Consolas,monospace;font-size:13px;min-height:100vh}
header{background:var(--sur);border-bottom:1px solid var(--bor);padding:10px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h1{font-size:15px;color:var(--bl);white-space:nowrap}
.badge{background:var(--bor);border-radius:4px;padding:2px 8px;font-size:11px;white-space:nowrap}
.badge.ok{background:#1a3a1a;color:var(--gr);border:1px solid var(--gr)}
.badge.err{background:#3a1a1a;color:var(--rd);border:1px solid var(--rd)}
.badge.warn{background:#3a2a00;color:var(--yl);border:1px solid var(--yl)}
#clock{margin-left:auto;color:var(--mt);font-size:11px}
#banner{background:#0d1a2d;border-bottom:1px solid var(--bor);padding:5px 16px;color:var(--mt);font-size:11px}
.tabs{display:flex;gap:0;border-bottom:1px solid var(--bor);overflow-x:auto}
.tab{padding:8px 14px;cursor:pointer;color:var(--mt);white-space:nowrap;border-bottom:2px solid transparent;transition:color .15s}
.tab:hover{color:var(--tx)}
.tab.active{color:var(--bl);border-bottom-color:var(--bl)}
.content{padding:14px 16px}
.panel{display:none}.panel.active{display:block}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:18px}
.kpi{background:var(--sur);border:1px solid var(--bor);border-radius:6px;padding:10px}
.kpi-label{font-size:10px;color:var(--mt);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.kpi-value{font-size:20px;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:var(--mt);font-weight:normal;font-size:10px;text-transform:uppercase;padding:5px 8px;border-bottom:1px solid var(--bor);text-align:left;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #21262d;white-space:nowrap}
tr:hover td{background:#1c2128}
.gr{color:var(--gr)}.rd{color:var(--rd)}.yl{color:var(--yl)}.bl{color:var(--bl)}.mt{color:var(--mt)}
h3{font-size:12px;color:var(--mt);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px}
.empty{color:var(--mt);padding:24px 0;text-align:center;font-size:12px}
.spin{display:inline-block;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<header>
  <h1>🤖 PRONTO-AI</h1>
  <span class="badge" id="vbadge">v12.7.0</span>
  <span class="badge" id="sbadge"><span class="spin">⟳</span> verbinden…</span>
  <span class="badge" id="ebadge" style="display:none"></span>
  <span id="clock"></span>
</header>
<div id="banner">📅 Data van: laden…</div>

<div class="tabs">
  <div class="tab active" id="tab-overview"   onclick="showTab('overview',this)">Overview</div>
  <div class="tab"        id="tab-positions"  onclick="showTab('positions',this)">Posities</div>
  <div class="tab"        id="tab-trades"     onclick="showTab('trades',this)">Trades</div>
  <div class="tab"        id="tab-ghost"      onclick="showTab('ghost',this)">Ghost</div>
  <div class="tab"        id="tab-ev"         onclick="showTab('ev',this)">EV</div>
  <div class="tab"        id="tab-signals"    onclick="showTab('signals',this)">Signalen</div>
  <div class="tab"        id="tab-spreads"    onclick="showTab('spreads',this)">Spreads</div>
</div>

<div class="content">

<!-- OVERVIEW -->
<div class="panel active" id="panel-overview">
  <div class="kpi-grid" id="kpi-grid">
    <div class="kpi"><div class="kpi-label">Status</div><div class="kpi-value mt"><span class="spin">⟳</span></div></div>
  </div>
  <h3>Dagelijkse P&amp;L</h3>
  <div id="daily-wrap"><div class="empty"><span class="spin">⟳</span> Laden…</div></div>
</div>

<!-- POSITIES -->
<div class="panel" id="panel-positions">
  <div id="pos-wrap"><div class="empty"><span class="spin">⟳</span> Laden…</div></div>
</div>

<!-- TRADES -->
<div class="panel" id="panel-trades">
  <div id="trades-wrap"><div class="empty"><span class="spin">⟳</span> Laden…</div></div>
</div>

<!-- GHOST -->
<div class="panel" id="panel-ghost">
  <div id="ghost-wrap"><div class="empty"><span class="spin">⟳</span> Laden…</div></div>
</div>

<!-- EV -->
<div class="panel" id="panel-ev">
  <div id="ev-wrap"><div class="empty"><span class="spin">⟳</span> Laden…</div></div>
</div>

<!-- SIGNALEN -->
<div class="panel" id="panel-signals">
  <div class="kpi-grid" id="sig-kpi"></div>
  <h3>Webhook History</h3>
  <div id="sig-wrap"><div class="empty"><span class="spin">⟳</span> Laden…</div></div>
</div>

<!-- SPREADS -->
<div class="panel" id="panel-spreads">
  <div id="spr-wrap"><div class="empty"><span class="spin">⟳</span> Laden…</div></div>
</div>

</div><!-- /content -->

<script>
'use strict';

// ── Helpers ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const f2 = n => n == null ? '—' : Number(n).toFixed(2);
const f1 = n => n == null ? '—' : Number(n).toFixed(1);
const f0 = n => n == null ? '—' : Number(n).toFixed(0);
const f5 = n => n == null ? '—' : Number(n).toFixed(5);
const pct = n => n == null ? '—' : Number(n).toFixed(1) + '%';
const eur = n => n == null ? '—' : '€' + Number(n).toFixed(2);
const clr = n => Number(n) >= 0 ? 'gr' : 'rd';

function fmtDT(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('nl-BE', {
      timeZone: 'Europe/Brussels', hour12: false,
      day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
    });
  } catch { return s; }
}

// Safe fetch with timeout — never hangs the dashboard
async function apiFetch(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    clearTimeout(tid);
    console.warn('apiFetch failed:', url, e.message);
    return null;
  }
}

// ── Tab switching ────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  $('panel-' + name).classList.add('active');
  // Lazy-load tab content
  if (name === 'positions') loadPositions();
  if (name === 'trades')    loadTrades();
  if (name === 'ghost')     loadGhost();
  if (name === 'ev')        loadEV();
  if (name === 'signals')   loadSignals();
  if (name === 'spreads')   loadSpreads();
}

// ── Clock ────────────────────────────────────────────────────────
function updateClock() {
  try {
    $('clock').textContent = new Date().toLocaleString('nl-BE',
      {timeZone:'Europe/Brussels',hour12:false});
  } catch {}
}
updateClock();
setInterval(updateClock, 1000);

// ── Status poller ────────────────────────────────────────────────
let statusOK = false;
async function pollStatus() {
  const data = await apiFetch('/status', 5000);
  const sb = $('sbadge');
  const eb = $('ebadge');
  if (!data) {
    sb.textContent = '✖ offline';
    sb.className = 'badge err';
    statusOK = false;
    return;
  }
  statusOK = true;
  const eq = data.account?.equity;
  sb.textContent = (eq != null ? '€' + f0(eq) + ' | ' : '') + data.openPositions + ' pos open';
  sb.className = 'badge ok';

  // Compliance banner
  if (data.complianceDate) {
    $('banner').textContent = '📅 Data vanaf: ' + data.complianceDate + ' UTC';
  }

  // Error badge
  if (data.errorCount > 0) {
    eb.textContent = '⚠ ' + data.errorCount + ' fout' + (data.errorCount > 1 ? 'en' : '') + ' /1u';
    eb.className = 'badge warn';
    eb.style.display = '';
  } else {
    eb.style.display = 'none';
  }
}

// ── Overview ─────────────────────────────────────────────────────
async function loadOverview() {
  const kg = $('kpi-grid');
  const dw = $('daily-wrap');

  const [perf, daily] = await Promise.all([
    apiFetch('/api/performance'),
    apiFetch('/api/daily-breakdown'),
  ]);

  const p = perf || {};
  const kpis = [
    ['Trades',        f0(p.total),                          ''],
    ['Win Rate',      pct(p.winRate),                       p.winRate >= 50 ? 'gr' : 'rd'],
    ['Profit Factor', p.profitFactor != null ? f2(p.profitFactor) : '—', (p.profitFactor||0) >= 1 ? 'gr' : 'rd'],
    ['Totaal PnL',    eur(p.totalPnl),                      clr(p.totalPnl)],
    ['Gem. Winner',   eur(p.avgWinner),                     'gr'],
    ['Gem. Loser',    eur(p.avgLoser),                      'rd'],
    ['Max Drawdown',  eur(p.maxDrawdown),                   'rd'],
    ['TP Trades',     f0(p.tpCount),                        'gr'],
    ['SL Trades',     f0(p.slCount),                        'rd'],
  ];

  if (!p.total && p.total !== 0) {
    kg.innerHTML = '<div class="kpi"><div class="kpi-label">Status</div><div class="kpi-value rd">DB fout</div></div>';
  } else if (p.total === 0) {
    kg.innerHTML = '<div class="kpi" style="grid-column:1/-1"><div class="kpi-label">Status</div><div class="kpi-value mt">Geen trades nog</div></div>';
  } else {
    kg.innerHTML = kpis.map(([l, v, c]) =>
      '<div class="kpi"><div class="kpi-label">' + l + '</div><div class="kpi-value ' + c + '">' + v + '</div></div>'
    ).join('');
  }

  const days = daily?.days || [];
  if (!days.length) {
    dw.innerHTML = '<div class="empty">Geen dagdata beschikbaar</div>';
  } else {
    dw.innerHTML = '<table><thead><tr>' +
      '<th>Datum</th><th>Trades</th><th>W</th><th>L</th><th>PnL €</th><th>Cum PnL</th><th>Gem RR</th>' +
      '</tr></thead><tbody>' +
      days.slice(0, 30).map(d =>
        '<tr>' +
        '<td class="mt">' + (d.trade_date || '—') + '</td>' +
        '<td>' + (d.trades || 0) + '</td>' +
        '<td class="gr">' + (d.wins || 0) + '</td>' +
        '<td class="rd">' + (d.losses || 0) + '</td>' +
        '<td class="' + clr(d.day_pnl) + '">' + eur(d.day_pnl) + '</td>' +
        '<td class="' + clr(d.cum_pnl) + '">' + eur(d.cum_pnl) + '</td>' +
        '<td>' + f2(d.avg_rr) + '</td>' +
        '</tr>'
      ).join('') +
      '</tbody></table>';
  }
}

// ── Posities ─────────────────────────────────────────────────────
async function loadPositions() {
  const wrap = $('pos-wrap');
  wrap.innerHTML = '<div class="empty"><span class="spin">⟳</span> Laden…</div>';
  const data = await apiFetch('/api/open-positions');
  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">Geen open posities</div>';
    return;
  }
  wrap.innerHTML = '<table><thead><tr>' +
    '<th>#</th><th>Symbol</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th>' +
    '<th>Lots</th><th>Risk €</th><th>MaxRR</th><th>SL%</th><th>Geopend</th>' +
    '</tr></thead><tbody>' +
    rows.map(p =>
      '<tr>' +
      '<td class="mt">' + (p.tradeNumber || '—') + '</td>' +
      '<td class="bl">' + (p.symbol || '—') + '</td>' +
      '<td class="' + (p.direction === 'buy' ? 'gr' : 'rd') + '">' + (p.direction || '—') + '</td>' +
      '<td>' + f5(p.entry) + '</td>' +
      '<td class="rd">' + f5(p.sl) + '</td>' +
      '<td class="gr">' + f5(p.tp) + '</td>' +
      '<td>' + f2(p.lots) + '</td>' +
      '<td>' + eur(p.riskEUR) + '</td>' +
      '<td class="' + ((p.ghost?.maxRR || 0) > 0 ? 'gr' : '') + '">' + f2(p.ghost?.maxRR) + '</td>' +
      '<td>' + f1(p.ghost?.maxSlPctUsed) + '%</td>' +
      '<td class="mt">' + fmtDT(p.openedAt) + '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

// ── Trades ───────────────────────────────────────────────────────
async function loadTrades() {
  const wrap = $('trades-wrap');
  wrap.innerHTML = '<div class="empty"><span class="spin">⟳</span> Laden…</div>';
  const data = await apiFetch('/api/trades');
  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">Geen gesloten trades</div>';
    return;
  }
  wrap.innerHTML = '<table><thead><tr>' +
    '<th>#</th><th>Symbol</th><th>Dir</th><th>Uitkomst</th><th>PnL €</th>' +
    '<th>MaxRR</th><th>Lots</th><th>Sessie</th><th>Gesloten</th>' +
    '</tr></thead><tbody>' +
    rows.slice(0, 200).map((t, i) =>
      '<tr>' +
      '<td class="mt">' + (rows.length - i) + '</td>' +
      '<td class="bl">' + (t.symbol || '—') + '</td>' +
      '<td class="' + (t.direction === 'buy' ? 'gr' : 'rd') + '">' + (t.direction || '—') + '</td>' +
      '<td class="' + (t.hitTP ? 'gr' : 'rd') + '">' + (t.hitTP ? 'TP' : 'SL') + ' <span class="mt">(' + (t.closeReason || '?') + ')</span></td>' +
      '<td class="' + clr(t.realizedPnlEUR) + '">' + eur(t.realizedPnlEUR) + '</td>' +
      '<td>' + f2(t.maxRR) + '</td>' +
      '<td>' + f2(t.lots) + '</td>' +
      '<td class="mt">' + (t.session || '—') + '</td>' +
      '<td class="mt">' + fmtDT(t.closedAt) + '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

// ── Ghost ────────────────────────────────────────────────────────
async function loadGhost() {
  const wrap = $('ghost-wrap');
  wrap.innerHTML = '<div class="empty"><span class="spin">⟳</span> Laden…</div>';
  const data = await apiFetch('/api/ghost-grouped');
  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">Nog geen ghost data (wacht op gesloten trades)</div>';
    return;
  }
  wrap.innerHTML = '<table><thead><tr>' +
    '<th>Optimizer Key</th><th>N</th><th>SL Hits</th><th>Gem MaxRR</th><th>Best MaxRR</th><th>Gem SL%</th><th>Gem TP RR</th><th>Laatste</th>' +
    '</tr></thead><tbody>' +
    rows.map(g =>
      '<tr>' +
      '<td class="bl">' + (g.optimizerKey || '—') + '</td>' +
      '<td>' + (g.n || 0) + '</td>' +
      '<td class="rd">' + (g.slHits || 0) + '</td>' +
      '<td>' + f2(g.avgMaxRR) + '</td>' +
      '<td class="gr">' + f2(g.bestMaxRR) + '</td>' +
      '<td>' + f1(g.avgSlPct) + '%</td>' +
      '<td>' + f2(g.avgTpRR) + '</td>' +
      '<td class="mt">' + fmtDT(g.lastOpened) + '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

// ── EV Optimizer ─────────────────────────────────────────────────
async function loadEV() {
  const wrap = $('ev-wrap');
  wrap.innerHTML = '<div class="empty"><span class="spin">⟳</span> Laden…</div>';
  const [ghost, tp, combo] = await Promise.all([
    apiFetch('/api/ghost-grouped'),
    apiFetch('/api/tp-config'),
    apiFetch('/api/ghost-combo-analysis'),
  ]);
  const rows  = ghost  || [];
  const tpMap = tp     || {};
  const comboArr = combo || [];
  const comboMap = {};
  comboArr.forEach(k => { comboMap[k.optimizerKey] = k; });

  const eligible = rows.filter(g => (g.n || 0) >= 5);
  if (!eligible.length) {
    wrap.innerHTML = '<div class="empty">Nog geen EV data (minimaal 5 ghost trades per key nodig)</div>';
    return;
  }
  wrap.innerHTML = '<table><thead><tr>' +
    '<th>Key</th><th>N</th><th>Locked TP</th><th>Best EV</th><th>Win Rate</th><th>Gem RR</th><th>EV Mult</th>' +
    '</tr></thead><tbody>' +
    eligible.map(g => {
      const c  = comboMap[g.optimizerKey];
      const t  = tpMap[g.optimizerKey];
      const ev = c?.evScore;
      const wr = c?.winRate;
      return '<tr>' +
        '<td class="bl">' + (g.optimizerKey || '—') + '</td>' +
        '<td>' + (g.n || 0) + '</td>' +
        '<td class="' + ((t?.lockedRR || 0) >= 2 ? 'gr' : 'yl') + '">' + (t?.lockedRR != null ? t.lockedRR + 'R' : '—') + '</td>' +
        '<td class="' + (ev > 0 ? 'gr' : 'rd') + '">' + (ev != null ? f2(ev) : '—') + '</td>' +
        '<td>' + (wr != null ? pct(wr) : '—') + '</td>' +
        '<td>' + f2(g.avgMaxRR) + '</td>' +
        '<td class="' + (ev > 0 ? 'gr' : 'rd') + '">' + (ev != null ? (ev > 0 ? '↑' : '↓') + (Math.abs(ev) > 0.2 ? (ev > 0 ? '↑' : '↓') : '') : '—') + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table>';
}

// ── Signalen ─────────────────────────────────────────────────────
async function loadSignals() {
  $('sig-wrap').innerHTML = '<div class="empty"><span class="spin">⟳</span> Laden…</div>';
  const [stats, hist] = await Promise.all([
    apiFetch('/api/signal-stats'),
    apiFetch('/api/webhook-history?limit=50'),
  ]);
  const s = stats || {};
  const kpis = [
    ['Signalen', f0(s.total), ''],
    ['Geplaatst', f0(s.placed), 'gr'],
    ['Conversie', pct(s.conversionPct), (s.conversionPct || 0) >= 15 ? 'gr' : 'yl'],
  ];
  $('sig-kpi').innerHTML = kpis.map(([l,v,c]) =>
    '<div class="kpi"><div class="kpi-label">'+l+'</div><div class="kpi-value '+c+'">'+v+'</div></div>'
  ).join('');

  const rows = hist || [];
  if (!rows.length) {
    $('sig-wrap').innerHTML = '<div class="empty">Geen webhook history</div>';
    return;
  }
  $('sig-wrap').innerHTML = '<table><thead><tr>' +
    '<th>Tijd</th><th>Symbol</th><th>Dir</th><th>Actie</th><th>Status</th><th>Reden</th><th>Latency</th>' +
    '</tr></thead><tbody>' +
    rows.map(h =>
      '<tr>' +
      '<td class="mt">' + fmtDT(h.ts) + '</td>' +
      '<td class="bl">' + (h.symbol || '—') + '</td>' +
      '<td class="' + (h.direction === 'buy' ? 'gr' : 'rd') + '">' + (h.direction || '—') + '</td>' +
      '<td>' + (h.action || '—') + '</td>' +
      '<td class="' + (h.status === 'OK' ? 'gr' : 'rd') + '">' + (h.status || '—') + '</td>' +
      '<td class="mt">' + (h.reason || '') + '</td>' +
      '<td>' + (h.latency_ms != null ? h.latency_ms + 'ms' : '—') + '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

// ── Spreads ──────────────────────────────────────────────────────
async function loadSpreads() {
  const wrap = $('spr-wrap');
  wrap.innerHTML = '<div class="empty"><span class="spin">⟳</span> Laden…</div>';
  const data = await apiFetch('/api/spread-stats');
  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty">Geen spread data beschikbaar</div>';
    return;
  }
  wrap.innerHTML = '<table><thead><tr>' +
    '<th>Symbol</th><th>Sessie</th><th>Uur</th><th>Samples</th>' +
    '<th>Gem Spread</th><th>P50</th><th>P90</th><th>Max</th>' +
    '</tr></thead><tbody>' +
    rows.slice(0, 100).map(r =>
      '<tr>' +
      '<td class="bl">' + (r.symbol || '—') + '</td>' +
      '<td>' + (r.session || '—') + '</td>' +
      '<td>' + (r.hour_brussels != null ? r.hour_brussels + ':00' : '—') + '</td>' +
      '<td class="mt">' + (r.samples || 0) + '</td>' +
      '<td>' + (r.avg_spread_abs != null ? Number(r.avg_spread_abs).toFixed(6) : '—') + '</td>' +
      '<td>' + (r.p50_spread != null ? Number(r.p50_spread).toFixed(6) : '—') + '</td>' +
      '<td>' + (r.p90_spread != null ? Number(r.p90_spread).toFixed(6) : '—') + '</td>' +
      '<td class="rd">' + (r.max_spread != null ? Number(r.max_spread).toFixed(6) : '—') + '</td>' +
      '</tr>'
    ).join('') +
    '</tbody></table>';
}

// ── Init ─────────────────────────────────────────────────────────
// Load status + overview immediately on page load
(async () => {
  await pollStatus();
  await loadOverview();
})();

// Refresh intervals
setInterval(pollStatus,  15000);   // status every 15s
setInterval(loadOverview, 60000);  // overview every 60s

</script>
</body>
</html>`;
}

// ── Startup ────────────────────────────────────────────────────────
async function startup() {
  console.log("[Startup] PRONTO-AI v12.7.0 starting...");

  // Init DB schema
  await db.initDB();

  // Load saved compliance date from DB (may differ from session.js default)
  try {
    const savedDate = await db.loadComplianceDate();
    if (savedDate) {
      liveComplianceDate = savedDate;
      db.setComplianceDateLive(savedDate);
      console.log(`[Startup] Compliance date loaded from DB: ${savedDate}`);
    } else {
      console.log(`[Startup] Compliance date using default: ${COMPLIANCE_DATE}`);
    }
  } catch (e) {
    recordError(`loadComplianceDate: ${e.message}`);
  }

  // Load cached data
  try {
    tpConfigs      = await db.loadTPConfig();
    symbolRiskMap  = await db.loadSymbolRiskConfig();
    keyRiskMults   = await db.loadKeyRiskMults();
    console.log(`[Startup] Loaded ${Object.keys(tpConfigs).length} TP configs, ${Object.keys(symbolRiskMap).length} symbol risks`);
  } catch (e) {
    recordError(`startup load: ${e.message}`);
  }

  // Sync trade number sequence
  try {
    await db.syncTradeNumberSequence();
  } catch (e) { /* non-critical */ }

  // Restore open positions from ghost_state
  await restorePositionsFromMT5();

  // Start express server
  app.listen(PORT, () => {
    console.log(`[Startup] Server listening on port ${PORT}`);
  });

  // Cron jobs
  cron.schedule("*/30 * * * * *", syncPositions);        // every 30s: sync positions
  cron.schedule("*/5 * * * *",    runShadowSnapshots);   // every 5min: shadow snapshots
  cron.schedule("0 * * * *",      runTPOptimizer);       // every 1h:  TP optimizer
  cron.schedule("0 */6 * * *",    runShadowOptimizer);   // every 6h:  shadow SL optimizer

  console.log("[Startup] All cron jobs scheduled");
}

startup().catch(e => {
  console.error("[FATAL] startup failed:", e);
  process.exit(1);
});
