// ===============================================================
// db.js  v12.1  |  PRONTO-AI
//
// Changes v12.1:
//  - FIX shadow_sl_analysis: ADD COLUMN IF NOT EXISTS migrations voor
//    alle kolommen (inclusief optimizer_key) — lost
//    "column optimizer_key does not exist" op bij oude DB schemas.
//  - FIX saveShadowAnalysis(): accepteert nu beide formaten:
//    * runShadowOptimizer() output: { n, p50, p75, p90, p99, recommendation }
//    * loadShadowSnapshots() output: { snapshotsCount, positionsCount, ... }
//    Voorheen mismatch → save faalde stil, loadAllShadowAnalysis crashte.
//  - NEW loadSignalRejects(): per outcome + symbol + direction breakdown
//    van afgewezen signalen — voor het dashboard reject tabel.
//
// Changes v10.7 (eerder):
//  - spread_log tabel + saveSpreadLog, loadSpreadStats, loadSpreadLog.
//
// Changes v10.6:
//  - key_risk_mult schema uitgebreid: ev_mult + day_mult kolommen.
//  - closed_trades: ADD COLUMN exclude_from_ev BOOLEAN (Fix E).
//  - currency_exposure tabel: NEW voor Fix C budget tracking.
//
// Changes v10.5:
//  - COMPLIANCE_DATE imported from session.js (FIX 8).
//  - lot_overrides table, key_risk_mult table, fetchRealizedPnl,
//    loadAllShadowAnalysis (FIX 12), loadAllTrades LIMIT 10000.
// ===============================================================

// FIX 8: COMPLIANCE_DATE from single source of truth
const { COMPLIANCE_DATE, COMPLIANCE_DATE_MS } = require('./session');
//  - DATE GATE: computeEVStats(), countGhostsByKey() now filter
//    ghost_trades to opened_at >= '2026-04-18' only.
//    Pre-compliance trades had missing execution_price / vwap_band_pct
//    and must not pollute EV or shadow statistics.
//  - VWAP INTEGRITY: computeEVStats(), countGhostsByKey() now filter
//    vwap_position IN ('above','below') — 'unknown' keys produce
//    meaningless optimizer keys and are excluded from all EV maths.
//  - SL SHADOW — WINNING TRADES ONLY: loadShadowSnapshots() now
//    JOINs shadow_snapshots with closed_trades WHERE hit_tp = TRUE,
//    closed_at >= '2026-04-18', vwap_position IN ('above','below').
//    SL-100% (stopped-out) trades are NEVER fed into shadow percentiles.
//    Including them would make p99 always approach 100% — useless for
//    tightening SL recommendations.
//  - loadShadowWinners() adds same date + VWAP filters.
//
// Changes v10.2:
//  - saveTrade(): INSERT now includes spread_at_entry (FIX 1),
//    vwap_band_pct (FIX 2), execution_price, tv_entry, slippage
//    ON CONFLICT UPDATE also updates these 5 columns
//  - loadSignalStats(): new function for GET /signal-stats endpoint
//    returns total signals, placed count, conversion%, top reject reasons
//
// Changes v10.1:
//  - countGhostsByKey: counts only phantomSLHit=TRUE AND max_rr IS NOT NULL
//  - closed_trades: added slippage, execution_price, vwap_band_pct columns
//  - webhook_history: added latency_ms, tv_entry, execution_price columns
//  - signal_log: new table — every inbound TV signal, including rejects
//  - ghost_trades ON CONFLICT: uses position_id+optimizer_key composite
// ===============================================================

