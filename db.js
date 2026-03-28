// ═══════════════════════════════════════════════════════════════
// db.js — PostgreSQL persistence layer
// Railway: voeg Postgres plugin toe → DATABASE_URL wordt auto-gezet
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
      id            SERIAL PRIMARY KEY,
      symbol        TEXT        NOT NULL,
      mt5_symbol    TEXT,
      direction     TEXT        NOT NULL,
      entry         NUMERIC     NOT NULL,
      sl            NUMERIC     NOT NULL,
      tp            NUMERIC,
      lots          NUMERIC,
      risk_eur      NUMERIC,
      max_price     NUMERIC,
      max_rr        NUMERIC,
      session       TEXT,
      opened_at     TIMESTAMPTZ,
      closed_at     TIMESTAMPTZ DEFAULT NOW(),
      created_at    TIMESTAMPTZ DEFAULT NOW()
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

    CREATE INDEX IF NOT EXISTS idx_trades_symbol   ON closed_trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_closed   ON closed_trades(closed_at);
    CREATE INDEX IF NOT EXISTS idx_trades_session  ON closed_trades(session);
    CREATE INDEX IF NOT EXISTS idx_equity_ts       ON equity_snapshots(ts);
  `);
  console.log("✅ [DB] Schema klaar");
}

// ── TRADES ────────────────────────────────────────────────────

async function saveTrade(trade) {
  const q = `
    INSERT INTO closed_trades
      (symbol, mt5_symbol, direction, entry, sl, tp, lots, risk_eur,
       max_price, max_rr, session, opened_at, closed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id
  `;
  const vals = [
    trade.symbol,
    trade.mt5Symbol    ?? null,
    trade.direction,
    trade.entry,
    trade.sl,
    trade.tp           ?? null,
    trade.lots         ?? null,
    trade.riskEUR      ?? null,
    trade.maxPrice     ?? null,
    trade.maxRR        ?? null,
    trade.session      ?? null,
    trade.openedAt     ?? null,
    trade.closedAt     ?? new Date().toISOString(),
  ];
  const res = await pool.query(q, vals);
  console.log(`💾 [DB] Trade opgeslagen: id=${res.rows[0].id} ${trade.symbol} maxRR=${trade.maxRR}`);
  return res.rows[0].id;
}

async function loadAllTrades() {
  const res = await pool.query(`
    SELECT
      symbol, mt5_symbol AS "mt5Symbol", direction,
      CAST(entry     AS FLOAT) AS entry,
      CAST(sl        AS FLOAT) AS sl,
      CAST(tp        AS FLOAT) AS tp,
      CAST(lots      AS FLOAT) AS lots,
      CAST(risk_eur  AS FLOAT) AS "riskEUR",
      CAST(max_price AS FLOAT) AS "maxPrice",
      CAST(max_rr    AS FLOAT) AS "maxRR",
      session,
      opened_at AS "openedAt",
      closed_at AS "closedAt"
    FROM closed_trades
    ORDER BY closed_at ASC
  `);
  console.log(`📂 [DB] ${res.rows.length} trades geladen uit Postgres`);
  return res.rows;
}

// ── EQUITY SNAPSHOTS ──────────────────────────────────────────
// Sla elke 30s snapshot op maar throttle DB writes naar elke 5 minuten
// om Postgres niet te overbelasten.

let lastSnapshotSave = 0;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minuten

async function saveSnapshot(snap) {
  const now = Date.now();
  if (now - lastSnapshotSave < SNAPSHOT_INTERVAL_MS) return; // throttle
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

module.exports = { initDB, saveTrade, loadAllTrades, saveSnapshot, loadSnapshots };