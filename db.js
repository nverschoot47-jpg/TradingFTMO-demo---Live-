// ===============================================================
// db.js  v14.0  |  PRONTO-AI
//
// Changes v14.0:
//  - saveGhostTrade: ON CONFLICT DO NOTHING → UPSERT on position_id.
//    Fixes: ghost trades nooit gesloten in DB (closed_at, milestones, stopReason).
//  - ghost_state: phantom_sl_hit + stop_reason kolommen toegevoegd.
//    saveGhostState/loadAllGhostStates bijgewerkt. Restart behoudt nu ghost status.
//  - loadAllTrades: accepteert nu since/until/openFrom/openTo params voor filter.
//  - loadDailyBreakdown: vereenvoudigd — alleen Peak+RR, P&L, total lots, max win/loss.
//    Best/Worst 10 nu vanuit ghost_trades (peak_rr_pos) ipv closed_trades.
//  - loadGhostHistoryByPair: filtert nu op closed_at ipv opened_at.
//  - loadSignalLog (NIEUW): volledige signaallijst uit signal_log voor Signals tab.
//    Retourneert outcome per signaal: PLACED/VWAP_EXHAUSTION/DUPLICATE_POSITION/NY_DEAD_ZONE.
//  - Unique index op ghost_trades.position_id toegevoegd voor UPSERT.
//
// Changes v13.3:
//  - loadGhostHistoryByPair(from, to): accepteert nu optionele
//    from/to ISO datum strings voor selectieve datumfilter.
//    Standaard: from='2000-01-01' (geen compliance beperking).
//    rr_milestones per trade doorgegeven aan frontend.
//  - Compliance date restriction verwijderd uit EV_DATA_CUTOFF
//    default (wordt nu gezet via session.js naar 2000-01-01).
//
// Changes v12.6:
//  - saveLotOverride / loadLotOverrides gemarkeerd als deprecated dead code
//    en verwijderd uit module.exports. De functies worden omgedoopt naar
//    _saveLotOverride / _loadLotOverrides (private). De DB tabel blijft.
//    Achtergrond: lot overrides werden verwijderd in v11.0 (FIX R4).
//
//  - FIX GH2: ghost_state tabel krijgt extra kolommen voor risk/ev data:
//    risk_pct, risk_eur, ev_mult, day_mult via ADD COLUMN IF NOT EXISTS.
//    restorePositionsFromMT5() in server.js leest deze terug bij restart
//    zodat dashboard na restart correcte risk% toont voor herstelde posities.
//  - saveGhostState() accepteert nu ook riskPct, riskEUR, evMult, dayMult.
//  - loadAllGhostStates() retourneert nu ook riskPct, riskEUR, evMult, dayMult.
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

// FIX 8: COMPLIANCE_DATE from single source of truth (startup default)
const { COMPLIANCE_DATE: COMPLIANCE_DATE_DEFAULT } = require('./session');

// Live mutable compliance date — updated at startup from DB and via POST /compliance-date.
// One date controls everything: open trades, ghost, history, EV, signals.
// Default: session.js hardcoded value (2026-05-03). Override via DB or endpoint.
let COMPLIANCE_DATE = COMPLIANCE_DATE_DEFAULT;
let EV_DATA_CUTOFF  = COMPLIANCE_DATE_DEFAULT;  // unified — same date for all filters

// Update both live vars at once. Called by server.js on startup + via /compliance-date POST.
function setComplianceDateLive(isoStr) {
  COMPLIANCE_DATE = isoStr;
  EV_DATA_CUTOFF  = isoStr;
  console.log(`[ComplianceDate] Live updated → ${isoStr}`);
}
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

// DATABASE_URL: Railway injects this from the linked Postgres service.
// If the env var is the OLD database → auth fails → update DATABASE_URL in Railway Variables
// to point to Postgres-4ncL. The hardcoded string below is the fallback (internal Railway network).
// ⚠️  If you see "password authentication failed" → fix DATABASE_URL in Railway Variables tab.
const DB_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:fjugQtTywQsHUkMnmUfWxIaQBIYfelyb@postgres-4ncl.railway.internal:5432/railway';

// Log which DB we're connecting to (mask password for security)
const _dbUrlMasked = DB_URL.replace(/:([^:@]+)@/, ':***@');
console.log(`[DB] Connecting to: ${_dbUrlMasked}`);

