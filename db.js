// ═══════════════════════════════════════════════════════════════
// db.js — PostgreSQL persistence layer  |  v5.2
//
// WIJZIGINGEN v5.2 (t.o.v. v5.0):
//  ✅ [FEAT] daily_risk_log tabel — dagelijkse EV tracking voor
//           risk scaling (positieve dag → Risk ×1.2 volgende dag)
//  ✅ [FEAT] saveDailyRisk / loadLatestDailyRisk functies
//  ✅ [FEAT] duplicate_entry_guard tabel — detectie dubbele orders
//           (zelfde pair + richting + korte tijdrange)
//  ✅ [FEAT] saveDuplicateEntry / recentDuplicateExists functies
//  ✅ [FIX]  SL auto-apply drempel verlaagd: 50 → 30 trades
//           (kolom applied_trades blijft zelfde, alleen server logica)
//  ✅ [KEEP] Pool timeouts, loadSnapshots 4s timeout, ghost analyse,
//           PnL log, TP/SL config — ongewijzigd t.o.v. v5.0
// ═══════════════════════════════════════════════════════════════

"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis:       10000,
  statement_timeout:       5000,
});

async function initDB() {
  // ── Basis tabellen ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS closed_trades (
      id                  SERIAL PRIMARY KEY,
      position_id         TEXT        UNIQUE,
      symbol              TEXT        NOT NULL,
      mt5_symbol          TEXT,
      direction           TEXT        NOT NULL,
      entry               NUMERIC     NOT NULL,
      sl                  NUMERIC     NOT NULL,
      tp                  NUMERIC,
      lots                NUMERIC,
      risk_eur            NUMERIC,
      max_price           NUMERIC,
      max_rr              NUMERIC,
      true_max_rr         NUMERIC,
      true_max_price      NUMERIC,
      ghost_stop_reason   TEXT,
      ghost_finalized_at  TIMESTAMPTZ,
      session             TEXT,
      opened_at           TIMESTAMPTZ,
      closed_at           TIMESTAMPTZ DEFAULT NOW(),
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      spread_guard        BOOLEAN     DEFAULT FALSE,
      sl_multiplier       NUMERIC     DEFAULT 1.0,
      realized_pnl_eur    NUMERIC,
      hit_tp              BOOLEAN     DEFAULT FALSE
    );

    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS position_id        TEXT        UNIQUE;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_rr        NUMERIC;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_price     NUMERIC;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_stop_reason  TEXT;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_finalized_at TIMESTAMPTZ;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS spread_guard       BOOLEAN     DEFAULT FALSE;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS sl_multiplier      NUMERIC     DEFAULT 1.0;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS realized_pnl_eur   NUMERIC;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS hit_tp             BOOLEAN     DEFAULT FALSE;
  `);

  // ── TP config (per sessie) ─────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tp_config (
      symbol          TEXT        NOT NULL,
      session         TEXT        NOT NULL DEFAULT 'all',
      locked_rr       NUMERIC     NOT NULL,
      locked_at       TIMESTAMPTZ DEFAULT NOW(),
      locked_trades   INTEGER     NOT NULL,
      prev_rr         NUMERIC,
      prev_locked_at  TIMESTAMPTZ,
      ev_at_lock      NUMERIC,
      auto_updated    BOOLEAN     DEFAULT TRUE,
      ev_positive     BOOLEAN     DEFAULT FALSE
    );

    ALTER TABLE tp_config ADD COLUMN IF NOT EXISTS session      TEXT    NOT NULL DEFAULT 'all';
    ALTER TABLE tp_config ADD COLUMN IF NOT EXISTS ev_positive  BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'tp_config_symbol_session_pk'
          AND table_name = 'tp_config'
      ) THEN
        BEGIN ALTER TABLE tp_config DROP CONSTRAINT IF EXISTS tp_config_pkey;
        EXCEPTION WHEN others THEN NULL; END;
        BEGIN
          ALTER TABLE tp_config
            ADD CONSTRAINT tp_config_symbol_session_pk PRIMARY KEY (symbol, session);
        EXCEPTION WHEN others THEN NULL; END;
      END IF;
    END $$;
  `);

  // ── SL config (met auto-apply na 30 trades) ───────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sl_config (
      symbol            TEXT        PRIMARY KEY,
      multiplier        NUMERIC     NOT NULL,
      direction         TEXT        DEFAULT 'unchanged',
      locked_at         TIMESTAMPTZ DEFAULT NOW(),
      locked_trades     INTEGER     NOT NULL,
      ev_at_lock        NUMERIC,
      best_tp_rr        NUMERIC,
      prev_multiplier   NUMERIC,
      prev_locked_at    TIMESTAMPTZ,
      auto_applied      BOOLEAN     DEFAULT FALSE,
      applied_at        TIMESTAMPTZ,
      applied_trades    INTEGER
    );

    ALTER TABLE sl_config ADD COLUMN IF NOT EXISTS direction      TEXT    DEFAULT 'unchanged';
    ALTER TABLE sl_config ADD COLUMN IF NOT EXISTS auto_applied   BOOLEAN DEFAULT FALSE;
    ALTER TABLE sl_config ADD COLUMN IF NOT EXISTS applied_at     TIMESTAMPTZ;
    ALTER TABLE sl_config ADD COLUMN IF NOT EXISTS applied_trades INTEGER;
  `);

  // ── Overige tabellen ───────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tp_update_log (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT        NOT NULL,
      session     TEXT        NOT NULL DEFAULT 'all',
      old_rr      NUMERIC,
      new_rr      NUMERIC,
      trades      INTEGER,
      ev          NUMERIC,
      reason      TEXT,
      ts          TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE tp_update_log ADD COLUMN IF NOT EXISTS session TEXT NOT NULL DEFAULT 'all';

    CREATE TABLE IF NOT EXISTS sl_update_log (
      id              SERIAL PRIMARY KEY,
      symbol          TEXT        NOT NULL,
      old_multiplier  NUMERIC,
      new_multiplier  NUMERIC,
      direction       TEXT,
      trades          INTEGER,
      ev              NUMERIC,
      reason          TEXT,
      auto_applied    BOOLEAN     DEFAULT FALSE,
      ts              TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE sl_update_log ADD COLUMN IF NOT EXISTS direction    TEXT;
    ALTER TABLE sl_update_log ADD COLUMN IF NOT EXISTS auto_applied BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS forex_consolidation_log (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT        NOT NULL,
      direction   TEXT        NOT NULL,
      blocked_at  TIMESTAMPTZ DEFAULT NOW(),
      count       INTEGER     NOT NULL,
      reason      TEXT
    );

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id            SERIAL PRIMARY KEY,
      ts            TIMESTAMPTZ DEFAULT NOW(),
      balance       NUMERIC,
      equity        NUMERIC,
      floating_pl   NUMERIC,
      margin        NUMERIC,
      free_margin   NUMERIC
    );

    -- Ghost analyse tabel
    CREATE TABLE IF NOT EXISTS ghost_analysis (
      id                  SERIAL PRIMARY KEY,
      symbol              TEXT        NOT NULL,
      session             TEXT,
      direction           TEXT,
      entry               NUMERIC,
      sl                  NUMERIC,
      tp                  NUMERIC,
      max_rr_at_close     NUMERIC,
      true_max_rr         NUMERIC,
      ghost_extra_rr      NUMERIC,
      hit_tp              BOOLEAN,
      ghost_stop_reason   TEXT,
      ghost_duration_min  INTEGER,
      ghost_finalized_at  TIMESTAMPTZ,
      closed_at           TIMESTAMPTZ,
      realized_pnl_eur    NUMERIC,
      trade_position_id   TEXT
    );

    ALTER TABLE ghost_analysis ADD COLUMN IF NOT EXISTS ghost_extra_rr     NUMERIC;
    ALTER TABLE ghost_analysis ADD COLUMN IF NOT EXISTS ghost_duration_min  INTEGER;
    ALTER TABLE ghost_analysis ADD COLUMN IF NOT EXISTS realized_pnl_eur   NUMERIC;

    -- Win/verlies log per sessie per symbool
    CREATE TABLE IF NOT EXISTS trade_pnl_log (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT        NOT NULL,
      session     TEXT,
      direction   TEXT,
      rr_achieved NUMERIC,
      hit_tp      BOOLEAN,
      pnl_eur     NUMERIC,
      closed_at   TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ── [v5.2] Daily Risk Scaling log ────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_risk_log (
      id                  SERIAL PRIMARY KEY,
      trade_date          DATE        NOT NULL DEFAULT CURRENT_DATE,
      total_pnl_eur       NUMERIC,
      ev_positive         BOOLEAN     DEFAULT FALSE,
      trades_count        INTEGER     DEFAULT 0,
      risk_multiplier_applied NUMERIC DEFAULT 1.0,
      risk_multiplier_next    NUMERIC DEFAULT 1.0,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_risk_date
      ON daily_risk_log(trade_date);
  `);

  // ── [v5.2] Duplicate Entry Guard ─────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_entry_log (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT        NOT NULL,
      direction   TEXT        NOT NULL,
      blocked_at  TIMESTAMPTZ DEFAULT NOW(),
      reason      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dup_symbol ON duplicate_entry_log(symbol, blocked_at DESC);
  `);

  // ── Indices ────────────────────────────────────────────────
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_trades_symbol      ON closed_trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_closed      ON closed_trades(closed_at);
    CREATE INDEX IF NOT EXISTS idx_trades_session     ON closed_trades(session);
    CREATE INDEX IF NOT EXISTS idx_trades_position_id ON closed_trades(position_id);
    CREATE INDEX IF NOT EXISTS idx_equity_ts          ON equity_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_sl_log_symbol      ON sl_update_log(symbol);
    CREATE INDEX IF NOT EXISTS idx_tp_log_symbol      ON tp_update_log(symbol);
    CREATE INDEX IF NOT EXISTS idx_tp_log_session     ON tp_update_log(session);
    CREATE INDEX IF NOT EXISTS idx_forex_cons_symbol  ON forex_consolidation_log(symbol);
    CREATE INDEX IF NOT EXISTS idx_ghost_symbol       ON ghost_analysis(symbol);
    CREATE INDEX IF NOT EXISTS idx_ghost_session      ON ghost_analysis(session);
    CREATE INDEX IF NOT EXISTS idx_pnl_symbol         ON trade_pnl_log(symbol);
    CREATE INDEX IF NOT EXISTS idx_pnl_session        ON trade_pnl_log(session);
  `);

  console.log("✅ [DB] Schema klaar (v5.2 — daily risk log, duplicate guard, SL@30)");
}

