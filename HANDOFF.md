# PROJECT HANDOFF — Sara Bot (whatsapp-bot) — 2026-06-18

## STATO CORRENTE
- Obiettivo generale: SaaS multi-tenant WhatsApp Business (Node/Express + Supabase + Anthropic Claude). Bot AI risponde a clienti, gestisce catalogo, delivery, turni/appuntamenti, ordini.
- Fase attuale: email transazionali operative (Brevo HTTP API). Prossimo: Stripe env vars + META_CONFIG_ID.
- Ultimo commit stabile: `3c91d96` — "security: rate limit forgot-password (5/h per IP), fix multer+nodemailer vulns"

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

## COSA È STATO FATTO (sessione 2026-06-18 — fix login flash + bug fix showDashboard)

### Bug fix loginPage flash / impersonazione superadmin
- `showDashboard()` era async → nascondeva loginPage solo DOPO `await api('/admin/settings')` → flash visivo della login screen durante la request
- Fix: `loginPage.classList.add('hidden')` spostato come prima riga sync di `showDashboard()` (prima dell'await)
- Secondo bug: `api()` su 401 chiama `logout()` ma ritorna `undefined` invece di throw → `settings.phone_number_id` crashava con TypeError → catch swallowava → codice nascondeva loginPage e mostrava dashboard comunque → poi altre API 401 → `logout()` → loginPage mostrata
- Fix: `if (!settings) return` aggiunto subito dopo `await api('/admin/settings')`
- File: `public/admin/index.html` — funzione `showDashboard()`

### Bug fix loginPage flash al boot / impersonazione (fix definitivo, sessione 2026-06-19)
- Root cause: `loginPage` visibile per default in HTML; `window.onload` nascondeva solo dentro `showDashboard()` dopo `await fetch('/admin/me')` → flash durante il round-trip
- Fix: `loginPage.classList.add('hidden')` spostato PRIMA del `fetch('/admin/me')` in `window.onload`
- Se `me` non ok o fetch fallisce → `loginPage` rimostrata nel ramo `else` + `catch`
- File: `public/admin/index.html` — `window.onload`

## COSA È STATO FATTO (sessione 2026-06-18 — fix wizard + validazione credenziali manuali)

### Bug fix wizard Embedded Signup
- `FB.login(async function...)` → rimosso `async` — Meta SDK rifiuta callback async con errore "Expression is of type asyncfunction, not function"
- Login con credenziali errate → `api()` restituiva `undefined` su 401 non-autenticato → crash `Cannot read properties of undefined (reading 'token')` — fix: 401 con `auth=false` ora lancia errore invece di chiamare `logout()`
- `META_APP_ID` e `META_CONFIG_ID` confermati settati su Render e iniettati correttamente nell'HTML

### Validazione credenziali manuali WhatsApp
- `POST /admin/whatsapp-connect-manual`: aggiunta chiamata verifica a `graph.facebook.com/v19.0/{phone_number_id}` prima di salvare — dati errati ora restituiscono errore leggibile invece di salvarsi silenziosamente
- Errori con `errorCode`: `invalid_meta_credentials` (token/ID sbagliati), `meta_unreachable` (rete)
- Chiavi `err.invalid_meta_credentials` + `err.meta_unreachable` aggiunte in ES/EN/IT/DE/FR/PT in `public/admin/i18n.js`

## COSA È STATO FATTO (sessione 2026-06-18 — legal + billing)

### Legal pages — aggiornamento completo
- `public/legal/terms.html` / `privacy.html` / `disclaimer.html`: Stripe aggiunto come processore pagamenti in tutte e 5 le lingue (ES/EN/IT/DE/FR); date aggiornate a 2026
- `privacy.html`: riga "dati di fatturazione (Stripe)" aggiunta alla tabella Merchant + Stripe aggiunto in sezione fornitori terzi
- `disclaimer.html`: §5 rinominato "Meta, Anthropic e Stripe" con testo aggiornato
- `public/register/index.html` + `public/register/i18n.js`: link rotti `/terms.html` → `/legal/terms` e `/privacy.html` → `/legal/privacy` in tutte e 6 le lingue
- `landingpage/index.html` + `register/i18n.js`: © 2025 → © 2026
- `services/mailer.js`: footer legale con link Terms + Privacy aggiunto all'email di benvenuto

### Billing Stripe — stato
- **Codice già completamente implementato** (`routes/billing.js`): Checkout session `mode:'subscription'` con trial 7gg, webhook per rinnovi automatici, cancel/reactivate, success page con credenziali
- `register/index.html` chiama già `/billing/create-checkout` correttamente
- `.env`: duplicato `APP_URL=https://candidatelens.com` rimosso; placeholder Stripe aggiunti
- **Mancano solo le env var reali** da configurare su Render e Stripe Dashboard

## COSA È STATO FATTO (sessione 2026-06-19 — landing page fix)

### Landing page — correzioni contenuto (`landingpage/index.html`)
- Rimosso "nessuna carta di credito" falso da tutti i punti (hero.note, pricing.note, cta.sub, cta.badge1) in tutte e 6 le lingue (ES/EN/IT/DE/FR/PT) — la carta è richiesta al signup come indicato nella FAQ7
- "Il telefono non smette di suonare" → "i messaggi WhatsApp non si fermano" — Sara è chat only, non risponde a chiamate vocali
- Titolo settori "Funziona per qualsiasi attività che vende" → "...o professionista" — include medici, avvocati, consulenti
- Sottotitolo settori aggiornato con esempi professionisti in tutte e 6 le lingue
- Aggiunto tab settore "🩺 Medico / Professionista" con story HTML di esempio consultorio
- Mockup hero: sostituito mix pizza/fiori/parrucchiera (irrealistico per un singolo tenant) con fioraio coerente — valuta ₲, 4 ordini realistici (delivery rose, ritiro bouquet, arreglo anniversario, orchidee)
- Rimosso label "Sara Bot 🤖" da tutti e 6 i bubble-who nelle chat di esempio

## COSA È STATO FATTO (sessione 2026-06-18 — support bot)

### Support bot — COMPLETATO
- `routes/admin.js`: Claude Haiku risponde automaticamente a ogni messaggio merchant nella chat supporto
- System prompt con knowledge base completa: catalogo, ordini, delivery, appuntamenti, billing, WhatsApp, account
- Escalation: bot include `[ESCALATE]` quando non può risolvere → Telegram alert solo in quel caso
- Badge fix superadmin: `POST /superadmin/support/:tenantId/read` + in-memory timestamp → badge sparisce all'apertura chat
- Cleanup: `support_messages` > 90 giorni eliminati ogni 24h
- Rate limit 10 msg/min/tenant confermato valido

## COSA È STATO FATTO (sessione 2026-06-18 — email transazionali operative)

### Email — COMPLETATO
- `services/mailer.js`: riscritto da SMTP (bloccato da Render) → Brevo HTTP API (`axios` POST a `api.brevo.com/v3/smtp/email`)
- `BREVO_API_KEY` aggiunta su Render — niente più SMTP vars
- Header email: sfondo verde → sfondo bianco con bordino verde — logo trasparente ora visibile
- Footer "messaggio automatico, non rispondere" aggiunto in ES/EN/IT/DE/FR/PT su tutte le email
- Rate limit `/forgot-password`: 5 richieste/IP/ora via `express-rate-limit`
- Fix vulnerabilità: `multer` + `nodemailer` aggiornati (`npm audit fix`)
- Email operative: welcome (nuove iscrizioni) + password reset — testate e funzionanti
- Lingua email: segue `currentLang` del pannello al momento della richiesta
- Email da aggiungere (quando si fa Stripe): pagamento fallito, cancellazione abbonamento, eliminazione account

## COSA È STATO FATTO (sessione 2026-06-20 — fix superadmin edit tenant)

### Bug fix GET /superadmin/tenants/:id
- Errore: modal edit tenant → 404 "Tenant no encontrado"
- Causa: select includeva `meta_connected` (campo computato, non colonna DB) → Supabase error → catch restituiva 404
- Fix (`commit a1e8360`): rimosso `meta_connected` dal select, aggiunto `whatsapp_token` + `products_enabled/services_enabled/appointments_enabled`; `meta_connected` calcolato server-side come `!!data.whatsapp_token` prima della risposta
- Migliorato messaggio errore: espone dettaglio Supabase per debug futuro

## COSA È STATO FATTO (sessione 2026-06-18 — security hardening + forgot password)

### Security hardening
- `index.js`: fail-fast all'avvio se mancano env var critiche (`ADMIN_JWT_SECRET`, `SUPERADMIN_JWT_SECRET`, `STRIPE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`, `ANTHROPIC_API_KEY`) — server non parte se mancano
- `routes/admin.js`, `routes/superadmin.js`, `routes/billing.js`: rimossi tutti i fallback hardcoded (`'sara-bot-secret-change-me'`, `'sara-super-secret-change-me'`, `'sk_test_placeholder'`) — ora usano solo `process.env.*`
- Password fallback `sara1234` eliminata — tenant senza `admin_password_hash` riceve errore `403` con messaggio "contraseña no configurada, contactá soporte"
- Supabase: colonne `password_reset_token TEXT` + `password_reset_expires TIMESTAMPTZ` aggiunte alla tabella `tenants` (migration eseguita manualmente)

### Forgot password flow — IMPLEMENTATO
- `POST /admin/forgot-password`: genera token 32 byte (crypto.randomBytes), scadenza 1h, manda mail con link `APP_URL/admin/index.html?reset=<token>` — risponde sempre `{ok:true}` per prevenire user enumeration
- `POST /admin/reset-password`: verifica token + scadenza, salva bcrypt hash, invalida token (set null)
- `services/mailer.js`: aggiunta `sendPasswordReset()` con template HTML i18n completo (ES/EN/IT/DE/FR/PT)
- UI admin: link "¿Olvidaste tu contraseña?" sul login → modal email → form reset con double-confirm password
- `window.onload`: check `?reset=<token>` in URL → mostra `#resetPage` direttamente (salta loginPage)
- i18n: chiavi `login.forgot`, `forgot.*`, `reset.*` aggiunte in tutte e 6 le lingue in `public/admin/i18n.js`

## COSA È STATO FATTO (sessione 2026-06-19 — security hardening HttpOnly cookies + audit)

### JWT → HttpOnly cookies (COMPLETATO)
- `cookie-parser` aggiunto come middleware in `index.js`
- Login admin/superadmin/billing: `res.cookie('sara_token', token, { httpOnly, secure, sameSite:'strict' })` — JWT non più nel body
- `requireAuth` / `requireSuper` / billing cancel+reactivate: leggono da `req.cookies` — Bearer fallback rimosso (era attack surface)
- Nuovi endpoint: `GET /admin/me` (boot check leggero), `POST /admin/logout`, `GET /superadmin/me`, `POST /superadmin/logout`
- Frontend admin + superadmin: rimossi tutti i `localStorage.getItem/setItem('sara_token')`, rimossi header `Authorization: Bearer`, `credentials:'same-origin'` su tutte le fetch, variabile `TOKEN` eliminata
- Impersonazione superadmin: cookie settato server-side, token rimosso dall'URL
- `billing/success`: `localStorage.setItem` rimosso dall'HTML inline — cookie settato server-side prima della redirect
- `privacy.html` (ES/EN/IT/DE/FR): sezione 6 aggiornata — localStorage→HttpOnly cookie, testo accurato
- `NODE_ENV=production` settato su Render (flag `Secure` attivo su cookie HTTPS)

### Audit sicurezza post-migrazione (COMPLETATO)
- `routes/register.js`: rimosso fallback hardcoded `|| 'sara-bot-secret-change-me'` — fail-fast via `index.js`
- `routes/superadmin.js` `GET /tenants/:id`: `select('*')` → campi espliciti (esclude `whatsapp_token`, `admin_password_hash`, `stripe_*`, `password_reset_*`)
- `routes/superadmin.js` analytics: rimosso `whatsapp_token` dalla query
- `public/admin/index.html`: XSS in error display — `innerHTML` con `e.message` → `textContent`

## COSA È STATO FATTO (sessione 2026-06-20 — merchant NL bot completo)

### Bot WhatsApp merchant — linguaggio naturale (COMPLETATO)
- Rimossi tutti i comandi rigidi (CATALOGO, STOCK, PRECIO, CONFIRMAR, ecc.)
- Tutto passa per Claude Haiku che interpreta linguaggio naturale in qualsiasi lingua
- Lingua rilevata automaticamente da ogni messaggio → tutte le risposte nella lingua del merchant
- Template multilingua ES/IT/EN/FR/DE/PT per tutte le risposte

**Stock (delta vs assoluto):**
- "aggiungi 50 rose" / "arrivate 50" → `update_stock delta:+50` → stock precedente + 50
- "vendute 10" / "leva 10" / "meno 10" → `update_stock delta:-10`
- "il nuovo stock è 50" / "stock = 50" → `set_stock qty:50`

**Prodotti:** aggiungere, cambiare prezzo, marcare esaurito/disponibile, vedere catalogo

**Ordini:**
- `get_orders` — lista ordini attivi con icone stato (🟡 pending, ✅ confirmed, 🔧 preparing, 🚚 delivering)
- `update_order_status` — "sto preparando l'ordine di Mario" → status preparing/delivering/delivered
- `confirm_order` / `cancel_order` — disambiguazione se più ordini pendenti
- Notifiche nuovo ordine localizzate in 6 lingue

**Takeover chat:**
- "fammi parlare con Giuseppe" / "chatta con chi finisce con 335" → cerca conversazione → attiva
- Conferma: "🟢 Stai parlando con Giuseppe (+595...335). Invia STOP per restituire la chat a Sara."
- `STOP` (parola riservata esplicita) → termina takeover
- Selezione cliente per numero se più match

**Appuntamenti (se `appointments_enabled`):**
- `get_appointments` — agenda prossimi 7 giorni (filtrabile per cliente)
- `add_appointment` — con slot check (giorno chiuso, fuori orario, già occupato, blocco manuale)
- `cancel_appointment` / `reschedule_appointment` — fuzzy match + slot check su nuovo orario
- `block_time` / `unblock_time` — blocco calendario (ferie, chiusure); end_at default fine giornata
- Campi mancanti: chiede tutto in una volta, non step-by-step; flusso multi-turn con pending
- `duration_override` — "serve mezz'ora" senza specificare il servizio

**Servizi (se `services_enabled`):**
- `get_services`, `add_service`, `update_service` — prezzo, durata, disponibilità, nome, categoria

**Feature gating:** azioni bloccate se modulo disabilitato sul tenant (products/services/appointments_enabled)

**Fuzzy match prodotti/clienti:** typo tollerati, singolo match → conferma "Intendi *X*?", multipli → lista numerata

**Pending state persistito su DB:**
- `merchant_pending_json` (jsonb) su tabella `tenants`
- L1: in-memory Map (zero overhead operazione normale)
- L2: DB (sopravvive restart Render)
- **Migration richiesta:** `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS merchant_pending_json jsonb DEFAULT NULL;`

**Cache invalidation:** `invalidateStock` / `invalidateServices` chiamati dopo ogni modifica NL

### Commits questa sessione
- `658d849` — NL bot base (replace rigid commands)
- `dc02955` — takeover by customer name/phone + STOP
- `43391ef` — appointments + services actions
- `3ad53e4` — feature gating, missing fields, slot check
- `6550443` — order workflow, cache invalidation, multilang notifications
- `d31bae4` — merchant_pending_json DB persistence

## COSA È STATO FATTO (sessione 2026-06-20 — help tab rewrite)

### Admin help tab — aggiornata per riflettere bot NL reale (`commit 68c5f94`)
- `renderHelp()` in `public/admin/index.html`: rimosso helper `cmd(keyword, desc)` con comandi fissi (CATALOGO, STOCK nome qty, PRECIO, AGOTADO, DISPONIBLE, NUEVO, NOMBRE, CONFIRMAR, CANCELAR, CHAT, FIN, AYUDA) — sostituito con `item(html)` — card con esempi NL in corsivo
- Nuova struttura: badge NL multilingua (🌐), prodotti (esempi NL), foto (caption method), ordini (NL), takeover (box viola con STOP), confirmazioni (flusso lista numerata + sì/no), chat panel (invariato)
- `public/admin/i18n.js`: chiave `help.nl.info` aggiunta; tutti `help.*` aggiornati in ES/EN/IT/DE/FR/PT — esempi in linguaggio naturale, nessun comando rigido, STOP al posto di FIN per uscire dal takeover
- Nota: anche `routes/superadmin.js GET /tenants/:id` già fixato in questa sessione (commit precedente incluso nel push)

## COSA È STATO FATTO (sessione 2026-06-20 — superadmin view + email/username)

### Superadmin modal → read-only info view (commit 997f8c0 → completato sessione corrente)
- Modal edit rimpiazzato con vista read-only: nome, email, username, WhatsApp merchant, WhatsApp Bot (`bot_phone_number`), Phone Number ID (sotto Conexión Meta), stato Meta, sezioni attive, piano (moneda/prezzo), paese, data registrazione
- "Vence" (scadenza piano) rimosso — pagamento ricorrente Stripe, non ha scadenza fissa
- Phone Number ID accorpato sotto riga Conexión Meta (era riga separata, ora testo grigio sotto stato)
- Bottone "Reset contraseña" rimosso — l'utente resetta via email autonomamente
- Azioni rimaste: impersonate (blu) + chiudi (grigio), toggle attivo/inattivo full-width sopra
- Rimosso: form editing, import-from-images dal modal; bottoni duplicati rimossi (tenuti stile blu/giallo originali)
- `toggleFromModal()` nuovo — toggle + chiude modal + ricarica lista
- `bot_phone_number` salvato al wizard connect (OAuth + manuale) da `display_phone_number` Meta API — mostrato nel modal superadmin; tenant esistenti vedranno "—" finché non riconnettono

### Email separata da username (commit 997f8c0)
- `routes/register.js`: salva `email` + `country` al signup
- `routes/admin.js` `GET /settings`: espone `login_slug`, `email`, `name`
- `routes/admin.js` `POST /change-email`: valida formato + unicità, aggiorna colonna `email`
- `routes/admin.js` `POST /change-username`: valida formato (`[a-z0-9_.-]+`) + unicità, aggiorna `login_slug`
- `routes/admin.js` forgot-password: accetta sia email che username — cerca per colonna `email` prima, fallback `login_slug`; manda reset a `email` reale (fallback `login_slug` per tenant legacy senza email)
- `routes/superadmin.js` GET /tenants + GET /tenants/:id: include `email`, `country`
- `public/admin/index.html` settings: nuova card "Account" — cambia email + username con feedback i18n
- `public/admin/i18n.js`: chiavi `settings.account.*` + `err.invalid_email/email_taken/username_*` in ES/EN/IT/DE/FR/PT

**Migration Supabase richiesta (non ancora eseguita):**
```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bot_phone_number TEXT;
UPDATE tenants SET email = login_slug WHERE email IS NULL;
```

## COSA È STATO FATTO (sessione 2026-06-19 — fix UX + template catalogo Excel)

### Fix flash loginPage al boot / impersonazione (commit 2619e00)
- Root cause: `loginPage` visibile di default in HTML; `window.onload` la nascondeva solo dentro `showDashboard()` dopo `await fetch('/admin/me')` → flash durante il round-trip
- Fix: `loginPage.classList.add('hidden')` spostato PRIMA del fetch in `window.onload`; rimostrata nel ramo `else` + `catch` se non autenticato
- File: `public/admin/index.html` — `window.onload`

### Superadmin modal cleanup finale (commit 080f713)
- Bottone "Reset contraseña" rimosso dal modal — l'utente resetta autonomamente via email
- "Vence" (scadenza piano) rimosso — Stripe è ricorrente, non ha scadenza fissa
- Phone Number ID accorpato sotto riga Conexión Meta (testo grigio mono, non riga separata)

### Template Excel catalogo prodotti (commit eb4061a)
- `public/catalog_template.xlsx`: foglio **Catalogo** (7 colonne: nome*, categoria, descrizione, prezzo*, stock, disponibile, SKU) + 3 righe esempio + dropdown SI/NO + freeze pane + foglio **Instrucciones**
- `GET /admin/catalog-template`: route autenticata che fa `res.download()` del file
- Pannello admin → Importa → CSV: banner viola con link "📥 Plantilla Excel →" → scarica template
- i18n `import.csv.templateHint` + `import.csv.templateBtn` in ES/EN/IT/DE/FR/PT

## COSA È STATO FATTO (sessione 2026-06-19 — import/export audit + ZIP bulk images)

### Import/export — audit e fix (commit 9dea353)
- **Export colonne inglese**: prodotti (`name,category,price,stock,active,description,image_url,created_at`) e servizi (stesso schema + `price_type,duration_min`)
- **Prezzi decimali**: import CSV ora usa `parseFloat` + strip solo `[^\d.,]` → supporta `€4,99`, `4.99`, `1.500`
- **AI foto import**: prompt passa valuta del tenant (`plan_currency`) e consente decimali (era "número entero" hardcoded)
- **URL esterna rimossa** dal form prodotto — solo upload file; nessun link esterno che si rompe
- **ZIP bulk images**: `POST /admin/products/bulk-images` — accetta ZIP (max 50MB), estrae immagini, fuzzy-match nome file → nome prodotto (soglia 50%, match esatto=100, inclusione=90, overlap parole>2char), carica su Supabase Storage, aggiorna DB; bottone "📦 Imágenes ZIP" + modal con istruzioni + report matched/unmatched
- **Valuta dinamica nel bot**: `services/claude.js` — `formatPrice()` con `CURRENCY_SYMBOL` + `CURRENCY_LOCALE` per 10 valute; sostituisce "Gs"/"es-PY" hardcoded; EUR merchant vede `€4,99`, USD vede `$29.99`, PYG vede `15.000 Gs`
- **`/settings` espone `plan_currency`**: frontend può mostrare simbolo valuta corretto
- **i18n**: chiavi `zip.*` + `products.bulkImages` in ES/EN/IT/DE/FR/PT

**Flusso ZIP per merchant:**
1. Esporta CSV catalogo → vede colonna `name` con nomi esatti
2. Rinomina foto con nome prodotto (`rosa-roja.jpg`, `torta-chocolate.jpg`)
3. Fa ZIP → carica da tab Productos → bottone "📦 Imágenes ZIP"
4. Modal mostra risultati: foto assegnate (con %) e non matchate

**Security hardening ZIP (commit 5911b29 + 75a05dd):**
- `zipRateLimit`: 10 upload/ora per tenant
- `handleZipUpload` wrapper: `MulterError LIMIT_FILE_SIZE` → JSON 413 (non crash Express)
- MAX_ZIP_ENTRIES = 300: rifiuta prima di estrarre se troppi file
- ZIP bomb guard: somma `entry.header.size` (non compresso) prima di qualsiasi `getData()` — rifiuta se totale > 200MB
- Per-entry cap: skip se immagine decompressa > 8MB
- Magic bytes check (`detectImageMime`): valida JPEG/PNG/GIF/WebP dai primi 12 byte — rifiuta file con estensione giusta ma contenuto non-immagine; usa mime reale (non da estensione) per upload
- Modal UI (commit 1d62470): pannello limiti visibile in 6 lingue (formati, 300 img max, 50MB ZIP, 8MB/img)

## COSA È STATO FATTO (sessione 2026-06-19 — UX cliente Sara + offerte + chiusure)

### Sara bot — miglioramenti esperienza cliente (commits 1036611, 42e8b45, 832d3f1, ad7b496)
- **Prompt personality-first**: `buildStaticSystemPrompt` ristrutturato — personalità è identità primaria, regole operative vengono dopo; regole stile WhatsApp aggiunte (messaggi corti, una domanda, no "¡Perfecto!", usa il nome, foto proattiva, offri alternativa se esaurito)
- **Stato ordine**: Sara vede ordine attivo del cliente nel dynamic prompt → risponde a "dov'è il mio ordine?"
- **Memoria acquisti**: ultimi 3 ordini consegnati nel dynamic prompt → "vuoi lo stesso di sempre?"
- **Foto proattiva**: Sara manda foto prodotto appena il cliente mostra interesse, senza aspettare richiesta esplicita
- **Occasion awareness per paese**: `getNearbyOccasion(country)` — Festa della Mamma diversa per PY/MX/AR/IT/ES/FR/GB; Sara menziona occasione solo se catalogo è rilevante (fioraio sì, dentista no)
- **Lista d'attesa esauriti**: tag `<WAITLIST:prodotto>` — cliente dice "avisami" → salva in tabella `waitlist` → quando merchant aggiorna stock a >0, notifica automatica a tutti i clienti in attesa
- **`services/claude.js`**: `buildDynamicSystemPrompt` ora accetta `customerContext`, `closures`, `offers`

### Chiusure aziendali (commit a152636)
- Tabella `business_closures (tenant_id, start_date, end_date, label)`
- Admin UI: sezione "🏖️ Cierres y Vacaciones" in Settings — crea/elimina chiusure con date range + etichetta
- Sara: vede chiusure nel dynamic prompt, avvisa clienti con data riapertura
- Appuntamenti: slot dei giorni in chiusura esclusi automaticamente dal calcolo 14 giorni
- Delivery: se oggi in chiusura, Sara informa che non si consegna
- Merchant NL: `create_closure` ("siamo in ferie dal 1 al 20 agosto") + `delete_closure`
- Cache: `getBusinessClosures` con TTL 45s, `invalidateClosures` dopo ogni modifica

### Offerte e sconti (commit 4d75824)
- Tabella `offers (tenant_id, label, discount_type: percent|fixed, discount_value, scope, scope_target, valid_from, valid_to, is_active)`
- Scope: `all_products`, `category`, `product`, `all_services`, `service_category`, `service`
- `buildStaticSystemPrompt`: applica sconto al prezzo nel catalogo → Sara mostra prezzo scontato + originale + etichetta
- Admin UI: sezione "🏷️ Ofertas y Descuentos" — form con tipo/valore/scope/date + lista con eliminazione
- Merchant NL: `create_offer` ("20% su tutte le rose fino a domenica") + `delete_offer`
- Cache: `getOffers` con TTL 45s, `invalidateOffers` dopo ogni modifica

### Migration SQL richieste (da eseguire in Supabase SQL Editor se non già fatto)
```sql
-- Waitlist
CREATE TABLE IF NOT EXISTS waitlist (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  product_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, customer_phone, product_name)
);

-- Business closures
CREATE TABLE IF NOT EXISTS business_closures (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  label      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Offers
CREATE TABLE IF NOT EXISTS offers (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value NUMERIC(10,2) NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('all_products','category','product','all_services','service_category','service')),
  scope_target   TEXT,
  valid_from     DATE,
  valid_to       DATE,
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
```

## COSA È STATO FATTO (sessione 2026-06-19 — Sara UX completamento)

### Sara bot — completamento 4 feature extra (commit bb75190)
- **Cross-sell rule 13**: `buildStaticSystemPrompt` → regola 13 aggiunta: suggerisce 1 prodotto complementare al momento della conferma ordine, mai forzato, mai al primo messaggio
- **Business hours in dynamic prompt**: `buildDynamicSystemPrompt` accetta `businessHours[]` + `isFirstMessage` — `hoursBlock` dice a Sara se è aperto o chiuso ora (con orario riapertura) e di accettare ordini ma avvisare "verranno confermati in orario lavorativo" se chiuso; `firstMsgBlock` abilita saluto personalizzato al primo messaggio
- **`getBusinessHours`** in `services/stock.js`: cache 45s, già presente — ora esportato e usato anche in webhook
- **Webhook `handleCustomerMessage`**: `getBusinessHours` aggiunto al `Promise.all` parallelo; `isFirstMessage = history.length === 0` calcolato prima di chiamare `chat()`; entrambi passati a `chat()`
- **Push notifiche cliente per cambio stato ordine**: `notifyCustomerOrderStatus()` helper — manda messaggio automatico al cliente (non al merchant) quando stato ordine cambia a `preparing`/`delivering`/`delivered`; stringhe multilingua aggiunte in MT (`cust_status_preparing/delivering/delivered` in ES/EN/IT/DE/FR/PT); chiamato in entrambi i path (single-match + pending-candidate)

## COSA È STATO FATTO (sessione 2026-06-19 — catalog UX rule)

### Sara — regola catalogo (commit a18d37e)
- Regola 14 in `buildStaticSystemPrompt`: Sara non dumpa mai tutto il catalogo. "Che avete?" → 2-3 esempi + "cerchi qualcosa in particolare?". Categoria specifica → max 3-4 prodotti + chiede follow-up. Evita wall of text e token sprecati.

## COSA È STATO FATTO (sessione 2026-06-19 — UX features 2+8+11)

### Feature 2 — Indirizzo negocio (commit 87c8943)
- `tenants.address` esposto in GET/PUT `/admin/settings`; iniettato nel static prompt → Sara risponde a "dove siete?"
- Admin UI: card "📍 Información del negocio" in Settings con campo indirizzo + link Google Reviews; i18n ES/EN/IT/DE/FR/PT

### Feature 8 — Note cliente (commit 87c8943)
- `conversations.customer_notes TEXT`: `PATCH /admin/chats/:phone/notes` salva note private
- Chat panel: strip gialla con campo note; si auto-salva `onchange`; `refreshChat()` la popola ad ogni refresh
- `buildDynamicSystemPrompt` accetta `customerNotes` → iniettato come contesto privato ("non menzionarlo esplicitamente")
- `chat()` passa `customerNotes: convRow?.customer_notes` dal convRow già caricato (select('*'))

### Feature 11 — Review request post-consegna (commit 87c8943)
- `tenants.google_review_url TEXT` in settings
- `notifyCustomerOrderStatus(order, status, phoneNumberId, token, tenant)`: quando `status==='delivered'` e `tenant.google_review_url` settato, manda secondo messaggio con link recensione
- Entrambi i path (single-match + pending-candidate) passano `tenant`

### Migration SQL — ✅ ESEGUITE (2026-06-19)
```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS google_review_url TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_notes TEXT;
```

## COSA È STATO FATTO (sessione 2026-06-19 — cron features + broadcast)

### Reminder appuntamenti 24h — COMPLETATO (commit 9d4cedf)
- `services/cron.js`: `runAppointmentReminders()` — ogni ora, finestra 23-25h, guard `reminder_sent_at IS NULL`, `status != cancelled`, `customer_phone NOT NULL`
- Manda messaggio al cliente via WhatsApp, poi segna `reminder_sent_at = NOW()`
- Raggruppa per tenant_id per minimizzare le query tenant

### Nudge carrello abbandonato — COMPLETATO (commit 9d4cedf)
- `services/cron.js`: `runAbandonedCartNudge()` — ogni ora, conversazioni aggiornate 2-24h fa, cooldown 7gg (`last_nudge_at`)
- Esclude clienti che hanno già ordinato nelle ultime 24h (cross-check tabella `orders`)
- Solo tenant con `products_enabled = true`
- 500ms delay tra messaggi per evitare rate limit Meta

### Broadcast marketing — COMPLETATO (commit 9d4cedf)
- `POST /admin/broadcast`: filtra clienti per `days_active` (default 30gg), invia a tutti a ~1 msg/s (fire-and-forget post-response)
- Validazione: messaggio non vuoto, max 1000 caratteri
- UI in tab Clientes: select periodo + textarea + pulsante viola + feedback count
- i18n `broadcast.*` + `err.missing_message/message_too_long` in ES/EN/IT/DE/FR/PT

### Migration SQL — ✅ ESEGUITE (2026-06-19)
```sql
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;
```

## ANALISI COSTI AI (calcolo parziale, sessione 2026-06-19)

### Modelli in uso
- Chat cliente (`handleCustomerMessage`): `claude-haiku-4-5-20251001`, max_tokens 1024 — `services/claude.js:420-421`
- Import foto: `claude-haiku-4-5-20251001`, max_tokens 2048 — `routes/admin.js:1033-1034`
- Support bot: `claude-haiku-4-5-20251001`, max_tokens 512 — `routes/admin.js:1683-1684`
- MAX_HISTORY = 20 msg — `services/claude.js:26`

### Prezzi Haiku 4.5
- Input: $1.00/MTok | Cache write: $1.25/MTok | Cache read: $0.10/MTok | Output: $5.00/MTok

### Costo per messaggio (chat cliente, stima con caching)
- Input: ~200 token uncached + ~1.800 token cached (static prompt)
- Output: ~300 token
- Formula: (200×$0.000001) + (1800×$0.0000001) + (300×$0.000005) ≈ **$0.000380/msg**

### Stima per tenant/mese
| Scenario | Msg/mese | Costo AI |
|----------|----------|----------|
| Basso (33 msg/gg) | 1.000 | ~$0.38 |
| Medio (50 msg/gg) | 1.500 | ~$0.57 |
| Alto (100 msg/gg) | 3.000 | ~$1.14 |
| Molto alto (200 msg/gg) | 6.000 | ~$2.28 |

**Cache miss rate 30% → moltiplica ×1.3 → ancora < $3/tenant/mese anche per uso molto alto.**

### Infrastruttura (sessione 2026-06-19 — COMPLETATO)
- Render: istanza paid ~$7/mese (Hobby workspace, no Pro workspace)
- Supabase: Pro $25/mese (free si pausa — obbligatorio per prod)
- Brevo: free (300 email/giorno, sufficiente per centinaia di tenant)
- **Totale fisso: ~$32/mese**
- Break-even: 2 clienti paganti qualsiasi piano

## COSA È STATO FATTO (sessione 2026-06-19 — sistema prenotazioni ristorante)

### Restaurant reservation system — COMPLETATO (commit d15f86a)
- Tabelle `restaurant_zones`, `restaurant_tables`, `reservations` + colonne `restaurant_enabled`, `restaurant_slot_duration` su `tenants` — migration eseguita su Supabase
- `services/stock.js`: `getRestaurantZones`, `getRestaurantTables`, `getUpcomingReservations`, `invalidateRestaurant`
- `services/claude.js`: `buildRestaurantStaticBlock` (zone+tavoli nel prompt statico), `buildReservationsBlock` (prenotazioni next 7gg nel prompt dinamico), parsing tag `RESERVATION`
- `routes/admin.js`: CRUD completo zone/tavoli/prenotazioni + `PUT /restaurant/settings`; `GET /settings` espone campi restaurant
- `routes/webhook.js`: caricamento dati restaurant (keyword-gated), gestione tag RESERVATION — assegna tavolo più piccolo libero, escalation a merchant per gruppi grandi
- Admin UI: tab 🍽️ Restaurante (nascosta finché non attivata) — toggle enable, slot duration, CRUD zone, CRUD tavoli per zona, vista giornaliera prenotazioni con cambio status
- i18n: `restaurant.*` in ES/EN/IT/DE/FR/PT

### Flusso Sara ristorante
1. Cliente chiede tavolo → Sara raccoglie n. persone, data, ora, preferenza zona
2. Verifica disponibilità in prompt dinamico (prenotazioni esistenti 7gg)
3. Gruppo ≤ tavolo singolo → conferma + tag `<RESERVATION:JSON>` → backend assegna tavolo libero più piccolo
4. Gruppo > tavolo singolo max → `status: pending_merchant` → notifica WhatsApp merchant

## COSA È STATO FATTO (sessione 2026-06-19 — superadmin restaurant badge)

### Superadmin — restaurant_enabled visibile (commit ddd9dd9)
- `routes/superadmin.js` GET `/tenants/:id`: aggiunto `restaurant_enabled` al select
- `routes/superadmin.js` PUT `/tenants/:id`: aggiunto `restaurant_enabled` ai campi aggiornabili
- `public/superadmin/index.html`: badge `🍽️ Restaurante` aggiunto in "Secciones activas" del modal tenant
- Pushato su Render (origin/main — 6 commit totali)

## COSA È STATO FATTO (sessione 2026-06-19 — pricing + Stripe test)

### Pricing — DEFINITO E IMPLEMENTATO (commit fdf017f, e699632)
- 4 piani: Shop $24.99, Bookings $29.99, Restaurant $39.99, Pro $44.99
- Moduli per piano: Shop=products; Bookings=services+appointments; Restaurant=products+appointments+restaurant; Pro=products+services+appointments
- `routes/billing.js`: PRICE_IDS aggiornato con 4 env vars
- `routes/register.js`: moduli abilitati automaticamente al signup per piano
- `public/register/index.html`: 4 card piano, currency map, selectPlan aggiornati
- `public/register/i18n.js`: chiavi s4.shop/bookings/restaurant/pro in 6 lingue
- `landingpage/index.html`: 4 card pricing + TR in 6 lingue

### Stripe test mode — CONFIGURATO
- 4 prodotti creati in Stripe test mode con price_id
- `STRIPE_PRICE_SHOP`, `STRIPE_PRICE_BOOKINGS`, `STRIPE_PRICE_RESTAURANT`, `STRIPE_PRICE_PRO` aggiunti su Render
- `STRIPE_SECRET_KEY` (test) aggiunta su Render
- `STRIPE_WEBHOOK_SECRET` aggiunto su Render
- Webhook endpoint: `https://sara-bot-tcl6.onrender.com/billing/webhook`
- Events: `customer.subscription.created/updated/deleted`, `invoice.payment_failed`, `customer.subscription.trial_will_end`

## COSA È STATO FATTO (sessione 2026-06-19 — landing page pricing UX)

### Landing page pricing — aggiornata (commit 88d1856 + e4564f4)
- Layout: 4 colonne desktop, 2x2 tablet, 1 colonna mobile (era auto-fit 3+1)
- Badge "7 giorni di prova gratis" verde prominente sopra la griglia (era testo piccolo)
- Esempi attività commerciale sotto ogni nome piano (Tiendas·Floristerías..., Peluquerías·Médicos..., etc.)
- Feature lists a crescita progressiva: Shop=5, Bookings=6, Restaurant=7, Pro=9 — percepzione differenza prezzo
- Rimossa scritta piccola pricing.note ("7 días gratis en cualquier plan · Cancelás...")
- TR aggiornata in 6 lingue per: pricing.trial, pricing.*.example, f1-f7/f9 corretti per ogni piano

## COSA È STATO FATTO (sessione 2026-06-19 — GDPR compliance, commit 1f7738e)

### GDPR compliance — COMPLETATO
- `public/legal/dpa.html`: DPA (Data Processing Agreement) in ES/EN/IT/DE/FR — sub-processor list, obblighi processor, clausole SCCs, strumento erasure
- `routes/admin.js`: `DELETE /admin/customers/:phone` — cancella tutti i dati di un cliente finale (conversations, orders, waitlist, appointments, reservations)
- `public/admin/index.html`: bottone 🗑️ in chat header + `eraseCustomerData()` — conferma + call API + chiude chat
- `public/admin/i18n.js`: chiavi `chat.erase.*` in ES/EN/IT/DE/FR/PT
- `public/register/i18n.js`: `s4.legal` aggiornato con link DPA in tutte e 6 le lingue
- `public/legal/privacy.html`: §5 aggiornato con right-to-erasure strumento + link DPA in ES/EN/IT/DE/FR
- Retention conversations 90gg già attiva in `index.js` (cleanup cron)
- Brevo SAS aggiunto come sub-processor in privacy.html e dpa.html (ES/EN/IT/DE/FR) — commit e73f6c4
- `/legal/dpa` route aggiunta in index.js (era mancante — file servito solo come /legal/dpa.html)
- PII scrub: `senderPhone` rimosso dal log audio transcription in webhook.js

## COSA È STATO FATTO (sessione 2026-06-19 — legal doc visibility, commit caa8af9)

### Visibilità documenti legali — COMPLETATO
- `landingpage/index.html`: footer URL fix `.html` → clean (`/legal/terms`, `/legal/privacy`, `/legal/disclaimer`)
- `public/admin/index.html`: DPA link aggiunto in login footer + sezione Settings → Legal
- `public/admin/i18n.js`: chiave `settings.legal.dpa` in ES/EN/IT/DE/FR/PT

**Mappa finale visibilità:**
| Doc | Landing | Register step 4 | Admin login | Admin settings |
|-----|---------|-----------------|-------------|----------------|
| Terms | ✅ | ✅ | ✅ | ✅ |
| Privacy | ✅ | ✅ | ✅ | ✅ |
| Disclaimer | ✅ | — | ✅ | ✅ |
| DPA | — (B2B) | ✅ | ✅ | ✅ |

## COSA È STATO FATTO (sessione 2026-06-19 — UI per-piano + label menu ristorante)

### Tab gating per piano + label "Menù" ristorante (commit 7e02fc6 + corrente)
- Admin panel: tab visibili in base ai moduli del piano (`products_enabled`, `services_enabled`, `appointments_enabled`, `restaurant_enabled`) — già funzionava via `applyTabVisibility`
- Ristorante: tab "Productos" → "🍽️ Menù" (chiave `tab.menu` in ES/EN/IT/DE/FR/PT)
- Ristorante: tutti i testi del tab prodotti → terminologia menu: titolo "Menú", "+ Nuevo ítem", colonna "Plato", "Platos activos", import title/hint/found (7 chiavi `menu.*` in 6 lingue)
- Meccanismo: `isRestaurantPlan` global + `applyMenuLabels()` chiamata da `applyTranslations()` e `applyTabVisibility()` — swap i18n key su `data-i18n` originali, override post-translate
- Superadmin modal: "Secciones activas" (4 badge moduli) → "Suscripción" con badge unico nome piano (Shop/Bookings/Restaurant/Pro derivato da flags)
- Superadmin lista tenant: badge piano inline sotto nome (es. `Sara · desde 01/01/2026 · 🍽️ Restaurant`)

## COSA È STATO FATTO (sessione 2026-06-19 — superadmin tenant list polling)

### Superadmin lista tenant — auto-refresh (commit 1cacfac)
- `setInterval(loadTenants, 60000)` aggiunto in `public/superadmin/index.html`
- Gira solo quando tab Clientes è visibile (check `sectionClients.classList`)
- Rileva in automatico: cancellazioni account, nuove iscrizioni, cambio piano

## COSA È STATO FATTO (sessione 2026-06-19 — broadcast security + bug fixes)

### Broadcast — protezioni (commit 6d13245)
- `broadcastRateLimit`: 1 richiesta/ora per tenant (express-rate-limit keyed su tenantId)
- `broadcastInProgress` Set: guard contro chiamate parallele (doppio click, bot) — blocca prima che il rate limiter scatti
- Loop in `try/finally` → Set svuotato anche su crash
- Fix token: `broadcastToken = tenant.whatsapp_token || process.env.WHATSAPP_TOKEN` (commit d241b41) — "Sin Meta" tenant usano token globale come il webhook

## PROSSIME PRIORITÀ (sessione successiva)
1. **Stripe test** — testare flow completo iscrizione end-to-end (scegli piano → Stripe checkout → webhook → tenant attivo)
2. **Fatturazione** — capire come mandare fatture ai merchant
3. **Go-to-market** — pubblicità, test, vendita

## IDEE FUTURE (non ancora pianificate)

### Offerte / sconti — ✅ IMPLEMENTATO sessione 2026-06-19
### Chiusure aziendali — ✅ IMPLEMENTATO sessione 2026-06-19
### Indirizzo + review request — ✅ IMPLEMENTATO sessione 2026-06-19
### Note cliente private — ✅ IMPLEMENTATO sessione 2026-06-19

## COSA NON FUNZIONA / IN SOSPESO
- **Env vars mancanti su Render** — da aggiungere in Render → Environment prima che il wizard funzioni:
  - `META_APP_ID` = `27756118003980694` (ID app Meta)
  - `META_APP_SECRET` = chiave segreta app (visibile in Meta Developer → Settings → Basic → "Chiave segreta")
  - `META_CONFIG_ID` = Configuration ID da Facebook Login for Business → Configurations (da creare se non esiste ancora)
- **META_CONFIG_ID non ancora creato** — va su Meta Developer → Facebook Login for Business → Configurations → crea nuova configurazione → copia ID
- **Stripe in TEST mode** — configurato e funzionante in test. Per andare live: sostituire `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, e i 4 `STRIPE_PRICE_*` con valori live su Render.

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
"Leggi HANDOFF.md. Sessione precedente: landing page pricing completata (badge prova, esempi attività, feature crescenti 5/6/7/9). Prossimo: testare flow Stripe end-to-end (signup → checkout → webhook → tenant attivo)."

## ERRORI NOTI / TRAPPOLE
- NON leggere/query tabella prod `tenants` con `select('*')` o colonne sensibili senza autorizzazione esplicita utente per quella lettura specifica — bloccato da permission classifier (dati merchant: token WhatsApp, telefoni). `superadmin GET /tenants/:id` ora usa campi espliciti sicuri.
- Anthropic prompt caching ha soglia minima ~4096 token sul prefisso cacheabile per modelli Haiku-tier: sotto soglia, caching no-op silenzioso, nessun errore — non assumere che caching funzioni senza verificare `response.usage.cache_creation_input_tokens`/`cache_read_input_tokens`.
- Caching è match byte-prefix stretto: qualsiasi contenuto dynamic messo PRIMA del blocco static rompe la cache ogni volta.