const pool = new Pool({
  connectionString:        DB_URL,
  ssl:                     { rejectUnauthorized: false },
  max:                     8,     // explicit pool size (Railway free: max 10 connections)
  connectionTimeoutMillis: 15000, // 15s — Railway internal DNS can be slow on cold start
  idleTimeoutMillis:       30000, // keep connections alive longer
  statement_timeout:       10000, // 10s query timeout
});
// Log pool errors (e.g. connection drops)
pool.on('error', (err) => console.error('[DB Pool] Unexpected error:', err.message));

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── system_config ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        key        TEXT        PRIMARY KEY,
        value      TEXT        NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

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
      ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS sl_milestones   JSONB;
      ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS rr_milestones   JSONB;
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_key     ON ghost_trades (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_symbol  ON ghost_trades (symbol);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_closed  ON ghost_trades (closed_at);
      -- v14.1: ensure closed_at is populated for old ghost_trades that have stop_reason
      -- This runs once and is idempotent
      -- v14.1: Delete stock trades in asia/london sessions — historically impossible
      -- These were placed before session restriction or are mis-classified indexes
      -- Symbols: everything that symType returns as 'stock' (not in index/forex/commodity sets)
      DELETE FROM closed_trades
      WHERE session IN ('asia', 'london')
        AND symbol NOT IN (
          -- Known forex
          'AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD',
          'GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF',
          'USDJPY','EURGBP','GBPCHF','EURCAD','AUDCAD','EURNZD',
          -- Known indexes
          'DE30EUR','NAS100USD','UK100GBP','US30USD',
          'GER40.cash','US100.cash','UK100.cash','US30.cash',
          'NAS100','US100','UK100','US30','GER40','DE30','USTEC','SPX500','DAX',
          -- Known commodities
          'XAUUSD','XAGUSD','XAUEUR','GOLD','XAUUSD.cash','WTIUSD','BCOUSD','XTIUSD'
        );

      -- Auto-populate closed_at for old ghost trades that have stop_reason but no closed_at
      UPDATE ghost_trades 
        SET closed_at = CASE
          WHEN time_to_sl_min IS NOT NULL THEN opened_at + (time_to_sl_min * INTERVAL '1 minute')
          ELSE opened_at + INTERVAL '1 hour'
        END
        WHERE closed_at IS NULL 
          AND (phantom_sl_hit = TRUE OR stop_reason IS NOT NULL)
          AND opened_at IS NOT NULL;
      -- v14.1: Deduplicate ghost_trades BEFORE creating unique index
      -- Keep only the most complete row per position_id (prefer rows with closed_at, then latest id)
      DELETE FROM ghost_trades a USING ghost_trades b
        WHERE a.position_id = b.position_id
          AND a.position_id IS NOT NULL
          AND a.id < b.id;
      -- Now safe to create unique index
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ghost_trades_pos_id ON ghost_trades (position_id) WHERE position_id IS NOT NULL;
      -- Performance indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_closed_trades_opened  ON closed_trades (opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_closed_trades_session ON closed_trades (session, symbol);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_opened   ON ghost_trades (opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ghost_trades_optkey   ON ghost_trades (optimizer_key);
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
      -- FIX GH2 (v12.4): extra kolommen voor risk/ev data zodat dashboard na restart
      -- de juiste risk% toont voor herstelde posities (waren null na restart).
      ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS risk_pct  NUMERIC;
      ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS risk_eur  NUMERIC;
      ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS ev_mult   NUMERIC DEFAULT 1.0;
      ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS day_mult  NUMERIC DEFAULT 1.0;
      ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS sl_milestones JSONB DEFAULT '{}'::jsonb;
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
        id              SERIAL      PRIMARY KEY,
        ts              TIMESTAMPTZ DEFAULT NOW(),
        symbol          TEXT,
        direction       TEXT,
        session         TEXT,
        vwap_pos        TEXT,
        action          TEXT,
        status          TEXT,
        reason          TEXT,
        position_id     TEXT,
        entry           NUMERIC,
        sl              NUMERIC,
        tp              NUMERIC,
        lots            NUMERIC,
        risk_pct        NUMERIC,
        optimizer_key   TEXT,
        latency_ms      INTEGER,
        tv_entry        NUMERIC,
        execution_price NUMERIC,
        slippage        NUMERIC,
        vwap_band_pct   NUMERIC,
        session_high    NUMERIC,
        session_low     NUMERIC,
        day_high        NUMERIC,
        day_low         NUMERIC,
        bull_breaks     INTEGER,
        bear_breaks     INTEGER,
        sl_points       NUMERIC
      );
    `);

    // ── equity_curve ─────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS equity_curve (
        id          SERIAL      PRIMARY KEY,
        balance     NUMERIC     NOT NULL,
        equity      NUMERIC     NOT NULL,
        open_pnl    NUMERIC     DEFAULT 0,
        open_pos    INTEGER     DEFAULT 0,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_equity_curve_time ON equity_curve (recorded_at DESC);
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
        position_id     TEXT,
        session_high    NUMERIC,
        session_low     NUMERIC,
        day_high        NUMERIC,
        day_low         NUMERIC,
        bull_breaks     INTEGER,
        bear_breaks     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_signal_log_ts     ON signal_log (received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_log_sym    ON signal_log (symbol);
      CREATE INDEX IF NOT EXISTS idx_signal_log_key    ON signal_log (optimizer_key);
    `);

    // ── blocked_ghost_tracker (v13.4) ────────────────────────────
    // Invisible ghost tracker voor geblokkeerde signalen:
    // - NY_DEAD_ZONE: signalen geblokkeerd buiten tradingvenster
    // - DUPLICATE_POSITION: signalen geblokkeerd door dubbele positie
    // - VWAP_EXHAUSTION: signalen geblokkeerd door VWAP band > 150%
    // Elke blocked signal krijgt zijn eigen ghost die bijgehouden wordt
    // via de syncPositions cron, zodat we kunnen analyseren wat er zou
    // zijn gebeurd als we het signaal WEL hadden genomen.
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_ghost_tracker (
        id              SERIAL      PRIMARY KEY,
        block_type      TEXT        NOT NULL,   -- 'NY_DEAD_ZONE' | 'DUPLICATE' | 'VWAP_EXHAUSTION'
        optimizer_key   TEXT        NOT NULL,
        symbol          TEXT        NOT NULL,
        mt5_symbol      TEXT,
        session         TEXT        NOT NULL,
        direction       TEXT        NOT NULL,
        vwap_position   TEXT        DEFAULT 'unknown',
        entry           NUMERIC     NOT NULL,
        sl              NUMERIC     NOT NULL,
        sl_pct          NUMERIC,
        tp_rr_used      NUMERIC,
        max_price       NUMERIC,
        max_rr          NUMERIC     DEFAULT 0,
        max_sl_pct_used NUMERIC     DEFAULT 0,
        peak_rr_pos     NUMERIC     DEFAULT 0,
        peak_rr_neg     NUMERIC     DEFAULT 0,
        sl_milestones   JSONB       DEFAULT '{}'::jsonb,
        rr_milestones   JSONB       DEFAULT '{}'::jsonb,
        phantom_sl_hit  BOOLEAN     DEFAULT FALSE,
        stop_reason     TEXT,
        time_to_sl_min  INTEGER,
        vwap_band_pct   NUMERIC,            -- voor VWAP_EXHAUSTION
        block_reason    TEXT,               -- volledige reject reason string
        opened_at       TIMESTAMPTZ NOT NULL,
        closed_at       TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_bgt_key     ON blocked_ghost_tracker (optimizer_key);
      CREATE INDEX IF NOT EXISTS idx_bgt_type    ON blocked_ghost_tracker (block_type);
      CREATE INDEX IF NOT EXISTS idx_bgt_sym     ON blocked_ghost_tracker (symbol);
      CREATE INDEX IF NOT EXISTS idx_bgt_opened  ON blocked_ghost_tracker (opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bgt_closed  ON blocked_ghost_tracker (closed_at);
    `);

    // ── blocked_ghost_state (actieve invisible ghosts — persist over restart) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_ghost_state (
        id              TEXT        PRIMARY KEY,  -- uniek ID bijv. "BGT_<ts>_<key>"
        block_type      TEXT        NOT NULL,
        optimizer_key   TEXT        NOT NULL,
        symbol          TEXT        NOT NULL,
        mt5_symbol      TEXT,
        session         TEXT        NOT NULL,
        direction       TEXT        NOT NULL,
        vwap_position   TEXT        DEFAULT 'unknown',
        entry           NUMERIC     NOT NULL,
        sl              NUMERIC     NOT NULL,
        sl_pct          NUMERIC,
        tp_rr_used      NUMERIC,
        max_price       NUMERIC,
        max_rr          NUMERIC     DEFAULT 0,
        max_sl_pct_used NUMERIC     DEFAULT 0,
        peak_rr_pos     NUMERIC     DEFAULT 0,
        peak_rr_neg     NUMERIC     DEFAULT 0,
        sl_milestones   JSONB       DEFAULT '{}'::jsonb,
        rr_milestones   JSONB       DEFAULT '{}'::jsonb,
        vwap_band_pct   NUMERIC,
        block_reason    TEXT,
        opened_at       TIMESTAMPTZ NOT NULL,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

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

    // ── v12.5.1: trade_number sequence — created inside transaction (safe) ──
    // Individual ALTER TABLE columns moved outside transaction (see safeAlter below)
    // to prevent a single column-exists conflict from rolling back the entire schema.

    // ── ghost_combo_analysis — gecombineerde analyse per optimizer_key ──
    // Wordt herberekend telkens een ghost trade afgewerkt wordt voor die combo.
    // Bevat: best_sl_pct, best_tp_rr, win_rate, ev_score, sample_count, ...
    await client.query(`
      CREATE TABLE IF NOT EXISTS ghost_combo_analysis (
        optimizer_key     TEXT        PRIMARY KEY,
        symbol            TEXT        NOT NULL,
        session           TEXT        NOT NULL,
        direction         TEXT        NOT NULL,
        vwap_position     TEXT        NOT NULL DEFAULT 'unknown',
        sample_count      INTEGER     DEFAULT 0,
        ev_count          INTEGER     DEFAULT 0,
        best_sl_pct       NUMERIC,
        best_tp_rr        NUMERIC,
        win_rate          NUMERIC,
        ev_score          NUMERIC,
        avg_peak_rr_pos   NUMERIC,
        avg_peak_rr_neg   NUMERIC,
        max_peak_rr_pos   NUMERIC,
        max_peak_rr_neg   NUMERIC,
        avg_time_to_sl    NUMERIC,
        computed_at       TIMESTAMPTZ DEFAULT NOW()
      );
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

    // ── deals (FIX v12.4: gerealiseerde P&L per positie — MetaAPI history) ──
    // Wordt gevuld door saveDeal() na elke gesloten trade via /history-deals.
    // fetchRealizedPnl() raadpleegt eerst deze tabel, dan MetaAPI live.
    await client.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id            SERIAL      PRIMARY KEY,
        position_id   TEXT        NOT NULL,
        deal_id       TEXT        UNIQUE,
        symbol        TEXT,
        type          TEXT,
        profit        NUMERIC     DEFAULT 0,
        commission    NUMERIC     DEFAULT 0,
        swap          NUMERIC     DEFAULT 0,
        volume        NUMERIC,
        price         NUMERIC,
        time          TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_deals_position ON deals (position_id);
      CREATE INDEX IF NOT EXISTS idx_deals_time     ON deals (time DESC);
    `);

    await client.query("COMMIT");
    console.log("[DB] v12.6 schema OK");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DB] initDB ROLLBACK:", err.message);
    throw err;
  } finally {
    client.release();
  }

  // ── Safe additive migrations (outside main transaction) ────────
  // Each runs independently — a failure here does NOT roll back the
  // core schema above. ADD COLUMN IF NOT EXISTS is idempotent.
  const safeAlter = async (sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn('[DB] safe alter skipped:', e.message); }
  };

  // v12.5.1: trade_number sequence + columns
  await safeAlter(`CREATE SEQUENCE IF NOT EXISTS trade_number_seq START 1`);
  await safeAlter(`ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS trade_number INTEGER`);
  // ghost_trades: trade_number + peak RR columns
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS trade_number      INTEGER`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS peak_rr_pos       NUMERIC DEFAULT 0`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS peak_rr_neg       NUMERIC DEFAULT 0`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS realized_pnl_eur  NUMERIC`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS lots              NUMERIC`);
  // ghost_state: trade_number + peak RR + rr_milestones
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS trade_number     INTEGER`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS lots             NUMERIC`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS peak_rr_pos      NUMERIC DEFAULT 0`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS peak_rr_neg      NUMERIC DEFAULT 0`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS rr_milestones    JSONB DEFAULT '{}'::jsonb`);
  // v14.0: persist phantom_sl_hit and stop_reason so restart preserves ghost status
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS phantom_sl_hit   BOOLEAN DEFAULT FALSE`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS stop_reason      TEXT`);
  // ghost_state: risk/ev columns (FIX GH2)
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS risk_pct  NUMERIC`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS risk_eur  NUMERIC`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS ev_mult   NUMERIC DEFAULT 1.0`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS day_mult  NUMERIC DEFAULT 1.0`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS sl_milestones JSONB DEFAULT '{}'::jsonb`);
  // ── v14.2 migrations ─────────────────────────────────────────────────────
  // ghost_trades: all columns needed for full MT5 + milestone data storage
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS sl_hit_at        TIMESTAMPTZ`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS key_count         INTEGER DEFAULT 1`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS vwap_band_pct    NUMERIC`);
  // v14.7: exit_price, asset_type, trade_number on closed_trades
  await safeAlter(`ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS exit_price    NUMERIC`);
  await safeAlter(`ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS asset_type    TEXT`);
  await safeAlter(`ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS trade_number  INTEGER`);
  await safeAlter(`ALTER TABLE closed_trades ADD COLUMN IF NOT EXISTS mt5_comment   TEXT`);
  // v14.6: session/day context columns in webhook_history + signal_log
  await safeAlter(`ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS session_high  NUMERIC`);
  await safeAlter(`ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS session_low   NUMERIC`);
  await safeAlter(`ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS day_high      NUMERIC`);
  await safeAlter(`ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS day_low       NUMERIC`);
  await safeAlter(`ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS bull_breaks   INTEGER`);
  await safeAlter(`ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS bear_breaks   INTEGER`);
  await safeAlter(`ALTER TABLE webhook_history ADD COLUMN IF NOT EXISTS sl_points     NUMERIC`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS session_high       NUMERIC`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS session_low        NUMERIC`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_high           NUMERIC`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS day_low            NUMERIC`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS bull_breaks        INTEGER`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS asset_type         TEXT`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS bear_breaks        INTEGER`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS sl_milestones    JSONB`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS rr_milestones    JSONB`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS peak_rr_pos      NUMERIC DEFAULT 0`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS peak_rr_neg      NUMERIC DEFAULT 0`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS mt5_symbol       TEXT`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS type             TEXT`);
  await safeAlter(`ALTER TABLE ghost_trades ADD COLUMN IF NOT EXISTS sub_session      TEXT`);
  // ghost_state: same new fields
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS sl_hit_at       TIMESTAMPTZ`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS key_count        INTEGER DEFAULT 1`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS vwap_band_pct   NUMERIC`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS sub_session      TEXT`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS mt5_symbol       TEXT`);
  await safeAlter(`ALTER TABLE ghost_state ADD COLUMN IF NOT EXISTS type             TEXT`);
  // blocked_ghost_tracker: block_types TEXT[] for multi-block (VWAP+DUP at same time)
  // v14.2 stap1: NY_NIGHT and ASIA_MORNING are now stored as separate block types
  await safeAlter(`ALTER TABLE blocked_ghost_tracker ADD COLUMN IF NOT EXISTS block_types      TEXT[] DEFAULT '{}'::text[]`);
  // sub_session: NY_DEAD_ZONE|NY_NIGHT|ASIA_MORNING|VWAP_EXHAUSTION|DUPLICATE_POSITION
  await safeAlter(`ALTER TABLE blocked_ghost_tracker ADD COLUMN IF NOT EXISTS sub_session      TEXT`);
  await safeAlter(`ALTER TABLE blocked_ghost_tracker ADD COLUMN IF NOT EXISTS sl_hit_at        TIMESTAMPTZ`);
  await safeAlter(`ALTER TABLE blocked_ghost_tracker ADD COLUMN IF NOT EXISTS key_count         INTEGER DEFAULT 1`);
  await safeAlter(`ALTER TABLE blocked_ghost_tracker ADD COLUMN IF NOT EXISTS realized_pnl_eur  NUMERIC`);
  await safeAlter(`ALTER TABLE blocked_ghost_tracker ADD COLUMN IF NOT EXISTS lots              NUMERIC`);
  // blocked_ghost_state: same new fields
  await safeAlter(`ALTER TABLE blocked_ghost_state ADD COLUMN IF NOT EXISTS block_types      TEXT[] DEFAULT '{}'::text[]`);
  await safeAlter(`ALTER TABLE blocked_ghost_state ADD COLUMN IF NOT EXISTS sl_hit_at        TIMESTAMPTZ`);
  await safeAlter(`ALTER TABLE blocked_ghost_state ADD COLUMN IF NOT EXISTS key_count         INTEGER DEFAULT 1`);
  await safeAlter(`ALTER TABLE blocked_ghost_state ADD COLUMN IF NOT EXISTS lots              NUMERIC`);
  // signal_log: key_count + block_types for multi-block logging
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS key_count    INTEGER DEFAULT 1`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS block_types  TEXT[] DEFAULT '{}'::text[]`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS sub_session  TEXT`);
  await safeAlter(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS asset_type   TEXT`);
  console.log('[DB] Safe migrations complete — v14.2');
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
         exclude_from_ev, exit_price, asset_type, trade_number, mt5_comment)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
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
        exclude_from_ev    = EXCLUDED.exclude_from_ev,
        exit_price         = COALESCE(EXCLUDED.exit_price, closed_trades.exit_price),
        asset_type         = COALESCE(EXCLUDED.asset_type, closed_trades.asset_type),
        trade_number       = COALESCE(EXCLUDED.trade_number, closed_trades.trade_number)
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
      t.exitPrice      ?? null,   // actual fill price at close
      t.assetType      ?? null,   // forex/stock/index/commodity
      t.tradeNumber    ?? null,   // trade sequence number
      t.mt5Comment     ?? null,   // MT5 broker comment e.g. "EURUSD S-NY-BLW #5"
    ]);
  } catch (e) { console.warn("[!] saveTrade:", e.message); }
}

async function loadAllTrades({ since = null, until = null, openFrom = null, openTo = null } = {}) {
  // v14.1: supports date filtering for Overview tab filter
  // since/until = closed_at filter; openFrom/openTo = opened_at filter
  // When NO filter params given -> returns ALL trades (no WHERE restriction)
  try {
    const params = [];
    const where  = [];
    if (since)    { params.push(since);    where.push(`closed_at >= $${params.length}`); }
    if (until)    { params.push(until);    where.push(`closed_at <= $${params.length}`); }
    if (openFrom) { params.push(openFrom); where.push(`opened_at >= $${params.length}`); }
    if (openTo)   { params.push(openTo);   where.push(`opened_at <= $${params.length}`); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
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
        CAST(slippage       AS FLOAT) AS slippage,
        CAST(exit_price     AS FLOAT) AS "exitPrice",
        CAST(realized_pnl_eur AS FLOAT) AS "realizedPnl",
        asset_type          AS "assetType",
        trade_number        AS "tradeNumber",
        mt5_comment         AS "mt5Comment"
      FROM closed_trades
      ${whereClause}
      ORDER BY closed_at DESC
      LIMIT 10000
    `, params);
    return r.rows;
  } catch (e) { console.warn("[!] loadAllTrades:", e.message); return []; }
}

// ── ghost_trades ───────────────────────────────────────────────
async function saveGhostTrade(g) {
  // v14.0: UPSERT on position_id — ON CONFLICT DO NOTHING was silently dropping
  // all ghost close data (closed_at, stopReason, peak milestones) on repeated saves.
  // Now: INSERT on first save, UPDATE all mutable fields on conflict.
  try {
    await pool.query(`
      INSERT INTO ghost_trades
        (position_id, symbol, session, direction, vwap_position, optimizer_key,
         entry, sl, sl_pct, phantom_sl, tp_rr_used,
         max_price, max_rr_before_sl, phantom_sl_hit, stop_reason,
         time_to_sl_min, max_sl_pct_used, sl_milestones, rr_milestones,
         trade_number, peak_rr_pos, peak_rr_neg,
         realized_pnl_eur, lots, vwap_band_pct,
         opened_at, closed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
      ON CONFLICT (position_id) WHERE position_id IS NOT NULL
      DO UPDATE SET
        max_price        = EXCLUDED.max_price,
        max_rr_before_sl = EXCLUDED.max_rr_before_sl,
        phantom_sl_hit   = EXCLUDED.phantom_sl_hit,
        stop_reason      = EXCLUDED.stop_reason,
        time_to_sl_min   = EXCLUDED.time_to_sl_min,
        max_sl_pct_used  = EXCLUDED.max_sl_pct_used,
        sl_milestones    = EXCLUDED.sl_milestones,
        rr_milestones    = EXCLUDED.rr_milestones,
        peak_rr_pos      = EXCLUDED.peak_rr_pos,
        peak_rr_neg      = EXCLUDED.peak_rr_neg,
        realized_pnl_eur = COALESCE(EXCLUDED.realized_pnl_eur, ghost_trades.realized_pnl_eur),
        lots             = COALESCE(EXCLUDED.lots, ghost_trades.lots),
        trade_number     = COALESCE(EXCLUDED.trade_number, ghost_trades.trade_number),
        vwap_band_pct    = COALESCE(EXCLUDED.vwap_band_pct, ghost_trades.vwap_band_pct),
        closed_at        = EXCLUDED.closed_at
    `, [
      g.positionId      ?? null,
      g.symbol, g.session, g.direction,
      g.vwapPosition    ?? 'unknown',
      g.optimizerKey    ?? '',
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
      g.slMilestones    ? JSON.stringify(g.slMilestones) : null,
      g.rrMilestones    ? JSON.stringify(g.rrMilestones) : null,
      g.tradeNumber     ?? null,
      g.peakRRPos       ?? g.maxRRBeforeSL ?? 0,
      g.peakRRNeg       ?? g.maxSlPctUsed  ?? 0,
      g.realizedPnlEUR  ?? null,
      g.lots            ?? null,
      g.vwapBandPct     ?? null,
      g.openedAt        ?? null,
      g.closedAt        ?? null,
    ]);
  } catch (e) { console.warn('[!] saveGhostTrade:', e.message); }
}