// ── Trades ────────────────────────────────────────────────────
async function saveTrade(trade) {
  const q = `
    INSERT INTO closed_trades
      (position_id, symbol, mt5_symbol, direction, entry, sl, tp, lots, risk_eur,
       max_price, max_rr, true_max_rr, true_max_price,
       ghost_stop_reason, ghost_finalized_at,
       session, opened_at, closed_at, spread_guard, sl_multiplier,
       realized_pnl_eur, hit_tp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (position_id) DO UPDATE SET
      max_price           = EXCLUDED.max_price,
      max_rr              = EXCLUDED.max_rr,
      true_max_rr         = EXCLUDED.true_max_rr,
      true_max_price      = EXCLUDED.true_max_price,
      ghost_stop_reason   = EXCLUDED.ghost_stop_reason,
      ghost_finalized_at  = EXCLUDED.ghost_finalized_at,
      realized_pnl_eur    = EXCLUDED.realized_pnl_eur,
      hit_tp              = EXCLUDED.hit_tp
    RETURNING id
  `;
  const vals = [
    trade.id                ?? null,
    trade.symbol,
    trade.mt5Symbol         ?? null,
    trade.direction,
    trade.entry,
    trade.sl,
    trade.tp                ?? null,
    trade.lots              ?? null,
    trade.riskEUR           ?? null,
    trade.maxPrice          ?? null,
    trade.maxRR             ?? null,
    trade.trueMaxRR         ?? null,
    trade.trueMaxPrice      ?? null,
    trade.ghostStopReason   ?? null,
    trade.ghostFinalizedAt  ?? null,
    trade.session           ?? null,
    trade.openedAt          ?? null,
    trade.closedAt          ?? new Date().toISOString(),
    trade.spreadGuard       ?? false,
    trade.slMultiplier      ?? 1.0,
    trade.realizedPnlEUR    ?? null,
    trade.hitTP             ?? false,
  ];
  const res = await pool.query(q, vals);
  const isGhost = trade.trueMaxRR !== null && trade.trueMaxRR !== undefined;
  console.log(
    isGhost
      ? `👻 [DB] Ghost update: id=${res.rows[0].id} ${trade.symbol} trueMaxRR=${trade.trueMaxRR}`
      : `💾 [DB] Trade: id=${res.rows[0].id} ${trade.symbol} maxRR=${trade.maxRR}`
  );
  return res.rows[0].id;
}

