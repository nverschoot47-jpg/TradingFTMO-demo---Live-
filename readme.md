# NV Clean — TradingView → MetaApi → FTMO MT5
**Versie:** v3.0 | **Auteur:** Nick Verschoot — PRONTO-AI

Automatisch trading systeem dat TradingView alerts ontvangt via webhook, verwerkt en doorstuurt naar een FTMO MT5 account via de MetaApi REST API.

---

## Architectuur

```
TradingView Alert
      ↓
  webhook.js  (Railway)
      ↓
  MetaApi REST
      ↓
  FTMO MT5 Demo/Live
```

---

## Repo structuur

```
webhook.js      → hoofdserver, alle logica
package.json    → dependencies (enkel express)
README.md       → deze file
```

---

## Environment variables (Railway)

| Variable | Waarde | Beschrijving |
|---|---|---|
| `META_API_TOKEN` | `...` | MetaApi token |
| `META_ACCOUNT_ID` | `7cb566c1-...` | MetaApi account ID |
| `WEBHOOK_SECRET` | `FtmoNV2025` | Secret voor TradingView webhook URL |
| `ACCOUNT_BALANCE` | `10000` | Startbalans account (EUR) |
| `RISK_INDEX` | `200` | Risico per trade indices (EUR) |
| `RISK_FOREX` | `15` | Risico per trade forex (EUR) |
| `RISK_STOCK` | `30` | Risico per trade aandelen (EUR) |
| `RISK_GOLD` | `30` | Risico per trade gold (EUR) |
| `RISK_CRYPTO` | `30` | Risico per trade crypto (EUR) |
| `RISK_MINLOT_CAP` | `60` | Max risico bij min-lot fallback (EUR) |
| `PORT` | automatisch | Railway vult dit zelf in |

---

## Trading regels per type

| Type | Risico | Max lots | Take Profit | Trading venster |
|---|---|---|---|---|
| Index | €200 | 10.0 | **3RR automatisch** | Ma–Vr doorlopend |
| Forex | €15 | 0.25 | **2RR automatisch** | Ma–Vr 24h |
| Aandelen | €30 | 50 | Geen (manueel) | **15:30–20:00 GMT+1** |
| Gold | €30 | 1.0 | Geen (manueel) | Ma–Vr doorlopend |
| Crypto | €30 | 1.0 | Geen (manueel) | Ma–Vr doorlopend |

---

## Symbolen

### Indices (TradingView → MT5)
| TradingView | MT5 |
|---|---|
| DE30EUR | GER40.cash |
| UK100GBP | UK100.cash |
| NAS100USD | US100.cash |
| US30USD | US30.cash |

### Forex
GBPUSD, USDJPY, USDCAD en alle majors/crosses — zelfde naam TV → MT5.

### Aandelen
AAPL, TSLA, NVDA, MSFT, PLTR, AMZN, AMD, META, MU, GOOGL, NFLX — zelfde naam TV → MT5.

### Gold / Crypto
XAUUSD, BTCUSD, ETHUSD — zelfde naam TV → MT5.

---

## TradingView alert instelling

**Webhook URL:**
```
https://jouw-railway-url.up.railway.app/webhook?secret=FtmoNV2025
```

**Alert bericht (JSON):**
```json
{"action":"buy","symbol":"{{ticker}}","entry":{{close}},"sl":{{low}}}
```

> ⚠️ Verwijder en hermaak de alert als `{{ticker}}` letterlijk in de webhook aankomt.

---

## Endpoints

| Methode | Pad | Beschrijving |
|---|---|---|
| `POST` | `/webhook` | TradingView alert ontvangen + order plaatsen |
| `POST` | `/close` | Positie manueel sluiten |
| `GET` | `/` | Health check + configuratie overzicht |
| `GET` | `/status` | Open trades + FTMO limieten |
| `GET` | `/live/positions` | Live posities met P&L + max RR |
| `GET` | `/analysis/rr` | Max RR per gesloten trade (geen bedragen) |
| `GET` | `/analysis/equity-curve` | Equity curve history |
| `GET` | `/history` | Webhook log (laatste 200) |

### Voorbeeld `/analysis/rr` response
```json
{
  "totalTrades": 12,
  "info": "maxRR = hoeveel R de prijs maximaal bewoog vóór SL of TP",
  "bySymbol": [
    {
      "symbol": "GBPUSD",
      "trades": 4,
      "avgMaxRR": 1.85,
      "details": [
        {
          "direction": "buy",
          "entry": 1.3316,
          "sl": 1.3290,
          "tp": 1.3368,
          "maxRR": 2.0,
          "tpHit": true
        }
      ]
    }
  ]
}
```

---

## Ingebouwde bescherming

**Anti-consolidation** — Als er al een open trade is in dezelfde richting op hetzelfde symbool, wordt het risico gehalveerd per extra trade.

**Self-healing** — Bij een order error probeert de server automatisch een gecorrigeerd symbool of lot size (learnedPatches).

**Weekend auto-close** — Elke vrijdag om 22:50 GMT+1 worden alle open posities automatisch gesloten.

**Stock venster** — Aandelen orders buiten 15:30–20:00 GMT+1 worden automatisch geweigerd.

**SL validatie** — Stop loss te dicht op entry wordt automatisch aangepast naar minimum afstand per symbool.

---

## Deployment (Railway)

1. Push `webhook.js` en `package.json` naar GitHub
2. Railway koppelen aan de repo
3. Environment variables instellen (zie tabel hierboven)
4. Railway detecteert automatisch Node.js 18 en start met `npm start`
5. `nixpacks.toml` is **niet nodig**

---

## MetaApi account

- **Account ID:** `7cb566c1-be02-415b-ab95-495368f3885c`
- **Broker:** FTMO Demo
- **API endpoint:** `mt-client-api-v1.london.agiliumtrade.ai`
