// ═══════════════════════════════════════════════════════════════
// db.js — PostgreSQL persistence layer  |  v4.1
// Railway: voeg Postgres plugin toe → DATABASE_URL wordt auto-gezet
//
// Wijzigingen t.o.v. v4.0:
//  ✅ tp_config — sub-1R niveaus (0.2/0.4/0.6/0.8) opgeslagen
//  ✅ closed_trades — spread_guard kolom toegevoegd
//  ✅ closed_trades — sl_multiplier_applied kolom toegevoegd
//  ✅ forex_consolidation_log tabel toegevoegd
//  ✅ sl_config — direction kolom (up/down/unchanged) voor advies
// ═══════════════════════════════════════════════════════════════

"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
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
      sl_multiplier       NUMERIC     DEFAULT 1.0
    );

    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS position_id        TEXT        UNIQUE;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_rr        NUMERIC;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_price     NUMERIC;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_stop_reason  TEXT;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_finalized_at TIMESTAMPTZ;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS spread_guard       BOOLEAN     DEFAULT FALSE;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS sl_multiplier      NUMERIC     DEFAULT 1.0;

    CREATE TABLE IF NOT EXISTS tp_config (
      symbol          TEXT        NOT NULL,
      session         TEXT        NOT NULL DEFAULT 'all',
      locked_rr       NUMERIC     NOT NULL,
      locked_at       TIMESTAMPTZ DEFAULT NOW(),
      locked_trades   INTEGER     NOT NULL,
      prev_rr         NUMERIC,
      prev_locked_at  TIMESTAMPTZ,
      ev_at_lock      NUMERIC,
      auto_updated    BOOLEAN     DEFAULT TRUE
    );

    ALTER TABLE tp_config ADD COLUMN IF NOT EXISTS session TEXT NOT NULL DEFAULT 'all';
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'tp_config_symbol_session_pk'
          AND table_name = 'tp_config'
      ) THEN
        BEGIN
          ALTER TABLE tp_config DROP CONSTRAINT IF EXISTS tp_config_pkey;
        EXCEPTION WHEN others THEN NULL;
        END;
        BEGIN
          ALTER TABLE tp_config
            ADD CONSTRAINT tp_config_symbol_session_pk PRIMARY KEY (symbol, session);
        EXCEPTION WHEN others THEN NULL;
        END;
      END IF;
    END $$;
  `);

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

    CREATE TABLE IF NOT EXISTS sl_config (
      symbol            TEXT        PRIMARY KEY,
      multiplier        NUMERIC     NOT NULL,
      direction         TEXT        DEFAULT 'unchanged',
      locked_at         TIMESTAMPTZ DEFAULT NOW(),
      locked_trades     INTEGER     NOT NULL,
      ev_at_lock        NUMERIC,
      best_tp_rr        NUMERIC,
      prev_multiplier   NUMERIC,
      prev_locked_at    TIMESTAMPTZ
    );

    ALTER TABLE sl_config ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'unchanged';

    CREATE TABLE IF NOT EXISTS sl_update_log (
      id              SERIAL PRIMARY KEY,
      symbol          TEXT        NOT NULL,
      old_multiplier  NUMERIC,
      new_multiplier  NUMERIC,
      direction       TEXT,
      trades          INTEGER,
      ev              NUMERIC,
      reason          TEXT,
      ts              TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE sl_update_log ADD COLUMN IF NOT EXISTS direction TEXT;

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

    CREATE INDEX IF NOT EXISTS idx_trades_symbol      ON closed_trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_closed      ON closed_trades(closed_at);
    CREATE INDEX IF NOT EXISTS idx_trades_session     ON closed_trades(session);
    CREATE INDEX IF NOT EXISTS idx_trades_position_id ON closed_trades(position_id);
    CREATE INDEX IF NOT EXISTS idx_equity_ts          ON equity_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_sl_log_symbol      ON sl_update_log(symbol);
    CREATE INDEX IF NOT EXISTS idx_tp_log_symbol      ON tp_update_log(symbol);
    CREATE INDEX IF NOT EXISTS idx_tp_log_session     ON tp_update_log(session);
    CREATE INDEX IF NOT EXISTS idx_forex_cons_symbol  ON forex_consolidation_log(symbol);
  `);

  console.log("✅ [DB] Schema klaar (v4.1 — sub-1R TP, spread guard, forex consolidatie)");
}