async function loadGhostTrades(optimizerKey = null, limitRows = 200) {
  try {
    const vals = [];
    // FIX v12.2: verwijder phantom_sl_hit = TRUE filter — dit sloot alle andere
    // stop-redenen (timeout_2w, max_rr_15, timeout_72h, manual_deploy) uit.
    // Ghost history moet ALLE afgesloten ghosts tonen, ongeacht stop-reden.
    // closed_at IS NOT NULL = ghost is gefinaliseerd (niet meer actief).
    let where = "WHERE closed_at IS NOT NULL";
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
        sl_milestones        AS "slMilestones",
        rr_milestones        AS "rrMilestones",
        trade_number         AS "tradeNumber",
        CAST(peak_rr_pos     AS FLOAT) AS "peakRRPos",
        CAST(peak_rr_neg     AS FLOAT) AS "peakRRNeg",
        CAST(realized_pnl_eur AS FLOAT) AS "realizedPnlEUR",
        CAST(lots            AS FLOAT) AS lots,
        vwap_band_pct        AS "vwapBandPct",
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
      // FIX v12.2: use EV_DATA_CUTOFF (not COMPLIANCE_DATE) and include max_rr_15 ghosts.
      `SELECT COUNT(*) AS cnt FROM ghost_trades
       WHERE optimizer_key=$1
         AND closed_at IS NOT NULL
         AND max_rr_before_sl IS NOT NULL
         AND opened_at >= $2
         AND vwap_position IN ('above','below')
         AND (phantom_sl_hit = TRUE OR stop_reason = 'max_rr_15')`,
      [optimizerKey, EV_DATA_CUTOFF]
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
         latency_ms, tv_entry, execution_price, slippage, vwap_band_pct,
         session_high, session_low, day_high, day_low, bull_breaks, bear_breaks, sl_points)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    `, [
      w.symbol        ?? null, w.direction    ?? null, w.session    ?? null, w.vwapPos      ?? null,
      w.action        ?? null, w.status       ?? null, w.reason     ?? null, w.positionId   ?? null,
      w.entry         ?? null, w.sl           ?? null, w.tp         ?? null, w.lots         ?? null,
      w.riskPct       ?? null, w.optimizerKey ?? null,
      w.latencyMs     ?? null, w.tvEntry      ?? null, w.executionPrice ?? null,
      w.slippage      ?? null, w.vwapBandPct  ?? null,
      w.sessionHigh   ?? null, w.sessionLow   ?? null,
      w.dayHigh       ?? null, w.dayLow       ?? null,
      w.bullBreaks    ?? null, w.bearBreaks   ?? null, w.slPoints ?? null,
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
         vwap_band_pct, outcome, reject_reason, latency_ms, position_id,
         session_high, session_low, day_high, day_low, bull_breaks, bear_breaks, asset_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    `, [
      s.symbol         ?? null, s.direction    ?? null, s.session      ?? null,
      s.vwapPosition   ?? null, s.optimizerKey ?? null,
      s.tvEntry        ?? null, s.slPct        ?? null, s.slPctHuman   ?? null,
      s.vwap           ?? null, s.vwapUpper    ?? null, s.vwapLower    ?? null,
      s.vwapBandPct    ?? null, s.outcome      ?? null, s.rejectReason ?? null,
      s.latencyMs      ?? null, s.positionId   ?? null,
      s.sessionHigh    ?? null, s.sessionLow   ?? null,
      s.dayHigh        ?? null, s.dayLow       ?? null,
      s.bullBreaks     ?? null, s.bearBreaks   ?? null,
      s.assetType      ?? null,
    ]);
  } catch (e) { /* non-critical */ }
}

async function loadWebhookHistory(limit = 100, since = null, until = null) {
  try {
    const cutoff  = since ?? '2000-01-01';
    const ceiling = until ?? '2099-12-31';
    const r = await pool.query(`
      SELECT * FROM webhook_history
      WHERE ts >= $2 AND ts <= $3
      ORDER BY ts DESC LIMIT $1
    `, [limit, cutoff, ceiling]);
    return r.rows;
  } catch (e) { return []; }
}

