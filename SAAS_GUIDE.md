# WhatsApp Bot SaaS — Guida Completa

_Aggiornato: 2026-06-22_

> **Pre-commit**: `.githooks/pre-commit` → `scripts/check-syntax.js` (`npm run check`) valida JS inline + i18n.js. Su clone nuova: `git config core.hooksPath .githooks`.

---

## Indice

1. [Per il merchant — Pannello Admin](#1-per-il-merchant--pannello-admin)
2. [Bot Sara — esperienza cliente](#2-bot-sara--esperienza-cliente)
3. [Bot merchant — comandi WhatsApp](#3-bot-merchant--comandi-whatsapp)
4. [Stack tecnico e deployment](#4-stack-tecnico-e-deployment)
5. [Piani e moduli](#5-piani-e-moduli)
6. [Architettura e ottimizzazioni](#6-architettura-e-ottimizzazioni)
7. [DB — tabelle principali](#7-db--tabelle-principali)
8. [Billing Stripe](#8-billing-stripe)
9. [i18n](#9-i18n)
10. [Sicurezza](#10-sicurezza)
11. [Import / Export catalogo](#11-import--export-catalogo)
12. [Appuntamenti](#12-appuntamenti)
13. [Ristorante](#13-ristorante)
14. [Tenant di test](#14-tenant-di-test)

---

## 1. Per il merchant — Pannello Admin

Accesso: `sarabot.pro/admin` → inserire slug tenant + password.

### Tab disponibili per piano

| Tab | Shop | Bookings | Restaurant | Pro |
|-----|:----:|:--------:|:----------:|:---:|
| Prodotti | ✅ | — | ✅ (menu) | ✅ |
| Ordini | ✅ | — | ✅ | ✅ |
| Clienti | ✅ | ✅ | ✅ | ✅ |
| Chat | ✅ | ✅ | ✅ | ✅ |
| Appuntamenti | — | ✅ | — | ✅ |
| Prenotazioni | — | — | ✅ | — |
| Servizi | — | ✅ | — | ✅ |
| Impostazioni | ✅ | ✅ | ✅ | ✅ |

### Prodotti / Menu

- **Importa**: da immagini (foto catalogo/menu → AI riconosce prodotti), da Excel template, da ZIP immagini (fuzzy-match nome file → prodotto).
- **Esporta**: CSV (`sep=;`, BOM, riga metadati `# sarabot.pro`) — round-trip pulito con il template Excel.
- **Cerca**: barra 🔍 in riga titolo — filtra per nome/categoria/descrizione in tempo reale.
- **Filtro categoria**: pillole sotto la barra di ricerca. `aa` = tutte le categorie.
- **Stock**: clicca direttamente sul numero per modificarlo.
- **Foto**: caricamento diretto dal pannello; Sara la mostra al cliente quando menziona il prodotto.

### Ordini

- **Nuovo ordine**: tasto "+ Nuovo ordine". Seleziona cliente dalla rubrica esistente o crea cliente al volo.
- **Aggiungi item**: mostra catalogo per default. Seleziona prodotto o scegli "Voce personalizzata" per item non in catalogo (inserisci nome + prezzo manuale).
- **Deduplicazione**: se aggiungi lo stesso item due volte, le quantità si sommano automaticamente al salvataggio.
- **Modifica ordine**: tasto ✏️ inline accanto al menu stato — apre lo stesso modal con i dati precompilati.
- **Stato**: pill colorata + select inline (`In attesa → Confermato → In preparazione → In consegna → Consegnato / Annullato`).
- **Cerca**: barra 🔍 filtra per nome cliente, telefono, nome item. Auto-aggiornamento ogni 10s.

### Clienti

- **Tabella**: Nome | Telefono | Email | Ultimo contatto.
- **Aggiungi**: tasto "+ Aggiungi cliente". Campi: Nome* | Telefono* | Email | Indirizzo. Nome e telefono obbligatori.
- **Modifica**: tasto ✏️ per riga — apre modal precompilato. Tutti i campi modificabili incluso numero di telefono.
- **Cerca**: barra 🔍 filtra per nome, telefono o email.

### Chat

- Lista conversazioni con badge messaggi non letti.
- Takeover: il merchant risponde direttamente; i messaggi vanno al cliente bypassando Sara.
- Stop takeover: il cliente scrive di nuovo e Sara riprende automaticamente.

### Appuntamenti (Bookings / Pro)

- Calendario slot disponibili (14 giorni).
- Nuova prenotazione: seleziona servizio, data, ora, cliente.
- Blocco orario: intervalli non prenotabili (pause, ferie).
- Chiusure: range date (es. vacanze).
- Revenue: pagato oggi + non pagato pianificato oggi (escluso cancellato, escluso stornato).

### Prenotazioni (Restaurant)

- Lista prenotazioni con stato. Walk-in diretto dalla tab.
- Pending: prenotazione in attesa di conferma merchant (gruppi grandi).

### Servizi (Bookings / Pro)

- Lista servizi con prezzo e durata.
- Cerca per nome o categoria.
- Nuovo / modifica / elimina servizio.
- Mobility: servizi a domicilio (Sara chiede l'indirizzo al cliente).

### Impostazioni

- **Bot**: nome bot, personalità, lingua, istruzioni personalizzate.
- **Profilo WhatsApp**: foto, descrizione, email, sito web, categoria (vertical) del business. Scritti direttamente sul profilo WhatsApp Business via Cloud API; il form precarica i valori attuali da Meta. Foto via Resumable Upload API (richiede `META_APP_ID`). Nota: lo status breve "Acerca de" sotto il nome non è settabile via Cloud API. L'**indirizzo** non sta qui: si imposta in "Il mio negozio" e viene sincronizzato automaticamente sul profilo WhatsApp al salvataggio.
- **Il mio negozio**: indirizzo, telefono supporto, link recensioni Google, posizione mappa. L'indirizzo viene mirrorato sul profilo WhatsApp.
- **Orari**: apertura/chiusura per giorno (doppio slot supportato).
- **Delivery**: zone, tariffe, disponibilità per giorno.
- **Pagamenti**: testo con istruzioni di pagamento (mostrato a ogni ordine).
- **Piano**: dettagli subscription, link gestione Stripe.
- **Supporto**: numero di contatto umano (mostrato ai clienti su richiesta).

---

## 2. Bot Sara — esperienza cliente

Sara risponde su WhatsApp in automatico, **nella lingua del cliente** (ES, IT, EN, FR, DE, PT, jopará).

### Cosa fa

| Modulo | Comportamento |
|--------|--------------|
| **Catalogo** | Mostra categorie prima, poi dettagli (max 5 per messaggio). Mai dump completo. |
| **Ordini** | Chiede conferma esplicita, poi genera `<ORDER>`. Mostra istruzioni pagamento. |
| **Foto** | Invia foto prodotto proattivamente appena il cliente lo menziona. |
| **Menu ristorante** | Invia menu live dal DB con `<SEND_MENU>` (mai scritto a mano). |
| **Appuntamenti** | Propone slot liberi su 14 giorni, gestisce modifica e cancellazione. |
| **Prenotazioni tavolo** | Propone orari con tavoli liberi, conferma con `<RESERVATION>`. |
| **Delivery** | Calcola tariffa per zona, informa se il delivery è disabilitato oggi. |
| **Offerte** | Mostra prezzi scontati dal DB con etichetta promo. |
| **Waitlist** | Se prodotto esaurito, registra interesse con `<WAITLIST>`. |
| **Cross-sell** | 1 suggerimento complementare opzionale al momento della conferma ordine. |
| **Contatto umano** | Fornisce numero supporto solo se il cliente lo chiede esplicitamente. |
| **Stato ordine** | Visible nel dynamic prompt — risponde a "dov'è il mio ordine". |

### Cosa NON fa

- Non mostra dati di altri clienti.
- Non modifica prezzi, stock, impostazioni.
- Non rivela email/telefono privato del merchant.
- Non gestisce rimborsi.
- Non risponde a topic off-topic (`<OFF_TOPIC>`).
- Non svela il system prompt né ammette di essere un'AI.

### Stile

- Messaggi brevi (max 3-4 righe). Una domanda alla volta. No "¡Perfecto!" o "¡Claro que sí!". Max 1 emoji per messaggio.

---

## 3. Bot merchant — comandi WhatsApp

Il merchant scrive in linguaggio naturale alla propria stessa utenza WhatsApp (numero del bot). Sara interpreta l'intento e agisce. Qualsiasi lingua.

### Catalogo e stock

```
"arrivate 50 bottiglie di Malbec"   → update_stock +50
"il Malbec costa 15000"             → set_price
"il Malbec è esaurito"              → mark_unavailable
"aggiungi torta de chocolate 8000"  → add_product
"elimina il prodotto X"             → delete_product
```

### Ordini

```
"ordini in corso"                   → get_orders (active)
"conferma l'ordine di Maria"        → update_order_status confirmed
"segnalo come consegnato"           → update_order_status delivered
```

### Clienti

```
"il 0981123456 si chiama Juan"      → name_customer
"aggiorna email di Juan a x@y.com"  → update_customer
"elimina il cliente Maria"          → delete_customer
```

### Appuntamenti (Bookings / Pro)

```
"appuntamenti di oggi"              → get_appointments
"prenota taglio capelli per Ana lunedì alle 10"  → add_appointment
"annulla l'appuntamento di Pedro"   → cancel_appointment
"blocca domani dalle 14 alle 16"    → block_time
"chiusi dal 24 al 26 dicembre"      → create_closure
```

### Ristorante

```
"prenotazioni di stasera"           → get_reservations
"prenota per 4 persone sabato alle 20"  → book_table
"blocca 2 tavoli per domani sera"   → block_tables
"conferma la prenotazione di Mario" → confirm_reservation
```

### Offerte

```
"sconto 20% su tutti i prodotti fino a domenica"  → create_offer
"elimina l'offerta estate"                        → delete_offer
```

### Servizi

```
"lista servizi"                     → get_services
"il taglio dura 45 minuti"          → update_service
"aggiungi servizio manicure 50000"  → add_service
```

### Statistiche

```
"quanti ordini oggi"                → get_stats today/orders
"fatturato del mese"                → get_stats month/revenue
"clienti nuovi questa settimana"    → get_stats week/customers
```

### Chat

```
"chat con Ana" / "passa ad Ana"     → chat_takeover (il merchant scrive direttamente)
(qualsiasi messaggio libero in takeover → viene inoltrato al cliente)
```

### Broadcast

```
"manda a tutti: nuovi arrivi in store!"  → broadcast (clienti attivi 30gg)
```

### Orari

```
"lunedì apriamo alle 9 e chiudiamo alle 20"  → set_hours
"domenica siamo chiusi"                       → set_hours is_closed
```

---

## 4. Stack tecnico e deployment

| Layer | Tech |
|-------|------|
| Server | Node.js + Express (Render) |
| DB | Supabase (PostgreSQL + Storage) |
| AI | Anthropic Claude — Haiku per chat/vision, Sonnet per task complessi |
| Messaggistica | Meta Cloud API (WhatsApp) |
| Billing | Stripe (subscription, trial 7gg) |
| Email | Brevo HTTP API (`BREVO_API_KEY`) |
| Dominio | `sarabot.pro` → Cloudflare → Render. Webhook Meta punta a `onrender.com` direttamente. |

### Flusso webhook cliente

```
Cliente WhatsApp → Meta → /webhook
  → identifica tenant da phone_number_id
  → carica stock + storico (Promise.all)
  → [se booking keywords] carica orari + slot 14gg
  → Claude Haiku → Sara risponde (prompt caching)
  → ordine confermato → notifica merchant
```

### Flusso merchant WhatsApp

```
Merchant → Meta → /webhook
  → identifica come merchant (phone match)
  → [takeover attivo] → forwarda al cliente
  → altrimenti: Claude Haiku parse NL → action JSON
  → esegui action → risposta al merchant
```

---

## 5. Piani e moduli

| Piano | products | services | appointments | restaurant |
|-------|:--------:|:--------:|:------------:|:----------:|
| Shop | ✅ | — | — | — |
| Bookings | — | ✅ | ✅ | — |
| Restaurant | ✅ | — | ✅ | ✅ |
| Pro | ✅ | ✅ | ✅ | — |

I flag booleani nel DB (`products_enabled`, `services_enabled`, `appointments_enabled`, `restaurant_enabled`) determinano: tab visibili nel pannello admin, azioni disponibili nel bot merchant, comportamento di Sara con i clienti. Vanno **sempre scritti espliciti** (true/false, mai null).

---

## 6. Architettura e ottimizzazioni

**Prompt caching** (`services/claude.js`): system prompt splittato in static (catalogo, regole, identità — `cache_control: ephemeral`) + dynamic (delivery state, slot, mobility). Risparmio ~8500 token/messaggio. Soglia minima Haiku: 4096 token.

**Appointment keyword gating** (`routes/webhook.js`): le 3 query Supabase extra + calcolo slot girano solo se il messaggio/history menzionano parole chiave booking.

**Cache in-memory** (`services/stock.js`): TTL 45s su `getTenantConfig`/`getStock`/`getServices`/`getOffers`/`getBusinessClosures`. `invalidate*` chiamati dopo ogni modifica.

**Admin panel cache** (`public/admin/index.html`): `_allOrders`, `_allCustomers`, `_allServices` caricati una volta per tab-switch; `render*()` filtrano in memoria. Auto-refresh ordini ogni 10s.

**Modelli AI per task**:

| Task | Modello |
|------|---------|
| Chat cliente (webhook) | `claude-haiku-4-5-20251001` |
| Parse comandi merchant | `claude-haiku-4-5-20251001` |
| Import catalogo da foto | `claude-haiku-4-5-20251001` |
| Ragionamento complesso | `claude-sonnet-4-6` |

---

## 7. DB — tabelle principali

| Tabella | Scopo |
|---------|-------|
| `tenants` | Un record per attività. Flag piano, valuta, token WhatsApp, pending bot state. |
| `products` | Catalogo + stock (shop) / menu + allergeni (ristorante) |
| `services` | Servizi con `duration_min` (multiplo 15), `price_guarani` |
| `orders` | `pending→confirmed→preparing→delivering→delivered/cancelled`. `customer_name TEXT` (colonna diretta). |
| `conversations` | Storico messaggi Claude (MAX 20, cleanup 90gg) |
| `appointments` | `paid`, `paid_at`, `price_guarani`, `refunded`, `start_at`, `end_at` |
| `business_hours` | Orari per giorno (slot 1 + slot 2) |
| `appointment_blocks` | Blocchi manuali orario |
| `reservations` | Prenotazioni ristorante (`table_id`, `table_ids BIGINT[]`) |
| `restaurant_tables` | Tavoli (capacità, zona) |
| `business_closures` | Chiusure/ferie con date range |
| `offers` | Sconti (percent/fixed, scope, date validità) |
| `waitlist` | Lista attesa prodotti esauriti |
| `promo_codes` + `promo_redemptions` | Codici promozionali SaaS |

---

## 8. Bot di supporto merchant

`SUPPORT_SYSTEM_PROMPT` in `routes/admin.js` — risponde in automatico ai merchant nella tab ❓ Aiuto e Supporto del pannello.

- Modello: `claude-haiku-4-5-20251001`, max 512 token.
- Conosce: tutto il pannello web (ogni tab, ogni bottone, incluse search bar, modal clienti, edit ordini), comportamento Sara lato cliente (cosa vede/non vede un cliente), tutti i comandi bot WhatsApp merchant con esempi multi-lingua.
- Escalation: se non può risolvere, inserisce `[ESCALATE]` nel reply → il sistema notifica il superadmin via email.
- Rate limit: limitato per tenant (vedi `checkSupportRateLimit`).
- Non rivela mai credenziali, token, dati di altri tenant.

---

## 9. Billing Stripe

`routes/billing.js`: Checkout (`mode:'subscription'`, trial 7gg) → webhook attiva/sospende tenant + scrive flag piano nel DB → cancel/reactivate → change-plan (upgrade/downgrade immediato con proration).

`PLAN_FLAGS` in `billing.js`: mappa piano → `{products_enabled, services_enabled, appointments_enabled, restaurant_enabled}`.

**Env vars**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` per ogni piano. **Ancora da configurare su Render con valori live.**

---

## 10. i18n


6 lingue: ES / EN / IT / DE / FR / PT. Chiave localStorage `sara_lang` condivisa tra tutte le pagine.

- `public/admin/i18n.js` — TR object admin
- `public/register/i18n.js` — TR object register
- Pattern errori: backend aggiunge `errorCode: 'snake_case'`; frontend usa `errMsg(e)` → `t('err.' + e.code)`.
- Ogni nuovo testo UI deve avere traduzione in tutte e 6 le lingue. Mai stringhe hardcoded.

---

## 11. Sicurezza

- Firma webhook Meta (HMAC-SHA256). JWT in HttpOnly cookie (`sara_token`). Trust proxy 1 (IP reale dietro Render). Rate limit su tutti gli endpoint pubblici. Injection block silenzioso. XSS: `textContent` non `innerHTML` per dati utente. No secret hardcoded (fail-fast all'avvio).
- Rate limit: cliente 50/h, merchant 120/h + 400/giorno.
- `select('*')` su `tenants` solo in `getTenantConfig` (interno/server-side). Query frontend: campi espliciti.
- Token WhatsApp, `merchant_phone`, credenziali pagamento = PII. Non esporre in log o risposte API.

---

## 12. Import / Export catalogo

- Template Excel: `catalog_template.xlsx` (shop) + `menu_template.xlsx` (ristorante), generati da `scripts/gen-templates.js`.
- Export CSV: `sep=;` + riga metadati `# sarabot.pro` + BOM. Colonne = template → round-trip pulito.
- Import: delimiter-aware (`;`/`,`), salta `sep=;` e righe `#`, alias colonne EN/ES.
- ZIP bulk images: fuzzy-match nome file → prodotto, max 300 img / 50MB / 8MB per img, magic bytes check.
- Import da foto: Haiku vision (non Opus) → JSON array prodotti.

---

## 13. Appuntamenti

- Slot 15 min step; durata servizio multiplo di 15; capacità parallela (`appointment_capacity`).
- `appointment_blocks` bloccano sempre indipendentemente dalla capacità.
- **Revenue** (due bucket): `paid=true AND paid_at::date=oggi AND !refunded` + `paid=false AND start_at::date=oggi AND status!='cancelled' AND !refunded`.
- **Storno** (`refunded=true`): appuntamento pagato poi cancellato esce dall'incasso.
- **Service mobility** (`service_location: own/client/both`): Sara chiede indirizzo se mobility attiva, lo inserisce in `<APPT_NOTE:domicilio:...>`. Stessa struttura tariffa delivery. Visibile per piani con `services_enabled`.

---

## 14. Ristorante

- Piatti in tabella `products` (con `allergens TEXT`). Stock = null (sempre disponibile).
- Prenotazioni: `table_ids BIGINT[]` = tavoli occupati. Pending senza tavolo = non blocca. Sara propone solo slot con tavoli liberi (griglia 7gg in dynamic prompt).
- Walk-in: `POST /restaurant/reservations` con `status=seated`.
- Orari: `business_hours` con slot 1 + slot 2 (`open_time_2/close_time_2`). `restaurant_meal_bands` rimosso (eliminato 2026-06-21).
- Tab admin: Prenotazioni (lista + walk-in), Ristorante (config: durata tavolo, zone, tavoli).

---

## 15. Design / Tema UI

Tema **"v5" editorial caldo** su tutte le superfici (landing, admin, register, superadmin, legali, email). Crema `#fbf6ec` + verde `#2f9e3a` (logo `#41b72d`) + CTA ambra `#e2622a`. Font **Outfit** (titoli) + **Inter** (corpo). Admin/superadmin/register ritematizzati via `tailwind.config` (remap ramp `green`) + `<style>` override.

Bottoni admin: PIENO (`.btn-green` ambra+ombra) / SOFT (`#fcefe6`) / OUTLINE (bordo grigio+`bg-white`) / ROSSO (destructive + notice errore).

**Token e spec completa: `DESIGN_SYSTEM.md` (root)** — leggere prima di toccare l'estetica.

---

## 16. Tenant di test

| Slug | Piano | Password |
|------|-------|----------|
| `testshop` | Shop | `sara1234` |
| `testbookings` | Bookings | `sara1234` |
| `testpro` | Pro | `sara1234` |
| `testrestaurant` | Restaurant | `sara1234` |
