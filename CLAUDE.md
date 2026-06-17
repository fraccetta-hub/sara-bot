# CLAUDE.md — Sara Bot (whatsapp-bot)

## Progetto

SaaS multi-tenant WhatsApp Business. Node/Express + Supabase + Anthropic Claude.
Bot AI (Sara) risponde a clienti, gestisce catalogo, delivery, appuntamenti, ordini.
Landing page + pannello admin + superadmin + billing/Stripe.

**Stato attuale:** ottimizzazione efficienza (token AI, query DB). Leggi HANDOFF.md prima di ogni sessione.

---

## Regole globali

### i18n — OBBLIGATORIO
Ogni nuovo testo UI (HTML, JS frontend) deve avere traduzione in **ES / EN / IT / DE / FR**.
Usa `data-i18n` + chiavi `TR`. Mai stringhe hardcoded nell'UI.

### Sicurezza
- NON leggere/query tabella prod `tenants` con `select('*')` senza autorizzazione esplicita per quella lettura.
- Dati sensibili merchant: `token WhatsApp`, `merchant_phone`, credenziali pagamento — trattare come PII.

### Stile codice
- Zero commenti tranne WHY non ovvio (constraint nascosta, workaround bug specifico).
- No error handling per scenari impossibili. Valida solo ai boundary (input utente, API esterne).
- No feature flags, no compat shim — cambia il codice direttamente.

---

## Selezione modello — usa il modello giusto per ogni task

| Task | Modello |
|------|---------|
| Chat cliente (webhook conversazionale) | `claude-haiku-4-5-20251001` |
| Import catalogo da foto (vision JSON) | `claude-haiku-4-5-20251001` (era Opus — vedere HANDOFF #3) |
| Ragionamento complesso / multi-step | `claude-sonnet-4-6` |
| Task ultra-pesanti / creatività | `claude-opus-4-8` |

Regola: parti sempre dal modello più economico che può fare il task. Scala su solo se la qualità è insufficiente.

---

## File chiave

| File | Ruolo |
|------|-------|
| `services/claude.js` | System prompt (static+dynamic+caching), chiamata Anthropic, parsing tag |
| `routes/webhook.js` | Entry point webhook WhatsApp, `handleCustomerMessage`, `handleMerchantMessage` |
| `routes/admin.js` | Pannello tenant, import catalogo da immagini |
| `routes/superadmin.js` | Gestione piattaforma (tutti i tenant) |
| `routes/billing.js` | Stripe subscription |
| `services/stock.js` | `getTenantConfig`, `getStock`, `getServices` |
| `services/geo.js` | `isDeliveryDisabledToday`, `describeDelivery` |
| `public/admin/index.html` | UI admin (polling attivo: 3-15s interval — non toccare senza motivo) |
| `public/admin/i18n.js` | **Traduzioni admin** (TR object, ES/EN/IT/DE/FR/PT) — edita qui per i18n admin |
| `public/register/i18n.js` | **Traduzioni register** (TR object, ES/EN/IT/DE/FR/PT) — edita qui per i18n register |
| `landingpage/index.html` | Landing pubblica |
| `SAAS_GUIDE.md` | Documentazione tecnica aggiornata del progetto |
| `HANDOFF.md` | Stato corrente sessione, task in sospeso, trappole note |

---

## Ottimizzazioni già implementate

1. **Prompt caching** (`services/claude.js`): blocco static (catalogo, regole) ha `cache_control: {type:'ephemeral'}`. Dynamic block separato — non cacheato. Caching confermato con `cache_read_input_tokens`.
2. **Appointment keyword-gating** (`routes/webhook.js`): query `business_hours` / `appointments` / `appointment_blocks` + calcolo slot 14gg girano solo se messaggio o ultimi 4 msg history menzionano booking.

## Ottimizzazioni pendenti (HANDOFF)

- **#3** — `routes/admin.js:856` / `routes/superadmin.js:286`: Opus → Haiku vision per import-from-images
- **#4** — `routes/webhook.js` `handleMerchantMessage`: query `conversations` evitabile per messaggi non-comando-catalogo
- **#5** — `services/stock.js`: TTL 30-60s in-memory cache per `getTenantConfig`/`getStock`/`getServices`

---

## Architettura Anthropic prompt caching

```
Static block (cache_control: ephemeral)
  └── identità bot, catalogo, regole sicurezza, istruzioni pagamento
Dynamic block (no cache)
  └── stato delivery oggi, slot appuntamenti disponibili
```

Soglia minima caching Haiku-tier: ~4096 token. Verifica con `response.usage.cache_creation_input_tokens`.

---

## DB Schema essenziale

| Tabella | Scopo |
|---------|-------|
| `tenants` | Un record per attività cliente |
| `products` | Catalogo + stock per tenant |
| `services` | Servizi (per tenant con appuntamenti) |
| `orders` | Ordini con workflow status |
| `conversations` | Storico messaggi per tenant+cliente |
| `appointments` | Prenotazioni |
| `business_hours` | Orari per tenant |
| `appointment_blocks` | Blocchi orario (chiusure, ferie) |

Status ordine: `pending → confirmed → preparing → delivering → delivered / cancelled`

---

## Manutenzione documenti

- **SAAS_GUIDE.md** — aggiorna dopo ogni cambiamento significativo all'architettura, stack, flussi principali.
- **HANDOFF.md** — aggiorna dopo ogni azione rilevante: aggiungi a "COSA È STATO FATTO", sposta task da pendenti a completati, aggiorna "COME RIPRENDERE".

---

## Compressione contesto

Quando la chat sta diventando lunga (> ~15 scambi o avverti contesto pieno), esegui:
```
/compress
```
Prima di `/compress`, aggiorna HANDOFF.md con lo stato corrente così la sessione successiva può ripartire pulita.
