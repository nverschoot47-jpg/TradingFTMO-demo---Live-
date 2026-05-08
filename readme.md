[README.md](https://github.com/user-attachments/files/27508254/README.md)
# PRONTO·AI v14.0 — Volledig Technisch Overzicht

> **Geschreven voor iemand die het systeem nog nooit heeft gezien.**
> Lees dit van boven naar beneden. Elk stuk bouwt verder op het vorige.

---

## Wat doet dit systeem?

Dit is een **automatisch handelssysteem**. Het verbindt drie dingen met elkaar:

```
TradingView (grafiekplatform)
    ↓  stuurt een signaal via webhook (JSON berichtje)
Server (jouw Railway app)
    ↓  controleert het signaal, plaatst een order
MetaTrader 5 via MetaAPI (jouw FTMO broker account)
    ↓  voert de trade uit met echt geld
Dashboard (website in de browser)
    ↑  toont alles live
```

Het systeem handelt automatisch. Als TradingView zegt "koop EURUSD", dan koopt de server EURUSD op je MT5-account — zonder dat jij iets hoeft te doen.

---

## Bestanden in dit project

| Bestand | Wat doet het? |
|---|---|
| `server.js` | Het hart van alles. Ontvangt signalen, plaatst orders, beheert posities, serveert het dashboard. |
| `db.js` | Alle communicatie met de database (PostgreSQL). Slaat trades, ghosts, signalen op. |
| `session.js` | Weet welke symbolen bestaan, wanneer de markt open is, en wat de sessie is (Azië/Londen/NY). |
| `package.json` | Lijst van alle npm-pakketten die nodig zijn. |
| `railway.toml` | Instrueert Railway hoe te bouwen en starten. |
| `nixpacks.toml` | Instrueert Nixpacks (de bouwer op Railway) welke Node.js versie te gebruiken. |

---

## Hoe werkt een trade van A tot Z?

### Stap 1 — TradingView stuurt een signaal

De Pine Script indicator op TradingView stuurt een JSON berichtje naar jouw server:

```json
{
  "action": "sell",
  "symbol": "GBPUSD",
  "entry": 1.36036,
  "sl": 1.36190,
  "sl_pct": 0.001,
  "vwap": 1.35900,
  "vwap_upper": 1.36200,
  "vwap_lower": 1.35600
}
```

**Let op:** Pine Script stuurt `action` (niet `direction`). De server vertaalt dit automatisch.

---

### Stap 2 — Server ontvangt het signaal op `/webhook`

De server controleert een reeks filters **in deze volgorde**:

```
1. Geheim klopt?          → WEBHOOK_SECRET controleren
2. DB klaar?              → anders 503 error
3. Symbool bekend?        → anders 400 error
4. direction/action OK?   → "buy" of "sell" vereist
5. Markt open?            → sessie, weekend, handelsuren
6. VWAP Exhaustion?       → prijs te ver van VWAP (>150%)  → SHADOW PLAYBOOK
7. Duplicate open?        → zelfde optimizer key al open    → SHADOW PLAYBOOK
8. NY Dead Zone?          → 15:30-18:00 Brussels (forex/stocks) → SHADOW PLAYBOOK
9. Currency budget?       → niet te veel in zelfde valuta
10. Alles OK?             → ORDER PLAATSEN → GHOST TRACKER
```

Als een filter FAALT bij stap 6/7/8 → **Shadow Playbook** (onzichtbare tracking, geen echte trade).
Als een filter FAALT bij stap 1-5/9 → **Geblokkeerd/Error** (geen tracking).
Als alles OK → **Trade geplaatst** + **Ghost Tracker gestart**.

---

### Stap 3 — Order op MT5

De server plaatst een order via MetaAPI:

```
Symbol: GBPUSD
Type: ORDER_TYPE_SELL
Volume: 0.05 lots
StopLoss: 1.36190
TakeProfit: berekend op basis van locked RR
Comment: "GBPUSD S-NY-BLW #42"
```

**Het comment-formaat:** `SYMBOOL RICHTING-SESSIE-VWAP #NUMMER`
- `S` = Sell, `B` = Buy
- `NY` = New York, `LD` = Londen, `AS` = Azië
- `ABV` = boven VWAP, `BLW` = onder VWAP, `UNK` = onbekend
- `#42` = trade nummer (telt globaal op)

---

### Stap 4 — Ghost Tracker start

Zodra de positie open staat, start de **Ghost Tracker**. Dit is een onzichtbare schaduw die de trade volgt en **elke 0.1R** een tijdstempel opslaat.

```
Opened: 14:18:15
+0.1R bereikt: 14:19:01  → 46 seconden na opening
+0.2R bereikt: 14:20:33  → 2 minuten
+0.3R bereikt: 14:22:15  → 4 minuten
...
-1.0R bereikt (= SL geraakt!)
```

De ghost stopt bij:
- **-1.0R**: Phantom SL geraakt = positie gaat op SL (stopReason: `phantom_sl`)
- **+15.0R**: Maximum winst bereikt (stopReason: `max_rr_15`)
- **14 dagen**: Timeout (stopReason: `timeout_14d`)

---

### Stap 5 — Positie sluit op MT5

`syncPositions()` draait elke 30 seconden. Als een positie verdwenen is uit MT5:
1. Detecteer sluitreden via deals (SL/TP/manual)
2. Sla ghost trade op in database (`ghost_trades` tabel)
3. Sla closed trade op (`closed_trades` tabel)
4. Verwijder uit memory en `ghost_state` tabel

---

## De Database — Welke tabellen bestaan er?

| Tabel | Inhoud |
|---|---|
| `closed_trades` | Alle gesloten trades met P&L, RR, SL-reden |
| `ghost_trades` | Alle gesloten ghost trackers met milestone tijden en peak RR |
| `ghost_state` | **Actieve** ghost trackers (persist bij herstart) |
| `signal_log` | Elk inkomend signaal: PLACED/VWAP_EXHAUSTION/DUPLICATE/NY_DEAD_ZONE |
| `webhook_history` | Ruwe webhook log |
| `blocked_ghost_state` | Actieve Shadow Playbook trackers |
| `blocked_ghost_trades` | Gesloten Shadow Playbook trades |
| `shadow_snapshots` | MAE (Max Adverse Excursion) snapshots per 5 min |
| `tp_config` | Locked TP RR per optimizer key (na ≥10 ghosts) |
| `key_risk_mult` | Risicomultiplier per optimizer key |
| `spread_log` | Spread op het moment van entry |
| `deals` | Individuele MT5 deals (voor P&L berekening) |

---

## De Optimizer Key

Alles draait om de **optimizer key**. Dit is een unieke combinatie van:

```
SYMBOOL_SESSIE_RICHTING_VWAPPOSITIE

Voorbeelden:
GBPUSD_ny_sell_below
EURUSD_london_buy_above
AAPL_ny_sell_above
XAUUSD_ny_buy_below
```

Deze sleutel wordt gebruikt om:
- Ghost trades te groeperen (Ghost History)
- EV statistieken te berekenen (EV TP Optimizer)
- De beste TP te bepalen (TP Config)
- Shadow Playbook te analyseren

---

## Het Dashboard — 8 tabbladen

### 1. Overview
Toont een samenvatting van alles. Heeft een datumfilter (Open datum + Closed datum).

**Daily Breakdown tabel:**
- Datum | # Trades | Total Lots | Dag P&L | Beste Peak+RR | Max Win | Max Loss

**Best 10 / Worst 10 setups:**
- Uit `ghost_trades` gesorteerd op `peak_rr_pos` (niet op gerealiseerde P&L)

### 2. Open Positions
**Altijd live — geen datumfilter.** Toont alle actuele MT5-posities.

Kolommen (links → rechts, Symbol is sticky):
`Symbol | Dir | VWAP | Sess | RR Now | Peak+RR | Peak-RR% | →TP | Entry | SL | TP | P&L | Lots | Risk% | Opened`

### 3. Ghost Tracker
**Altijd live — geen datumfilter.** Toont actieve ghost trackers met milestone kolommen.

Milestone kolommen: `-1.0R` tot `-0.1R` (adverse) en `+0.1R` tot `+15.0R` (favorable)
Elke cel toont de **tijd vanaf opening** toen dat RR-niveau bereikt werd.

### 4. Ghost History
**Filter op GESLOTEN datum** (wanneer de ghost trade afgesloten werd in de DB).

Selecteer `03/05/2026 → 07/05/2026` = je ziet alleen ghosts die in die periode **gesloten** werden.

Twee secties:
- **Grouped per pair**: uitklapbare rijen per optimizer key, elke trade in een dropdown
- **By Signal Combo**: gemiddelden per combo, EV data source voor TP Optimizer

### 5. EV TP Optimizer
Berekent de beste TP in R-multiples per optimizer key op basis van ghost history.

- Data zichtbaar vanaf **≥5 ghost trades**
- TP wordt **automatisch gelockt door de server** pas bij **≥10 ghost trades**
- Totale P&L nu correct berekend en getoond

### 6. EV SL Optimizer
MAE (Max Adverse Excursion) analyse om de SL te verkleinen.

- p50 = 50% van trades ging nooit dieper dan X% van de SL
- p90 = 90% van trades bleef binnen X%
- Groen = SL kan strak (p90 < 50%), Geel = matig, Rood = SL goed

### 7. Signals & Blocked
**Filter op datum van signaal ontvangst.**

Toont **alle signalen** uit de `signal_log` database per rij:

| Kolom | Inhoud |
|---|---|
| Time | Tijdstip ontvangst |
| Symbol | Handelsinstrument |
| Dir | Buy/Sell |
| Session | Azië/Londen/NY |
| VWAP | Above/Below |
| Entry | Entryprijs op moment van signaal |
| SL% | Stop Loss afstand |
| Band% | VWAP band percentage |
| Outcome | PLACED / SHADOW / REJECT |
| Destination | ✓ Ghost Tracker / → Shadow Playbook / ✗ REJECT reden |
| Latency | Verwerkingstijd in ms |

**KPI tellers:**
- Total Signals, Placed, Conversion%
- Total Blocked, Duplicate, VWAP Exhausted, Outside Window, NY Dead Zone

### 8. Shadow Playbook
Toont de invisible ghost trackers voor geblokkeerde signalen (VWAP_EXHAUSTION, DUPLICATE, NY_DEAD_ZONE).

---

## Datumfilters — Wat filtert wat?

| Tab | Filter filtert op | Werkt? |
|---|---|---|
| Overview | Opened datum + Closed datum van `closed_trades` | ✅ Ja |
| Open Positions | **Geen filter** — altijd live MT5 data | ✅ Geen filter nodig |
| Ghost Tracker | **Geen filter** — altijd actieve ghosts | ✅ Geen filter nodig |
| Ghost History | **Closed datum** van `ghost_trades` | ✅ Ja |
| EV TP Optimizer | Opened datum van `ghost_trades` | ✅ Ja |
| EV SL Optimizer | Opened datum van `ghost_trades` | ✅ Ja |
| Signals | Ontvangstdatum van `signal_log` | ✅ Ja |

---

## Cron Jobs (automatische taken)

| Frequentie | Taak | Wat doet het? |
|---|---|---|
| Elke 30 seconden | `syncPositions()` | Controleert of posities nog open zijn op MT5. Sluit ghosts. |
| Elke 5 minuten | `runShadowSnapshots()` | Slaat MAE (adverse excursion) op voor open posities. |
| Elke 30 minuten | `runTPOptimizer()` | Herberekent locked TP per optimizer key. |
| Elke uur | `syncTradeNumberSequence()` | Synchroniseert trade nummers met DB. |

---

## Sessies en Handelstijden (Brussels tijd)

| Sessie | Tijden Brussels | Label in systeem |
|---|---|---|
| Azië | 02:00 – 08:00 | `asia` |
| Londen | 08:00 – 15:30 | `london` |
| New York | 15:30 – 21:00 | `ny` |
| Buiten venster | 21:00 – 02:00 | `outside` |

**NY Dead Zone** (geblokkeerd voor forex/stocks): 15:30 – 18:00 Brussels
**Weekend**: Zaterdag + Zondag = geen nieuwe trades

**Handelsvensters per type:**
- **Forex + Commodity**: 02:00–21:00, NY Dead Zone actief
- **Stocks (aandelen)**: 16:00–21:00 ALLEEN (NYSE/NASDAQ uren), NY Dead Zone actief 16:00–18:00
- **Indexes**: 02:00–21:00, GEEN dead zone

---

## Symbolen Catalogus

**Stocks:** AAPL, AMD, AMZN, ARM, ASML, AVGO, AZN, BA, BABA, BAC, BRKB, CSCO, CVX, DIS, FDX, GE, GM, GME, GOOGL, IBM, INTC, JNJ, JPM, KO, LMT, MCD, META, MSFT, MSTR, NFLX, NKE, NVDA, PFE, PLTR, QCOM, SBUX, SNOW, T, TSLA, V, WMT, XOM, ZM

**Forex:** AUDCAD, AUDCHF, AUDNZD, AUDUSD, CADCHF, EURAUD, EURCHF, EURUSD, GBPAUD, GBPNZD, GBPUSD, NZDCAD, NZDCHF, NZDUSD, USDCAD, USDCHF

**Indexes:** DE30EUR (GER40.cash), NAS100USD (US100.cash), UK100GBP (UK100.cash), US30USD (US30.cash)

**Commodities:** XAUUSD (goud)

**Aliases (TradingView → intern):** UK100 → UK100GBP, NAS100 → NAS100USD, GOOG → GOOGL, etc.

---

## Risicobeheer

**Default risico per trade:** 0.0375% van balans per trade (= `DEFAULT_RISK_BY_TYPE`)

**SL Buffer multiplier:**
- Forex/Index/Commodity: 1.5× (de SL wordt 1.5× groter dan de TV-afstand)
- Stocks: 3.0× (stocks hebben grotere spread, anders te snel uitgestopt)

**Lot berekening:**
```
riskEUR = balans × riskPct
lotWaarde = riskEUR / (slAfstand × pipWaarde)
```

---

## Omgevingsvariabelen (Environment Variables op Railway)

| Variabele | Beschrijving |
|---|---|
| `DATABASE_URL` | PostgreSQL connectiestring (automatisch van Railway Postgres plugin) |
| `WEBHOOK_SECRET` | Geheim wachtwoord voor de TradingView webhook URL |
| `META_API_TOKEN` | MetaAPI toegangstoken |
| `META_ACCOUNT` | MetaTrader 5 account ID |
| `PORT` | Serverpoort (Railway zet dit automatisch) |

---

## Railway Deployment

**Stappen:**
1. Push alle bestanden naar GitHub
2. Railway detecteert de push automatisch
3. Nixpacks bouwt met Node.js 20
4. `npm i --omit=dev` installeert alleen productie-pakketten
5. `node server.js` start de server
6. Bij crash: Railway herstart automatisch (max 3× via `railway.toml`)

**URL structuur:**
```
https://jouw-app.up.railway.app/                    ← Dashboard
https://jouw-app.up.railway.app/webhook?secret=XXX  ← TradingView webhook
https://jouw-app.up.railway.app/api/open-positions  ← API
```

---

## Webhook Configuratie in TradingView

In de TradingView alert, stel de URL in als:
```
https://jouw-app.up.railway.app/webhook?secret=JOUW_SECRET
```

Het JSON bericht moet er zo uitzien:
```json
{
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "entry": {{close}},
  "sl": {{close}},
  "sl_pct": 0.003,
  "vwap": 0,
  "vwap_upper": 0,
  "vwap_lower": 0
}
```

Of de versie uit de Pine Script indicator:
```json
{"action":"buy","symbol":"EURUSD","entry":1.08500,"sl":1.08200}
```

**Beide velden werken:** `action` en `direction` worden allebei geaccepteerd.

---

## Wat veranderde in v14.0? (Alle fixes)

### Kritische bugs opgelost

**1. `direction = undefined` voor elke trade**
- *Probleem:* Pine Script stuurt `action: "buy"`, server verwachtte `direction`. Resultaat: elke trade had `direction = undefined`, cascade van DB errors.
- *Fix:* Server accepteert nu beide velden. Validatie faalt expliciet als geen geldig direction gevonden wordt.

**2. Ghost History was altijd leeg**
- *Probleem:* `saveGhostTrade()` gebruikte `ON CONFLICT DO NOTHING`. Omdat er geen UNIQUE constraint op `position_id` stond, deed elke INSERT een nieuwe rij maar werd `closed_at` nooit bijgewerkt. Ghost History filtert op `WHERE closed_at IS NOT NULL` → altijd leeg.
- *Fix:* Unieke index op `position_id` toegevoegd. `ON CONFLICT DO NOTHING` vervangen door echte UPSERT met `DO UPDATE SET` voor alle velden inclusief `closed_at`, milestones, peak RR.

**3. Ghost status verdween bij herstart**
- *Probleem:* `phantom_sl_hit` en `stop_reason` werden niet opgeslagen in `ghost_state`. Bij herstart werden ze op `false/null` gezet, waardoor de ghost opnieuw moest beginnen.
- *Fix:* Twee nieuwe kolommen in `ghost_state`. `saveGhostState()` slaat ze op, `loadAllGhostStates()` leest ze terug, restore-functie zet ze correct terug.

**4. `adoptPosition()` gaf altijd direction = sell**
- *Probleem:* `lp.type ?? ''` werd doorgegeven aan `parseMT5Comment()` die een commentstring verwacht. `POSITION_TYPE_BUY` werd nooit herkend.
- *Fix:* MT5 type veld apart gedetecteerd via `lpType.includes('BUY')`. Expliciete guard die positie overslaat als direction niet bepaald kan worden.

**5. ORDER_NOT_CONFIRMED maakte orphan ghosts**
- *Probleem:* Als MT5 geen positie-ID terugstuurde, werd `String(Date.now())` als ID gebruikt. Die ghost werd nooit automatisch gesloten.
- *Fix:* Bij ORDER_NOT_CONFIRMED wordt nu `HTTP 202` teruggegeven en géén fallback-positie aangemaakt.

**6. MT5 order comment verkeerd**
- *Probleem:* Session map had `'new_york' → 'NY'` maar `getSession()` retourneert `'ny'`. Alle NY-trades kregen `'NY??'` of `'NYYY'` als comment.
- *Fix:* Map gecorrigeerd naar `{ ny: 'NY', london: 'LD', asia: 'AS' }`. Nieuw formaat: `GBPUSD S-NY-BLW #42`.

**7. `runShadowSnapshots()` kon direction-null errors geven**
- *Probleem:* Als een positie geadopteerd werd met null direction, probeerde de shadow snapshot het toch op te slaan.
- *Fix:* Guard toegevoegd: `if (!pos.direction || !pos.symbol || !pos.session) continue;`

### Dashboard verbeteringen

**8. Open Positions symbool onzichtbaar op mobiel**
- Symbol kolom is nu sticky (`position: sticky; left: 0`). Altijd zichtbaar bij horizontaal scrollen.
- Kolom volgorde geoptimaliseerd voor mobiel: meest relevante info eerst.
- `RR Now` is nu een echte live berekening op basis van `currentPrice`.

**9. Daily Breakdown vereenvoudigd**
- Verwijderd: wins, losses, win%, cumulative P&L, avg lots, avg RR, max win streak, max loss streak, max drawdown.
- Behouden: datum, # trades, total lots, dag P&L, beste Peak+RR, max win, max loss.
- Best 10 / Worst 10 nu vanuit `ghost_trades.peak_rr_pos` (niet meer gerealiseerde P&L).

**10. Datumfilters werken nu correct per tab**
- Open Positions en Ghost Tracker: filter bars verwijderd (altijd live data, filter heeft geen zin).
- Overview filter: stuurt nu `since`/`until`/`openFrom`/`openTo` mee naar `/api/trades`.
- Ghost History filter: filtert nu correct op `closed_at` (wanneer ghost gesloten werd).
- Signals tab: gebruikt nu `/api/signal-log` uit de database (niet meer in-memory webhook_history die resettet bij herstart).

**11. Signals tab volledig herschreven**
- Toont nu alle signalen uit `signal_log` database.
- Persistent, filterbaar op datum.
- Elke rij toont duidelijk: `✓ Ghost Tracker`, `→ Shadow Playbook`, of `✗ REJECT`.
- KPI tellers berekend uit dezelfde data.

**12. EV P&L KPI was altijd €0.00**
- `ev-pnl` element werd nooit gevuld. Nu correct berekend vanuit `_allTrades`.

**13. EV drempel label gecorrigeerd**
- Was: "EV locked at ≥5 ghost trades" (misleidend).
- Nu: "EV data van ≥5 ghosts · TP auto-locked door server bij ≥10 ghosts".

---

## Wat zou je nog kunnen doen? (Toekomstige verbeteringen)

1. **VWAP waarden meesturen in Pine Script alert** — `vwap_upper`/`vwap_lower` zijn nodig voor de VWAP Exhaustion filter. Als ze `0` zijn, wordt de filter nooit getriggerd.
2. **Authenticatie op `/api/open-positions`** — Dit endpoint is momenteel publiek. Iedereen met de URL ziet je posities.
3. **Per-positie live P&L** — Huidige P&L komt van de MT5-header, niet per individuele positie. Een extra MetaAPI call per sync zou dit oplossen.
4. **Meer symbolen toevoegen** — Pas `SYMBOL_CATALOG` in `session.js` aan.
5. **Risk% aanpassen** — Pas `DEFAULT_RISK_BY_TYPE` aan in `session.js`.

---

## Veelgestelde Vragen

**Q: Waarom zie ik geen trades in Ghost History?**
A: Ghost History toont alleen gesloten ghosts. Filter op de datum waarop de ghost gesloten werd (niet geopend). Als er helemaal niets staat, zijn er nog geen trades gesloten of is v14.0 nog niet deployed (de UPSERT fix was nodig hiervoor).

**Q: Mijn webhook geeft een 400 error.**
A: Controleer of `action` OF `direction` aanwezig is in het JSON bericht. Controleer of het symbool in de `SYMBOL_CATALOG` staat in `session.js`.

**Q: De server herstart constant op Railway.**
A: Bekijk de Railway logs. Meest voorkomende oorzaken: `DATABASE_URL` ontbreekt, `META_API_TOKEN` ontbreekt, of een Node.js syntax error.

**Q: Een trade staat open op MT5 maar niet op het dashboard.**
A: Klik op ⚡ Recover. Dit roept `syncPositions()` aan en adopteert bestaande MT5-posities.

**Q: Hoe voeg ik een nieuw symbool toe?**
A: Open `session.js`, voeg het toe aan `SYMBOL_CATALOG`:
```javascript
MYSTOCK: { type: "stock", mt5: "MYSTOCK" },
```
En eventueel aan `SYMBOL_ALIASES` als TradingView een andere naam gebruikt.

---

*PRONTO·AI v14.0 — Nick Verschoot*
*Gebouwd op: Express.js + PostgreSQL + MetaAPI + Railway + TradingView*
