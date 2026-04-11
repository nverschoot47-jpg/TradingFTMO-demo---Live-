# FTMO Webhook Server — Volledige Technische Documentatie
**Versie:** v7.7 | **Auteur:** Nick Verschoot — PRONTO-AI | **Platform:** Railway + PostgreSQL

---

## Inhoudsopgave

1. [Systeemoverzicht](#1-systeemoverzicht)
2. [Architectuur](#2-architectuur)
3. [Configuratie & Omgevingsvariabelen](#3-configuratie--omgevingsvariabelen)
4. [Symbool- en Typelogica](#4-symbool--en-typelogica)
5. [Sessielogica & Tijdzones](#5-sessielogica--tijdzones)
6. [Risicobeheer](#6-risicobeheer)
7. [Order Flow — van Webhook tot MT5](#7-order-flow--van-webhook-tot-mt5)
8. [Ghost Tracker Engine](#8-ghost-tracker-engine)
9. [TP Lock Engine](#9-tp-lock-engine)
10. [SL Lock Engine](#10-sl-lock-engine)
11. [Shadow SL Optimizer](#11-shadow-sl-optimizer)
12. [Daily Risk Scaling](#12-daily-risk-scaling)
13. [Positie Synchronisatie](#13-positie-synchronisatie)
14. [Cron Jobs](#14-cron-jobs)
15. [Database Schema](#15-database-schema)
16. [API Endpoints — Volledig Overzicht](#16-api-endpoints--volledig-overzicht)
17. [Dashboard](#17-dashboard)
18. [Foutafhandeling & Zelflerend Systeem](#18-foutafhandeling--zelflerend-systeem)
19. [Bugfixes v7.7](#19-bugfixes-v77)
20. [Deploymentinstructies](#20-deploymentinstructies)

---

## 1. Systeemoverzicht

Dit systeem ontvangt TradingView-webhook-alerts, verwerkt ze naar MetaApi REST-calls, en plaatst orders op een FTMO MT5 demo-account. Naast pure orderuitvoering bevat het een volledig statistisch analyse-ecosysteem dat leert van historische trades om TP-targets, SL-groottes en risico automatisch te optimaliseren.

### Kernprincipes

- **Geen hardcoded logica**: TP-targets, SL-multipliers en risicobedragen worden statistisch bepaald vanuit eigen tradedata.
- **Brussels tijdzone overal**: alle tijdsberekeningen gebruiken `Intl.DateTimeFormat` met `Europe/Brussels` — geen hardcoded UTC-offsets.
- **Data-driven**: het systeem verzamelt ghost-data (wat zou er zijn gebeurd als je de trade langer had aangehouden?) om de ware maximale RR per trade te berekenen.
- **FTMO-regels**: auto-close om 21:50, geen trades buiten 02:00–20:00, weekend-blokkade behalve crypto.

---

## 2. Architectuur

```
TradingView Alert
       │
       ▼
POST /webhook
       │
  Validatie (secret, symbool, duplicaat, markt open)
       │
  Forex consolidatie check
       │
  SL Multiplier bepalen (getEffectiveSLMultiplier)
       │
  Spread Guard (stocks)
       │
  Risico + Lot berekening
       │
  placeOrderWithTimeout → MetaApi REST → MT5
       │
  openPositions bijwerken
       │
  ┌────────────────────────────────────┐
  │         syncPositions (30s)        │
  │  Detecteert gesloten posities      │
  │  → closedTrades                    │
  │  → startGhostTracker               │
  │  → saveTrade (DB)                  │
  └────────────────────────────────────┘
       │
  Ghost Tracker (async, per trade)
       │
  finaliseGhost → trueMaxRR opgeslagen
       │
  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
  │ runTPLockEngine │  │ runSLLockEngine  │  │ runShadowSLOptimizer │
  │ (per symbool)   │  │ (per symbool)    │  │ (per symbool)        │
  └─────────────────┘  └──────────────────┘  └──────────────────────┘
       │
  PostgreSQL (Railway)
```

### Bestanden

| Bestand | Functie |
|---|---|
| `server.js` | Hoofdapplicatie: Express, webhooks, engines, cron, dashboard |
| `session.js` | Tijdzone-helpers, sessiedefinities, marktopen-checks |
| `db.js` | PostgreSQL persistence layer — alle tabellen en queries |
| `package.json` | Dependencies: express, helmet, node-cron, pg |

---

## 3. Configuratie & Omgevingsvariabelen

| Variabele | Vereist | Standaard | Beschrijving |
|---|---|---|---|
| `META_API_TOKEN` | ✅ | — | MetaApi authenticatietoken |
| `META_ACCOUNT_ID` | ✅ | — | MetaApi account-ID (UUID) |
| `WEBHOOK_SECRET` | ✅ | — | Geheime sleutel voor webhook-authenticatie |
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string (Railway auto-inject) |
| `ACCOUNT_BALANCE` | ❌ | 10000 | Startbalans voor risicopercentage-berekeningen |
| `PORT` | ❌ | 3000 | HTTP-poort (Railway auto-inject) |
| `RISK_INDEX` | ❌ | 200 | Basisrisico in EUR voor indices |
| `RISK_FOREX` | ❌ | 15 | Basisrisico in EUR voor forex |
| `RISK_GOLD` | ❌ | 30 | Basisrisico in EUR voor goud |
| `RISK_BRENT` | ❌ | 30 | Basisrisico in EUR voor Brent olie |
| `RISK_WTI` | ❌ | 30 | Basisrisico in EUR voor WTI olie |
| `RISK_CRYPTO` | ❌ | 30 | Basisrisico in EUR voor crypto |
| `RISK_STOCK` | ❌ | 30 | Basisrisico in EUR voor aandelen |

### Constanten (hardcoded in server.js)

| Constante | Waarde | Betekenis |
|---|---|---|
| `GHOST_DURATION_MS` | 24u | Max. duur ghost tracker |
| `GHOST_INTERVAL_RECENT_MS` | 60s | Polling interval ghost eerste 6u |
| `GHOST_INTERVAL_OLD_MS` | 5min | Polling interval ghost na 6u |
| `SL_AUTO_APPLY_THRESHOLD` | 30 | Trades nodig voor auto-apply SL Lock |
| `SHADOW_SL_MIN_TRADES` | 30 | Ghost trades nodig voor Shadow Optimizer |
| `FIXED_TP_RR` | 4R | Initiële TP fallback (vóór eerste TP Lock) |
| `FOREX_MAX_SAME_DIR` | 2 | Max. gelijktijdige forex orders zelfde richting |
| `FOREX_HALF_RISK_THRESHOLD` | 1 | Vanaf 1 open positie → halftrade risico |
| `TP_LOCK_RISK_MULT` | 4x | Risicomultiplier bij positieve TP Lock |
| `STOCK_SL_SPREAD_MULT` | 1.5x | Extra SL-buffer voor aandelen |
| `STOCK_MAX_SPREAD_FRACTION` | 33.3% | Max spread als % van SL-afstand voor stocks |
| `DUPLICATE_GUARD_MS` | 60s | Blokkeerperiode voor duplicate orders |

---

## 4. Symbool- en Typelogica

### Symboolmapping

Alle inkomende TradingView-symbolen worden via `SYMBOL_MAP` vertaald naar MT5-symbolen. De map werkt via twee methoden:

- `mapAliases(aliases, mt5, type)` — meerdere invoernamen naar één MT5-symbool
- `mapDirect(symbols, type)` — directe 1-op-1 mapping

**Ondersteunde types:**

| Type | Voorbeelden | Basisrisico |
|---|---|---|
| `index` | GER40, US100, US30, SP500 | €200 |
| `gold` | XAUUSD | €30 |
| `brent` | UKOIL | €30 |
| `wti` | USOIL | €30 |
| `crypto` | BTCUSD, ETHUSD | €30 |
| `stock` | AAPL, TSLA, NVDA, ... | €30 |
| `forex` | EURUSD, GBPUSD, ... | €15 |

### Normalisatie

`normalizeSymbol()` corrigeert bekende aliassen (bijv. NIKE → NKE).

### Zelflerend patchsysteem (`learnedPatches`)

Als MetaApi een order afwijst vanwege een ongekend symbool, probeert het systeem automatisch:
1. `.cash` toe te voegen of te verwijderen aan het MT5-symbool
2. De lotgrootte-stap aan te passen bij volume-fouten
3. De minimale stop te verdubbelen bij stop-fouten

---

## 5. Sessielogica & Tijdzones

### Brussels Tijdzone (session.js)

Alle tijdsberekeningen gebruiken `Intl.DateTimeFormat` met `Europe/Brussels`. Dit handelt zomer/wintertijd automatisch af (geen hardcoded +1h of +2h).

**Kernfuncties:**

| Functie | Output | Gebruik |
|---|---|---|
| `getBrusselsComponents(date?)` | `{ day, hhmm, hour, minute }` | Sessie- en marktchecks |
| `getBrusselsDateOnly(date?)` | `"YYYY-MM-DD"` | Dagelijkse trade-groepering |
| `getBrusselsDateStr()` | Leesbare string | Dashboard weergave |
| `getSessionGMT1(date?)` | `"asia"/"london"/"ny"/"buiten_venster"` | Sessielabeling per trade |

### Handelssessies

| Sessie | Brussels Tijd | Gebruik |
|---|---|---|
| Asia | 02:00 – 08:00 | TP Lock per sessie |
| London | 08:00 – 15:30 | TP Lock per sessie |
| New York | 15:30 – 20:00 | TP Lock per sessie |
| Buiten venster | 20:00 – 02:00 | Geen nieuwe trades |

### Markt Open Logica (`isMarketOpen`)

- **Alle types behalve stock**: ma–vr, 02:00–20:00
- **Stocks**: alleen 15:30–20:00 (NY-venster)
- **Crypto**: ook weekend 02:00–20:00 (BTCUSD, ETHUSD)

### Ghost & Shadow Venster

- Ghost tracker actief: 02:00–22:00 (ma–vr)
- Hard stop alle ghosts: 22:00 via cron
- Weekend: geen ghost tracking

---

## 6. Risicobeheer

### Effectief Risico (`getEffectiveRisk`)

Het risico per trade wordt beïnvloed door drie factoren:

**1. Pyramiding-halveringen**
Bij meerdere gelijktijdige trades in dezelfde richting wordt het risico gehalveerd:
```
risk = baseRisk / 2^(count)
minimum = baseRisk × 10%
```

**2. TP Lock Compound Boost**
Als een TP Lock actief is met positieve EV én dit de eerste trade is (count=0):
```
risk = BASE_RISK × 4 × compoundBoost × dailyRiskMultiplier
compoundBoost = 1.2^(aaneengesloten positieve dagen)
```

**3. Daily Risk Multiplier**
Dagelijks aangepast op basis van PnL van vorige dag:
- Positieve dag: multiplier × 1.2 (maximaal compounderen)
- Negatieve dag: reset naar 1.0

### Lot Berekening (`calcLots`)

```
lots = floor((risk / (SL_afstand × lot_value)) / lot_step) × lot_step
```

Gemaximeerd op `MAX_LOTS` per type en gecontroleerd op overschrijding van 1.5× het effectieve risicocap.

### Forex Vaste Lots

Forex gebruikt altijd vaste lotgroottes (geen risico-berekening):
- Eerste trade in richting: **0.25L**
- Tweede trade (halfrisico): **0.12L**

### SL Validatie (`validateSL`)

- Minimale SL-afstand per instrument (zie `MIN_STOP_*` tabellen)
- Stocks: SL altijd vergroot met factor 1.5 (spread buffer)
- Forex: minimale pip-afstand van 0.0005

---

## 7. Order Flow — van Webhook tot MT5

### Stap 1: Authenticatie
```
POST /webhook?secret=WEBHOOK_SECRET
Header: x-secret: WEBHOOK_SECRET
Body: { symbol, action, entry, sl }
```

### Stap 2: Validaties (in volgorde)
1. Secret check → 401 bij mismatch
2. Symbool aanwezig → 400 bij ontbreken
3. Symbool in SYMBOL_MAP of learnedPatches → SKIP bij onbekend
4. `action`, `entry`, `sl` aanwezig → 400 bij ontbreken
5. SL aan juiste kant van entry (buy: sl < entry, sell: sl > entry) → 400
6. Duplicate guard (60s blokkade per symbool+richting) → SKIP
7. Symbooltype bepalen
8. `isMarketOpen()` check → SKIP bij gesloten markt
9. Forex consolidatie check → SKIP bij >2 posities zelfde richting

### Stap 3: SL Multiplier bepalen
Via `getEffectiveSLMultiplier()` — zie sectie 10.

### Stap 4: Spread Guard (alleen stocks)
Live spread ophalen via MetaApi. Als spread > 33.3% van SL-afstand → SKIP.

### Stap 5: Risico & Lots
- `getEffectiveRisk()` → risicobedrag in EUR
- Forex: vaste lots
- Overig: `calcLots()` → lotgrootte

### Stap 6: Order plaatsen
`placeOrderWithTimeout()` → 8 seconden timeout (Promise.race + AbortController op fetch).

TP-prijs berekend via TP Lock (of FIXED_TP_RR=4 als fallback).

### Stap 7: Foutafhandeling & Retry
Bij orderfout:
1. `learnFromError()` → patches opslaan
2. Herberekening lots
3. Eén retry (ook met 8s timeout)
4. Bij tweede fout: ERROR_LEARNED teruggeven

### Stap 8: Positie registreren
```javascript
openPositions[posId] = {
  symbol, mt5Symbol, direction, entry, sl, tp, lots,
  riskEUR, session, slMultiplierApplied, ...
}
```

### Response bij succes
```json
{
  "status": "OK",
  "versie": "v7.7",
  "direction": "buy",
  "tvSymbol": "EURUSD",
  "mt5Symbol": "EURUSD",
  "entry": 1.0850,
  "sl": 1.0820,
  "tp": 1.0970,
  "tpRR": 4,
  "lots": 0.25,
  "risicoEUR": "15.00",
  "slMultiplier": 0.5,
  "positionId": "12345678"
}
```

---

## 8. Ghost Tracker Engine

### Doel
Na het sluiten van een trade volgt de ghost tracker de marktprijs door om te berekenen wat de maximale RR *had kunnen zijn* als je de trade langer had aangehouden. Dit levert `trueMaxRR` op — de basis voor alle optimalisatie-engines.

### Werking

**Start:** `startGhostTracker(closedTrade, isManual)` wordt automatisch aangeroepen vanuit `syncPositions()` zodra een positie gesloten wordt (behalve bij insta-SL: `maxRR ≤ 0.05`).

**Polling:**
- Eerste 6 uur: elke 60 seconden
- Na 6 uur: elke 5 minuten
- Maximum: 24 uur (of 22:00 Brussels, wat eerder is)

**Per tick:**
1. Actuele prijs ophalen via MetaApi (`fetchCurrentPrice`)
2. `bestPrice` bijwerken (meest gunstige koers voor de trade)
3. `worstPrice` bijwerken (meest ongunstige → MAE berekening)
4. Check: heeft de prijs de originele SL geraakt? → `phantom_sl` stop
5. Buiten tijdvenster? → `auto_close_window` stop

**Stopredenen:**

| Reden | Trigger |
|---|---|
| `phantom_sl` | Prijs raakt de originele SL |
| `timeout` | 24 uur verstreken |
| `auto_close_window` | 22:00 Brussels |
| `failsafe` | 24u + 5min veiligheidsklep |
| `restart_lost` | Ghost verloren bij herstart (orphan repair) |

**Finalise:**
- `trueMaxRR` = max RR bereikt na sluiting
- `ghostExtraRR` = trueMaxRR − maxRR@close
- `ghostMAE` = max adverse excursion in R
- Opgeslagen in `closedTrades` en PostgreSQL
- Triggert daarna automatisch TP Lock, SL Lock en Shadow Optimizer

### Ghost Manual Extension
Als een trade **manueel** gesloten wordt (`closeReason = "manual"`), loopt de ghost tracker door met `isManual = true`. Dit laat zien wat er was gebeurd als je de trade niet handmatig had gesloten.

### Orphan Repair
Bij herstart van de server worden ghost trackers die verloren gingen gerepareerd: `trueMaxRR = maxRR` en `ghostStopReason = "restart_lost"`.

---

## 9. TP Lock Engine

### Doel
Bepaalt statistisch de optimale TP-target (in R) per symbool per sessie.

### Triggering
- Na elke ghost finalisatie (`finaliseGhost`)
- Nightly cron om 03:00 (alle symbolen)

### Algoritme (`_runTPLockForSession`)

1. Filter trades: zelfde symbool + sessie, minimaal 3 trades
2. Bereken EV voor elke RR-level:
   ```
   EV = winrate × RR − (1 − winrate)
   ```
3. Kies het RR-level met de hoogste EV (ook bij negatieve EV — altijd statistisch beste)
4. Lock opslaan als: nieuw, veranderd, of ≥5 nieuwe trades

**Composite key:** `SYMBOL__SESSION` (bijv. `EURUSD__london`)

**Compound Boost:**
Als een symbool/sessie meerdere aaneengesloten winstdagen heeft:
```
compoundBoost = 1.2^(aaneengesloten positieve dagen)
```
Dit verhoogt het risicobedrag bij nieuwe trades met een actieve positieve lock.

### Persistentie
- In-memory: `tpLocks` object
- PostgreSQL: `tp_config` tabel (UPSERT per symbool+sessie)
- Log: `tp_update_log`

---

## 10. SL Lock Engine

### Doel
Bepaalt de optimale SL-groottefactor (multiplier) statistisch. Een multiplier < 1.0 verkleint de SL (hogere RR maar meer SL-hits), > 1.0 vergroot de SL.

### Triggering
- Na elke ghost finalisatie
- Nightly cron om 03:00
- Startup bij symbolen met ≥30 trades

### Algoritme (`runSLLockEngine`)

1. Filter: minimaal 10 trades, SL en entry aanwezig
2. `buildSLAnalysis()`: voor elke SL-multiplier (0.5×, 0.6×, 0.75×, ..., 3.0×) bereken beste EV
3. Kies de multiplier met de hoogste EV
4. Richting bepalen: `up` (groter), `down` (kleiner), `unchanged`
5. Auto-apply bij ≥30 trades

### SL Multipliers beschikbaar
`[0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0]`

### Auto-Apply vs. Readonly

| Trades | Status |
|---|---|
| < 10 | Geen analyse |
| 10–29 | Readonly (suggestie, niet toegepast) |
| ≥ 30 | Auto-applied (direct toegepast op nieuwe orders) |

---

## 11. Shadow SL Optimizer

### Doel
Verfijnde SL-optimalisatie op basis van `trueMaxRR` (ghost-gecorrigeerde data). Nauwkeuriger dan de SL Lock Engine omdat het de werkelijke prijs na sluiting meeneemt.

### Verschil met SL Lock Engine

| | SL Lock Engine | Shadow SL Optimizer |
|---|---|---|
| Data | maxRR@close | trueMaxRR (ghost) |
| Nauwkeurigheid | Gebaseerd op sluitmoment | Gebaseerd op werkelijk verloop |
| Minimaal | 10 trades | 30 ghost-gefinaliseerde trades |
| Triggering | Elke ghost finalisatie | Na 30+ ghost trades + na 22:00 cron |

### Algoritme

Voor elke SL-multiplier: bereken of `trueMaxRR / mult ≥ RR` per trade.
Kies de combinatie met hoogste EV.

### Route
`GET /sl-shadow` — bekijk alle resultaten
`POST /sl-shadow/run` — handmatig triggeren

---

## 12. Daily Risk Scaling

### Doel
Past het dagelijkse risico aan op basis van de prestaties van de vorige dag.

### Mechanisme

**Om 21:50** (na auto-close):
- Alle trades van die dag worden opgeteld
- Totale PnL positief? → `dailyRiskMultiplierNext = huidig × 1.2`
- Totale PnL negatief? → `dailyRiskMultiplierNext = 1.0` (reset)

**Om 02:00** (dagelijkse reconnect):
- `dailyRiskMultiplier = dailyRiskMultiplierNext`
- Nieuwe dag start met bijgewerkt risico

### Consecutive Positive Days

Het systeem telt aaneengesloten winstdagen per symbool+sessie combinatie. Dit wordt gebruikt voor de compound boost bij TP Lock trades.

Bij herstart wordt dit gereconstrueerd vanuit `closedTrades` (max. 30 werkdagen terug, weekenden worden overgeslagen).

---

## 13. Positie Synchronisatie

### syncPositions (elke 30 seconden)

1. **Open posities ophalen** van MetaApi
2. **Prijzen bijwerken** per positie: currentPnL, maxPrice, maxRR
3. **Gesloten posities detecteren** (aanwezig in `openPositions` maar niet meer op MT5):
   - `closeReason` bepalen: `tp`, `sl`, of `manual`
   - TP-hit check: `maxRR ≥ TP RR`
   - SL-hit: `maxRR ≤ 0.05`
   - Overig: `manual`
   - Trade opslaan in `closedTrades` en PostgreSQL
   - Ghost tracker starten (tenzij insta-SL)
4. **Account snapshot** elke 5 minuten (balance, equity, floating PnL)

### Restart Recovery (`restoreOpenPositionsFromMT5`)

Bij serverherstart:
1. Haal live posities op van MT5
2. Posities die tijdens downtime gesloten zijn → verwijder uit tracker
3. Nieuwe posities die niet in `openPositions` staan → herstel

---

## 14. Cron Jobs

Alle crons draaien in `Europe/Brussels` tijdzone.

| Tijd | Dagen | Actie |
|---|---|---|
| **21:50** | Ma–Vr | Auto-close alle open posities |
| **21:00** | Ma–Vr | EOD Ghost Check: start ghosts voor recent gesloten trades zonder trueMaxRR |
| **22:00** | Ma–Vr | Hard stop alle actieve ghost trackers + Shadow Optimizer run |
| **02:00** | Dagelijks | Reconnect: risk multiplier activeren, positions herstellen, duplicate guard clearen |
| **03:00** | Dagelijks | Nightly Optimizer: TP Lock + SL Lock + Shadow Optimizer voor alle symbolen |

### Auto-Close (21:50)
- Alle open MT5-posities worden gesloten
- Crypto in weekend wordt **niet** gesloten (apart weekend-venster)
- Na close: `evaluateDailyRisk()` triggeren voor morgen-multiplier

---

## 15. Database Schema

### Tabellen

#### `closed_trades`
Alle gesloten trades met ghost-data.

| Kolom | Type | Beschrijving |
|---|---|---|
| `position_id` | TEXT UNIQUE | MT5 positie-ID |
| `symbol` | TEXT | TradingView symbool |
| `direction` | TEXT | buy/sell |
| `entry` | NUMERIC | Instapprijs |
| `sl` | NUMERIC | Stop Loss prijs |
| `tp` | NUMERIC | Take Profit prijs |
| `max_rr` | NUMERIC | Max RR bij sluiting |
| `true_max_rr` | NUMERIC | Max RR na ghost tracking |
| `ghost_stop_reason` | TEXT | phantom_sl / timeout / etc. |
| `close_reason` | TEXT | tp / sl / manual / auto |
| `realized_pnl_eur` | NUMERIC | Gerealiseerde winst/verlies |
| `sl_multiplier` | NUMERIC | Toegepaste SL-multiplier |

#### `tp_config`
TP Lock configuratie per symbool + sessie.

| Kolom | Type | Beschrijving |
|---|---|---|
| `symbol` | TEXT | Handelssymbool |
| `session` | TEXT | asia/london/ny |
| `locked_rr` | NUMERIC | Gekozen TP in R |
| `ev_at_lock` | NUMERIC | EV op moment van lock |
| `locked_trades` | INTEGER | Aantal trades bij lock |

**Primary key:** `(symbol, session)`

#### `sl_config`
SL Lock configuratie per symbool.

| Kolom | Type | Beschrijving |
|---|---|---|
| `symbol` | TEXT PRIMARY KEY | Handelssymbool |
| `multiplier` | NUMERIC | Gekozen SL-multiplier |
| `direction` | TEXT | up/down/unchanged |
| `auto_applied` | BOOLEAN | True vanaf ≥30 trades |
| `ev_at_lock` | NUMERIC | EV bij lock |

#### `ghost_analysis`
Detailanalyse per ghost-run.

Bevat: symbol, session, direction, entry, sl, tp, maxRRAtClose, trueMaxRR, ghostExtraRR, ghostHitSL, ghostMAE, ghostTimeToSL, isManual, closeReason, ghostDurationMin.

**UNIQUE INDEX:** `trade_position_id` (v7.7 fix — voorheen geen constraint)

#### `shadow_sl_analysis`
Shadow SL Optimizer resultaten, één rij per symbool (UPSERT).

| Kolom | Beschrijving |
|---|---|
| `best_multiplier` | Optimale SL-multiplier |
| `best_ev` | Bijbehorende EV |
| `best_rr` | Optimale TP bij die multiplier |
| `sl_hit_rate` | % trades waarbij prijs SL raakte |
| `trades_used` | Aantal ghost-trades gebruikt |

#### Overige tabellen
- `equity_snapshots` — account balance/equity elke 5 min
- `tp_update_log` — geschiedenis van TP Lock wijzigingen
- `sl_update_log` — geschiedenis van SL Lock wijzigingen
- `ghost_analysis` — uitgebreide ghost statistieken
- `trade_pnl_log` — PnL per trade (voor snelle aggregaties)
- `daily_risk_log` — dagelijkse risico-multiplier log
- `duplicate_entry_log` — geblokkeerde duplicate orders
- `forex_consolidation_log` — geblokkeerde forex pyramiding
- `shadow_sl_log` — wijzigingen in shadow optimizer

---

## 16. API Endpoints — Volledig Overzicht

**Base URL:** `https://tradingftmo-demo-live-production-8b1e.up.railway.app`

### Webhooks (POST)

| Endpoint | Body | Beschrijving |
|---|---|---|
| `POST /webhook?secret=...` | `{ symbol, action, entry, sl }` | TradingView alert verwerken |
| `POST /close` | `{ positionId, symbol?, direction? }` | Positie manueel sluiten |
| `POST /sl-shadow/run` | `{ symbol? }` | Shadow optimizer triggeren |

### Live Data (GET)

| Endpoint | Beschrijving |
|---|---|
| `GET /` | Server status, versie, tracking counts |
| `GET /status` | OpenTradeTracker, learnedPatches, risico per type |
| `GET /live/positions` | Alle open posities met risk%/PnL%/SL% |
| `GET /live/ghosts` | Actieve ghost trackers met delta en MAE |

### Optimizers (GET)

| Endpoint | Parameters | Beschrijving |
|---|---|---|
| `GET /tp-locks` | — | Alle TP Locks per symbool/sessie |
| `GET /sl-locks` | — | Alle SL analyses + auto-apply status |
| `GET /sl-shadow` | `?symbol=` | Shadow SL resultaten |
| `GET /daily-risk` | — | Dagelijkse multiplier + effectief risico |

### Analyse (GET)

| Endpoint | Parameters | Beschrijving |
|---|---|---|
| `GET /analysis/equity-curve` | `?hours=24` | Equity snapshots uit DB of memory |
| `GET /analysis/ghost-deep` | — | Ghost statistieken per symbool/sessie |
| `GET /analysis/pnl` | `?symbol=&session=` | PnL statistieken uit DB |
| `GET /analysis/extremes` | `?n=10` | Beste/slechtste trades + sessie summary |
| `GET /analysis/rr` | `?symbol=&session=` | RR verdeling + EV tabel |
| `GET /analysis/sessions` | — | Asia/London/NY vergelijking |

### Research (GET)

| Endpoint | Parameters | Beschrijving |
|---|---|---|
| `GET /research/tp-optimizer` | `?symbol=` | Beste TP RR globaal + per symbool/sessie |
| `GET /research/tp-optimizer/sessie` | `?symbol=` | TP optimizer per sessie |

### Matrix & History (GET)

| Endpoint | Beschrijving |
|---|---|
| `GET /api/matrix` | Pair × sessie matrix (server-side computed) |
| `GET /history?limit=50` | Laatste webhook events |

### Admin (DELETE)

| Endpoint | Beschrijving |
|---|---|
| `DELETE /tp-locks/:symbol` | TP Locks verwijderen voor symbool |
| `DELETE /sl-locks/:symbol` | SL analyse verwijderen voor symbool |

### Dashboard

| Endpoint | Beschrijving |
|---|---|
| `GET /dashboard` | Dark terminal UI — volledig interactief |

---

## 17. Dashboard

Het dashboard is een server-side gerenderde HTML-pagina met client-side data-refresh elke 30 seconden.

### Secties

1. **Account KPI Strip** — Balance, Floating P&L, Open Posities, Actieve Ghosts, Closed Trades, Gem. RR, TP Locks
2. **Daily Risk** — Vandaag/morgen multiplier, risico% per type
3. **Open Posities** — Risk%, SL afstand%, PnL%, lots, SL multiplier, openingstijd
4. **Actieve Ghosts** — delta (trueRR − maxRR@close), MAE, closeReason badge, elapsed tijd
5. **Sessie Overzicht** — Asia/London/NY tabel (sorteerbaar op alle kolommen)
6. **Tijd-tot-SL** — Gem/snelste/traagste minuten per pair × sessie
7. **Pair × Sessie Matrix** — TP Lock RR, EV, trades, shadow SL, auto-apply status
8. **Cron Status** — Laatste run tijd per job
9. **Webhook History** — Laatste 20 events

### CSP Configuratie (v7.7 fix)
Helmet is geconfigureerd met `unsafe-inline` voor scripts (vereist voor inline dashboard JS) en Google Fonts toestemming.

---

## 18. Foutafhandeling & Zelflerend Systeem

### learnFromError

Bij MetaApi-fouten past het systeem automatisch aan:

| Foutcode | Aanpassing |
|---|---|
| `TRADE_RETCODE_INVALID` + "symbol" | Probeer `.cash` toe te voegen/verwijderen aan MT5-symbool |
| "volume" of "lot" in bericht | Lot-stap × 10 |
| "stop" of `TRADE_RETCODE_INVALID_STOPS` | Minimale stop verdubbelen voor dat instrument |

Deze patches worden opgeslagen in `learnedPatches[symbol]` en overleven herstarts niet (in-memory). Bij een herstart worden ze opnieuw opgebouwd vanuit fouten.

### Timeout Beveiliging

Alle MetaApi-calls hebben een AbortController + 8 seconden timeout:
- `fetchOpenPositions()`
- `fetchAccountInfo()`
- `closePosition()`
- `placeOrder()` (v7.7 fix: ook de /trade POST)
- `placeOrderWithTimeout()` via Promise.race

### Ghost Failsafe Timer

Elke ghost tracker heeft naast de normale poll-timer ook een failsafe timer van 24u + 5 minuten. Als de normale timer crasht, ruimt de failsafe op.

---

## 19. Bugfixes v7.7

### Bug 1 — CRITICAL: slMultiplierApplied niet opgeslagen in DB

**Probleem:** In `openPositions` werd het veld `slMultiplierApplied` gezet, maar `saveTrade()` in `db.js` las `trade.slMultiplier` (undefined → standaard 1.0). De werkelijk toegepaste SL-multiplier ging verloren bij elke trade-close.

**Fix:** `db.js` saveTrade: `trade.slMultiplierApplied ?? trade.slMultiplier ?? 1.0`

### Bug 2 — CRITICAL: placeOrder fetch zonder AbortController

**Probleem:** De `fetch` naar `/trade` in `placeOrder()` had geen `signal`. Na 8s timeout via `Promise.race` in `placeOrderWithTimeout()` bleef de onderliggende fetch hangen → stale connections accumuleerden op Railway.

**Fix:** `server.js` placeOrder: AbortController + `signal: ctrl.signal` toegevoegd aan de fetch.

### Bug 3 — ghost_analysis ON CONFLICT triggerde nooit

**Probleem:** De `ghost_analysis` tabel had geen UNIQUE constraint op `trade_position_id`. `ON CONFLICT DO NOTHING` conflicteerde dus enkel op de SERIAL primary key (nooit) → duplicate ghost analyses werden ingevoegd.

**Fix:** `db.js` initDB: `CREATE UNIQUE INDEX idx_ghost_trade_position_id ON ghost_analysis(trade_position_id) WHERE trade_position_id IS NOT NULL` + `ON CONFLICT (trade_position_id) DO NOTHING`.

### Bug 4 — loadSnapshots SQL injection patroon

**Probleem:** `WHERE ts > NOW() - INTERVAL '${hours} hours'` gebruikte een template literal in SQL.

**Fix:** `db.js` loadSnapshots: `WHERE ts > NOW() - ($1 * INTERVAL '1 hour')` met parameterized query.

### Bug 5 — Autoclose cron isWE altijd false

**Probleem:** De cron draait alleen ma–vr (`1-5`), dus `isWE` was altijd `false`. De crypto-weekend-skip in de loop triggerde nooit.

**Fix:** `server.js`: dead code verwijderd.

### Bug 6 — reconstructConsecutivePositiveDays loop te kort

**Probleem:** Loop `i <= 30` over kalenderdagen bevat ~22 werkdagen, niet 30. De streak-reconstructie was dus korter dan bedoeld.

**Fix:** `server.js`: outer loop tot 50 kalenderdagen zodat 30 werkdagen bereikt worden.

### Bug 7 — Dashboard title v7.5 in v7.7 codebase

**Fix:** HTML `<title>` en logo label bijgewerkt naar v7.7.

### Bug 8 — Helmet CSP blokkeerde inline dashboard scripts

**Probleem:** `app.use(helmet())` met standaard CSP blokkeerde alle inline `<script>` tags → matrix bleef "Laden...", klok toonde "--:--:--".

**Fix:** Helmet geconfigureerd met `scriptSrc: ["'self'", "'unsafe-inline'"]` en Google Fonts toegestaan.

### Bug 9 — package.json versie 7.5.0 bij v7.7 codebase

**Fix:** `"version": "7.7.0"` in package.json.

---

## 20. Deploymentinstructies

### Vereisten
- Node.js ≥ 18.0.0
- PostgreSQL database (Railway auto-provisioned)
- MetaApi account met REST API toegang

### Railway Setup

1. Nieuwe Railway service aanmaken
2. GitHub repo koppelen (of bestanden uploaden)
3. PostgreSQL database toevoegen aan project
4. Environment variabelen instellen (zie sectie 3)
5. `railway up` of auto-deploy via GitHub push

### Lokaal draaien
```bash
npm install
node server.js
```

### Eerste startup
Bij eerste start:
1. `initDB()` — alle tabellen worden aangemaakt (idempotent via `IF NOT EXISTS`)
2. `loadAllTrades()` — bestaande trades geladen
3. `loadTPConfig()` / `loadSLConfig()` / `loadShadowSLAnalysis()` — optimizer-data hersteld
4. `restoreOpenPositionsFromMT5()` — open posities van MT5 hersteld
5. `repairOrphanedGhosts()` — verloren ghost-data gerepareerd
6. `reconstructConsecutivePositiveDays()` — streaks hersteld
7. `runSLLockEngine()` voor symbolen met ≥30 trades
8. `runShadowSLOptimizerAll()` — alle shadow analyses
9. Server start luisteren op `PORT`

### TradingView Alert Configuratie
```
URL: https://tradingftmo-demo-live-production-8b1e.up.railway.app/webhook?secret={{WEBHOOK_SECRET}}
Method: POST
Body:
{
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "entry": {{close}},
  "sl": {{plot_0}}
}
```

---

## Technische Stack

| Component | Technologie |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Security | Helmet (CSP geconfigureerd) |
| Scheduling | node-cron |
| Database | PostgreSQL via `pg` |
| Hosting | Railway |
| Broker API | MetaApi REST (London endpoint) |
| Alerts | TradingView webhooks |
| Tijdzone | Intl.DateTimeFormat — Europe/Brussels |

---

*Documentatie gegenereerd voor FTMO Webhook Server v7.7 | Nick Verschoot — PRONTO-AI | April 2026*
