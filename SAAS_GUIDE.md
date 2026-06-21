# WhatsApp Bot SaaS — Guida Operativa

_Aggiornato: 2026-06-21_

> **Tooling**: pre-commit hook `.githooks/pre-commit` (→ `scripts/check-syntax.js`, anche `npm run check`) valida la sintassi JS dei file UI serviti al browser (i18n.js + script inline di `public/{admin,register,superadmin}/index.html`) per evitare commit che azzerano l'UI (white page). Attivazione su clone nuova: `git config core.hooksPath .githooks`.

## Stack tecnico

- **Node.js + Express** — server webhook + API REST
- **Supabase** — PostgreSQL + autenticazione + storage immagini
- **Anthropic Claude** — motore conversazionale Sara
  - Chat cliente: `claude-haiku-4-5-20251001`
  - Task complessi: `claude-sonnet-4-6`
- **Meta Cloud API** — invio/ricezione messaggi WhatsApp
- **Stripe** — billing SaaS (subscription tenant)
- **Nodemailer** — email transazionali
- **Deploy** — Render (`sara-bot-tcl6.onrender.com`) — server Node.js attivo
- **Dominio** — `sarabot.pro` su Cloudflare (solo DNS/email — MX per Brevo SMTP). `www.sarabot.pro` CNAME proxiato → Render. Webhook Meta punta a `onrender.com` direttamente.
- **Meta App** — SaraBot, ID `27756118003980694`, Business: Deepcable LLC — **pubblicata (live)**
- **Token WhatsApp** — System User Admin token permanente in `WHATSAPP_TOKEN` env Render

---

## Flusso completo per un tenant

```
Cliente WhatsApp → Meta Cloud API → /webhook
    → identifica tenant da phone_number_id
    → carica stock + storico conversazione
    → [se booking keywords] carica orari + slot appuntamenti
    → Claude (Sara) risponde con prompt caching
    → se ordine confermato → notifica merchant
    → merchant risponde CONFIRMAR/CANCELAR/CHAT
    → aggiorna DB → notifica cliente
```

---

## Ottimizzazioni performance attive

### Prompt Caching (Anthropic)
`services/claude.js` — system prompt splittato in due blocchi:
- **Static** (catalogo, regole, identità bot): `cache_control: {type:'ephemeral'}` → cacheato tra messaggi
- **Dynamic** (stato delivery, slot disponibili): non cacheato, varia ogni messaggio

Risparmio tipico: ~8500 token cached per messaggio (vedi `cache_read_input_tokens` nella response).
Soglia minima caching Haiku: ~4096 token — verifica sempre `usage.cache_creation_input_tokens`.

### Appointment Keyword Gating
`routes/webhook.js` — le 3 query Supabase extra (`business_hours`, `appointments`, `appointment_blocks`) + calcolo slot 14gg girano **solo** se messaggio o ultimi 4 msg history menzionano parole chiave di booking (regex `APPOINTMENT_KEYWORDS`).

---

## Human Takeover

Quando Sara rileva un ordine confermato:
1. Salva ordine con `status: 'pending'`
2. Invia al merchant (numero in `tenants.merchant_phone`):

```
🛒 Nuevo pedido #ABC12345
👤 Cliente: +595981234567

📦 Productos:
  • Ramo de Rosas Rojas x1 — 150.000 Gs

💰 Subtotal: 150.000 Gs
🚚 Envío: 5.000 Gs
💵 Total: 155.000 Gs

Respondé con:
✅ CONFIRMAR — aceptar el pedido
❌ CANCELAR — rechazar el pedido
💬 CHAT — tomar el chat con el cliente
```

Comandi merchant:
- **CONFIRMAR** → ordine `confirmed`, cliente riceve conferma + istruzioni pagamento
- **CANCELAR** → ordine `cancelled`, cliente notificato
- **CHAT** → takeover attivo: merchant ↔ cliente via bot
- **FIN** → fine takeover, Sara riprende

