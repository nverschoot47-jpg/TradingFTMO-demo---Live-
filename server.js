"use strict";
// ═══════════════════════════════════════════════════════════════
//  PRONTO-AI  v13.1.0  server.js
//  KEY FIX: app.listen() fires BEFORE any DB/MetaAPI call.
//  The server is always reachable. DB init runs in background.
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const db = require("./db");
const {
  COMPLIANCE_DATE, COMPLIANCE_DATE_MS,
  DEFAULT_RISK_BY_TYPE, SL_BUFFER_MULT, STOCK_SL_BUFFER_MULT,
  getBrusselsComponents, getBrusselsDateStr, getBrusselsDateOnly,
  getSession, isMarketOpen, canOpenNewTrade,
  isMonitoringActive, isGhostActive, isShadowActive,
  normalizeSymbol, getSymbolInfo, getVwapPosition, buildOptimizerKey,
} = require("./session");

// ── Version ──────────────────────────────────────────────────────
const VERSION = "13.1.0";

// ── Config ───────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const META_API_TOKEN = process.env.META_API_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT   || "";
const META_BASE      = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

// ── App state ────────────────────────────────────────────────────
let dbReady          = false;   // true once initDB() succeeds
let openPositions    = new Map();
let tpConfigs        = {};
let symbolRiskMap    = {};
let keyRiskMults     = {};
let liveComplianceDate = COMPLIANCE_DATE;

// Rolling error log (1 h window)
let errorLog = [];
function recordError(msg) {
  const now = Date.now();
  errorLog.push({ ts: now, msg: String(msg) });
  errorLog = errorLog.filter(e => now - e.ts < 3_600_000);
  console.error("[ERR]", msg);
}
function getErrorCount() {
  const now = Date.now();
  return errorLog.filter(e => now - e.ts < 3_600_000).length;
}

// ── Express — start listening IMMEDIATELY ────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));

const server = app.listen(PORT, () => {
  console.log(`[PRONTO-AI] Listening on port ${PORT} — DB init starting…`);
});

// ── Webhook secret check ──────────────────────────────────────────
function checkSecret(req, res) {
  if (!WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const provided = req.headers["x-webhook-secret"] || req.body?.secret || req.query?.secret;
  if (provided !== WEBHOOK_SECRET) {
    const ip = req.ip || "?";
    recordError(`Bad webhook secret from ${ip}`);
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── MetaAPI helpers ───────────────────────────────────────────────
async function metaFetch(path, method = "GET", body = null) {
  const url = `${META_BASE}${path}`;
  const opts = {
    method,
    headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    let errBody = "";
    try { errBody = await res.text(); } catch {}
    throw new Error(`MetaAPI ${method} ${path} → ${res.status} ${errBody.slice(0, 200)}`);
  }
  return res.json().catch(() => null);
}

async function getAccountInfo() {
  if (!META_API_TOKEN || !META_ACCOUNT) {
    console.warn("[MetaAPI] getAccountInfo: TOKEN or ACCOUNT not set");
    return null;
  }
  try {
    return await metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`);
  } catch (e) {
    recordError(`getAccountInfo: ${e.message}`);
    return null;
  }
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

async function closePositionMeta(positionId) {
  return metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions/${positionId}/close`, "POST", {});
}

async function fetchHistoryDeals(positionId) {
  try {
    const to   = new Date().toISOString();
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const d    = await metaFetch(
      `/users/current/accounts/${META_ACCOUNT}/history-deals/position/${positionId}?from=${from}&to=${to}`
    );
    return Array.isArray(d) ? d : (d?.deals ?? []);
  } catch { return []; }
}

// ── DB timeout wrapper ───────────────────────────────────────────
function dbCall(promise, fallback, ms = 7000) {
  return Promise.race([
    promise.catch(e => { recordError(e.message); return fallback; }),
    new Promise(r => setTimeout(() => r(fallback), ms)),
  ]);
}

// ── Ghost helpers ────────────────────────────────────────────────
function initGhost(pos) {
  return {
    positionId:   pos.positionId,
    optimizerKey: pos.optimizerKey,
    symbol:       pos.symbol,
    mt5Symbol:    pos.mt5Symbol,
    session:      pos.session,
    direction:    pos.direction,
    vwapPosition: pos.vwapPosition,
    entry:        parseFloat(pos.entry),
    sl:           parseFloat(pos.sl),
    slPct:        pos.slPct,
    tpRRUsed:     pos.tpRRUsed,
    maxPrice:     parseFloat(pos.entry),
    maxRR:        0,
    maxSlPctUsed: 0,
    openedAt:     pos.openedAt,
    riskPct:      pos.riskPct,
    riskEUR:      pos.riskEUR,
    evMult:       pos.evMult ?? 1.0,
    dayMult:      pos.dayMult ?? 1.0,
    tradeNumber:  pos.tradeNumber,
    peakRRPos:    0,
    peakRRNeg:    0,
    slMilestones: {},
    rrMilestones: {},
    phantomSLHit: false,
    stopReason:   null,
    timeToSLMin:  null,
    closedAt:     null,
  };
}

function updateGhost(ghost, price) {
  price = parseFloat(price);
  const entry   = ghost.entry;
  const sl      = ghost.sl;
  const slRange = Math.abs(entry - sl);
  if (slRange <= 0) return;
  const isBuy = ghost.direction === "buy";
  if (isBuy ? price > ghost.maxPrice : price < ghost.maxPrice) ghost.maxPrice = price;
  const fav  = isBuy ? price - entry : entry - price;
  const rr   = parseFloat((fav / slRange).toFixed(4));
  if (rr > ghost.maxRR) ghost.maxRR = rr;
  if (rr > ghost.peakRRPos) ghost.peakRRPos = rr;
  const adv    = isBuy ? entry - price : price - entry;
  const slUsed = parseFloat(((adv / slRange) * 100).toFixed(2));
  if (slUsed > ghost.maxSlPctUsed) ghost.maxSlPctUsed = slUsed;
  if (slUsed > ghost.peakRRNeg)    ghost.peakRRNeg    = slUsed;
  for (const p of [25, 50, 75, 90, 100])
    if (slUsed >= p && !ghost.slMilestones[p]) ghost.slMilestones[p] = new Date().toISOString();
  for (const r of [1, 2, 3, 5, 10])
    if (rr >= r && !ghost.rrMilestones[r]) ghost.rrMilestones[r] = new Date().toISOString();
  const hitSL = isBuy ? price <= sl : price >= sl;
  if (hitSL && !ghost.phantomSLHit) {
    ghost.phantomSLHit = true;
    ghost.stopReason   = "phantom_sl";
    ghost.timeToSLMin  = Math.round((Date.now() - new Date(ghost.openedAt).getTime()) / 60000);
  }
  if (rr >= 15 && !ghost.stopReason) ghost.stopReason = "max_rr_15";
}

async function closePosition(positionId, reason = "manual", pnl = null) {
  const pos = openPositions.get(positionId);
  if (!pos) return;
  openPositions.delete(positionId);
  const ghost = pos.ghost;
  const now   = new Date().toISOString();
  let realPnl = pnl;

  // Fetch deals
  if (dbReady) {
    try {
      const deals = await fetchHistoryDeals(positionId);
      for (const d of deals) {
        await db.saveDeal({ positionId, dealId: d.id ?? d.dealId, symbol: d.symbol,
          type: d.type, profit: d.profit ?? 0, commission: d.commission ?? 0,
          swap: d.swap ?? 0, volume: d.volume, price: d.price, time: d.time });
      }
      realPnl = await db.fetchRealizedPnl(positionId) ?? pnl;
    } catch (e) { recordError(`closePos deals: ${e.message}`); }
  }

  if (ghost && dbReady) {
    ghost.closedAt   = now;
    ghost.stopReason = ghost.stopReason ?? reason;
    await db.saveGhostTrade({ ...ghost, maxRRBeforeSL: ghost.maxRR }).catch(e => recordError(e.message));
    db.computeAndSaveGhostComboAnalysis(ghost.optimizerKey).catch(() => {});
  }

  if (dbReady) {
    await db.saveTrade({
      positionId, symbol: pos.symbol, mt5Symbol: pos.mt5Symbol,
      direction: pos.direction, vwapPosition: pos.vwapPosition,
      entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: pos.lots,
      riskPct: pos.riskPct, riskEUR: pos.riskEUR,
      maxPrice: ghost?.maxPrice ?? pos.entry, maxRR: ghost?.maxRR ?? 0,
      trueMaxRR: ghost?.maxRR ?? 0, trueMaxPrice: ghost?.maxPrice ?? pos.entry,
      ghostStopReason: ghost?.stopReason, ghostFinalizedAt: now,
      session: pos.session, vwapAtEntry: pos.vwapAtEntry,
      openedAt: pos.openedAt, closedAt: now,
      slMultiplier: pos.slMultiplier ?? 1.0,
      realizedPnlEUR: realPnl, hitTP: reason === "tp", closeReason: reason,
      spreadAtEntry: pos.spreadAtEntry, vwapBandPct: pos.vwapBandPct,
      executionPrice: pos.executionPrice, tvEntry: pos.tvEntry, slippage: pos.slippage,
    }).catch(e => recordError(e.message));
    db.deleteGhostState(positionId).catch(() => {});
  }
  console.log(`[Pos] Closed ${positionId} ${pos.symbol} ${pos.direction} reason=${reason} pnl=${realPnl}`);
}

// ── Position sync (cron) ─────────────────────────────────────────
async function syncPositions() {
  if (!isMonitoringActive() || !dbReady) return;
  const live = await getPositions();
  const liveIds = new Set(live.map(p => String(p.id)));
  for (const [id] of openPositions) {
    if (!liveIds.has(id)) await closePosition(id, "manual", null);
  }
  for (const lp of live) {
    const pos = openPositions.get(String(lp.id));
    if (pos?.ghost && lp.currentPrice) {
      updateGhost(pos.ghost, lp.currentPrice);
      if (dbReady) db.saveGhostState(pos.ghost).catch(() => {});
    }
  }
}

// ── Shadow snapshots (cron) ───────────────────────────────────────
async function runShadowSnapshots() {
  if (!isShadowActive() || !dbReady || openPositions.size === 0) return;
  const live     = await getPositions();
  const priceMap = new Map(live.map(p => [String(p.id), p.currentPrice]));
  for (const [id, pos] of openPositions) {
    const price   = priceMap.get(id);
    if (!price) continue;
    const slDist  = Math.abs(pos.entry - pos.sl);
    if (slDist <= 0) continue;
    const adv     = pos.direction === "buy" ? pos.entry - price : price - pos.entry;
    const pctUsed = Math.max(0, parseFloat(((adv / slDist) * 100).toFixed(2)));
    db.saveShadowSnapshot({ positionId: id, optimizerKey: pos.optimizerKey,
      symbol: pos.symbol, session: pos.session, direction: pos.direction,
      vwapPosition: pos.vwapPosition, entry: pos.entry, sl: pos.sl,
      currentPrice: price, pctSlUsed: pctUsed }).catch(() => {});
  }
}

// ── TP Optimizer (cron) ───────────────────────────────────────────
async function runTPOptimizer() {
  if (!isMonitoringActive() || !dbReady) return;
  try {
    tpConfigs = await db.loadTPConfig();
    const grouped = await db.loadGhostGrouped();
    for (const g of grouped) {
      if ((g.n || 0) < 10) continue;
      const ev = await db.computeEVStats(g.optimizerKey).catch(() => null);
      if (!ev || ev.count < 10 || !ev.bestRR) continue;
      const km  = keyRiskMults[g.optimizerKey] ?? { streak: 0, evMult: 1.0, dayMult: 1.0 };
      const mul = ev.bestEV > 0 ? Math.min(1.5, 1 + ev.bestEV) : Math.max(0.5, 1 + ev.bestEV);
      keyRiskMults[g.optimizerKey] = { streak: km.streak, evMult: parseFloat(mul.toFixed(4)), dayMult: km.dayMult ?? 1.0 };
      db.saveKeyRiskMult(g.optimizerKey, keyRiskMults[g.optimizerKey]).catch(() => {});
      const existing = tpConfigs[g.optimizerKey];
      if (!existing || g.n >= (existing.lockedGhosts ?? 0) * 2) {
        await db.saveTPConfig(g.optimizerKey, g.symbol, g.session, g.direction,
          g.vwapPosition, ev.bestRR, g.n, ev.bestEV, existing?.lockedRR ?? null).catch(() => {});
        tpConfigs[g.optimizerKey] = { ...existing, lockedRR: ev.bestRR, lockedGhosts: g.n };
      }
    }
  } catch (e) { recordError(`TPOptimizer: ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

// ── Dashboard ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHTML());
});

// /dashboard → alias for root (fixes broken /dashboard link)
app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHTML());
});

// ── Health ────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, version: VERSION, dbReady, ts: new Date().toISOString() });
});

// ── Status (always fast) ──────────────────────────────────────────
app.get("/status", async (req, res) => {
  const base = {
    version:        VERSION,
    dbReady,
    openPositions:  openPositions.size,
    complianceDate: liveComplianceDate,
    errorCount:     getErrorCount(),
    ts:             new Date().toISOString(),
  };
  // Account info: try with 10 s timeout — never block
  const acct = await Promise.race([
    getAccountInfo(),
    new Promise(r => setTimeout(() => r(null), 10000)),
  ]);
  res.json({
    ...base,
    account: acct ? { balance: acct.balance, equity: acct.equity,
                      margin: acct.margin, currency: acct.currency } : null,
  });
});

// ── Compliance date ───────────────────────────────────────────────
app.get("/compliance-date", (req, res) => res.json({ complianceDate: liveComplianceDate }));

app.post("/compliance-date", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { date } = req.body ?? {};
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const iso = date.length === 10 ? `${date} 00:00:00` : date;
  liveComplianceDate = iso;
  db.setComplianceDateLive(iso);
  if (dbReady) await db.saveComplianceDate(iso).catch(() => {});
  res.json({ ok: true, complianceDate: iso });
});

// ── Webhook ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const t0 = Date.now();
  if (!checkSecret(req, res)) return;
  if (!dbReady) return res.status(503).json({ error: "DB not ready yet, retry in a moment" });

  const { symbol: rawSym, direction, sl_pct, vwap, vwap_upper, vwap_upper2,
          vwap_lower, vwap_lower2, close: tvClose } = req.body ?? {};

  const symbol = normalizeSymbol(rawSym);
  if (!symbol) return res.status(400).json({ error: `Unknown symbol: ${rawSym}` });

  const symInfo   = getSymbolInfo(symbol);
  const mt5Sym    = symInfo?.mt5 ?? symbol;
  const assetType = symInfo?.type ?? "forex";

  const { allowed, reason: mktReason } = canOpenNewTrade(symbol);
  if (!allowed) {
    db.logSignal({ symbol, direction, outcome: "REJECTED", rejectReason: mktReason,
      session: getSession(), latencyMs: Date.now() - t0 }).catch(() => {});
    return res.json({ ok: false, reason: mktReason });
  }

  const tvEntry  = tvClose ? parseFloat(tvClose) : null;
  const vwapMid  = vwap    ? parseFloat(vwap)    : null;
  const session  = getSession();
  const vwapPos  = getVwapPosition(tvEntry, vwapMid);
  const optKey   = buildOptimizerKey(symbol, session, direction, vwapPos);
  const slPct    = sl_pct ? parseFloat(sl_pct) : 0.003;

  let equity = 10000;
  const acct = await Promise.race([getAccountInfo(), new Promise(r => setTimeout(() => r(null), 8000))]);
  if (acct?.equity) equity = parseFloat(acct.equity);

  const baseRisk = symbolRiskMap[symbol] ?? DEFAULT_RISK_BY_TYPE[assetType] ?? DEFAULT_RISK_BY_TYPE.forex;
  const km       = keyRiskMults[optKey] ?? { evMult: 1.0, dayMult: 1.0 };
  const riskPct  = baseRisk * (km.evMult ?? 1) * (km.dayMult ?? 1);
  const riskEUR  = parseFloat((equity * riskPct).toFixed(2));

  // Live quote
  let execPrice = tvEntry, spreadAtEntry = null, bid = null, ask = null;
  try {
    const q = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/symbols/${mt5Sym}/current-price`);
    bid = q?.bid ? parseFloat(q.bid) : null;
    ask = q?.ask ? parseFloat(q.ask) : null;
    if (bid && ask) { spreadAtEntry = parseFloat((ask - bid).toFixed(6)); execPrice = direction === "buy" ? ask : bid; }
  } catch {}

  const slippage    = tvEntry && execPrice ? parseFloat(Math.abs(execPrice - tvEntry).toFixed(6)) : null;
  const slBuf       = assetType === "stock" ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
  const slDist      = (slPct * slBuf) * execPrice;
  const slPrice     = direction === "buy"
    ? parseFloat((execPrice - slDist).toFixed(6))
    : parseFloat((execPrice + slDist).toFixed(6));
  const tpRR        = tpConfigs[optKey]?.lockedRR ?? 2.0;
  const tpPrice     = direction === "buy"
    ? parseFloat((execPrice + slDist * tpRR).toFixed(6))
    : parseFloat((execPrice - slDist * tpRR).toFixed(6));

  let lots;
  const lotNom = slDist > 0 ? riskEUR / slDist : 0.01;
  if (assetType === "forex")     lots = Math.max(0.01, parseFloat((lotNom / 100000).toFixed(2)));
  else if (assetType === "index") lots = Math.max(0.01, parseFloat(lotNom.toFixed(2)));
  else if (assetType === "stock") lots = Math.max(0.01, parseFloat((lotNom / execPrice).toFixed(2)));
  else lots = Math.max(0.01, parseFloat((lotNom / 100).toFixed(2)));

  let tradeNumber = null;
  if (dbReady) tradeNumber = await db.getNextTradeNumber().catch(() => null);

  // Place order
  let positionId;
  try {
    const r  = await placeOrder({
      symbol: mt5Sym,
      actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume: lots, stopLoss: slPrice, takeProfit: tpPrice,
      comment: `PRONTO-AI #${tradeNumber ?? "?"}`,
    });
    positionId = r?.positionId ?? r?.orderId ?? String(Date.now());
  } catch (e) {
    recordError(`placeOrder: ${e.message}`);
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, outcome: "ERROR", rejectReason: e.message, latencyMs: Date.now() - t0 }).catch(() => {});
    return res.status(500).json({ error: e.message });
  }

  const pos = { positionId, symbol, mt5Symbol: mt5Sym, direction,
    vwapPosition: vwapPos, session, entry: execPrice, sl: slPrice, tp: tpPrice, lots,
    riskPct, riskEUR, openedAt: new Date().toISOString(), optimizerKey: optKey,
    tpRRUsed: tpRR, slMultiplier: slBuf, vwapAtEntry: vwapMid, tvEntry, executionPrice: execPrice,
    slippage, spreadAtEntry, vwapBandPct: null, tradeNumber, ghost: null };
  pos.ghost = initGhost({ ...pos, slPct, evMult: km.evMult, dayMult: km.dayMult });
  openPositions.set(positionId, pos);

  if (dbReady) {
    db.saveGhostState(pos.ghost).catch(() => {});
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, outcome: "PLACED", latencyMs: Date.now() - t0, positionId }).catch(() => {});
    db.logWebhook({ symbol, direction, session, vwapPos, action: "place", status: "OK",
      positionId, entry: execPrice, sl: slPrice, tp: tpPrice, lots, riskPct, optimizerKey: optKey,
      latencyMs: Date.now() - t0, tvEntry, executionPrice: execPrice, slippage }).catch(() => {});
    if (bid && ask) db.saveSpreadLog({ symbol, mt5Symbol: mt5Sym, session,
      hourBrussels: getBrusselsComponents().hour, minuteBrussels: getBrusselsComponents().minute,
      dayOfWeek: getBrusselsComponents().day,
      bid, ask, spreadAbs: spreadAtEntry,
      spreadPct: spreadAtEntry && execPrice > 0 ? parseFloat((spreadAtEntry / execPrice * 100).toFixed(4)) : null,
      assetType, positionId }).catch(() => {});
  }

  res.json({ ok: true, positionId, symbol, direction, lots,
    entry: execPrice, sl: slPrice, tp: tpPrice, riskEUR, tpRR, tradeNumber,
    latencyMs: Date.now() - t0 });
});

