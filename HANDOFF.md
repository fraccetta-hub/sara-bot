# PROJECT HANDOFF — Sara Bot — 2026-06-22

## STATO CORRENTE
SaaS multi-tenant WhatsApp Business. Feature appuntamenti complete (paid, storno, mobility, slot 15min, rubrica). Prossimo: Stripe live env vars su Render, invoicing merchant.

**Ultimo commit stabile:** `0b8dfa0` (fix disabled-dates hint + offers HTML-escape)

---

## TENANT DI TEST
| Slug | Piano | Password | Flag DB |
|------|-------|----------|---------|
| `testshop` | Shop | `sara1234` | products=T, services=F, appts=F |
| `testbookings` | Bookings | `sara1234` | products=F, services=T, appts=T |
| `testpro` | Pro | `sara1234` | products=T, services=T, appts=T |
| `testrestaurant` | Restaurant | `sara1234` | restaurant=T |

Flag espliciti nel DB (non null) → tab visibilità corretta.

---

## MIGRATIONS DA ESEGUIRE (verificare se già applicate su Supabase)

```sql
-- Migration 13: multi-tavolo ristorante (BIGINT[], non JSONB)
ALTER TABLE reservations DROP COLUMN IF EXISTS table_ids;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS table_ids BIGINT[];

-- Migration 14: phone change flow
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS pending_merchant_phone TEXT,
  ADD COLUMN IF NOT EXISTS phone_change_token     TEXT,
  ADD COLUMN IF NOT EXISTS phone_change_expires   TIMESTAMPTZ;

-- Migration 15-18: appuntamenti paid/storno/service_*/paid_at
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS paid          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_guarani INTEGER,
  ADD COLUMN IF NOT EXISTS refunded      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paid_at       TIMESTAMPTZ;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS service_location       TEXT NOT NULL DEFAULT 'own',
  ADD COLUMN IF NOT EXISTS service_fee_type       TEXT NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS service_base_fee       INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_zone_km        NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_zone_outer_fee INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_per_km         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_min_value      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_disabled_dates TEXT;

-- Altre (più vecchie, quasi certamente già applicate)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS account_deletion_token   TEXT,
  ADD COLUMN IF NOT EXISTS account_deletion_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email       TEXT,
  ADD COLUMN IF NOT EXISTS country     TEXT,
  ADD COLUMN IF NOT EXISTS bot_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS merchant_pending_json JSONB DEFAULT NULL;

ALTER TABLE business_hours
  ADD COLUMN IF NOT EXISTS open_time_2  TIME,
  ADD COLUMN IF NOT EXISTS close_time_2 TIME;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS appointment_capacity INTEGER NOT NULL DEFAULT 1;
```

---

## SESSIONE 2026-06-22

### Fix UX / bug (commit `0b8dfa0`)
- **Date disabilitate**: label `settings.delivery.disabled` + `settings.smob.disabled` ora include "(oltre ai giorni di chiusura)" in 6 lingue.
- **Offerte**: `loadOffers` HTML-escape su label/scope/date (preveniva DOM breakage da label con `</div>`). `_offerBusy` flag anti-double-submit. Errori distinti per campo mancante (`err_label` / `err_value`).
- **Tab visibilità**: era problema di dati (flag null in DB). Risolto ricreando i tenant di test con flag espliciti via superadmin API.
- **Tenant test ricreati** via `POST /superadmin/tenants` (slug: testshop/testbookings/testpro) + whatsapp_token fake via Supabase.

---

## SESSIONE 2026-06-21 — appuntamenti, storno, service mobility

### Appuntamenti — slot 15min, paid, storno, rubrica
- Slot ogni 15 min (era 30); durata servizio multiplo di 15 (validato front+back).
- `paid BOOLEAN` + `price_guarani INTEGER` + `paid_at TIMESTAMPTZ` + `refunded BOOLEAN` su `appointments`.
- Revenue: due bucket — pagati oggi (`paid_at::date=oggi`) + non pagati non cancellati oggi.
- Storno: `refunded=true` toglie dall'incasso. Bottone visibile solo se `paid=true AND status='cancelled'`.
- Customer autocomplete nel modal da rubrica clienti.
- Nessun appuntamento nel passato (min=oggi front, back rifiuta `start_at < now()`).

### Ordini — 3 fix
- Nome cliente: fetch parallelo `conversations` + merge per phone.
- Pillola status: aggiornata immediatamente via DOM update.
- Incasso: solo whitelist `['confirmed','preparing','delivering','delivered']`.

