# FTMO Webhook Server v3.4
**TradingView → MetaApi REST → FTMO MT5**
*Nick Verschoot — PRONTO-AI*

---

## Bestanden

| Bestand | Omschrijving |
|---|---|
| `webhook.js` | Hoofdserver — alle logica |
| `db.js` | PostgreSQL persistence layer |
| `session.js` | Sessie detectie (Asia / London / NY) |
| `package.json` | Dependencies |

---

## Setup

### 1. Railway — Postgres toevoegen
Railway dashboard → jouw project → **+ New** → **Database** → **PostgreSQL**
`DATABASE_URL` wordt automatisch als environment variable gezet.

### 2. Environment Variables

| Variable | Standaard | Omschrijving |
|---|---|---|
| `META_API_TOKEN` | — | MetaApi token (verplicht) |
| `META_ACCOUNT_ID` | — | MetaApi account ID (verplicht) |
| `WEBHOOK_SECRET` | `FtmoNV2025` | Secret voor TradingView alerts |
| `ACCOUNT_BALANCE` | `10000` | Startbalans voor FTMO berekeningen |
| `DATABASE_URL` | — | Auto-gezet door Railway Postgres plugin |
| `RISK_INDEX` | `200` | Risico per indextrade (EUR) |
| `RISK_FOREX` | `15` | Risico per forextrade (EUR) |
| `RISK_GOLD` | `30` | Risico per goudtrade (EUR) |
| `RISK_CRYPTO` | `30` | Risico per cryptotrade (EUR) |
| `RISK_STOCK` | `30` | Risico per aandelentrade (EUR) |
| `RISK_MINLOT_CAP` | `60` | Max risico bij min-lot fallback (EUR) |

---

## TradingView Alert instellen

**Webhook URL:**
```
https://jouw-railway-url.railway.app/webhook?secret=FtmoNV2025
```

**Alert bericht (JSON):**
```json
{
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "entry":  "{{close}}",
  "sl":     "1.23456"
}
```

> `action` accepteert: `buy` / `sell` / `bull` / `bear` / `long` / `short`

---

## Endpoints

### Trading
| Methode | Endpoint | Omschrijving |
|---|---|---|
| `POST` | `/webhook?secret=...` | TradingView alert ontvangen → order plaatsen |
| `POST` | `/close` | Positie manueel sluiten |

### Monitoring
| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/` | Health check + alle instellingen |
| `GET` | `/status` | Open trades + FTMO limieten |
| `GET` | `/live/positions` | Live posities met P&L + max RR |
| `GET` | `/history` | Laatste 200 webhook events |

### Analyse
| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/analysis/rr` | Max RR per symbool (gesloten trades) |
| `GET` | `/analysis/rr?symbol=GBPUSD` | Max RR voor één symbool |
| `GET` | `/analysis/sessions` | EV + maxRR per symbool per sessie |
| `GET` | `/analysis/sessions?symbol=GBPUSD` | Sessie analyse voor één pair |
| `GET` | `/analysis/sessions?session=london` | Alle pairs voor één sessie |
| `GET` | `/analysis/equity-curve` | Equity curve laatste 24u |
| `GET` | `/analysis/equity-curve?hours=168` | Equity curve laatste 7 dagen |

### TP Optimizer
| Methode | Endpoint | Omschrijving |
|---|---|---|
| `GET` | `/research/tp-optimizer` | Beste TP per symbool op basis van EV |
| `POST` | `/research/tp-optimizer/apply?secret=...` | Pas TP_RR_BY_SYMBOL aan (≥10 trades, EV>0) |

---

## Logica

### Risico & Lot berekening
- Risico per trade is vast in EUR per type (zie env vars)
- Lots worden berekend op basis van SL-afstand: `lots = riskEUR / (slDist × lotValue)`
- Forex hard cap: **max 0.25 lot**
- Anti-consolidatie: elke extra trade in dezelfde richting op hetzelfde symbool halveert het risico (vloer = 10% van basis)

### Take Profit (TP)
- **Indices**: automatisch via `TP_RR_BY_SYMBOL` (standaard 3R)
- **Forex**: automatisch via `TP_RR_BY_SYMBOL` (standaard 2R)
- **Gold / Crypto / Stocks**: geen auto-TP — manueel sluiten
- TP wordt nachtelijk geoptimaliseerd (03:00 CET) op basis van historische data
- Na een `apply` worden open posities in MT5 direct bijgewerkt

### Auto-close
| Trigger | Wat |
|---|---|
| Vrijdag 22:50 CET | Alle posities gesloten (weekend) |
| Werkdag 20:50 CET | Alleen aandelen gesloten |

### Marktvensters
| Type | Venster |
|---|---|
| Forex | Ma–Vr 24u |
| Crypto | Ma–Vr 24u (geen weekend bij FTMO) |
| Indices / Gold | Ma–Vr, sluit vrijdag 22:50 |
| Aandelen | Ma–Vr 15:30–20:00 GMT+1 |

### Sessie tracking
Elke trade krijgt automatisch een sessie label op basis van openingstijd (UTC):

| Sessie | Tijdvenster (UTC) |
|---|---|
| `asia` | 22:00 – 07:00 |
| `london` | 07:00 – 13:00 |
| `overlap_lndy` | 13:00 – 16:00 |
| `new_york` | 16:00 – 22:00 |

### Postgres persistence
- Alle gesloten trades worden opgeslagen in `closed_trades` tabel
- Equity snapshots worden opgeslagen in `equity_snapshots` (throttled: 1x per 5 min)
- Bij herstart worden historische trades automatisch geladen — optimizer werkt meteen

### Self-healing
Bij MT5 fouten past de server automatisch aan:
- Onbekend symbool → probeert `.cash` / zonder `.cash` / `.US` varianten
- Lot fout → verhoogt lot step
- Stop fout → vergroot minimale stop distance

---

## TP Optimizer

**Formule:**
```
EV = winrate(X) × X − (1 − winrate(X)) × 1
```
Positieve EV = winstgevend TP-niveau over tijd.

**Automatisch (03:00 CET):** past TP aan voor symbolen met ≥10 trades en EV > 0

**Manueel:**
```
POST /research/tp-optimizer/apply?secret=FtmoNV2025
```

---

## Sessie Analyse

```
GET /analysis/sessions?symbol=GBPUSD
```

Geeft per sessie: aantal trades, gemiddelde maxRR, beste TP niveau, volledige EV tabel.
`bestSession` toont in welke sessie het pair de hoogste verwachte waarde heeft.

---

## Versiehistorie

| Versie | Wijzigingen |
|---|---|
| v3.4 | Postgres persistence, sessie tracking, `/analysis/sessions` per symbool + sessie |
| v3.3 | TP optimizer, nachtelijke auto-apply, live TP-correctie open posities |
| v3.2 | Anti-consolidatie, self-healing, max RR tracker |
| v3.1 | Equity curve snapshots, FTMO drawdown guard |
| v3.0 | Multi-symbool support, dynamische TP per type |