// ── Manual close ──────────────────────────────────────────────────
app.post("/close/:id", async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    await closePositionMeta(req.params.id);
    await closePosition(req.params.id, "manual", null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── History deals ─────────────────────────────────────────────────
app.post("/history-deals", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { positionId } = req.body ?? {};
  if (!positionId) return res.status(400).json({ error: "positionId required" });
  try {
    const deals = await fetchHistoryDeals(positionId);
    for (const d of deals)
      await db.saveDeal({ positionId, dealId: d.id ?? d.dealId, symbol: d.symbol,
        type: d.type, profit: d.profit ?? 0, commission: d.commission ?? 0,
        swap: d.swap ?? 0, volume: d.volume, price: d.price, time: d.time });
    const pnl = await db.fetchRealizedPnl(positionId);
    res.json({ ok: true, deals: deals.length, realizedPnl: pnl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API endpoints (all safe — return empty on error/not ready) ───

function apiGet(path, fn, empty = []) {
  app.get(path, async (req, res) => {
    if (!dbReady) return res.json(empty);
    try { res.json(await dbCall(fn(req), empty)); }
    catch (e) { recordError(`${path}: ${e.message}`); res.json(empty); }
  });
}

apiGet("/api/trades",              () => db.loadAllTrades(),                   []);
apiGet("/api/ghost-trades",        r  => db.loadGhostTrades(r.query.key??null, parseInt(r.query.limit)||200), []);
apiGet("/api/ghost-grouped",       () => db.loadGhostGrouped(),                []);
apiGet("/api/ghost-history-by-pair",() => db.loadGhostHistoryByPair(),         []);
apiGet("/api/ghost-combo-analysis",r  => db.loadGhostComboAnalysis(r.query.key??null), []);
apiGet("/api/shadow-analysis",     () => db.loadAllShadowAnalysis(),           []);
apiGet("/api/shadow-winners",      () => db.loadShadowWinners(),               {});
apiGet("/api/mae-stats",           r  => db.loadMAEStats(r.query.since??null), []);
apiGet("/api/signal-stats",        () => db.loadSignalStats(),                 { total:0, placed:0, conversionPct:0 });
apiGet("/api/signal-rejects",      r  => db.loadSignalRejects({ since: r.query.since }), []);
apiGet("/api/blocked-raw",         r  => db.loadBlockedRaw(r.query.since??null), []);
apiGet("/api/webhook-history",     r  => db.loadWebhookHistory(parseInt(r.query.limit)||100), []);
apiGet("/api/spread-stats",        r  => db.loadSpreadStats(r.query),          []);
apiGet("/api/spread-log",          r  => db.loadSpreadLog({ symbol: r.query.symbol, session: r.query.session, limit: parseInt(r.query.limit)||500 }), []);
apiGet("/api/band-ghosts",         r  => db.loadBandGhosts(r.query),           []);
apiGet("/api/symbol-risk",         () => db.loadSymbolRiskConfig(),            {});

app.get("/api/open-positions", (req, res) => {
  const out = [];
  for (const [id, pos] of openPositions) {
    out.push({
      positionId: id, symbol: pos.symbol, direction: pos.direction,
      session: pos.session, vwapPosition: pos.vwapPosition, optimizerKey: pos.optimizerKey,
      entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: pos.lots,
      riskPct: pos.riskPct, riskEUR: pos.riskEUR, openedAt: pos.openedAt,
      tradeNumber: pos.tradeNumber,
      // currentPrice not available server-side without live fetch — omit
      ghost: pos.ghost ? {
        maxRR:        pos.ghost.maxRR,
        maxSlPctUsed: pos.ghost.maxSlPctUsed,
        peakRRPos:    pos.ghost.peakRRPos,
        peakRRNeg:    pos.ghost.peakRRNeg,
        slMilestones: pos.ghost.slMilestones,   // {25: iso, 50: iso, 75: iso, 90: iso, 100: iso}
        rrMilestones: pos.ghost.rrMilestones,   // {1: iso, 2: iso, 3: iso, 5: iso, 10: iso}
        phantomSLHit: pos.ghost.phantomSLHit,
        stopReason:   pos.ghost.stopReason,
        openedAt:     pos.ghost.openedAt,
        entry:        pos.ghost.entry,
        sl:           pos.ghost.sl,
      } : null,
    });
  }
  res.json(out);
});


app.get("/api/tp-config", (req, res) => res.json(tpConfigs));

app.get("/api/performance", async (req, res) => {
  const empty = { total: 0, tpCount: 0, slCount: 0, winRate: 0, avgWinner: 0,
    avgLoser: 0, grossWins: 0, grossLosses: 0, profitFactor: null,
    totalPnl: 0, avgPnlPerTrade: 0, maxDrawdown: 0, pnlCurve: [] };
  if (!dbReady) return res.json(empty);
  res.json(await dbCall(db.loadPerformanceSummary(), empty));
});

app.get("/api/daily-breakdown", async (req, res) => {
  const empty = { days: [], maxWinStreak: 0, maxLossStreak: 0, maxDrawdownDay: 0 };
  if (!dbReady) return res.json(empty);
  res.json(await dbCall(db.loadDailyBreakdown(), empty));
});

app.get("/api/ev-stats", async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "key required" });
  if (!dbReady) return res.json({ count: 0, rrLevels: [] });
  res.json(await dbCall(db.computeEVStats(key), { count: 0, rrLevels: [] }));
});

app.get("/api/band-ghost-stats", async (req, res) => {
  const { bandTier } = req.query;
  if (!bandTier) return res.status(400).json({ error: "bandTier required" });
  if (!dbReady) return res.json([]);
  res.json(await dbCall(db.loadBandGhostStats(bandTier), []));
});

app.post("/api/symbol-risk", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { symbol, riskPct } = req.body ?? {};
  if (!symbol || riskPct == null) return res.status(400).json({ error: "symbol + riskPct required" });
  if (dbReady) await db.upsertSymbolRisk(symbol, riskPct).catch(e => recordError(e.message));
  symbolRiskMap[symbol] = parseFloat(riskPct);
  res.json({ ok: true, symbol, riskPct });
});

// ══════════════════════════════════════════════════════════════════
//  /api/snapshot  — full system state in one call (for Claude / monitoring)
//  Secret required. Returns everything needed to diagnose any issue.
// ══════════════════════════════════════════════════════════════════
app.get("/api/snapshot", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

  const [acct, positions, trades, ghostGrouped, daily, performance,
         signalStats, tpConfig, symbolRisk, shadowAnalysis, webhookHistory,
         signalRejects, blockedRaw, spreadStats, evKeys] = await Promise.all([
    safe(getAccountInfo,                        null),
    safe(getPositions,                          []),
    safe(() => dbReady ? db.loadAllTrades()                          : [], []),
    safe(() => dbReady ? db.loadGhostGrouped()                       : [], []),
    safe(() => dbReady ? db.loadDailyBreakdown()                     : {}  , {}),
    safe(() => dbReady ? db.loadPerformanceSummary()                 : {}  , {}),
    safe(() => dbReady ? db.loadSignalStats()                        : {}  , {}),
    safe(() => Promise.resolve(tpConfigs),                           {}),
    safe(() => Promise.resolve(symbolRiskMap),                       {}),
    safe(() => dbReady ? db.loadAllShadowAnalysis()                  : [], []),
    safe(() => dbReady ? db.loadWebhookHistory(50)                   : [], []),
    safe(() => dbReady ? db.loadSignalRejects({})                    : [], []),
    safe(() => dbReady ? db.loadBlockedRaw()                         : [], []),
    safe(() => dbReady ? db.loadSpreadStats({})                      : [], []),
    safe(() => Promise.resolve(Object.keys(keyRiskMults)),           []),
  ]);

  res.json({
    meta: {
      version: VERSION,
      ts: new Date().toISOString(),
      dbReady,
      errorCount: getErrorCount(),
      recentErrors: errorLog.slice(-20),
      complianceDate: liveComplianceDate,
      openPositionCount: openPositions.size,
    },
    account: acct ? {
      balance: acct.balance, equity: acct.equity,
      margin: acct.margin, freeMargin: acct.freeMargin,
      marginLevel: acct.marginLevel, currency: acct.currency,
    } : null,
    livePositions: positions.map(p => ({
      id: p.id, symbol: p.symbol, type: p.type,
      volume: p.volume, openPrice: p.openPrice,
      currentPrice: p.currentPrice, profit: p.profit,
      swap: p.swap, openTime: p.openTime,
    })),
    openPositions: (() => {
      const out = [];
      for (const [id, pos] of openPositions)
        out.push({ positionId: id, symbol: pos.symbol, direction: pos.direction,
          session: pos.session, entry: pos.entry, sl: pos.sl, tp: pos.tp,
          riskPct: pos.riskPct, riskEUR: pos.riskEUR, openedAt: pos.openedAt,
          ghost: pos.ghost ? { maxRR: pos.ghost.maxRR, maxSlPctUsed: pos.ghost.maxSlPctUsed,
            phantomSLHit: pos.ghost.phantomSLHit, stopReason: pos.ghost.stopReason } : null });
      return out;
    })(),
    performance,
    daily,
    signalStats,
    tpConfig,
    symbolRisk,
    keyRiskMults,
    evKeys,
    recentTrades:  (trades  || []).slice(-30),
    ghostGrouped:  (ghostGrouped || []).slice(0, 50),
    shadowAnalysis:(shadowAnalysis || []).slice(0, 30),
    webhookHistory:(webhookHistory || []).slice(0, 50),
    signalRejects: (signalRejects || []).slice(0, 30),
    blockedRaw:    (blockedRaw || []).slice(0, 50),
    spreadStats:   (spreadStats || []).slice(0, 30),
    endpoints: [
      "GET  /",
      "GET  /dashboard",
      "GET  /health",
      "GET  /status",
      "GET  /compliance-date",
      "POST /compliance-date          [secret]",
      "POST /webhook                  [secret]",
      "POST /close/:id                [secret]",
      "POST /history-deals            [secret]",
      "GET  /api/snapshot             [secret]",
      "GET  /api/open-positions",
      "GET  /api/trades",
      "GET  /api/daily-breakdown",
      "GET  /api/performance",
      "GET  /api/tp-config",
      "GET  /api/ev-stats?key=",
      "GET  /api/ghost-trades",
      "GET  /api/ghost-grouped",
      "GET  /api/ghost-history-by-pair",
      "GET  /api/ghost-combo-analysis",
      "GET  /api/shadow-analysis",
      "GET  /api/shadow-winners",
      "GET  /api/mae-stats",
      "GET  /api/signal-stats",
      "GET  /api/signal-rejects",
      "GET  /api/blocked-raw",
      "GET  /api/webhook-history",
      "GET  /api/spread-stats",
      "GET  /api/spread-log",
      "GET  /api/band-ghosts",
      "GET  /api/band-ghost-stats?bandTier=",
      "GET  /api/symbol-risk",
      "POST /api/symbol-risk          [secret]",
    ],
  });
});

// ══════════════════════════════════════════════════════════════════
//  DASHBOARD HTML  (self-contained — all JS inline)
// ══════════════════════════════════════════════════════════════════
function dashboardHTML() {
// Symbol type maps (mirrored from session.js for client-side use)
const FOREX_SYMS     = ['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
const INDEX_SYMS     = ['DE30EUR','NAS100USD','UK100GBP','US30USD'];
const COMM_SYMS      = ['XAUUSD'];
const FIXED_RISK_PCT = 0.000375;
const COMPLIANCE_MS  = new Date('2026-05-03T00:00:00.000Z').getTime();

// Build milestone arrays: -1.0 → -0.1 then +0.1 → +15.0 in 0.1 steps
const ADV_STEPS = [];
for (let v = 1.0; v >= 0.1 - 1e-9; v = Math.round((v - 0.1) * 10) / 10) ADV_STEPS.push(v);
// ADV_STEPS = [1.0, 0.9, ..., 0.1]
const FAV_STEPS = [];
for (let v = 0.1; v <= 15.0 + 1e-9; v = Math.round((v + 0.1) * 10) / 10) FAV_STEPS.push(v);

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO·AI v13.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080c12;--bg2:#0d1117;--bg3:#161b22;--bg4:#1c2128;
  --bdr:#21262d;--bdr2:#30363d;
  --ink:#e6edf3;--ink2:#c9d1d9;--ink3:#8b949e;
  --b:#58a6ff;--g:#3fb950;--r:#f85149;--y:#d29922;--p:#bc8cff;--c:#39d0d8;--o:#f0883e;
  --b2:rgba(88,166,255,.12);--g2:rgba(63,185,80,.12);--r2:rgba(248,81,73,.12);
  --y2:rgba(210,153,34,.12);--p2:rgba(188,140,255,.12);
}
body{background:var(--bg);color:var(--ink2);font:12px/1.5 'SF Mono',Consolas,monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
/* header */
header{background:var(--bg2);border-bottom:1px solid var(--bdr2);padding:0 14px;display:flex;align-items:center;height:44px;gap:0;flex-shrink:0}
.hbrand{font-size:14px;font-weight:700;color:var(--b);letter-spacing:-.3px;margin-right:14px;white-space:nowrap}
.hkpis{display:flex;align-items:stretch;gap:0;flex:1;overflow:hidden;height:100%}
.hkpi{display:flex;flex-direction:column;justify-content:center;padding:0 12px;border-right:1px solid var(--bdr);min-width:0;flex-shrink:0}
.hkl{font-size:8px;font-weight:500;letter-spacing:.8px;text-transform:uppercase;color:var(--ink3);margin-bottom:1px}
.hkv{font-size:16px;font-weight:700;white-space:nowrap}
.hright{display:flex;align-items:center;gap:8px;margin-left:auto;padding-left:12px;flex-shrink:0}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--g);box-shadow:0 0 6px var(--g);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.sess-badge{padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;background:var(--b2);color:var(--b);border:1px solid rgba(88,166,255,.25)}
#hclock{font-size:11px;color:var(--ink3)}
.hbtn{padding:3px 10px;border-radius:4px;border:1px solid var(--bdr2);background:var(--bg3);color:var(--ink2);font:11px/1.4 'SF Mono',monospace;cursor:pointer}
.hbtn:hover{border-color:var(--b);color:var(--b)}
/* compliance bar */
#cbar{background:#0a1628;border-bottom:1px solid rgba(88,166,255,.15);padding:3px 14px;font-size:10px;color:var(--ink3);flex-shrink:0;display:flex;align-items:center;gap:6px}
#cbar strong{color:var(--c)}
/* nav */
nav{display:flex;border-bottom:1px solid var(--bdr2);background:var(--bg2);flex-shrink:0;overflow-x:auto}
.ntab{padding:8px 14px;cursor:pointer;color:var(--ink3);white-space:nowrap;border-bottom:2px solid transparent;font-size:12px;transition:color .15s}
.ntab:hover{color:var(--ink)}
.ntab.on{color:var(--b);border-bottom-color:var(--b)}
.nbadge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;border-radius:8px;font-size:9px;font-weight:700;padding:0 4px;margin-left:4px;background:var(--r2);color:var(--r)}
/* pages */
.npage{display:none;flex:1;overflow-y:auto}
.npage.on{display:block}
.pg{padding:14px;display:flex;flex-direction:column;gap:12px}
/* card */
.card{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;overflow:hidden}
.card-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--bdr);background:var(--bg3)}
.card-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--g)}
.dot.r{background:var(--r)}.dot.y{background:var(--y)}
.cmeta{font-size:10px;color:var(--ink3)}
/* kpi strip */
.kstrip{display:flex;border-bottom:1px solid var(--bdr)}
.ks{flex:1;padding:10px 12px;border-right:1px solid var(--bdr);min-width:0}
.ks:last-child{border-right:none}
.ksl{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.ksv{font-size:18px;font-weight:700;white-space:nowrap}
.kss{font-size:9px;color:var(--ink3);margin-top:1px}
/* section label */
.slabel{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;padding:7px 14px 4px;font-weight:600;border-bottom:1px solid var(--bdr)}
/* table */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:11px}
th{color:var(--ink3);font-weight:400;font-size:9px;text-transform:uppercase;letter-spacing:.4px;padding:5px 8px;border-bottom:1px solid var(--bdr);text-align:left;white-space:nowrap;position:sticky;top:0;background:var(--bg3);z-index:1}
td{padding:4px 8px;border-bottom:1px solid var(--bdr);white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg4)}
.nd{text-align:center;color:var(--ink3);padding:20px!important}
/* color helpers */
.cb{color:var(--b)}.cg{color:var(--g)}.cr{color:var(--r)}.cy{color:var(--y)}
.cp{color:var(--p)}.cc{color:var(--c)}.co{color:var(--o)}.cd{color:var(--ink3)}
.fw{font-weight:700}
/* badges */
.bd{display:inline-flex;align-items:center;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;line-height:1.4}
.bd-buy{background:var(--g2);color:var(--g);border:1px solid rgba(63,185,80,.25)}
.bd-sell{background:var(--r2);color:var(--r);border:1px solid rgba(248,81,73,.25)}
.bd-ab{background:var(--b2);color:var(--b);border:1px solid rgba(88,166,255,.2)}
.bd-bw{background:var(--p2);color:var(--p);border:1px solid rgba(188,140,255,.2)}
.bd-asia{background:rgba(57,208,216,.1);color:var(--c);border:1px solid rgba(57,208,216,.2)}
.bd-lon{background:rgba(63,185,80,.1);color:var(--g);border:1px solid rgba(63,185,80,.2)}
.bd-ny{background:rgba(240,136,62,.1);color:var(--o);border:1px solid rgba(240,136,62,.2)}
.bd-fx{background:rgba(88,166,255,.1);color:var(--b);border:1px solid rgba(88,166,255,.2)}
.bd-sk{background:rgba(188,140,255,.1);color:var(--p);border:1px solid rgba(188,140,255,.2)}
.bd-ix{background:rgba(57,208,216,.1);color:var(--c);border:1px solid rgba(57,208,216,.2)}
.bd-cm{background:rgba(210,153,34,.1);color:var(--y);border:1px solid rgba(210,153,34,.2)}
/* filter bar */
.fbar{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--bdr);flex-wrap:wrap}
.fl{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.4px;margin-right:2px}
.fb{padding:2px 8px;border-radius:3px;border:1px solid var(--bdr2);background:transparent;color:var(--ink3);font:10px 'SF Mono',monospace;cursor:pointer}
.fb:hover{color:var(--ink);border-color:var(--bdr2)}
.fb.on{background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)}
/* milestone header colors */
.adv-th{background:rgba(248,81,73,.06)!important;color:var(--r)!important}
.fav-th{background:rgba(63,185,80,.06)!important;color:var(--g)!important}
/* best/worst toggle */
.bw-section{border-top:1px solid var(--bdr);padding:10px 14px}
.bw-hdr{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
/* 2-col layout */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--bdr)}
.col-pane{background:var(--bg2)}
.col-hdr{padding:7px 12px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;gap:6px}
.col-hdr-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
/* 3-col explain */
.explain-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.explain-cell{background:var(--bg2);padding:12px 14px}
.explain-step{font-size:8px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;font-weight:600}
.explain-body{font-size:10px;color:var(--ink2);line-height:1.6}
/* signal stat grid */
.sig-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.sig-cell{background:var(--bg2);padding:10px 12px}
.sig-lbl{font-size:8px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.sig-val{font-size:20px;font-weight:700}
/* overview ov-grid */
.ov-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--bdr);margin:0}
.ov-card{background:var(--bg2);padding:14px 14px 12px;border-bottom:1px solid var(--bdr)}
.ov-lbl{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.ov-val{font-size:28px;font-weight:700;line-height:1;margin-bottom:3px}
.ov-sub{font-size:9px;color:var(--ink3)}
/* spinner */
.spin{display:inline-block;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<!-- ═══════════════════════ HEADER ═════════════════════════════ -->
<header>
  <div class="hbrand">PRONTO·AI</div>
  <div class="hkpis">
    <div class="hkpi"><div class="hkl">Balance MT5</div><div class="hkv cb" id="h-bal">—</div></div>
    <div class="hkpi"><div class="hkl">Live P&amp;L</div><div class="hkv" id="h-pnl">—</div></div>
    <div class="hkpi"><div class="hkl">% Gain</div><div class="hkv cy" id="h-gain">—</div></div>
    <div class="hkpi"><div class="hkl">Open Trades</div><div class="hkv cg" id="h-pos">—</div></div>
    <div class="hkpi"><div class="hkl">Ghost Trackers</div><div class="hkv cp" id="h-gh">—</div></div>
    <div class="hkpi"><div class="hkl">Closed Ghosts</div><div class="hkv cc" id="h-ghh">—</div></div>
    <div class="hkpi"><div class="hkl">Risk/Trade</div><div class="hkv cd">${(FIXED_RISK_PCT*100).toFixed(4)}%</div></div>
    <div class="hkpi"><div class="hkl">TP Locked</div><div class="hkv cy" id="h-tp">—</div></div>
  </div>
  <div class="hright">
    <div class="live-dot"></div>
    <div class="sess-badge" id="h-sess">—</div>
    <div id="hclock">—</div>
    <button class="hbtn" onclick="loadAll()">⟳ Refresh</button>
  </div>
</header>

<!-- ═══════════════════════ COMPLIANCE BAR ══════════════════════ -->
<div id="cbar">
  <strong id="cbar-date">Compliance</strong>
  <span>—</span>
  <span id="cbar-desc">all EV, statistics &amp; P&amp;L calculated only on trades after this date</span>
</div>

<!-- ═══════════════════════ NAV ════════════════════════════════ -->
<nav id="main-nav">
  <div class="ntab on"  data-page="overview">Overview</div>
  <div class="ntab"     data-page="positions">Open Positions<span class="nbadge" id="nb-pos" style="pointer-events:none">—</span></div>
  <div class="ntab"     data-page="ghosts">Ghost Tracker<span class="nbadge" id="nb-gh" style="pointer-events:none">—</span></div>
  <div class="ntab"     data-page="history">Ghost History</div>
  <div class="ntab"     data-page="ev">EV TP Optimizer</div>
  <div class="ntab"     data-page="evsl">EV SL Optimizer</div>
  <div class="ntab"     data-page="signals">Signals &amp; Blocked<span class="nbadge" id="nb-sig" style="pointer-events:none;display:none"></span></div>
</nav>

<!-- ══════════════ PAGE: OVERVIEW ══════════════════════════════ -->
<div class="npage on" id="page-overview">
  <div class="pg">

    <!-- KPI Row -->
    <div class="card" style="overflow:hidden">
      <div class="ov-grid">
        <div class="ov-card"><div class="ov-lbl">Balance MT5</div><div class="ov-val cb" id="ov-bal">—</div><div class="ov-sub">Live account equity</div></div>
        <div class="ov-card"><div class="ov-lbl">Live P&amp;L</div><div class="ov-val" id="ov-pnl">—</div><div class="ov-sub" id="ov-pnl-sub">open positions</div></div>
        <div class="ov-card"><div class="ov-lbl">% Gain (compliance+)</div><div class="ov-val cy" id="ov-gain">—</div><div class="ov-sub" id="ov-gain-sub">realized P&amp;L / balance</div></div>
        <div class="ov-card"><div class="ov-lbl">Open Trades</div><div class="ov-val cg" id="ov-open">—</div><div class="ov-sub" id="ov-open-sub">live positions</div></div>
        <div class="ov-card"><div class="ov-lbl">Compliance Trades</div><div class="ov-val" id="ov-comp">—</div><div class="ov-sub">closed after compliance date</div></div>
      </div>
    </div>

    <!-- Trade Activity by Session/VWAP/Direction + asset split -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="wr-dot"></div>Trade Activity — Session / VWAP / Direction</div>
        <div class="cmeta" id="wr-meta">loading…</div>
      </div>
      <!-- Summary strip -->
      <div class="kstrip">
        <div class="ks"><div class="ksl">Total</div><div class="ksv cb" id="wr-tot">—</div><div class="kss" id="wr-tot-n"></div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="wr-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="wr-sell">—</div></div>
        <div class="ks"><div class="ksl">Above VWAP</div><div class="ksv cb" id="wr-ab">—</div></div>
        <div class="ks"><div class="ksl">Below VWAP</div><div class="ksv cp" id="wr-bw">—</div></div>
        <div class="ks"><div class="ksl">Asia</div><div class="ksv cc" id="wr-asia">—</div></div>
        <div class="ks"><div class="ksl">London</div><div class="ksv cg" id="wr-lon">—</div></div>
        <div class="ks"><div class="ksl">New York</div><div class="ksv co" id="wr-ny">—</div></div>
      </div>
      <!-- Table per combo per asset type -->
      <div id="wr-type-tabs" style="display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--bdr)">
        <span class="fl">Asset:</span>
        <button class="fb on" onclick="setWRType('all',this)">All</button>
        <button class="fb" onclick="setWRType('forex',this)">Forex</button>
        <button class="fb" onclick="setWRType('stock',this)">Stock</button>
        <button class="fb" onclick="setWRType('index',this)">Index</button>
        <button class="fb" onclick="setWRType('commodity',this)">Commodity</button>
      </div>
      <div class="tw">
        <table><thead><tr>
          <th>Session</th><th>Direction</th><th>VWAP</th><th>Asset Type</th><th>Trades</th>
        </tr></thead><tbody id="wr-body"><tr><td colspan="5" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>
    </div>

    <!-- Trade Distribution by asset type -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="dist-dot"></div>Trade Distribution — by Asset Type</div>
        <div class="cmeta" id="dist-meta">loading…</div>
      </div>
      <div class="kstrip">
        <div class="ks"><div class="ksl">Total Closed</div><div class="ksv cb" id="d-tot">—</div></div>
        <div class="ks"><div class="ksl">Forex</div><div class="ksv" style="color:var(--b)" id="d-fx">—</div></div>
        <div class="ks"><div class="ksl">Stock</div><div class="ksv cp" id="d-sk">—</div></div>
        <div class="ks"><div class="ksl">Index</div><div class="ksv cc" id="d-ix">—</div></div>
        <div class="ks"><div class="ksl">Commodity</div><div class="ksv cy" id="d-cm">—</div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="d-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="d-sell">—</div></div>
      </div>
      <div class="tw">
        <table><thead><tr>
          <th>Asset Type</th><th>Session</th>
          <th class="cg">Buy / Above</th><th class="cg">Buy / Below</th>
          <th class="cr">Sell / Above</th><th class="cr">Sell / Below</th>
          <th>Total</th>
        </tr></thead>
        <tbody id="dist-body"><tr><td colspan="7" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        <tfoot><tr style="background:var(--bg3);font-weight:700">
          <td class="cy" colspan="2">TOTAL</td>
          <td id="ft-ba" class="cg">—</td><td id="ft-bb" class="cg">—</td>
          <td id="ft-sa" class="cr">—</td><td id="ft-sb" class="cr">—</td>
          <td id="ft-t" class="cb">—</td>
        </tr></tfoot>
        </table>
      </div>
    </div>

    <!-- Daily Breakdown -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="daily-dot"></div>Daily Breakdown — Performance (compliance+)</div>
        <div class="cmeta" id="daily-meta">loading…</div>
      </div>
      <div class="kstrip">
        <div class="ks"><div class="ksl">Max Win Streak</div><div class="ksv cg" id="d-wstrk">—</div></div>
        <div class="ks"><div class="ksl">Max Loss Streak</div><div class="ksv cr" id="d-lstrk">—</div></div>
        <div class="ks"><div class="ksl">Max Drawdown</div><div class="ksv cy" id="d-dd">—</div></div>
      </div>
      <div class="tw">
        <table><thead><tr>
          <th>Date</th><th># Trades</th><th>Wins</th><th>Losses</th><th>Win%</th>
          <th>Day P&amp;L</th><th>Cum P&amp;L</th><th>Avg Lots</th><th>Best RR</th><th>Avg RR</th>
        </tr></thead><tbody id="daily-body"><tr><td colspan="10" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>

      <!-- Best / Worst Setups -->
      <div class="bw-section">
        <div class="bw-hdr">
          <span class="fl">Period:</span>
          <button class="fb on" onclick="setBWP('all',this)">All Time</button>
          <button class="fb" onclick="setBWP('week',this)">This Week</button>
          <button class="fb" onclick="setBWP('day',this)">Today</button>
          <span id="bw-period-lbl" style="font-size:9px;color:var(--ink3);margin-left:4px">all time</span>
        </div>
        <div class="bw-grid">
          <div>
            <div style="font-size:9px;color:var(--g);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700">🏆 Best 5 Setups</div>
            <table style="font-size:10px"><thead><tr>
              <th>Symbol</th><th>Dir</th><th>Sess</th><th>VWAP</th><th>RR</th><th>P&amp;L</th><th>Date</th>
            </tr></thead><tbody id="best-body"></tbody></table>
          </div>
          <div>
            <div style="font-size:9px;color:var(--r);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700">💀 Worst 5 Setups</div>
            <table style="font-size:10px"><thead><tr>
              <th>Symbol</th><th>Dir</th><th>Sess</th><th>VWAP</th><th>RR</th><th>P&amp;L</th><th>Date</th>
            </tr></thead><tbody id="worst-body"></tbody></table>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: OPEN POSITIONS ════════════════════════ -->
<div class="npage" id="page-positions">
  <div class="pg">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="pos-dot"></div>Open Positions — Live</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="fb" onclick="toggleMsCols()" id="ms-btn">± Milestones</button>
          <div class="cmeta" id="pos-meta">loading…</div>
        </div>
      </div>
      <div class="kstrip" id="pos-strip" style="display:none">
        <div class="ks"><div class="ksl">Open</div><div class="ksv cg" id="pos-cnt">—</div></div>
        <div class="ks"><div class="ksl">P&amp;L</div><div class="ksv" id="pos-pnl">—</div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="pos-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="pos-sell">—</div></div>
        <div class="ks"><div class="ksl">Stock</div><div class="ksv cp" id="pos-sk">—</div></div>
        <div class="ks"><div class="ksl">Index</div><div class="ksv cc" id="pos-ix">—</div></div>
        <div class="ks"><div class="ksl">Forex</div><div class="ksv cb" id="pos-fx">—</div></div>
        <div class="ks"><div class="ksl">Commodity</div><div class="ksv cy" id="pos-cm">—</div></div>
        <div class="ks"><div class="ksl">Ghosted</div><div class="ksv cp" id="pos-gh">—</div></div>
      </div>
      <div class="tw">
        <table id="pos-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Session</th>
            <th>Entry</th><th>SL</th><th>TP</th>
            <th>RR Now</th><th title="Best favorable RR">Peak+RR</th><th title="Worst adverse RR%">Peak−RR%</th>
            <th>→TP</th><th>P&amp;L€</th><th>Lots</th><th>Risk%</th>
            <th colspan="${ADV_STEPS.length}" class="adv-th" style="text-align:center">← Adverse (−1R to −0.1R)</th>
            <th colspan="${FAV_STEPS.length}" class="fav-th" style="text-align:center">Favorable (+0.1R to +15R) →</th>
            <th>Opened</th>
          </tr>
          <tr>
            <th colspan="15"></th>
            ${ADV_STEPS.map(v=>`<th class="adv-th">-${v.toFixed(1)}</th>`).join('')}
            ${FAV_STEPS.map(v=>`<th class="fav-th">+${v.toFixed(1)}</th>`).join('')}
            <th></th>
          </tr></thead>
          <tbody id="pos-body"><tr><td colspan="100" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: GHOST TRACKER ═════════════════════════ -->
<div class="npage" id="page-ghosts">
  <div class="pg">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="gh-dot"></div>Ghost Tracker — Active (until SL hit | 15R | timeout)</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="fb" onclick="toggleMsCols()">± Milestones</button>
          <div class="cmeta" id="gh-meta">Phantom SL = real SL at open · runs until closed</div>
        </div>
      </div>
      <div class="kstrip" id="gh-strip" style="display:none">
        <div class="ks"><div class="ksl">Active</div><div class="ksv cp" id="gh-cnt">—</div></div>
        <div class="ks"><div class="ksl">Peak+RR Best</div><div class="ksv cg" id="gh-best">—</div></div>
        <div class="ks"><div class="ksl">Peak−RR Worst</div><div class="ksv cr" id="gh-worst">—</div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="gh-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="gh-sell">—</div></div>
        <div class="ks"><div class="ksl">Stock</div><div class="ksv cp" id="gh-sk">—</div></div>
        <div class="ks"><div class="ksl">Index</div><div class="ksv cc" id="gh-ix">—</div></div>
        <div class="ks"><div class="ksl">Forex</div><div class="ksv cb" id="gh-fx">—</div></div>
        <div class="ks"><div class="ksl">Avg Elapsed</div><div class="ksv cd" id="gh-el">—</div></div>
      </div>
      <div class="tw">
        <table id="gh-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th title="Best favorable RR">Peak+RR</th><th title="Worst adverse RR%">Peak−RR%</th>
            <th colspan="${ADV_STEPS.length}" class="adv-th" style="text-align:center">← Adverse</th>
            <th colspan="${FAV_STEPS.length}" class="fav-th" style="text-align:center">Favorable →</th>
            <th>Elapsed</th><th>Opened</th>
          </tr>
          <tr>
            <th colspan="7"></th>
            ${ADV_STEPS.map(v=>`<th class="adv-th">-${v.toFixed(1)}</th>`).join('')}
            ${FAV_STEPS.map(v=>`<th class="fav-th">+${v.toFixed(1)}</th>`).join('')}
            <th colspan="2"></th>
          </tr></thead>
          <tbody id="gh-body"><tr><td colspan="100" class="nd">No active ghost trackers</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: GHOST HISTORY ═════════════════════════ -->
<div class="npage" id="page-history">
  <div class="pg">
    <!-- Grouped by pair - expandable -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="ghh-dot"></div>Ghost History — Grouped per Pair · Click row for detail</div>
        <div class="cmeta" id="ghh-meta">loading…</div>
      </div>
      <div class="fbar">
        <span class="fl">Session:</span>
        <button class="fb on" onclick="setGHF('sess','all',this)">All</button>
        <button class="fb" onclick="setGHF('sess','asia',this)">Asia</button>
        <button class="fb" onclick="setGHF('sess','london',this)">London</button>
        <button class="fb" onclick="setGHF('sess','ny',this)">NY</button>
        &nbsp;<span class="fl">Dir:</span>
        <button class="fb on" onclick="setGHF('dir','all',this)">All</button>
        <button class="fb" onclick="setGHF('dir','buy',this)">Buy</button>
        <button class="fb" onclick="setGHF('dir','sell',this)">Sell</button>
        &nbsp;<span class="fl">Type:</span>
        <button class="fb on" onclick="setGHF('type','all',this)">All</button>
        <button class="fb" onclick="setGHF('type','forex',this)">Forex</button>
        <button class="fb" onclick="setGHF('type','stock',this)">Stock</button>
        <button class="fb" onclick="setGHF('type','index',this)">Index</button>
        <button class="fb" onclick="setGHF('type','commodity',this)">Comm</button>
      </div>
      <div class="tw">
        <table id="ghh-tbl">
          <thead><tr>
            <th style="width:16px"></th>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th>SL Hits</th><th>15R Hits</th><th>Timeout</th>
            <th>Avg Peak+RR</th><th>Avg Peak−RR%</th><th>Max Peak+RR</th>
            <th>EV TP (last 5)</th><th>Close Reason</th>
          </tr></thead>
          <tbody id="ghh-body"><tr><td colspan="15" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Signal combo grouped — only completed ghosts -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="ghc-dot"></div>Ghost History — By Signal Combo · EV Data Source</div>
        <div class="cmeta" id="ghc-meta">Only finalized ghosts · used for EV optimizer</div>
      </div>
      <div style="padding:6px 14px;background:rgba(88,166,255,.04);border-bottom:1px solid rgba(88,166,255,.1);font-size:10px;color:var(--ink3)">
        ℹ Each row = one signal combo (Symbol + Session + Dir + VWAP). Milestone columns show avg time to reach each RR level. Min 5 ghosts for EV lock.
      </div>
      <div class="tw">
        <table id="ghc-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th># EV</th><th>Peak+RR</th><th>Avg RR</th>
            <th class="adv-th">T-¼R</th><th class="adv-th">T-½R</th>
            <th class="adv-th">T-¾R</th><th class="adv-th">T-1R</th>
            <th class="fav-th">T+½R</th><th class="fav-th">T+1R</th>
            <th class="fav-th">T+2R</th><th class="fav-th">T+3R</th>
            <th class="fav-th">T+5R</th><th class="fav-th">T+10R</th>
            <th class="fav-th">T+15R</th>
            <th>Stop Reason</th><th>MAE p50</th><th>MAE p75</th><th>MAE p90</th>
            <th>EV SL</th><th>EV TP</th>
          </tr></thead>
          <tbody id="ghc-body"><tr><td colspan="26" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: EV TP OPTIMIZER ═══════════════════════ -->
<div class="npage" id="page-ev">
  <div class="pg">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="ev-dot"></div>EV / TP Optimizer — All Signal Combos</div>
        <div class="cmeta" id="ev-meta">EV locked at ≥5 ghost trades</div>
      </div>
      <div class="fbar">
        <span class="fl">Type:</span>
        <button class="fb on" onclick="setEVF('type','all',this)">All</button>
        <button class="fb" onclick="setEVF('type','forex',this)">Forex</button>
        <button class="fb" onclick="setEVF('type','index',this)">Index</button>
        <button class="fb" onclick="setEVF('type','stock',this)">Stock</button>
        <button class="fb" onclick="setEVF('type','commodity',this)">Comm</button>
        &nbsp;<span class="fl">Session:</span>
        <button class="fb on" onclick="setEVF('sess','all',this)">All</button>
        <button class="fb" onclick="setEVF('sess','asia',this)">Asia</button>
        <button class="fb" onclick="setEVF('sess','london',this)">London</button>
        <button class="fb" onclick="setEVF('sess','ny',this)">New York</button>
        &nbsp;<span class="fl">Dir:</span>
        <button class="fb on" onclick="setEVF('dir','all',this)">All</button>
        <button class="fb" onclick="setEVF('dir','buy',this)">Buy</button>
        <button class="fb" onclick="setEVF('dir','sell',this)">Sell</button>
        &nbsp;<span class="fl">Min Ghosts:</span>
        <button class="fb on" onclick="setEVF('min','5',this)">≥5</button>
        <button class="fb" onclick="setEVF('min','10',this)">≥10</button>
        <button class="fb" onclick="setEVF('min','20',this)">≥20</button>
      </div>
      <div class="kstrip">
        <div class="ks"><div class="ksl">Combos Shown</div><div class="ksv cb" id="ev-cnt">0</div></div>
        <div class="ks"><div class="ksl">With Ghost Data</div><div class="ksv cc" id="ev-data">0</div></div>
        <div class="ks"><div class="ksl">EV+ Locked</div><div class="ksv cg" id="ev-lock">0</div></div>
        <div class="ks"><div class="ksl">Total P&amp;L (compliance+)</div><div class="ksv cy" id="ev-pnl">+€0.00</div></div>
      </div>
      <div class="tw">
        <table id="ev-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th># Trades</th><th>Best TP RR</th><th>Avg RR</th>
            <th>EV Score</th><th>Status</th><th>TP Lock</th>
            <th>Avg T→SL</th><th>Avg MAE%</th><th>P&amp;L€</th>
          </tr></thead>
          <tbody id="ev-body"><tr><td colspan="15" class="nd">No combos match current filters</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: EV SL OPTIMIZER ══════════════════════ -->
<div class="npage" id="page-evsl">
  <div class="pg">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="evsl-dot"></div>EV SL Optimizer — MAE-based SL Reduction · Read Only</div>
        <div class="cmeta">Never auto-applied · min 5 ghost trades required per combo</div>
      </div>
      <div class="explain-grid">
        <div class="explain-cell">
          <div class="explain-step">Step 1 — Ghost MAE data</div>
          <div class="explain-body">Every ghost trade records the <span class="cy fw">Max Adverse Excursion (MAE)</span> — how deep price went against the position before recovery or SL hit. Expressed as % of full SL distance (0–100%).</div>
        </div>
        <div class="explain-cell">
          <div class="explain-step">Step 2 — Percentile analysis</div>
          <div class="explain-body"><span class="cg fw">MAE p50</span> = median trade went no deeper than this. <span class="cy fw">MAE p90</span> = 90% of trades stayed within this level. Smaller p90 = more room to tighten the SL safely.</div>
        </div>
        <div class="explain-cell">
          <div class="explain-step">Step 3 — What to do</div>
          <div class="explain-body"><span class="cg fw">Green (p90 &lt;50%)</span>: strong tightening possible. <span class="cy fw">Yellow (50–75%)</span>: moderate. <span class="cr fw">Red (&gt;75%)</span>: keep SL as-is. Always verify with risk manager before applying.</div>
        </div>
      </div>
      <div class="tw">
        <table id="evsl-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th>MAE p50</th><th>MAE p75</th><th>MAE p90</th>
            <th>SL Advice</th><th>Best SL%</th><th>Potential Reduction</th>
            <th>Shadow p50</th><th>Shadow p90</th>
          </tr></thead>
          <tbody id="evsl-body"><tr><td colspan="14" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: SIGNALS & BLOCKED ═════════════════════ -->
<div class="npage" id="page-signals">
  <div class="pg">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="sig-dot"></div>Signal Intelligence — Placed, Blocked &amp; Errors</div>
        <div class="cmeta" id="sig-meta">loading…</div>
      </div>
      <!-- KPI grid -->
      <div class="sig-grid">
        <div class="sig-cell"><div class="sig-lbl">Total Signals</div><div class="sig-val cb" id="sig-tot">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Placed</div><div class="sig-val cg" id="sig-placed">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Conversion%</div><div class="sig-val cy" id="sig-conv">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Total Blocked</div><div class="sig-val cr" id="blk-tot">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Duplicate Open</div><div class="sig-val co" id="blk-dup">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">VWAP Exhausted</div><div class="sig-val cp" id="blk-vw">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Outside Window</div><div class="sig-val cd" id="blk-win">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Currency Budget</div><div class="sig-val cy" id="blk-cur">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">NY Dead Zone</div><div class="sig-val cr" id="blk-ny">—</div></div>
      </div>

      <!-- Placed + Blocked side by side -->
      <div class="two-col">
        <div class="col-pane">
          <div class="col-hdr">
            <div style="width:6px;height:6px;border-radius:50%;background:var(--g)"></div>
            <span class="col-hdr-title" style="color:var(--g)">Recent Placed Signals</span>
            <span class="cmeta" style="margin-left:auto">in-memory log</span>
          </div>
          <div class="tw" style="max-height:350px;overflow-y:auto">
            <table id="placed-tbl"><thead><tr>
              <th>Time</th><th>Symbol</th><th>Dir</th><th>Session</th><th>VWAP</th>
              <th>Entry</th><th>SL%</th><th>Latency</th>
            </tr></thead><tbody id="placed-body"><tr><td colspan="8" class="nd">—</td></tr></tbody></table>
          </div>
        </div>
        <div class="col-pane" style="border-left:1px solid var(--bdr)">
          <div class="col-hdr">
            <div style="width:6px;height:6px;border-radius:50%;background:var(--r)"></div>
            <span class="col-hdr-title" style="color:var(--r)">Blocked Signals</span>
            <span class="cmeta" style="margin-left:auto">grouped by reason</span>
          </div>
          <div class="tw" style="max-height:350px;overflow-y:auto">
            <table id="blk-tbl"><thead><tr>
              <th>Reason</th><th>Symbol</th><th>Dir</th><th>Session</th><th>VWAP</th><th>Count</th>
            </tr></thead><tbody id="blk-body"><tr><td colspan="6" class="nd">—</td></tr></tbody></table>
          </div>
        </div>
      </div>

      <!-- Webhook Errors full width -->
      <div class="col-hdr" style="border-top:1px solid var(--bdr)">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--o)"></div>
        <span class="col-hdr-title" style="color:var(--o)">Webhook Errors</span>
        <span class="cmeta" style="margin-left:auto">last 80 in memory</span>
      </div>
      <div class="tw">
        <table id="whe-tbl"><thead><tr>
          <th>Time</th><th>Symbol</th><th>Dir</th><th>Session</th><th>VWAP</th>
          <th>Entry</th><th>SL%</th><th>Band%</th><th>Reason</th>
        </tr></thead><tbody id="whe-body"><tr><td colspan="9" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>

      <!-- Blocked Raw all-time -->
      <div class="col-hdr" style="border-top:1px solid var(--bdr)">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--p)"></div>
        <span class="col-hdr-title" style="color:var(--p)">Blocked Raw — All Time (compliance+)</span>
        <div class="cmeta" id="blkraw-meta" style="margin-left:auto">grouped per symbol / dir / vwap / session / reason</div>
      </div>
      <div class="tw">
        <table id="blkraw-tbl"><thead><tr>
          <th>Symbol</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th>Outcome</th><th>Reject Reason</th><th># Blocked</th><th>Last Seen</th>
        </tr></thead><tbody id="blkraw-body"><tr><td colspan="8" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>

      <!-- Band analysis 2-col -->
      <div class="two-col" style="border-top:1px solid var(--bdr)">
        <div class="col-pane">
          <div class="col-hdr">
            <span class="col-hdr-title cy">Band 150–250%</span>
            <span class="cmeta" style="margin-left:auto">rejected — ghost potential shown</span>
          </div>
          <div class="tw"><table id="b150-tbl"><thead><tr>
            <th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th><th>n</th>
            <th>Avg RR</th><th>Max RR</th><th>Avg SL%</th>
          </tr></thead><tbody id="b150-body"><tr><td colspan="8" class="nd">—</td></tr></tbody></table></div>
        </div>
        <div class="col-pane" style="border-left:1px solid var(--bdr)">
          <div class="col-hdr">
            <span class="col-hdr-title cr">Band 250–350%</span>
            <span class="cmeta" style="margin-left:auto">extreme outliers · read only</span>
          </div>
          <div class="tw"><table id="b250-tbl"><thead><tr>
            <th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th><th>n</th>
            <th>Avg RR</th><th>Max RR</th><th>Avg SL%</th>
          </tr></thead><tbody id="b250-body"><tr><td colspan="8" class="nd">—</td></tr></tbody></table></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
