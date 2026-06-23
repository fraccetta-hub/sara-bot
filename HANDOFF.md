# PROJECT HANDOFF — Sara Bot — 2026-06-23

## STATO CORRENTE
SaaS multi-tenant WhatsApp Business. Feature appuntamenti complete (paid, storno, mobility, slot 15min, rubrica). Prossimo: Stripe live env vars su Render, invoicing merchant.

**Ultimo commit stabile:** `0289d11` (profilo WhatsApp esteso: email/website/vertical + sync indirizzo)

### Vocali WhatsApp — setup completato
- Trascrizione via **Groq Whisper** (`services/transcribe.js`) — modello `whisper-large-v3-turbo`.
- Key: `GROQ_API_KEY` = `gsk_...` (da console.groq.com — NON xAI/Grok di X).
- Già settata su Render e funzionante.
- Fallback se trascrizione fallisce: messaggio multilingua IT+ES+EN.

---

## SESSIONE 2026-06-23 (parte 3) — broadcast fix, 9A/9D/9E

### Commit: `c4e2368`

### Broadcast — fix comportamento fuori finestra ✅
- `services/cron.js`: rimosso il fake fallback testo+link per errore 131047 (anche `sendMessage` fallisce fuori dalla finestra 24h). `sendOneBroadcast` ora restituisce `'skipped'` per 131047 su entrambi i path (foto e testo). Counters: `photo_sent / text_sent / skipped / failed`. Messaggio report merchant aggiornato.
- `public/admin/index.html` + `i18n.js`: box info broadcast corretto. Rimossa `broadcast.info.link` (falsa). Aggiunte `broadcast.info.text` + `broadcast.info.inactive` in 6 lingue. Ora dice esplicitamente: clienti inattivi >24h NON ricevono nulla.

### 9A — Anonymization ordini PII ✅
- `index.js`: cron giornaliero (avvio dopo 25s, poi 24h) → `customer_phone = '[deleted]'` su ordini con `created_at < 5 anni fa`. Dati finanziari preservati per obblighi fiscali. Idempotente (skip se già anonimizzato).
- **Nessuna migration necessaria** (colonna esiste già).

### 9D — WhatsApp tier monitoring ✅
- `routes/admin.js`: `GET /admin/whatsapp-quality` → chiama `GET https://graph.facebook.com/v19.0/{phone_number_id}?fields=quality_rating,messaging_limit_tier` + conta convs ultime 24h dal DB.
- `public/admin/index.html`: card "WhatsApp" nella tab Analytics. Badge verde/giallo/rosso per qualità, tier/limite, convs oggi. Alert se `quality=RED` o `convs >= 80% del limite`. Nascosta se API non disponibile.
- i18n: `analytics.wa.*` (title, quality, tier, convs, alert.red, alert.limit) in 6 lingue.

### 9E — Email verification ✅
- **⚠️ DA ESEGUIRE SU SUPABASE:**
  ```sql
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS email_verification_token TEXT,
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
  ```
- `services/mailer.js`: `sendEmailVerification({ email, businessName, verifyUrl, lang })` — template HTML in 6 lingue, stesso stile delle altre email.
- `routes/register.js`: al `POST /` genera token 32-byte hex, salva su tenant, invia email verifica (fire-and-forget). Aggiunto `GET /register/verify-email?token=xxx` (imposta `email_verified_at`, cancella token, redirect a `?verified=ok`). Aggiunto `POST /register/resend-verification` (rate-limited 5/h, silent succ se account non esiste o già verificato).
- `routes/admin.js` login: legge `email_verification_token + email_verified_at`; blocca con 403 `{errorCode:'email_not_verified'}` se token presente e non verificato. **Grandfathering: account esistenti (token=null) non bloccati.**
- `public/admin/index.html`: 
  - Login error handler: se `e.code === 'email_not_verified'` mostra messaggio + link "Reinvia email" (`resendVerification()`).
  - `?verified=ok/invalid` URL param (da redirect email): toast banner fisso 5s in cima alla pagina.
