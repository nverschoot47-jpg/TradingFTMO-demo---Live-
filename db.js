// ===============================================================
// db.js  v9.0  |  PRONTO-AI
//
// Changes v9.0:
//  - ghost_trades: new table — ghost starts at trade placement,
//    closes on phantom_sl hit, records max_rr_before_sl
//  - shadow_snapshots: price snapshots per open position
//    recording pct_sl_used (how deep toward SL price went)
//  - shadow_sl_analysis: keyed by (symbol, session, direction, vwap_pos)
//    instead of symbol only — one shadow optimizer per key
//  - symbol_risk_config: per-symbol risk_pct override
//  - closed_trades: added vwap_position column
//  - tp_config: keyed by (symbol, session, direction, vwap_pos)
//  - Removed: forex_consolidation_log (no consolidation blocking)
// ===============================================================

"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis:       10000,
  statement_timeout:       8000,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── symbol_risk_config ──────────────────────────────────────
    // Per-symbol risk % override. Seeded from env on startup.
    // UI can show this table so user knows what's active.
    await client.query(`
      CREATE TABLE IF NOT EXISTS symbol_risk_config (
        symbol          TEXT    PRIMARY KEY,
        risk_pct        NUMERIC NOT NULL DEFAULT 0.002,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── closed_trades ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS closed_trades (
        id                  SERIAL      PRIMARY KEY,
        position_id         TEXT        UNIQUE,
        symbol              TEXT        NOT NULL,
        mt5_symbol          TEXT,
        direction           TEXT        NOT NULL,
        vwap_position       TEXT        DEFAULT 'unknown',
        entry               NUMERIC     NOT NULL,
        sl                  NUMERIC     NOT NULL,
        tp                  NUMERIC,
        lots                NUMERIC,
        risk_pct            NUMERIC,
        risk_eur            NUMERIC,
        max_price           NUMERIC,
        max_rr              NUMERIC,
        true_max_rr         NUMERIC,
        true_max_price      NUMERIC,
        ghost_stop_reason   TEXT,
        ghost_finalized_at  TIMESTAMPTZ,
        session             TEXT,
        vwap_at_entry       NUMERIC,
        opened_at           TIMESTAMPTZ,
        closed_at           TIMESTAMPTZ DEFAULT NOW(),
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        sl_multiplier       NUMERIC     DEFAULT 1.0,
        realized_pnl_eur    NUMERIC,
        hit_tp              BOOLEAN     DEFAULT FALSE,
        close_reason        TEXT        DEFAULT 'manual'
      );
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS vwap_position  TEXT    DEFAULT 'unknown';
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS vwap_at_entry  NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS risk_pct       NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_rr    NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_price NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_stop_reason  TEXT;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_finalized_at TIMESTAMPTZ;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS sl_multiplier  NUMERIC DEFAULT 1.0;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS realized_pnl_eur NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS hit_tp         BOOLEAN DEFAULT FALSE;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS close_reason   TEXT    DEFAULT 'manual';
    `);

    // ── ghost_trades ─────────────────────────────────────────────
    // One row per ghost. Ghost is created when the real trade is
    // placed. It closes when phantom_sl is hit (same SL as real).
    // max_rr_before_sl = the best RR reached before phantom SL hit.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ghost_trades (
        id                  SERIAL      PRIMARY KEY,
        position_id         TEXT,
        symbol              TEXT        NOT NULL,
        session             TEXT        NOT NULL,
        direction           TEXT        NOT NULL,
        vwap_position       TEXT        DEFAULT 'unknown',
        optimizer_key       TEXT        NOT NULL,
        entry               NUMERIC     NOT NULL,
        sl                  NUMERIC     NOT NULL,
        sl_pct              NUMERIC,
        phantom_sl          NUMERIC     NOT NULL,
        tp_rr_used          NUMERIC,
        max_price           NUMERIC,
        max_rr_before_sl    NUMERIC,
        phantom_sl_hit      BOOLEAN     DEFAULT FALSE,
        stop_reason         TEXT,
        time_to_sl_min      INTEGER,
        opened_at           TIMESTAMPTZ,
        closed_at           TIMESTAMPTZ,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_key     ON ghost_trades (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_symbol  ON ghost_trades (symbol);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_closed  ON ghost_trades (closed_at);
    `);

    // ── shadow_snapshots ─────────────────────────────────────────
    // Price snapshots taken every minute for open positions.
    // pct_sl_used: 0–100 — how far price moved toward SL as % of SL distance.
    // 0 = price at entry, 100 = price at SL (or beyond).
    await client.query(`
      CREATE TABLE IF NOT EXISTS shadow_snapshots (
        id              SERIAL      PRIMARY KEY,
        position_id     TEXT        NOT NULL,
        optimizer_key   TEXT        NOT NULL,
        symbol          TEXT        NOT NULL,
        session         TEXT        NOT NULL,
        direction       TEXT        NOT NULL,
        vwap_position   TEXT        DEFAULT 'unknown',
        entry           NUMERIC     NOT NULL,
        sl              NUMERIC     NOT NULL,
        current_price   NUMERIC     NOT NULL,
        pct_sl_used     NUMERIC     NOT NULL,
        snapped_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_snap_key ON shadow_snapshots (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_shadow_snap_pos ON shadow_snapshots (position_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_snap_ts  ON shadow_snapshots (snapped_at);
    `);

    // ── shadow_sl_analysis ───────────────────────────────────────
    // One row per optimizer_key (symbol_session_direction_vwap).
    // READ ONLY recommendations — never auto-applied.
    // recommended_sl_pct: % of original SL distance to use.
    // p50/p90/p99: percentiles of pct_sl_used distribution.
    await client.query(`
      CREATE TABLE IF NOT EXISTS shadow_sl_analysis (
        optimizer_key         TEXT    PRIMARY KEY,
        symbol                TEXT    NOT NULL,
        session               TEXT    NOT NULL,
        direction             TEXT    NOT NULL,
        vwap_position         TEXT    NOT NULL,
        snapshots_count       INTEGER DEFAULT 0,
        positions_count       INTEGER DEFAULT 0,
        p50_sl_used           NUMERIC,
        p90_sl_used           NUMERIC,
        p99_sl_used           NUMERIC,
        max_sl_used           NUMERIC,
        recommended_sl_pct    NUMERIC,
        current_sl_too_wide   BOOLEAN DEFAULT FALSE,
        potential_saving_pct  NUMERIC,
        computed_at           TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── tp_config ────────────────────────────────────────────────
    // Per optimizer_key TP lock from ghost optimizer.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tp_config (
        optimizer_key   TEXT        PRIMARY KEY,
        symbol          TEXT        NOT NULL,
        session         TEXT        NOT NULL,
        direction       TEXT        NOT NULL,
        vwap_position   TEXT        NOT NULL DEFAULT 'unknown',
        locked_rr       NUMERIC     NOT NULL,
        locked_at       TIMESTAMPTZ DEFAULT NOW(),
        locked_ghosts   INTEGER     NOT NULL DEFAULT 0,
        prev_rr         NUMERIC,
        ev_at_lock      NUMERIC,
        ev_positive     BOOLEAN     DEFAULT FALSE
      );
    `);

    // ── trade_pnl_log ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS trade_pnl_log (
        id            SERIAL      PRIMARY KEY,
        symbol        TEXT        NOT NULL,
        session       TEXT        NOT NULL,
        direction     TEXT        NOT NULL,
        vwap_position TEXT        DEFAULT 'unknown',
        rr_achieved   NUMERIC,
        hit_tp        BOOLEAN     DEFAULT FALSE,
        pnl_eur       NUMERIC,
        logged_at     TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE trade_pnl_log ADD COLUMN IF NOT EXISTS vwap_position TEXT DEFAULT 'unknown';
    `);

    // ── daily_risk_log ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_risk_log (
        trade_date   DATE        PRIMARY KEY,
        total_pnl_eur NUMERIC    DEFAULT 0,
        ev_positive  BOOLEAN     DEFAULT FALSE,
        trades_count INTEGER     DEFAULT 0,
        risk_mult_applied NUMERIC DEFAULT 1.0,
        risk_mult_next    NUMERIC DEFAULT 1.0,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── webhook_history ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_history (
        id          SERIAL      PRIMARY KEY,
        ts          TIMESTAMPTZ DEFAULT NOW(),
        symbol      TEXT,
        direction   TEXT,
        session     TEXT,
        vwap_pos    TEXT,
        action      TEXT,
        status      TEXT,
        reason      TEXT,
        position_id TEXT,
        entry       NUMERIC,
        sl          NUMERIC,
        tp          NUMERIC,
        lots        NUMERIC,
        risk_pct    NUMERIC,
        optimizer_key TEXT
      );
    `);

    await client.query("COMMIT");
    console.log("[DB] v9.0 schema OK");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DB] initDB ROLLBACK:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ── closed_trades ──────────────────────────────────────────────
async function saveTrade(t) {
  try {
    await pool.query(`
      INSERT INTO closed_trades
        (position_id, symbol, mt5_symbol, direction, vwap_position, entry, sl, tp,
         lots, risk_pct, risk_eur, max_price, max_rr, true_max_rr, true_max_price,
         ghost_stop_reason, ghost_finalized_at, session, vwap_at_entry,
         opened_at, closed_at, sl_multiplier, realized_pnl_eur, hit_tp, close_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      ON CONFLICT (position_id) DO UPDATE SET
        true_max_rr        = EXCLUDED.true_max_rr,
        true_max_price     = EXCLUDED.true_max_price,
        ghost_stop_reason  = EXCLUDED.ghost_stop_reason,
        ghost_finalized_at = EXCLUDED.ghost_finalized_at,
        max_rr             = EXCLUDED.max_rr,
        max_price          = EXCLUDED.max_price,
        realized_pnl_eur   = EXCLUDED.realized_pnl_eur,
        hit_tp             = EXCLUDED.hit_tp,
        close_reason       = EXCLUDED.close_reason,
        sl_multiplier      = EXCLUDED.sl_multiplier
    `, [
      t.positionId   ?? null,
      t.symbol       ?? "",
      t.mt5Symbol    ?? null,
      t.direction    ?? "",
      t.vwapPosition ?? "unknown",
      t.entry        ?? 0,
      t.sl           ?? 0,
      t.tp           ?? null,
      t.lots         ?? null,
      t.riskPct      ?? null,
      t.riskEUR      ?? null,
      t.maxPrice     ?? null,
      t.maxRR        ?? null,
      t.trueMaxRR    ?? null,
      t.trueMaxPrice ?? null,
      t.ghostStopReason  ?? null,
      t.ghostFinalizedAt ?? null,
      t.session      ?? null,
      t.vwapAtEntry  ?? null,
      t.openedAt     ?? null,
      t.closedAt     ?? null,
      t.slMultiplier ?? 1.0,
      t.realizedPnlEUR ?? null,
      t.hitTP        ?? false,
      t.closeReason  ?? "manual",
    ]);
  } catch (e) { console.warn("[!] saveTrade:", e.message); }
}

async function loadAllTrades() {
  try {
    const r = await pool.query(`
      SELECT
        position_id         AS "positionId",
        symbol, mt5_symbol  AS "mt5Symbol", direction,
        vwap_position       AS "vwapPosition",
        CAST(entry          AS FLOAT) AS entry,
        CAST(sl             AS FLOAT) AS sl,
        CAST(tp             AS FLOAT) AS tp,
        CAST(lots           AS FLOAT) AS lots,
        CAST(risk_pct       AS FLOAT) AS "riskPct",
        CAST(risk_eur       AS FLOAT) AS "riskEUR",
        CAST(max_price      AS FLOAT) AS "maxPrice",
        CAST(max_rr         AS FLOAT) AS "maxRR",
        CAST(true_max_rr    AS FLOAT) AS "trueMaxRR",
        CAST(true_max_price AS FLOAT) AS "trueMaxPrice",
        ghost_stop_reason   AS "ghostStopReason",
        ghost_finalized_at  AS "ghostFinalizedAt",
        session,
        CAST(vwap_at_entry  AS FLOAT) AS "vwapAtEntry",
        opened_at           AS "openedAt",
        closed_at           AS "closedAt",
        CAST(sl_multiplier  AS FLOAT) AS "slMultiplier",
        CAST(realized_pnl_eur AS FLOAT) AS "realizedPnlEUR",
        hit_tp              AS "hitTP",
        close_reason        AS "closeReason"
      FROM closed_trades
      ORDER BY closed_at DESC
      LIMIT 5000
    `);
    return r.rows;
  } catch (e) { console.warn("[!] loadAllTrades:", e.message); return []; }
}

// ── ghost_trades ───────────────────────────────────────────────
async function saveGhostTrade(g) {
  try {
    await pool.query(`
      INSERT INTO ghost_trades
        (position_id, symbol, session, direction, vwap_position, optimizer_key,
         entry, sl, sl_pct, phantom_sl, tp_rr_used,
         max_price, max_rr_before_sl, phantom_sl_hit, stop_reason,
         time_to_sl_min, opened_at, closed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT DO NOTHING
    `, [
      g.positionId      ?? null,
      g.symbol, g.session, g.direction,
      g.vwapPosition    ?? "unknown",
      g.optimizerKey    ?? "",
      g.entry, g.sl,
      g.slPct           ?? null,
      g.phantomSL       ?? g.sl,
      g.tpRRUsed        ?? null,
      g.maxPrice        ?? null,
      g.maxRRBeforeSL   ?? null,
      g.phantomSLHit    ?? false,
      g.stopReason      ?? null,
      g.timeToSLMin     ?? null,
      g.openedAt        ?? null,
      g.closedAt        ?? null,
    ]);
  } catch (e) { console.warn("[!] saveGhostTrade:", e.message); }
}

async function loadGhostTrades(optimizerKey = null, limitRows = 200) {
  try {
    const vals = [];
    let where = "WHERE phantom_sl_hit = TRUE";
    if (optimizerKey) { vals.push(optimizerKey); where += ` AND optimizer_key = $${vals.length}`; }
    const r = await pool.query(`
      SELECT
        id, position_id AS "positionId", symbol, session, direction,
        vwap_position   AS "vwapPosition",
        optimizer_key   AS "optimizerKey",
        CAST(entry           AS FLOAT) AS entry,
        CAST(sl              AS FLOAT) AS sl,
        CAST(sl_pct          AS FLOAT) AS "slPct",
        CAST(phantom_sl      AS FLOAT) AS "phantomSL",
        CAST(tp_rr_used      AS FLOAT) AS "tpRRUsed",
        CAST(max_price       AS FLOAT) AS "maxPrice",
        CAST(max_rr_before_sl AS FLOAT) AS "maxRRBeforeSL",
        phantom_sl_hit       AS "phantomSLHit",
        stop_reason          AS "stopReason",
        time_to_sl_min       AS "timeToSLMin",
        opened_at            AS "openedAt",
        closed_at            AS "closedAt"
      FROM ghost_trades
      ${where}
      ORDER BY closed_at DESC
      LIMIT $${vals.length + 1}
    `, [...vals, limitRows]);
    return r.rows;
  } catch (e) { console.warn("[!] loadGhostTrades:", e.message); return []; }
}

async function countGhostsByKey(optimizerKey) {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) AS cnt FROM ghost_trades WHERE optimizer_key=$1 AND phantom_sl_hit=TRUE`,
      [optimizerKey]
    );
    return parseInt(r.rows[0]?.cnt ?? 0, 10);
  } catch (e) { return 0; }
}

// ── shadow_snapshots ───────────────────────────────────────────
async function saveShadowSnapshot(s) {
  try {
    await pool.query(`
      INSERT INTO shadow_snapshots
        (position_id, optimizer_key, symbol, session, direction, vwap_position,
         entry, sl, current_price, pct_sl_used)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      s.positionId, s.optimizerKey, s.symbol, s.session,
      s.direction, s.vwapPosition ?? "unknown",
      s.entry, s.sl, s.currentPrice, s.pctSlUsed,
    ]);
  } catch (e) { console.warn("[!] saveShadowSnapshot:", e.message); }
}

async function loadShadowSnapshots(optimizerKey, limit = 5000) {
  try {
    const r = await pool.query(`
      SELECT
        CAST(pct_sl_used AS FLOAT) AS "pctSlUsed",
        position_id AS "positionId",
        snapped_at  AS "snappedAt"
      FROM shadow_snapshots
      WHERE optimizer_key = $1
      ORDER BY snapped_at DESC
      LIMIT $2
    `, [optimizerKey, limit]);
    return r.rows;
  } catch (e) { return []; }
}

// ── shadow_sl_analysis ─────────────────────────────────────────
async function saveShadowAnalysis(a) {
  try {
    await pool.query(`
      INSERT INTO shadow_sl_analysis
        (optimizer_key, symbol, session, direction, vwap_position,
         snapshots_count, positions_count, p50_sl_used, p90_sl_used, p99_sl_used,
         max_sl_used, recommended_sl_pct, current_sl_too_wide, potential_saving_pct, computed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (optimizer_key) DO UPDATE SET
        snapshots_count      = EXCLUDED.snapshots_count,
        positions_count      = EXCLUDED.positions_count,
        p50_sl_used          = EXCLUDED.p50_sl_used,
        p90_sl_used          = EXCLUDED.p90_sl_used,
        p99_sl_used          = EXCLUDED.p99_sl_used,
        max_sl_used          = EXCLUDED.max_sl_used,
        recommended_sl_pct   = EXCLUDED.recommended_sl_pct,
        current_sl_too_wide  = EXCLUDED.current_sl_too_wide,
        potential_saving_pct = EXCLUDED.potential_saving_pct,
        computed_at          = NOW()
    `, [
      a.optimizerKey, a.symbol, a.session, a.direction, a.vwapPosition,
      a.snapshotsCount ?? 0, a.positionsCount ?? 0,
      a.p50 ?? null, a.p90 ?? null, a.p99 ?? null, a.maxUsed ?? null,
      a.recommendedSlPct ?? null,
      a.currentSlTooWide ?? false,
      a.potentialSavingPct ?? null,
    ]);
  } catch (e) { console.warn("[!] saveShadowAnalysis:", e.message); }
}

async function loadShadowAnalysis(optimizerKey = null) {
  try {
    const vals = [];
    let where = "";
    if (optimizerKey) { vals.push(optimizerKey); where = "WHERE optimizer_key=$1"; }
    const r = await pool.query(`
      SELECT
        optimizer_key        AS "optimizerKey",
        symbol, session, direction,
        vwap_position        AS "vwapPosition",
        snapshots_count      AS "snapshotsCount",
        positions_count      AS "positionsCount",
        CAST(p50_sl_used     AS FLOAT) AS "p50",
        CAST(p90_sl_used     AS FLOAT) AS "p90",
        CAST(p99_sl_used     AS FLOAT) AS "p99",
        CAST(max_sl_used     AS FLOAT) AS "maxUsed",
        CAST(recommended_sl_pct AS FLOAT) AS "recommendedSlPct",
        current_sl_too_wide  AS "currentSlTooWide",
        CAST(potential_saving_pct AS FLOAT) AS "potentialSavingPct",
        computed_at          AS "computedAt"
      FROM shadow_sl_analysis
      ${where}
      ORDER BY optimizer_key
    `, vals);
    return r.rows;
  } catch (e) { return []; }
}

// ── tp_config ──────────────────────────────────────────────────
async function saveTPConfig(optimizerKey, symbol, session, direction, vwapPos, lockedRR, lockedGhosts, evAtLock, prevRR) {
  try {
    await pool.query(`
      INSERT INTO tp_config
        (optimizer_key, symbol, session, direction, vwap_position, locked_rr, locked_ghosts, ev_at_lock, ev_positive, prev_rr, locked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (optimizer_key) DO UPDATE SET
        locked_rr     = EXCLUDED.locked_rr,
        locked_ghosts = EXCLUDED.locked_ghosts,
        ev_at_lock    = EXCLUDED.ev_at_lock,
        ev_positive   = EXCLUDED.ev_positive,
        prev_rr       = EXCLUDED.prev_rr,
        locked_at     = NOW()
    `, [
      optimizerKey, symbol, session, direction, vwapPos,
      lockedRR, lockedGhosts, evAtLock ?? null,
      (evAtLock ?? 0) > 0, prevRR ?? null,
    ]);
  } catch (e) { console.warn("[!] saveTPConfig:", e.message); }
}

async function loadTPConfig() {
  try {
    const r = await pool.query(`
      SELECT
        optimizer_key   AS "optimizerKey",
        symbol, session, direction,
        vwap_position   AS "vwapPosition",
        CAST(locked_rr  AS FLOAT) AS "lockedRR",
        locked_ghosts   AS "lockedGhosts",
        CAST(ev_at_lock AS FLOAT) AS "evAtLock",
        ev_positive     AS "evPositive",
        CAST(prev_rr    AS FLOAT) AS "prevRR",
        locked_at       AS "lockedAt"
      FROM tp_config
      ORDER BY optimizer_key
    `);
    const map = {};
    for (const row of r.rows) map[row.optimizerKey] = row;
    return map;
  } catch (e) { return {}; }
}

// ── trade_pnl_log ──────────────────────────────────────────────
async function savePnlLog(symbol, session, direction, vwapPos, rrAchieved, hitTP, pnlEUR) {
  try {
    await pool.query(`
      INSERT INTO trade_pnl_log (symbol, session, direction, vwap_position, rr_achieved, hit_tp, pnl_eur)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [symbol, session, direction, vwapPos ?? "unknown", rrAchieved ?? 0, hitTP ?? false, pnlEUR ?? 0]);
  } catch (e) { console.warn("[!] savePnlLog:", e.message); }
}

// ── daily_risk_log ─────────────────────────────────────────────
async function saveDailyRisk(tradeDate, totalPnlEUR, tradesCount, riskMultApplied, riskMultNext) {
  try {
    await pool.query(`
      INSERT INTO daily_risk_log (trade_date, total_pnl_eur, ev_positive, trades_count, risk_mult_applied, risk_mult_next)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (trade_date) DO UPDATE SET
        total_pnl_eur    = EXCLUDED.total_pnl_eur,
        ev_positive      = EXCLUDED.ev_positive,
        trades_count     = EXCLUDED.trades_count,
        risk_mult_applied= EXCLUDED.risk_mult_applied,
        risk_mult_next   = EXCLUDED.risk_mult_next,
        created_at       = NOW()
    `, [tradeDate, totalPnlEUR ?? 0, (totalPnlEUR ?? 0) > 0, tradesCount ?? 0, riskMultApplied ?? 1.0, riskMultNext ?? 1.0]);
  } catch (e) { console.warn("[!] saveDailyRisk:", e.message); }
}

async function loadLatestDailyRisk() {
  try {
    const r = await pool.query(`
      SELECT
        trade_date          AS "tradeDate",
        CAST(total_pnl_eur   AS FLOAT) AS "totalPnlEUR",
        trades_count         AS "tradesCount",
        CAST(risk_mult_applied AS FLOAT) AS "riskMultApplied",
        CAST(risk_mult_next    AS FLOAT) AS "riskMultNext"
      FROM daily_risk_log
      ORDER BY trade_date DESC
      LIMIT 1
    `);
    return r.rows[0] ?? null;
  } catch (e) { return null; }
}

// ── symbol_risk_config ─────────────────────────────────────────
async function upsertSymbolRisk(symbol, riskPct) {
  try {
    await pool.query(`
      INSERT INTO symbol_risk_config (symbol, risk_pct, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (symbol) DO UPDATE SET risk_pct=EXCLUDED.risk_pct, updated_at=NOW()
    `, [symbol, riskPct]);
  } catch (e) { console.warn("[!] upsertSymbolRisk:", e.message); }
}

async function loadSymbolRiskConfig() {
  try {
    const r = await pool.query(`SELECT symbol, CAST(risk_pct AS FLOAT) AS "riskPct" FROM symbol_risk_config`);
    const map = {};
    for (const row of r.rows) map[row.symbol] = row.riskPct;
    return map;
  } catch (e) { return {}; }
}

// ── webhook_history ────────────────────────────────────────────
async function logWebhook(w) {
  try {
    await pool.query(`
      INSERT INTO webhook_history
        (symbol, direction, session, vwap_pos, action, status, reason, position_id,
         entry, sl, tp, lots, risk_pct, optimizer_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      w.symbol ?? null, w.direction ?? null, w.session ?? null, w.vwapPos ?? null,
      w.action ?? null, w.status ?? null, w.reason ?? null, w.positionId ?? null,
      w.entry ?? null, w.sl ?? null, w.tp ?? null, w.lots ?? null,
      w.riskPct ?? null, w.optimizerKey ?? null,
    ]);
  } catch (e) { /* non-critical */ }
}

async function loadWebhookHistory(limit = 100) {
  try {
    const r = await pool.query(`
      SELECT * FROM webhook_history ORDER BY ts DESC LIMIT $1
    `, [limit]);
    return r.rows;
  } catch (e) { return []; }
}

// ── Shadow SL analysis for WINNING trades only ─────────────────
// Joins shadow_snapshots (max pct_sl_used per position) with
// closed_trades (hit_tp=TRUE) to show how much SL room was used
// on trades that actually won — excludes SL-hit trades entirely.
async function loadShadowWinners() {
  try {
    const r = await pool.query(`
      SELECT
        mae.optimizer_key        AS "optimizerKey",
        COUNT(DISTINCT mae.position_id) AS "winnerCount",
        CAST(AVG(mae.max_pct)    AS FLOAT) AS "avgMaxSlUsed",
        CAST(PERCENTILE_CONT(0.50) WITHIN GROUP(ORDER BY mae.max_pct) AS FLOAT) AS "p50",
        CAST(PERCENTILE_CONT(0.90) WITHIN GROUP(ORDER BY mae.max_pct) AS FLOAT) AS "p90"
      FROM (
        SELECT position_id, optimizer_key,
               MAX(CAST(pct_sl_used AS FLOAT)) AS max_pct
        FROM shadow_snapshots
        GROUP BY position_id, optimizer_key
      ) mae
      JOIN closed_trades ct ON mae.position_id = ct.position_id
      WHERE ct.hit_tp = TRUE
      GROUP BY mae.optimizer_key
    `);
    const map = {};
    for (const row of r.rows) map[row.optimizerKey] = {
      winnerCount:    parseInt(row.winnerCount,  10),
      avgMaxSlUsed:   row.avgMaxSlUsed,
      p50:            row.p50,
      p90:            row.p90,
    };
    return map;
  } catch (e) { console.warn('[!] loadShadowWinners:', e.message); return {}; }
}

// ── EV stats computed from ghost_trades ────────────────────────
// Computes EV table for a key from ghost_trades DB directly.
// Returns { key, count, rrLevels: [{rr, winRate, ev}], bestRR, bestEV }
async function computeEVStats(optimizerKey) {
  try {
    const r = await pool.query(`
      SELECT CAST(max_rr_before_sl AS FLOAT) AS "maxRR"
      FROM ghost_trades
      WHERE optimizer_key=$1 AND phantom_sl_hit=TRUE AND max_rr_before_sl IS NOT NULL
    `, [optimizerKey]);
    const arr = r.rows.map(x => x.maxRR);
    if (arr.length < 1) return { key: optimizerKey, count: 0, rrLevels: [], bestRR: 1.0, bestEV: null };

    const levels = [];
    for (let rr = 0.5; rr <= 15.01; rr = parseFloat((rr + 0.1).toFixed(1))) {
      const wins   = arr.filter(v => v >= rr).length;
      const wr     = wins / arr.length;
      const ev     = parseFloat((wr * rr - (1 - wr)).toFixed(4));
      levels.push({ rr, winRate: parseFloat((wr * 100).toFixed(1)), ev });
    }
    const best = levels.reduce((a, b) => b.ev > a.ev ? b : a);
    return { key: optimizerKey, count: arr.length, rrLevels: levels, bestRR: best.rr, bestEV: best.ev };
  } catch (e) { return { key: optimizerKey, count: 0, rrLevels: [], bestRR: 1.0, bestEV: null }; }
}

module.exports = {
  initDB,
  // Trades
  saveTrade,
  loadAllTrades,
  // Ghost optimizer
  saveGhostTrade,
  loadGhostTrades,
  countGhostsByKey,
  // Shadow optimizer
  saveShadowSnapshot,
  loadShadowSnapshots,
  saveShadowAnalysis,
  loadShadowAnalysis,
  // TP config
  saveTPConfig,
  loadTPConfig,
  // PnL
  savePnlLog,
  // Daily risk
  saveDailyRisk,
  loadLatestDailyRisk,
  // Symbol risk
  upsertSymbolRisk,
  loadSymbolRiskConfig,
  // Webhook history
  logWebhook,
  loadWebhookHistory,
  // EV stats
  computeEVStats,
  // Shadow winners (SL% on winning trades only)
  loadShadowWinners,
};
