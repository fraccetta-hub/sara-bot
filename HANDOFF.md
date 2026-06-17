# PROJECT HANDOFF — Sara Bot (whatsapp-bot) — 2026-06-18

## STATO CORRENTE
- Obiettivo generale: SaaS multi-tenant WhatsApp Business (Node/Express + Supabase + Anthropic Claude). Bot AI risponde a clienti, gestisce catalogo, delivery, turni/appuntamenti, ordini.
- Fase attuale: configurazione Meta completata, prossimo step implementazione Embedded Signup wizard nel codice.
- Ultimo commit stabile: `20cf3e9` — "perf: skip appointment-slot queries when irrelevant, add Anthropic prompt caching" — pushato su `origin/main`.

## COSA È STATO FATTO (sessioni precedenti + 2026-06-17)
- **#3** — `routes/admin.js` + `routes/superadmin.js`: Opus → `claude-haiku-4-5-20251001` per import catalogo da foto
- **#4** — `routes/webhook.js` `handleMerchantMessage`: query `conversations` spostata dentro i branch CHAT/CONFIRMAR/CANCELAR — FIN/BOT e free-text non la eseguono più
- **#5** — `services/stock.js`: TTL 45s in-memory cache su `getTenantConfig`/`getStock`/`getServices`; `decrementStock` invalida `stock:tenantId` immediatamente
- Email: `support@sarabot.pro` e `info@sarabot.pro` integrati in legal pages, register, mailer.js; SMTP Brevo configurato via env
- CLAUDE.md creato, SAAS_GUIDE.md aggiornato, `.claude/settings.json` con autoCompact + PreCompact hook

## COSA È STATO FATTO (sessione originale 2026-06-16)
- `routes/webhook.js` → aggiunto `APPOINTMENT_KEYWORDS` regex + `mightBeAboutAppointments` guard. Le 3 query Supabase extra (business_hours, appointments, appointment_blocks) + calcolo slot 14 giorni ora girano SOLO se messaggio/history recente menziona booking. Prima girava sempre se `tenant.appointments_enabled`.
- `services/claude.js` → system prompt splittato in `buildStaticSystemPrompt()` (catalogo, pagamento, regole custom/sicurezza — identico tra messaggi) e `buildDynamicSystemPrompt()` (delivery state, slot turni — cambia ogni messaggio). Static block ha `cache_control: {type:'ephemeral'}` → Anthropic prompt caching attivo.
- Decisione: caching solo sul blocco static perché caching è match prefisso esatto — mescolare dynamic avrebbe invalidato cache ogni messaggio.
- Verificato end-to-end con script temporaneo (`_test_claude.js`, poi cancellato) + chiamata reale Anthropic: 1° msg `cache_creation_input_tokens: 8517`, 2° msg `cache_read_input_tokens: 8517` (stesso conv) → caching confermato funzionante, risposte catalogo corrette.

## COSA È STATO FATTO (sessione 2026-06-17 — configurazione Meta)
- App Meta "SaraBot" pubblicata (live) — ID `27756118003980694`, Business: Deepcable LLC
- Webhook configurato su `https://sara-bot-tcl6.onrender.com/webhook` (server Render attivo)
- Numero WhatsApp Business registrato + metodo pagamento aggiunto
- Azienda verificata su Meta Business Manager
- System User Admin creato su Business Manager con token permanente (no-expiry) → salvato come `WHATSAPP_TOKEN` su Render (sostituisce token vecchio)
- Token generato con permessi: `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management`
- Facebook Login for Business configurato: redirect URI `https://www.sarabot.pro/auth/meta/callback`
- App pubblicata — può ricevere/inviare messaggi reali a qualsiasi numero

## ARCHITETTURA INFRASTRUTTURA (chiarita questa sessione)
- Server Node/Express: Render (`sara-bot-tcl6.onrender.com`)
- Dominio `sarabot.pro`: Cloudflare DNS-only (solo email MX → Brevo SMTP)
- `www.sarabot.pro` → CNAME proxiato Cloudflare → `sara-bot-tcl6.onrender.com`
- `sarabot.pro` (root) → A record Cloudflare (non punta a Render)
- Webhook Meta punta a `onrender.com` direttamente (più sicuro, no proxy)

## COSA È STATO FATTO (sessione 2026-06-17 — wizard + UX blocco)

### Embedded Signup wizard — IMPLEMENTATO
- Backend `POST /admin/whatsapp-connect` già completo: scambia code OAuth → token long-lived → salva `phone_number_id` + `whatsapp_token` nel tenant
- Backend `POST /admin/whatsapp-connect-manual` già completo: inserimento manuale credenziali
- `index.js`: admin HTML servito dinamicamente — `%%META_APP_ID%%` e `%%META_CONFIG_ID%%` sostituiti con env vars a runtime
- Banner "Connetti WhatsApp Business" aggiunto in support tab (`id="wizResumeBanner"`) — visibile solo se non connesso, chiama `openWizard()`
- `applyTabGating()` mostra/nasconde il banner automaticamente