- i18n: `login.emailNotVerified/resendVerification/verificationSent/emailVerified/emailVerifiedInvalid` in 6 lingue.

---

## SESSIONE 2026-06-23 (parte 2) — catalogo WhatsApp nativo, Fase 1

### Decisioni catalogo (non riaprire)
- **`waba_id`**: catturato all'Embedded Signup e salvato su tutti i tenant (anche solo-servizi). Sempre, non opt-in.
- **Multi-image**: Supabase Storage + compressione (Meta ha bisogno di URL live).
- **Auto-on**: `catalog_sync_enabled` parte `false`; il wizard offre "Attiva" 1-tap; toggle in Impostazioni WhatsApp.
- **Valuta**: nessun default — deve essere impostata alla registrazione dal paese; nessun fallback per catalogo.
- **Plan completo**: `PLAN_CATALOG.md`.

### Fase 1 — Schema DB (Migration 20) ✅
Nuove colonne aggiunte (idempotenti):
- `tenants`: `waba_id TEXT`, `wa_catalog_id TEXT`, `catalog_sync_enabled BOOLEAN DEFAULT false`, `catalog_synced_at TIMESTAMPTZ`
- `products`: `wa_retailer_id TEXT`, `wa_sync_error TEXT`, `additional_images TEXT[]`
Schema in `db/schema.sql` allineato. Migration in `db/migrations.sql`.
**⚠️ DA ESEGUIRE SU SUPABASE** (SQL Editor → incolla Migration 20 da `db/migrations.sql`).

### Fase 1 — Capture waba_id (Embedded Signup) ✅
`waba_id` arriva in `data.data.waba_id` nel messaggio `WA_EMBEDDED_SIGNUP / FINISH` da Meta.
- `public/admin/index.html`: catturato in `wizConnectedWabaId`, inviato al backend.
- `routes/admin.js` `/whatsapp-connect`: se `waba_id` presente, salvato su `tenants.waba_id`.

### Fase 2 — `services/catalog.js` ✅
Engine di sync catalogo. Funzioni: `ensureCatalog`, `pushProduct`, `pushAllProducts`, `removeProduct`, `validateForCatalog`.
- Currency: mappa locale `CATALOG_CURRENCY` — **nessun fallback**, `null` se paese sconosciuto → skip sync (non USD sbagliato).
- `ensureCatalog`: legge `business_id` dal WABA (`GET /{waba_id}?fields=business`), crea catalogo, abilita commerce sul numero, salva `wa_catalog_id`. Idempotente.
- Prodotti invalidi: scrive `wa_sync_error` sul prodotto, mai blocca il pannello. Best-effort su tutto.
- `pushAllProducts`: batch 100 prodotti per chunk (limite Meta).
- `removeProduct`: fire-and-forget.

### Fase 4 — Auto-sync hooks in admin.js ✅
Aggiunti 3 helper fire-and-forget: `bgSyncProduct`, `bgSyncRemove`, `bgSyncAll`.
Hooks su: POST/PUT/DELETE prodotti, upload foto, import-confirm (solo products), bulk-images ZIP.
Tutti: gate `catalog_sync_enabled` come prima cosa (no-op veloce per tenant senza catalogo), mai bloccano la risposta.

### Fase 3 — Wizard step "Attiva catalogo" ✅ (commit a08e1b8)
Dopo `saveWizardMerchantPhone()` → `showWizCatalogOrDone()` chiama `GET /catalog-status`.
Se eligible → mostra sezione catalogo (`wizCatalogSection`) con "Attiva" / "Più tardi".
Se non eligible → salta direttamente a `wizDoneSection`.
Bug fixes inclusi: `applyI18n()` non esiste → rimosso; eligibility check null-as-true corretto.

