-- ============================================================
-- Migrations — run in Supabase SQL editor after schema.sql
-- ============================================================
-- PRIMA DI TUTTO: crea il bucket per le foto su Supabase Storage
-- Supabase Dashboard → Storage → New bucket
-- Nome: product-images
-- Public bucket: ✅ SÌ (le foto devono essere accessibili pubblicamente)
-- ============================================================

-- 1. Tenant: merchant contact + payment info + admin panel auth
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS merchant_phone        TEXT,          -- WhatsApp number that receives order alerts
  ADD COLUMN IF NOT EXISTS payment_instructions  TEXT,          -- shown to customer after order confirmed
  ADD COLUMN IF NOT EXISTS admin_password_hash   TEXT;          -- bcrypt hash for admin panel login

-- 2. Products: photo support
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT;                      -- public URL (Supabase Storage or any CDN)

-- 3. Conversations: takeover state + customer name
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS customer_name              TEXT,                 -- extracted from chat or set by merchant
  ADD COLUMN IF NOT EXISTS takeover_active            BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS takeover_started_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_pending_order_id      UUID        REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_pending_customer_phone TEXT;     -- cached to route merchant→customer replies

-- ============================================================
-- Update sample tenant with merchant phone + payment info
-- ============================================================
UPDATE tenants
SET
  merchant_phone        = '595981000001',   -- replace with real merchant WhatsApp number
  payment_instructions  = 'Podés pagar por 📱 *Billetera Personal* al número *0981-000-001* (Las Orquídeas) o por *transferencia bancaria* a la cuenta BNF Nro. 000-123456 a nombre de Florería Las Orquídeas. Envianos el comprobante por este chat 🧾'
WHERE name = 'Florería Las Orquídeas';

-- Add image URLs to sample products (use real Supabase Storage URLs in production)
UPDATE products
SET image_url = 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600'  -- red roses
WHERE name = 'Ramo de Rosas Rojas (12 unidades)';

UPDATE products
SET image_url = 'https://images.unsplash.com/photo-1487530811015-780cb2f3de30?w=600'  -- mixed flowers
WHERE name = 'Arreglo Floral Mixto';

UPDATE products
SET image_url = 'https://images.unsplash.com/photo-1566908829550-e6551b00979b?w=600'  -- orchid
WHERE name = 'Orquídea en Maceta';

-- ============================================================
-- Migration 4: Delivery system
-- ============================================================

-- 4a. Tenants: full delivery config
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS login_slug              TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS delivery_enabled        BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS location_address        TEXT,
  ADD COLUMN IF NOT EXISTS delivery_type           TEXT        NOT NULL DEFAULT 'fixed'
                                                   CHECK (delivery_type IN ('fixed','zone','per_km')),
  ADD COLUMN IF NOT EXISTS delivery_zone_km        NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS delivery_zone_outer_fee INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_min_order      INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_disabled_dates TEXT[]      NOT NULL DEFAULT '{}';

-- 4c. Tenants: free-text custom business rules injected into Claude system prompt
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS custom_instructions TEXT;

-- 4b. Conversations: delivery state per active conversation
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS delivery_choice         TEXT        CHECK (delivery_choice IN ('retiro','envio')),
  ADD COLUMN IF NOT EXISTS delivery_lat            NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS delivery_lng            NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS delivery_address_text   TEXT,
  ADD COLUMN IF NOT EXISTS delivery_fee_calc       INTEGER;

-- ============================================================
-- Second sample tenant: Pastelería (for buyer demos)
-- ============================================================
INSERT INTO tenants (name, phone_number_id, bot_name, bot_personality, location_lat, location_lng, merchant_phone, payment_instructions)
VALUES (
  'Pastelería Dulce Sueño',
  'PHONE_NUMBER_ID_PASTELERIA',   -- replace with real Meta phone number ID
  'Sara',
  'dulce, creativa y muy atenta a los detalles',
  -25.2900,
  -57.6500,
  '595981000002',
  'Pagá por 📱 *Billetera Personal* al *0981-000-002* (Dulce Sueño) o por transferencia a cuenta Familiar Nro. 000-654321. Mandanos el comprobante y te confirmamos el pedido 🎂'
) ON CONFLICT DO NOTHING;

INSERT INTO products (tenant_id, name, category, price_guarani, stock_qty, description, image_url)
SELECT id,
  unnest(ARRAY['Torta de Chocolate (kg)', 'Alfajores x12', 'Cheesecake de Frutos Rojos', 'Medialunas x6']),
  unnest(ARRAY['Tortas', 'Galletitas', 'Tortas', 'Facturas']),
  unnest(ARRAY[120000, 45000, 95000, 25000]),
  unnest(ARRAY[5, 30, 8, 20]),
  unnest(ARRAY[
    'Torta húmeda con ganache de chocolate belga, ideal para cumpleaños',
    'Alfajores de maicena rellenos de dulce de leche, bañados en chocolate',
    'Base de galletitas, relleno cremoso y coulis de frutillas y arándanos',
    'Medialunas de manteca, recién horneadas cada mañana'
  ]),
  unnest(ARRAY[
    'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600',
    'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=600',
    'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?w=600',
    'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600'
  ])
FROM tenants WHERE name = 'Pastelería Dulce Sueño';