### UX blocco post-registrazione — IMPLEMENTATO
- Tab bloccate senza WhatsApp: tutte tranne `support` (era: `plan`+`settings` libere)
- Redirect automatico a tab `support` quando non connesso
- Bottone "Elimina account" spostato da Settings → Support tab (visibile anche senza wizard completato)
- `DELETE /admin/account` ora cancella subscription Stripe immediatamente prima di eliminare dati DB
- Confirm dialog elimina account aggiornato in ES/EN/IT/DE/FR — menziona esplicitamente cancellazione Stripe

### i18n
- 790 linee TR riformattate — ogni chiave su riga propria (grep ora funziona)
- Aggiunte chiavi `wiz.resume.title/desc/btn` in ES/EN/IT/DE/FR
- Bug fix: ~790 virgole mancanti nel TR admin causavano syntax error JS → zero traduzioni caricate
- Legal pages ora scrivono su `sara_lang` (prima solo `legal_lang`) — lingua propagata a tutte le pagine
- TR estratto da `public/admin/index.html` → `public/admin/i18n.js` (7060→4356 righe)
- TR estratto da `public/register/index.html` → `public/register/i18n.js` (1610→811 righe)

### i18n (sessione 2026-06-17 — messaggi errore + UX)
- Lang switcher: `<select>` nativo → dropdown custom (CSS+JS) su tutte le pagine — fix emoji bandiere non renderizzate su Windows
- Logo immagine aggiunto a legal pages (era testo plain)
- `favicon.webp` committato nel repo (era untracked → mancava su Render)
- Tutti i messaggi errore frontend hardcoded → `t()` (15 chiavi nuove: `saving`, `save`, `error.save`, `error.generic`, `login.required`, `wiz.fb.*`, `profile.*`, `billing.renewed`, `appt.*`, `bh.*`)
- Backend errors tradotti via `errorCode`: `routes/admin.js` aggiunge `errorCode` alle 8 risposte errore utente-visibili; `api()` helper attacca `err.code`; helper `errMsg(e)` in frontend usa `t('err.' + e.code)` con fallback `e.message`
- Chiavi `err.*` aggiunte a `i18n.js`: `unauthorized`, `token_expired`, `suspended`, `plan_expired`, `rate_limit`, `wrong_credentials`, `password_too_short`
- **Sistema errori i18n (pattern da seguire sempre):** backend aggiunge `errorCode: 'snake_case'` alla response; `api()` helper in admin/index.html:3261 attacca `err.code`; `errMsg(e)` (index.html:3236) cerca `t('err.' + e.code)` con fallback `e.message`; chiave `err.snake_case` va aggiunta in tutte e 6 le lingue in `public/admin/i18n.js`

## COSA È STATO FATTO (sessione 2026-06-18 — superadmin UX fix, commit e51ecc3)

### Superadmin panel — fix UX (commit e51ecc3)
- Logo navbar: 🤖 emoji → `/images/logo.webp` (identico ad admin panel)
- Tab "Nuevo cliente" rimossa (flusso creazione tenant rimane via edit modal)
- Analytics: rimossa tabella morosi duplicata in fondo (rimane solo card con conteggio)
- Promo codes: aggiunti pulsanti ✏️ edit e 🗑️ elimina per ogni codice
  - Modal riusato per edit (campo code readonly in edit mode)
  - Backend: `PUT /superadmin/promo-codes/:id` (modifica) + `DELETE /superadmin/promo-codes/:id` (elimina)

## COSA È STATO FATTO (sessione 2026-06-18 — superadmin UX + promo codes)

### Superadmin panel — miglioramenti UX
- Logo navbar: 🛡️ → 🤖
- Nuovo stato tenant `🔵 Sin Meta` (status-meta, blu): tenant attivo ma senza `whatsapp_token` proprio (usa token globale env)
- Logica stato: inactivo → moroso (expired) → sin Meta → activo
- `meta_connected: !!t.whatsapp_token` calcolato server-side (token mai esposto al frontend)
- Nuova tab **📊 Analytics**: card per stato tenant (totale/attivi/sin Meta/morosos/inactivos), card pedidos (totale/oggi/consegnati/cancellati), grafici a barre SVG (registros/mes, pedidos/mes, bajas/mes), MRR per valuta, tabella morosi
- Campo `plan_price` aggiunto al modal edit (prezzo mensile abbonamento)
- `deactivated_at` registrato al toggle off, cancellato al toggle on
- Migration: `plan_price NUMERIC(10,2)`, `deactivated_at TIMESTAMPTZ` su `tenants`

### Promo codes — IMPLEMENTATO
- Schema: tabelle `promo_codes` + `promo_redemptions` (migration in `db/migrations.sql`)
- Superadmin: nuova tab "🎟️ Promos" — CRUD completo (crea/modifica/disattiva)
  - `discount_type`: percent | fixed amount
  - `discount_value`: valore sconto
  - `months_free`: mesi gratuiti da aggiungere al piano
  - `max_uses`: null=illimitato, 1=singolo uso, N=N usi
  - `valid_for_currency`: null=tutti i piani, o valuta specifica
  - `expires_at`: scadenza codice opzionale
