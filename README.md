# PRONTO-AI v2.0 — Deploy Guide

## Railway Environment Variables (required)

| Variable          | Value                                      | Description                    |
|-------------------|--------------------------------------------|--------------------------------|
| `DATABASE_URL`    | (auto-set by Railway Postgres plugin)      | PostgreSQL connection string   |
| `WEBHOOK_SECRET`  | your-secret-here                           | TradingView webhook auth       |
| `META_API_TOKEN`  | your-metaapi-token                         | MetaAPI auth token             |
| `META_ACCOUNT`    | your-metaapi-account-id                    | MetaAPI account ID             |
| `META_BASE`       | https://mt-client-api-v1.agiliumtrade.ai   | MetaAPI endpoint (check region)|
| `PORT`            | 3000                                       | Auto-set by Railway            |

## TradingView Webhook Format

Send to: `https://your-app.railway.app/webhook`

Headers: `x-webhook-secret: your-secret-here`

Body:
```json
{
  "action": "buy",
  "symbol": "XAUUSD",
  "close": 2345.00,
  "sl_pct": 0.003,
  "sl_points": 10.55,
  "vwap": 2330.50,
  "vwap_upper": 2352.40,
  "vwap_lower": 2308.60,
  "session_high": 2350.20,
  "session_low": 2318.40,
  "day_high": 2358.80,
  "day_low": 2301.20
}
```

Accepted symbols: XAUUSD, US100.cash (and aliases: GOLD, NAS100, NAS100USD, etc.)
All other symbols → blocked, logged with SYMBOL_NOT_ALLOWED

## Files

- `session.js` — Symbol catalog, SL buffer, time helpers
- `db.js`      — PostgreSQL schema + all DB functions
- `server.js`  — Express server, webhook, MetaAPI, ghost tracker, dashboard

## Database Tables

| Table           | Contents                                        |
|-----------------|-------------------------------------------------|
| `signal_log`    | Every webhook (PLACED + blocked)                |
| `closed_trades` | MT5 positions closed (TP or SL)                 |
| `ghost_state`   | Active ghost trackers (restart-safe)            |
| `ghost_trades`  | Finalized ghosts (phantom SL hit)               |
| `equity_curve`  | Balance/equity snapshots every 5min             |
| `daily_counter` | Per-day trade counter for daily labels          |

## Ghost Tracker Logic

1. Webhook → order placed → ghost started
2. Sync every 5s via MetaAPI → update milestones (-1.0R to +20R per 0.1R)
3. MT5 TP hit → close MT5 position → ghost keeps running
4. MT5 SL hit → close MT5 position → ghost finalizes (phantom SL = MT5 SL)
5. Phantom SL (price crosses SL while ghost active) → finalize ghost
6. All ADV milestones (-0.1 to -1.0) backfilled proportionally on finalize

## Deploy Steps

1. Create new Railway project
2. Add PostgreSQL plugin → DATABASE_URL auto-set
3. Push this repo → Railway deploys
4. Set env vars in Railway dashboard
5. Check /health endpoint
6. Send test webhook