---

## Customer Bot — Sara (o nome personalizzato)

Il bot si presenta al cliente con il nome configurato dal merchant nel pannello admin (`tenants.bot_name` o equivalente). Se non configurato, usa il nome di default "Sara". Parla nella lingua del cliente (rilevata automaticamente), risponde 24/7, e opera solo nei limiti del piano attivo del merchant.

### Cosa può fare

**Informazioni sull'attività**
- Orari di apertura e giorni di chiusura
- Indirizzo e indicazioni per raggiungerla
- Contatti pubblici del locale (WhatsApp business, sito web, social — se configurati dal merchant)
- Descrizione dell'attività, specialità, informazioni generali

**Catalogo / Menu / Servizi**
- Mostrare menu o catalogo completo
- Informazioni su singoli prodotti, piatti o servizi (prezzo, descrizione, disponibilità, allergeni)
- Foto di prodotti/piatti (se caricate dal merchant)
- Offerte e sconti attivi
- **Ricerca per foto** — il cliente invia una foto e chiede se c'è qualcosa di uguale o simile; Sara confronta visivamente con il catalogo e risponde

**Transazioni** *(solo se abilitati dal merchant)*
- Ordinare prodotti con consegna a domicilio *(shop o ristorante con delivery attivo)*
- Prenotare un tavolo *(ristorante)*
- Prenotare un appuntamento *(servizi)*
- Inviare comprovante di pagamento

**Stato acquisto**
- Stato del proprio ordine o prenotazione
- Riepilogo della propria prenotazione

### Cosa NON può fare
- Vedere dati di altri clienti (ordini, prenotazioni, identità)
- Accedere a dati interni dell'attività
- Modificare prezzi, stock o impostazioni
- Conoscere email o numeri privati del merchant
- Eseguire rimborsi o cancellare pagamenti

---

## Merchant Bot — specchio del pannello admin

**Principio fondamentale:** il bot WhatsApp del merchant è la copia in linguaggio naturale del pannello admin. Ogni azione disponibile nell'interfaccia grafica è eseguibile via chat. Se il pannello richiede un campo obbligatorio, il bot lo chiede. Se è facoltativo, il bot lo chiede solo se mancante e rilevante. Se non è previsto nel pannello, il bot lo ignora anche se viene detto.

### Regole invarianti

1. **Isolamento tenant totale** — ogni query porta sempre `.eq('tenant_id', tenant.id)`. Un merchant non può mai vedere o modificare dati di un altro.
2. **Feature gating** — le azioni disponibili dipendono dai moduli attivi del piano (`products_enabled`, `services_enabled`, `appointments_enabled`, `restaurant_enabled`). Se un'azione non è nel piano del merchant, il bot risponde con un messaggio localizzato che spiega il limite.
3. **Lingua automatica** — il bot risponde nella lingua del merchant (rilevata da Haiku ad ogni messaggio e memorizzata in `merchantLang`). Tutte le risposte sono disponibili in ES/IT/EN/FR/DE/PT.
4. **Dialogo progressivo** — se mancano campi obbligatori, il bot chiede solo quelli mancanti (pattern `awaiting_fields` in `merchantPending`), non riparte dall'inizio.
5. **Autorità del merchant** — il merchant conosce la sua attività. Non si validano le sue scelte operative (es. bloccare tavoli con capienza diversa dal party). Si validano solo i campi obbligatori per l'integrità del dato in DB.

### Azioni disponibili per tipo di piano