async function saveTrade(trade) {
  const q = `
    INSERT INTO closed_trades
      (position_id, symbol, mt5_symbol, direction, entry, sl, tp, lots, risk_eur,
       max_price, max_rr, true_max_rr, true_max_price,
       ghost_stop_reason, ghost_finalized_at,
       session, opened_at, closed_at, spread_guard, sl_multiplier)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (position_id) DO UPDATE SET
      max_price           = EXCLUDED.max_price,
      max_rr              = EXCLUDED.max_rr,
      true_max_rr         = EXCLUDED.true_max_rr,
      true_max_price      = EXCLUDED.true_max_price,
      ghost_stop_reason   = EXCLUDED.ghost_stop_reason,
      ghost_finalized_at  = EXCLUDED.ghost_finalized_at
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
      COALESCE(CAST(sl_multiplier AS FLOAT), 1.0) AS "slMultiplier"
    FROM closed_trades
    ORDER BY closed_at ASC
  `);
  console.log(`📂 [DB] ${res.rows.length} trades geladen`);
  return res.rows;
}

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
  const res = await pool.query(`
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
  return res.rows;
}

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
  await pool.query(`
    INSERT INTO tp_config (symbol, session, locked_rr, locked_trades, ev_at_lock, prev_rr, prev_locked_at, locked_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT ON CONSTRAINT tp_config_symbol_session_pk DO UPDATE SET
      prev_rr        = tp_config.locked_rr,
      prev_locked_at = tp_config.locked_at,
      locked_rr      = EXCLUDED.locked_rr,
      locked_trades  = EXCLUDED.locked_trades,
      ev_at_lock     = EXCLUDED.ev_at_lock,
      locked_at      = NOW()
  `, [symbol, session || "all", lockedRR, lockedTrades, evAtLock ?? null, prevRR ?? null, prevLockedAt ?? null]);
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
      };
    }
    console.log(`📐 [DB] ${res.rows.length} SL configs geladen`);
    return map;
  } catch (e) { console.warn("⚠️ loadSLConfig:", e.message); return {}; }
}

async function saveSLConfig(symbol, multiplier, direction, lockedTrades, evAtLock, bestTPRR, prevMultiplier, prevLockedAt) {
  await pool.query(`
    INSERT INTO sl_config
      (symbol, multiplier, direction, locked_trades, ev_at_lock, best_tp_rr, prev_multiplier, prev_locked_at, locked_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (symbol) DO UPDATE SET
      prev_multiplier = sl_config.multiplier,
      prev_locked_at  = sl_config.locked_at,
      multiplier      = EXCLUDED.multiplier,
      direction       = EXCLUDED.direction,
      locked_trades   = EXCLUDED.locked_trades,
      ev_at_lock      = EXCLUDED.ev_at_lock,
      best_tp_rr      = EXCLUDED.best_tp_rr,
      locked_at       = NOW()
  `, [symbol, multiplier, direction || "unchanged", lockedTrades,
      evAtLock ?? null, bestTPRR ?? null, prevMultiplier ?? null, prevLockedAt ?? null]);
}

async function logSLUpdate(symbol, oldMult, newMult, direction, trades, ev, reason) {
  await pool.query(`
    INSERT INTO sl_update_log (symbol, old_multiplier, new_multiplier, direction, trades, ev, reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [symbol, oldMult ?? null, newMult, direction || "unchanged", trades, ev ?? null, reason]);
  console.log(`📝 [DB] SL log: ${symbol} ${oldMult ?? "nieuw"}× → ${newMult}× (${direction})`);
}

async function loadSLUpdateLog(limit = 50) {
  try {
    const res = await pool.query(`
      SELECT symbol,
             CAST(old_multiplier AS FLOAT) AS "oldMultiplier",
             CAST(new_multiplier AS FLOAT) AS "newMultiplier",
             direction, trades, CAST(ev AS FLOAT) AS ev, reason, ts
      FROM sl_update_log ORDER BY ts DESC LIMIT $1
    `, [limit]);
    return res.rows;
  } catch (e) { console.warn("⚠️ loadSLUpdateLog:", e.message); return []; }
}

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
  logForexConsolidation,
};