// (COMPLIANCE_DATE imported from session.js above)

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
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS execution_price NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS tv_entry       NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS slippage       NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS vwap_band_pct  NUMERIC;
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS spread_at_entry NUMERIC;
    `);

    // ── ghost_trades ─────────────────────────────────────────────
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
        max_sl_pct_used     NUMERIC     DEFAULT 0,
        opened_at           TIMESTAMPTZ,
        closed_at           TIMESTAMPTZ,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS max_sl_pct_used NUMERIC DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_key     ON ghost_trades (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_symbol  ON ghost_trades (symbol);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_closed  ON ghost_trades (closed_at);
    `);

    // ── ghost_state (persists ghost tracking across restarts) ─────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ghost_state (
        position_id       TEXT        PRIMARY KEY,
        optimizer_key     TEXT        NOT NULL,
        symbol            TEXT        NOT NULL,
        mt5_symbol        TEXT,
        session           TEXT        NOT NULL,
        direction         TEXT        NOT NULL,
        vwap_position     TEXT        DEFAULT 'unknown',
        entry             NUMERIC     NOT NULL,
        sl                NUMERIC     NOT NULL,
        sl_pct            NUMERIC,
        tp_rr_used        NUMERIC,
        max_price         NUMERIC,
        max_rr            NUMERIC     DEFAULT 0,
        max_sl_pct_used   NUMERIC     DEFAULT 0,
        opened_at         TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── shadow_snapshots ─────────────────────────────────────────
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
      -- FIX v12.1: ensure optimizer_key column exists (safety migration voor oude DB)
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS optimizer_key TEXT;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS symbol        TEXT;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS session       TEXT;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS direction     TEXT;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS vwap_position TEXT;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS snapshots_count     INTEGER DEFAULT 0;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS positions_count     INTEGER DEFAULT 0;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS p50_sl_used         NUMERIC;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS p90_sl_used         NUMERIC;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS p99_sl_used         NUMERIC;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS max_sl_used         NUMERIC;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS recommended_sl_pct  NUMERIC;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS current_sl_too_wide BOOLEAN DEFAULT FALSE;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS potential_saving_pct NUMERIC;
      ALTER TABLE shadow_sl_analysis ADD COLUMN IF NOT EXISTS computed_at         TIMESTAMPTZ DEFAULT NOW();
    `);

    // ── tp_config ────────────────────────────────────────────────
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
        id            SERIAL      PRIMARY KEY,
        ts            TIMESTAMPTZ DEFAULT NOW(),
        symbol        TEXT,
        direction     TEXT,
        session       TEXT,
        vwap_pos      TEXT,
        action        TEXT,
        status        TEXT,
        reason        TEXT,
        position_id   TEXT,
        entry         NUMERIC,
        sl            NUMERIC,
        tp            NUMERIC,
        lots          NUMERIC,
        risk_pct      NUMERIC,
        optimizer_key TEXT
      );
      ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS latency_ms       INTEGER;
      ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS tv_entry         NUMERIC;
      ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS execution_price  NUMERIC;
      ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS slippage         NUMERIC;
      ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS vwap_band_pct    NUMERIC;
    `);

    // ── signal_log ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS signal_log (
        id              SERIAL      PRIMARY KEY,
        received_at     TIMESTAMPTZ DEFAULT NOW(),
        symbol          TEXT,
        direction       TEXT,
        session         TEXT,
        vwap_position   TEXT,
        optimizer_key   TEXT,
        tv_entry        NUMERIC,
        sl_pct          NUMERIC,
        sl_pct_human    TEXT,
        vwap            NUMERIC,
        vwap_upper      NUMERIC,
        vwap_lower      NUMERIC,
        vwap_band_pct   NUMERIC,
        outcome         TEXT,
        reject_reason   TEXT,
        latency_ms      INTEGER,
        position_id     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signal_log_ts     ON signal_log (received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_log_sym    ON signal_log (symbol);
      CREATE INDEX IF NOT EXISTS idx_signal_log_key    ON signal_log (optimizer_key);
    `);

    // ── vwap_band_ghost — ghost data for signals rejected by VWAP band exhaustion ──
    // Separate from main ghost_trades. Tracks what would have happened if we took
    // the trade at 150–250% and 250–350% VWAP band exhaustion.
    // NEVER merged into main EV / TP optimizer tables.
    await client.query(`
      CREATE TABLE IF NOT EXISTS vwap_band_ghost (
        id              SERIAL      PRIMARY KEY,
        signal_id       INTEGER,               -- fk to signal_log.id if available
        optimizer_key   TEXT        NOT NULL,
        symbol          TEXT        NOT NULL,
        session         TEXT        NOT NULL,
        direction       TEXT        NOT NULL,
        vwap_position   TEXT        DEFAULT 'unknown',
        band_tier       TEXT        NOT NULL,  -- '150_250' or '250_350'
        band_pct        NUMERIC,               -- actual band% at signal time
        entry           NUMERIC     NOT NULL,
        sl              NUMERIC,
        sl_pct          NUMERIC,
        max_price       NUMERIC,
        max_rr          NUMERIC     DEFAULT 0,
        max_sl_pct_used NUMERIC     DEFAULT 0,
        phantom_sl_hit  BOOLEAN     DEFAULT FALSE,
        stop_reason     TEXT,
        time_to_sl_min  INTEGER,
        opened_at       TIMESTAMPTZ,
        closed_at       TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_vwap_band_ghost_key  ON vwap_band_ghost (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_vwap_band_ghost_tier ON vwap_band_ghost (band_tier);
      CREATE INDEX IF NOT EXISTS idx_vwap_band_ghost_sym  ON vwap_band_ghost (symbol);
    `);

    // ── lot_overrides (FIX 2: persistent lot overrides) ─────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lot_overrides (
        symbol      TEXT        PRIMARY KEY,
        base_lots   NUMERIC     NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── key_risk_mult (FIX 19 + v10.6: ev_mult + day_mult separate) ─
    await client.query(`
      CREATE TABLE IF NOT EXISTS key_risk_mult (
        optimizer_key TEXT        PRIMARY KEY,
        streak        INTEGER     NOT NULL DEFAULT 0,
        mult          NUMERIC     NOT NULL DEFAULT 1.0,
        ev_mult       NUMERIC     NOT NULL DEFAULT 1.0,
        day_mult      NUMERIC     NOT NULL DEFAULT 1.0,
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE key_risk_mult ADD COLUMN IF NOT EXISTS ev_mult  NUMERIC NOT NULL DEFAULT 1.0;
      ALTER TABLE key_risk_mult ADD COLUMN IF NOT EXISTS day_mult NUMERIC NOT NULL DEFAULT 1.0;
    `);

    // ── closed_trades: exclude_from_ev (Fix E: RR_VERIFY_FAILED) ────
    await client.query(`
      ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS exclude_from_ev BOOLEAN DEFAULT FALSE;
    `);

    // ── currency_exposure (Fix C: per-currency budget tracking) ─────
    await client.query(`
      CREATE TABLE IF NOT EXISTS currency_exposure (
        currency    TEXT        PRIMARY KEY,
        exposure_eur NUMERIC    NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── spread_log (v10.7: bid/ask spread per symbool + tijdstip) ───
    // Slaat spread op bij elke order voor latere tijdzone analyse.
    // Kolommen: symbol, mt5_symbol, session, hour_brussels, bid, ask,
    //           spread_abs (ask-bid), spread_pct ((ask-bid)/bid),
    //           asset_type, logged_at.
    await client.query(`
      CREATE TABLE IF NOT EXISTS spread_log (
        id            SERIAL      PRIMARY KEY,
        symbol        TEXT        NOT NULL,
        mt5_symbol    TEXT,
        session       TEXT        NOT NULL,
        hour_brussels INTEGER     NOT NULL,
        minute_brussels INTEGER   NOT NULL,
        day_of_week   INTEGER     NOT NULL,
        bid           NUMERIC,
        ask           NUMERIC,
        spread_abs    NUMERIC,
        spread_pct    NUMERIC,
        asset_type    TEXT,
        position_id   TEXT,
        logged_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_spread_log_sym     ON spread_log (symbol, logged_at DESC);
      CREATE INDEX IF NOT EXISTS idx_spread_log_session ON spread_log (session, hour_brussels);
      CREATE INDEX IF NOT EXISTS idx_spread_log_ts      ON spread_log (logged_at DESC);
    `);

    await client.query("COMMIT");
    console.log("[DB] v10.7 schema OK");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DB] initDB ROLLBACK:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ── closed_trades ──────────────────────────────────────────────
// FIX 1 + FIX 2: INSERT now includes spread_at_entry, vwap_band_pct,
// execution_price, tv_entry, slippage — all were missing despite
// columns existing in the schema.
async function saveTrade(t) {
  try {
    await pool.query(`
      INSERT INTO closed_trades
        (position_id, symbol, mt5_symbol, direction, vwap_position, entry, sl, tp,
         lots, risk_pct, risk_eur, max_price, max_rr, true_max_rr, true_max_price,
         ghost_stop_reason, ghost_finalized_at, session, vwap_at_entry,
         opened_at, closed_at, sl_multiplier, realized_pnl_eur, hit_tp, close_reason,
         spread_at_entry, vwap_band_pct, execution_price, tv_entry, slippage,
         exclude_from_ev)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
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
        sl_multiplier      = EXCLUDED.sl_multiplier,
        spread_at_entry    = EXCLUDED.spread_at_entry,
        vwap_band_pct      = EXCLUDED.vwap_band_pct,
        execution_price    = EXCLUDED.execution_price,
        tv_entry           = EXCLUDED.tv_entry,
        slippage           = EXCLUDED.slippage,
        exclude_from_ev    = EXCLUDED.exclude_from_ev
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
      t.spreadAtEntry  ?? null,
      t.vwapBandPct    ?? null,
      t.executionPrice ?? null,
      t.tvEntry        ?? null,
      t.slippage       ?? null,
      t.excludeFromEV  ?? false,  // Fix E: RR_VERIFY_FAILED trades
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
        close_reason        AS "closeReason",
        CAST(spread_at_entry AS FLOAT) AS "spreadAtEntry",
        CAST(vwap_band_pct  AS FLOAT) AS "vwapBandPct",
        CAST(execution_price AS FLOAT) AS "executionPrice",
        CAST(tv_entry       AS FLOAT) AS "tvEntry",
        CAST(slippage       AS FLOAT) AS slippage
      FROM closed_trades
      ORDER BY closed_at DESC
      LIMIT 10000
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
         time_to_sl_min, max_sl_pct_used, opened_at, closed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
      g.maxSlPctUsed    ?? 0,
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
        CAST(max_sl_pct_used AS FLOAT) AS "maxSlPctUsed",
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
      // DATA QUALITY: only count ghosts from 18/04/2026 onward with valid VWAP.
      // Pre-compliance rows had missing execution_price and vwap_band_pct.
      // 'unknown' vwap_position produces meaningless optimizer keys.
      `SELECT COUNT(*) AS cnt FROM ghost_trades
       WHERE optimizer_key=$1
         AND phantom_sl_hit=TRUE
         AND max_rr_before_sl IS NOT NULL
         AND opened_at >= $2
         AND vwap_position IN ('above','below')`,
      [optimizerKey, COMPLIANCE_DATE]
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
    // DATA QUALITY — three hard rules applied here:
    //
    // Rule 1 (Date Gate):   only snapshots from positions closed on or after 18/04/2026.
    //                       Earlier positions had unreliable vwap_band_pct / execution_price.
    //
    // Rule 2 (VWAP):        only positions with vwap_position IN ('above','below').
    //                       'unknown' keys have no VWAP context and must not skew percentiles.
    //
    // Rule 3 (Winning only): CRITICAL — only JOIN positions where hit_tp = TRUE.
    //                        Stopped-out positions (close_reason = 'sl') are EXCLUDED.
    //                        Including them would push p99 toward ~100% which is useless
    //                        for recommending a tighter stop-loss.
    //                        The correct question is: "how far toward SL did winners go?"
    const r = await pool.query(`
      SELECT
        CAST(ss.pct_sl_used AS FLOAT) AS "pctSlUsed",
        ss.position_id AS "positionId",
        ss.snapped_at  AS "snappedAt"
      FROM shadow_snapshots ss
      JOIN closed_trades ct ON ss.position_id = ct.position_id
      WHERE ss.optimizer_key = $1
        AND ct.hit_tp = TRUE
        AND ct.close_reason = 'tp'
        AND ct.closed_at   >= $3
        AND ct.vwap_position IN ('above','below')
      ORDER BY ss.snapped_at DESC
      LIMIT $2
    `, [optimizerKey, limit, COMPLIANCE_DATE]);
    return r.rows;
  } catch (e) { return []; }
}

// ── shadow_sl_analysis ─────────────────────────────────────────
async function saveShadowAnalysis(a) {
  // FIX v12.1: runShadowOptimizer stuurt { optimizerKey, n, p50, p75, p90, p99, maxUsed,
  //   recommendation: { reduceTo, saving, newEV, newWR } }.
  // Oude call-site (loadShadowSnapshots) stuurt { snapshotsCount, positionsCount }.
  // Beide formaten worden hier afgehandeld.
  try {
    const recPct = a.recommendation?.reduceTo ?? a.recommendedSlPct ?? null;
    const saving  = a.recommendation?.saving   ?? a.potentialSavingPct ?? null;
    const tooWide = recPct != null && recPct < 100;
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
      a.optimizerKey,
      a.symbol   ?? (a.optimizerKey?.split('_')[0] ?? null),
      a.session  ?? (a.optimizerKey?.split('_')[1] ?? null),
      a.direction ?? (a.optimizerKey?.split('_')[2] ?? null),
      a.vwapPosition ?? (a.optimizerKey?.split('_')[3] ?? 'unknown'),
      a.snapshotsCount ?? a.n ?? 0,
      a.positionsCount ?? a.n ?? 0,
      a.p50 ?? null,
      a.p90 ?? null,
      a.p99 ?? null,
      a.maxUsed ?? null,
      recPct,
      a.currentSlTooWide ?? tooWide,
      saving,
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
         entry, sl, tp, lots, risk_pct, optimizer_key,
         latency_ms, tv_entry, execution_price, slippage, vwap_band_pct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    `, [
      w.symbol        ?? null, w.direction    ?? null, w.session    ?? null, w.vwapPos      ?? null,
      w.action        ?? null, w.status       ?? null, w.reason     ?? null, w.positionId   ?? null,
      w.entry         ?? null, w.sl           ?? null, w.tp         ?? null, w.lots         ?? null,
      w.riskPct       ?? null, w.optimizerKey ?? null,
      w.latencyMs     ?? null, w.tvEntry      ?? null, w.executionPrice ?? null,
      w.slippage      ?? null, w.vwapBandPct  ?? null,
    ]);
  } catch (e) { /* non-critical */ }
}

// ── signal_log ─────────────────────────────────────────────────
async function logSignal(s) {
  try {
    await pool.query(`
      INSERT INTO signal_log
        (symbol, direction, session, vwap_position, optimizer_key,
         tv_entry, sl_pct, sl_pct_human, vwap, vwap_upper, vwap_lower,
         vwap_band_pct, outcome, reject_reason, latency_ms, position_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [
      s.symbol         ?? null, s.direction    ?? null, s.session      ?? null,
      s.vwapPosition   ?? null, s.optimizerKey ?? null,
      s.tvEntry        ?? null, s.slPct        ?? null, s.slPctHuman   ?? null,
      s.vwap           ?? null, s.vwapUpper    ?? null, s.vwapLower    ?? null,
      s.vwapBandPct    ?? null, s.outcome      ?? null, s.rejectReason ?? null,
      s.latencyMs      ?? null, s.positionId   ?? null,
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

// ── Signal stats — FIX 7 ───────────────────────────────────────
// Computes signal conversion ratio from signal_log table.
// Returns: total, placed, conversionPct, byOutcome, topRejectReasons
async function loadSignalStats() {
  try {
    const [totalR, byOutcomeR, rejectR, rejectSymR] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM signal_log`),
      pool.query(`
        SELECT outcome, COUNT(*) AS cnt
        FROM signal_log
        GROUP BY outcome
        ORDER BY cnt DESC
      `),
      pool.query(`
        SELECT reject_reason, COUNT(*) AS cnt
        FROM signal_log
        WHERE reject_reason IS NOT NULL AND reject_reason != ''
        GROUP BY reject_reason
        ORDER BY cnt DESC
        LIMIT 20
      `),
      // Per reject_reason: welke symbols en hoe vaak
      pool.query(`
        SELECT reject_reason,
               symbol,
               direction,
               COUNT(*) AS cnt
        FROM signal_log
        WHERE reject_reason IS NOT NULL AND reject_reason != ''
          AND symbol IS NOT NULL
        GROUP BY reject_reason, symbol, direction
        ORDER BY reject_reason, cnt DESC
      `),
    ]);
    const totalN  = parseInt(totalR.rows[0]?.cnt ?? 0, 10);
    const placed  = byOutcomeR.rows.find(r => r.outcome === "PLACED");
    const placedN = parseInt(placed?.cnt ?? 0, 10);

    // Bouw per reject_reason een gesorteerde lijst van pairs op
    const symsByReason = {};
    for (const row of rejectSymR.rows) {
      const r = row.reject_reason;
      if (!symsByReason[r]) symsByReason[r] = [];
      symsByReason[r].push({ symbol: row.symbol, direction: row.direction, count: parseInt(row.cnt, 10) });
    }

    return {
      total:            totalN,
      placed:           placedN,
      conversionPct:    totalN > 0 ? parseFloat((placedN / totalN * 100).toFixed(2)) : 0,
      byOutcome:        byOutcomeR.rows.map(r => ({ outcome: r.outcome, count: parseInt(r.cnt, 10) })),
      topRejectReasons: rejectR.rows.map(r => ({
        reason: r.reject_reason,
        count:  parseInt(r.cnt, 10),
        // Top 5 pairs voor deze reason, gesorteerd op count
        pairs:  (symsByReason[r.reject_reason] ?? []).slice(0, 5),
      })),
    };
  } catch (e) { console.warn("[!] loadSignalStats:", e.message); return null; }
}

// ── Shadow SL analysis for WINNING trades only ─────────────────
// DATA QUALITY: Only counts winning positions from 18/04/2026 onward
// with valid VWAP context. SL-100% (stopped-out) trades are never
// included here — the JOIN with ct.hit_tp=TRUE handles that.
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
        AND ct.close_reason = 'tp'
        AND ct.closed_at   >= $1
        AND ct.vwap_position IN ('above','below')
      GROUP BY mae.optimizer_key
    `, [COMPLIANCE_DATE]);
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
// DATA QUALITY: Only ghost trades from 18/04/2026 onward with valid
// VWAP context (not 'unknown') are included in EV calculations.
// v10.6: Fix E — trades met exclude_from_ev=TRUE worden uitgesloten
// via LEFT JOIN op closed_trades.
async function computeEVStats(optimizerKey) {
  try {
    const r = await pool.query(`
      SELECT
        CAST(g.max_rr_before_sl AS FLOAT)  AS "maxRR",
        g.time_to_sl_min                   AS "timeToSL",
        CAST(g.max_sl_pct_used  AS FLOAT)  AS "maxSlPct"
      FROM ghost_trades g
      LEFT JOIN closed_trades ct ON ct.position_id = g.position_id
      WHERE g.optimizer_key=$1
        AND g.phantom_sl_hit=TRUE
        AND g.max_rr_before_sl IS NOT NULL
        AND g.max_rr_before_sl >= 0.5
        AND g.opened_at >= $2
        AND g.vwap_position IN ('above','below')
        AND (ct.exclude_from_ev IS NULL OR ct.exclude_from_ev = FALSE)
    `, [optimizerKey, COMPLIANCE_DATE]);

    // Filter 0.00R ghosts — went straight to SL, no movement
    // Filter < 0.5R ghosts — can never hit any realistic TP level, only inflate loss count
    const rows = r.rows.filter(x => (x.maxRR ?? 0) >= 0.5);
    if (rows.length < 1) return { key: optimizerKey, count: 0, rrLevels: [], bestRR: null, bestEV: null, avgRR: null, avgTimeToSLMin: null, avgMaxSlPct: null, bestWinnerSlPct: null };

    const arr      = rows.map(x => x.maxRR);
    const timings  = rows.map(x => x.timeToSL).filter(v => v != null);
    const slPcts   = rows.map(x => x.maxSlPct).filter(v => v != null);
    const avgTimeToSLMin = timings.length  ? Math.round(timings.reduce((s,v)=>s+v,0)/timings.length)   : null;
    const avgMaxSlPct    = slPcts.length   ? parseFloat((slPcts.reduce((s,v)=>s+v,0)/slPcts.length).toFixed(1)) : null;
    const avgRR          = arr.length      ? parseFloat((arr.reduce((s,v)=>s+v,0)/arr.length).toFixed(3)) : null;

    const levels = [];
    for (let rr = 0.5; rr <= 15.01; rr = parseFloat((rr + 0.1).toFixed(1))) {
      const wins = arr.filter(v => v >= rr).length;
      const wr   = wins / arr.length;
      const ev   = parseFloat((wr * rr - (1 - wr)).toFixed(4));
      levels.push({ rr, winRate: parseFloat((wr * 100).toFixed(1)), ev });
    }
    const best = levels.reduce((a, b) => b.ev > a.ev ? b : a);

    // bestWinnerSlPct: avg SL% used only from ghosts that would have hit TP at bestRR
    // These are "winning" ghosts — their SL% tells you how much SL you actually needed
    const winnerRows = rows.filter(x => x.maxRR >= best.rr);
    const wSlPcts    = winnerRows.map(x => x.maxSlPct).filter(v => v != null);
    const bestWinnerSlPct = wSlPcts.length ? parseFloat((wSlPcts.reduce((s,v)=>s+v,0)/wSlPcts.length).toFixed(1)) : null;

    return { key: optimizerKey, count: arr.length, rrLevels: levels, bestRR: best.rr, bestEV: best.ev, avgRR, avgTimeToSLMin, avgMaxSlPct, bestWinnerSlPct };
  } catch (e) { return { key: optimizerKey, count: 0, rrLevels: [], bestRR: null, bestEV: null, avgRR: null, avgTimeToSLMin: null, avgMaxSlPct: null, bestWinnerSlPct: null }; }
}

// ── lot_overrides (FIX 2) ──────────────────────────────────────
async function saveLotOverride(symbol, baseLots) {
  try {
    await pool.query(`
      INSERT INTO lot_overrides (symbol, base_lots, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (symbol) DO UPDATE SET base_lots=$2, updated_at=NOW()
    `, [symbol, baseLots]);
  } catch (e) { console.warn('[!] saveLotOverride:', e.message); }
}

async function loadLotOverrides() {
  try {
    const r = await pool.query(`SELECT symbol, CAST(base_lots AS FLOAT) AS base_lots FROM lot_overrides`);
    const map = {};
    for (const row of r.rows) map[row.symbol] = row.base_lots;
    return map;
  } catch (e) { console.warn('[!] loadLotOverrides:', e.message); return {}; }
}

// ── key_risk_mult (FIX 19 + v10.6: ev_mult + day_mult) ────────
// v10.6: streak, evMult en dayMult worden apart opgeslagen.
// mult kolom is deprecated maar blijft voor backwards compat.
async function saveKeyRiskMult(optimizerKey, { streak, evMult, dayMult }) {
  try {
    const em = evMult  ?? 1.0;
    const dm = dayMult ?? 1.0;
    await pool.query(`
      INSERT INTO key_risk_mult (optimizer_key, streak, mult, ev_mult, day_mult, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (optimizer_key) DO UPDATE
        SET streak=$2, mult=$3, ev_mult=$4, day_mult=$5, updated_at=NOW()
    `, [optimizerKey, streak, em, em, dm]);
  } catch (e) { console.warn('[!] saveKeyRiskMult:', e.message); }
}

async function loadKeyRiskMults() {
  try {
    const r = await pool.query(`
      SELECT optimizer_key,
             streak,
             CAST(ev_mult  AS FLOAT) AS ev_mult,
             CAST(day_mult AS FLOAT) AS day_mult
      FROM key_risk_mult
    `);
    const map = {};
    for (const row of r.rows) map[row.optimizer_key] = {
      streak:  row.streak,
      evMult:  row.ev_mult  ?? 1.0,
      dayMult: row.day_mult ?? 1.0,
    };
    return map;
  } catch (e) { console.warn('[!] loadKeyRiskMults:', e.message); return {}; }
}

// ── spread_log (v10.7) ─────────────────────────────────────────
// Slaat spread op bij elke order — later filteren op tijdzone/sessie.
async function saveSpreadLog({ symbol, mt5Symbol, session, hourBrussels, minuteBrussels,
  dayOfWeek, bid, ask, spreadAbs, spreadPct, assetType, positionId }) {
  try {
    await pool.query(`
      INSERT INTO spread_log
        (symbol, mt5_symbol, session, hour_brussels, minute_brussels, day_of_week,
         bid, ask, spread_abs, spread_pct, asset_type, position_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      symbol, mt5Symbol ?? null, session, hourBrussels, minuteBrussels,
      dayOfWeek, bid ?? null, ask ?? null,
      spreadAbs ?? null, spreadPct ?? null,
      assetType ?? null, positionId ?? null,
    ]);
  } catch (e) { console.warn('[!] saveSpreadLog:', e.message); }
}

// Laad spread statistieken: gemiddeld, p50, p90, p99 per symbool + sessie + uur.
// Optioneel filteren op symbol, session, hour_brussels range, day_of_week.
async function loadSpreadStats({ symbol, session, hourMin, hourMax, dayOfWeek } = {}) {
  try {
    const conds = [];
    const vals  = [];
    if (symbol)    { vals.push(symbol);    conds.push(`symbol = $${vals.length}`); }
    if (session)   { vals.push(session);   conds.push(`session = $${vals.length}`); }
    if (dayOfWeek != null) { vals.push(dayOfWeek); conds.push(`day_of_week = $${vals.length}`); }
    if (hourMin != null)   { vals.push(hourMin);   conds.push(`hour_brussels >= $${vals.length}`); }
    if (hourMax != null)   { vals.push(hourMax);   conds.push(`hour_brussels <= $${vals.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`
      SELECT
        symbol,
        session,
        hour_brussels,
        day_of_week,
        COUNT(*)                                                           AS samples,
        CAST(AVG(spread_abs)    AS FLOAT)                                  AS avg_spread_abs,
        CAST(AVG(spread_pct)    AS FLOAT)                                  AS avg_spread_pct,
        CAST(PERCENTILE_CONT(0.50) WITHIN GROUP(ORDER BY spread_abs) AS FLOAT) AS p50_spread,
        CAST(PERCENTILE_CONT(0.90) WITHIN GROUP(ORDER BY spread_abs) AS FLOAT) AS p90_spread,
        CAST(PERCENTILE_CONT(0.99) WITHIN GROUP(ORDER BY spread_abs) AS FLOAT) AS p99_spread,
        CAST(MAX(spread_abs)    AS FLOAT)                                  AS max_spread,
        CAST(MIN(bid)           AS FLOAT)                                  AS min_bid,
        CAST(MAX(ask)           AS FLOAT)                                  AS max_ask
      FROM spread_log
      ${where}
      GROUP BY symbol, session, hour_brussels, day_of_week
      ORDER BY symbol, session, hour_brussels
    `, vals);
    return r.rows;
  } catch (e) { console.warn('[!] loadSpreadStats:', e.message); return []; }
}

// Laad ruwe spread log rijen — voor detail analyse.
async function loadSpreadLog({ symbol, session, limit = 500 } = {}) {
  try {
    const conds = [], vals = [];
    if (symbol)  { vals.push(symbol);  conds.push(`symbol = $${vals.length}`); }
    if (session) { vals.push(session); conds.push(`session = $${vals.length}`); }
    vals.push(limit);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`
      SELECT id, symbol, mt5_symbol, session, hour_brussels, minute_brussels,
             day_of_week, bid, ask,
             CAST(spread_abs AS FLOAT) AS spread_abs,
             CAST(spread_pct AS FLOAT) AS spread_pct,
             asset_type, position_id,
             logged_at
      FROM spread_log ${where}
      ORDER BY logged_at DESC LIMIT $${vals.length}
    `, vals);
    return r.rows;
  } catch (e) { console.warn('[!] loadSpreadLog:', e.message); return []; }
}
// Tries to get the actual realized P&L for a closed position from
// the MetaApi deals history. Falls back to null if not available.
// Note: this queries the deals table if it exists in the DB schema.
// In practice the caller catches errors and falls back to currentPnL.
async function fetchRealizedPnl(positionId) {
  try {
    const r = await pool.query(`
      SELECT SUM(CAST(profit AS FLOAT)) AS realized_pnl
      FROM deals
      WHERE position_id = $1
    `, [positionId]);
    const val = r.rows[0]?.realized_pnl;
    return val != null ? parseFloat(val) : null;
  } catch {
    // deals table may not exist — non-critical, return null
    return null;
  }
}

// ── loadAllShadowAnalysis (FIX 12: load all keys at startup) ───
async function loadAllShadowAnalysis() {
  try {
    const r = await pool.query(`SELECT * FROM shadow_sl_analysis ORDER BY optimizer_key`);
    return r.rows.map(row => ({
      optimizerKey:        row.optimizer_key,
      symbol:              row.symbol,
      session:             row.session,
      direction:           row.direction,
      vwapPosition:        row.vwap_position,
      snapshotsCount:      row.snapshots_count,
      positionsCount:      row.positions_count,
      n:                   row.snapshots_count ?? 0,  // alias voor ready check
      ready:               (row.snapshots_count ?? 0) >= 30,  // v12.1.1: consistent met runShadowOptimizer
      p50:                 row.p50_sl_used   != null ? parseFloat(row.p50_sl_used)  : null,
      p90:                 row.p90_sl_used   != null ? parseFloat(row.p90_sl_used)  : null,
      p99:                 row.p99_sl_used   != null ? parseFloat(row.p99_sl_used)  : null,
      maxUsed:             row.max_sl_used   != null ? parseFloat(row.max_sl_used)  : null,
      recommendedSlPct:    row.recommended_sl_pct != null ? parseFloat(row.recommended_sl_pct) : null,
      currentSlTooWide:    row.current_sl_too_wide,
      potentialSavingPct:  row.potential_saving_pct != null ? parseFloat(row.potential_saving_pct) : null,
    }));
  } catch (e) { console.warn('[!] loadAllShadowAnalysis:', e.message); return []; }
}

// ── ghost_state (restart persistence) ─────────────────────────
async function saveGhostState(g) {
  try {
    await pool.query(`
      INSERT INTO ghost_state
        (position_id, optimizer_key, symbol, mt5_symbol, session, direction,
         vwap_position, entry, sl, sl_pct, tp_rr_used,
         max_price, max_rr, max_sl_pct_used, opened_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (position_id) DO UPDATE SET
        max_price       = EXCLUDED.max_price,
        max_rr          = EXCLUDED.max_rr,
        max_sl_pct_used = EXCLUDED.max_sl_pct_used,
        updated_at      = NOW()
    `, [
      g.positionId, g.optimizerKey, g.symbol, g.mt5Symbol ?? g.symbol,
      g.session, g.direction, g.vwapPosition ?? 'unknown',
      g.entry, g.sl, g.slPct ?? null, g.tpRRUsed ?? null,
      g.maxPrice ?? g.entry, g.maxRR ?? 0, g.maxSlPctUsed ?? 0,
      g.openedAt ?? null,
    ]);
  } catch (e) { console.warn('[!] saveGhostState:', e.message); }
}

async function loadAllGhostStates() {
  try {
    const r = await pool.query(`
      SELECT
        position_id       AS "positionId",
        optimizer_key     AS "optimizerKey",
        symbol, mt5_symbol AS "mt5Symbol",
        session, direction,
        vwap_position     AS "vwapPosition",
        CAST(entry            AS FLOAT) AS entry,
        CAST(sl               AS FLOAT) AS sl,
        CAST(sl_pct           AS FLOAT) AS "slPct",
        CAST(tp_rr_used       AS FLOAT) AS "tpRRUsed",
        CAST(max_price        AS FLOAT) AS "maxPrice",
        CAST(max_rr           AS FLOAT) AS "maxRR",
        CAST(max_sl_pct_used  AS FLOAT) AS "maxSlPctUsed",
        opened_at             AS "openedAt"
      FROM ghost_state
    `);
    return r.rows;
  } catch (e) { console.warn('[!] loadAllGhostStates:', e.message); return []; }
}

async function deleteGhostState(positionId) {
  try {
    await pool.query('DELETE FROM ghost_state WHERE position_id=$1', [positionId]);
  } catch (e) { console.warn('[!] deleteGhostState:', e.message); }
}

// ── vwap_band_ghost ─────────────────────────────────────────────
// Ghost 2.0: tracks what would have happened for VWAP-exhausted signals
async function saveBandGhost(g) {
  try {
    await pool.query(`
      INSERT INTO vwap_band_ghost
        (signal_id, optimizer_key, symbol, session, direction, vwap_position,
         band_tier, band_pct, entry, sl, sl_pct,
         max_price, max_rr, max_sl_pct_used, phantom_sl_hit, stop_reason,
         time_to_sl_min, opened_at, closed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT DO NOTHING
    `, [
      g.signalId ?? null,
      g.optimizerKey, g.symbol, g.session, g.direction,
      g.vwapPosition ?? "unknown",
      g.bandTier,       // '150_250' or '250_350'
      g.bandPct ?? null,
      g.entry, g.sl ?? null, g.slPct ?? null,
      g.maxPrice ?? null, g.maxRR ?? 0, g.maxSlPctUsed ?? 0,
      g.phantomSLHit ?? false, g.stopReason ?? null,
      g.timeToSLMin ?? null,
      g.openedAt ?? null, g.closedAt ?? null,
    ]);
  } catch (e) { console.warn("[!] saveBandGhost:", e.message); }
}

async function loadBandGhosts({ bandTier, symbol, optimizerKey, limit = 500 } = {}) {
  try {
    const conds = [], vals = [];
    if (bandTier)      { conds.push(`band_tier=$${vals.length+1}`);      vals.push(bandTier); }
    if (symbol)        { conds.push(`symbol=$${vals.length+1}`);         vals.push(symbol); }
    if (optimizerKey)  { conds.push(`optimizer_key=$${vals.length+1}`);  vals.push(optimizerKey); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const r = await pool.query(`
      SELECT
        id, signal_id AS "signalId", optimizer_key AS "optimizerKey",
        symbol, session, direction, vwap_position AS "vwapPosition",
        band_tier AS "bandTier", CAST(band_pct AS FLOAT) AS "bandPct",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl,
        CAST(sl_pct AS FLOAT) AS "slPct",
        CAST(max_price AS FLOAT) AS "maxPrice",
        CAST(max_rr AS FLOAT) AS "maxRR",
        CAST(max_sl_pct_used AS FLOAT) AS "maxSlPctUsed",
        phantom_sl_hit AS "phantomSLHit", stop_reason AS "stopReason",
        time_to_sl_min AS "timeToSLMin",
        opened_at AS "openedAt", closed_at AS "closedAt"
      FROM vwap_band_ghost
      ${where}
      ORDER BY opened_at DESC
      LIMIT $${vals.length+1}
    `, [...vals, limit]);
    return r.rows;
  } catch (e) { console.warn("[!] loadBandGhosts:", e.message); return []; }
}

async function loadBandGhostStats(bandTier) {
  try {
    const r = await pool.query(`
      SELECT
        optimizer_key AS "optimizerKey", symbol, session, direction,
        vwap_position AS "vwapPosition",
        band_tier AS "bandTier",
        COUNT(*)                                                   AS n,
        COUNT(*) FILTER (WHERE phantom_sl_hit)                     AS "nSLHit",
        AVG(max_rr) FILTER (WHERE phantom_sl_hit AND max_rr > 0)   AS "avgMaxRR",
        MAX(max_rr)                                                AS "maxMaxRR",
        AVG(max_sl_pct_used)                                       AS "avgSlPct",
        AVG(time_to_sl_min) FILTER (WHERE time_to_sl_min IS NOT NULL) AS "avgTimeMin"
      FROM vwap_band_ghost
      WHERE band_tier = $1
      GROUP BY optimizer_key, symbol, session, direction, vwap_position, band_tier
      ORDER BY "avgMaxRR" DESC NULLS LAST
    `, [bandTier]);
    return r.rows.map(row => ({
      ...row,
      n: parseInt(row.n),
      nSLHit: parseInt(row.nSLHit),
      avgMaxRR: row.avgMaxRR != null ? parseFloat(parseFloat(row.avgMaxRR).toFixed(3)) : null,
      maxMaxRR: row.maxMaxRR != null ? parseFloat(parseFloat(row.maxMaxRR).toFixed(3)) : null,
      avgSlPct: row.avgSlPct != null ? parseFloat(parseFloat(row.avgSlPct).toFixed(1)) : null,
      avgTimeMin: row.avgTimeMin != null ? Math.round(row.avgTimeMin) : null,
    }));
  } catch (e) { console.warn("[!] loadBandGhostStats:", e.message); return []; }
}

// ── loadSignalRejects (v12.1: niet-genomen trades breakdown) ───
// Retourneert per outcome + symbol + direction het aantal afgewezen signalen
// met de meest voorkomende reject_reason. Gebruikt voor het dashboard reject tabel.
async function loadSignalRejects({ since } = {}) {
  try {
    const cutoff = since ?? COMPLIANCE_DATE;
    const r = await pool.query(`
      SELECT
        outcome,
        symbol,
        direction,
        session,
        reject_reason,
        COUNT(*)::INTEGER AS count
      FROM signal_log
      WHERE outcome NOT IN ('PLACED')
        AND received_at >= $1
      GROUP BY outcome, symbol, direction, session, reject_reason
      ORDER BY count DESC
      LIMIT 500
    `, [cutoff]);
    // Aggregeer per outcome: totaal + top pairs
    const byOutcome = {};
    for (const row of r.rows) {
      const key = row.outcome;
      if (!byOutcome[key]) byOutcome[key] = { outcome: key, total: 0, pairs: [] };
      byOutcome[key].total += row.count;
      byOutcome[key].pairs.push({
        symbol:       row.symbol,
        direction:    row.direction,
        session:      row.session,
        rejectReason: row.reject_reason,
        count:        row.count,
      });
    }
    return Object.values(byOutcome).sort((a, b) => b.total - a.total);
  } catch (e) { console.warn('[!] loadSignalRejects:', e.message); return []; }
}

module.exports = {
  pool,
  initDB,
  // Trades
  saveTrade,
  loadAllTrades,
  // Ghost optimizer
  saveGhostTrade,
  loadGhostTrades,
  saveGhostState,
  loadAllGhostStates,
  deleteGhostState,
  saveBandGhost,
  loadBandGhosts,
  loadBandGhostStats,
  countGhostsByKey,
  // Shadow optimizer
  saveShadowSnapshot,
  loadShadowSnapshots,
  saveShadowAnalysis,
  loadShadowAnalysis,
  loadAllShadowAnalysis,     // FIX 12
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
  // Lot overrides (FIX 2)
  saveLotOverride,
  loadLotOverrides,
  // Key risk multipliers (FIX 19 + v10.6 evMult/dayMult)
  saveKeyRiskMult,
  loadKeyRiskMults,
  // Realized P&L (FIX 4)
  fetchRealizedPnl,
  // Spread log (v10.7)
  saveSpreadLog,
  loadSpreadStats,
  loadSpreadLog,
  // Webhook history
  logWebhook,
  loadWebhookHistory,
  // Signal log
  logSignal,
  // Signal stats
  loadSignalStats,
  loadSignalRejects,    // v12.1: niet-genomen trades breakdown
  // EV stats
  computeEVStats,
  // Shadow winners
  loadShadowWinners,
};
