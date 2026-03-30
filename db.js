// ═══════════════════════════════════════════════════════════════
// db.js — PostgreSQL persistence layer  |  v3.8
// Railway: voeg Postgres plugin toe → DATABASE_URL wordt auto-gezet
//
// Wijzigingen t.o.v. v3.7:
//  ✅ position_id kolom (MT5 positie-ID) als unieke sleutel
//  ✅ true_max_rr / true_max_price / ghost_stop_reason / ghost_finalized_at
//  ✅ saveTrade = UPSERT op position_id
//     → eerste call slaat trade op bij sluiting
//     → tweede call (ghost klaar) update alleen de ghost-velden
// ═══════════════════════════════════════════════════════════════

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Schema init — draait bij elke startup, veilig (IF NOT EXISTS) ──
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS closed_trades (
      id                  SERIAL PRIMARY KEY,
      position_id         TEXT        UNIQUE,          -- MT5 positie-ID (upsert sleutel)
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
      true_max_rr         NUMERIC,                     -- ghost tracker resultaat
      true_max_price      NUMERIC,                     -- beste prijs na sluiting
      ghost_stop_reason   TEXT,                        -- timeout / sl_breach / market_closed / failsafe
      ghost_finalized_at  TIMESTAMPTZ,
      session             TEXT,
      opened_at           TIMESTAMPTZ,
      closed_at           TIMESTAMPTZ DEFAULT NOW(),
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );

    -- Voeg nieuwe kolommen toe als ze nog niet bestaan (veilig bij upgrade van v3.7)
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS position_id        TEXT        UNIQUE;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_rr        NUMERIC;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS true_max_price     NUMERIC;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_stop_reason  TEXT;
    ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS ghost_finalized_at TIMESTAMPTZ;

    -- TP configuratie per symbool (auto-lock na 10 trades, update elke 10)
    CREATE TABLE IF NOT EXISTS tp_config (
      symbol          TEXT        PRIMARY KEY,
      locked_rr       NUMERIC     NOT NULL,
      locked_at       TIMESTAMPTZ DEFAULT NOW(),
      locked_trades   INTEGER     NOT NULL,
      prev_rr         NUMERIC,
      prev_locked_at  TIMESTAMPTZ,
      ev_at_lock      NUMERIC,
      auto_updated    BOOLEAN     DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS tp_update_log (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT        NOT NULL,
      old_rr      NUMERIC,
      new_rr      NUMERIC,
      trades      INTEGER,
      ev          NUMERIC,
      reason      TEXT,
      ts          TIMESTAMPTZ DEFAULT NOW()
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
  `);
  console.log("✅ [DB] Schema klaar (v3.8)");
}

// ── TRADES ────────────────────────────────────────────────────
// UPSERT op position_id:
//   - Nieuwe trade → volledige INSERT
//   - Ghost klaar  → update alleen de ghost-velden (trueMaxRR etc.)

async function saveTrade(trade) {
  const q = `
    INSERT INTO closed_trades
      (position_id, symbol, mt5_symbol, direction, entry, sl, tp, lots, risk_eur,
       max_price, max_rr, true_max_rr, true_max_price,
       ghost_stop_reason, ghost_finalized_at,
       session, opened_at, closed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
    trade.id             ?? null,          // position_id = MT5 positie-ID
    trade.symbol,
    trade.mt5Symbol      ?? null,
    trade.direction,
    trade.entry,
    trade.sl,
    trade.tp             ?? null,
    trade.lots           ?? null,
    trade.riskEUR        ?? null,
    trade.maxPrice       ?? null,
    trade.maxRR          ?? null,
    trade.trueMaxRR      ?? null,
    trade.trueMaxPrice   ?? null,
    trade.ghostStopReason   ?? null,
    trade.ghostFinalizedAt  ?? null,
    trade.session        ?? null,
    trade.openedAt       ?? null,
    trade.closedAt       ?? new Date().toISOString(),
  ];
  const res = await pool.query(q, vals);
  const isGhostUpdate = trade.trueMaxRR !== null && trade.trueMaxRR !== undefined;
  console.log(
    isGhostUpdate
      ? `👻 [DB] Ghost update: id=${res.rows[0].id} ${trade.symbol} trueMaxRR=${trade.trueMaxRR}`
      : `💾 [DB] Trade opgeslagen: id=${res.rows[0].id} ${trade.symbol} maxRR=${trade.maxRR}`
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
      closed_at           AS "closedAt"
    FROM closed_trades
    ORDER BY closed_at ASC
  `);
  console.log(`📂 [DB] ${res.rows.length} trades geladen uit Postgres`);
  return res.rows;
}

// ── EQUITY SNAPSHOTS ──────────────────────────────────────────
// Throttle DB writes naar elke 5 minuten om Postgres niet te overbelasten

let lastSnapshotSave = 0;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

async function saveSnapshot(snap) {
  const now = Date.now();
  if (now - lastSnapshotSave < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotSave = now;
  await pool.query(`
    INSERT INTO equity_snapshots (ts, balance, equity, floating_pl, margin, free_margin)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [
    snap.ts,
    snap.balance    ?? null,
    snap.equity     ?? null,
    snap.floatingPL ?? null,
    snap.margin     ?? null,
    snap.freeMargin ?? null,
  ]);
}

async function loadSnapshots(hours = 24) {
  const res = await pool.query(`
    SELECT
      ts,
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

// ── TP CONFIG ─────────────────────────────────────────────────
async function loadTPConfig() {
  try {
    const res = await pool.query(`SELECT * FROM tp_config ORDER BY symbol`);
    const map = {};
    for (const r of res.rows) {
      map[r.symbol] = {
        lockedRR:     parseFloat(r.locked_rr),
        lockedAt:     r.locked_at,
        lockedTrades: r.locked_trades,
        prevRR:       r.prev_rr ? parseFloat(r.prev_rr) : null,
        prevLockedAt: r.prev_locked_at,
        evAtLock:     r.ev_at_lock ? parseFloat(r.ev_at_lock) : null,
      };
    }
    console.log(`📊 [DB] ${res.rows.length} TP configs geladen`);
    return map;
  } catch (e) {
    console.warn("⚠️ loadTPConfig:", e.message);
    return {};
  }
}

async function saveTPConfig(symbol, lockedRR, lockedTrades, evAtLock, prevRR, prevLockedAt) {
  await pool.query(`
    INSERT INTO tp_config (symbol, locked_rr, locked_trades, ev_at_lock, prev_rr, prev_locked_at, locked_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (symbol) DO UPDATE SET
      prev_rr        = tp_config.locked_rr,
      prev_locked_at = tp_config.locked_at,
      locked_rr      = EXCLUDED.locked_rr,
      locked_trades  = EXCLUDED.locked_trades,
      ev_at_lock     = EXCLUDED.ev_at_lock,
      locked_at      = NOW()
  `, [symbol, lockedRR, lockedTrades, evAtLock ?? null, prevRR ?? null, prevLockedAt ?? null]);
}

async function logTPUpdate(symbol, oldRR, newRR, trades, ev, reason) {
  await pool.query(`
    INSERT INTO tp_update_log (symbol, old_rr, new_rr, trades, ev, reason)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [symbol, oldRR ?? null, newRR, trades, ev ?? null, reason]);
  console.log(`📝 [DB] TP log: ${symbol} ${oldRR ?? "nieuw"}R → ${newRR}R (${reason})`);
}

async function loadTPUpdateLog(limit = 50) {
  try {
    const res = await pool.query(`
      SELECT symbol,
             CAST(old_rr AS FLOAT) AS "oldRR",
             CAST(new_rr AS FLOAT) AS "newRR",
             trades,
             CAST(ev AS FLOAT) AS ev,
             reason, ts
      FROM tp_update_log ORDER BY ts DESC LIMIT $1
    `, [limit]);
    return res.rows;
  } catch (e) {
    console.warn("⚠️ loadTPUpdateLog:", e.message);
    return [];
  }
}

module.exports = { initDB, saveTrade, loadAllTrades, saveSnapshot, loadSnapshots, loadTPConfig, saveTPConfig, logTPUpdate, loadTPUpdateLog };
