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

### Superadmin modal → read-only info view (commit 997f8c0)
- Modal edit rimpiazzato con vista read-only: nome, email, username, WhatsApp merchant, Bot ID (Meta), stato Meta, sezioni attive, piano (moneda/prezzo/scadenza), paese, data registrazione
- Azioni rimaste: impersonate, toggle active (nel modal), reset password
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

## PROSSIME PRIORITÀ (sessione successiva)
1. **Migration Supabase** — `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS merchant_pending_json jsonb DEFAULT NULL;` (richiesta per pending persistence)
2. **Stripe** — configurare env vars reali su Render + testare flow completo con account business
3. **Bot supporto** — risposta automatica FAQ/supporto nella sezione support del pannello admin
4. **Email** — finire config Cloudflare send + Brevo receive
5. **Sara risposte** — tuning qualità risposte ai clienti finali
6. **Costi/margini** — calcolo reale token AI + infra + limiti piano + definire piani starter/pro
7. **Fatturazione** — capire come mandare fatture ai merchant
8. **GDPR compliance** — audit cosa manca (DPA, retention policy, right-to-erasure flow)
9. **Go-to-market** — pubblicità, test, vendita

## COSA NON FUNZIONA / IN SOSPESO
- **Env vars mancanti su Render** — da aggiungere in Render → Environment prima che il wizard funzioni:
  - `META_APP_ID` = `27756118003980694` (ID app Meta)
  - `META_APP_SECRET` = chiave segreta app (visibile in Meta Developer → Settings → Basic → "Chiave segreta")
  - `META_CONFIG_ID` = Configuration ID da Facebook Login for Business → Configurations (da creare se non esiste ancora)
- **META_CONFIG_ID non ancora creato** — va su Meta Developer → Facebook Login for Business → Configurations → crea nuova configurazione → copia ID
- **Stripe env vars mancanti su Render** — da configurare su stripe.com + aggiungere in Render → Environment:
  - `STRIPE_SECRET_KEY=sk_live_...`
  - `STRIPE_WEBHOOK_SECRET=whsec_...` (da Stripe Dashboard → Developers → Webhooks → endpoint `https://sarabot.pro/billing/webhook`)
  - `STRIPE_PRICE_STARTER=price_...`
  - `STRIPE_PRICE_PRO=price_...`
  - Webhook Stripe: events `customer.subscription.created/updated/deleted` + `invoice.payment_failed`

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
"Leggi HANDOFF.md. Sessione precedente: merchant NL bot completato (linguaggio naturale, appuntamenti, ordini, servizi, takeover, persistence DB). Prima cosa: eseguire migration Supabase `merchant_pending_json`. Poi priorità 2: Stripe con account business reale."

## ERRORI NOTI / TRAPPOLE
- NON leggere/query tabella prod `tenants` con `select('*')` o colonne sensibili senza autorizzazione esplicita utente per quella lettura specifica — bloccato da permission classifier (dati merchant: token WhatsApp, telefoni). `superadmin GET /tenants/:id` ora usa campi espliciti sicuri.
- Anthropic prompt caching ha soglia minima ~4096 token sul prefisso cacheabile per modelli Haiku-tier: sotto soglia, caching no-op silenzioso, nessun errore — non assumere che caching funzioni senza verificare `response.usage.cache_creation_input_tokens`/`cache_read_input_tokens`.
- Caching è match byte-prefix stretto: qualsiasi contenuto dynamic messo PRIMA del blocco static rompe la cache ogni volta.