| Azione | Shop | Bookings | Restaurant | Pro |
|--------|:----:|:--------:|:----------:|:---:|
| Catalogo prodotti (add/update/delete/stock/price) | ✅ | — | ✅ (menu) | ✅ |
| Offerte e sconti | ✅ | — | ✅ | ✅ |
| Ordini (list/confirm/cancel/status) | ✅ | — | ✅ | ✅ |
| Servizi (add/update/delete) | — | ✅ | — | ✅ |
| Appuntamenti (list/add/cancel/reschedule/block) | — | ✅ | — | ✅ |
| Prenotazioni tavolo (list/book/block/cancel/confirm) | — | — | ✅ | ✅ |
| Chat takeover (prendi/rilascia chat cliente) | ✅ | ✅ | ✅ | ✅ |
| Broadcast (messaggio a tutti i clienti attivi) | ✅ | ✅ | ✅ | ✅ |
| Clienti (aggiorna nome/email/indirizzo, elimina) | ✅ | ✅ | ✅ | ✅ |
| Orari apertura (aggiorna per giorno o tutti) | ✅ | ✅ | ✅ | ✅ |
| Chiusure straordinarie (ferie, festivi) | ✅ | ✅ | ✅ | ✅ |
| Analytics (ordini, ricavi, clienti per periodo) | ✅ | ✅ | ✅ | ✅ |
| Foto prodotto (invia immagine con caption = nome) | ✅ | — | ✅ | ✅ |

### Flusso tecnico (`routes/webhook.js`)

```
Messaggio merchant → handleMerchantMessage()
    → check takeover attivo → forwarda al cliente
    → check merchantPending (awaiting_fields / candidate selection / yes-no)
    → parseMerchantIntent(messageText, products, services, tenant)
        → Haiku: restituisce {action, product_query, service_query, params, language}
        → tenant.products/services/appointments/restaurant_enabled passati come contesto
    → merchantLang.set(tenant.id, lang)  ← lingua persistita per notifiche
    → featureGate(tenant, action, lang)  ← blocca se modulo non attivo
    → handler specifico per action
        → se campi mancanti → merchantPending.set (awaiting_fields) → chiedi
        → se candidati multipli → merchantPending.set (candidates) → chiedi numero
        → se confirm_one → merchantPending.set (product) → chiedi sì/no
        → esegui azione → risposta localizzata
```

### Azioni non disponibili via bot (solo pannello)

- Upload foto da file (il bot accetta immagini inviate direttamente su WhatsApp)
- Import catalogo da immagini / CSV / Excel
- Configurazione zone e tavoli ristorante
- Configurazione WhatsApp (token, numero)
- Gestione billing / Stripe
- Cambio password / email account
- Export CSV clienti/ordini/prodotti

---

## Foto prodotti

Aggiungi `image_url` ai prodotti (URL pubblico — Supabase Storage consigliato).
Sara include `<SHOW_IMAGE>` nella risposta; webhook intercetta e invia foto prima del testo.

**Upload:**
1. Bucket `product-images` con policy pubblica in Supabase Storage
2. Carica foto → copia URL pubblico → salva in `products.image_url`

---

## Menu ristorante

Tenant con `restaurant_enabled = true` vedono il tab Productos come **vista Menu** dedicata: piatti raggruppati per categoria (= sezione menu), colonne `Piatto | Descrizione | Allergeni | Prezzo | Stato | Azioni`. Niente stock/SKU.

- I piatti vivono nella tabella `products` (riuso, no tabella dedicata). Colonna extra `allergens TEXT`. Stock ignorato (`stock_qty = null` → sempre disponibile).
- **Import foto menu**: `POST /admin/import-from-images` usa prompt vision menu-aware se `restaurant_enabled` — estrae nome, categoria (sezione), descrizione, allergeni per piatto. Riusa pipeline Haiku + import-confirm.
- **Invio menu al cliente**: il menu è SEMPRE generato dal catalogo live, mai una foto cartacea caricata (evita staleness). Sara emette il tag `<SEND_MENU>` quando il cliente chiede la carta; `routes/webhook.js` `buildMenuText()` costruisce il messaggio testo formattato dai products attivi e lo invia. Zero token AI (costruito nel backend), zero storage.
- Foto del singolo piatto su richiesta → meccanismo `<SHOW_IMAGE>` + `products.image_url`.