'use strict';

// ── Symbol type lookup ────────────────────────────────────────────
const FOREX_S = new Set(['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF']);
const INDEX_S = new Set(['DE30EUR','NAS100USD','UK100GBP','US30USD']);
const COMM_S  = new Set(['XAUUSD']);
function symType(s){ if(FOREX_S.has(s)) return 'forex'; if(INDEX_S.has(s)) return 'index'; if(COMM_S.has(s)) return 'commodity'; return 'stock'; }

// ── Milestone steps: -1.0→-0.1 then +0.1→+15.0 ──────────────────
const ADV_STEPS=[],FAV_STEPS=[];
for(let v=1.0;v>=0.1-1e-9;v=Math.round((v-0.1)*10)/10) ADV_STEPS.push(+v.toFixed(1));
for(let v=0.1;v<=15.0+1e-9;v=Math.round((v+0.1)*10)/10) FAV_STEPS.push(+v.toFixed(1));

// ── Formatters ───────────────────────────────────────────────────
const f2  = v => v==null||isNaN(+v)?'—':(+v).toFixed(2);
const f1  = v => v==null||isNaN(+v)?'—':(+v).toFixed(1);
const f0  = v => v==null||isNaN(+v)?'—':(+v).toFixed(0);
const eu  = v => v==null?'—':((+v)>=0?'+':'')+'€'+(+v).toFixed(2);
const pct = v => v==null?'—':(+v).toFixed(1)+'%';
const pC  = v => (+v||0)>=0?'cg':'cr';
const dt  = s => { try{ return new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }catch{return s||'—';} };
const dtS = s => { try{ return new Date(s).toLocaleDateString('nl-BE'); }catch{return s||'—';} };
const msFmt = m => { if(!m&&m!==0) return '—'; m=Math.round(+m); const h=Math.floor(m/60),mn=m%60; return h>0?h+'h'+mn+'m':mn+'m'; };