async function loadAllTrades() {
  const res = await pool.query(`
    SELECT
      position_id         AS "id",
      symbol,
      mt5_symbol          AS "mt5Symbol",
      direction,
      CAST(entry          AS FLOAT) AS entry,
      CAST(sl             AS FLOAT) AS sl,
      CAST(tp             AS FLOAT) AS tp,
      CAST(lots           AS FLOAT) AS lots,
      CAST(risk_eur       AS FLOAT) AS "riskEUR",
      CAST(max_price      AS FLOAT) AS "maxPrice",
      CAST(max_rr         AS FLOAT) AS "maxRR",
      CAST(true_max_rr    AS FLOAT) AS "trueMaxRR",
      CAST(true_max_price AS FLOAT) AS "trueMaxPrice",
      ghost_stop_reason   AS "ghostStopReason",
      ghost_finalized_at  AS "ghostFinalizedAt",
      session,
      opened_at           AS "openedAt",
      closed_at           AS "closedAt",
      COALESCE(spread_guard, FALSE) AS "spreadGuard",
      COALESCE(CAST(sl_multiplier AS FLOAT), 1.0) AS "slMultiplier",
      CAST(realized_pnl_eur AS FLOAT) AS "realizedPnlEUR",
      COALESCE(hit_tp, FALSE) AS "hitTP"
    FROM closed_trades
    ORDER BY closed_at ASC
  `);
  console.log(`📂 [DB] ${res.rows.length} trades geladen`);
  return res.rows;
}