// ── Signal stats — FIX 7 ───────────────────────────────────────
// Computes signal conversion ratio from signal_log table.
// Returns: total, placed, conversionPct, byOutcome, topRejectReasons
async function loadSignalStats({ since = null, until = null } = {}) {
  try {
    const cutoff  = since ?? '2000-01-01';
    const ceiling = until ?? '2099-12-31';
    const dateFilter = `received_at >= '${cutoff}' AND received_at <= '${ceiling}'`;
    const [totalR, byOutcomeR, rejectR, rejectSymR] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS cnt FROM signal_log WHERE ${dateFilter}`),
      pool.query(`
        SELECT outcome, COUNT(*) AS cnt
        FROM signal_log
        WHERE ${dateFilter}
        GROUP BY outcome
        ORDER BY cnt DESC
      `),
      pool.query(`
        SELECT reject_reason, COUNT(*) AS cnt
        FROM signal_log
        WHERE reject_reason IS NOT NULL AND reject_reason != ''
        AND ${dateFilter}
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

    // Count per outcome type
    const byOutcomeMap = {};
    for (const r of byOutcomeR.rows) byOutcomeMap[r.outcome] = parseInt(r.cnt, 10);
    const shadowN = (byOutcomeMap['NY_DEAD_ZONE']||0) + (byOutcomeMap['NY_NIGHT']||0) +
      (byOutcomeMap['ASIA_MORNING']||0) + (byOutcomeMap['VWAP_EXHAUSTION']||0) +
      (byOutcomeMap['DUPLICATE']||0);

    return {
      total:            totalN,
      placed:           placedN,
      shadow:           shadowN,
      conversionPct:    totalN > 0 ? parseFloat((placedN / totalN * 100).toFixed(2)) : 0,
      nyDead:           byOutcomeMap['NY_DEAD_ZONE']   ?? 0,
      nyNight:          byOutcomeMap['NY_NIGHT']       ?? 0,
      asiaMorning:      byOutcomeMap['ASIA_MORNING']   ?? 0,
      vwapExhaustion:   byOutcomeMap['VWAP_EXHAUSTION']?? 0,
      duplicate:        byOutcomeMap['DUPLICATE']      ?? 0,
      weekend:          byOutcomeMap['WEEKEND']        ?? 0,
      stockOOH:         byOutcomeMap['STOCK_OOH']      ?? 0,
      unknownSymbol:    byOutcomeMap['UNKNOWN_SYMBOL'] ?? 0,
      maxPositions:     byOutcomeMap['MAX_POSITIONS']  ?? 0,
      errors:           byOutcomeMap['ERROR']          ?? 0,
      byOutcome:        byOutcomeR.rows.map(r => ({ outcome: r.outcome, count: parseInt(r.cnt, 10) })),
      topRejectReasons: rejectR.rows.map(r => ({
        reason: r.reject_reason,
        count:  parseInt(r.cnt, 10),
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
        AND g.max_rr_before_sl IS NOT NULL
        AND g.max_rr_before_sl >= 0
        AND g.opened_at >= $2
        AND g.vwap_position IN ('above','below')
        AND (ct.exclude_from_ev IS NULL OR ct.exclude_from_ev = FALSE)
        AND (
          g.phantom_sl_hit = TRUE
          OR g.stop_reason IN ('max_rr_15', 'timeout_14d', 'gap_stop', 'phantom_sl')
          OR (g.closed_at IS NOT NULL AND g.stop_reason IS NOT NULL)
        )
    `, [optimizerKey, EV_DATA_CUTOFF]);

    // v14.1: ALL closed ghosts count — including direct SL-hits (maxRR < 0.5R).
    // These are real losses and must be in the denominator for accurate win rate + EV.
    // Excluding them inflated EV artificially.
    const rows = r.rows;
    if (rows.length < 1) return { key: optimizerKey, count: 0, rrLevels: [], bestRR: null, bestEV: null, avgRR: null, avgTimeToSLMin: null, avgMaxSlPct: null, bestWinnerSlPct: null };

    const arr      = rows.map(x => x.maxRR);
    const timings  = rows.map(x => x.timeToSL).filter(v => v != null);
    const slPcts   = rows.map(x => x.maxSlPct).filter(v => v != null);
    const avgTimeToSLMin = timings.length  ? Math.round(timings.reduce((s,v)=>s+v,0)/timings.length)   : null;
    const avgMaxSlPct    = slPcts.length   ? parseFloat((slPcts.reduce((s,v)=>s+v,0)/slPcts.length).toFixed(1)) : null;
    const avgRR          = arr.length      ? parseFloat((arr.reduce((s,v)=>s+v,0)/arr.length).toFixed(3)) : null;

    const levels = [];
    // v14.2: Start EV analysis from 0.1R — catches tight TP setups
    for (let rr = 0.1; rr <= 15.01; rr = parseFloat((rr + 0.1).toFixed(1))) {
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

// ── lot_overrides — DEPRECATED (verwijderd in v11.0 FIX R4) ──────
// lotDivisor en lot overrides werden verwijderd voor uniform 0.15% risk.
// Functies behouden voor backward compat (DB tabel bestaat nog), maar
// worden niet meer aangeroepen door server.js. Niet langer geëxporteerd.
// De lot_overrides DB tabel blijft aanwezig — verwijder pas bij schema reset.
async function _saveLotOverride(symbol, baseLots) {
  try {
    await pool.query(`
      INSERT INTO lot_overrides (symbol, base_lots, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (symbol) DO UPDATE SET base_lots=$2, updated_at=NOW()
    `, [symbol, baseLots]);
  } catch (e) { console.warn('[!] saveLotOverride:', e.message); }
}

async function _loadLotOverrides() {
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
// ── deals — gerealiseerde P&L opslaan (FIX v12.4) ─────────────
// Wordt aangeroepen door server.js na fetchHistoryDeals().
// deal: { positionId, dealId, symbol, type, profit, commission, swap, volume, price, time }
async function saveDeal(deal) {
  try {
    await pool.query(`
      INSERT INTO deals (position_id, deal_id, symbol, type, profit, commission, swap, volume, price, time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (deal_id) DO UPDATE SET
        profit     = EXCLUDED.profit,
        commission = EXCLUDED.commission,
        swap       = EXCLUDED.swap
    `, [
      deal.positionId ?? null,
      deal.dealId     ?? null,
      deal.symbol     ?? null,
      deal.type       ?? null,
      deal.profit     ?? 0,
      deal.commission ?? 0,
      deal.swap       ?? 0,
      deal.volume     ?? null,
      deal.price      ?? null,
      deal.time       ?? null,
    ]);
  } catch (e) { console.warn('[!] saveDeal:', e.message); }
}

// FIX v12.4: fetchRealizedPnl haalt nu profit+commission+swap op uit deals tabel.
// Als die tabel leeg is (nog geen deals voor deze positie), retourneert null.
// Caller (handlePositionClosed) valt dan terug op currentPnL.
async function fetchRealizedPnl(positionId) {
  try {
    const r = await pool.query(`
      SELECT
        SUM(CAST(profit     AS FLOAT)) AS profit,
        SUM(CAST(commission AS FLOAT)) AS commission,
        SUM(CAST(swap       AS FLOAT)) AS swap
      FROM deals
      WHERE position_id = $1
    `, [positionId]);
    const row = r.rows[0];
    if (!row || row.profit == null) return null;
    // Netto P&L = profit + commission + swap (commission en swap zijn negatief op FTMO)
    return parseFloat(((row.profit ?? 0) + (row.commission ?? 0) + (row.swap ?? 0)).toFixed(2));
  } catch {
    // deals tabel niet beschikbaar — non-critical, caller valt terug op currentPnL
    return null;
  }
}

// ── loadPerformanceSummary (v12.5: investeerder KPI's) ────────
// Retourneert win rate, profit factor, expectancy, max drawdown
// op basis van gesloten trades na compliance datum.
// Alleen trades met close_reason IN ('tp','sl') — geen manual.
async function loadPerformanceSummary() {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE hit_tp = TRUE)             AS tp_count,
        COUNT(*) FILTER (WHERE close_reason = 'sl')       AS sl_count,
        COALESCE(AVG(realized_pnl_eur) FILTER (WHERE hit_tp = TRUE), 0)          AS avg_winner,
        COALESCE(AVG(realized_pnl_eur) FILTER (WHERE close_reason = 'sl'), 0)    AS avg_loser,
        COALESCE(SUM(realized_pnl_eur) FILTER (WHERE hit_tp = TRUE), 0)          AS gross_wins,
        COALESCE(ABS(SUM(realized_pnl_eur) FILTER (WHERE close_reason = 'sl')), 0) AS gross_losses,
        COALESCE(SUM(realized_pnl_eur), 0)               AS total_pnl,
        COALESCE(AVG(realized_pnl_eur), 0)               AS avg_pnl_per_trade
      FROM closed_trades
      WHERE opened_at >= $1
        AND close_reason IN ('tp','sl')
        AND (exclude_from_ev IS NULL OR exclude_from_ev = FALSE)
    `, [EV_DATA_CUTOFF]);

    const row = r.rows[0];
    const total      = parseInt(row.total ?? 0);
    const tpCount    = parseInt(row.tp_count ?? 0);
    const slCount    = parseInt(row.sl_count ?? 0);
    const grossWins  = parseFloat(row.gross_wins   ?? 0);
    const grossLoss  = parseFloat(row.gross_losses ?? 0);
    const winRate    = total > 0 ? parseFloat((tpCount / total * 100).toFixed(1)) : 0;
    const profitFactor = grossLoss > 0 ? parseFloat((grossWins / grossLoss).toFixed(2)) : null;

    // Cumulatieve P&L reeks voor drawdown berekening
    const pnlR = await pool.query(`
      SELECT realized_pnl_eur, closed_at
      FROM closed_trades
      WHERE opened_at >= $1
        AND close_reason IN ('tp','sl')
        AND (exclude_from_ev IS NULL OR exclude_from_ev = FALSE)
        AND realized_pnl_eur IS NOT NULL
      ORDER BY closed_at ASC
    `, [EV_DATA_CUTOFF]);

    let maxDrawdown = 0, peak = 0, cumPnl = 0;
    const pnlCurve = [];
    for (const tr of pnlR.rows) {
      cumPnl += parseFloat(tr.realized_pnl_eur ?? 0);
      pnlCurve.push({ at: tr.closed_at, pnl: parseFloat(cumPnl.toFixed(2)) });
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    return {
      total, tpCount, slCount, winRate,
      avgWinner:     parseFloat(parseFloat(row.avg_winner ?? 0).toFixed(2)),
      avgLoser:      parseFloat(parseFloat(row.avg_loser  ?? 0).toFixed(2)),
      grossWins:     parseFloat(grossWins.toFixed(2)),
      grossLosses:   parseFloat(grossLoss.toFixed(2)),
      profitFactor,
      totalPnl:      parseFloat(parseFloat(row.total_pnl ?? 0).toFixed(2)),
      avgPnlPerTrade: parseFloat(parseFloat(row.avg_pnl_per_trade ?? 0).toFixed(2)),
      maxDrawdown:   parseFloat(maxDrawdown.toFixed(2)),
      pnlCurve:      pnlCurve.slice(-200), // max 200 punten voor grafiek
    };
  } catch (e) { console.warn('[!] loadPerformanceSummary:', e.message); return null; }
}

// ── loadMAEStats (v12.5: MAE percentiles per optimizer_key) ────
// Max Adverse Excursion analyse voor SL inkortings beslissingen.
// Gebaseerd op ghost_trades die NIET gestopt zijn door phantom SL
// (survivors = trades die doorgingen voorbij het drempel zonder geraakt te worden).
// Per key: p50 / p75 / p90 MAE — als p90 < 50% → halveren van SL is safe.
async function loadMAEStats(since) {
  try {
    const cutoff = since ?? EV_DATA_CUTOFF;
    const r = await pool.query(`
      SELECT
        optimizer_key                                               AS "optimizerKey",
        COUNT(*)                                                    AS n_total,
        COUNT(*) FILTER (WHERE phantom_sl_hit = FALSE
          AND stop_reason NOT IN ('real_sl_hit'))                   AS n_survivors,
        COUNT(*) FILTER (WHERE phantom_sl_hit = TRUE)               AS n_sl_hit,
        CAST(PERCENTILE_CONT(0.50) WITHIN GROUP(ORDER BY max_sl_pct_used)
             FILTER (WHERE phantom_sl_hit = FALSE
               AND stop_reason NOT IN ('real_sl_hit')) AS FLOAT)    AS mae_p50,
        CAST(PERCENTILE_CONT(0.75) WITHIN GROUP(ORDER BY max_sl_pct_used)
             FILTER (WHERE phantom_sl_hit = FALSE
               AND stop_reason NOT IN ('real_sl_hit')) AS FLOAT)    AS mae_p75,
        CAST(PERCENTILE_CONT(0.90) WITHIN GROUP(ORDER BY max_sl_pct_used)
             FILTER (WHERE phantom_sl_hit = FALSE
               AND stop_reason NOT IN ('real_sl_hit')) AS FLOAT)    AS mae_p90,
        CAST(AVG(max_sl_pct_used)
             FILTER (WHERE phantom_sl_hit = FALSE
               AND stop_reason NOT IN ('real_sl_hit')) AS FLOAT)    AS mae_avg
      FROM ghost_trades
      WHERE opened_at >= $1
        AND closed_at IS NOT NULL
        AND vwap_position IN ('above','below')
        AND max_sl_pct_used IS NOT NULL
      GROUP BY optimizer_key
      HAVING COUNT(*) >= 3
      ORDER BY optimizer_key
    `, [cutoff]);

    return r.rows.map(row => {
      const p90 = row.mae_p90 != null ? parseFloat(parseFloat(row.mae_p90).toFixed(1)) : null;
      // Aanbeveling: veilig halveren als p90 < 50%, inkorten naar 75% als p90 < 75%
      let slReduction = null;
      if (p90 != null) {
        if      (p90 < 40)  slReduction = { pct: 40,  label: '✅ SAFE: SL → 40%',  color: 'g' };
        else if (p90 < 50)  slReduction = { pct: 50,  label: '✅ SAFE: SL → 50%',  color: 'g' };
        else if (p90 < 65)  slReduction = { pct: 65,  label: '⚠ MILD: SL → 65%',  color: 'y' };
        else if (p90 < 80)  slReduction = { pct: 80,  label: '⚠ MILD: SL → 80%',  color: 'y' };
        else                slReduction = { pct: null, label: '❌ RISICO: houd SL',  color: 'r' };
      }
      return {
        optimizerKey:  row.optimizerKey,
        nTotal:        parseInt(row.n_total),
        nSurvivors:    parseInt(row.n_survivors ?? 0),
        nSLHit:        parseInt(row.n_sl_hit    ?? 0),
        maeP50:        row.mae_p50  != null ? parseFloat(parseFloat(row.mae_p50).toFixed(1))  : null,
        maeP75:        row.mae_p75  != null ? parseFloat(parseFloat(row.mae_p75).toFixed(1))  : null,
        maeP90:        p90,
        maeAvg:        row.mae_avg  != null ? parseFloat(parseFloat(row.mae_avg).toFixed(1))  : null,
        slReduction,
      };
    });
  } catch (e) { console.warn('[!] loadMAEStats:', e.message); return []; }
}

// ── loadGhostGrouped (v12.5: ghost info per optimizer_key voor grouped view) ──
// Gebruikt voor de "grouped" tab in ghost tracker: TP/SL info per combo.
// Retourneert actieve ghosts gegroepeerd per optimizer_key met TP + SL details.
async function loadGhostGrouped() {
  try {
    const r = await pool.query(`
      SELECT
        optimizer_key                                               AS "optimizerKey",
        symbol, session, direction,
        vwap_position                                               AS "vwapPosition",
        COUNT(*)                                                    AS n,
        COUNT(*) FILTER (WHERE phantom_sl_hit = FALSE
          AND stop_reason IS NULL)                                  AS n_open_estimate,
        CAST(AVG(CASE WHEN max_rr_before_sl IS NOT NULL
              THEN max_rr_before_sl END) AS FLOAT)                  AS avg_max_rr,
        CAST(MAX(CASE WHEN max_rr_before_sl IS NOT NULL
              THEN max_rr_before_sl END) AS FLOAT)                  AS best_max_rr,
        CAST(AVG(max_sl_pct_used) AS FLOAT)                         AS avg_sl_pct,
        CAST(AVG(tp_rr_used)      AS FLOAT)                         AS avg_tp_rr,
        CAST(AVG(CAST(sl_pct AS FLOAT)) AS FLOAT)                   AS avg_sl_dist_pct,
        MAX(opened_at)                                              AS last_opened,
        COUNT(*) FILTER (WHERE phantom_sl_hit = TRUE)               AS sl_hits
      FROM ghost_trades
      WHERE vwap_position IN ('above','below')
        AND (
          closed_at IS NOT NULL
          OR phantom_sl_hit = TRUE
          OR stop_reason IS NOT NULL
        )
      GROUP BY optimizer_key, symbol, session, direction, vwap_position
      ORDER BY last_opened DESC
      LIMIT 200
    `);

    return r.rows.map(row => ({
      optimizerKey:   row.optimizerKey,
      symbol:         row.symbol,
      session:        row.session,
      direction:      row.direction,
      vwapPosition:   row.vwapPosition,
      n:              parseInt(row.n),
      avgMaxRR:       row.avg_max_rr  != null ? parseFloat(parseFloat(row.avg_max_rr).toFixed(3)) : null,
      bestMaxRR:      row.best_max_rr != null ? parseFloat(parseFloat(row.best_max_rr).toFixed(3)) : null,
      avgSlPct:       row.avg_sl_pct  != null ? parseFloat(parseFloat(row.avg_sl_pct).toFixed(1)) : null,
      avgTpRR:        row.avg_tp_rr   != null ? parseFloat(parseFloat(row.avg_tp_rr).toFixed(2)) : null,
      avgSlDistPct:   row.avg_sl_dist_pct != null ? parseFloat(parseFloat(row.avg_sl_dist_pct).toFixed(3)) : null,
      slHits:         parseInt(row.sl_hits ?? 0),
      lastOpened:     row.last_opened,
    }));
  } catch (e) { console.warn('[!] loadGhostGrouped:', e.message); return []; }
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
// FIX GH2 (v12.4): risk_pct, risk_eur, ev_mult, day_mult meegestuurd zodat
// dashboard na restart de juiste risk% toont voor herstelde posities.
async function saveGhostState(g) {
  try {
    await pool.query(`
      INSERT INTO ghost_state
        (position_id, optimizer_key, symbol, mt5_symbol, session, direction,
         vwap_position, entry, sl, sl_pct, tp_rr_used, lots,
         max_price, max_rr, max_sl_pct_used, opened_at,
         risk_pct, risk_eur, ev_mult, day_mult,
         sl_milestones, rr_milestones,
         trade_number, peak_rr_pos, peak_rr_neg,
         phantom_sl_hit, stop_reason, vwap_band_pct,
         updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())
      ON CONFLICT (position_id) DO UPDATE SET
        max_price       = EXCLUDED.max_price,
        max_rr          = EXCLUDED.max_rr,
        max_sl_pct_used = EXCLUDED.max_sl_pct_used,
        risk_pct        = COALESCE(EXCLUDED.risk_pct,  ghost_state.risk_pct),
        risk_eur        = COALESCE(EXCLUDED.risk_eur,  ghost_state.risk_eur),
        ev_mult         = COALESCE(EXCLUDED.ev_mult,   ghost_state.ev_mult),
        day_mult        = COALESCE(EXCLUDED.day_mult,  ghost_state.day_mult),
        sl_milestones   = COALESCE(EXCLUDED.sl_milestones, ghost_state.sl_milestones),
        rr_milestones   = CASE 
          WHEN EXCLUDED.rr_milestones IS NOT NULL THEN EXCLUDED.rr_milestones
          ELSE ghost_state.rr_milestones 
        END,
        peak_rr_pos     = GREATEST(EXCLUDED.peak_rr_pos, ghost_state.peak_rr_pos),
        peak_rr_neg     = GREATEST(EXCLUDED.peak_rr_neg, ghost_state.peak_rr_neg),
        trade_number    = COALESCE(ghost_state.trade_number, EXCLUDED.trade_number),
        phantom_sl_hit  = EXCLUDED.phantom_sl_hit,
        stop_reason     = EXCLUDED.stop_reason,
        vwap_band_pct   = COALESCE(EXCLUDED.vwap_band_pct, ghost_state.vwap_band_pct),
        updated_at      = NOW()
    `, [
      g.positionId, g.optimizerKey, g.symbol, g.mt5Symbol ?? g.symbol,
      g.session, g.direction, g.vwapPosition ?? 'unknown',
      g.entry, g.sl, g.slPct ?? null, g.tpRRUsed ?? null, g.lots ?? null,
      g.maxPrice ?? g.entry, g.maxRR ?? 0, g.maxSlPctUsed ?? 0,
      g.openedAt ?? null,
      g.riskPct ?? null, g.riskEUR ?? null,
      g.evMult ?? 1.0, g.dayMult ?? 1.0,
      g.slMilestones && Object.keys(g.slMilestones).length > 0
        ? JSON.stringify(g.slMilestones) : null,
      g.rrMilestones && Object.keys(g.rrMilestones).length > 0
        ? JSON.stringify(g.rrMilestones) : null,
      g.tradeNumber ?? null,
      g.peakRRPos ?? g.maxRR ?? 0,
      g.peakRRNeg ?? g.maxSlPctUsed ?? 0,
      g.phantomSLHit ?? false,
      g.stopReason ?? null,
      g.vwapBandPct ?? null,
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
        CAST(lots             AS FLOAT) AS lots,
        CAST(max_price        AS FLOAT) AS "maxPrice",
        CAST(max_rr           AS FLOAT) AS "maxRR",
        CAST(max_sl_pct_used  AS FLOAT) AS "maxSlPctUsed",
        opened_at             AS "openedAt",
        CAST(risk_pct         AS FLOAT) AS "riskPct",
        CAST(risk_eur         AS FLOAT) AS "riskEUR",
        CAST(ev_mult          AS FLOAT) AS "evMult",
        CAST(day_mult         AS FLOAT) AS "dayMult",
        sl_milestones         AS "slMilestones",
        rr_milestones         AS "rrMilestones",
        trade_number          AS "tradeNumber",
        CAST(peak_rr_pos      AS FLOAT) AS "peakRRPos",
        CAST(peak_rr_neg      AS FLOAT) AS "peakRRNeg",
        COALESCE(phantom_sl_hit, FALSE) AS "phantomSLHit",
        stop_reason           AS "stopReason",
        CAST(vwap_band_pct    AS FLOAT) AS "vwapBandPct"
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
async function loadSignalRejects({ since = null, until = null } = {}) {
  try {
    const cutoff  = since ?? '2000-01-01';
    const ceiling = until ?? '2099-12-31';
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
        AND received_at <= $2
      GROUP BY outcome, symbol, direction, session, reject_reason
      ORDER BY count DESC
      LIMIT 500
    `, [cutoff, ceiling]);
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

// ── loadSignalLog (v14.0) — volledige signaallijst voor Signals tab ─
// Retourneert alle signalen (geplaatst + geblokkeerd) uit signal_log.
// Elke rij heeft: outcome → bepaalt bestemming (Ghost Tracker vs Shadow Playbook).
// Exclude puur technische errors (geen symbol of outcome = null).
async function loadSignalLog({ since = null, until = null, limit = 500 } = {}) {
  try {
    const cutoff  = since ?? '2000-01-01';
    const ceiling = until ?? '2099-12-31';
    const r = await pool.query(`
      SELECT
        received_at                  AS ts,
        symbol, direction, session,
        vwap_position                AS "vwap_position",
        optimizer_key                AS "optimizer_key",
        CAST(tv_entry AS FLOAT)      AS entry,
        CAST(sl_pct   AS FLOAT)      AS "sl_pct",
        CAST(vwap_band_pct AS FLOAT) AS "band_pct",
        outcome,
        reject_reason                AS reason,
        latency_ms,
        position_id,
        asset_type,
        session_high, session_low, day_high, day_low, bull_breaks
      FROM signal_log
      WHERE received_at >= $1
        AND received_at <= $2
        AND symbol IS NOT NULL
        AND outcome IS NOT NULL
        AND outcome NOT IN ('ERROR','FETCH_FAILED','MISSING_DATA')
      ORDER BY received_at DESC
      LIMIT 1000
    `, [cutoff, ceiling]);
    return r.rows;
  } catch (e) { console.warn('[!] loadSignalLog:', e.message); return []; }
}
// Geeft het volgende globale trade nummer terug (atomisch via sequence).
async function getNextTradeNumber() {
  try {
    const r = await pool.query(`SELECT nextval('trade_number_seq') AS num`);
    return parseInt(r.rows[0]?.num ?? 1, 10);
  } catch (e) {
    // Fallback: tel huidige closed_trades + open_positions
    try {
      const r2 = await pool.query(`SELECT COALESCE(MAX(trade_number),0)+1 AS num FROM closed_trades WHERE trade_number IS NOT NULL`);
      return parseInt(r2.rows[0]?.num ?? 1, 10);
    } catch { return Date.now() % 100000; }
  }
}

// Herlaad trade_number sequence zodat die na een deploy synchroon loopt
async function syncTradeNumberSequence() {
  try {
    await pool.query(`
      SELECT setval('trade_number_seq',
        COALESCE((SELECT MAX(trade_number) FROM closed_trades WHERE trade_number IS NOT NULL), 0) + 1,
        false)
    `);
  } catch (e) { console.warn('[TradeNum] sequence sync failed:', e.message); }
}

// ── Ghost Combo Analysis ──────────────────────────────────────
// Herbereken de gecombineerde analyse voor een optimizer_key
// op basis van ALLE afgewerkte ghost trades voor die combo.
// Wordt aangeroepen telkens een ghost finalizeert.
async function computeAndSaveGhostComboAnalysis(optimizerKey) {
  try {
    const r = await pool.query(`
      SELECT
        optimizer_key, symbol, session, direction, vwap_position,
        CAST(max_rr_before_sl  AS FLOAT) AS "maxRR",
        CAST(max_sl_pct_used   AS FLOAT) AS "maxSlPct",
        CAST(peak_rr_pos       AS FLOAT) AS "peakPos",
        CAST(peak_rr_neg       AS FLOAT) AS "peakNeg",
        CAST(tp_rr_used        AS FLOAT) AS "tpRR",
        phantom_sl_hit   AS "phantomSLHit",
        stop_reason      AS "stopReason",
        time_to_sl_min   AS "timeToSL",
        opened_at        AS "openedAt"
      FROM ghost_trades
      WHERE optimizer_key = $1
        AND closed_at IS NOT NULL
        AND opened_at >= $2
        AND vwap_position IN ('above','below')
      ORDER BY opened_at ASC
    `, [optimizerKey, COMPLIANCE_DATE]);

    const rows = r.rows;
    if (!rows.length) return null;

    const n = rows.length;
    const sym   = rows[0].optimizer_key?.split('_')[0] ?? '';
    const sess  = rows[0].session;
    const dir   = rows[0].direction;
    const vwap  = rows[0].vwap_position;

    // v14.1: ALL properly closed ghosts are EV-eligible (phantom_sl OR max_rr_15 OR timeout)
    // Direct SL-hits (maxRR < 0.5R) are real losses — count them.
    const evRows = rows.filter(g => g.phantomSLHit || g.stopReason === 'max_rr_15' || g.stopReason === 'timeout_14d');
    const evCount = evRows.length;

    const avgPeakPos = rows.reduce((s,g) => s+(g.peakPos??g.maxRR??0), 0) / n;
    const avgPeakNeg = rows.reduce((s,g) => s+(g.peakNeg??0), 0) / n;
    const maxPeakPos = Math.max(...rows.map(g => g.peakPos ?? g.maxRR ?? 0));
    const maxPeakNeg = Math.max(...rows.map(g => g.peakNeg ?? 0));

    const tSLRows = rows.filter(g => g.timeToSL != null);
    const avgTimeToSL = tSLRows.length > 0 ? tSLRows.reduce((s,g) => s+g.timeToSL, 0) / tSLRows.length : null;

    // Sweep TP RR levels from 0.5 to 15 to find best EV
    let bestTPRR = null, bestWR = 0, bestEV = -Infinity;
    for (let tp = 0.5; tp <= 15; tp += 0.5) {
      const wins = evRows.filter(g => (g.maxRR ?? 0) >= tp).length;
      const wr   = evCount > 0 ? wins / evCount : 0;
      const ev   = wr * tp - (1 - wr);
      if (ev > bestEV) { bestEV = ev; bestWR = wr; bestTPRR = tp; }
    }

    // Best SL: sweep maxSlPct percentiles
    const slPcts = evRows.map(g => g.maxSlPct ?? 100).sort((a,b) => a-b);
    const p90SL  = slPcts.length > 0 ? slPcts[Math.min(slPcts.length-1, Math.floor(0.9*slPcts.length))] : null;

    const analysis = {
      optimizerKey, symbol: sym, session: sess, direction: dir, vwapPosition: vwap,
      sampleCount: n, evCount,
      bestSlPct: p90SL, bestTpRr: bestTPRR,
      winRate: parseFloat((bestWR * 100).toFixed(2)),
      evScore: parseFloat(bestEV.toFixed(4)),
      avgPeakRrPos: parseFloat(avgPeakPos.toFixed(3)),
      avgPeakRrNeg: parseFloat(avgPeakNeg.toFixed(3)),
      maxPeakRrPos: parseFloat(maxPeakPos.toFixed(3)),
      maxPeakRrNeg: parseFloat(maxPeakNeg.toFixed(3)),
      avgTimeToSl: avgTimeToSL != null ? Math.round(avgTimeToSL) : null,
    };

    await pool.query(`
      INSERT INTO ghost_combo_analysis
        (optimizer_key, symbol, session, direction, vwap_position,
         sample_count, ev_count, best_sl_pct, best_tp_rr, win_rate, ev_score,
         avg_peak_rr_pos, avg_peak_rr_neg, max_peak_rr_pos, max_peak_rr_neg,
         avg_time_to_sl, computed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (optimizer_key) DO UPDATE SET
        sample_count    = EXCLUDED.sample_count,
        ev_count        = EXCLUDED.ev_count,
        best_sl_pct     = EXCLUDED.best_sl_pct,
        best_tp_rr      = EXCLUDED.best_tp_rr,
        win_rate        = EXCLUDED.win_rate,
        ev_score        = EXCLUDED.ev_score,
        avg_peak_rr_pos = EXCLUDED.avg_peak_rr_pos,
        avg_peak_rr_neg = EXCLUDED.avg_peak_rr_neg,
        max_peak_rr_pos = EXCLUDED.max_peak_rr_pos,
        max_peak_rr_neg = EXCLUDED.max_peak_rr_neg,
        avg_time_to_sl  = EXCLUDED.avg_time_to_sl,
        computed_at     = NOW()
    `, [
      analysis.optimizerKey, analysis.symbol, analysis.session,
      analysis.direction, analysis.vwapPosition,
      analysis.sampleCount, analysis.evCount,
      analysis.bestSlPct, analysis.bestTpRr,
      analysis.winRate, analysis.evScore,
      analysis.avgPeakRrPos, analysis.avgPeakRrNeg,
      analysis.maxPeakRrPos, analysis.maxPeakRrNeg,
      analysis.avgTimeToSl,
    ]);

    return analysis;
  } catch (e) {
    console.warn('[GhostCombo] computeAndSave:', e.message);
    return null;
  }
}

async function loadGhostComboAnalysis(optimizerKey = null) {
  try {
    const vals = [];
    let where = '';
    if (optimizerKey) { vals.push(optimizerKey); where = 'WHERE optimizer_key=$1'; }
    const r = await pool.query(`
      SELECT
        optimizer_key AS "optimizerKey", symbol, session, direction,
        vwap_position AS "vwapPosition",
        sample_count  AS "sampleCount",
        ev_count      AS "evCount",
        CAST(best_sl_pct     AS FLOAT) AS "bestSlPct",
        CAST(best_tp_rr      AS FLOAT) AS "bestTpRr",
        CAST(win_rate        AS FLOAT) AS "winRate",
        CAST(ev_score        AS FLOAT) AS "evScore",
        CAST(avg_peak_rr_pos AS FLOAT) AS "avgPeakRrPos",
        CAST(avg_peak_rr_neg AS FLOAT) AS "avgPeakRrNeg",
        CAST(max_peak_rr_pos AS FLOAT) AS "maxPeakRrPos",
        CAST(max_peak_rr_neg AS FLOAT) AS "maxPeakRrNeg",
        avg_time_to_sl AS "avgTimeToSl",
        computed_at    AS "computedAt"
      FROM ghost_combo_analysis
      ${where}
      ORDER BY sample_count DESC
    `, vals);
    return r.rows;
  } catch (e) { return []; }
}

// ── loadDailyBreakdown (v12.6: per-dag KPI's voor Overview tab) ──
async function loadDailyBreakdown() {
  try {
    // v14.1: closed_trades as base, LEFT JOIN ghost_trades for peak_rr enrichment
    const r = await pool.query(`
      SELECT
        DATE(ct.opened_at AT TIME ZONE 'Europe/Brussels')  AS trade_date,
        COUNT(*)                                            AS trades,
        COALESCE(SUM(CAST(ct.lots AS FLOAT)), 0)            AS total_lots,
        COALESCE(SUM(ct.realized_pnl_eur), 0)               AS day_pnl,
        MAX(COALESCE(gt.peak_rr_pos, ct.true_max_rr, ct.max_rr, 0)) AS best_peak_rr,
        MAX(ct.realized_pnl_eur)                            AS max_win,
        MIN(ct.realized_pnl_eur)                            AS max_loss
      FROM closed_trades ct
      LEFT JOIN ghost_trades gt ON gt.position_id = ct.position_id
      WHERE (ct.exclude_from_ev IS NULL OR ct.exclude_from_ev = FALSE)
      GROUP BY DATE(ct.opened_at AT TIME ZONE 'Europe/Brussels')
      ORDER BY trade_date DESC
    `);

    // Best/Worst 10: use closed_trades as base, enrich with ghost peak_rr_pos
    // This covers ALL 5000+ historical trades, not just the ones with ghost data
    const topR = await pool.query(`
      SELECT
        ct.symbol, ct.direction, ct.session,
        ct.vwap_position                                       AS "vwapPosition",
        CAST(COALESCE(gt.peak_rr_pos, ct.true_max_rr, ct.max_rr, 0) AS FLOAT) AS "peakRRPos",
        CAST(COALESCE(gt.peak_rr_neg, gt.max_sl_pct_used, 0)  AS FLOAT) AS "peakRRNeg",
        CAST(ct.realized_pnl_eur AS FLOAT)                     AS pnl,
        COALESCE(gt.stop_reason, ct.close_reason)              AS "stopReason",
        ct.opened_at                                           AS "openedAt"
      FROM closed_trades ct
      LEFT JOIN ghost_trades gt ON gt.position_id = ct.position_id
      WHERE (ct.exclude_from_ev IS NULL OR ct.exclude_from_ev = FALSE)
        AND COALESCE(gt.peak_rr_pos, ct.true_max_rr, ct.max_rr, 0) > 0
      ORDER BY COALESCE(gt.peak_rr_pos, ct.true_max_rr, ct.max_rr, 0) DESC NULLS LAST
      LIMIT 10
    `);

    const botR = await pool.query(`
      SELECT
        ct.symbol, ct.direction, ct.session,
        ct.vwap_position                                       AS "vwapPosition",
        CAST(COALESCE(gt.peak_rr_pos, ct.true_max_rr, ct.max_rr, 0) AS FLOAT) AS "peakRRPos",
        CAST(COALESCE(gt.peak_rr_neg, gt.max_sl_pct_used, 0)  AS FLOAT) AS "peakRRNeg",
        CAST(ct.realized_pnl_eur AS FLOAT)                     AS pnl,
        COALESCE(gt.stop_reason, ct.close_reason)              AS "stopReason",
        ct.opened_at                                           AS "openedAt"
      FROM closed_trades ct
      LEFT JOIN ghost_trades gt ON gt.position_id = ct.position_id
      WHERE (ct.exclude_from_ev IS NULL OR ct.exclude_from_ev = FALSE)
        AND ct.realized_pnl_eur IS NOT NULL
      ORDER BY ct.realized_pnl_eur ASC
      LIMIT 10
    `);

    // Supplement with ghost_trades data if closed_trades has no pnl (pnl=null)
    // This handles the case where syncPositions couldn't fetch deals
    const days = r.rows;
    if(days.every(d => !d.day_pnl || parseFloat(d.day_pnl) === 0)) {
      // Try ghost_trades grouped by day as fallback
      const gr = await pool.query(`
        SELECT
          DATE(opened_at AT TIME ZONE 'Europe/Brussels') AS trade_date,
          COUNT(*) AS trades,
          COALESCE(SUM(CAST(lots AS FLOAT)),0) AS total_lots,
          COALESCE(SUM(realized_pnl_eur),0) AS day_pnl,
          MAX(peak_rr_pos) AS best_peak_rr,
          MAX(realized_pnl_eur) AS max_win,
          MIN(realized_pnl_eur) AS max_loss
        FROM ghost_trades
        WHERE closed_at IS NOT NULL OR stop_reason IS NOT NULL
        GROUP BY DATE(opened_at AT TIME ZONE 'Europe/Brussels')
        ORDER BY trade_date DESC
      `).catch(()=>({rows:[]}));
      if(gr.rows.length > 0) {
        return { days: gr.rows, bestTrades: topR.rows, worstTrades: botR.rows };
      }
    }
    return {
      days:        days,
      bestTrades:  topR.rows,
      worstTrades: botR.rows,
    };
  } catch (e) { console.warn('[!] loadDailyBreakdown:', e.message); return null; }
}

// ── loadGhostHistoryByPair v14.2 ─────────────────────────────────
// Every finished ghost tracker = one trade row.
// Grouped per optimizer_key for EV analysis + detail dropdown.
// Principle: show ALL data, old trades with missing fields show —
async function loadGhostHistoryByPair(from, to) {
  try {
    const cutoff  = from ?? '2000-01-01';
    const ceiling = to   ?? '2099-12-31';

    const r = await pool.query(`
      SELECT
        id,
        COALESCE(
          optimizer_key,
          symbol||'_'||COALESCE(session,'unknown')||'_'||COALESCE(direction,'?')||'_'||COALESCE(vwap_position,'unknown')
        )                                                     AS "optimizerKey",
        symbol,
        COALESCE(session,   '?')                              AS session,
        COALESCE(direction, '?')                              AS direction,
        COALESCE(vwap_position, 'unknown')                    AS "vwapPosition",
        CAST(entry            AS FLOAT)                       AS entry,
        CAST(sl               AS FLOAT)                       AS sl,
        CAST(sl_pct           AS FLOAT)                       AS "slPct",
        CAST(tp_rr_used       AS FLOAT)                       AS "tpRRUsed",
        CAST(COALESCE(
          NULLIF(peak_rr_pos, 0),
          max_rr_before_sl,
          -- Reconstruct from max_price if available
          CASE WHEN max_price IS NOT NULL AND entry IS NOT NULL AND sl IS NOT NULL AND ABS(entry-sl)>0
               THEN ABS(max_price - entry) / ABS(entry - sl)
               ELSE NULL END,
          0
        ) AS FLOAT) AS "peakRRPos",
        CAST(COALESCE(NULLIF(peak_rr_neg, 0), max_sl_pct_used, 0) AS FLOAT) AS "peakRRNeg",
        CAST(COALESCE(NULLIF(max_rr_before_sl, 0), NULLIF(peak_rr_pos, 0), 0) AS FLOAT) AS "maxRR",
        CAST(COALESCE(max_sl_pct_used, peak_rr_neg, 0) AS FLOAT) AS "maxSlPct",
        CAST(COALESCE(realized_pnl_eur, 0) AS FLOAT)             AS "realizedPnlEUR",
        CAST(lots AS FLOAT)                                        AS lots,
        CAST(time_to_sl_min AS FLOAT)                          AS "timeToSL",
        phantom_sl_hit                                         AS "phantomSLHit",
        stop_reason                                            AS "stopReason",
        rr_milestones                                          AS "rrMilestones",
        sl_milestones                                          AS "slMilestones",
        opened_at                                              AS "openedAt",
        closed_at                                              AS "closedAt"
      FROM ghost_trades
      WHERE (
          $1 = '2000-01-01'
          OR closed_at >= $1
          OR (closed_at IS NULL AND opened_at >= $1)
        )
        AND (
          $2 = '2099-12-31'
          OR closed_at <= $2
          OR (closed_at IS NULL AND opened_at <= $2)
        )
      ORDER BY optimizer_key ASC, COALESCE(closed_at, opened_at) DESC
    `, [cutoff, ceiling]);

    // Group per optimizer_key
    const grouped = {};
    for (const row of r.rows) {
      const key = row.optimizerKey || (row.symbol + '_unknown');
      if (!grouped[key]) {
        grouped[key] = {
          optimizerKey:  key,
          symbol:        row.symbol,
          session:       row.session !== '?' ? row.session : null,
          direction:     row.direction !== '?' ? row.direction : null,
          vwapPosition:  row.vwapPosition !== 'unknown' ? row.vwapPosition : null,
          trades:        [],
          n:             0, nSLHit: 0, nMaxRR15: 0, nMaxDays: 0,
          nWithPeakRR:   0, nWithPnl: 0, nWithMilestones: 0,
          sumPeakPos:    0, sumPeakNeg: 0,
          maxPeakPos:    0, maxPeakNeg: 0,
          sumPnl:        0, _stopReasons: {},
        };
      }
      const g = grouped[key];
      // Backfill group fields from newer complete trades
      if (!g.session     && row.session     !== '?')       g.session     = row.session;
      if (!g.direction   && row.direction   !== '?')       g.direction   = row.direction;
      if (!g.vwapPosition && row.vwapPosition !== 'unknown') g.vwapPosition = row.vwapPosition;

      g.trades.push(row);
      g.n++;
      if (row.stopReason === 'phantom_sl' || row.stopReason === 'gap_stop' || row.phantomSLHit) g.nSLHit++;
      if (row.stopReason === 'max_rr_15')  g.nMaxRR15++;
      if ((row.stopReason||'').includes('timeout')) g.nMaxDays++;
      if (row.stopReason) g._stopReasons[row.stopReason] = (g._stopReasons[row.stopReason]||0)+1;
      if (row.rrMilestones && Object.keys(row.rrMilestones).length > 0) g.nWithMilestones++;

      const pp = parseFloat(row.peakRRPos ?? 0);
      const pn = parseFloat(row.peakRRNeg ?? 0);
      if (pp > 0) { g.sumPeakPos += pp; g.nWithPeakRR++; }
      if (pn > 0)   g.sumPeakNeg += pn;
      if (pp > g.maxPeakPos) g.maxPeakPos = pp;
      if (pn > g.maxPeakNeg) g.maxPeakNeg = pn;
      if (row.realizedPnlEUR != null) { g.sumPnl += parseFloat(row.realizedPnlEUR); g.nWithPnl++; }
    }

    // Finalize averages + EV estimate
    for (const g of Object.values(grouped)) {
      g.avgPeakPos   = g.nWithPeakRR > 0 ? parseFloat((g.sumPeakPos / g.nWithPeakRR).toFixed(3)) : 0;
      g.avgPeakNeg   = g.n > 0 ? parseFloat((g.sumPeakNeg / g.n).toFixed(3)) : 0;
      g.maxPeakPos   = parseFloat(g.maxPeakPos.toFixed(3));
      g.maxPeakNeg   = parseFloat(g.maxPeakNeg.toFixed(3));
      g.totalPnl     = g.nWithPnl > 0 ? parseFloat(g.sumPnl.toFixed(2)) : null;
      g.pctComplete  = g.n > 0 ? Math.round(g.nWithMilestones / g.n * 100) : 0;
      g.topStopReason = Object.entries(g._stopReasons).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? null;
      // EV estimate: (nSLHit as losses, rest as wins at avgPeakPos)
      if (g.n >= 3) {
        const winRate  = (g.n - g.nSLHit) / g.n;
        const bestTP   = g.avgPeakPos > 0 ? g.avgPeakPos : 1.0;
        g.evEstimate   = parseFloat(((winRate * bestTP) - (1 - winRate)).toFixed(3));
      } else {
        g.evEstimate = null;
      }
      const slPcts = g.trades.map(t => parseFloat(t.maxSlPct ?? 0)).filter(v => v > 0);
      g.avgSlPct = slPcts.length ? parseFloat((slPcts.reduce((s,v)=>s+v,0)/slPcts.length).toFixed(1)) : 0;
      delete g.sumPeakPos; delete g.sumPeakNeg; delete g.sumPnl;
      delete g.nWithPeakRR; delete g.nWithPnl; delete g.nWithMilestones;
      delete g._stopReasons;
    }

    return Object.values(grouped).sort((a, b) => b.n - a.n);
  } catch (e) { console.warn('[!] loadGhostHistoryByPair:', e.message); return []; }
}


async function loadBlockedRaw(since, until) {
  try {
    const cutoff  = since ?? '2000-01-01';
    const ceiling = until ?? '2099-12-31';
    const r = await pool.query(`
      SELECT
        symbol, direction,
        vwap_position AS "vwapPosition",
        session,
        reject_reason AS "rejectReason",
        outcome,
        COUNT(*)::INTEGER AS count,
        MAX(received_at)  AS "lastSeen"
      FROM signal_log
      WHERE outcome NOT IN ('PLACED')
        AND received_at >= $1
        AND received_at <= $2
      GROUP BY symbol, direction, vwap_position, session, reject_reason, outcome
      ORDER BY count DESC
      LIMIT 500
    `, [cutoff, ceiling]);
    return r.rows;
  } catch (e) { console.warn('[!] loadBlockedRaw:', e.message); return []; }
}

// ══════════════════════════════════════════════════════════════
//  BLOCKED GHOST TRACKER (v13.4)
//  Invisible ghost tracking voor NY_DEAD_ZONE, DUPLICATE, VWAP_EXHAUSTION
// ══════════════════════════════════════════════════════════════

// Sla een actieve blocked ghost op (persist over restart)
async function saveBlockedGhostState(g) {
  try {
    // blockTypes: array of all block reasons (a signal can be VWAP+DUP simultaneously)
    const blockTypes = g.blockTypes ?? (g.blockType ? [g.blockType] : []);
    await pool.query(`
      INSERT INTO blocked_ghost_state
        (id, block_type, block_types, optimizer_key, symbol, mt5_symbol, session, direction,
         vwap_position, entry, sl, sl_pct, tp_rr_used,
         max_price, max_rr, max_sl_pct_used, peak_rr_pos, peak_rr_neg,
         sl_milestones, rr_milestones, vwap_band_pct, block_reason,
         sl_hit_at, key_count, lots,
         opened_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,NOW())
      ON CONFLICT (id) DO UPDATE SET
        max_price       = EXCLUDED.max_price,
        max_rr          = EXCLUDED.max_rr,
        max_sl_pct_used = EXCLUDED.max_sl_pct_used,
        peak_rr_pos     = GREATEST(EXCLUDED.peak_rr_pos, blocked_ghost_state.peak_rr_pos),
        peak_rr_neg     = GREATEST(EXCLUDED.peak_rr_neg, blocked_ghost_state.peak_rr_neg),
        sl_milestones   = COALESCE(EXCLUDED.sl_milestones, blocked_ghost_state.sl_milestones),
        rr_milestones   = CASE
          WHEN EXCLUDED.rr_milestones IS NOT NULL THEN EXCLUDED.rr_milestones
          ELSE blocked_ghost_state.rr_milestones
        END,
        block_types     = EXCLUDED.block_types,
        sl_hit_at       = COALESCE(EXCLUDED.sl_hit_at, blocked_ghost_state.sl_hit_at),
        key_count       = EXCLUDED.key_count,
        lots            = COALESCE(EXCLUDED.lots, blocked_ghost_state.lots),
        updated_at      = NOW()
    `, [
      g.id, g.blockType, blockTypes,
      g.optimizerKey, g.symbol, g.mt5Symbol ?? g.symbol,
      g.session, g.direction, g.vwapPosition ?? 'unknown',
      g.entry, g.sl, g.slPct ?? null, g.tpRRUsed ?? null,
      g.maxPrice ?? g.entry, g.maxRR ?? 0, g.maxSlPctUsed ?? 0,
      g.peakRRPos ?? 0, g.peakRRNeg ?? 0,
      g.slMilestones && Object.keys(g.slMilestones).length > 0 ? JSON.stringify(g.slMilestones) : null,
      g.rrMilestones && Object.keys(g.rrMilestones).length > 0 ? JSON.stringify(g.rrMilestones) : null,
      g.vwapBandPct ?? null, g.blockReason ?? null,
      g.slHitAt ?? null, g.keyCount ?? 1, g.lots ?? null,
      g.openedAt,
    ]);
  } catch (e) { console.warn('[!] saveBlockedGhostState:', e.message); }
}

async function loadAllBlockedGhostStates() {
  try {
    const r = await pool.query(`
      SELECT
        id, block_type AS "blockType", block_types AS "blockTypes",
        optimizer_key AS "optimizerKey",
        symbol, mt5_symbol AS "mt5Symbol", session, direction,
        vwap_position AS "vwapPosition",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl,
        CAST(sl_pct AS FLOAT) AS "slPct",
        CAST(tp_rr_used AS FLOAT) AS "tpRRUsed",
        CAST(max_price AS FLOAT) AS "maxPrice",
        CAST(max_rr AS FLOAT) AS "maxRR",
        CAST(max_sl_pct_used AS FLOAT) AS "maxSlPctUsed",
        CAST(peak_rr_pos AS FLOAT) AS "peakRRPos",
        CAST(peak_rr_neg AS FLOAT) AS "peakRRNeg",
        sl_milestones AS "slMilestones",
        rr_milestones AS "rrMilestones",
        CAST(vwap_band_pct AS FLOAT) AS "vwapBandPct",
        block_reason AS "blockReason",
        sl_hit_at AS "slHitAt",
        key_count AS "keyCount",
        CAST(lots AS FLOAT) AS lots,
        opened_at AS "openedAt"
      FROM blocked_ghost_state
    `);
    return r.rows;
  } catch (e) { console.warn('[!] loadAllBlockedGhostStates:', e.message); return []; }
}

async function deleteBlockedGhostState(id) {
  try {
    await pool.query('DELETE FROM blocked_ghost_state WHERE id=$1', [id]);
  } catch (e) { console.warn('[!] deleteBlockedGhostState:', e.message); }
}

// Sla een afgesloten blocked ghost op in de history tabel
async function saveBlockedGhostTrade(g) {
  try {
    const blockTypes = g.blockTypes ?? (g.blockType ? [g.blockType] : []);
    await pool.query(`
      INSERT INTO blocked_ghost_tracker
        (block_type, block_types, optimizer_key, symbol, mt5_symbol, session, direction,
         vwap_position, entry, sl, sl_pct, tp_rr_used,
         max_price, max_rr, max_sl_pct_used, peak_rr_pos, peak_rr_neg,
         sl_milestones, rr_milestones, phantom_sl_hit, stop_reason,
         time_to_sl_min, vwap_band_pct, block_reason,
         sl_hit_at, key_count, lots, realized_pnl_eur,
         opened_at, closed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
    `, [
      g.blockType, blockTypes,
      g.optimizerKey, g.symbol, g.mt5Symbol ?? g.symbol,
      g.session, g.direction, g.vwapPosition ?? 'unknown',
      g.entry, g.sl, g.slPct ?? null, g.tpRRUsed ?? null,
      g.maxPrice ?? null, g.maxRR ?? 0, g.maxSlPctUsed ?? 0,
      g.peakRRPos ?? 0, g.peakRRNeg ?? 0,
      g.slMilestones ? JSON.stringify(g.slMilestones) : null,
      g.rrMilestones ? JSON.stringify(g.rrMilestones) : null,
      g.phantomSLHit ?? false, g.stopReason ?? null,
      g.timeToSLMin ?? null, g.vwapBandPct ?? null,
      g.blockReason ?? null,
      g.slHitAt ?? null, g.keyCount ?? 1, g.lots ?? null, g.realizedPnlEUR ?? null,
      g.openedAt, g.closedAt ?? new Date().toISOString(),
    ]);
  } catch (e) { console.warn('[!] saveBlockedGhostTrade:', e.message); }
}

// Laad blocked ghost history gegroepeerd per blockType + optimizerKey
async function loadBlockedGhostHistory(blockType, from, to) {
  try {
    const cutoff  = from ?? '2000-01-01';
    const ceiling = to   ?? '2099-12-31';
    // NY block includes NY_DEAD_ZONE + OUTSIDE_WINDOW (session is always 'ny' now)
    const safeType = (blockType||'NY_DEAD_ZONE').replace(/'/g,"''");
    // STAP 6 FIX: explicit text casts + include NY_NIGHT and ASIA_MORNING in timezone filter
    const blockFilter = (blockType === 'NY_DEAD_ZONE' || blockType === 'OUTSIDE_WINDOW'
                      || blockType === 'NY_NIGHT'     || blockType === 'ASIA_MORNING'
                      || blockType === 'TIMEZONE')
      ? `(block_type IN ('NY_DEAD_ZONE','NY_NIGHT','ASIA_MORNING','OUTSIDE_WINDOW','STOCK_OUTSIDE_MARKET')
          OR 'NY_DEAD_ZONE'::text   = ANY(COALESCE(block_types, ARRAY[block_type]::text[]))
          OR 'NY_NIGHT'::text       = ANY(COALESCE(block_types, ARRAY[block_type]::text[]))
          OR 'ASIA_MORNING'::text   = ANY(COALESCE(block_types, ARRAY[block_type]::text[]))
          OR 'OUTSIDE_WINDOW'::text = ANY(COALESCE(block_types, ARRAY[block_type]::text[])))`
      : blockType === 'DUPLICATE_POSITION'
      ? `(block_type = 'DUPLICATE_POSITION'
          OR 'DUPLICATE_POSITION'::text = ANY(COALESCE(block_types, ARRAY[block_type]::text[])))`
      : blockType === 'VWAP_EXHAUSTION'
      ? `(block_type = 'VWAP_EXHAUSTION'
          OR 'VWAP_EXHAUSTION'::text = ANY(COALESCE(block_types, ARRAY[block_type]::text[])))`
      : `block_type = '${safeType}'`;
    const r = await pool.query(`
      SELECT
        id,
        block_type                                    AS "blockType",
        COALESCE(block_types, ARRAY[block_type])      AS "blockTypes",
        optimizer_key                                 AS "optimizerKey",
        symbol, session, direction,
        vwap_position                                 AS "vwapPosition",
        CAST(entry           AS FLOAT)                AS entry,
        CAST(sl              AS FLOAT)                AS sl,
        CAST(sl_pct          AS FLOAT)                AS "slPct",
        CAST(tp_rr_used      AS FLOAT)                AS "tpRRUsed",
        CAST(max_rr          AS FLOAT)                AS "maxRR",
        CAST(max_sl_pct_used AS FLOAT)                AS "maxSlPct",
        CAST(peak_rr_pos     AS FLOAT)                AS "peakRRPos",
        CAST(peak_rr_neg     AS FLOAT)                AS "peakRRNeg",
        phantom_sl_hit                                AS "phantomSLHit",
        stop_reason                                   AS "stopReason",
        time_to_sl_min                                AS "timeToSL",
        rr_milestones                                 AS "rrMilestones",
        sl_milestones                                 AS "slMilestones",
        CAST(vwap_band_pct   AS FLOAT)                AS "vwapBandPct",
        block_reason                                  AS "blockReason",
        sl_hit_at                                     AS "slHitAt",
        key_count                                     AS "keyCount",
        CAST(lots            AS FLOAT)                AS lots,
        CAST(realized_pnl_eur AS FLOAT)               AS "realizedPnlEUR",
        opened_at                                     AS "openedAt",
        closed_at                                     AS "closedAt"
      FROM blocked_ghost_tracker
      WHERE ${blockFilter}
        AND opened_at >= $1
        AND opened_at <= $2
        AND closed_at IS NOT NULL
      ORDER BY optimizer_key ASC, opened_at DESC
    `, [cutoff, ceiling]);

    // Groepeer per optimizer_key
    const grouped = {};
    for (const row of r.rows) {
      const key = row.optimizerKey;
      if (!grouped[key]) grouped[key] = {
        optimizerKey: key, blockType: row.blockType,
        symbol: row.symbol, session: row.session,
        direction: row.direction, vwapPosition: row.vwapPosition,
        trades: [],
        n: 0, nSLHit: 0, nMaxRR15: 0,
        sumPeakPos: 0, sumPeakNeg: 0,
        maxPeakPos: 0, maxPeakNeg: 0,
      };
      const g = grouped[key];
      g.trades.push(row);
      g.n++;
      if (row.stopReason === 'phantom_sl' || row.phantomSLHit) g.nSLHit++;
      if (row.stopReason === 'max_rr_15') g.nMaxRR15++;
      const pp = parseFloat(row.peakRRPos ?? row.maxRR ?? 0);
      const pn = parseFloat(row.peakRRNeg ?? row.maxSlPct ?? 0);
      g.sumPeakPos += pp; g.sumPeakNeg += pn;
      if (pp > g.maxPeakPos) g.maxPeakPos = pp;
      if (pn > g.maxPeakNeg) g.maxPeakNeg = pn;
    }
    for (const g of Object.values(grouped)) {
      g.avgPeakPos = g.n > 0 ? parseFloat((g.sumPeakPos / g.n).toFixed(3)) : 0;
      g.avgPeakNeg = g.n > 0 ? parseFloat((g.sumPeakNeg / g.n).toFixed(3)) : 0;
      g.maxPeakPos = parseFloat(g.maxPeakPos.toFixed(3));
      g.maxPeakNeg = parseFloat(g.maxPeakNeg.toFixed(3));
      delete g.sumPeakPos; delete g.sumPeakNeg;
    }
    return Object.values(grouped).sort((a, b) => b.n - a.n);
  } catch (e) { console.warn('[!] loadBlockedGhostHistory:', e.message); return []; }
}

// Actieve blocked ghosts (open posities die worden gevolgd)
async function loadActiveBlockedGhosts() {
  try {
    const r = await pool.query(`
      SELECT
        id, block_type AS "blockType", optimizer_key AS "optimizerKey",
        symbol, mt5_symbol AS "mt5Symbol", session, direction,
        vwap_position AS "vwapPosition",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl,
        CAST(sl_pct AS FLOAT) AS "slPct",
        CAST(max_rr AS FLOAT) AS "maxRR",
        CAST(max_sl_pct_used AS FLOAT) AS "maxSlPctUsed",
        CAST(peak_rr_pos AS FLOAT) AS "peakRRPos",
        CAST(peak_rr_neg AS FLOAT) AS "peakRRNeg",
        sl_milestones AS "slMilestones",
        rr_milestones AS "rrMilestones",
        CAST(vwap_band_pct AS FLOAT) AS "vwapBandPct",
        block_reason AS "blockReason",
        opened_at AS "openedAt"
      FROM blocked_ghost_state
      ORDER BY opened_at DESC
    `);
    return r.rows;
  } catch (e) { console.warn('[!] loadActiveBlockedGhosts:', e.message); return []; }
}


async function saveComplianceDate(isoStr) {
  try {
    await pool.query(`
      INSERT INTO system_config (key, value, updated_at)
      VALUES ('compliance_date', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [isoStr]);
  } catch (e) { console.warn('[!] saveComplianceDate:', e.message); }
}

async function loadComplianceDate() {
  try {
    const r = await pool.query(`SELECT value FROM system_config WHERE key = 'compliance_date'`);
    return r.rows[0]?.value ?? null;
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// loadAllGhostsCombined — ghost_trades (closed) + ghost_state (active)
// This gives a complete picture of ALL ghost tracking ever done
// ═══════════════════════════════════════════════════════════════════
async function loadAllGhostsCombined(from, to) {
  try {
    const cutoff  = from ?? '2000-01-01';
    const ceiling = to   ?? '2099-12-31';
    // Get finished ghost trades
    const closedR = await pool.query(`
      SELECT
        position_id AS "positionId",
        COALESCE(optimizer_key, symbol||'_'||COALESCE(session,'?')||'_'||COALESCE(direction,'?')||'_'||COALESCE(vwap_position,'unknown'))
                                                              AS "optimizerKey",
        symbol, COALESCE(session,'?') AS session,
        COALESCE(direction,'?') AS direction,
        COALESCE(vwap_position,'unknown') AS "vwapPosition",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl,
        CAST(tp_rr_used AS FLOAT) AS "tpRRUsed",
        CAST(COALESCE(
          NULLIF(peak_rr_pos,0), max_rr_before_sl,
          CASE WHEN max_price IS NOT NULL AND entry IS NOT NULL AND sl IS NOT NULL AND ABS(entry-sl)>0
               THEN ABS(max_price-entry)/ABS(entry-sl) ELSE NULL END, 0
        ) AS FLOAT) AS "peakRRPos",
        CAST(COALESCE(NULLIF(peak_rr_neg,0), NULLIF(max_sl_pct_used,0), 0) AS FLOAT) AS "peakRRNeg",
        CAST(COALESCE(max_rr_before_sl, NULLIF(peak_rr_pos,0), 0) AS FLOAT) AS "maxRR",
        CAST(COALESCE(max_sl_pct_used, 0) AS FLOAT) AS "maxSlPct",
        CAST(COALESCE(realized_pnl_eur,0) AS FLOAT) AS "realizedPnlEUR",
        CAST(lots AS FLOAT) AS lots,
        phantom_sl_hit AS "phantomSLHit",
        stop_reason AS "stopReason",
        rr_milestones AS "rrMilestones",
        sl_milestones AS "slMilestones",
        opened_at AS "openedAt",
        closed_at AS "closedAt",
        FALSE AS "_active"
      FROM ghost_trades
      WHERE (
        $1 = '2000-01-01' OR closed_at >= $1
        OR (closed_at IS NULL AND opened_at >= $1)
      ) AND (
        $2 = '2099-12-31' OR closed_at <= $2
        OR (closed_at IS NULL AND opened_at <= $2)
      )
    `, [cutoff, ceiling]);

    // Get active ghost state entries (still running)
    const activeR = await pool.query(`
      SELECT
        position_id AS "positionId",
        COALESCE(optimizer_key, symbol||'_'||COALESCE(session,'?')||'_'||COALESCE(direction,'?')||'_'||COALESCE(vwap_position,'unknown'))
                                                              AS "optimizerKey",
        symbol, COALESCE(session,'?') AS session,
        COALESCE(direction,'?') AS direction,
        COALESCE(vwap_position,'unknown') AS "vwapPosition",
        CAST(entry AS FLOAT) AS entry, CAST(sl AS FLOAT) AS sl,
        CAST(tp_rr_used AS FLOAT) AS "tpRRUsed",
        CAST(COALESCE(NULLIF(peak_rr_pos,0), max_rr, 0) AS FLOAT) AS "peakRRPos",
        CAST(COALESCE(NULLIF(peak_rr_neg,0), NULLIF(max_sl_pct_used,0), 0) AS FLOAT) AS "peakRRNeg",
        CAST(COALESCE(max_rr, 0) AS FLOAT) AS "maxRR",
        CAST(COALESCE(max_sl_pct_used, 0) AS FLOAT) AS "maxSlPct",
        NULL AS "realizedPnlEUR",
        CAST(lots AS FLOAT) AS lots,
        phantom_sl_hit AS "phantomSLHit",
        stop_reason AS "stopReason",
        rr_milestones AS "rrMilestones",
        sl_milestones AS "slMilestones",
        opened_at AS "openedAt",
        NULL AS "closedAt",
        TRUE AS "_active"
      FROM ghost_state
      WHERE (
        $1 = '2000-01-01' OR opened_at IS NULL OR opened_at >= $1
      ) AND (
        $2 = '2099-12-31' OR opened_at IS NULL OR opened_at <= $2
      )
    `, [cutoff, ceiling]);

    // Combine: closed first, then active (closed have priority for data quality)
    const allRows = [...closedR.rows, ...activeR.rows];

    // Group by optimizer_key
    const grouped = {};
    for (const row of allRows) {
      const key = row.optimizerKey || (row.symbol + '_unknown');
      if (!grouped[key]) {
        grouped[key] = {
          optimizerKey: key,
          symbol: row.symbol,
          session: row.session !== '?' ? row.session : null,
          direction: row.direction !== '?' ? row.direction : null,
          vwapPosition: row.vwapPosition !== 'unknown' ? row.vwapPosition : null,
          trades: [], n: 0, nActive: 0,
          nSLHit: 0, nMaxRR15: 0, nMaxDays: 0,
          nWithPeakRR: 0, nWithPnl: 0, nWithMilestones: 0,
          sumPeakPos: 0, sumPeakNeg: 0, maxPeakPos: 0, maxPeakNeg: 0,
          sumPnl: 0, _stopReasons: {},
        };
      }
      const g = grouped[key];
      if (!g.session     && row.session     !== '?')        g.session     = row.session;
      if (!g.direction   && row.direction   !== '?')        g.direction   = row.direction;
      if (!g.vwapPosition && row.vwapPosition !== 'unknown') g.vwapPosition = row.vwapPosition;

      g.trades.push(row);
      g.n++;
      if (row._active) g.nActive++;
      if (row.stopReason === 'phantom_sl' || row.stopReason === 'gap_stop' || row.phantomSLHit) g.nSLHit++;
      if (row.stopReason === 'max_rr_15') g.nMaxRR15++;
      if ((row.stopReason||'').includes('timeout')) g.nMaxDays++;
      if (row.stopReason) g._stopReasons[row.stopReason] = (g._stopReasons[row.stopReason]||0)+1;
      if (row.rrMilestones && Object.keys(row.rrMilestones).length > 0) g.nWithMilestones++;
      const pp = parseFloat(row.peakRRPos ?? 0);
      const pn = parseFloat(row.peakRRNeg ?? 0);
      if (pp > 0) { g.sumPeakPos += pp; g.nWithPeakRR++; }
      if (pn > 0)   g.sumPeakNeg += pn;
      if (pp > g.maxPeakPos) g.maxPeakPos = pp;
      if (pn > g.maxPeakNeg) g.maxPeakNeg = pn;
      if (row.realizedPnlEUR != null && row.realizedPnlEUR !== 0) {
        g.sumPnl += parseFloat(row.realizedPnlEUR); g.nWithPnl++;
      }
    }

    for (const g of Object.values(grouped)) {
      g.avgPeakPos  = g.nWithPeakRR > 0 ? parseFloat((g.sumPeakPos/g.nWithPeakRR).toFixed(3)) : 0;
      g.avgPeakNeg  = g.n > 0 ? parseFloat((g.sumPeakNeg/g.n).toFixed(3)) : 0;
      g.maxPeakPos  = parseFloat(g.maxPeakPos.toFixed(3));
      g.maxPeakNeg  = parseFloat(g.maxPeakNeg.toFixed(3));
      g.totalPnl    = g.nWithPnl > 0 ? parseFloat(g.sumPnl.toFixed(2)) : null;
      g.pctComplete = g.n > 0 ? Math.round(g.nWithMilestones/g.n*100) : 0;
      g.topStopReason = Object.entries(g._stopReasons).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? null;
      if (g.n >= 3) {
        const winRate = (g.n - g.nSLHit) / g.n;
        const bestTP  = g.avgPeakPos > 0 ? g.avgPeakPos : 1.0;
        g.evEstimate  = parseFloat(((winRate*bestTP)-(1-winRate)).toFixed(3));
      } else { g.evEstimate = null; }
      const slPcts = g.trades.map(t=>parseFloat(t.maxSlPct??0)).filter(v=>v>0);
      g.avgSlPct = slPcts.length ? parseFloat((slPcts.reduce((s,v)=>s+v,0)/slPcts.length).toFixed(1)) : 0;
      delete g.sumPeakPos; delete g.sumPeakNeg; delete g.sumPnl;
      delete g.nWithPeakRR; delete g.nWithPnl; delete g.nWithMilestones;
      delete g._stopReasons;
    }
    return Object.values(grouped).sort((a,b) => b.n - a.n);
  } catch(e) { console.warn('[!] loadAllGhostsCombined:', e.message); return []; }
}

// ═══════════════════════════════════════════════════════════════════
// loadPerformanceStats — Sharpe, Profit Factor, Expectancy, Max Drawdown
// ═══════════════════════════════════════════════════════════════════
async function loadPerformanceStats(since = null) {
  try {
    const cutoff = since ?? '2000-01-01';
    const r = await pool.query(`
      SELECT
        COUNT(*)                                                    AS total,
        COUNT(*) FILTER (WHERE realized_pnl_eur > 0)               AS wins,
        COUNT(*) FILTER (WHERE realized_pnl_eur < 0)               AS losses,
        COUNT(*) FILTER (WHERE realized_pnl_eur = 0)               AS breakeven,
        COALESCE(SUM(realized_pnl_eur), 0)                         AS total_pnl,
        COALESCE(SUM(realized_pnl_eur) FILTER (WHERE realized_pnl_eur > 0), 0) AS gross_win,
        COALESCE(ABS(SUM(realized_pnl_eur) FILTER (WHERE realized_pnl_eur < 0)), 0) AS gross_loss,
        COALESCE(AVG(realized_pnl_eur), 0)                         AS avg_pnl,
        COALESCE(STDDEV(realized_pnl_eur), 0)                      AS stddev_pnl,
        COALESCE(MAX(realized_pnl_eur), 0)                         AS best_trade,
        COALESCE(MIN(realized_pnl_eur), 0)                         AS worst_trade,
        COALESCE(AVG(realized_pnl_eur) FILTER (WHERE realized_pnl_eur > 0), 0) AS avg_win,
        COALESCE(ABS(AVG(realized_pnl_eur) FILTER (WHERE realized_pnl_eur < 0)), 0) AS avg_loss
      FROM closed_trades
      WHERE opened_at >= $1
        AND realized_pnl_eur IS NOT NULL
        AND (exclude_from_ev IS NULL OR exclude_from_ev = FALSE)
    `, [cutoff]);
    const s = r.rows[0];
    const total = parseInt(s.total)||0, wins = parseInt(s.wins)||0, losses = parseInt(s.losses)||0;
    const grossWin = parseFloat(s.gross_win)||0, grossLoss = parseFloat(s.gross_loss)||0;
    const avgPnl = parseFloat(s.avg_pnl)||0, stddevPnl = parseFloat(s.stddev_pnl)||0;
    const profitFactor = grossLoss > 0 ? parseFloat((grossWin/grossLoss).toFixed(3)) : null;
    const winRate = total > 0 ? parseFloat((wins/total*100).toFixed(2)) : 0;
    const avgWin = parseFloat(s.avg_win)||0, avgLoss = parseFloat(s.avg_loss)||0;
    const winR = wins/Math.max(total,1), lossR = losses/Math.max(total,1);
    const expectancy = parseFloat(((winR*avgWin)-(lossR*avgLoss)).toFixed(2));
    const sharpe = stddevPnl > 0 ? parseFloat((avgPnl/stddevPnl*Math.sqrt(252)).toFixed(3)) : null;
    const ddR = await pool.query(`
      WITH daily AS (
        SELECT DATE(opened_at AT TIME ZONE 'Europe/Brussels') AS d, SUM(realized_pnl_eur) AS day_pnl
        FROM closed_trades WHERE opened_at>=$1 AND realized_pnl_eur IS NOT NULL
          AND (exclude_from_ev IS NULL OR exclude_from_ev=FALSE) GROUP BY d ORDER BY d
      ), cumulative AS (SELECT d, SUM(day_pnl) OVER (ORDER BY d) AS cum_pnl FROM daily),
      peak AS (SELECT d, cum_pnl, MAX(cum_pnl) OVER (ORDER BY d ROWS UNBOUNDED PRECEDING) AS running_peak FROM cumulative)
      SELECT COALESCE(MIN(cum_pnl-running_peak),0) AS max_drawdown FROM peak
    `, [cutoff]);
    const maxDrawdown = parseFloat(ddR.rows[0]?.max_drawdown||0);
    const totalPnl = parseFloat(s.total_pnl)||0;
    const calmar = maxDrawdown < 0 ? parseFloat((totalPnl/Math.abs(maxDrawdown)).toFixed(3)) : null;
    return { total, wins, losses, breakeven: parseInt(s.breakeven)||0, winRate,
      grossWin: parseFloat(grossWin.toFixed(2)), grossLoss: parseFloat(grossLoss.toFixed(2)),
      profitFactor, expectancy, sharpe, maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      calmar, totalPnl: parseFloat(totalPnl.toFixed(2)),
      bestTrade: parseFloat(s.best_trade||0), worstTrade: parseFloat(s.worst_trade||0),
      avgWin: parseFloat(avgWin.toFixed(2)), avgLoss: parseFloat(avgLoss.toFixed(2)) };
  } catch (e) { console.warn('[!] loadPerformanceStats:', e.message); return null; }
}

module.exports = {
  pool,
  initDB,
  // Trades
  saveTrade,
  loadAllTrades,
  loadAllGhostsCombined,
  loadPerformanceStats,
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
  // Lot overrides — DEPRECATED in v11.0, niet meer geëxporteerd
  // Key risk multipliers (FIX 19 + v10.6 evMult/dayMult)
  saveKeyRiskMult,
  loadKeyRiskMults,
  // Realized P&L (FIX 4 + v12.4: deals tabel)
  fetchRealizedPnl,
  saveDeal,
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
  loadSignalLog,        // v14.0: volledige signaallijst voor Signals tab
  // EV stats
  computeEVStats,
  loadPerformanceStats,
  // Shadow winners
  loadShadowWinners,
  // v12.5.1: trade numbering + ghost combo analysis
  getNextTradeNumber,
  syncTradeNumberSequence,
  computeAndSaveGhostComboAnalysis,
  loadGhostComboAnalysis,
  // v13.4: blocked ghost tracker
  saveBlockedGhostState,
  loadAllBlockedGhostStates,
  deleteBlockedGhostState,
  saveBlockedGhostTrade,
  loadBlockedGhostHistory,
  loadActiveBlockedGhosts,
  // v12.5: compliance date management
  setComplianceDateLive,
  saveComplianceDate,
  loadComplianceDate,
  // v12.5: nieuwe functies
  loadPerformanceSummary,
  loadMAEStats,
  loadGhostGrouped,
  // v12.6: daily breakdown, ghost history per pair, blocked raw
  loadDailyBreakdown,
  loadEquityCurve: async (limit=200) => {
    try {
      const r = await pool.query(
        'SELECT balance,equity,open_pnl AS "openPnl",open_pos AS "openPos",recorded_at AS "recordedAt" FROM equity_curve ORDER BY recorded_at DESC LIMIT $1',
        [limit]);
      return r.rows.reverse(); // oldest first for chart
    } catch { return []; }
  },
  loadGhostHistoryByPair,
  loadBlockedRaw,
}; 
