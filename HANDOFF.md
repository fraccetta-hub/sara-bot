# PROJECT HANDOFF — Sara Bot (whatsapp-bot) — 2026-06-21

## ✅ FATTO (2026-06-21 — security hardening bot: rate limit merchant, broadcast lock, injection block, delete confirm) [commit 4fc8511]

### Analisi sicurezza preventiva + implementazione
**`services/ratelimit.js`** — aggiunto tier merchant separato:
- Merchant: 120 msg/h, 400/giorno, 30 foto/h, 30 audio/h (cliente restava a 50/h, 8 foto, 10 audio)
- Messaggi di blocco localizzati in 6 lingue per merchant (prima solo spagnolo per cliente)
- Cleanup store ogni ora: rimuove entries > 1 giorno vecchio (prevenzione memory leak)

**`routes/webhook.js`** — multipli fix:
- **Merchant rate limiting**: applicato prima di `handleMerchantImage` / `handleMerchantMessage`
- **Injection bloccata** (drop silenzioso, no feedback all'attaccante): testo + audio trascritto — prima solo loggata
- **Broadcast lock**: `broadcastInProgress` Set per tenant — previene doppio invio se merchant invia "broadcast" due volte di fila (identico al lock già presente in admin.js)
- **Broadcast length**: max 1000 caratteri (identico al limite admin panel)
- **delete_product / delete_service** con 1 solo match: chiede conferma sì/no invece di eliminare subito; con più match → lista numerata (invariato)
- **delete_customer**: sempre chiede conferma sì/no prima di eliminare (azione distruttiva)
- `merchantLang` Map pulita ogni 7 giorni (cleanup cosmetic, non critico — max 1 entry per tenant)

**`services/claude.js`** — regola 14 riscritta (output limitato):
- Cliente chiede "tutto il catalogo" → Sara risponde con lista CATEGORIE + "quale ti interessa?"
- Cliente sceglie categoria → max 4-5 prodotti + "ci sono altre opzioni, cerchi qualcosa in particolare?"
- Cliente insiste → max 5 prodotti per risposta, mai dump completo
- Vale anche per liste ordini/appuntamenti/prenotazioni (max 5 per risposta)

**Analisi sicurezza — cose già protette (non modificate)**:
- Firma webhook Meta (HMAC SHA-256) ✅
- `max_tokens: 1024` cliente, 400 merchant intent parser ✅
- Storico conversazione capped MAX_HISTORY=20 ✅
- 47 query con filtro `tenant_id` ✅

**Gap documentati non implementati** (bassa priorità, da valutare):
- Guardia `.eq('tenant_id', ...)` difensiva sugli UPDATE prodotti/servizi (id viene già da query filtrata per tenant → safe ma non esplicito)
- Reservation spam cliente anonimo (non critico — prenotazioni richiedono conferma merchant)

### Manutenzione DB — conversations cleanup
- Tabella `conversations`: ~2-3 KB per riga (20 messaggi max per `MAX_HISTORY`). 100K clienti ≈ 250 MB. Supabase free tier cap 500 MB.
- Job pulizia 90 giorni INSERITO dall'utente (via Supabase pg_cron o cron esterno):
  ```sql
  DELETE FROM conversations WHERE updated_at < NOW() - INTERVAL '90 days';
  ```
- Non un fix sicurezza — manutenzione spazio disco. Non urgente sotto i 50K clienti attivi.

## ✅ FATTO (2026-06-21 — merchant bot: azioni complete, rate limit, bot mirror admin panel) [commits 036a0ef…4fc8511]

### Bot merchant — specchio completo pannello admin
Vedere sezione `## COSA È STATO FATTO (sessione 2026-06-21 — merchant bot)` sotto.

## ✅ FATTO (2026-06-21 — audit sicurezza full-stack + fix S1/S2/S4) [commit 28a52ad]

Audit read-only di tutto il backend (routes/services/index). Fix approvati dall'utente: S1, S2, S4 (S3 in attesa di decisione — vedi sotto).
- **S1 — firma webhook Meta**: `POST /webhook` ora verifica `X-Hub-Signature-256` (HMAC-SHA256 del raw body con `META_APP_SECRET`); scarta payload spoofati (401). `express.json` cattura `req.rawBody`. Salta solo se `META_APP_SECRET` non settato. ⚠️ **Deploy**: `META_APP_SECRET` deve essere l'app secret corretto (già usato per il token exchange → ok). Se fosse sbagliato, TUTTI i webhook verrebbero rifiutati (log `[webhook] rejected: invalid X-Hub-Signature-256`).
- **S2 — secret Telegram**: `POST /telegram-webhook` verifica header `X-Telegram-Bot-Api-Secret-Token` vs `TELEGRAM_WEBHOOK_SECRET`. ⚠️ **Deploy (2 step)**: 1) settare `TELEGRAM_WEBHOOK_SECRET` su Render; 2) ri-registrare il webhook con `secret_token`:
  `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://sarabot.pro/telegram-webhook&secret_token=<SECRET>"`. Se setti l'env ma NON ri-registri, Telegram non manda l'header → updates rifiutati (superadmin non può rispondere via Telegram).
- **S4 — rate-limit reset-password**: `POST /admin/reset-password` ora 10/h per IP (`resetPasswordLimiter`).
- **S3 — rate-limit register** [commit e2f7c90]: `POST /register` 10/h, `GET /register/check-email` 30/h per IP.
- **trust proxy + hardening** [commit 61fde2e]: aggiunto `app.set('trust proxy', 1)` (req.ip reale dietro Render → rate-limiter per-IP, Secure cookie); error-handler Express globale (500 generico, niente stack trace ai client); handler `unhandledRejection`/`uncaughtException` (log invece di crash). Tutti i rate-limiter ora keyano sull'IP client reale.
- Note audit (non bug): billing cancel/reactivate/change-plan hanno auth inline (cookie+JWT); confirm-deletion/confirm-username-change validano token+scadenza; `getTenantConfig` usa `select('*')` ma è interno/server-side; nessun error-handler Express globale (bassa); header sicurezza base presenti; nessun leak segreti nei log; register e superadmin frontend puliti.

## ✅ FATTO (2026-06-21 — audit i18n: chiavi mancanti/duplicate/morte) [commit 561930e]

Audit read-only su `public/admin/i18n.js`, poi fix approvati dall'utente:
- **A** — DE `settings.delivery.zoneOuter` aveva `(Gs)` letterale invece di `{cur}` → utenti DE vedevano Gs sempre. Corretto.
- **B** — 3 chiavi mancanti aggiunte in 6 lingue: `restaurant.slotDurationTitle` (prima ripiegava sul testo italiano hardcoded per TUTTE le lingue), `settings.personality.saved` (mostrava "undefined" al salvataggio personalità), `wiz.fb.error`.
- **C** — rimossi duplicati nel blocco PT (`usernameCheckEmail`, `usernamePending`, `plan.manage.payment`, `plan.promo.*`) → ora 6 occorrenze ciascuna.
- **D** — rimosse chiavi morte `settings.delivery.mapsUrl/mapsUrlPh/mapsUrlHint/address` (residue dopo il dedup delivery).
- Cleanup C+D fatto con script line-based (dedup per blocco-lingua); A+B con edit mirati. Verificato preview: slotDurationTitle traduce per lingua, DE zoneOuter risolve il simbolo valuta. Re-audit chiavi mancanti: NONE.
- Audit non ha trovato bug critici backend; register pulito; gli "orfani" getElementById sono elementi creati a runtime.

## ✅ FATTO (2026-06-21 — fix "auth not defined" + colonne tab prodotti = Excel)

- **Bug "auth not defined"** (creazione prodotto / qualsiasi 401): `login()` chiamava `api('/admin/login','POST',{...}, false)` con un 4° arg, ma `api()` aveva solo 3 parametri → dentro `if (res.status===401 && auth)` la var `auth` era undefined → ReferenceError su ogni risposta 401 (residuo della migrazione a cookie HttpOnly). Fix: aggiunto `auth = true` come 4° parametro di `api()` (`public/admin/index.html`). Login passa `false` → 401 mostra "credenziali errate"; chiamate autenticate → 401 fa logout.
- **Colonne tab prodotti riordinate per matchare l'Excel**: ora `Producto, Categoría, Descripción, Precio ({cur}), Stock, SKU, Estado, Acciones` (era Producto, SKU, Categoría, Precio, Stock, Estado, Acciones — ordine diverso, SKU fuori posto, niente descrizione). Aggiunta **colonna Descripción** (troncata `hidden lg:table-cell`, testo completo nel `title` + nel modal di modifica). i18n `products.col.description` + `products.col.sku` in 6 lingue.
- Verificato preview: header e righe 8 colonne allineate nell'ordine dell'Excel; prezzo `$12.50` con account USD; `api.length===4`.

## ✅ FATTO (2026-06-21 — fix valuta header: Gs nei prodotti, $ nell'incasso)

Bug: stesso account, prezzi prodotti con header "Precio (Gs)" ma incasso in "$". Causa: in `showDashboard` (`public/admin/index.html`) `applyTranslations()` girava PRIMA di `TENANT_CURRENCY = settings.plan_currency` → i token `{cur}` (header prezzo) risolvevano col default PYG; le celle + l'incasso (renderizzati dopo) usavano la valuta vera → mismatch. Fix: setto `TENANT_CURRENCY` prima di `applyTranslations` (rimossa l'assegnazione duplicata più sotto). Ora header, celle e incasso usano tutti la valuta dell'account.

## ✅ FATTO (2026-06-21 — coerenza colonne prodotti/menu + SKU + valuta)

Allineate le colonne prodotti (shop) e menu (ristorante) tra tabella UI, template Excel, import e export CSV; nomi i18n e prezzo per valuta account.
- **Valuta prezzo**: i label prezzo prodotti usavano già `{cur}` (currency-aware via applyTranslations). Mancava solo `menu.col.price` (era "Precio" senza valuta) → aggiunto `{cur}` in 6 lingue; in `renderMenu` l'header è JS-injected quindi sostituisco `{cur}` con `CURRENCY_SYMBOL_MAP[TENANT_CURRENCY]`. Verificato preview: prodotti+menu → €/$/Gs secondo account.
- **SKU shop ovunque**: era solo nel modal/tabella, mancava in template/import/export.
  - `scripts/gen-templates.js`: colonna `sku` nel catalogo (name, category, description, price, stock, sku, available) + esempi + istruzioni EN/ES. Rigenerati xlsx.
  - `routes/admin.js` import-preview: alias `sku`/`codigo`/`code` + campo riga. import-confirm shop: `sku` inserito (null per menu). products/export shop: colonna `sku` (round-trip pulito col template).
- Menu resta: name, category, description, allergens, price, available (no stock/sku) — coerente tra tabella/template/import/export.
- Confermato: prezzo nelle celle già currency-aware (`fmtPrice` + `CURRENCY_SYMBOL_MAP`); l'header prodotti mostra "Gs" solo se l'account è PYG (corretto), "$"/"€" per USD/EUR.
- Nota: la tabella prodotti non mostra la colonna `description` (testo lungo, visibile nel modal) — gli altri campi combaciano con template/import/export.

## ✅ FATTO (2026-06-21 — fix UX register: back nav, prefisso tel, copy trial)

Commit 211f95e (`public/register/index.html` + `i18n.js`):
- **Back bloccato**: `goStep` validava SEMPRE lo step corrente → "← Atrás" da step2 senza nome bloccato. Fix: valida solo in avanti (`if (n > currentStep() && !validateStep(...))`).
- **Telefono**: campo testo libero ("código de país, sin +") → `<select id="phonePrefix">` dial-code (pre-compilato dal paese dello step1 via `syncPhonePrefix`/`data-cc`) + input solo cifre. `validateStep(3)` unisce prefisso+locale (toglie junk e trunk-0), rifiuta locale fuori 6–12 cifre. `formData.phone` = numero internazionale senza +.
- **Step4 copy**: tolto il falso "Sin tarjeta ahora" (la carta si inserisce subito dopo) → "prueba gratis, no se cobra durante la prueba, cancelás cuando quieras". 6 lingue (`s4.sub`).
- i18n `s3.phone.label/placeholder`, `s4.sub`, `js.err.phone` in 6 lingue.
- Confermato: register usa **email come username** (`login_slug=email` in register.js) + `merchant_phone=phone` → il testo step3 è corretto; il campo username separato è in Ajustes (modificabile dopo).
- Verificato in preview: back step2→1 ok; PY→+595 auto; `0981-123-456`→`595981123456`; copy step4 aggiornata.