### Service mobility
- Impostazioni → "Luogo del servizio": 3 opzioni (mi sede / domicilio cliente / entrambi).
- Stessa struttura tariffa delivery (fissa/zona/per km), valore minimo, giorni disabilitati.
- Visibile per piani con `services_enabled` (Bookings + Pro).
- `geo.js`: `isServiceMobilityDisabledToday` + `describeServiceMobility`.
- `claude.js`: blocco `SERVICIO A DOMICILIO` nel dynamic prompt; Sara usa `<APPT_NOTE:domicilio:...>`.

### UX varie
- Tab Ordini nascosta per piano Bookings. Card servizi compatta (no placeholder emoji). Foto unica per item (`deleteImageByUrl` prima di upload). Titolo "Nuevo turno" → i18n.

### Security hardening bot
- Rate limit merchant separato (120/h, 400/giorno). Injection: drop silenzioso. Broadcast lock + max 1000 char. Delete prodotto/cliente: chiede conferma. Output limitato: Sara risponde con categorie, non dump completo catalogo.

---

## STORIA COMPATTA (sessioni 2026-06-16 → 2026-06-21)

| Data | Cosa |
|------|------|
| 2026-06-16 | Prompt caching Anthropic (static/dynamic split). Appointment keyword gating. |
| 2026-06-17 | Meta app live. Wizard Embedded Signup. HttpOnly cookies. i18n TR estratto in file separati. |
| 2026-06-18 | Email Brevo operative. Support bot (Haiku + Telegram escalation). Security hardening (fail-fast env, no fallback hardcoded). Promo codes (CRUD superadmin + riscatto merchant). Forgot/reset password. Legal pages aggiornate. |
| 2026-06-19 | Sara UX (stato ordine, memoria acquisti, foto proattiva, waitlist, cross-sell, occasion awareness). Business closures + Offers tabelle + UI. Import/export CSV con `sep=;`. ZIP bulk images con security guards. Template Excel catalogo/menu separati. Superadmin: inline rows + module toggles. Piano → tab visibili → comportamento bot. |
| 2026-06-20 | Bot merchant NL completo (tutti i comandi → linguaggio naturale, multi-lingua, pending state su DB). Menu ristorante (vista dedicata, allergeni, `<SEND_MENU>`, import vision-aware). Tavoli ristorante bulk + multi-tavolo (`table_ids`). Prenotazioni ristorante: no overbooking, griglia disponibilità a Sara, walk-in modal, griglia slot pannello. Business hours unificati (eliminato `restaurant_meal_bands`, aggiunto orario spezzato `open_time_2/close_time_2`). UX redesign admin (accordion settings, merge tab Help+Plan, max-w-6xl). i18n audit (fix chiavi mancanti/duplicate/morte). |
| 2026-06-21 | Audit Sara cross-plan (valuta hardcoded → `formatPrice`, fix midnight slot, allergeni rule). Support bot context fix. Fix banner scorte false, descrizione menu. Webhook merchant: greeting action, JSON code-block strip. Auth bug fix (`auth` undefined → 4° param `api()`). Colonne prodotti riordinate per Excel. Fix valuta header. Hardening: trust proxy 1, error handler globale, rate-limit signup. |

---

## INFRA
- **Server**: Render (`sara-bot-tcl6.onrender.com`) → `www.sarabot.pro` via Cloudflare CNAME.
- **Meta App**: SaraBot ID `27756118003980694`, Business: Deepcable LLC. Token permanente System User Admin in `WHATSAPP_TOKEN`.
- **Email**: Brevo HTTP API (`BREVO_API_KEY`). SMTP Render bloccato.
- **Pre-commit**: `.githooks/pre-commit` → `scripts/check-syntax.js`. Su clone nuova: `git config core.hooksPath .githooks`.
- **DB maintenance**: job `conversations` > 90 giorni inserito da utente (Supabase pg_cron).
- **Stripe**: codice completo in `routes/billing.js`. Mancano solo env vars live su Render + Stripe Dashboard.

## TRAPPOLE NOTE
- `products_enabled !== false` tratta null come true → nuovi tenant vanno creati con flag espliciti (il form superadmin già li setta).
- Apostrofi nelle stringhe i18n: usare doppi apici oppure `\'`. Il pre-commit hook blocca syntax error.
- Sessioni concorrenti sullo stesso repo → rischio doppio `const` / merge conflict. Controllare prima di push.
- `whatsapp_token` non è nel PUT allowed di superadmin — va settato via Supabase direttamente se serve.
