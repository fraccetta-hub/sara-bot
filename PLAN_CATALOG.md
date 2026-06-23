# PLAN — Integrazione Catalogo WhatsApp nativo

> Stato: **proposta, non iniziato**. Creato 2026-06-23.
> Obiettivo: sincronizzare il catalogo del gestionale (tabella `products`) con il
> **catalogo commerce nativo di WhatsApp**, così i clienti vedono la vetrina +
> carrello dentro WhatsApp. Opt-in per tenant, auto-sync, zero attriti per merchant.

---

## Principi guida

1. **Opt-in, mai obbligatorio.** Gate per tenant via `catalog_sync_enabled`.
2. **A prova di non-tecnico.** Il merchant tipo = signora 50enne, poca dimestichezza.
   Attivazione = 1 tap. Nessun ID/token/gergo Meta visibile. Tutto il lavoro è server-side.
3. **Auto-sync.** Il merchant non sincronizza mai a mano: i prodotti vanno sul catalogo
   automaticamente quando li crea/modifica/elimina. Bottone "Re-sincronizza" solo come fallback.
4. **Solo prodotti.** Gate `products_enabled || restaurant_enabled`. Servizi/appuntamenti
   restano conversazionali (il carrello non ha semantica di prenotazione).
5. **Non distruttivo.** Errori di sync salvati, mai bloccano il salvataggio nel pannello
   né l'onboarding.

---

## Limiti Meta (verificati / da verificare)

- **Pagamento in chat (WhatsApp Pay):** NON disponibile in Paraguay. Il carrello genera
  l'ordine; il pagamento resta col flusso attuale (`payment_instructions`).