## ✅ FATTO (2026-06-21 — fix pagina bianca admin + hook pre-commit anti-white-page)

- **Pagina bianca** (`https://sarabot.pro/admin/index.html` tutto bianco): doppia dichiarazione `const curSym` nella stessa funzione `applyTranslations()` (`public/admin/index.html`, dal lavoro currency concorrente) → `SyntaxError: Identifier 'curSym' has already been declared` → l'intero script inline non parsava → UI vuota. Rimosso il 2° blocco `{cur}` ridondante (il primo già sostituisce `{cur}` in data-i18n/-ph). Commit 5cf75a4.
- **Prevenzione**: nuovo `scripts/check-syntax.js` valida via `new Function` i file UI serviti al browser (i18n.js admin/register + script inline di `public/{admin,register,superadmin}/index.html`) e fallisce al primo errore. Cablato come `.githooks/pre-commit` con `git config core.hooksPath .githooks`; salta se `node` assente. Anche `npm run check`. Commit cbdff33.
- ⚠️ **Attivazione su clone nuovo**: il pre-commit gira solo se `core.hooksPath=.githooks` è settato in `.git/config` (locale, non versionato). Su una clone fresca eseguire una volta: `git config core.hooksPath .githooks`. (Sessioni concorrenti sulla stessa working dir condividono già il config → coperte.)
- Pattern ricorrente da tenere d'occhio: sessioni concorrenti hanno introdotto 2 white-page in 2 giorni (apostrofo non escapato `un'email`, doppio `const curSym`). L'hook ora le blocca a monte.

## ✅ FATTO (sessione 2026-06-20 — dedup indirizzo/Maps nel delivery)

Indirizzo locale + link Google Maps erano ripetuti: una volta nella card "🏪 Mi negocio" e di nuovo nella sezione "Consegna a domicilio". Rimossi dal delivery (richiesta utente: tenerli solo in alto). Commit f813067.
- `public/admin/index.html`: tolti `sLocationAddress` + `sMapsUrl` (label/input/hint) dalla sezione delivery. `saveDelivery` non invia più `location_address/location_lat/location_lng`; il load non li setta più.
- Fonte unica ora: card "Mi negocio" → `sAddress`→`address` (usato da Sara nel prompt: `tenant.address`) + `sBizMapsUrl`→`location_lat/lng` (usati per il calcolo distanza consegna in webhook/geo).
- `location_address` (colonna) non era usata da bot/backend → ora vestigiale, nessun impatto. Dati coord esistenti preservati (bizinfo li carica). Nessun ref orfano; script inline pulito.
- Chiavi i18n `settings.delivery.address/mapsUrl*` ora inutilizzate (lasciate, innocue).

## ✅ FATTO (sessione 2026-06-20 — settings accordion + bug fixes + Sara type-awareness)

### Settings panel → accordion collassabile (commit 5fcd0ea + 6685247)
- `#sectionSettings` ristrutturato: da griglia 2 colonne a stack di 5 accordion per scopo.
- Gruppi: 🤖 Asistente (apertura default) | 🏪 Mi negocio (apertura default) | 💰 Pagos y envíos (chiuso) | 👤 Mi cuenta (chiuso) | 💳 Plan y facturación (chiuso).
- Danger zone spostata da tab Support → dentro accordion "Mi cuenta".
- `deliverySection` ora dentro accordion "Pagos y envíos" (JS show/hide invariato).
- `toggleAccordion(id)`: toggling `hidden` + rotazione chevron via inline style.
- i18n: chiavi `settings.acc.bot/business/orders/account/plan` in ES/EN/IT/DE/FR/PT.
- **Bugfix chevron**: accordions aperti avevano chevron puntato down (sbagliato) — fixato con inline `style="transform:rotate(180deg)"` sugli aperti, rimosso classe `rotate-180` dai chiusi.

### Bug: restaurant + appointments_enabled → appointment slots caricati per ristorante (commit 6685247)
- `routes/webhook.js`: `mightBeAboutAppointments` ora aggiunge `&& !tenant.restaurant_enabled`. Ristoranti usano il sistema `RESERVATION`, non `APPOINTMENT` — i due blocchi non si sovrappongono più.

### Sara — business-type awareness (commit 6685247)
- `services/claude.js` `buildStaticSystemPrompt`: nuovo blocco `bizTypeBlock` iniettato subito dopo "IDENTIDAD Y CARÁCTER".
- Calcola `hasProducts/hasServices/hasAppointments/hasRestaurant/hasDelivery` da flags tenant.
- Produce `TIPO DE NEGOCIO` + `LO QUE PODÉS HACER` + `LO QUE NO PODÉS OFRECER` → Sara non proporrà mai prenotazione tavolo a cliente di centro estetico, né cita di servizi a cliente di ristorante.

## ✅ FATTO (sessione 2026-06-20 — fix tab ristorante + bizinfo maps + phone confirm)

### Tab visibilità per tipo account
- `applyTabVisibility()`: Services tab SEMPRE nascosto per account ristorante. Appointments tab mostrato per ristorante (rinominato Prenotazioni). `apptCapacityRow` nascosto per ristorante, visibile solo per piani appuntamenti.

### Bizinfo — campo Maps URL
- Nuova card bizinfo: campo `sBizMapsUrl` estrae lat/lng via `parseMapsUrl()` e salva su `saveBusinessInfo()`. `loadSettings()` popola da `location_lat/lng`. i18n in 6 lingue.

### Phone merchant — conferma via email
- Numero WhatsApp non modificabile liberamente. `POST /admin/request-phone-change` (rate-limit 5/h) → email con link → `GET /admin/confirm-phone-change?token=`. `window.onload` gestisce `?confirm_phone=TOKEN`. `sendPhoneChange()` in mailer.js.
- **⚠️ MIGRATION 14 DA ESEGUIRE su Supabase**:
  ```sql
  ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS pending_merchant_phone TEXT,
    ADD COLUMN IF NOT EXISTS phone_change_token     TEXT,
    ADD COLUMN IF NOT EXISTS phone_change_expires   TIMESTAMPTZ;
  ```

## ✅ FATTO (sessione 2026-06-20 — griglia disponibilità + walk-in quick block)

