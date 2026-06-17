# PROJECT HANDOFF — Sara Bot (whatsapp-bot) — 2026-06-17

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
"Leggi HANDOFF.md. Configurazione Meta completata. Prossimo task: implementare Embedded Signup wizard. Parti leggendo `public/register/index.html` per capire il flusso attuale post-registrazione merchant."

## ERRORI NOTI / TRAPPOLE
- NON leggere/query tabella prod `tenants` con `select('*')` o colonne sensibili senza autorizzazione esplicita utente per quella lettura specifica — bloccato da permission classifier (dati merchant: token WhatsApp, telefoni).
- Anthropic prompt caching ha soglia minima ~4096 token sul prefisso cacheabile per modelli Haiku-tier: sotto soglia, caching no-op silenzioso, nessun errore — non assumere che caching funzioni senza verificare `response.usage.cache_creation_input_tokens`/`cache_read_input_tokens`.
- Caching è match byte-prefix stretto: qualsiasi contenuto dynamic messo PRIMA del blocco static rompe la cache ogni volta.