// ── Badge helpers ─────────────────────────────────────────────────
const dBadge = d => d==='buy'?'<span class="bd bd-buy">BUY</span>':'<span class="bd bd-sell">SELL</span>';
const vBadge = v => v==='above'?'<span class="bd bd-ab">ABOVE</span>':'<span class="bd bd-bw">BELOW</span>';
const sBadge = s => ({asia:'<span class="bd bd-asia">ASIA</span>',london:'<span class="bd bd-lon">LON</span>',ny:'<span class="bd bd-ny">NY</span>'}[s])||'<span class="bd cd">'+s+'</span>';
const tBadge = t => ({forex:'<span class="bd bd-fx">FX</span>',stock:'<span class="bd bd-sk">STK</span>',index:'<span class="bd bd-ix">IDX</span>',commodity:'<span class="bd bd-cm">COM</span>'}[t])||'<span class="bd cd">'+t+'</span>';
const emptyRow = (cols,msg) => '<tr><td colspan="'+cols+'" class="nd">'+msg+'</td></tr>';

// ── API helper ───────────────────────────────────────────────────
async function api(url, ms=12000){
  const ctrl=new AbortController(), tid=setTimeout(()=>ctrl.abort(),ms);
  try{
    const r=await fetch(url,{signal:ctrl.signal});
    clearTimeout(tid);
    if(!r.ok) throw new Error(r.status);
    return await r.json();
  }catch(e){ clearTimeout(tid); console.warn('[API]',url,e.message||e); return null; }
}

