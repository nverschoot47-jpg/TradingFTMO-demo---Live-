# 🚀 NV TradingView → FTMO MT5 Webhook

**TradingView (NV Clean Pine Script) → Railway → MetaApi → FTMO MT5**  
Auteur: Nick Verschoot — [PRONTO-AI](https://pronto-ai.be)

---

## Architectuur

```
TradingView alert  →  POST /webhook?secret=…  →  Railway (webhook.js)
                                                      ↓
                                              Symbol mapping
                                              Lot berekening (0.5% risico)
                                              FTMO guards (dagelijks verlies, weekend)
                                                      ↓
                                              MetaApi REST API
                                                      ↓
                                              FTMO MT5 account
```

---

## Vereisten

- Node.js 18.x
- Railway account (of andere Node-host)
- MetaApi account + MT5-account gekoppeld
- TradingView Pro/Premium (voor webhook alerts)

---

## Omgevingsvariabelen (Railway → Variables)

| Variabele           | Verplicht | Beschrijving                                              |
|---------------------|-----------|-----------------------------------------------------------|
| `META_API_TOKEN`    | ✅        | MetaApi API token (Dashboard → API tokens)                |
| `META_ACCOUNT_ID`   | ✅        | MetaApi account ID (jouw MT5 account UUID)                |
| `WEBHOOK_SECRET`    | ✅        | Geheime sleutel voor TradingView → `?secret=…`            |
| `ACCOUNT_BALANCE`   | ➖        | Accountgrootte in EUR (standaard: `10000`)                |
| `PORT`              | ➖        | Poort (Railway stelt dit automatisch in)                  |

> ⚠️ Zet **nooit** je `META_API_TOKEN` hardcoded in de code. Gebruik altijd env vars.

---

## Lokaal opstarten

```bash
# 1. Afhankelijkheden installeren
npm install

# 2. Env vars instellen
export META_API_TOKEN="jouw_token"
export META_ACCOUNT_ID="jouw_account_id"
export WEBHOOK_SECRET="FtmoNV2025"
export ACCOUNT_BALANCE="10000"

# 3. Server starten
npm start

# Development (auto-restart bij wijzigingen)
npm run dev
```

---

## TradingView Alert instellen

### Stap 1 — Pine Script laden
Laad het script **NV Clean** op TradingView. Zorg dat de Retracement Filter aanstaat (standaard: 40%).

### Stap 2 — Alert aanmaken
- Klik op een candle / open Alerts panel → "Create Alert"
- **Condition**: `NV Clean` → `alert()` calls (de indicator heeft ingebouwde alerts)
- **Trigger**: Once Per Bar Close

### Stap 3 — Webhook URL instellen
```
https://jouw-railway-url.up.railway.app/webhook?secret=FtmoNV2025
```

> Vervang `FtmoNV2025` door jouw eigen `WEBHOOK_SECRET`.

### Stap 4 — Alert Message
De Pine Script stuurt automatisch het correcte JSON-formaat:

```json
{"action":"buy","symbol":"NAS100USD","entry":19500.5,"sl":19480.0}
```

Laat het "Message" veld in TradingView **leeg** — de `alert()` functie in de Pine Script vult dit zelf in.

---

## Webhook payload formaat

```json
{
  "action": "buy",
  "symbol": "NAS100USD",
  "entry": 19500.50,
  "sl": 19480.00
}
```

| Veld     | Type   | Waarden                             |
|----------|--------|-------------------------------------|
| `action` | string | `buy` / `sell` / `bull` / `bear` / `long` / `short` |
| `symbol` | string | TradingView ticker (zie symbol map) |
| `entry`  | number | Slotkoers van de break candle       |
| `sl`     | number | Stop loss (low van break candle voor buy, high voor sell) |

---

## Symbol mapping — TradingView → FTMO MT5

| TradingView (OANDA) | FTMO MT5      | Type   |
|---------------------|---------------|--------|
| `DE30EUR`           | `GER40.cash`  | index  |
| `UK100GBP`          | `UK100.cash`  | index  |
| `NAS100USD`         | `US100.cash`  | index  |
| `US30USD`           | `US30.cash`   | index  |
| `SPX500USD`         | `US500.cash`  | index  |
| `JP225USD`          | `JP225.cash`  | index  |
| `AU200AUD`          | `AUS200.cash` | index  |
| `EU50EUR`           | `EU50.cash`   | index  |
| `FR40EUR`           | `FRA40.cash`  | index  |
| `XAUUSD` / `GOLD`   | `XAUUSD`      | gold   |
| `UKOIL`             | `UKOIL.cash`  | brent  |
| `USOIL`             | `USOIL.cash`  | wti    |
| `BTCUSD`            | `BTCUSD`      | crypto |
| `ETHUSD`            | `ETHUSD`      | crypto |
| `AAPL`, `TSLA`, `NVDA`, `MSFT`, `PLTR`, `AMZN`, `AMD` | zelfde | stock |

Aliassen werken ook: `GER40`, `NAS100`, `US100`, `SPX500`, `US500`, enz.

---

## Risicobeheer

| Parameter         | Waarde           | Beschrijving                              |
|-------------------|------------------|-------------------------------------------|
| Risico per trade  | 0.5%             | Van accountbalans (bijv. €50 bij €10.000) |
| Max risico        | 0.9% (×1.8)      | Fallback voor kleine SL-afstanden         |
| Lot berekening    | Automatisch      | `risico ÷ (SL-afstand × lot-waarde)`     |
| Anti-consolidatie | Risico halveert  | Bij meerdere open trades zelfde richting  |

**Lot-waarde per type:**

| Type   | €/punt/lot | Voorbeeld (50 punten SL) |
|--------|-----------|--------------------------|
| Index  | €20       | 50p × €20 = €1000/lot → 0.05 lot |
| Gold   | €10       | variabel                 |
| Crypto | €1        | variabel                 |
| Stock  | €1        | per aandeel              |

---

## FTMO Guards

| Guard                      | Instelling         | Beschrijving                                        |
|----------------------------|--------------------|-----------------------------------------------------|
| Dagelijks verlies          | 5% van startbalans | Orders geblokkeerd als dagelijks verlies bereikt    |
| Totaal verlies             | 10%                | Referentie (niet automatisch geforceerd)            |
| Weekend auto-close         | Vrijdag 22:50 CET  | Alle posities worden automatisch gesloten           |
| Weekend order blokkade     | Za + Zo            | Geen orders, ook geen crypto                        |
| Self-healing symbolen      | Automatisch        | Probeert `.cash` / `.US` suffixen bij symboolfouten |
| Anti-consolidatie          | Per symbool+richting | Risico halveert bij n-de open trade                |

---

## API Endpoints

| Methode | Pad                    | Beschrijving                                |
|---------|------------------------|---------------------------------------------|
| `POST`  | `/webhook?secret=…`    | TradingView → FTMO MT5 order plaatsen       |
| `POST`  | `/close`               | Positie manueel sluiten (positionId vereist)|
| `GET`   | `/`                    | Health check + config overzicht             |
| `GET`   | `/status`              | Open trades + FTMO limieten                 |
| `GET`   | `/live/positions`      | Live posities met P&L                       |
| `GET`   | `/analysis/closed`     | Gesloten trades + what-if RR analyse        |
| `GET`   | `/analysis/equity-curve` | Equity curve (laatste 24u standaard)      |
| `GET`   | `/history`             | Webhook log (laatste 200 events)            |

### Voorbeeld: positie manueel sluiten
```bash
curl -X POST https://jouw-url.up.railway.app/close?secret=FtmoNV2025 \
  -H "Content-Type: application/json" \
  -d '{"positionId":"12345","symbol":"NAS100USD","direction":"buy"}'
```

### Voorbeeld: live posities bekijken
```bash
curl https://jouw-url.up.railway.app/live/positions
```

---

## Deployen op Railway

```bash
# 1. Railway CLI installeren (optioneel)
npm install -g @railway/cli

# 2. Inloggen
railway login

# 3. Project aanmaken of koppelen
railway init
# of
railway link

# 4. Env vars instellen via Railway Dashboard
#    Settings → Variables → voeg toe:
#    META_API_TOKEN, META_ACCOUNT_ID, WEBHOOK_SECRET, ACCOUNT_BALANCE

# 5. Deployen
railway up
```

Of gewoon pushen naar GitHub als Railway gekoppeld is aan je repo — Railway deployt automatisch.

---

## Pine Script signaallogica (NV Clean)

De indicator genereert 2 typen signalen:

**Break signalen** (direct op candle close):
- `▲N` = bullish break van kanaallijnen (N = aantal breaks vandaag)
- `▼N` = bearish break

**Retracement entry signalen** (wanneer retracement filter AAN staat):
- `↩▲` = prijs retracet 40% van break candle → long entry
- `↩▼` = prijs retracet 40% van break candle → short entry

**Alert instelling in Pine Script:**
```pine
// Retracement filter AAN (standaard) → wacht op 40% retrace
bull_alert = retrace_enable ? bull_retrace_signal : cs_bullBreakThisBar
bear_alert = retrace_enable ? bear_retrace_signal : cs_bearBreakThisBar
```

De webhook payload bevat altijd de `close` van de trigger candle als `entry` en de `low`/`high` als `sl`.

---

## Probleemoplossing

| Probleem                          | Oplossing                                                    |
|-----------------------------------|--------------------------------------------------------------|
| `Unauthorized`                    | Controleer `WEBHOOK_SECRET` in Railway én TradingView URL    |
| `symbol is {{ticker}}`            | TradingView alert opnieuw aanmaken; ticker was niet ingevuld |
| `SL moet onder entry voor BUY`    | Pine Script stuurt soms `low` als entry bij snelle bars      |
| `FTMO dagelijkse verliesgrens`    | Dagelijks verlies van 5% bereikt; wacht op nieuwe dag        |
| `Markt gesloten`                  | Buiten handelsuren; controleer CET market hours              |
| MetaApi 401 error                 | `META_API_TOKEN` verlopen of onjuist                         |
| Symbool niet gevonden             | Self-healing probeert `.cash` suffix; check MT5 symboolnaam  |

---

## Changelog

| Versie | Datum      | Wijzigingen                                                   |
|--------|------------|---------------------------------------------------------------|
| v2.0   | 2025-03    | FTMO guards, weekend close, self-healing, what-if RR, equity curve |
| v1.0   | 2024       | Basis TradingView → MetaApi integratie                        |

---

*PRONTO-AI · pronto-ai.be · Nick Verschoot · West-Vlaanderen*