### Tab admin ristorante (dal 2026-06-20)
- Tenant ristorante: il tab "Turnos" diventa "📅 Prenotazioni" e mostra le `reservations` (vista giornaliera, calendario). Il tab "Restaurante" è solo configurazione.
- Tab Restaurante = config: enable, durata prenotazione, zone, tavoli (creazione in blocco per capienza+quantità), **fasce di servizio** (`tenants.restaurant_meal_bands` JSON — pranzo/cena con start/end). Sara accetta reservas solo dentro le fasce.

### Prenotazioni mesa — capacità e disponibilità (dal 2026-06-21)
- **Multi-tavolo**: `reservations.table_ids` (JSONB, Migration 13) = tutti i tavoli occupati; `table_id` = primario/display. Una prenotazione blocca i tavoli in `table_ids`/`table_id`. Le prenotazioni **senza tavolo assegnato (pending_merchant) NON bloccano** (regola: un pending non deve congelare il locale).
- **Assegnazione Sara** (`routes/webhook.js`): auto-assegna il tavolo libero più piccolo che ospita il party; se nessun tavolo idoneo libero → "completo", non salva e fa proporre a Sara un altro orario. Gruppo > tavolo più grande → `pending_merchant` + notifica WhatsApp al titolare (unione tavoli = decisione manuale). Sara non unisce tavoli da sola.
- **Griglia disponibilità a Sara** (`services/claude.js` `buildAvailabilityBlock`): nel prompt dinamico, slot liberi per i prossimi 7 giorni aperti → Sara propone/conferma SOLO orari con tavoli liberi.
- **Pannello merchant** (`GET /admin/restaurant/availability`): griglia 1/3/7/14 giorni con tavoli liberi per slot; modal "Ocupar mesa" (walk-in) crea una reservation `seated` `customer_name='walk-in'` con `table_ids`, senza ordine completo.
- Modal prenotazione admin: multi-select tavoli; `POST/PUT /admin/restaurant/reservations` accettano `table_ids` (`normTableIds` dedup, `table_id`=primo).

## Catalogo / Menu — import / export / template (dal 2026-06-20)