### Fase 5 — UI toggle + badge sync + multi-foto ✅ (commit cc6d6d0)
- **Toggle catalogo** in accordion "Perfil WhatsApp" impostazioni. Visibile solo se tenant eligible.
  - Se no `waba_id`: toggle disabilitato + messaggio "riconnetti Embedded Signup".
  - Se `waba_id` presente: toggle ON/OFF chiama `/catalog-activate` o `/catalog-deactivate`.
  - Resync: chiama di nuovo `/catalog-activate` (idempotente, lancia `bgSyncAll`).
  - Mostra data ultimo sync (`catalog_synced_at`).
- **Badge stato** (✅/⚠️) nelle colonne azioni dei prodotti (tabella e vista menu ristorante).
  - Visibili solo se `_catalogSyncEnabled = true`. ⚠️ ha tooltip con testo errore `wa_sync_error`.
  - `_catalogStatusCache`: caricato fire-and-forget al load prodotti; aggiornato al cambio toggle.
- **Foto aggiuntive** nel modal prodotto (fino a 9).
  - Compressione canvas lato client: max 1280px, JPEG 85%.
  - Anteprima con blobURL + × per rimuovere.
  - Al salvataggio: upload singolo per ogni file nuovo → `POST /products/:id/additional-images/upload`; poi `PUT /products/:id/additional-images` con array URL finale (include rimozioni).
- **Nuovi endpoint**: `GET /catalog-status` + `hasWaba`/`syncedAt`, `POST /products/:id/additional-images/upload`, `PUT /products/:id/additional-images`.
- **i18n**: `settings.catalog.*` + `modal.product.extraPhotos/addPhoto/photoLimit` in ES/EN/IT/DE/FR/PT.

### Prerequisiti Meta (task utente — ancora pendente)
- Aggiungere `catalog_management` + `business_management` a Login Config nella Meta App Dashboard.
- Sottomettere App Review per queste permission.

---

## SESSIONE 2026-06-23 — fix import + onboarding token + profilo WhatsApp

### Import catalogo (Foto IA) — 3 fix
- **`782772e`** `max_tokens` 2048→8192 in `/admin/import-from-images` e `/superadmin/.../import-from-images` + guard `stop_reason==='max_tokens'`. Causa errore "Expected ',' or ']'": JSON troncato a metà array, regex prendeva fino all'ultima `}` completa → array non chiuso.
- **`e21f81f`** drop `duration_min` dal bulk insert `products` (colonna solo di `services`).
- **`b2b2313`** drop `price_type` dal bulk insert `products` (idem, service-only).
- Colonne reali `products`: name, category, price_guarani, stock_qty, description, sku, allergens, image_url, is_available. NO price_type/duration_min.

### Schema allineato
- **`1fc3249`** `db/schema.sql` + `db/migrations.sql`: aggiunta colonna `sku` (esisteva nel DB live ma mancava nei file). Migration 19 idempotente.

### Token WhatsApp — cron + onboarding
- **`d86617b`** cron `renewTokens` (`index.js`): i token System User permanenti non sono scambiabili via `fb_exchange_token` → il cron scriveva `whatsapp_token_refresh_error` → X rossa nel superadmin anche con bot funzionante. Ora su fallimento exchange verifica con `debug_token`: se valido azzera l'errore.
- **Gotcha onboarding:** TOKEN WA rosso = `whatsapp_token_refresh_error` truthy. Se nel Table Editor Supabase si scrive la **stringa** `"NULL"` invece di SQL `NULL`, resta truthy → X rossa. Tooltip sulla X mostra il valore. Fix: `UPDATE ... SET whatsapp_token_refresh_error = NULL`.

