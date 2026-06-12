# WhatsApp Bot SaaS — Guida Operativa

## Stack tecnico
- **Node.js + Express** — server webhook
- **Supabase** — database PostgreSQL + autenticazione + storage immagini
- **Claude AI (claude-sonnet-4-6)** — motore conversazionale (Sara)
- **Meta Cloud API** — invio/ricezione messaggi WhatsApp
- **Deploy** — Railway / Fly.io / Render (qualsiasi piattaforma Node.js)

---

## Flusso completo per un tenant

```
Cliente WhatsApp → Meta Cloud API → /webhook
    → identifica tenant da phone_number_id
    → carica stock + storico conversazione
    → Claude (Sara) risponde
    → se ordine confermato → notifica merchant
    → merchant risponde CONFIRMAR/CANCELAR/CHAT
    → aggiorna DB → notifica cliente
```

---

## Human Takeover

Quando Sara rileva un ordine confermato:
1. Salva ordine con `status: 'pending'`
2. Invia al merchant (numero configurato in `tenants.merchant_phone`):

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

Il merchant risponde con:
- **CONFIRMAR** → ordine diventa `confirmed`, cliente riceve conferma + istruzioni pagamento
- **CANCELAR** → ordine diventa `cancelled`, cliente riceve notifica
- **CHAT** → modalità takeover attiva: merchant e cliente si parlano direttamente attraverso il bot
- **FIN** → termina takeover, Sara riprende il chat

---

## Foto prodotti

Aggiungi `image_url` ai prodotti (URL pubblico — Supabase Storage consigliato).

Quando il cliente chiede di un prodotto, Sara include automaticamente il tag `<SHOW_IMAGE>` nella risposta. Il webhook intercetta il tag e invia la foto prima del testo.

**Upload foto su Supabase Storage:**
1. Crea bucket `product-images` con policy pubblica
2. Carica la foto
3. Copia l'URL pubblico e salvalo in `products.image_url`

---

## Pagamenti Paraguay

Configura `tenants.payment_instructions` con le istruzioni per il tenant:

```
Podés pagar por 📱 Billetera Personal al número 0981-000-001 (Las Orquídeas)
o por transferencia bancaria a la cuenta BNF Nro. 000-123456.
Envianos el comprobante por este chat 🧾
```

Sara include automaticamente queste istruzioni dopo la conferma dell'ordine.
Il merchant le include di nuovo quando conferma manualmente via CONFIRMAR.

**Metodi supportati in Paraguay:**
- Billetera Personal (Tigo)
- Billetera Claro Pay
- Transferencia bancaria (BNF, Continental, Itaú)
- PagoExpress

---

## Aggiungere un nuovo tenant

1. Inserisci riga in `tenants`:
```sql
INSERT INTO tenants (name, phone_number_id, bot_name, bot_personality, merchant_phone, payment_instructions)
VALUES ('Nombre del Local', 'META_PHONE_NUMBER_ID', 'Sara', 'cálida y profesional', '595981XXXXXX', 'Instrucciones de pago...');
```

2. Inserisci prodotti in `products`

3. Configura un numero WhatsApp Business su Meta per il tenant

4. Imposta webhook URL sul Meta Developer Portal: `https://tudominio.com/webhook`

5. Tutto funziona automaticamente — il `phone_number_id` di Meta identifica il tenant.

---

## Struttura DB

| Tabella | Scopo |
|---|---|
| `tenants` | Un record per ogni attività cliente |
| `products` | Catalogo + stock per tenant |
| `orders` | Ordini con status workflow |
| `conversations` | Storico messaggi Claude per tenant+cliente |

**Status ordine:** `pending` → `confirmed` → `preparing` → `delivering` → `delivered` / `cancelled`

---

## Scalabilità multi-tenant

Il sistema è già multi-tenant by design:
- Ogni attività ha il suo `phone_number_id` Meta
- Ogni attività ha il suo catalogo, stock, conversazioni
- Un solo server gestisce N tenant in parallelo
- Supabase Row Level Security (RLS) può isolare i dati per tenant

**Costi stimati a regime (50 tenant):**
- Supabase Pro: ~$25/mese
- Claude API: ~$0.003/messaggio (Sonnet) × volume messaggi
- Deploy (Railway): ~$5-20/mese
- Meta Cloud API: gratuito fino a 1000 conversazioni/mese per tenant

---

## Tenant di demo inclusi

1. **Florería Las Orquídeas** — fioreria, Asunción Paraguay
2. **Pastelería Dulce Sueño** — pasticceria, Asunción Paraguay

Entrambi con catalogo, foto prodotti, merchant phone e istruzioni di pagamento configurate.