Stesse "voci" (campi) tra tabella UI, template Excel scaricabile, import CSV e export CSV. Due template separati generati da `scripts/gen-templates.js` (`npm run gen-templates`, dep dev `exceljs`):
- **Catalogo (shop)** `public/catalog_template.xlsx`: `name, category, description, price, stock, sku, available`.
- **Menu (ristorante)** `public/menu_template.xlsx`: `name, category, description, allergens, price, available` (no stock/sku).
- Header file in inglese (chiavi canoniche; l'import accetta alias ES/EN). Ogni file ha 2 fogli istruzioni: "Instructions" (EN) + "Instrucciones" (ES). Metadati workbook con riferimento `sarabot.pro`.
- `GET /admin/catalog-template` serve il template giusto in base a `restaurant_enabled`.
- **Export CSV** (`toCsv` in `routes/admin.js`): delimitatore `;` + riga `sep=;` (Excel apre in colonne) + riga metadati `# sarabot.pro`. Colonne = template → round-trip pulito al reimport.
- **Import** delimiter-aware (`;`/`,`), salta `sep=;` e righe `#`; rileva colonna header anche dopo righe di metadati.
- **Valuta**: prezzi e label currency-aware via `fmtPrice` + token `{cur}` (sostituito in `applyTranslations` / `renderMenu` con `CURRENCY_SYMBOL_MAP[plan_currency]`). `TENANT_CURRENCY` va impostato PRIMA di `applyTranslations` (vedi `showDashboard`).

## Billing SaaS (Stripe)

`routes/billing.js` gestisce l'intero ciclo di vita abbonamento:

| Endpoint | Scopo |
|----------|-------|
| `POST /billing/create-checkout` | Crea Stripe Checkout session (`mode:'subscription'`, trial 7gg) |
| `POST /billing/webhook` | Webhook Stripe: attiva/sospende tenant su `subscription.created/updated/deleted`, log su `invoice.payment_failed` |
| `GET /billing/success` | Redirect post-checkout: attiva tenant + mostra credenziali |
| `POST /billing/cancel` | Cancel at period end (accesso fino a fine periodo) |
| `POST /billing/reactivate` | Annulla cancellazione |

**Env vars richieste:**
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`

**Webhook URL:** `https://sarabot.pro/billing/webhook`
**Events:** `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

Sara Bot non conserva dati di carta — tutto delegato a Stripe (PCI-DSS compliant).

---

## Pagamenti merchant (incasso clienti)

Configura `tenants.payment_instructions` per tenant. Sara include istruzioni dopo conferma ordine.

**Metodi supportati (Paraguay):** Billetera Personal (Tigo), Claro Pay, trasferimento bancario (BNF/Continental/Itaú), PagoExpress.

---

## Appuntamenti

Tenant con `appointments_enabled = true` hanno gestione turni:
- `business_hours` — orari per giorno settimana
- `appointment_blocks` — blocchi orario (chiusure/ferie)
- `appointments` — prenotazioni confermate
- Sara calcola slot liberi 14 giorni in avanti e propone al cliente
- **Capacità parallela** (`tenants.appointment_capacity`, default 1): quanti appuntamenti simultanei nella stessa fascia. 1 = dentista/sala singola; N = studio con N risorse. Uno slot è "pieno" solo quando le sovrapposizioni raggiungono la capacità. `appointment_blocks` bloccano sempre. Configurabile in admin → tab appuntamenti → Horarios.

---

## Aggiungere un nuovo tenant

1. Riga in `tenants`:
```sql
INSERT INTO tenants (name, phone_number_id, bot_name, bot_personality, merchant_phone, payment_instructions)
VALUES ('Nombre del Local', 'META_PHONE_NUMBER_ID', 'Sara', 'cálida y profesional', '595981XXXXXX', 'Instrucciones...');
```
2. Prodotti in `products`
3. Numero WhatsApp Business su Meta Developer Portal
4. Webhook URL: `https://tudominio.com/webhook`
5. Il `phone_number_id` Meta identifica automaticamente il tenant

---

## Struttura DB

| Tabella | Scopo |
|---------|-------|
| `tenants` | Un record per attività cliente |
| `products` | Catalogo + stock per tenant |
| `services` | Servizi (per tenant con appuntamenti) |
| `orders` | Ordini con status workflow |
| `conversations` | Storico messaggi Claude per tenant+cliente |
| `appointments` | Prenotazioni |
| `business_hours` | Orari apertura per giorno |
| `appointment_blocks` | Blocchi orario (chiusure, ferie) |
| `customers` | Anagrafica clienti per tenant |
| `promo_codes` | Codici promozionali (sconto % / fisso, mesi gratis, max usi, valuta) |
| `promo_redemptions` | Riscatti codice per tenant (UNIQUE promo+tenant) |

**Colonne chiave tenants:** `plan_price` (prezzo mensile abbonamento in `plan_currency`), `deactivated_at` (timestamp disattivazione per tracking churn).

**Status ordine:** `pending → confirmed → preparing → delivering → delivered / cancelled`

---

## Scalabilità multi-tenant

- Ogni attività: proprio `phone_number_id` Meta, catalogo, stock, conversazioni
- Un solo server gestisce N tenant in parallelo
- Supabase RLS può isolare dati per tenant

**Costi stimati a regime (50 tenant):**
- Supabase Pro: ~$25/mese
- Claude API: ~$0.001/messaggio (Haiku con caching) × volume
- Deploy (Railway): ~$5-20/mese
- Meta Cloud API: gratuito fino a 1000 conversazioni/mese per tenant
- Stripe: 0.5-0.7% per transazione SaaS

---

## Pannelli web

| Route | Descrizione |
|-------|-------------|
| `/admin` | Pannello merchant: catalogo, ordini, chat, clienti, appuntamenti, piano (con riscatto codice promo) |
| `/superadmin` | Gestione piattaforma: tutti i tenant, analytics, promo codes, soporte |
| `/register` | Registrazione nuovo tenant (con i18n ES/EN/IT/DE/FR) |
| `landingpage/` | Landing pubblica |

### Superadmin — tab principali

| Tab | Contenuto |
|-----|-----------|
| 🏪 Clientes | Lista tenant con stato (✅ Activo / 🔵 Sin Meta / 🟠 Moroso / 🔴 Inactivo), edit modal, impersonare |
| 📊 Analytics | Card per stato, MRR per valuta, grafici SVG registrazioni/pedidos/churn per mese |
| 🎟️ Promos | CRUD codici promozionali — crea/modifica/elimina/disattiva; ogni codice ha tipo sconto, valore, mesi gratis, max usi, valuta, scadenza |
| 💬 Soporte | Chat in-app con merchant, badge unread |

### Status tenant (superadmin)

| Badge | Condizione |
|-------|-----------|
| ✅ Activo | `active=true`, piano non scaduto, `whatsapp_token` presente |
| 🔵 Sin Meta | `active=true`, piano non scaduto, ma `whatsapp_token` NULL (usa token globale env) |
| 🟠 Moroso | `active=true` ma `plan_expires` passato |
| 🔴 Inactivo | `active=false` |

### Promo codes — logica riscatto

`POST /admin/redeem-promo` — validazioni in ordine:
1. Codice esiste e `active=true`
2. Non scaduto (`expires_at`)
3. Non esaurito (`uses_count < max_uses` oppure `max_uses=null`)
4. Valuta tenant compatibile (`valid_for_currency=null` accetta tutti)
5. Tenant non ha già riscattato questo codice (UNIQUE su `promo_redemptions`)

Effetti applicati al tenant:
- `discount_type=percent` → `plan_price * (1 - value/100)`
- `discount_type=fixed` → `plan_price - value` (min 0)
- `months_free > 0` → estende `plan_expires` da oggi o dalla scadenza attuale

### i18n — architettura traduzioni

Tutte le pagine condividono la chiave `sara_lang` in `localStorage`. Lingua cambiata su qualsiasi pagina si propaga a tutte le altre.

| File | Contenuto |
|------|-----------|
| `public/admin/i18n.js` | TR object admin (~2700 righe, 6 lingue: ES/EN/IT/DE/FR/PT) |
| `public/register/i18n.js` | TR object register (~800 righe, 6 lingue) |
| `landingpage/index.html` | TR inline (landing — pagina autonoma) |
| `public/legal/*.html` | setLang inline per-file, legge `sara_lang`, scrive su entrambe `legal_lang` e `sara_lang` |

Per aggiungere/modificare traduzioni admin: edita `public/admin/i18n.js` direttamente — non toccare `index.html`. Stesso pattern per register.

### Errori backend tradotti

`routes/admin.js` include `errorCode` nelle risposte errore utente-visibili. Il frontend usa `errMsg(e)` (definita in `admin/index.html`) che restituisce `t('err.' + e.code)` se la chiave esiste, altrimenti `e.message` come fallback.

Codici attivi: `unauthorized`, `token_expired`, `suspended`, `plan_expired`, `rate_limit`, `wrong_credentials`, `password_too_short`. Chiavi `err.*` in `public/admin/i18n.js`.

Per aggiungere un nuovo errore tradotto: 1) aggiungi `errorCode: 'my_code'` alla risposta in `admin.js`; 2) aggiungi `'err.my_code': '...'` in tutte e 6 le sezioni lingua di `i18n.js`.

---

## Tenant di demo inclusi

1. **Florería Las Orquídeas** — fioreria, Asunción Paraguay
2. **Pastelería Dulce Sueño** — pasticceria, Asunción Paraguay