### Profilo WhatsApp (admin) — fix + feature
- **`825fdbb`** foto profilo: usa **Resumable Upload API** (`/{app-id}/uploads` → handle `h`) invece di `/media` id. Errore precedente "Parameter value is not valid". Richiede `META_APP_ID` su Render.
- **`67ea5e4`** testo: la Cloud API business profile NON supporta `about` (On-Premises only, ignorato silenziosamente) → usa `description`.
- **`0289d11`** feature: sezione Profilo WhatsApp ora setta anche **email, website, vertical** (dropdown enum Meta) in una sola chiamata. `GET /admin/whatsapp-profile` precarica i valori da Meta. Salvataggio "Il mio negozio" sincronizza l'**indirizzo** sul profilo WhatsApp (best-effort). i18n 6 lingue. Helper `setWhatsappProfileFields`.
- **Limite Meta:** lo status breve "Acerca de" sotto il nome NON è settabile via Cloud API. Solo description/email/website/vertical/address/foto.

---

## SESSIONE 2026-06-22 (notte) — documentazione e bot supporto

### Docs aggiornate
- **SAAS_GUIDE.md** riscritta da zero: 15 sezioni, indice, coprendo merchant admin, Sara cliente, bot merchant WhatsApp, stack, piani, DB, billing, i18n, sicurezza, import, appuntamenti, ristorante.
- **`❓ Guida all'uso`** (tab Supporto pannello admin) riscritta: due sezioni (Pannello web + Bot WhatsApp), plan-conditional, 6 lingue. Nuovi i18n keys: `help.web.*`, `help.stats.*`.

### Bot supporto (`routes/admin.js` — `SUPPORT_SYSTEM_PROMPT`)
Rewrite completo. Ora copre:
- Sara lato cliente: cosa vede/può fare/non può fare (catalogo, ordini, appuntamenti, ristorante, allergens, waitlist, storico ordini, foto auto, cross-sell, delivery, supporto umano, sicurezza injection)
- Pannello web: ogni tab con ogni bottone (incluse novità: search bar tutte le tab, modal clienti unificato con phone editable, ✏️ ordini inline, deduplica item, ordini manuali)
- Bot merchant WhatsApp: tutti i comandi con esempi multi-lingua, per tutti i piani (prodotti, ordini, clienti, appuntamenti, ristorante, offerte, broadcast, statistiche, orari)

---

## SESSIONE 2026-06-22 (sera) — ordini, clienti, UX

### Migration richiesta (eseguire su Supabase se non già fatto)
```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE orders ALTER COLUMN customer_phone DROP NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_phone TEXT;
```

### Ordini — modal nuovo/modifica
- **Modale unificato** nuovo + modifica ordine (`_editOrderId`). Bottone ✏️ inline con select stato.
- **Picker clienti** esistenti; "Salva in rubrica" se nome+telefono presenti.
- **Deduplica item**: voci con stesso nome si sommano al salvataggio (`itemMap`).
- **Voce custom**: select placeholder disabilitato → seleziona "Voce personalizzata" (value=`__custom__`) → campo testo; ☰ torna al catalogo.
- **Prezzo custom** esplicitamente `text-gray-900` (nero); catalogo readonly grigio.
- **customer_name** ora salvato direttamente nella tabella `orders` (fix: prima andava solo su `conversations` e risultava null se telefono assente).
- **renderCustomerLabel**: mostra nome+telefono; se manca telefono solo nome; entrambi assenti → `—`.

### Clienti — modal unificato add/edit
- Un solo bottone ✏️ per riga (rimosso 📋).
- Modal unificato: nome primo, telefono secondo, entrambi obbligatori.
- Edit mode: tutti i campi editabili incluso telefono (PUT `/admin/customers/:phone` aggiorna anche `customer_phone` se cambiato).
- Colonna Email aggiunta alla tabella.
- Telefono: `oninput` strip non-cifre su tutti i campi tel del pannello.