// ── Clock ────────────────────────────────────────────────────────
function updateClock(){
  try{
    const now=new Date();
    const el=document.getElementById('hclock'); if(el) el.textContent=now.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour12:false});
    const bx=new Date(now.toLocaleString('en-US',{timeZone:'Europe/Brussels'}));
    const t=bx.getHours()*60+bx.getMinutes();
    const sess=t>=120&&t<480?'ASIA':t>=480&&t<930?'LONDON':t>=930&&t<1260?'NEW YORK':'CLOSED';
    const se=document.getElementById('h-sess'); if(se) se.textContent=sess;
  }catch{}
}
setInterval(updateClock,1000); updateClock();

// ── Page nav (event delegation) ──────────────────────────────────
const PAGES=['overview','positions','ghosts','history','ev','evsl','signals'];
const _loaded={};
function showPage(name){
  PAGES.forEach(p=>{ const pg=document.getElementById('page-'+p); if(pg) pg.classList.remove('on'); });
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));
  const pg=document.getElementById('page-'+name); if(pg) pg.classList.add('on');
  const tab=document.querySelector('.ntab[data-page="'+name+'"]'); if(tab) tab.classList.add('on');
  if(!_loaded[name]){
    _loaded[name]=true;
    if(name==='history') { loadGhostHistory(); loadGhostCombo(); }
    if(name==='evsl')    loadEVSL();
    if(name==='signals') { loadSignals(); loadBlockedRaw(); loadBand(); }
    if(name==='ev')      loadEV();
  }
}
document.addEventListener('click',e=>{
  const t=e.target.closest('.ntab[data-page]'); if(t) showPage(t.dataset.page);
});

// ── Milestone toggle ─────────────────────────────────────────────
let _msVisible=false;
function toggleMsCols(){
  _msVisible=!_msVisible;
  let s=document.getElementById('ms-style');
  if(!s){ s=document.createElement('style'); s.id='ms-style'; document.head.appendChild(s); }
  s.textContent=_msVisible?'':'.ms-adv,.ms-fav{display:none!important}';
  document.querySelectorAll('th.adv-th,th.fav-th').forEach(el=>el.style.display=_msVisible?'':'none');
  const btn=document.getElementById('ms-btn');
  if(btn) btn.textContent=_msVisible?'✕ Milestones':'± Milestones';
}

// ── pollStatus — fills header KPIs from /status ──────────────────
async function pollStatus(){
  const d=await api('/status',5000); if(!d) return;
  const bal=d.account?.balance, eq=d.account?.equity;
  if(bal!=null){
    setText('h-bal','€'+f0(bal));
    setText('ov-bal','€'+f0(bal));
  }
  if(bal!=null&&eq!=null){
    const live=eq-bal;
    setHtml('h-pnl','<span class="'+(live>=0?'cg':'cr')+'">'+(live>=0?'+':'')+'€'+live.toFixed(2)+'</span>');
    setText('ov-pnl',(live>=0?'+':'')+'€'+live.toFixed(2));
    setClass('ov-pnl','ov-val '+(live>=0?'cg':'cr'));
    setText('ov-pnl-sub',(live>=0?'+':'')+live.toFixed(2)+' on open trades');
  }
  if(d.openPositions!=null){ setText('h-pos',d.openPositions); setText('nb-pos',d.openPositions); }
  if(d.complianceDate){ setText('cbar-date','Compliance: '+d.complianceDate.slice(0,10)+' UTC'); }
}