Griglia disponibilità multi-giorno nel pannello prenotazioni + modal walk-in per occupare mesas senza inserire una prenotazione completa.
- `GET /restaurant/availability`: endpoint server che restituisce slot liberi per 1/3/7/14 giorni; replica la logica `_freeTablesAt` (rispetta `table_ids`, ignora cancelled/done/no_show/pending senza tavolo).
- `POST /restaurant/reservations`: ora accetta `status=seated` per inserimento walk-in diretto.
- Frontend: card "griglia disponibilità" (`#availGrid`) con `<select id="availDays">` 1/3/7/14; `loadAvailGrid()` fetcha + renderizza. Modal `#blockModal` ("Ocupar mesas sin reserva"): `openBlockModal()` / `refreshBlockTables()` (mostra solo tavoli liberi all'ora scelta) / `saveBlock()` inserisce `status=seated`, `customer_name=Walk-in`.
- i18n: `avail1/3/7/14`, `availLegend`, `availClosed`, `blockBtn/Title/Desc/Tables/TablesHint/NoFree/Save`, `walkin` in 6 lingue.

**White page investigazione chiusa**: causa era apostrofo non escapato `un'email` in i18n.js IT (commit 7281fba). Già fixato da f38cb44. Nessuna azione richiesta.

⚠️ **Fix collisione (post 6e96498)**: il commit della griglia usava `id="blockModal"` + funzioni `openBlockModal/closeBlockModal/saveBlock` GIÀ esistenti per il modal "blocco orario" degli appuntamenti → doppio id + funzioni duplicate (vinceva quella appuntamenti → modal walk-in rotto). Rinominati walk-in in `id="walkinModal"` + `openWalkinModal/closeWalkinModal/saveWalkin/refreshWalkinTables`. La griglia slot ora chiama `openWalkinModal`. Verificato: 1 solo `blockModal` (appuntamenti) + 1 `walkinModal`, script inline senza errori.

## ✅ FATTO (sessione 2026-06-20 — pannello "Mesas libres" per il merchant)

Il merchant ora vede quanti tavoli (e di che capienza) sono liberi a una certa ora.
- `public/admin/index.html`: nuova card nella vista Prenotazioni (`reservationsView`) con `<input type="time" id="resvAvailTime">` + `#resvAvail`. `renderAvailability()` calcola lato client da `_rTables` (capienze) e `_rReservations` (cache giornaliera): un tavolo è occupato se una prenotazione attiva che lo include (`table_ids`/`table_id`) copre l'istante scelto. Cancelled/no_show/done e i **pending (senza tavolo) non contano**.
- Output: numero tavoli liberi + coperti totali + breakdown per capienza (`2×4p · 1×6p`) + chip verdi (liberi) / rossi barrati (occupati). Si aggiorna a ogni `loadReservations()` e al cambio ora.
- i18n: `restaurant.availTitle/availHint/availFree/availSeats` in 6 lingue.
- Test: A(single)+B,C(multi) occupate alle 20:30, pending 8p ignorato → libero solo M4(6p).

## ✅ FATTO (sessione 2026-06-20 — multi-tavolo + pending NON blocca)

⚠️ **MIGRATION 13 DA ESEGUIRE su Supabase** (`db/migrations.sql`):
```sql
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS table_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE reservations SET table_ids = jsonb_build_array(table_id)
  WHERE table_id IS NOT NULL AND (table_ids IS NULL OR table_ids = '[]'::jsonb);
```

Regola definitiva utente: **una prenotazione non confermata NON blocca il locale** (un pending da 100 coperti non deve congelare tutto). Solo prenotazioni con **tavoli assegnati** bloccano. Supporto **multi-tavolo** (unione tavoli per gruppi grandi).
- Schema: nuova colonna `reservations.table_ids` JSONB = TUTTI i tavoli occupati; `table_id` resta primario/display. Backfill da `table_id`.
- `services/stock.js`: `getUpcomingReservations` seleziona anche `table_ids`.
- `services/claude.js`: rimosso `pendingNeed`/`maxCap`. `_occupiedTables(r)` = `table_ids` o `[table_id]` o `[]` (pending). `_freeTablesAt` blocca solo i tavoli occupati → pending (nessun tavolo) non incide. Griglia disponibilità invariata nel formato.
- `routes/webhook.js`: assegnazione usa `occupied(r)` (pending non blocca); insert salva `table_ids:[tableId]` (o `[]` se pending/escalate).
- `routes/admin.js`: `normTableIds()` — POST/PUT `/restaurant/reservations` accettano `table_ids` (array, dedup), `table_id`=primo. PUT sincronizza entrambi.
- Frontend (`public/admin/index.html`): modal `resvModalTable` ora `<select multiple>` + hint; `_rReservations` cache per prefill in edit; `openResvModal` precompila e preseleziona tavoli; `saveResv` invia `table_ids`; lista mostra `Mesa X +N`. i18n `restaurant.resvTableHint` in 6 lingue.
- **Bugfix collaterale**: i18n.js riga IT `usernameCheckEmail` aveva apostrofo non escapato (`un'email`) → rompeva TUTTO il file TR (sintassi JS). Corretto `un\'email`.
- Test logica: pending 100p → 4 tavoli liberi; confermata `[A,B]` → 2 liberi; legacy single → 3 liberi.
- **Limite residuo**: il webhook auto-assegna sempre 1 tavolo (gruppi grandi → merchant che unisce manualmente i tavoli dal pannello). Sara non auto-unisce tavoli.

## ✅ FATTO (sessione 2026-06-20 — disponibilità conservativa per gruppi pending) [SUPERATA dalla entry sopra]

Buco: prenotazioni `pending_merchant` (table_id null, es. gruppo grande in attesa di unione tavoli) NON bloccavano alcun tavolo → griglia/assegnazione sovrastimavano la disponibilità.
- `_freeTablesAt` (`services/claude.js`) + loop assegnazione (`routes/webhook.js`): i gruppi non assegnati che si sovrappongono allo slot ora consumano `ceil(party_size / maxCap)` tavoli (`maxCap` = tavolo più grande). `free = tavoliLiberiDiretti − pendingNeed`.
- Test: 4 tavoli da 4; gruppo 7p pending alle 20:00 → liberi=2 (4−ceil(7/4)); fuori sovrapposizione=4. Scenario "4 prenotazioni da 2p" → 1 tavolo libero (1 tavolo per party, corretto, niente posti condivisi).
- **Limite residuo**: il modello ha UN solo `table_id` per prenotazione. L'unione fisica di 2 tavoli per un gruppo grande è contabilizzata (pendingNeed) finché lo stato è `pending_merchant`, ma quando il merchant conferma assegnando un singolo `table_id` il 2° tavolo unito torna "libero" → serve supporto multi-tavolo (array `table_ids` + UI multi-select) per bloccarli entrambi con precisione. DA DECIDERE con l'utente.

## ✅ FATTO (sessione 2026-06-20 — gruppi grandi → merchant + disponibilità reale a Sara)

### 1. Gruppo troppo grande → escala al merchant (`routes/webhook.js`)
- Se `party_size` > capacità di OGNI tavolo singolo → `escalate=true` (prima rifiutava come "full"). Ora inserisce `pending_merchant` + notifica WhatsApp al titolare ("Reserva grupo grande — requiere tu atención") per coordinare l'unione tavoli. Vale sia se Sara marca `pending_merchant` sia come fallback se non l'ha fatto.
- Distinzione: tavoli **idonei ma tutti occupati** → `full` (rifiuto + proponi altro orario); **nessun tavolo abbastanza grande** → `escalate` (merchant).

### 2. Sara propone solo orari realmente disponibili (`services/claude.js`)
- Nuovo `buildAvailabilityBlock(tenant, tables, reservations, mealBands, businessHours, closures)`: griglia "DISPONIBILIDAD REAL DE MESAS" per i prossimi 7 giorni aperti. Per ogni giorno/franja genera gli slot (`_genSlots`, passo = `restaurant_slot_duration`) e per ognuno conta i tavoli liberi (`_freeTablesAt`, overlap su durata). Formato compatto: `19:30(2) 21:00(✗) 22:30(1)`.
- Salta giorni in chiusura (closures) e giorni `is_closed`. Se nessun tavolo configurato → fallback a `buildReservationsBlock`.
- Regola critica nel prompt: proporre/confermare SOLO slot con numero ≥1; mai un `✗` o un orario non in lista. Regole statiche R2/R4 + large-group riscritte per puntare alla griglia.
- `buildDynamicSystemPrompt` + `chat()` ora passano `restaurantTables`.
- Limite: griglia non filtra per capacità del party (mostra tavoli liberi totali); Sara abbina la taglia, il backend valida comunque overlap+capacità all'insert.

## ✅ FATTO (sessione 2026-06-20 — fix doppia prenotazione ristorante)

Bug: Sara (path cliente) prendeva prenotazioni infinite. `routes/webhook.js` blocco reservation auto-assegnava il tavolo libero più piccolo, ma **se tutti i tavoli erano occupati `table_id` restava null e inseriva comunque `confirmed`** → overbooking. Inoltre `upcomingReservations` poteva essere `null` (caricato solo su keyword match) → check conflitto saltato → doppia assegnazione.
- Fix: nel handler ora **re-fetch fresco** `getUpcomingReservations(tenant.id, 90)` (finestra 90gg, non i 7 cached) → niente race/staleness; se **nessun tavolo idoneo libero** nella finestra (slot duration overlap) → `full=true`, **NON inserisce** e spinge `[SISTEMA]` per far scusare Sara e proporre altro orario/data (stesso pattern degli appuntamenti out-of-band → correzione al turno successivo).
- Tavolo assegnato resta bloccato per la sua fascia (overlap reqStart<rEnd && reqEnd>rStart su `restaurant_slot_duration`). Manuale (merchant `POST /restaurant/reservations`) invariato = override volontario consentito.
- Limite noto: la conferma ottimistica di Sara parte comunque quel turno (reply generato prima del guard); il [SISTEMA] corregge al messaggio dopo. Per eliminarlo servirebbe override del reply con lingua cliente (non disponibile in scope) — coerente col comportamento appuntamenti già esistente.

## ✅ FATTO (sessione 2026-06-20 — branding sarabot.pro su tutti i download)

Regola: **form vuoti** (template xlsx) = con istruzioni; **form con dati** (export) = solo dati, CSV reimportabile. Tutti i file esportati portano il riferimento a sarabot.pro nei metadati.
- **Template** (`scripts/gen-templates.js`): aggiunta `brand(wb,title)` → metadati workbook `creator=SaraBot`, `company=sarabot.pro`, `subject/keywords=sarabot.pro`, `description=https://sarabot.pro`. Fogli istruzioni EN ("Instructions") + ES ("Instrucciones") **mantenuti**. Rigenerati i 2 xlsx.
- **Export CSV** (`toCsv` in `routes/admin.js`): ora antepone una riga metadati `# SaraBot — sarabot.pro — exported <data>` dopo `sep=;`. Solo dati, niente istruzioni. Vale per products/menu, services, orders, customers.
- **Import** reso robusto: salta `sep=;` + qualunque riga `#...` (metadata) prima di trovare l'header; delimiter auto-detect dopo lo skip. **Round-trip testato**: export (con `;`, `#` meta, campi virgolettati contenenti `;`/`,`) → reimport ricostruisce i dati correttamente.
- `exceljs` resta devDependency (serve solo al generatore template; export sono CSV, runtime non lo importa).

## ✅ FATTO (sessione 2026-06-20 — template import/export separati + CSV a colonne)

### Due template separati (catalogo vs menu)
- Generati 2 file: `public/catalog_template.xlsx` (shop: name/category/description/price/stock/available) e `public/menu_template.xlsx` (ristorante: name/category/description/**allergens**/price/available — niente stock). Header in **inglese**.
- Ogni file ha 2 fogli istruzioni: **"Instructions"** (EN) + **"Instrucciones"** (ES), stesso contenuto, aggiornato (come compilare, available Yes/No, prezzo numero senza simbolo, non rinominare header, allergeni separati da virgola solo menu, foto via ZIP, dedup per nome).
- Generatore: `scripts/gen-templates.js` (exceljs, dropdown Yes/No, freeze header, autofilter). `npm run gen-templates`. `exceljs` aggiunto a devDependencies (NON serve a runtime — il route fa solo `res.download` del file statico).
- `routes/admin.js` `GET /admin/catalog-template`: ora **branch su `restaurant_enabled`** → ristorante scarica menu_template, altri catalog_template.
- Frontend: `#importCsvColumnsHint` mostra colonne corrette per shop / menu / servizi.

### Export CSV → si apre in colonne (era tutto in una colonna)
- Nuovo helper `toCsv(headers, rows)` in `routes/admin.js`: delimitatore **`;`** + prima riga **`sep=;`** → Excel (anche locale ES/IT) splitta nelle colonne. BOM mantenuto. Quote su `;`/`"`/newline.
- `products/export` ora **restaurant-aware** (colonne = template menu o catalogo) + `services/export` + `orders/export` + `customers/export` usano `toCsv`. Colonne export = colonne template → **round-trip pulito** al re-import.
- Import reso delimiter-aware: `parseCSVLine(line, delim)`; import-preview rileva `sep=;` e auto-detect `;` vs `,` (export nostro = `;`, Google Sheets = `,`). Aggiunta colonna **allergens** al parsing. Stock importato `null` (non 0) quando colonna assente; import-confirm forza `stock_qty=null` per tenant ristorante.
- Round-trip testato: export `;` con campo contenente `;`/`,` virgolettato → re-import parser lo ricostruisce correttamente.

## ✅ FATTO (sessione 2026-06-20 — UX redesign pannello admin)

UX redesign 10-punti completato e verificato in preview (static server `public/` su :4100, eval + snapshot + resize mobile).

1. **Merge ❓ Ayuda → 💬 Soporte** — tab unico "Ayuda y Soporte". `renderHelp()` ora rende in `#helpContent`, blocco **collassabile** in cima a `#sectionSupport` (`toggleHelpPanel()`, chevron ▾ rota). `#tabHelp` + `#sectionHelp` standalone rimossi. Tolto `'help'` da array switchTab + applyTranslations. Label tab via nuova chiave `tab.support` (6 lingue).
2. **Merge 💳 Plan → ⚙️ Ajustes** — le 3 card plan (stato, gestión Stripe, promo) spostate dentro `#sectionSettings` sotto header `plan.section.title` "💳 Plan y facturación"; `loadPlan()` chiamato in `switchTab('settings')`. `#tabPlan` + `#sectionPlan` rimossi; tolto `'plan'` da switchTab/LOCKED_TABS/applyTranslations. Banner piano scaduto → `switchTab('settings')`.
3. **Larghezza**: `#sectionSupport` + `#sectionAnalytics` `max-w-2xl` → `max-w-6xl`.
4. **Chat support**: container più alto (`calc(100vh-18rem)`, min 360px), bolle `max-w-[75%]` usano la larghezza, font bolle `text-base`, input `text-base` + bottone `px-5 py-3`.
5. **Font / tap target**: tab buttons `py-2`→`py-2.5`; titoli/input support `text-sm`→`text-base`.
6. **Mobile** (375px): nessun overflow orizzontale, tab bar scrolla (overflow-x-auto), sezioni fit. Verificato.
7. **i18n 6 lingue**: nuove chiavi `tab.support`, `support.guideTitle`, `plan.section.title` in ES/EN/IT/DE/FR/PT. `tab.help`/`tab.plan` ora inutilizzate (lasciate, innocue).
8. **Grep sicurezza**: zero ref orfani a `tabHelp`/`tabPlan`/`sectionHelp`/`sectionPlan`/`'help'`/`'plan'` in index.html.
9. **Test preview**: desktop + mobile, tenant ristorante (Menù/Prenotazioni relabel OK) e non — zero errori JS su tutti i tab.
10. Commit + push + MD aggiornato.

**Nota infra**: aggiunta config `admin-static` in `.claude/launch.json` (npx serve public :4100) per preview statico del pannello.

## ✅ FATTO (sessione 2026-06-20 — superadmin inline rows + tab visibility fix)

### Superadmin — righe espandibili inline (commit 46449f1)
- Rimosso il pattern "✏️ Editar → modal". Ogni riga tenant ha ora un toggle **▼ Ver / ▲ Ocultar** che espande una riga di dettaglio inline (no modal).
- Dettaglio inline mostra: email, usuario/slug, merchant phone, bot phone, stato Meta.
- **Module toggles** (Productos / Servicios / Turnos-Citas / Restaurante) con bottone "💾 Guardar módulos" → chiama `PUT /superadmin/tenants/:id` per aggiornare i flag live. Restaurant toggle auto-abilita Productos+Turnos e disabilita Servicios (non esiste concetto servizi per ristorante).
- Azioni inline: Desactivar/Activar + Impersonar (no modal).
- `detailLoaded[id]` cache: il fetch tenant avviene una sola volta per espansione, non ripetuto.
- Modal HTML (`#editModal`) conservato come contenitore stub per le funzioni import legacy.

### Tab visibility coherence — causa radice + fix (commit 46449f1)
- **Root cause**: `POST /superadmin/tenants` non settava MAI `products_enabled/services_enabled/appointments_enabled/restaurant_enabled` → colonne rimanevano NULL nel DB → `products_enabled !== false` era `true` → tutti i tab visibili per qualsiasi piano.
- **Fix 1 — tenant esistenti**: module toggles nella riga espandibile permettono di correggere i flag senza SQL.
- **Fix 2 — nuovi tenant**: form "Registrar nuevo cliente" ora ha `<select id="nPlan">` (Shop / Bookings / Restaurant / Pro). `createTenant()` mappa il piano ai flag corretti e li manda nel POST. `routes/superadmin.js` `POST /tenants` ora accetta e persiste `products_enabled/services_enabled/appointments_enabled/restaurant_enabled` + `plan_currency/plan_expires/plan_price`.

## ✅ FATTO (sessione 2026-06-20 — piano via Stripe + superadmin read-only)

### Piano = tab visibili = comportamento bot (commit ed1dd3d)
- **Concetto "moduli" eliminato** — esistono solo 4 piani (Shop/Bookings/Restaurant/Pro) che determinano i flag booleani nel DB, che a loro volta determinano le tab visibili al merchant e il comportamento di Sara.
- `PLAN_FLAGS` in `routes/billing.js` — mappa piano → flag DB, condivisa tra webhook e change-plan route.
- **`POST /billing/change-plan`** — merchant può fare upgrade/downgrade. Chiama Stripe (`subscriptions.update` con nuovo `price`, `proration_behavior: 'always_invoice'`, metadata `plan`), aggiorna immediatamente i flag nel DB senza attendere il webhook.
- **Webhook `customer.subscription.updated`** — ora legge `metadata.plan` e aggiorna i flag se presente. Copre anche rinnovi/cambi Stripe-side.
- **Admin panel "💳 Plan y facturación"** — nuova sezione "Cambiar de plan" con 4 card (Shop/Bookings/Restaurant/Pro). Piano attuale evidenziato e disabilitato. Visibile solo con Stripe sub attiva. i18n 6 lingue.
- **Superadmin** — dropdown piano rimosso dalle righe. Il piano è read-only (badge testo). Il superadmin non gestisce più il piano; lo fa il merchant via Stripe. Le righe mostrano: nome+info+metaStatus | ordini | stato (toggle) | piano badge + Desact. + Impersonar.

## ✅ FATTO (sessione 2026-06-21 — unificazione orari + walk-in ristorante)

### Business hours unificati (commit 95edbcb)
- `business_hours` è ora l'unica fonte di verità per orari, sia ristorante che non-ristorante.
- **Orario spezzato**: nuove colonne `open_time_2`/`close_time_2` su `business_hours` per turni doppi (es. 12-15 e 19-23).
- **Migration richiesta (ESEGUIRE su Supabase)**:
  ```sql
  ALTER TABLE business_hours ADD COLUMN IF NOT EXISTS open_time_2 TIME;
  ALTER TABLE business_hours ADD COLUMN IF NOT EXISTS close_time_2 TIME;
  ```
- `restaurant_meal_bands` rimosso completamente da `routes/admin.js`, `routes/webhook.js`, `services/claude.js`, `public/admin/index.html`.
- `routes/admin.js` `PUT /business-hours`: salva anche `open_time_2`/`close_time_2`. `GET /availability` usa entrambi i slot. `PUT /restaurant/settings`: rimossa validazione bande, rimossa colonna `restaurant_meal_bands`.
- `routes/webhook.js` reservation time check: usa `open_time`/`close_time` + `open_time_2`/`close_time_2` invece di meal bands.
- `services/claude.js` `buildAvailabilityBlock`: rimosso parametro `mealBands`, usa bh slot 1+2. `buildRestaurantStaticBlock`: rimosso parametro `mealBands`.
- Frontend: sezione orari + chiusure ora stacked verticalmente (era `md:grid-cols-2` che causava overlap). Ogni giorno ha pulsante `+ turno` per 2° slot opzionale. `saveBusinessHours` invia `open_time_2`/`close_time_2`. Rimossa card "Franjas de servicio" dal tab Tavoli + tutte le funzioni `renderMealBands/addMealBand/saveMealBands`.

### Walk-in modal redesign (commit f813067 + 21a0f43)
- **"Occupa tavolo"**: modal non mostra più ID interni. Raggruppa tavoli liberi per (capacità, zona) con contatore `+/-`. Il merchant seleziona "2 da 4 pers. — Zona A", sistema assegna IDs automaticamente. `party_size` calcolato automaticamente.
- **"✓ Libera"**: bottone verde su ogni prenotazione `seated` → setta status a `done` → tavolo torna disponibile nella griglia Sara. Funziona per walk-in registrati con "Occupa tavolo" (non per occupazioni fisiche non registrate).
- **Migration richiesta (ESEGUITA)**:
  ```sql
  ALTER TABLE reservations DROP COLUMN IF EXISTS table_ids;
  ALTER TABLE reservations ADD COLUMN IF NOT EXISTS table_ids BIGINT[];
  ```
  (`restaurant_tables.id` è BIGINT, non UUID.)

### Fix date locale (commit 89ab29c + bf31e50)
- `localDateStr(d)` helper usa `getFullYear/Month/Date` (locale browser, non UTC) — elimina bug "data di ieri" per timezone UTC+2.
- Applicato a: `initReservationsView`, `openWalkinModal`, `openResvModal`, `apptDate`.
- Avail grid: mostra hint "Nessun orario configurato → Impostazioni" quando `business_hours` non configurati.

## ✅ FATTO (sessione 2026-06-21 — ristruttura tab ristorante + logica slot)

### Ristruttura tab Ristorante (commit dcec2a1 → d5b99a9)
- **Ordine tab Ristorante** (dall'alto): griglia tavoli liberi (sempre visibile) → accordion "⏱ Durata media tavolo" → accordion "🗺️ Zone e Tavoli".
- Griglia "tavoli liberi per fascia" spostata da tab Prenotazioni a tab Ristorante.
- Tab Prenotazioni: lista prenotazioni + "Occupa tavolo" + "+ Nuova prenotazione" nell'header.
- Accordion Zone+Tavoli chiuso di default (config set-and-forget).
- `loadRestaurant()` carica business-hours per rilevare se esiste orario spezzato → mostra/nasconde campo "Fascia 2 (min)" automaticamente. Nessun toggle manuale.
- `loadRestaurant()` chiama `loadAvailGrid()` → griglia si carica quando si apre il tab.

### Status prenotazioni in italiano / lingua sistema (commit f4cadc5)
- Nuove chiavi `resv.status.*` (pending_merchant/confirmed/seated/done/cancelled/no_show) in ES/EN/IT/DE/FR/PT in `i18n.js`.
- Dropdown status usa `t('resv.status.' + s)` — segue lingua pannello.

### Durata tavolo per fascia + logica overlap corretta (commit 006c85e → d5b99a9)
- `restaurant_slot_duration_2` aggiunto a `tenants` (**migration da eseguire**):
  ```sql
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS restaurant_slot_duration_2 INTEGER;
  ```
- `GET /restaurant/availability`: window 1 usa `dur1`, window 2 usa `dur2` (fallback `dur1` se non configurato).
- `freeAt` in admin.js e `_freeTablesAt` in claude.js: overlap tollerato se ≤10min su entrambi i lati (`Math.min(re,b) - Math.max(rs,a) > CLEAN_MS`). Prima qualsiasi overlap bloccava lo slot.
- `buildAvailabilityBlock` in claude.js: usa `dur1`/`dur2` per finestra; Sara propone solo slot realmente liberi per la fascia corretta; giorni chiusi/closure già saltati.
- Webhook reservation: rileva se l'orario cade in window 2 → salva `duration_min` corretto; overlap check con CLEAN_MS.
- Warning confirm() prima di cambiare durata (6 lingue) — le prenotazioni esistenti mantengono il loro `duration_min` ma la nuova durata cambia come vengono calcolate le sovrapposizioni.
- Prenotazioni fuori orario (inserite manualmente dal merchant) restano valide — è override consapevole, non un bug da correggere.

## ✅ FATTO (sessione 2026-06-21 — slot ristorante + i18n delivery)

### Durata slot unica (commit 8e671c1)
- Rimosso concetto `restaurant_slot_duration_2` — un'unica durata per tutte le fasce di tutti i giorni.
- Motivo: slot 1/slot 2 sono posizioni strutturali (prima/seconda finestra del giorno), non semantiche. Con orari che attraversano mezzanotte (sabato 00:00–03:00) il mapping era invertito e confuso.
- `routes/admin.js`: rimosso `dur2` da `GET /restaurant/availability` e `PUT /restaurant/settings`; tutti i window usano `dur1`.
- `services/claude.js`: rimosso `dur2`; `buildAvailabilityBlock` usa `dur1` per tutti i window; `durNote` semplificato.
- `routes/webhook.js`: rimossa logica `inW2` + `dur2`; reservation usa `tenant.restaurant_slot_duration || 90` direttamente.
- `public/admin/index.html`: rimossa riga "Slot 2 (min)", rimosso `restDur2Row`; `saveRestaurantSettings` invia solo `restaurant_slot_duration`.
- **Migration non più necessaria**: `tenants.restaurant_slot_duration_2` non viene né scritta né letta — colonna vestigiale innocua, ignorabile.

### Fix label giorno domenica (commit 5621b69)
- Label "Durata media tavolo" in tab Ristorante prendeva domenica (day_of_week=0, prima in array) come riferimento.
- Fix: `loadRestaurant` ora preferisce primo giorno feriale con apertura ≥ 06:00.
- Rimosso `toMin(s, isEnd)` (era modifica parziale non completata) → ripristinato `toMin(s)`.

### i18n giorni tavoli liberi (commit 7f2aec6)
- `renderAvailGrid()`: `WD` array era hardcoded in spagnolo (`['dom','lun',...]`).
- Fix: `WD` usa `t('day.sun')…t('day.sat')` — chiavi già presenti in tutte e 6 le lingue.

### Fix valuta labels consegna + step input (commit ed4d322)
- `applyTranslations()`: i18n keys delivery contenevano `{cur}` mai sostituito → appariva letteralmente `((cur))`.
- Fix: `applyTranslations` sostituisce `{cur}` con `CURRENCY_SYMBOL_MAP[TENANT_CURRENCY]` in tutti i `data-i18n` e `data-i18n-ph`.
- Input delivery (`sDeliveryBaseFee/MinOrder/ZoneOuterFee/PerKm`): `step=1` per valute intere (PYG/CLP/COP), `step=0.01` per le altre — settato in `loadSettings()` dopo che `TENANT_CURRENCY` è noto.

## ✅ FATTO (sessione 2026-06-21 — audit Sara bot cross-plan)

### Audit completo Sara bot — bug trovati e fixati (commit 5fc0419, 610e25a, c983610)

**Valuta hardcoded nel dynamic prompt (claude.js):**
- `buildDynamicSystemPrompt`: delivery min order, fee calc, active order total usavano `toLocaleString('es-PY') Gs` — ora `formatPrice(v, currency)` per tutti i piani.
- Appointment pricing in slots block usava `toLocaleString('es-PY')` — ora `formatPrice(s.price_guarani, currency)`.

**Valuta hardcoded nel webhook (webhook.js):**
- `price_updated` template merchant: `p.toLocaleString() Gs` → `formatPrice(p, currency)` (accetta terzo param `cur`).
- Catalog list merchant: `p.price_guarani.toLocaleString() Gs` → `formatPrice`.
- Orders total merchant: `total.toLocaleString() Gs` → `formatPrice`.
- Services list merchant: `s.price_guarani.toLocaleString() Gs` → `formatPrice`.
- System note delivery fee (iniettato in history Sara): `toLocaleString('es-PY') Gs` → `formatPrice`.
- Messaggio cliente dopo location: era spagnolo con `Gs` hardcoded → semplificato a formato neutro `${km} km — 🚚 ${formatPrice(fee)}`.
- `handleMerchantMessage` e `handleCustomerMessage`: aggiunto `const currency = tenant.plan_currency || 'PYG'` all'inizio.

**Takeover:**
- Rimosso messaggio spagnolo hardcoded al cliente (`"En este momento te atiendo yo directamente 👋"`). Il merchant si presenta direttamente nella lingua del cliente.

**Dead code:**
- `claude.js:171`: variabile `price` mai usata (ternario identico su entrambi i branch, `priceStr` riga 172 era già corretta) → rimossa.

**Midnight slot gen (claude.js + admin.js):**
- `_hhmmToMin(s, isEnd)`: se `isEnd=true` e valore=0 (00:00) → ritorna 1440. `_genSlots` passa `isEnd=true` per end time.
- Stesso fix in `admin.js` `toMin(s, isEnd)` con `toMin(w.end, true)` nel loop slot.
- Fix: `close_time='00:00'` ora genera slot fino a mezzanotte invece di finestra vuota.

**Allergeni (claude.js):**
- Regola 16 aggiunta: se il piatto ha `⚠️ allergeni` nel catalogo → risponde con quelli. Se assente → "non ho quest'info, chiedi al locale". Mai inventa, mai assume "nessun allergene".

**Nessun bug logico per piano** trovato nel routing `hasProducts/hasServices/hasAppointments/hasRestaurant` — i guard webhook (`mightBeAboutAppointments && !restaurant_enabled`) sono corretti per tutti e 4 i piani (Shop/Bookings/Restaurant/Pro).

## ✅ FATTO (2026-06-21 — fix support bot + prodotti/menu/xlsx)

### Support bot — contesto chat [commit af54787]
- `SUPPORT_SYSTEM_PROMPT`: aggiunto blocco CONTEXT esplicito — il merchant parla DENTRO la tab Supporto, non deve essere indirizzato "alla chat di supporto" (era un loop confuso). Per tutto il non-risolvibile → `email support@sarabot.pro`.

### Prodotti/Menu — fix banner scorte + descrizione + xlsx coerenti [commit 2e5d4fe]
- **Banner "scorte basse ≤5" falso**: `toggleAvailable` mandava `stock_qty:1` quando abilitava un prodotto → scattava il banner. Fix: `toggleAvailable` invia solo `{ is_available: val }` — lo stock non viene toccato.
- **Descrizione tab menu**: cella `description` nella `renderMenu` non aveva `truncate` → testo lungo sfondava la riga. Aggiunto `truncate` + `title`. Aggiunto `maxlength=500` al textarea descrizione nel modal.
- **Nomi colonne xlsx**: header prima colonna era `name` per entrambi i template, mentre la UI mostra "Producto/Product/Prodotto" e "Plato/Dish/Piatto". Rinominato → `product` (catalog) / `dish` (menu). Aggiornati `gen-templates.js`, export CSV (`products/export`), import parser (alias ampliati: `product, dish, plato, piatto, plat, produkt, prodotto, produit`). Xlsx rigenerati.
- **stock=0 → available=false**: già implementato server-side nel PUT `/products/:id` (riga 528) — nessuna modifica necessaria.

### Webhook merchant — greeting + JSON parse [commit f25a4db]
- Action `greeting` aggiunta al classifier merchant: saluti (ciao, hola, hi…) non cadono più su `unknown`.
- JSON parse: strip ` ```json…``` ` prima del parse — alcuni modelli wrappano la risposta in un code block.
- `add_product` senza nome: ora chiede il nome del prodotto invece di rispondere "non capisco".

## STATO CORRENTE
- Obiettivo generale: SaaS multi-tenant WhatsApp Business (Node/Express + Supabase + Anthropic Claude). Bot AI risponde a clienti, gestisce catalogo, delivery, turni/appuntamenti, ordini.
- Fase attuale: hardening sicurezza completato. Prossimo: Stripe live env vars su Render, invoicing merchant.
- Ultimo commit stabile: `4fc8511`
- **Migration pendente**: nessuna nuova.
- **DB maintenance**: job pulizia `conversations` > 90 giorni inserito dall'utente (Supabase pg_cron). Non urgente.

## COSA È STATO FATTO (sessione 2026-06-20 — i18n hardcoded in Ajustes)

### Stringhe hardcoded in Settings → tradotte
- `public/admin/index.html`: card "👤 Perfil de WhatsApp del bot" (titolo, desc, "Foto de perfil", hint, "Elegir foto", "Descripción (About)", placeholder, "Actualizar perfil en WhatsApp") e blocco "🕐 Horarios del local" (titolo, desc, "Guardar horarios") erano hardcoded → aggiunti `data-i18n`/`data-i18n-ph`.
- **Bug attributo**: `closureLabel` e `offerLabel` usavano `data-i18n-placeholder` (attributo inesistente — applyTranslations cerca `data-i18n-ph`) → placeholder mai tradotti. Corretto in `data-i18n-ph` (le chiavi `settings.closures.label_ph`/`settings.offers.label_ph` esistevano già).
- `public/admin/i18n.js`: nuove chiavi `settings.wp.*` (8) + `settings.hours.*` (3) in ES/EN/IT/DE/FR/PT. Verificato in preview (switch IT → tutto tradotto).

## COSA È STATO FATTO (sessione 2026-06-20 — riscrittura prompt support bot)

### Support bot merchant — knowledge base aggiornata e precisa
- `routes/admin.js` `SUPPORT_SYSTEM_PROMPT` riscritto: era vago/datato (citava "Business Hours tab"/"Blocks tab" inesistenti, stock sui piatti, niente reservations/franjas/capacità/cierres/broadcast/ZIP).
- Nuovo prompt: regola "rispondi col percorso REALE passo-passo, label esatte tra virgolette, includi SEMPRE l'emoji del tab (uguale in ogni lingua), niente invenzioni — se non sai, escala". Knowledge allineata alla UI attuale: tutti i tab + bottoni reali verificati contro `index.html`/`i18n.js` (es. "+ Nuevo producto", "+ Nuevo ítem", "📥 Importar productos", "📦 Imágenes ZIP", "🕐 Horarios del local", "Citas en paralelo por horario", "Franjas de servicio", "Cantidad de mesas", "+ Nueva reserva", "🏖️ Cierres y Vacaciones", "¿Olvidaste tu contraseña?", "Conectar ahora", "Eliminar cuenta").
- Label canoniche in spagnolo (default); il bot le cita + traduce nella lingua del merchant; emoji tab per disambiguare cross-lingua.

## COSA È STATO FATTO (sessione 2026-06-20 — fix eliminazione account email/link)

### Email + link eliminazione account (feature sessione concorrente)
- **Link rotto — causa probabile: migration NON eseguita.** `request-deletion` salvava `account_deletion_token/expires` ma le colonne potrebbero non esistere su Supabase → token mai salvato → `confirm-deletion` non trova il tenant → "token inválido". **ESEGUIRE su Supabase:**
  ```sql
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS account_deletion_token   TEXT;
  ALTER TABLE tenants ADD COLUMN IF NOT EXISTS account_deletion_expires TIMESTAMPTZ;
  ```
- **Hardening** (`routes/admin.js` `request-deletion`): ora controlla l'errore dell'UPDATE → se fallisce ritorna 500 invece di mandare un link morto.
- **Email** (`services/mailer.js` `buildDeleteHtml`): bordo header rosso → verde `#22c55e` per coerenza con welcome/reset (il bottone resta rosso = danger). Logo `https://sarabot.pro/images/logosarabot.webp` OK (servito da `/images` → dir root `images/`).
- Nota: `APP_URL=https://sarabot.pro` — il reset password usa la stessa base e funziona, quindi la pagina è raggiungibile; il problema del link è il token/migration, non l'host.

## COSA È STATO FATTO (sessione 2026-06-20 — bugfix modal prodotto/piatto)

### Bug "+ Nuevo piatto/producto" non apriva il modal
- `openProductModal` → `clearImage()` faceva `document.getElementById('pImage').value=''` ma `#pImage` (vecchio campo URL immagine) era stato rimosso in una sessione passata → `clearImage`/`previewImage` avevano riferimenti orfani → throw "Cannot set properties of null" → modal mai aperto (sia ristorante che shop). Diagnosi riprodotta servendo `public/` e chiamando `openProductModal(null)` in preview.
- Fix: rimossi i 2 `getElementById('pImage')` orfani in `clearImage` e `previewImage` (`public/admin/index.html`). Verificato in preview: modal apre sia restaurant (allergeni visibili, stock/sku nascosti) sia shop (stock visibile).
- Pattern [[feedback-dom-js-sync]]: rimuovere i ref JS quando si elimina un elemento HTML.

### Polish modal piatto ristorante (commit d4ed093)
- Placeholder coerenti: tenant ristorante vede esempi piatto (`menu.namePh/categoryPh/descPh`, 6 lingue: Milanesa / Platos principales / Ingredientes...) invece di "Ramo de Rosas". Shop invariato. `openProductModal` setta `placeholder` via `t()` in base a `isRestaurantPlan`.
- Categoria full-width: con SKU nascosto, `#catSkuGrid` passa `grid-cols-2`→`grid-cols-1` (era mezza riga con buco vuoto).

## COSA È STATO FATTO (sessione 2026-06-20 — menu ristorante)

### Menu ristorante — vista dedicata + invio menu da Sara
- **Data model**: riusata tabella `products` (no tabella nuova). Aggiunta UNA colonna `allergens TEXT`. Stock irrilevante per ristorante → nascosto in UI, item sempre disponibile (`stock_qty = null`).
- **Migration ✅ ESEGUITA (2026-06-20)**: `ALTER TABLE products ADD COLUMN IF NOT EXISTS allergens TEXT;` (Migration 10 in `db/migrations.sql`)
- **Vista Menu** (`public/admin/index.html`): quando `isRestaurantPlan`, il tab Productos/Menu rende `renderMenu()` invece della tabella prodotti. Piatti raggruppati per categoria, colonne `Piatto | Descrizione | Allergeni | Prezzo | Stato | Azioni` — niente stock/SKU. `#menuView` nuovo container, `#productsTableWrap` nascosto in modalità ristorante.
- **Modal piatto**: campo allergeni (`#pAllergens`) visibile solo ristorante; `#stockRow` + `#skuField` nascosti in ristorante. `saveProduct`/`openProductModal` gestiscono `allergens`; stock forzato a `null` per ristorante.
- **Backend** (`routes/admin.js`): POST/PUT `/products` accettano `allergens`. `import-confirm` bulk insert passa `allergens`.
- **Import foto menu-aware** (`routes/admin.js` `import-from-images`): prompt vision branchato su `tenant.restaurant_enabled` — estrae `category` (= sezione menu: Entradas/Primeros/Postres...), `description`, `allergens` per ogni piatto. Riusa stessa pipeline Haiku.
- **Invio menu da Sara** (decisione chiave: menu sempre generato dal DB, MAI foto cartacea caricata — evita staleness, zero storage, zero token AI):
  - `services/claude.js`: regola 15 (solo `restaurant_enabled`) → cliente chiede menu/carta → Sara emette `<SEND_MENU>` e NON scrive i piatti. Catalogo nel prompt mostra anche allergeni (`⚠️`). Tag `<SEND_MENU>` parsato → ritorna `sendMenu`. `formatPrice` ora esportato.
  - `routes/webhook.js`: destruttura `sendMenu`; `buildMenuText(stock, tenant)` costruisce menu testo formattato (raggruppato per categoria, prezzo via `formatPrice`, descrizione, allergeni) e lo manda dopo la reply. Zero token AI (costruito nel backend).
- **i18n**: chiavi `menu.col.dish/desc/allergens/price/status/actions`, `menu.active/inactive`, `menu.noCategory`, `menu.allergens/allergensPh` in ES/EN/IT/DE/FR/PT (`public/admin/i18n.js`).
- **Foto singolo piatto**: meccanismo esistente `<SHOW_IMAGE>` + `products.image_url` invariato.

### Tavoli ristorante — creazione in blocco (bulk)
- Problema: ristoranti con molti coperti non possono inserire i tavoli uno a uno.
- `routes/admin.js` `POST /restaurant/tables`: accetta `quantity`. `quantity=1` + label esplicita → comportamento singolo (label come digitata). Altrimenti bulk: prefisso = label o `"Mesa"`, etichette auto-numerate continuando la sequenza esistente (`${prefix} N`, regex su label esistenti per trovare max). Cap 200 tavoli/op.
- `public/admin/index.html`: modal tavolo — campo `#tableModalQuantity` + hint (`#tableQtyRow`), visibile solo in creazione (nascosto in edit). Label ora opzionale. `saveTable` invia `quantity` in POST.
- i18n: `restaurant.tableQuantity` + `restaurant.tableQuantityHint` in 6 lingue; `restaurant.tableLabel` → "(opcional)".

### Capacità parallela appuntamenti (Fase 1 epic prenotazioni)
- Problema: modello appuntamenti assumeva 1 prenotazione per slot. Dentista=1 ok, ma studio con N poltrone / ristorante devono accettare più prenotazioni nella stessa fascia. Decisione: capacità **per-tenant** (numero unico), non per-servizio.
- **Migration ✅ ESEGUITA (2026-06-20)**: `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS appointment_capacity INTEGER NOT NULL DEFAULT 1;` (Migration 11)
- `routes/webhook.js`: `checkSlotAvailability(tenantId, start, end, capacity)` — slot pieno solo quando appuntamenti sovrapposti ≥ capacità (era: qualsiasi sovrapposizione). I `appointment_blocks` bloccano sempre. Slot-gen 14gg idem (blocchi sempre, appts contati vs cap). Entrambi i caller passano `tenant.appointment_capacity` (getTenantConfig usa `select('*')`).
- `routes/admin.js`: `/settings` GET espone `appointment_capacity`, PUT lo accetta (clamp ≥1). `/available-slots` (usato dal modal calendario manuale) capacity-aware: blocchi sempre, appts contati vs cap.
- `public/admin/index.html`: campo "Citas en paralelo por horario" (`#apptCapacity`) nella sezione 🕐 Horarios (tab appuntamenti), load in `initCalendar`, save via `saveApptCapacity` → `/admin/settings`.
- i18n: `appt.capacity` + `appt.capacityHint` in 6 lingue.
- **Restaurant resta table-based** (parallelismo = tavoli liberi) — non usa appointment_capacity.

### Fase 2 — merge vista prenotazioni nel tab appuntamenti (FATTA)
- Tenant ristorante: tab "Turnos" → relabel "📅 Prenotazioni" (`tab.reservations`). `applyTabVisibility` + `applyTranslations` ora restaurant-aware per Products→Menu e Appointments→Prenotazioni (fix anche relabel menu al cambio lingua).
- `sectionAppointments`: calendario appuntamenti wrappato in `#apptCalendarWrap`; nuovo `#reservationsView` (date picker + lista + "Nueva reserva") spostato qui dal tab Ristorante.
- `switchTab('appointments')`: ristorante → `initReservationsView()` (mostra reservationsView, nasconde calendario, carica tavoli/zone se mancanti, loadReservations); altrimenti `initCalendar()` (mostra calendario, nasconde reservationsView).
- Lista prenotazioni RIMOSSA dal tab Ristorante.

### Fase 3 — tab Ristorante = config (FATTA)
- Tab Ristorante: enable + durata mesa + zone + tavoli + **fasce di servizio** (nuovo). Niente più lista prenotazioni.
- **Migration ✅ ESEGUITA (2026-06-20)**: `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS restaurant_meal_bands JSONB NOT NULL DEFAULT '[]'::jsonb;` (Migration 12). Formato: `[{label,start,end}]`.
- `public/admin/index.html`: card "Franjas de servicio" (`#mealBandsList`) — add/edit/remove franja (label + start + end), salva su `/admin/restaurant/settings`. Funzioni `renderMealBands/addMealBand/updateMealBand/removeMealBand/saveMealBands`, stato `_mealBands`.
- `routes/admin.js`: `/settings` GET espone `restaurant_meal_bands`; `/restaurant/settings` PUT lo accetta (sanitizza: solo {label≤40, start, end} con start/end presenti).
- `services/claude.js`: `buildRestaurantStaticBlock(zones, tables, mealBands)` — aggiunge "FRANJAS DE RESERVA" + regola "SOLO reservas dentro de estas franjas". Passato `tenant.restaurant_meal_bands` (getTenantConfig `select('*')`).
- i18n: `tab.reservations`, `restaurant.bands/addBand/bandsHint/noBands/bandLabelPh` in 6 lingue.
- Restaurant resta table-based per il parallelismo (le fasce delimitano gli orari, i tavoli il numero simultaneo).

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

## COSA È STATO FATTO (sessione 2026-06-19 — WhatsApp reconnect banner fix)

### Banner "connessione WhatsApp ha un problema" — FIX (commit 56c408f + b6e0957)
- Il banner (`showTokenErrorBanner()`) appare quando `whatsapp_token_refresh_error` è settato (dal cron `index.js` che tenta refresh token Meta)
- Il bottone chiamava `switchTab('settings')` → portava in Settings che non ha campo per token → sembrava non fare nulla
- Fix: bottone ora chiama `reconnectWhatsApp()` — nuova funzione che apre wizard direttamente allo **step 2** (connessione WhatsApp)
- Step 2 wizard offre sia Embedded Signup (Facebook/Meta) che inserimento manuale (Phone ID + token)
- Il banner si rimuove automaticamente all'apertura wizard
- **Card persistente in tab Support** (`tokenErrorCard`): visibile finché `token_refresh_error` è settato — non scompare se tenant chiude il banner. Tenant trova sempre il bottone in Support tab.
- i18n: `wiz.token_error_title` + `wiz.token_error_desc` aggiunte in ES/EN/IT/DE/FR/PT
- Cosa deve fare il tenant: clicca "Ricollegare WhatsApp" (banner o card Support) → si apre wizard → usa Embedded Signup o inserisce manualmente le credenziali Meta aggiornate

## COSA È STATO FATTO (sessione 2026-06-19 — rimossa notifica Telegram token scaduto)

### Telegram token-error alert — RIMOSSO
- Eliminata `notifyTokenError()` da `routes/telegram.js` (funzione + export)
- Rimosso import + chiamata in `index.js` (cron `scheduleTokenRenewal`)
- Il cron continua a loggare il fallimento e a settare `whatsapp_token_refresh_error` in DB → banner/card "Ricollegare WhatsApp" nel pannello admin invariati
- `notifySuperadmin` (alert chat supporto) non toccato

## COSA È STATO FATTO (sessione corrente 2026-06-19 — settings tab layout)

### Settings tab — layout refactor (commit 8ad08d0)
- Problema: griglia `grid-cols-2` con `md:col-span-2` su molte card causava righe con spazio vuoto a destra (`h2`, `Account`, `Business info` erano soli nella loro riga)
- Fix: `sectionSettings` diventa `space-y-5`; due div espliciti `LEFT` / `RIGHT` con `space-y-5` indipendenti dentro un `grid-cols-2`; card full-width (Orari+Chiusure, Offerte, Delivery) messe sotto il grid block
- LEFT: Lingua, Account, Telefono, Info negocio, Password, Legal
- RIGHT: Bot personality, Profilo WA, Istruzioni pagamento, Regole negocio
- FULL-WIDTH sotto: Orari+Chiusure (già split interno 2-col), Offerte, Delivery (condizionale)
- Delivery card interna compattata: Indirizzo+Tipo tarifa affiancati; Costo+Minimo affiancati; zone/km fields in grid-cols-2

## COSA È STATO FATTO (sessione 2026-06-19 — Stripe + register redesign)

### Stripe — COMPLETATO ✅
- Account LLC collegato in test mode — env var già settate su Render (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_SHOP/BOOKINGS/RESTAURANT/PRO)
- Flow end-to-end testato e funzionante: signup → Stripe checkout → webhook → tenant attivo

### Register page — redesign UX (commit dd52deb + aa99fab + 9f9674e)
- **Step 1**: 7 settori liberi → 4 settori legati ai piani con etichetta tipo (solo prodotti / solo servizi / cibo e bevande / prodotti+servizi) + esempi concreti di lavoro per ogni settore in ES/EN/IT/DE/FR/PT
- **Auto-piano**: selezione settore → pre-seleziona piano corrispondente in step 4 + banner "consigliamo questo piano"
- **Step 2**: rimosso campo "nome titolare" (non necessario per bot setup)
- **Step 3**: testo warning WhatsApp ingrandito (text-sm invece di text-xs)
- **Step 4**: badge "più popolare" spostato da Pro → Restaurant (come landing); feature list aggiornate con stesse voci della landing (5/6/7/9 feature per piano); piani in griglia 2 colonne su desktop
- **Layout**: max-w-lg → max-w-2xl (più largo su desktop)
- **Settori**: etichetta tipo attività ("solo prodotti / solo servizi / cibo e bevande / prodotti+servizi") + esempi concreti (Abbigliamento · Pasticceria · Medico · Dentista · Pizzeria · Estetica con prodotti...) in tutte e 6 le lingue
- **Modal disclaimer rimosso**: bottone "Continuar al pago" → Stripe diretto (avviso numero WhatsApp già in step 3, Facebook/carta sono prerequisiti ovvi)

## COSA È STATO FATTO (sessione 2026-06-19 — fix login flash definitivo, commit 6c160b3)

### Bug fix loginPage flash — FIX DEFINITIVO
- Root cause reale: `loginPage` non aveva `hidden` nell'HTML → visibile prima che JS partisse (window.onload)
- Fix precedente (nasconderla in window.onload prima del fetch) non bastava perché window.onload si attiva dopo il render
- Fix definitivo: `hidden` aggiunto direttamente al div `loginPage` nell'HTML → mai visibile al browser prima di JS
- Mostrata esplicitamente solo nei rami `else` / `catch` di window.onload se non autenticato

## COSA È STATO FATTO (sessione 2026-06-20 — fix support bot muto)

### Support bot (tab Support admin) non rispondeva — FIX (`routes/admin.js` POST `/admin/support`)
- Sintomo: merchant scriveva nella chat supporto, nessuna risposta del bot
- Bug 1: history `limit(20)` con `order ascending` → dopo 20 msg prendeva i 20 PIÙ VECCHI, bot rispondeva a contesto antico ignorando la domanda nuova
- Bug 2: Anthropic richiede ruoli `user/assistant` strettamente alternati a partire da `user`. Una singola risposta AI fallita (o 2 msg merchant di fila, o 2 risposte superadmin `support` consecutive) lasciava ruoli consecutivi → ogni chiamata successiva errore 400 → bot muto in modo permanente su quella chat
- Fix: fetch ultimi 20 (`descending` + `reverse`); collasso ruoli consecutivi (concatena content); drop `assistant` iniziali; fallback al msg corrente se array vuoto
- Resto invariato e funzionante: escalation `[ESCALATE]` → `notifySuperadmin` Telegram (rispondi col reply Telegram → arriva al merchant via role `support`); chat visibile in superadmin panel (`GET /superadmin/support`)
- Telegram escalation confermato funzionante (env già settati e testati)

## COSA È STATO FATTO (sessione 2026-06-20 — plan tab redesign, commit d75c620)

### Admin plan tab — redesign (public/admin/index.html + i18n.js)
- Rimosso pulsante "Pagar con MercadoPago" (`mpPayBtn`) + funzione JS `startMpCheckout()`
- Rimosso pulsante "Contatta supporto per rinnovare"
- Rimossa griglia "Planes disponibles" (Starter/Pro/Enterprise — completamente obsoleta)
- Aggiunto link testo discreto "Vuoi cambiare piano? Contatta il supporto" → `switchTab('support')`
- Rimossi chiavi i18n obsoleti: `plan.pay.btn/processing/error/not_configured`, `plan.status.renew`, `plan.plans.title`, `plan.plans.chat_support`
- Aggiunta chiave `plan.change.plan` in ES/EN/IT/DE/FR/PT
- Rimane: status abbonamento (`planStatusBox`) + codice promozionale

## COSA È STATO FATTO (sessione 2026-06-20 — eliminazione account a conferma email)

### Anti-malicious-employee: delete account ora richiede conferma via email
- Motivo: prima `DELETE /admin/account` cancellava subito → un dipendente col pannello poteva eliminare l'account del titolare. Ora solo chi controlla l'email registrata (il titolare) può completare.
- Flusso: Settings → "Elimina account" → doppia conferma pannello → `POST /admin/account/request-deletion` (genera token 32B, scadenza 1h, manda mail) → mostra "controlla la mail" → titolare apre link `?delete=<token>` → pagina `#deletePage` → `POST /admin/account/confirm-deletion` (token-gated, NO requireAuth, come reset-password) → cancel Stripe + wipe dati + logout + redirect
- `routes/admin.js`: rimosso `DELETE /account`; aggiunto helper `performAccountDeletion(tenantId)` + route request/confirm; KB support bot aggiornata
- `services/mailer.js`: `sendAccountDeletion()` + traduzioni `TD` ×6 lingue (template rosso)
- `public/admin/index.html`: `#deletePage` (dopo `#resetPage`), detection `?delete=` in `window.onload`, `deleteAccount()` riscritta (chiama request-deletion + msg `email_sent`), `showDeletePage()` + `confirmDeletion()`
- `public/admin/i18n.js`: `delete.title/hint/btn/cancel/error` + `settings.danger.email_sent` + reword `settings.danger.confirm1` in tutte e 6 le lingue (ES/EN/IT/DE/FR/PT)

**Migration Supabase richiesta (NON ancora eseguita):**
```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS account_deletion_token   TEXT,
  ADD COLUMN IF NOT EXISTS account_deletion_expires TIMESTAMPTZ;
```

## COSA È STATO FATTO (sessione 2026-06-20 — help tab estesa per feature mancanti)

### Tab Help aggiornata — sezioni gated per piano (`public/admin/index.html` `renderHelp()`)
- Mancavano le feature aggiunte di recente. Aggiunte 3 sezioni condizionali:
  - **📅 Appuntamenti e servizi** (se `appointments_enabled` o `services_enabled`): vedi agenda, prenota, annulla/sposta, blocca orario/ferie, gestione servizi (prezzo/durata)
  - **🍽️ Prenotazioni tavolo** (se `restaurant_enabled`): Sara prende prenotazioni (persone/data/ora/zona), assegna tavolo più piccolo libero, gruppi grandi → avviso WhatsApp manuale, gestione dal tab Restaurante
  - **🏷️ Chiusure, offerte e diffusione** (sempre): chiusure/ferie NL, offerte/sconti NL, broadcast marketing dal tab Clienti
- Gating: nuovi globali `planProductsEnabled` / `planServicesEnabled` / `planAppointmentsEnabled` settati in `applyTabVisibility` (oltre a `isRestaurantPlan` esistente)
- i18n: 14 chiavi nuove `help.appts.*` / `help.restaurant.*` / `help.extra.*` in tutte e 6 le lingue (ES/EN/IT/DE/FR/PT) — verificato 6/chiave
- Sezioni esistenti (catalogo, foto, ordini, takeover, chat panel) invariate
- Migration `account_deletion_*` già eseguita su Supabase ✅

## COSA È STATO FATTO (sessione 2026-06-20 — tab Plan: nome piano + disdetta self-service)

### Tab Plan — nome piano attivo + gestione abbonamento (disdici/riattiva)
- **Nome piano** mostrato nella card stato: badge derivato dai flag (📦 Shop / 📅 Bookings / 🍽️ Restaurant / ⭐ Pro) + prezzo/mese — stessa logica del badge superadmin
- **Card "Gestisci abbonamento"**: bottone **Disdici** (rosso); dopo disdetta → bottone **Riattiva** + avviso giallo "accesso fino al {data}"
- Backend billing già esisteva (`POST /billing/cancel` = `cancel_at_period_end:true`, `POST /billing/reactivate`); ora cablato nell'UI
- **Persistenza flag**: nuovo `subscription_cancel_at_period_end` (DB) settato in cancel/reactivate + webhook `subscription.updated` (`obj.cancel_at_period_end`) → l'UI sceglie Disdici vs Riattiva anche dopo reload
- `/admin/settings` espone ora `plan_price`, `stripe_subscription_status`, `subscription_cancel_at_period_end`
- Card billing visibile solo se `stripe_subscription_status ∈ {active, trialing, past_due}` (tenant manuali/legacy senza Stripe non vedono il bottone)
- i18n: 11 chiavi `plan.*` (your_plan, per_month, manage.title, cancel.btn/confirm/done/scheduled/scheduled_nodate, reactivate.btn/done) in ES/EN/IT/DE/FR/PT
- File: `public/admin/index.html` (`loadPlan` + `cancelSubscription`/`reactivateSubscription`), `public/admin/i18n.js`, `routes/admin.js`, `routes/billing.js`, `db/migrations.sql`

### DECISIONE: comportamento a disdetta/scadenza (NON riaprire — è lo standard SaaS)
- Disdetta **non immediata**: accesso fino a fine periodo pagato; riattivabile prima
- A fine periodo → Stripe `subscription.deleted` → `active:false`, `plan_status:suspended`
- Poi: **Sara OFF** per i clienti (kill switch `webhook.js`) + **pannello limitato** a support/settings/plan (`ALWAYS_ALLOWED` in `admin.js`) — NON lockout totale: il merchant resta dentro per ripagare/contattare supporto/esportare/eliminare dati

**Migration richiesta su Supabase (NON ancora eseguita):**
```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN DEFAULT false;
```

## COSA È STATO FATTO (sessione 2026-06-20 — superadmin genera codici Stripe-compatibili)

### Guardrail creazione codici (superadmin) per compatibilità Stripe coupon
- `routes/superadmin.js`: helper `validatePromoBenefit()` usato in POST e PUT `/promo-codes` (autoritativo):
  - sconto XOR mesi gratis (non entrambi — il riscatto crea UN solo coupon)
  - almeno un beneficio (>0)
  - percent ≤ 100 (Stripe `percent_off` 0-100)
- `public/superadmin/index.html`: stessa validazione in `savePromo` (feedback immediato) + nota nel modal ("descuento = próximo cobro una vez; meses gratis saltan N cobros; uno o el otro; % ≤ 100")
- Il codice resta solo-DB alla creazione; il coupon Stripe nasce al riscatto (`/admin/redeem-promo`) — vedi sezione sotto

## COSA È STATO FATTO (sessione 2026-06-20 — promo codes applicati su Stripe)

### Riscatto promo ora applica un Coupon Stripe reale (`routes/admin.js POST /redeem-promo`)
- Prima: il riscatto mutava solo `tenants.plan_price`/`plan_expires` nel DB → cosmetico. Stripe addebitava il prezzo pieno (price_id fisso) e il webhook `subscription.updated` sovrascriveva `plan_expires`. Sconti/mesi gratis senza effetto reale.
- Ora: al riscatto si crea un Coupon Stripe e si applica alla subscription (`stripe.subscriptions.update(sub, { coupon })`):
  - **sconto % / fisso** → coupon `duration: 'once'` → applicato al PROSSIMO addebito (decisione utente: -X% una volta). Fisso usa `amount_off` in centesimi + `plan_currency`.
  - **mesi gratis** → coupon `percent_off:100, duration:'repeating', duration_in_months:N` → N mesi saltati, poi riprende.
- Niente più mutazioni DB di `plan_price`/`plan_expires` (Stripe fonte di verità; webhook sincronizza). Si registrano solo `promo_redemptions` + `uses_count`.
- Serve subscription attiva: `!stripe_subscription_id` → errore `no_subscription`. Errore Stripe → 502 `stripe_failed`, redemption NON registrata (riprovabile).
- Frontend `redeemPromo`: messaggio aggiornato ("en tu próximo cobro", "N mes gratis"). Campi `newPlanPrice/newPlanExpires` rimossi dalla response.
- Coupon creato al volo al riscatto (uno per riscatto); creazione codice in superadmin resta solo-DB.

## COSA È STATO FATTO (sessione 2026-06-20 — fix promo codes superadmin)

### Bug: codici sconto superadmin non funzionavano
- `GET /superadmin/promo-codes` usava embed `select('*, promo_redemptions(tenant_id)')` → richiede FK `promo_redemptions.promo_code_id → promo_codes`, assente se la tabella è stata creata a mano → 500 → `loadPromos()` ingoiava l'errore → tabella bloccata su "Cargando" (stesso pattern di support)
- Il render (`renderPromos`) non usa nemmeno i dati di `promo_redemptions` → embed inutile
- Fix: `routes/superadmin.js` GET promo-codes → `.select('*')` (rimosso embed); `loadPromos` ora mostra l'errore reale nell'UI invece di "Cargando" muto
- NB: lo stesso fix escHtml (commit 56e8bc5) era prerequisito — `renderPromos` usa `escHtml`, prima lanciava ReferenceError

## COSA È STATO FATTO (sessione 2026-06-20 — fix superadmin support chat "cargando")

### ✅ CAUSA REALE (commit 56e8bc5): `escHtml` non definito in superadmin/index.html — RISOLTO E CONFERMATO FUNZIONANTE
- `loadSupportList` / `renderSupportMessages` chiamano `escHtml()` ma la funzione NON era mai definita in `public/superadmin/index.html` → ogni render lanciava ReferenceError → catch silenzioso → lista bloccata su "Cargando" da sempre.
- Indizio diagnostico: il badge unread mostrava "5" mentre la lista era vuota → il poll del badge non usa `escHtml` (funzionava); solo la lista falliva.
- Fix: definita `escHtml` in superadmin (identica all'admin), function declaration hoisted.
- NB: l'embed `tenants(name)` rimosso prima NON era la causa (badge=5 provava che l'endpoint tornava dati). Modifiche tenute comunque (più robuste): no-embed + error surfacing UI.

### Bug (ipotesi iniziale errata): chat support superadmin "Cargando..."
- Causa: `GET /superadmin/support` usava embed PostgREST `select('... tenants(name)')` che richiede una FK dichiarata `support_messages.tenant_id → tenants`. In prod la tabella è stata creata a mano, probabilmente senza FK → PostgREST 500 → `loadSupportList()` ingoia l'errore in console → lista resta "Cargando..."
- Fix (`routes/superadmin.js`): rimosso l'embed. Ora fetch `support_messages` semplice + query separata `tenants.select('id,name').in('id', ids)` per i nomi. Mai più 500 sulla relazione. Aggiunto anche `last_message` nella risposta (il frontend lo usava ma il backend non lo popolava).
- `db/migrations.sql`: documentata la tabella `support_messages` (CREATE IF NOT EXISTS) con FK a tenants + CHECK `role IN ('merchant','assistant','support')` + indice — così nuovi ambienti hanno la relazione corretta per gli embed.

### Sospetto residuo: bot support admin non risponde
- Se la tabella `support_messages` esistente ha un CHECK su `role` che NON include `'assistant'` (creata prima del support bot), ogni insert della risposta bot fallisce nel catch → nessuna risposta.
- `CREATE IF NOT EXISTS` non altera una tabella già esistente. Se il bot non risponde dopo il deploy, eseguire su Supabase:
```sql
ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_role_check;
ALTER TABLE support_messages ADD  CONSTRAINT support_messages_role_check CHECK (role IN ('merchant','assistant','support'));
```

## COSA È STATO FATTO (sessione 2026-06-20 — enforcement orari prenotazioni/appuntamenti)

### Appuntamenti e reservation ora rispettano orari/fasce lato server
- **Appuntamento cliente** (`webhook.js` blocco `appointmentRequest`): prima inseriva SENZA validazione → un cliente poteva prenotare fuori orario. Ora chiama `checkSlotAvailability` (già usata dal lato merchant): se non valido (giorno chiuso / fuori orario / bloccato / slot pieno) → NON salva, NON notifica, inietta `[SISTEMA]` note → Sara corregge al turno dopo nella lingua del cliente.
- **Reservation ristorante** (`webhook.js` blocco `reservationRequest`): nuovo guard — la prenotazione deve cadere in una **meal band** (`tenant.restaurant_meal_bands`) E in giorno aperto/entro orari (`business_hours`). Fuori → NON salva + `[SISTEMA]` note. Se non ci sono band/orari configurati, il vincolo relativo è skippato.
- **Meal bands ⊆ orari apertura** (`admin.js PUT /restaurant/settings`): al salvataggio valida che ogni fascia abbia start<end e stia dentro l'orario di ogni giorno aperto (`business_hours`). Fuori → 400 `band_outside_hours` / `band_invalid_range`.
- NB: il prompt (`claude.js buildRestaurantStaticBlock`) già diceva a Sara di accettare reservation solo dentro le franjas; i guard sono il backstop server-side che impedisce salvataggi fuori regola.
- Confronti orari normalizzati a `HH:MM` (slice 0,5) per gestire `open_time` con secondi.

## COSA È STATO FATTO (sessione 2026-06-20 — audit completo + fix, commit ea7e60f)

### Audit + fix batch (`public/admin/index.html`, `i18n.js`, `register/`, `landingpage/`, `routes/billing.js`)
- `.btn-purple` CSS mancante → bottoni "Applica" promo e import-foto senza sfondo — aggiunto in `<style>`
- Chiave i18n `cancel` mancante in 6 lingue → 4 bottoni modal stuck in spagnolo — aggiunta ES/EN/IT/DE/FR/PT
- Dead keys `settings.plan.starter/enterprise/popular/custom/f1-f11` (vecchia griglia piani) — eliminate da tutti e 6 i blocchi lingua in `public/admin/i18n.js`
- `saveRestaurantSettings()` leggeva visibilità tab dal DOM (`style.display !== 'none'`) — usa ora variabili globali `planProductsEnabled/planServicesEnabled/planAppointmentsEnabled`
- Typo "Gestional" → "Gestión de" in `landingpage/index.html` (TR ES) e `public/register/i18n.js` (ES) — 6 occorrenze
- `showDisclaimer()` wrapper rimosso da register — validazione inline in `submitRegistration()`, button chiama direttamente `submitRegistration()`
- `invoice.paid` non gestito in billing webhook → handler aggiunto in `routes/billing.js` (aggiorna `plan_expires` ad ogni rinnovo mensile)
- `restaurant_enabled` mancante in `applyTabVisibility()` in settings reload → tab Restaurant spariva per piano Restaurant — fixato (commit 296cb04)

## COSA È STATO FATTO (sessione corrente 2026-06-20 — UX admin vari)

### Settings tab layout refactor (commit 8ad08d0)
- Grid a 2 colonne con `md:col-span-2` lasciava righe con spazio vuoto → refactor con colonne esplicite LEFT/RIGHT (`space-y-5` indipendenti) + card full-width (Orari+Chiusure, Offerte, Delivery) sotto il blocco 2-col

### Valuta tenant-aware in tutto il pannello admin (commit b9fd443)
- `TENANT_CURRENCY` global settato da `plan_currency` al boot e in `loadSettings()`
- `fmtPrice(n)` sostituisce `formatGs()`/`fmtGs()` — formato + simbolo corretti per PYG/USD/EUR/ARS/BRL/MXN/CLP/COP/UYU/PEN
- i18n: 54 occorrenze `(Gs)` → `({cur})`; `applyTranslations()` sostituisce `{cur}` col simbolo reale dopo ogni pass

### Parsing prezzi locale-aware (commit c660be9)
- `parsePriceInput(str)` gestisce separatori migliaia/decimale per valuta:
  - PYG/CLP/COP (intere): strip tutto tranne cifre → `250.000` = 250000
  - EUR/ARS/BRL/UYU/PEN (virgola=decimale): `1.500,99`→1500.99, `250.000`→250000
  - USD/MXN (punto=decimale): `1,500.00`→1500.00
- Applicato a: prezzo prodotto, prezzo servizio, tutti i campi delivery fee

### Clienti: email + indirizzo (commit e7dbd8f)
- **Migration richiesta:**
  ```sql
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_email TEXT;
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_address TEXT;
  ```
- `GET/POST /admin/customers` + export CSV includono i nuovi campi
- `PUT /admin/customers/:phone/info` — nuovo endpoint per aggiornare email/indirizzo
- Modal "Aggiungi cliente" → 2 campi opzionali extra
- Tabella clienti → email (✉️) e indirizzo (📍) come subtext; bottone 📋 apre modal edit
- i18n in ES/EN/IT/DE/FR/PT

## COSA È STATO FATTO (sessione 2026-06-20 — fix superadmin + tab visibility + restaurant)

### Support notifications persistence (commit b476a99)
- `supportReadAt` era una Map in-memory → si resettava ad ogni restart Render → badge notifiche tornavano dopo refresh
- Fix: `POST /superadmin/support/:tenantId/read` ora fa UPDATE `tenants.support_read_at = now()` nel DB; `GET /superadmin/support` legge `support_read_at` da `tenants` al posto della Map
- **Migration richiesta (eseguita? ⚠️ verificare):** `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_read_at TIMESTAMPTZ;`

### Superadmin: delete tenant + fix icone token/meta (commit ec8a1e6)
- `DELETE /superadmin/tenants/:id`: elimina tenant + tutti i dati (support_messages, appointments, orders, conversations, products, services, restaurant_tables, restaurant_reservations) in ordine di dipendenza
- Bottone 🗑️ in colonna Acciones con doppia conferma
- Token WA: ✅ attivo / ❌ con errore reale in tooltip
- Meta: ✅ token Meta proprio / ❌ usa token globale — rimosso 🔵 blu confuso

### Tenant di test creati (script: scripts/create-test-tenants.js)
- Test Shop (`testshop`), Test Bookings (`testbookings`), Test Restaurant (`testrestaurant`), Test Pro (`testpro`)
- Password: `sara1234`, token WA simulato (no errori), flag plan corretti nel DB

### Bug: /admin/settings ritornava 500 per TUTTI i tenant
- Causa: colonna `tenants.sector` non esiste nel DB → Supabase errore → 500 → `applyTabVisibility` mai chiamata → tutte le tab visibili
- **Migration ESEGUITA:** `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sector TEXT;`
- (Contemporaneamente: `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_read_at TIMESTAMPTZ;`)

### Fix showDashboard: singola fetch settings, tab sempre applicate (commit 7120615)
- Prima: 2 chiamate separate a `/admin/settings`; se la seconda falliva → `applyTabVisibility` non chiamata
- Ora: una sola fetch, risultato riusato per `waConnected` check e `applyTabVisibility`; stats caricati separatamente in fire-and-forget

### Fix tab restaurant: rimosso toggle enable, icona 🍽️→🪑 (commit e7d2433)
- Toggle "Gestisce prenotazione con Sara" era il checkbox `restaurantEnabled` — disattivandolo e salvando si chiamava `applyTabVisibility(..., false)` → tab Tavoli spariva
- Rimosso toggle; `saveRestaurantSettings` invia sempre `restaurant_enabled: true`; `applyTabVisibility` non più chiamata da `saveRestaurantSettings`
- Tab rinominata 🪑 "Tavoli" (era 🍽️ "Restaurante" — uguale a tab Menu)

## COSA È STATO FATTO (sessione 2026-06-20 — delivery sector + email logo)

### Settore Pizzeria/Delivery/Asporto — COMPLETATO (commit 7033423)
- `services/sectorPrompts.js`: aggiunto settore `delivery` (prima di `restaurante`) — personalità rapida/diretta, 7 regole comportamentali specifiche delivery/asporto.
- `routes/admin.js` `GET /settings`: aggiunto `sector` al select → frontend legge il settore.
- `public/admin/index.html`:
  - Global `isMenuMode = false`; settato a `true` se `settings.sector === 'delivery'` in ENTRAMBI `showDashboard()` e `loadSettings()`.
  - `applyMenuLabels()`: usa `tab.menu` se `isRestaurantPlan || isMenuMode`.
  - `applyTabVisibility()`: usa `tab.menu` se `restaurantEnabled || isMenuMode`.
- `public/register/index.html`: card 5a col-span-2 `data-sector="delivery" data-plan="shop"` — cliente delivery vede piano Shop ma con label Menú.
- `public/register/i18n.js`: chiavi `s1.sector.delivery` + `s1.sector.delivery.example` in 6 lingue.
- `landingpage/index.html`: `pricing.shop.example` aggiornato con Pizzerías/Delivery in tutte e 6 le lingue.
- **Comportamento**: merchant delivery → tab "Menú" invece di "Productos/Catálogo", stessa funzionalità Shop, Sara con personalità delivery.

### Logo email aggiornato (commit 38c6046)
- `images/mail.webp`: nuovo logo per email (committato nel repo).
- `services/mailer.js`: 5 occorrenze `logosarabot.webp` → `mail.webp`. Tutte le email (welcome, reset password, phone change, delete account) ora usano il nuovo logo.

## PROSSIME PRIORITÀ (sessione successiva)
1. **Migration Supabase** — eseguire `ALTER TABLE conversations ADD COLUMN customer_email/customer_address`
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

## COSA È STATO FATTO (sessione 2026-06-20 — protezione azioni sensibili impostazioni)

### Password richiesta per cambio email, username, telefono merchant, password
- **Backend** (`routes/admin.js`): aggiunta helper `verifyCurrentPassword(tenantId, pwd)` → bcrypt compare vs `admin_password_hash`.
- `POST /admin/change-email`: richiede `currentPassword`, verifica prima di aggiornare.
- `POST /admin/change-username`: richiede `currentPassword`, verifica prima di aggiornare.
- `POST /admin/change-password`: richiede `currentPassword`, verifica prima di aggiornare.
- Nuovo `POST /admin/change-merchant-phone`: richiede `currentPassword`, verifica, aggiorna `merchant_phone`. Il campo `merchant_phone` rimosso da allowed in `PUT /admin/settings`.
- ErrorCode `wrong_password` (HTTP 403) su verifica fallita.
- **Frontend** (`public/admin/index.html`):
  - Card Account: aggiunto campo `#aCurrentPwd` (password attuale) condiviso tra cambio email e cambio username.
  - Card Password: aggiunto campo `#currentPwd` sopra il campo nuova password.
  - Card Telefono WhatsApp: aggiunto campo `#sPhoneCurrentPwd`. `saveMerchantPhone()` ora chiama `POST /admin/change-merchant-phone` invece di `PUT /admin/settings`.
  - Campi password svuotati dopo successo.
- **i18n** (`public/admin/i18n.js`): chiavi `settings.account.currentPwd`, `settings.account.currentPwdPh`, `err.wrong_password` in ES/EN/IT/DE/FR/PT.
- Commit: `cda5d9d` — push completato.

## COME RIPRENDERE
Primo messaggio da mandare a Claude nella prossima sessione:
"Leggi HANDOFF.md. Sessione precedente: fix support persistence, delete tenant, fix tab visibility (sector migration), fix restaurant toggle. Prossimo: fatturazione merchant, oppure go-to-market."

## ERRORI NOTI / TRAPPOLE
- NON leggere/query tabella prod `tenants` con `select('*')` o colonne sensibili senza autorizzazione esplicita utente per quella lettura specifica — bloccato da permission classifier (dati merchant: token WhatsApp, telefoni). `superadmin GET /tenants/:id` ora usa campi espliciti sicuri.
- Anthropic prompt caching ha soglia minima ~4096 token sul prefisso cacheabile per modelli Haiku-tier: sotto soglia, caching no-op silenzioso, nessun errore — non assumere che caching funzioni senza verificare `response.usage.cache_creation_input_tokens`/`cache_read_input_tokens`.
- Caching è match byte-prefix stretto: qualsiasi contenuto dynamic messo PRIMA del blocco static rompe la cache ogni volta.