### UX generale
- **Barra di ricerca** spostata nella riga del titolo (flex-1 centrata) su Prodotti, Ordini, Clienti, Servizi. Placeholder vuoto.
- Ordini/Clienti/Servizi: cache `_allOrders`/`_allCustomers`/`_allServices` + funzioni `render*()` separate dal fetch.
- `setOrderFilter` usa cache (re-render istantaneo); auto-refresh 10s ricarica dal server.
- Prodotti: cerca per nome/categoria/descrizione; Ordini: nome/telefono/item; Clienti: nome/telefono/email; Servizi: nome/categoria.
- `renderCustomerLabel` semplificato: no più matitina inline.

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
-- Migration 21: email verification (9E)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email_verification_token TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
```

---

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

-- Migration 19: codice prodotto opzionale (era nel DB live, mancava nei file)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sku TEXT;

-- Migration 20: WhatsApp native catalog support
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS waba_id              TEXT,
  ADD COLUMN IF NOT EXISTS wa_catalog_id        TEXT,
  ADD COLUMN IF NOT EXISTS catalog_sync_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS catalog_synced_at    TIMESTAMPTZ;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS additional_images TEXT[],
  ADD COLUMN IF NOT EXISTS wa_retailer_id    TEXT,
  ADD COLUMN IF NOT EXISTS wa_sync_error     TEXT;
```

---

## SESSIONE 2026-06-22

### Modal nuovo ordine — miglioramenti (commit `89063cb`)
- **Picker rubrica**: dropdown clienti esistenti sopra nome/tel → autofilla entrambi i campi.
- **Nome obbligatorio, telefono opzionale** (front + back). Backend non richiede più `customer_phone`.
- **Header colonne** "Qtà / Prezzo" sopra righe item.
- **Prezzo readonly** (bg grigio) se prodotto da catalogo; editabile per voci custom.
- Nuove chiavi i18n (`orders.new.col.*`, `orders.new.customer.pick/new`, `err.missing_name`) in 6 lingue.

### Fix UX / bug (commit `0b8dfa0`)
- **Date disabilitate**: label `settings.delivery.disabled` + `settings.smob.disabled` ora include "(oltre ai giorni di chiusura)" in 6 lingue.
- **Offerte**: `loadOffers` HTML-escape su label/scope/date (preveniva DOM breakage da label con `</div>`). `_offerBusy` flag anti-double-submit. Errori distinti per campo mancante (`err_label` / `err_value`).
- **Tab visibilità**: era problema di dati (flag null in DB). Risolto ricreando i tenant di test con flag espliciti via superadmin API.
- **Tenant test ricreati** via `POST /superadmin/tenants` (slug: testshop/testbookings/testpro) + whatsapp_token fake via Supabase.

### Restyle UI site-wide (commit `0b0a4f4`)
- Tema **"v5" editorial caldo** applicato a TUTTO: landing (layout rifatto, hero asimmetrico), admin (login + pannello, tutte le tab), register, superadmin, legali (4), 5 email (`mailer.js`).
- Palette: crema `#fbf6ec`, verde `#2f9e3a` (logo reale `#41b72d`), CTA **ambra `#e2622a`**. Font **Outfit** (titoli) + **Inter** (corpo). Angoli arrotondati, ombre offset.
- Admin/superadmin/register: retheme via `tailwind.config` (remap ramp `green`) + override `<style>` — **zero** tocchi a classi/id/JS/polling.
- Bottoni admin unificati: **PIENO** (ambra+ombra, classe `.btn-green`), **SOFT** (ambra chiaro `#fcefe6` + testo `#a3430f`), **OUTLINE** (bordo grigio + `bg-white`), **ROSSO** (destructive + notice errore: banner WhatsApp/token-error).
- Solo estetica: testi, i18n (`data-i18n`/`TR`), logica **invariati**. Emoji mantenute.
- Spec completa + token: **`DESIGN_SYSTEM.md`** (root). Ritocchi minori futuri ok direttamente su `main`.

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
- Settando colonne via Supabase Table Editor: usare il vero SQL `NULL` (opzione "Set to NULL"), non digitare la stringa `"NULL"` → resta truthy e rompe i check (es. TOKEN WA rosso).
- Profilo WhatsApp: foto via Resumable Upload API richiede `META_APP_ID` su Render. `about` non esiste su Cloud API → usare `description`.
