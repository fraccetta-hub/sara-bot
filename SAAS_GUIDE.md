# WhatsApp Bot SaaS — Guida Operativa

_Aggiornato: 2026-06-22_

> **Pre-commit**: `.githooks/pre-commit` → `scripts/check-syntax.js` (`npm run check`) valida JS inline + i18n.js. Su clone nuova: `git config core.hooksPath .githooks`.

---

## Stack

| Layer | Tech |
|-------|------|
| Server | Node.js + Express (Render) |
| DB | Supabase (PostgreSQL + Storage) |
| AI | Anthropic Claude — Haiku per chat/vision, Sonnet per task complessi |
| Messaggistica | Meta Cloud API (WhatsApp) |
| Billing | Stripe (subscription, trial 7gg) |
| Email | Brevo HTTP API (`BREVO_API_KEY`) |
| Dominio | `sarabot.pro` → Cloudflare → Render. Webhook Meta punta a `onrender.com` direttamente. |

---

## Flusso webhook

```
Cliente WhatsApp → Meta → /webhook
  → identifica tenant da phone_number_id
  → carica stock + storico (Promise.all)
  → [se booking keywords] carica orari + slot 14gg
  → Claude Haiku → Sara risponde (prompt caching)
  → ordine confermato → notifica merchant
  → CONFIRMAR/CANCELAR/CHAT/STOP merchant → aggiorna DB + notifica cliente
```

---

## Piani e moduli

| Piano | products | services | appointments | restaurant |
|-------|:--------:|:--------:|:------------:|:----------:|
| Shop | ✅ | — | — | — |
| Bookings | — | ✅ | ✅ | — |
| Restaurant | ✅ | — | ✅ | ✅ |
| Pro | ✅ | ✅ | ✅ | — |

I flag booleani nel DB (`products_enabled`, `services_enabled`, `appointments_enabled`, `restaurant_enabled`) determinano: tab visibili nel pannello admin, azioni disponibili nel bot merchant, comportamento di Sara con i clienti. Vanno **sempre scritti espliciti** (true/false, mai null).

---

## Ottimizzazioni attive

**Prompt caching** (`services/claude.js`): system prompt splittato in static (catalogo, regole, identità — `cache_control: ephemeral`) + dynamic (delivery state, slot, mobility). Risparmio ~8500 token/messaggio. Soglia minima Haiku: 4096 token.

**Appointment keyword gating** (`routes/webhook.js`): le 3 query Supabase extra + calcolo slot girono solo se il messaggio/history menzionano parole chiave booking.

**Cache in-memory** (`services/stock.js`): TTL 45s su `getTenantConfig`/`getStock`/`getServices`/`getOffers`/`getBusinessClosures`. `invalidate*` chiamati dopo ogni modifica.

---

## Bot Sara — cosa fa e non fa

**Cliente**: risponde in lingua automatica. Mostra catalogo/menu/servizi (categorie prima, poi dettagli — no dump completo). Gestisce ordini (shop/ristorante), prenotazioni tavolo (ristorante), appuntamenti (bookings/pro). Foto prodotto proattiva (`<SHOW_IMAGE>`). Menu ristorante sempre live dal DB (`<SEND_MENU>` → `buildMenuText` backend). Offerte nel catalogo. Waitlist esauriti. Stato ordine e storia acquisti nel dynamic prompt.

**Non fa**: dati altri clienti, modifica prezzi/stock/impostazioni, informa su email/telefono privato merchant, rimborsi.

**Merchant** (bot NL): specchio del pannello in linguaggio naturale, qualsiasi lingua. Azioni disponibili per piano. Pending state su `tenants.merchant_pending_json` (in-memory + DB per restart). Fuzzy match prodotti/clienti.

**Security bot**: rate limit cliente 50/h, merchant 120/h + 400/giorno. Injection → drop silenzioso. Broadcast: lock per tenant + max 1000 char. Output: max 5 item per risposta.

---

## Appuntamenti

- Slot 15 min step; durata servizio multiplo di 15; capacità parallela (`appointment_capacity`).
- `appointment_blocks` bloccano sempre indipendentemente dalla capacità.
- **Revenue** (due bucket): `paid=true AND paid_at::date=oggi AND !refunded` + `paid=false AND start_at::date=oggi AND status!='cancelled' AND !refunded`.
- **Storno** (`refunded=true`): appuntamento pagato poi cancellato esce dall'incasso.
- **Service mobility** (`service_location: own/client/both`): Sara chiede indirizzo se mobility attiva, lo inserisce in `<APPT_NOTE:domicilio:...>`. Stessa struttura tariffa delivery. Visibile per piani con `services_enabled`.