- **Valuta PYG:** supportata (confermato dall'utente).
- **Servizi nel catalogo:** sconsigliato — niente scelta slot nel carrello.
- **Permesso `catalog_management`:** NON è nel codice. Si concede nella **Login Configuration**
  del `config_id` Embedded Signup (Meta App Dashboard) + **App Review**. Serve anche
  `business_management` per creare/possedere cataloghi.
- **Tenant già connessi:** il loro token ha solo `whatsapp_business_*`. Per ottenere
  `catalog_management` devono **riconnettere** (rifare Embedded Signup). I nuovi lo avranno.

---

## FASE 0 — Prerequisiti Meta (fuori dal codice, responsabile: utente)

- [ ] Aggiungere `catalog_management` + `business_management` alla Login Config del `config_id`
- [ ] App Review per i permessi commerce
- [ ] Verificare commerce abilitato sul WABA in PY

> Senza Fase 0 il codice non gira in produzione, ma si può costruire e testare in sandbox.

---

## FASE 1 — Schema DB

`tenants`:
- `wa_catalog_id TEXT` — id catalogo Meta del tenant
- `catalog_sync_enabled BOOLEAN NOT NULL DEFAULT false` — opt-in
- `catalog_synced_at TIMESTAMPTZ`

`products`:
- `wa_retailer_id TEXT` — id stabile lato Meta (= `id` UUID del prodotto)
- `wa_sync_error TEXT` — errore per-prodotto (null = ok)
- `additional_images TEXT[]` — foto extra per la vetrina nativa (max ~9)

Migration idempotente in `db/migrations.sql` + aggiornare `db/schema.sql`.

---

## FASE 2 — Engine di sync (`services/catalog.js`, nuovo)

- `ensureCatalog(tenant)` → se manca `wa_catalog_id`: crea catalogo
  (`POST /{business-id}/owned_product_catalogs`), collega al WABA, abilita commerce
  sul numero, salva `wa_catalog_id`. Idempotente.
- `pushProduct(tenant, product)` → upsert singolo via Catalog Items Batch API.
- `pushAllProducts(tenant)` → batch completo. Ritorna `{synced, errors}`.
- `removeProduct(tenant, retailerId)` → delete dal catalogo.
- `disableCatalog(tenant)` → set flag false (opzionale: svuota catalogo).

Mappatura item:
| Catalogo Meta | Fonte | Obbligatorio Meta |
|---|---|---|
| `retailer_id` | `product.id` | ✅ |
| `name` | `product.name` | ✅ |
| `description` | `product.description` | ✅ (non vuota) |
| `price` | `product.price_guarani` (formato minore richiesto da Meta) | ✅ |
| `currency` | `'PYG'` | ✅ |
| `image_link` | `product.image_url` | ✅ (≥500×500) |
| `additional_image_link` | `product.additional_images` | opzionale (max ~9) |
| `availability` | `is_available ? 'in stock' : 'out of stock'` | ✅ |
| `condition` | `'new'` (default) | ✅ |
| `url`/`link` | opzionale per catalogo solo-WhatsApp (placeholder se l'API lo pretende) | — |

**Validazione campi minimi** (`validateForCatalog(product)`): prima del push verifica
name + description non vuota + image_url + price. Se manca qualcosa → NON pushare,
scrivi `wa_sync_error` (es. "manca foto" / "manca descrizione"). Mai bloccare il
salvataggio nel pannello.

Best-effort: ogni errore → `products.wa_sync_error`, mai throw verso il chiamante.

---

## FASE 3 — Wizard onboarding (step condizionale)

Nuovo step nel wizard (`public/admin/index.html`), inserito dopo connessione WhatsApp.

**Visibilità:** solo se `products_enabled || restaurant_enabled`. Omesso per solo-servizi.

**UX (1 tap, zero tecnicismi):**
- Titolo: "📦 Mostra i tuoi prodotti su WhatsApp"
- Disclaimer 1 frase: integra catalogo gestionale ↔ vetrina WhatsApp, clienti sfogliano + carrello
- Bottoni: **[Attiva]** (verde) · **[Più tardi]**
- Su Attiva: spinner "Sto collegando..." → `ensureCatalog` → ✅ "Fatto!"
- Nota piccola: "Puoi attivarlo/disattivarlo dalle Impostazioni"
- Su fallimento: messaggio gentile + prosegue comunque (non blocca onboarding)

> Al momento del wizard i prodotti sono ~0: lo step crea solo catalogo + flag.
> Il push avviene poi via auto-sync (Fase 4).

i18n 6 lingue (ES/EN/IT/DE/FR/PT): chiavi `wiz.cat.*`.

---

## FASE 4 — Auto-sync (gira solo se `catalog_sync_enabled`)

Aggancio agli endpoint esistenti in `routes/admin.js`:
- `POST /admin/products` → `pushProduct`
- `PUT /admin/products/:id` → `pushProduct`
- `DELETE /admin/products/:id` → `removeProduct`
- Import bulk + Foto IA → `pushAllProducts` a fine import
Tutto best-effort, non blocca la risposta del pannello.

---

## FASE 5 — UI pannello Prodotti (+ Menu)

- Toggle "Catalogo WhatsApp: ON/OFF" → setta `catalog_sync_enabled`
  - Accendere da OFF = punto di **riattivazione**: riusa lo step wizard
    (disclaimer → `ensureCatalog` → `pushAllProducts`)
- Bottone "Re-sincronizza tutto" (fallback → `pushAllProducts`)
- Badge stato per prodotto: sincronizzato ✅ / errore ⚠️ (tooltip = `wa_sync_error`,
  es. "manca foto/descrizione per WhatsApp")
- **Upload multi-foto** nel form prodotto: 1 principale (`image_url`) + extra
  (`additional_images`, max ~9). Drag&drop, riordino, rimozione singola.
- i18n 6 lingue.

---

## FASE 6 — Sara invia prodotti (`services/claude.js` + `routes/webhook.js`)

- Nuovo tag `<SEND_PRODUCTS:retailer_id1,retailer_id2>` → Multi-Product Message
  (`interactive` type `product_list`).
- Sara lo usa quando il cliente chiede prodotti, **solo se** `catalog_sync_enabled`.
- Fallback al testo+foto attuale se catalogo off.

---

## FASE 7 — Carrello → ordine (`routes/webhook.js`)

- Gestire messaggi in entrata type `order` (oggetto `order.product_items`:
  `product_retailer_id`, `quantity`, `item_price`).
- Mappa `product_retailer_id` → prodotto → crea record `orders` (riusa flusso esistente).
- Sara conferma e invia `payment_instructions` (pagamento fuori da WhatsApp in PY).

Modello universale, funziona ovunque (anche dove non c'è pagamento nativo).
**La piattaforma non processa mai denaro.**

---

## FASE 7b — Pagamento nativo WhatsApp (opzionale, region-gated)

Solo nei paesi dove Meta offre il checkout/pagamento in chat (India, Brasile, ecc.).
Il pagamento è **tra merchant e Meta/provider** — la piattaforma resta fuori dai soldi.

- Campo opzionale per-tenant: `payment_configuration` (nome config che il merchant
  ha creato con Meta/provider). Mai chiavi/credenziali di pagamento lato nostro.
- Se presente: Sara/checkout invia `order_details` con il riferimento alla config;
  Meta gestisce il pagamento nativamente.
- Se assente o paese non supportato: fallback alla Fase 7 (ordine + pagamento offline).
- **Non implementare alcun processing di pagamento.** Solo passthrough del riferimento.

> Da fare solo se/quando ci sono merchant in paesi con WhatsApp Pay. Per PY: salta.

---

## FASE 8 — Test + rollout

- Tenant di test + catalogo sandbox.
- Verifica end-to-end: sync prodotto → product message → checkout carrello → ordine creato.
- Rollout opt-in, monitorare `wa_sync_error`.

---

## Decisioni aperte

- Disattivazione catalogo: solo flag off, oppure anche svuotare il catalogo Meta? (default: solo flag)
- Restaurant menu: stesso engine dei prodotti (tabella `products` con `restaurant_enabled`) — confermare.