- Backend: `GET/POST /superadmin/promo-codes`, `PATCH /superadmin/promo-codes/:id/toggle`, `POST /admin/redeem-promo`
- Merchant panel: input riscatto codice nella tab Plan/Billing

## COSA È STATO FATTO (sessione 2026-06-18 — fix wizard + validazione credenziali manuali)

### Bug fix wizard Embedded Signup
- `FB.login(async function...)` → rimosso `async` — Meta SDK rifiuta callback async con errore "Expression is of type asyncfunction, not function"
- Login con credenziali errate → `api()` restituiva `undefined` su 401 non-autenticato → crash `Cannot read properties of undefined (reading 'token')` — fix: 401 con `auth=false` ora lancia errore invece di chiamare `logout()`
- `META_APP_ID` e `META_CONFIG_ID` confermati settati su Render e iniettati correttamente nell'HTML

### Validazione credenziali manuali WhatsApp
- `POST /admin/whatsapp-connect-manual`: aggiunta chiamata verifica a `graph.facebook.com/v19.0/{phone_number_id}` prima di salvare — dati errati ora restituiscono errore leggibile invece di salvarsi silenziosamente
- Errori con `errorCode`: `invalid_meta_credentials` (token/ID sbagliati), `meta_unreachable` (rete)
- Chiavi `err.invalid_meta_credentials` + `err.meta_unreachable` aggiunte in ES/EN/IT/DE/FR/PT in `public/admin/i18n.js`

## COSA NON FUNZIONA / IN SOSPESO
- **Env vars mancanti su Render** — da aggiungere in Render → Environment prima che il wizard funzioni:
  - `META_APP_ID` = `27756118003980694` (ID app Meta)
  - `META_APP_SECRET` = chiave segreta app (visibile in Meta Developer → Settings → Basic → "Chiave segreta")
  - `META_CONFIG_ID` = Configuration ID da Facebook Login for Business → Configurations (da creare se non esiste ancora)
- **META_CONFIG_ID non ancora creato** — va su Meta Developer → Facebook Login for Business → Configurations → crea nuova configurazione → copia ID

## DECISIONI TECNICHE PRESE (non riaprire)
- Modello chat cliente: `claude-haiku-4-5-20251001` (non cambiato, va bene per chat conversazionale).
- Prompt caching: solo blocco static col breakpoint, dynamic block separato e non cacheato — vedi `services/claude.js:170-179`.
- Skip appuntamenti via regex keyword-gating su messaggio + ultimi 4 msg history, non flag esplicito utente — più robusto, basso costo computazionale — vedi `routes/webhook.js` (subito dopo `Promise.all([getStock, getServices])`).
- Test caching: niente query dirette su tabella prod `tenants` (bloccato da permission classifier per dati sensibili merchant) — testato con tenant/catalogo mock in-memory + vera chiamata Anthropic invece.

## FILE CHIAVE
- `services/claude.js` — costruzione system prompt (static+dynamic), chiamata Anthropic, parsing tag risposta (ORDER, SHOW_IMAGE, CUSTOMER_NAME, DELIVERY_CHOICE, OFF_TOPIC, DELIVERY_ADDRESS, APPOINTMENT). `MAX_HISTORY=20`.
- `routes/webhook.js` — entry point webhook WhatsApp, `handleCustomerMessage` e `handleMerchantMessage`, logica skip-query appuntamenti.
- `routes/admin.js` / `routes/superadmin.js` — pannelli gestione tenant, import catalogo da immagini (Opus, candidato #3).
- `services/stock.js` — `getTenantConfig`, `getStock`, `getServices` (candidati cache in-memory, #5).
- `services/geo.js` — `isDeliveryDisabledToday`, `describeDelivery`.
- `public/admin/index.html` — UI admin (4356 righe), polling attivo: `startSupportPoll` 5s, `startChatListPoll` 8s, `refreshChat` 3s, `checkNewOrders` 15s — non toccare senza motivo.
- `public/admin/i18n.js` — **TR traduzioni admin** (ES/EN/IT/DE/FR/PT). Edita qui, non in index.html.
- `public/register/i18n.js` — **TR traduzioni register** (ES/EN/IT/DE/FR/PT). Edita qui, non in index.html.

## COME RIPRENDERE
Primo messaggio da mandare a Claude nella prossima sessione:
"Leggi HANDOFF.md. Sessione precedente: superadmin UX fix (logo, tab, promo edit/delete) + analytics/promo codes sessione precedente. Migration Supabase ancora da eseguire se non fatto."

## ERRORI NOTI / TRAPPOLE
- NON leggere/query tabella prod `tenants` con `select('*')` o colonne sensibili senza autorizzazione esplicita utente per quella lettura specifica — bloccato da permission classifier (dati merchant: token WhatsApp, telefoni).
- Anthropic prompt caching ha soglia minima ~4096 token sul prefisso cacheabile per modelli Haiku-tier: sotto soglia, caching no-op silenzioso, nessun errore — non assumere che caching funzioni senza verificare `response.usage.cache_creation_input_tokens`/`cache_read_input_tokens`.
- Caching è match byte-prefix stretto: qualsiasi contenuto dynamic messo PRIMA del blocco static rompe la cache ogni volta.
