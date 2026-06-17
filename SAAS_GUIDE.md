# WhatsApp Bot SaaS — Guida Operativa

_Aggiornato: 2026-06-17_

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

## Foto prodotti

Aggiungi `image_url` ai prodotti (URL pubblico — Supabase Storage consigliato).
Sara include `<SHOW_IMAGE>` nella risposta; webhook intercetta e invia foto prima del testo.

**Upload:**
1. Bucket `product-images` con policy pubblica in Supabase Storage
2. Carica foto → copia URL pubblico → salva in `products.image_url`

---

## Pagamenti

Configura `tenants.payment_instructions` per tenant. Sara include istruzioni dopo conferma ordine.

**Metodi supportati (Paraguay):** Billetera Personal (Tigo), Claro Pay, trasferimento bancario (BNF/Continental/Itaú), PagoExpress.

---

## Appuntamenti

Tenant con `appointments_enabled = true` hanno gestione turni:
- `business_hours` — orari per giorno settimana
- `appointment_blocks` — blocchi orario (chiusure/ferie)
- `appointments` — prenotazioni confermate
- Sara calcola slot liberi 14 giorni in avanti e propone al cliente

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
| `/admin` | Pannello merchant: catalogo, ordini, chat, clienti, appuntamenti |
| `/superadmin` | Gestione piattaforma: tutti i tenant, billing, metriche |
| `/register` | Registrazione nuovo tenant (con i18n ES/EN/IT/DE/FR) |
| `landingpage/` | Landing pubblica |

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