// ── Helpers ───────────────────────────────────────────────────────
function setText(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }
function setHtml(id,v){ const el=document.getElementById(id); if(el) el.innerHTML=v; }
function setClass(id,v){ const el=document.getElementById(id); if(el) el.className=v; }

// ── loadPositions — uses /api/open-positions ─────────────────────
async function loadPositions(){
  const d=await api('/api/open-positions')||[];
  const cnt=d.length;
  setText('h-pos',cnt); setText('nb-pos',cnt||''); setText('ov-open',cnt);
  const posStrip=document.getElementById('pos-strip');
  if(!cnt){
    setHtml('pos-body',emptyRow(100,'No open positions'));
    if(posStrip) posStrip.style.display='none';
    setText('ov-open-sub','no live positions');
    return;
  }
  if(posStrip) posStrip.style.display='flex';
  const buys=d.filter(p=>p.direction==='buy').length;
  const ghd=d.filter(p=>p.ghost!=null).length;
  setText('pos-cnt',cnt);
  setText('pos-buy',buys); setText('pos-sell',cnt-buys);
  setText('pos-sk',d.filter(p=>symType(p.symbol)==='stock').length);
  setText('pos-ix',d.filter(p=>symType(p.symbol)==='index').length);
  setText('pos-fx',d.filter(p=>symType(p.symbol)==='forex').length);
  setText('pos-cm',d.filter(p=>symType(p.symbol)==='commodity').length);
  setText('pos-gh',ghd);
  setText('ov-open-sub',buys+' buy · '+(cnt-buys)+' sell');

  // Use live P&L from header (set by pollStatus)
  const livePnlTxt=document.getElementById('h-pnl')?.textContent||'—';
  setText('pos-pnl',livePnlTxt);

  const tbody=document.getElementById('pos-body');
  if(!tbody) return;
  tbody.innerHTML=d.map(p=>{
    const dec=(p.symbol||'').includes('JPY')?3:p.lots<0.5?5:4;
    const slDist=Math.abs((p.entry||0)-(p.sl||0));
    const peakPos=p.ghost?.peakRRPos??p.ghost?.maxRR??0;
    const peakNeg=p.ghost?.peakRRNeg??p.ghost?.maxSlPctUsed??0;
    const tpRR=slDist>0?Math.abs((p.tp||0)-(p.entry||0))/slDist:null;
    const rPct=p.riskPct?(p.riskPct*100).toFixed(3):null;
    // Milestone time helper
    const msT=(ms,opened,isFav)=>{
      const cls='td class="'+(isFav?'ms-fav cg':'ms-adv cr')+'" style="font-size:8px"';
      if(!ms||!opened) return '<'+cls+'>—</td>';
      const mins=Math.round((new Date(ms)-new Date(opened))/60000);
      return '<'+cls+'>'+msFmt(mins)+'</td>';
    };
    // slMilestones keys: {25,50,75,90,100} → map ADV step to nearest pct key
    const advMs=p.ghost?.slMilestones||{};
    const favMs=p.ghost?.rrMilestones||{};
    const advKeys=Object.keys(advMs).map(Number);
    const favKeys=Object.keys(favMs).map(Number);
    return '<tr>'+
      '<td class="cb fw" style="font-size:11px">'+p.symbol+'</td>'+
      '<td>'+tBadge(symType(p.symbol))+'</td>'+
      '<td>'+dBadge(p.direction)+'</td>'+
      '<td>'+vBadge(p.vwapPosition)+'</td>'+
      '<td>'+sBadge(p.session)+'</td>'+
      '<td class="cd" style="font-size:10px">'+f2(p.entry)+'</td>'+
      '<td class="cr" style="font-size:10px">'+f2(p.sl)+'</td>'+
      '<td class="cg" style="font-size:10px">'+f2(p.tp)+'</td>'+
      '<td class="'+(peakPos>=1?'cg fw':peakPos>0?'cy':'cd')+' fw">'+f2(peakPos)+'R</td>'+
      '<td class="'+(peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd')+'">'+f2(peakPos)+'R</td>'+
      '<td class="'+(peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd')+'">'+( peakNeg>0?'-'+f0(peakNeg)+'%':'—')+'</td>'+
      '<td class="cy">'+(tpRR!=null?f2(tpRR)+'R':'—')+'</td>'+
      '<td class="cd">—</td>'+
      '<td class="cd">'+f2(p.lots)+'</td>'+
      '<td class="'+(rPct&&+rPct>0.04?'cr fw':rPct&&+rPct>0.025?'co':'cg')+'">'+(rPct!=null?rPct+'%':'—')+'</td>'+
      // ADV milestones (-1.0 to -0.1): slMilestones keys 100,90,75,50,25
      ADV_STEPS.map(v=>{
        const pctKey=Math.round(v*100);
        const nearest=advKeys.sort((a,b)=>Math.abs(a-pctKey)-Math.abs(b-pctKey))[0];
        const ms=nearest!=null&&Math.abs(nearest-pctKey)<=15?advMs[nearest]:null;
        return msT(ms,p.openedAt,false);
      }).join('')+
      // FAV milestones (+0.1 to +15): rrMilestones keys 1,2,3,5,10
      FAV_STEPS.map(v=>{
        const intV=Math.round(v);
        const nearest=favKeys.sort((a,b)=>Math.abs(a-intV)-Math.abs(b-intV))[0];
        const ms=nearest!=null&&Math.abs(nearest-intV)<=1?favMs[nearest]:null;
        return msT(ms,p.openedAt,true);
      }).join('')+
      '<td class="cd" style="font-size:9px">'+dt(p.openedAt)+'</td>'+
    '</tr>';
  }).join('');
}

// ── loadGhostTrackers — reuses /api/open-positions ghost data ─────
async function loadGhostTrackers(){
  const d=await api('/api/open-positions')||[];
  const ghosts=d.filter(p=>p.ghost!=null);
  const cnt=ghosts.length;
  setText('h-gh',cnt); setText('nb-gh',cnt||'');
  const ghStrip=document.getElementById('gh-strip');
  if(!cnt){ setHtml('gh-body',emptyRow(100,'No active ghost trackers')); if(ghStrip) ghStrip.style.display='none'; return; }
  if(ghStrip) ghStrip.style.display='flex';
  const best=Math.max(...ghosts.map(g=>g.ghost?.peakRRPos??g.ghost?.maxRR??0));
  const worst=Math.max(...ghosts.map(g=>g.ghost?.peakRRNeg??g.ghost?.maxSlPctUsed??0));
  const buys=ghosts.filter(g=>g.direction==='buy').length;
  const elapsed=ghosts.map(g=>g.openedAt?Math.round((Date.now()-new Date(g.openedAt))/60000):0);
  const avgEl=elapsed.length?Math.round(elapsed.reduce((s,v)=>s+v,0)/elapsed.length):0;
  setText('gh-cnt',cnt);
  setText('gh-best',f2(best)+'R');
  setText('gh-worst',worst>0?'-'+f0(worst)+'%':'—');
  setText('gh-buy',buys); setText('gh-sell',cnt-buys);
  setText('gh-sk',ghosts.filter(g=>symType(g.symbol)==='stock').length);
  setText('gh-ix',ghosts.filter(g=>symType(g.symbol)==='index').length);
  setText('gh-fx',ghosts.filter(g=>symType(g.symbol)==='forex').length);
  setText('gh-el',msFmt(avgEl));

  const msT=(ms,opened,isFav)=>{
    const cls='td class="'+(isFav?'ms-fav cg':'ms-adv cr')+'" style="font-size:8px"';
    if(!ms||!opened) return '<'+cls+'>—</td>';
    const mins=Math.round((new Date(ms)-new Date(opened))/60000);
    return '<'+cls+'>'+msFmt(mins)+'</td>';
  };
  const tbody=document.getElementById('gh-body');
  if(!tbody) return;
  tbody.innerHTML=ghosts.map(g=>{
    const peakPos=g.ghost?.peakRRPos??g.ghost?.maxRR??0;
    const peakNeg=g.ghost?.peakRRNeg??g.ghost?.maxSlPctUsed??0;
    const advMs=g.ghost?.slMilestones||{};
    const favMs=g.ghost?.rrMilestones||{};
    const advKeys=Object.keys(advMs).map(Number);
    const favKeys=Object.keys(favMs).map(Number);
    const elapsed=g.openedAt?Math.round((Date.now()-new Date(g.openedAt))/60000):null;
    return '<tr>'+
      '<td class="cb fw" style="font-size:11px">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="'+(peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd')+'">'+f2(peakPos)+'R</td>'+
      '<td class="'+(peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd')+'">'+( peakNeg>0?'-'+f0(peakNeg)+'%':'—')+'</td>'+
      ADV_STEPS.map(v=>{
        const pctKey=Math.round(v*100);
        const nearest=advKeys.sort((a,b)=>Math.abs(a-pctKey)-Math.abs(b-pctKey))[0];
        const ms=nearest!=null&&Math.abs(nearest-pctKey)<=15?advMs[nearest]:null;
        return msT(ms,g.openedAt,false);
      }).join('')+
      FAV_STEPS.map(v=>{
        const intV=Math.round(v);
        const nearest=favKeys.sort((a,b)=>Math.abs(a-intV)-Math.abs(b-intV))[0];
        const ms=nearest!=null&&Math.abs(nearest-intV)<=1?favMs[nearest]:null;
        return msT(ms,g.openedAt,true);
      }).join('')+
      '<td class="cd">'+msFmt(elapsed)+'</td>'+
      '<td class="cd" style="font-size:9px">'+dt(g.openedAt)+'</td>'+
    '</tr>';
  }).join('');
}

// ── renderOverview — called after trades+daily+ghGrouped load ────
let _allTrades=[];
function renderOverview(trades, daily, ghGrouped){
  // Trades: realizedPnlEUR, direction, vwapPosition, session, symbol, openedAt, closedAt, maxRR, hitTP
  const total=trades.length;
  setText('ov-comp',total);
  setText('wr-meta',total+' trades · compliance+');
  setText('dist-meta',total+' trades · compliance+');

  // Summary strip
  const buys=trades.filter(t=>t.direction==='buy').length;
  const ab=trades.filter(t=>t.vwapPosition==='above').length;
  setText('wr-tot',total); setText('wr-tot-n',total+' trades');
  setText('wr-buy',buys); setText('wr-sell',total-buys);
  setText('wr-ab',ab); setText('wr-bw',total-ab);
  setText('wr-asia',trades.filter(t=>t.session==='asia').length);
  setText('wr-lon', trades.filter(t=>t.session==='london').length);
  setText('wr-ny',  trades.filter(t=>t.session==='ny').length);

  // % gain
  const pnlSum=trades.reduce((s,t)=>s+(t.realizedPnlEUR||0),0);
  const balStr=(document.getElementById('ov-bal')?.textContent||'').replace('€','').replace(/[,\s]/g,'');
  const bal=parseFloat(balStr)||0;
  if(bal>0){
    const gPct=(pnlSum/bal*100);
    const gStr=(gPct>=0?'+':'')+gPct.toFixed(2)+'%';
    setText('ov-gain',gStr); setClass('ov-gain','ov-val '+(gPct>=0?'cg':'cr'));
    setText('h-gain',gStr);
    setText('ov-gain-sub',(gPct>=0?'+':'')+eu(pnlSum)+' realized');
  }

  // Ghost history count
  if(ghGrouped){
    const closed=ghGrouped.reduce((s,g)=>s+(g.n||0),0);
    setText('h-ghh',closed);
    const tpLocked=ghGrouped.filter(g=>(g.n||0)>=5).length;
    setText('h-tp',tpLocked);
  }

  // Trade activity table
  window._wrTrades=trades;
  renderWRTable(window._wrTypeFilter||'all');

  // Distribution
  const fxT=trades.filter(t=>symType(t.symbol)==='forex');
  const skT=trades.filter(t=>symType(t.symbol)==='stock');
  const ixT=trades.filter(t=>symType(t.symbol)==='index');
  const cmT=trades.filter(t=>symType(t.symbol)==='commodity');
  setText('d-tot',total); setText('d-fx',fxT.length); setText('d-sk',skT.length);
  setText('d-ix',ixT.length); setText('d-cm',cmT.length);
  setText('d-buy',buys); setText('d-sell',total-buys);

  let ba_t=0,bb_t=0,sa_t=0,sb_t=0;
  const typeGroups=[
    {label:'Forex',    arr:fxT, cls:'bd-fx', sessions:['asia','london','ny']},
    {label:'Stock',    arr:skT, cls:'bd-sk', sessions:['ny']},
    {label:'Index',    arr:ixT, cls:'bd-ix', sessions:['asia','london','ny']},
    {label:'Commodity',arr:cmT, cls:'bd-cm', sessions:['asia','london','ny']},
  ];
  const dRows=[];
  for(const tg of typeGroups){
    for(const sess of tg.sessions){
      const st=tg.arr.filter(t=>t.session===sess); if(!st.length) continue;
      const ba=st.filter(t=>t.direction==='buy'&&t.vwapPosition==='above').length;
      const bb=st.filter(t=>t.direction==='buy'&&t.vwapPosition==='below').length;
      const sa=st.filter(t=>t.direction==='sell'&&t.vwapPosition==='above').length;
      const sb=st.filter(t=>t.direction==='sell'&&t.vwapPosition==='below').length;
      ba_t+=ba; bb_t+=bb; sa_t+=sa; sb_t+=sb;
      dRows.push('<tr><td><span class="bd '+tg.cls+'">'+tg.label+'</span></td><td>'+sBadge(sess)+'</td><td class="cg fw">'+ba+'</td><td class="cg">'+bb+'</td><td class="cr fw">'+sa+'</td><td class="cr">'+sb+'</td><td class="cb fw">'+(ba+bb+sa+sb)+'</td></tr>');
    }
  }
  setHtml('dist-body',dRows.join('')||emptyRow(7,'No trades after compliance date'));
  setText('ft-ba',ba_t); setText('ft-bb',bb_t); setText('ft-sa',sa_t); setText('ft-sb',sb_t); setText('ft-t',total);

  // Daily breakdown
  // days rows: {trade_date, trades, wins, losses, day_pnl, avg_pnl, best_rr, worst_rr, avg_rr, avg_lots, cum_pnl}
  const days=daily?.days||[];
  setText('daily-meta',days.length+' trading days · compliance+');
  setText('d-wstrk',(daily?.maxWinStreak||0)+' days');
  setText('d-lstrk',(daily?.maxLossStreak||0)+' days');
  setText('d-dd','€'+f2(daily?.maxDrawdownDay));
  setHtml('daily-body',days.length?days.slice(0,60).map(r=>{
    const wins=parseInt(r.wins||0), tot=parseInt(r.trades||0), lss=parseInt(r.losses||0);
    const wpct=tot>0?(wins/tot*100):0;
    return '<tr>'+
      '<td class="cd" style="font-size:10px">'+dtS(r.trade_date)+'</td>'+
      '<td class="cb">'+tot+'</td>'+
      '<td class="cg">'+wins+'</td>'+
      '<td class="cr">'+lss+'</td>'+
      '<td class="'+(wpct>=50?'cg':wpct>=40?'cy':'cr')+'">'+wpct.toFixed(1)+'%</td>'+
      '<td class="'+pC(r.day_pnl)+' fw">'+eu(r.day_pnl)+'</td>'+
      '<td class="'+pC(r.cum_pnl)+'">'+eu(r.cum_pnl)+'</td>'+
      '<td class="cd">'+f2(r.avg_lots)+'</td>'+
      '<td class="cy">'+f2(r.best_rr)+'R</td>'+
      '<td class="cd">'+f2(r.avg_rr)+'R</td>'+
    '</tr>';
  }).join(''):emptyRow(10,'No daily data'));

  // Best/Worst: comes from daily.bestTrades/worstTrades
  // fields: symbol, direction, session, vwapPosition, maxRR, pnl, hitTP, closeReason, openedAt
  window._bestTrades  = daily?.bestTrades  || [];
  window._worstTrades = daily?.worstTrades || [];
  renderBW('all');
}

// ── Trade Activity table ──────────────────────────────────────────
window._wrTypeFilter='all';
function setWRType(type,btn){
  window._wrTypeFilter=type;
  document.querySelectorAll('#wr-type-tabs .fb').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');
  renderWRTable(type);
}
function renderWRTable(typeFilter){
  const trades=window._wrTrades||[];
  const filtered=typeFilter==='all'?trades:trades.filter(t=>symType(t.symbol)===typeFilter);
  const combos={};
  for(const t of filtered){
    const k=(t.session||'?')+'|'+(t.direction||'?')+'|'+(t.vwapPosition||'?')+'|'+symType(t.symbol);
    combos[k]=(combos[k]||0)+1;
  }
  const rows=Object.entries(combos).sort((a,b)=>b[1]-a[1]).map(([k,n])=>{
    const [sess,dir,vwap,type]=k.split('|');
    return '<tr><td>'+sBadge(sess)+'</td><td>'+dBadge(dir)+'</td><td>'+vBadge(vwap)+'</td><td>'+tBadge(type)+'</td><td class="cb fw">'+n+'</td></tr>';
  }).join('');
  setHtml('wr-body',rows||emptyRow(5,'No trades'));
  setText('wr-meta',(filtered.length)+' trades · compliance+');
}

// ── Best/Worst setups ─────────────────────────────────────────────
let _bwPeriod='all';
function setBWP(p,btn){
  _bwPeriod=p;
  document.querySelectorAll('.fb[onclick*="setBWP"]').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');
  setText('bw-period-lbl',p==='day'?'today':p==='week'?'this week':'all time');
  renderBW(p);
}
function renderBW(period){
  // bestTrades/worstTrades from daily endpoint: {symbol,direction,session,vwapPosition,maxRR,pnl,openedAt}
  const now=new Date();
  const today=new Date(now); today.setHours(0,0,0,0);
  const weekStart=new Date(now); weekStart.setDate(now.getDate()-now.getDay()); weekStart.setHours(0,0,0,0);
  function filt(arr){
    if(period==='all') return arr;
    return arr.filter(t=>{ const d=new Date(t.openedAt); return period==='day'?d>=today:d>=weekStart; });
  }
  let best,worst;
  if(period==='all'){
    best  = window._bestTrades||[];
    worst = window._worstTrades||[];
  } else {
    // Filter _allTrades by period
    const pool=filt(_allTrades).filter(t=>t.realizedPnlEUR!=null);
    const sorted=pool.sort((a,b)=>(b.realizedPnlEUR||0)-(a.realizedPnlEUR||0));
    best=sorted.slice(0,5);
    worst=sorted.slice(-5).reverse();
    // Map field names to match bestTrades format
    best=best.map(t=>({...t, pnl:t.realizedPnlEUR, maxRR:t.maxRR}));
    worst=worst.map(t=>({...t, pnl:t.realizedPnlEUR, maxRR:t.maxRR}));
  }
  const row=t=>'<tr>'+
    '<td class="cb fw" style="font-size:10px">'+t.symbol+'</td>'+
    '<td>'+dBadge(t.direction)+'</td>'+
    '<td>'+sBadge(t.session)+'</td>'+
    '<td>'+vBadge(t.vwapPosition)+'</td>'+
    '<td class="cy" style="font-size:10px">'+f2(t.maxRR)+'R</td>'+
    '<td class="'+((+(t.pnl||0))>=0?'cg':'cr')+' fw" style="font-size:10px">'+eu(t.pnl)+'</td>'+
    '<td class="cd" style="font-size:9px">'+dtS(t.openedAt)+'</td>'+
  '</tr>';
  setHtml('best-body', (best||[]).map(row).join('')||emptyRow(7,'No trades'));
  setHtml('worst-body',(worst||[]).map(row).join('')||emptyRow(7,'No trades'));
}

// ── Ghost History (by pair, expandable) ──────────────────────────
let _ghhData=[],_ghhF={sess:'all',dir:'all',type:'all'};
function setGHF(k,v,btn){
  _ghhF[k]=v;
  document.querySelectorAll('.fb[onclick*="setGHF"]').forEach(b=>{ if(b.getAttribute('onclick').includes("'"+k+"'")) b.classList.remove('on'); });
  if(btn) btn.classList.add('on');
  renderGhostHistory();
}
async function loadGhostHistory(){
  // /api/ghost-history-by-pair returns grouped: {optimizerKey,symbol,session,direction,vwapPosition,
  //   n,nSLHit,nMaxRR15,nMaxDays,avgPeakPos,avgPeakNeg,maxPeakPos,maxPeakNeg,trades:[...]}
  const d=await api('/api/ghost-history-by-pair')||[];
  _ghhData=d;
  const closed=d.reduce((s,g)=>s+(g.n||0),0);
  setText('h-ghh',closed);
  setText('ghh-meta',d.length+' combos · compliance+');
  renderGhostHistory();
}
function renderGhostHistory(){
  const data=_ghhData.filter(g=>{
    if(_ghhF.sess!=='all'&&g.session!==_ghhF.sess) return false;
    if(_ghhF.dir!=='all'&&g.direction!==_ghhF.dir) return false;
    if(_ghhF.type!=='all'&&symType(g.symbol)!==_ghhF.type) return false;
    return true;
  });
  if(!data.length){ setHtml('ghh-body',emptyRow(15,'No ghost history')); return; }
  const tbody=document.getElementById('ghh-body'); if(!tbody) return;
  tbody.innerHTML=data.map(g=>{
    const safeKey=(g.optimizerKey||'').replace(/[^a-z0-9]/gi,'_');
    const tpRRs=(g.trades||[]).filter(t=>parseFloat(t.peakRRPos||t.maxRR||0)>0).map(t=>parseFloat(t.peakRRPos||t.maxRR));
    const last5=tpRRs.slice(0,5);
    const bestTP=last5.length?'avg '+f2(last5.reduce((s,v)=>s+v,0)/last5.length)+'R':'—';
    const reasons=(g.trades||[]).map(t=>t.stopReason).filter(Boolean);
    const topReason=reasons.length?Object.entries(reasons.reduce((m,r)=>{m[r]=(m[r]||0)+1;return m;},{})).sort((a,b)=>b[1]-a[1])[0][0]:'—';
    return '<tr style="cursor:pointer" onclick="toggleGHHRow(\''+safeKey+'\')">'+
      '<td class="cd" style="font-size:9px">▶</td>'+
      '<td class="cb fw">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="'+(g.n>=5?'cy fw':'cc')+'">'+g.n+'</td>'+
      '<td class="cr">'+(g.nSLHit||0)+'</td>'+
      '<td class="cg">'+(g.nMaxRR15||0)+'</td>'+
      '<td class="cy">'+(g.nMaxDays||0)+'</td>'+
      '<td class="cg fw">'+f2(g.avgPeakPos)+'R</td>'+
      '<td class="cr">'+f1(g.avgPeakNeg)+'%</td>'+
      '<td class="cg fw">'+f2(g.maxPeakPos)+'R</td>'+
      '<td class="cy" style="font-size:9px">'+bestTP+'</td>'+
      '<td class="cd" style="font-size:9px">'+topReason+'</td>'+
    '</tr>'+
    '<tr id="ghh-d-'+safeKey+'" style="display:none">'+
      '<td colspan="15" style="padding:0;background:var(--bg3)">'+
        '<div style="overflow-x:auto"><table style="font-size:9px;min-width:600px">'+
          '<thead><tr>'+
            '<th>#</th><th>Date</th><th>Stop Reason</th><th>TP RR</th><th>Max RR</th>'+
            '<th>Peak+RR</th><th>Peak-RR%</th><th>MAE%</th>'+
          '</tr></thead><tbody>'+
          (g.trades||[]).map((t,i)=>{
            const sr=t.stopReason;
            const srCls=sr==='phantom_sl'?'cr':sr==='max_rr_15'?'cg':'cy';
            return '<tr style="border-bottom:1px solid var(--bdr)">'+
              '<td class="cd">'+( i+1)+'</td>'+
              '<td class="cd" style="font-size:8px">'+dtS(t.openedAt)+'</td>'+
              '<td class="'+srCls+'" style="font-size:8px">'+(sr||'—')+'</td>'+
              '<td class="cy">'+f2(t.tpRRUsed)+'</td>'+
              '<td class="cy">'+f2(t.maxRR)+'R</td>'+
              '<td class="cg">'+f2(t.peakRRPos)+'R</td>'+
              '<td class="cr">'+f1(t.peakRRNeg)+'%</td>'+
              '<td class="cd">'+f1(t.maxSlPct)+'%</td>'+
            '</tr>';
          }).join('')+
        '</tbody></table></div>'+
      '</td>'+
    '</tr>';
  }).join('');
}
function toggleGHHRow(key){ const el=document.getElementById('ghh-d-'+key); if(el) el.style.display=el.style.display==='none'?'':'none'; }

// ── Ghost Combo (signal combo grouped) ───────────────────────────
async function loadGhostCombo(){
  // /api/ghost-grouped: {optimizerKey,symbol,session,direction,vwapPosition,n,avgMaxRR,bestMaxRR,avgSlPct,avgTpRR,slHits,lastOpened}
  const d=await api('/api/ghost-grouped')||[];
  setText('ghc-meta',d.length+' combos · compliance+');
  const tbody=document.getElementById('ghc-body'); if(!tbody) return;
  if(!d.length){ tbody.innerHTML=emptyRow(26,'No signal combo data'); return; }
  tbody.innerHTML=d.map(g=>{
    return '<tr>'+
      '<td class="cb fw">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="'+(g.n>=5?'cy fw':'cc')+'">'+g.n+'</td>'+
      '<td class="cc">'+g.n+'</td>'+
      '<td class="cg fw">'+f2(g.bestMaxRR)+'R</td>'+
      '<td class="cd">'+f2(g.avgMaxRR)+'R</td>'+
      '<td class="cd" colspan="4">avg SL used: '+f1(g.avgSlPct)+'%</td>'+
      '<td class="cg" colspan="7">avg TP RR: '+f2(g.avgTpRR)+'R</td>'+
      '<td class="cr" style="font-size:9px">'+g.slHits+' SL hits</td>'+
      '<td class="cd" colspan="3" style="font-size:9px">'+dt(g.lastOpened)+'</td>'+
      '<td class="cd">—</td>'+
      '<td class="'+(g.n>=5?'cg fw':'cd')+'">'+( g.n>=5?f2(g.avgTpRR)+'R':'need≥5')+'</td>'+
    '</tr>';
  }).join('');
}

// ── EV TP Optimizer ───────────────────────────────────────────────
let _evData=[],_evF={type:'all',sess:'all',dir:'all',min:'5'};
function setEVF(k,v,btn){
  _evF[k]=v;
  document.querySelectorAll('.fb[onclick*="setEVF"]').forEach(b=>{ if(b.getAttribute('onclick').includes("'"+k+"'")) b.classList.remove('on'); });
  if(btn) btn.classList.add('on');
  renderEV();
}
async function loadEV(){
  const [g,tp]=await Promise.all([api('/api/ghost-grouped'),api('/api/tp-config')]);
  const grouped=g||[];
  const evKeys=grouped.filter(r=>r.n>=5).map(r=>r.optimizerKey);
  const evResults=await Promise.all(evKeys.map(key=>api('/api/ev-stats?key='+encodeURIComponent(key))));
  const evMap={};
  evKeys.forEach((key,i)=>{ if(evResults[i]) evMap[key]=evResults[i]; });
  _evData=grouped.map(r=>({...r,tpLocked:(tp||{})[r.optimizerKey],evStats:evMap[r.optimizerKey]||null}));
  renderEV();
}
function renderEV(){
  const minN=parseInt(_evF.min)||5;
  const rows=_evData.filter(g=>{
    if(g.n<minN) return false;
    if(_evF.type!=='all'&&symType(g.symbol)!==_evF.type) return false;
    if(_evF.sess!=='all'&&g.session!==_evF.sess) return false;
    if(_evF.dir!=='all'&&g.direction!==_evF.dir) return false;
    return true;
  });
  setText('ev-cnt',rows.length);
  setText('ev-data',rows.filter(r=>r.n>0).length);
  setText('ev-lock',rows.filter(r=>r.tpLocked?.lockedRR).length);
  setText('ev-meta',rows.length+' combos shown · ≥'+minN+' ghosts required for EV lock');
  const tbody=document.getElementById('ev-body'); if(!tbody) return;
  if(!rows.length){ tbody.innerHTML=emptyRow(15,'No combos match filters'); return; }
  tbody.innerHTML=rows.map(r=>{
    const tp=r.tpLocked;
    return '<tr>'+
      '<td class="cb fw">'+r.symbol+'</td>'+
      '<td>'+tBadge(symType(r.symbol))+'</td>'+
      '<td>'+sBadge(r.session)+'</td>'+
      '<td>'+dBadge(r.direction)+'</td>'+
      '<td>'+vBadge(r.vwapPosition)+'</td>'+
      '<td class="'+(r.n>=5?'cy fw':'cc')+'">'+r.n+'</td>'+
      '<td class="cd">'+r.n+'</td>'+
      '<td class="cg fw">'+f2(r.bestMaxRR)+'R</td>'+
      '<td class="cd">'+f2(r.avgMaxRR)+'R</td>'+
      '<td class="cd">—</td>'+
      '<td class="'+(tp?.lockedRR?'cg':'cy')+'" style="font-size:9px">'+(tp?.lockedRR?'✓ EV+ Locked':'need≥5')+'</td>'+
      '<td class="'+(tp?.lockedRR?'cg fw':'cd')+'">'+( tp?.lockedRR?tp.lockedRR+'R':'—')+'</td>'+
      '<td class="cd">'+f1(r.avgSlPct)+'% avg SL</td>'+
      '<td class="cd">—</td>'+
      '<td class="cd">—</td>'+
    '</tr>';
  }).join('');
}

// ── EV SL Optimizer ───────────────────────────────────────────────
async function loadEVSL(){
  // /api/mae-stats returns: {optimizerKey,nTotal,nSurvivors,nSLHit,maeP50,maeP75,maeP90,maeAvg,slReduction}
  const d=await api('/api/mae-stats')||[];
  const tbody=document.getElementById('evsl-body'); if(!tbody) return;
  if(!d.length){ tbody.innerHTML=emptyRow(14,'Min 3 ghost trades required per combo · waiting for ghost data'); return; }
  tbody.innerHTML=d.map(r=>{
    const parts=(r.optimizerKey||'').split('_');
    const sym=parts[0]||'—',sess=parts[1]||'—',dir=parts[2]||'—',vwap=parts[3]||'—';
    const p90=r.maeP90; const slRec=r.slReduction;
    const cls=slRec?.color==='g'?'cg':slRec?.color==='y'?'cy':slRec?.color==='r'?'cr':'cd';
    const pot=p90!=null&&p90<100?(100-p90).toFixed(1)+'% possible':'—';
    return '<tr>'+
      '<td class="cb fw">'+sym+'</td>'+
      '<td>'+tBadge(symType(sym))+'</td>'+
      '<td>'+sBadge(sess)+'</td>'+
      '<td>'+dBadge(dir)+'</td>'+
      '<td>'+vBadge(vwap)+'</td>'+
      '<td class="'+(r.nTotal>=5?'cy':'cc')+'">'+r.nTotal+' <span class="cd" style="font-size:9px">('+r.nSurvivors+' surv/'+r.nSLHit+' SL)</span></td>'+
      '<td class="cg">'+f1(r.maeP50)+'%</td>'+
      '<td class="cy">'+f1(r.maeP75)+'%</td>'+
      '<td class="'+cls+' fw">'+f1(r.maeP90)+'%</td>'+
      '<td class="'+cls+' fw" style="font-size:9px">'+(slRec?.label||'—')+'</td>'+
      '<td class="cd">'+f1(r.maeAvg)+'%</td>'+
      '<td class="'+(pot!=='—'?'cg':'cd')+'" style="font-size:9px">'+pot+'</td>'+
      '<td class="cd">—</td><td class="cd">—</td>'+
    '</tr>';
  }).join('');
}

// ── Signals & Blocked ─────────────────────────────────────────────
async function loadSignals(){
  // /api/signal-stats: {total,placed,conversionPct,byOutcome:[{outcome,count}],topRejectReasons:[{reason,count,pairs}]}
  // /api/webhook-history: rows from webhook_history table (raw DB rows, snake_case)
  const [stats,hist,rejects]=await Promise.all([
    api('/api/signal-stats'),
    api('/api/webhook-history?limit=80'),
    api('/api/signal-rejects'),
  ]);
  const s=stats||{};
  setText('sig-tot',s.total||0);
  setText('sig-placed',s.placed||0);
  setText('sig-conv',s.conversionPct!=null?pct(s.conversionPct):'—');
  const totalBlocked=(s.byOutcome||[]).filter(o=>o.outcome!=='PLACED').reduce((sum,o)=>sum+(o.count||0),0);
  setText('blk-tot',totalBlocked);
  // topRejectReasons[].reason = raw string from DB e.g. "DUPLICATE_OPEN"
  const reasons={};
  (s.topRejectReasons||[]).forEach(r=>{ reasons[(r.reason||'').toLowerCase().replace(/[^a-z]/g,'_')]=r.count||0; });
  setText('blk-dup',reasons['duplicate_open']||reasons['duplicate']||0);
  setText('blk-vw', reasons['vwap_exhausted']||reasons['vwap']||0);
  setText('blk-win',reasons['outside_window']||reasons['outside_trading_window']||0);
  setText('blk-cur',reasons['currency_budget']||reasons['budget']||0);
  setText('blk-ny', reasons['ny_dead_zone']||reasons['ny_dz']||0);
  const nbSig=document.getElementById('nb-sig');
  if(nbSig&&totalBlocked>0){ nbSig.textContent=totalBlocked; nbSig.style.display=''; }

  // Webhook history — DB rows are snake_case: ts, symbol, direction, session, vwap_position, entry, sl_pct, band_pct, status, reason
  const placed=(hist||[]).filter(r=>r.status==='OK'||r.status==='PLACED');
  const errors=(hist||[]).filter(r=>r.status!=='OK'&&r.status!=='PLACED');
  setHtml('placed-body',placed.length?placed.map(r=>
    '<tr>'+
    '<td class="cd" style="font-size:9px">'+dt(r.ts)+'</td>'+
    '<td class="cb fw">'+r.symbol+'</td>'+
    '<td>'+dBadge(r.direction)+'</td>'+
    '<td>'+sBadge(r.session)+'</td>'+
    '<td>'+(r.vwap_position?vBadge(r.vwap_position):'—')+'</td>'+
    '<td class="cd">'+f2(r.entry)+'</td>'+
    '<td class="cd">'+(r.sl_pct!=null?pct(r.sl_pct*100):'—')+'</td>'+
    '<td class="cd">'+(r.latency_ms!=null?r.latency_ms+'ms':'—')+'</td>'+
    '</tr>'
  ).join(''):emptyRow(8,'No placed signals in memory · resets on restart'));

  setHtml('whe-body',errors.length?errors.map(r=>
    '<tr>'+
    '<td class="cd" style="font-size:9px">'+dt(r.ts)+'</td>'+
    '<td class="cb fw">'+r.symbol+'</td>'+
    '<td>'+dBadge(r.direction)+'</td>'+
    '<td>'+sBadge(r.session)+'</td>'+
    '<td>'+(r.vwap_position?vBadge(r.vwap_position):'—')+'</td>'+
    '<td class="cd">'+f2(r.entry)+'</td>'+
    '<td class="cd">'+(r.sl_pct!=null?pct(r.sl_pct*100):'—')+'</td>'+
    '<td class="cd">'+(r.band_pct!=null?pct(r.band_pct):'—')+'</td>'+
    '<td class="cr" style="font-size:9px">'+(r.reason||r.status||'—')+'</td>'+
    '</tr>'
  ).join(''):emptyRow(9,'No webhook errors in memory'));

  // Signal rejects: loadSignalRejects returns [{outcome,total,pairs:[{symbol,direction,session,rejectReason,count}]}]
  const blkRows=[];
  for(const outcome of (rejects||[])){
    for(const p of (outcome.pairs||[]).slice(0,5)){
      blkRows.push('<tr>'+
        '<td class="cr" style="font-size:9px">'+(p.rejectReason||outcome.outcome||'—')+'</td>'+
        '<td class="cb">'+p.symbol+'</td>'+
        '<td>'+dBadge(p.direction)+'</td>'+
        '<td>'+sBadge(p.session)+'</td>'+
        '<td>—</td>'+
        '<td class="cr fw">'+p.count+'</td>'+
      '</tr>');
    }
  }
  setHtml('blk-body',blkRows.join('')||emptyRow(6,'No blocked signals'));
}

async function loadBlockedRaw(){
  // /api/blocked-raw: {symbol,direction,vwapPosition,session,rejectReason,outcome,count,lastSeen}
  const d=await api('/api/blocked-raw')||[];
  setText('blkraw-meta',d.length+' entries · compliance+');
  setHtml('blkraw-body',d.length?d.slice(0,200).map(r=>
    '<tr>'+
    '<td class="cb fw">'+r.symbol+'</td>'+
    '<td>'+dBadge(r.direction)+'</td>'+
    '<td>'+vBadge(r.vwapPosition)+'</td>'+
    '<td>'+sBadge(r.session)+'</td>'+
    '<td class="'+(r.outcome==='PLACED'?'cg':'cr')+'" style="font-size:9px">'+(r.outcome||'—')+'</td>'+
    '<td class="cr" style="font-size:9px">'+(r.rejectReason||'—')+'</td>'+
    '<td class="cr fw">'+(r.count||1)+'</td>'+
    '<td class="cd" style="font-size:9px">'+dt(r.lastSeen)+'</td>'+
    '</tr>'
  ).join(''):emptyRow(8,'No blocked raw data'));
}

async function loadBand(){
  const [b1,b2]=await Promise.all([
    api('/api/band-ghost-stats?bandTier=150_250'),
    api('/api/band-ghost-stats?bandTier=250_350'),
  ]);
  const fill=(data,bId)=>{
    const tbody=document.getElementById(bId); if(!tbody) return;
    if(!data?.length){ tbody.innerHTML=emptyRow(8,'No band data'); return; }
    tbody.innerHTML=data.slice(0,30).map(r=>'<tr>'+
      '<td class="cb fw">'+r.symbol+'</td>'+
      '<td>'+sBadge(r.session||'—')+'</td>'+
      '<td>'+dBadge(r.direction||'buy')+'</td>'+
      '<td>'+vBadge(r.vwapPosition||r.vwap_position||'above')+'</td>'+
      '<td class="cc">'+(r.n||0)+'</td>'+
      '<td class="cg">'+f2(r.avgMaxRR||r.avg_max_rr)+'R</td>'+
      '<td class="cg fw">'+f2(r.bestMaxRR||r.best_max_rr)+'R</td>'+
      '<td class="cd">'+f1(r.avgSlPct||r.avg_sl_pct)+'%</td>'+
    '</tr>').join('');
  };
  fill(b1,'b150-body'); fill(b2,'b250-body');
}

// ── Boot ──────────────────────────────────────────────────────────
// Initialise milestone styles
(function(){
  const s=document.createElement('style'); s.id='ms-style';
  s.textContent='.ms-adv,.ms-fav{display:none!important}';
  document.head.appendChild(s);
  // Also hide th columns
  document.addEventListener('DOMContentLoaded',()=>{
    document.querySelectorAll('th.adv-th,th.fav-th').forEach(el=>el.style.display='none');
  });
})();

async function loadAll(){
  // 1. Status poll + live positions + ghost trackers in parallel
  await Promise.all([pollStatus(), loadPositions(), loadGhostTrackers()]);
  // 2. Trade history + daily breakdown + ghost grouped
  const compDateStr=document.getElementById('cbar-date')?.textContent?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const cutoff=compDateStr?new Date(compDateStr+'T00:00:00Z').getTime():0;
  const [trades,daily,ghGrouped]=await Promise.all([
    api('/api/trades'),
    api('/api/daily-breakdown'),
    api('/api/ghost-grouped'),
  ]);
  _allTrades=(trades||[]).filter(t=>t.openedAt&&new Date(t.openedAt).getTime()>=cutoff);
  renderOverview(_allTrades,daily,ghGrouped);
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',()=>{loadAll();setInterval(loadAll,30000);});
}else{
  loadAll();
  setInterval(loadAll,30000);
}
</script>

</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════
//  BACKGROUND DB INIT  (runs after server is already listening)
// ══════════════════════════════════════════════════════════════════
async function initBackground() {
  // Retry DB init up to 5 times with backoff
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await db.initDB();
      console.log("[DB] initDB() success");
      break;
    } catch (e) {
      console.error(`[DB] initDB attempt ${attempt}/5 failed: ${e.message}`);
      if (attempt < 5) await new Promise(r => setTimeout(r, 3000 * attempt));
      else { recordError(`initDB failed permanently: ${e.message}`); return; }
    }
  }

  // Load compliance date
  try {
    const saved = await db.loadComplianceDate();
    if (saved) { liveComplianceDate = saved; db.setComplianceDateLive(saved); }
  } catch {}

  // Load cached config
  try {
    [tpConfigs, symbolRiskMap, keyRiskMults] = await Promise.all([
      db.loadTPConfig().catch(() => ({})),
      db.loadSymbolRiskConfig().catch(() => ({})),
      db.loadKeyRiskMults().catch(() => ({})),
    ]);
    console.log(`[DB] Loaded: ${Object.keys(tpConfigs).length} TP, ${Object.keys(symbolRiskMap).length} risk, ${Object.keys(keyRiskMults).length} mults`);
  } catch {}

  // Restore open positions
  try {
    const states = await db.loadAllGhostStates();
    for (const gs of states) {
      if (openPositions.has(gs.positionId)) continue;
      const ghost = { ...gs, maxPrice: gs.maxPrice??gs.entry, maxRR: gs.maxRR??0,
        maxSlPctUsed: gs.maxSlPctUsed??0, slMilestones: gs.slMilestones??{},
        rrMilestones: gs.rrMilestones??{}, phantomSLHit: false, stopReason: null, closedAt: null };
      openPositions.set(gs.positionId, {
        positionId: gs.positionId, symbol: gs.symbol, mt5Symbol: gs.mt5Symbol??gs.symbol,
        direction: gs.direction, vwapPosition: gs.vwapPosition,
        session: gs.session, entry: gs.entry, sl: gs.sl, tp: null, lots: null,
        riskPct: gs.riskPct, riskEUR: gs.riskEUR, openedAt: gs.openedAt,
        optimizerKey: gs.optimizerKey, ghost });
    }
    console.log(`[DB] Restored ${openPositions.size} open positions`);
  } catch (e) { console.error("[DB] restorePositions failed:", e.message); }

  // Sync trade number sequence
  db.syncTradeNumberSequence().catch(() => {});

  // Mark DB as ready
  dbReady = true;
  console.log("[PRONTO-AI] ✅ DB ready — all systems operational");

  // MetaAPI connectivity check
  if (META_API_TOKEN && META_ACCOUNT) {
    console.log(`[MetaAPI] Checking connectivity — account ${META_ACCOUNT.slice(0,8)}…`);
    try {
      const acct = await Promise.race([
        metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15000)),
      ]);
      if (acct) {
        console.log(`[MetaAPI] ✅ Connected — balance: ${acct.balance} ${acct.currency}`);
      } else {
        console.warn("[MetaAPI] ⚠️ Response empty — account may still be deploying");
      }
    } catch (e) {
      console.error(`[MetaAPI] ❌ Connection failed: ${e.message}`);
      recordError(`MetaAPI startup check: ${e.message}`);
    }
  } else {
    console.warn("[MetaAPI] ⚠️ META_API_TOKEN or META_ACCOUNT not set — MetaAPI disabled");
  }

  // Start cron jobs
  cron.schedule("*/30 * * * * *", syncPositions);
  cron.schedule("*/5 * * * *",    runShadowSnapshots);
  cron.schedule("0 * * * *",      runTPOptimizer);
  console.log("[PRONTO-AI] Cron jobs active");
}

// Start background init (non-blocking)
initBackground().catch(e => console.error("[FATAL] initBackground:", e.message));