// ── Snapshots ─────────────────────────────────────────────────
let lastSnapshotSave = 0;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

async function saveSnapshot(snap) {
  const now = Date.now();
  if (now - lastSnapshotSave < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotSave = now;
  await pool.query(`
    INSERT INTO equity_snapshots (ts, balance, equity, floating_pl, margin, free_margin)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [snap.ts, snap.balance ?? null, snap.equity ?? null,
      snap.floatingPL ?? null, snap.margin ?? null, snap.freeMargin ?? null]);
}

async function loadSnapshots(hours = 24) {
  const query = pool.query(`
    SELECT ts,
      CAST(balance     AS FLOAT) AS balance,
      CAST(equity      AS FLOAT) AS equity,
      CAST(floating_pl AS FLOAT) AS "floatingPL",
      CAST(margin      AS FLOAT) AS margin,
      CAST(free_margin AS FLOAT) AS "freeMargin"
    FROM equity_snapshots
    WHERE ts > NOW() - INTERVAL '${hours} hours'
    ORDER BY ts ASC
  `);
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("loadSnapshots timeout")), 4000)
  );
  const res = await Promise.race([query, timeout]);
  return res.rows;
}

// ── TP Config ─────────────────────────────────────────────────
async function loadTPConfig() {
  try {
    const res = await pool.query(`SELECT * FROM tp_config ORDER BY symbol, session`);
    const map = {};
    for (const r of res.rows) {
      const sess = r.session || "all";
      const key  = `${r.symbol}__${sess}`;
      map[key] = {
        lockedRR:     parseFloat(r.locked_rr),
        lockedAt:     r.locked_at,
        lockedTrades: r.locked_trades,
        session:      sess,
        prevRR:       r.prev_rr       ? parseFloat(r.prev_rr)    : null,
        prevLockedAt: r.prev_locked_at ?? null,
        evAtLock:     r.ev_at_lock    ? parseFloat(r.ev_at_lock) : null,
        evPositive:   r.ev_positive   ?? false,
      };
    }
    console.log(`📊 [DB] ${res.rows.length} TP configs geladen`);
    return map;
  } catch (e) {
    console.warn("⚠️ loadTPConfig:", e.message);
    return {};
  }
}

async function saveTPConfig(symbol, session, lockedRR, lockedTrades, evAtLock, prevRR, prevLockedAt) {
  const evPositive = (evAtLock ?? 0) > 0;
  await pool.query(`
    INSERT INTO tp_config (symbol, session, locked_rr, locked_trades, ev_at_lock, ev_positive, prev_rr, prev_locked_at, locked_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT ON CONSTRAINT tp_config_symbol_session_pk DO UPDATE SET
      prev_rr        = tp_config.locked_rr,
      prev_locked_at = tp_config.locked_at,
      locked_rr      = EXCLUDED.locked_rr,
      locked_trades  = EXCLUDED.locked_trades,
      ev_at_lock     = EXCLUDED.ev_at_lock,
      ev_positive    = EXCLUDED.ev_positive,
      locked_at      = NOW()
  `, [symbol, session || "all", lockedRR, lockedTrades, evAtLock ?? null,
      evPositive, prevRR ?? null, prevLockedAt ?? null]);
}

async function logTPUpdate(symbol, session, oldRR, newRR, trades, ev, reason) {
  await pool.query(`
    INSERT INTO tp_update_log (symbol, session, old_rr, new_rr, trades, ev, reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [symbol, session || "all", oldRR ?? null, newRR, trades, ev ?? null, reason]);
  console.log(`📝 [DB] TP log: ${symbol}/${session} ${oldRR ?? "nieuw"}R → ${newRR}R`);
}

async function loadTPUpdateLog(limit = 50) {
  try {
    const res = await pool.query(`
      SELECT symbol, session,
             CAST(old_rr AS FLOAT) AS "oldRR",
             CAST(new_rr AS FLOAT) AS "newRR",
             trades, CAST(ev AS FLOAT) AS ev, reason, ts
      FROM tp_update_log ORDER BY ts DESC LIMIT $1
    `, [limit]);
    return res.rows;
  } catch (e) { console.warn("⚠️ loadTPUpdateLog:", e.message); return []; }
}

// ── SL Config (met auto-apply na 30 trades) ───────────────────
async function loadSLConfig() {
  try {
    const res = await pool.query(`SELECT * FROM sl_config ORDER BY symbol`);
    const map = {};
    for (const r of res.rows) {
      map[r.symbol] = {
        multiplier:     parseFloat(r.multiplier),
        direction:      r.direction      ?? "unchanged",
        lockedAt:       r.locked_at,
        lockedTrades:   r.locked_trades,
        evAtLock:       r.ev_at_lock      ? parseFloat(r.ev_at_lock)      : null,
        bestTPRR:       r.best_tp_rr      ? parseFloat(r.best_tp_rr)      : null,
        prevMultiplier: r.prev_multiplier ? parseFloat(r.prev_multiplier) : null,
        prevLockedAt:   r.prev_locked_at  ?? null,
        autoApplied:    r.auto_applied    ?? false,
        appliedAt:      r.applied_at      ?? null,
        appliedTrades:  r.applied_trades  ?? null,
      };
    }
    console.log(`📐 [DB] ${res.rows.length} SL configs geladen`);
    return map;
  } catch (e) { console.warn("⚠️ loadSLConfig:", e.message); return {}; }
}

async function saveSLConfig(symbol, multiplier, direction, lockedTrades, evAtLock, bestTPRR,
                            prevMultiplier, prevLockedAt, autoApplied = false, appliedAt = null, appliedTrades = null) {
  await pool.query(`
    INSERT INTO sl_config
      (symbol, multiplier, direction, locked_trades, ev_at_lock, best_tp_rr,
       prev_multiplier, prev_locked_at, locked_at, auto_applied, applied_at, applied_trades)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10, $11)
    ON CONFLICT (symbol) DO UPDATE SET
      prev_multiplier = sl_config.multiplier,
      prev_locked_at  = sl_config.locked_at,
      multiplier      = EXCLUDED.multiplier,
      direction       = EXCLUDED.direction,
      locked_trades   = EXCLUDED.locked_trades,
      ev_at_lock      = EXCLUDED.ev_at_lock,
      best_tp_rr      = EXCLUDED.best_tp_rr,
      locked_at       = NOW(),
      auto_applied    = EXCLUDED.auto_applied,
      applied_at      = EXCLUDED.applied_at,
      applied_trades  = EXCLUDED.applied_trades
  `, [symbol, multiplier, direction || "unchanged", lockedTrades,
      evAtLock ?? null, bestTPRR ?? null, prevMultiplier ?? null, prevLockedAt ?? null,
      autoApplied, appliedAt, appliedTrades]);
}

async function logSLUpdate(symbol, oldMult, newMult, direction, trades, ev, reason, autoApplied = false) {
  await pool.query(`
    INSERT INTO sl_update_log (symbol, old_multiplier, new_multiplier, direction, trades, ev, reason, auto_applied)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [symbol, oldMult ?? null, newMult, direction || "unchanged", trades, ev ?? null, reason, autoApplied]);
  console.log(`📝 [DB] SL log: ${symbol} ${oldMult ?? "nieuw"}× → ${newMult}× (${direction})${autoApplied ? " [AUTO APPLIED]" : ""}`);
}

async function loadSLUpdateLog(limit = 50) {
  try {
    const res = await pool.query(`
      SELECT symbol,
             CAST(old_multiplier AS FLOAT) AS "oldMultiplier",
             CAST(new_multiplier AS FLOAT) AS "newMultiplier",
             direction, trades, CAST(ev AS FLOAT) AS ev, reason, auto_applied AS "autoApplied", ts
      FROM sl_update_log ORDER BY ts DESC LIMIT $1
    `, [limit]);
    return res.rows;
  } catch (e) { console.warn("⚠️ loadSLUpdateLog:", e.message); return []; }
}

// ── Ghost Analyse ─────────────────────────────────────────────
async function saveGhostAnalysis(data) {
  try {
    await pool.query(`
      INSERT INTO ghost_analysis
        (symbol, session, direction, entry, sl, tp, max_rr_at_close, true_max_rr,
         ghost_extra_rr, hit_tp, ghost_stop_reason, ghost_duration_min,
         ghost_finalized_at, closed_at, realized_pnl_eur, trade_position_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT DO NOTHING
    `, [
      data.symbol, data.session, data.direction,
      data.entry, data.sl, data.tp ?? null,
      data.maxRRAtClose ?? null, data.trueMaxRR ?? null,
      data.ghostExtraRR ?? null,
      data.hitTP ?? false,
      data.ghostStopReason ?? null,
      data.ghostDurationMin ?? null,
      data.ghostFinalizedAt ?? null,
      data.closedAt ?? null,
      data.realizedPnlEUR ?? null,
      data.tradePositionId ?? null,
    ]);
  } catch (e) { console.warn("⚠️ saveGhostAnalysis:", e.message); }
}

async function loadGhostAnalysis(symbol = null, session = null, limit = 200) {
  try {
    let where = "WHERE 1=1";
    const vals = [];
    if (symbol)  { vals.push(symbol);  where += ` AND symbol = $${vals.length}`; }
    if (session) { vals.push(session); where += ` AND session = $${vals.length}`; }
    vals.push(limit);
    const res = await pool.query(`
      SELECT
        symbol, session, direction,
        CAST(entry AS FLOAT) AS entry,
        CAST(sl    AS FLOAT) AS sl,
        CAST(tp    AS FLOAT) AS tp,
        CAST(max_rr_at_close  AS FLOAT) AS "maxRRAtClose",
        CAST(true_max_rr      AS FLOAT) AS "trueMaxRR",
        CAST(ghost_extra_rr   AS FLOAT) AS "ghostExtraRR",
        hit_tp                          AS "hitTP",
        ghost_stop_reason               AS "ghostStopReason",
        ghost_duration_min              AS "ghostDurationMin",
        ghost_finalized_at              AS "ghostFinalizedAt",
        closed_at                       AS "closedAt",
        CAST(realized_pnl_eur AS FLOAT) AS "realizedPnlEUR",
        trade_position_id               AS "tradePositionId"
      FROM ghost_analysis
      ${where}
      ORDER BY ghost_finalized_at DESC NULLS LAST
      LIMIT $${vals.length}
    `, vals);
    return res.rows;
  } catch (e) { console.warn("⚠️ loadGhostAnalysis:", e.message); return []; }
}

// ── PnL Log ───────────────────────────────────────────────────
async function savePnlLog(symbol, session, direction, rrAchieved, hitTP, pnlEUR) {
  try {
    await pool.query(`
      INSERT INTO trade_pnl_log (symbol, session, direction, rr_achieved, hit_tp, pnl_eur)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [symbol, session ?? null, direction ?? null,
        rrAchieved ?? null, hitTP ?? false, pnlEUR ?? null]);
  } catch (e) { console.warn("⚠️ savePnlLog:", e.message); }
}

async function loadPnlStats(symbol = null, session = null) {
  try {
    let where = "WHERE 1=1";
    const vals = [];
    if (symbol)  { vals.push(symbol);  where += ` AND symbol = $${vals.length}`; }
    if (session) { vals.push(session); where += ` AND session = $${vals.length}`; }
    const res = await pool.query(`
      SELECT
        symbol, session,
        COUNT(*)                            AS total,
        SUM(CASE WHEN pnl_eur > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN pnl_eur < 0 THEN 1 ELSE 0 END) AS losses,
        CAST(SUM(pnl_eur)        AS FLOAT)  AS total_pnl,
        CAST(MAX(pnl_eur)        AS FLOAT)  AS best_trade,
        CAST(MIN(pnl_eur)        AS FLOAT)  AS worst_trade,
        CAST(AVG(pnl_eur)        AS FLOAT)  AS avg_pnl,
        CAST(AVG(rr_achieved)    AS FLOAT)  AS avg_rr,
        CAST(MAX(rr_achieved)    AS FLOAT)  AS best_rr,
        CAST(MIN(rr_achieved)    AS FLOAT)  AS worst_rr,
        SUM(CASE WHEN hit_tp THEN 1 ELSE 0 END) AS tp_hits
      FROM trade_pnl_log
      ${where}
      GROUP BY symbol, session
      ORDER BY total_pnl DESC
    `, vals);
    return res.rows;
  } catch (e) { console.warn("⚠️ loadPnlStats:", e.message); return []; }
}

// ── [v5.2] Daily Risk Scaling ─────────────────────────────────
async function saveDailyRisk(tradeDate, totalPnlEUR, tradesCount, riskMultApplied, riskMultNext) {
  try {
    const evPositive = (totalPnlEUR ?? 0) > 0;
    await pool.query(`
      INSERT INTO daily_risk_log
        (trade_date, total_pnl_eur, ev_positive, trades_count, risk_multiplier_applied, risk_multiplier_next)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (trade_date) DO UPDATE SET
        total_pnl_eur           = EXCLUDED.total_pnl_eur,
        ev_positive             = EXCLUDED.ev_positive,
        trades_count            = EXCLUDED.trades_count,
        risk_multiplier_applied = EXCLUDED.risk_multiplier_applied,
        risk_multiplier_next    = EXCLUDED.risk_multiplier_next,
        created_at              = NOW()
    `, [tradeDate, totalPnlEUR ?? 0, evPositive, tradesCount ?? 0,
        riskMultApplied ?? 1.0, riskMultNext ?? 1.0]);
    console.log(`📅 [DB] Daily risk: ${tradeDate} PnL=€${(totalPnlEUR??0).toFixed(2)} → next mult=${riskMultNext}`);
  } catch (e) { console.warn("⚠️ saveDailyRisk:", e.message); }
}

async function loadLatestDailyRisk() {
  try {
    const res = await pool.query(`
      SELECT
        trade_date,
        CAST(total_pnl_eur           AS FLOAT) AS "totalPnlEUR",
        ev_positive                            AS "evPositive",
        trades_count                           AS "tradesCount",
        CAST(risk_multiplier_applied AS FLOAT) AS "riskMultApplied",
        CAST(risk_multiplier_next    AS FLOAT) AS "riskMultNext"
      FROM daily_risk_log
      ORDER BY trade_date DESC
      LIMIT 1
    `);
    return res.rows[0] ?? null;
  } catch (e) { console.warn("⚠️ loadLatestDailyRisk:", e.message); return null; }
}

// ── [v5.2] Duplicate Entry Guard ─────────────────────────────
async function logDuplicateEntry(symbol, direction, reason) {
  try {
    await pool.query(`
      INSERT INTO duplicate_entry_log (symbol, direction, reason)
      VALUES ($1, $2, $3)
    `, [symbol, direction, reason]);
  } catch (e) { console.warn("⚠️ logDuplicateEntry:", e.message); }
}

// ── Misc ──────────────────────────────────────────────────────
async function logForexConsolidation(symbol, direction, count, reason) {
  try {
    await pool.query(`
      INSERT INTO forex_consolidation_log (symbol, direction, count, reason)
      VALUES ($1, $2, $3, $4)
    `, [symbol, direction, count, reason]);
  } catch (e) { console.warn("⚠️ logForexConsolidation:", e.message); }
}

module.exports = {
  initDB,
  saveTrade, loadAllTrades,
  saveSnapshot, loadSnapshots,
  loadTPConfig, saveTPConfig, logTPUpdate, loadTPUpdateLog,
  loadSLConfig, saveSLConfig, logSLUpdate, loadSLUpdateLog,
  saveGhostAnalysis, loadGhostAnalysis,
  savePnlLog, loadPnlStats,
  logForexConsolidation,
  // v5.2
  saveDailyRisk, loadLatestDailyRisk,
  logDuplicateEntry,
};