---

## Ristorante

- Piatti in tabella `products` (con `allergens TEXT`). Stock = null (sempre disponibile).
- Prenotazioni: `table_ids BIGINT[]` = tavoli occupati. Pending senza tavolo = non blocca. Sara propone solo slot con tavoli liberi (griglia 7gg in dynamic prompt).
- Walk-in: `POST /restaurant/reservations` con `status=seated`.
- Orari: `business_hours` con slot 1 + slot 2 (`open_time_2/close_time_2`). `restaurant_meal_bands` rimosso (eliminato 2026-06-21).
- Tab admin: Prenotazioni (lista + walk-in), Ristorante (config: durata tavolo, zone, tavoli).

---

## Import / Export

- Template Excel: `catalog_template.xlsx` (shop) + `menu_template.xlsx` (ristorante), generati da `scripts/gen-templates.js`.
- Export CSV: `sep=;` + riga metadati `# sarabot.pro` + BOM. Colonne = template → round-trip pulito.
- Import: delimiter-aware (`;`/`,`), salta `sep=;` e righe `#`, alias colonne EN/ES.
- ZIP bulk images: fuzzy-match nome file → prodotto, max 300 img / 50MB / 8MB per img, magic bytes check.

---

## DB — tabelle principali

| Tabella | Scopo |
|---------|-------|
| `tenants` | Un record per attività. Flag piano, valuta, token WhatsApp, pending bot state. |
| `products` | Catalogo + stock (shop) / menu + allergeni (ristorante) |
| `services` | Servizi con `duration_min` (multiplo 15), `price_guarani` |
| `orders` | `pending→confirmed→preparing→delivering→delivered/cancelled` |
| `conversations` | Storico messaggi Claude (MAX 20, cleanup 90gg) |
| `appointments` | `paid`, `paid_at`, `price_guarani`, `refunded`, `start_at`, `end_at` |
| `business_hours` | Orari per giorno (slot 1 + slot 2) |
| `appointment_blocks` | Blocchi manuali orario |
| `customers` | Anagrafica clienti per tenant |
| `reservations` | Prenotazioni ristorante (`table_id`, `table_ids BIGINT[]`) |
| `restaurant_tables` | Tavoli (capacità, zona) |
| `business_closures` | Chiusure/ferie con date range |
| `offers` | Sconti (percent/fixed, scope, date validità) |
| `waitlist` | Lista attesa prodotti esauriti |
| `promo_codes` + `promo_redemptions` | Codici promozionali SaaS |

---

## Billing Stripe

`routes/billing.js`: Checkout (`mode:'subscription'`, trial 7gg) → webhook attiva/sospende tenant + scrive flag piano nel DB → cancel/reactivate → change-plan (upgrade/downgrade immediato con proration).

`PLAN_FLAGS` in `billing.js`: mappa piano → `{products_enabled, services_enabled, appointments_enabled, restaurant_enabled}`.

**Env vars**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` per ogni piano. **Ancora da configurare su Render con valori live.**

---

## Pannelli web

| Route | Chi | Note |
|-------|-----|------|
| `/admin` | Merchant | Catalogo, ordini, chat, appuntamenti/prenotazioni, impostazioni, billing |
| `/superadmin` | Platform | Tenant list, analytics, promo codes, support chat |
| `/register` | Nuovo merchant | Wizard 4 step con piano |
| `landingpage/` | Pubblico | Landing marketing |

---

## i18n

6 lingue: ES / EN / IT / DE / FR / PT. Chiave localStorage `sara_lang` condivisa tra tutte le pagine.

- `public/admin/i18n.js` — TR object admin
- `public/register/i18n.js` — TR object register
- Pattern errori: backend aggiunge `errorCode: 'snake_case'`; frontend usa `errMsg(e)` → `t('err.' + e.code)`.

---

## Sicurezza

- Firma webhook Meta (HMAC-SHA256). JWT in HttpOnly cookie (`sara_token`). Trust proxy 1 (IP reale dietro Render). Rate limit su tutti gli endpoint pubblici. Injection block silenzioso. XSS: `textContent` non `innerHTML` per dati utente. No secret hardcoded (fail-fast all'avvio).
- `select('*')` su `tenants` solo in `getTenantConfig` (interno/server-side). Query frontend: campi espliciti.

---

## Tenant di test

| Slug | Piano | Password |
|------|-------|----------|
| `testshop` | Shop | `sara1234` |
| `testbookings` | Bookings | `sara1234` |
| `testpro` | Pro | `sara1234` |
| `testrestaurant` | Restaurant | `sara1234` |
