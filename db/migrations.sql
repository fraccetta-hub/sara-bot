-- ============================================================
-- Migrations — run in Supabase SQL editor after schema.sql
-- ============================================================

-- Migration 8: Billing tracking + churn tracking
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS plan_price      NUMERIC(10,2) DEFAULT 0,   -- monthly subscription fee in plan_currency
  ADD COLUMN IF NOT EXISTS deactivated_at  TIMESTAMPTZ;               -- set when active goes false, cleared on reactivation

-- Migration: email-confirmed account deletion (anti-malicious-employee)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS account_deletion_token   TEXT,
  ADD COLUMN IF NOT EXISTS account_deletion_expires TIMESTAMPTZ;

-- Migration: track Stripe cancel-at-period-end so the Plan tab shows Cancel vs Reactivate
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end BOOLEAN DEFAULT false;

-- Migration: support chat (merchant ↔ bot ↔ superadmin). Was created manually
-- before; documented here with the FK so PostgREST embeds resolve correctly.
CREATE TABLE IF NOT EXISTS support_messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('merchant','assistant','support')),
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_tenant ON support_messages(tenant_id, created_at);

-- Migration 9: Promo codes
CREATE TABLE IF NOT EXISTS promo_codes (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT          NOT NULL UNIQUE,
  description          TEXT,
  discount_type        TEXT          NOT NULL DEFAULT 'percent'
                                     CHECK (discount_type IN ('percent','fixed')),
  discount_value       NUMERIC(10,2) NOT NULL DEFAULT 0,
  months_free          INTEGER       NOT NULL DEFAULT 0,
  max_uses             INTEGER,                                        -- null = unlimited
  uses_count           INTEGER       NOT NULL DEFAULT 0,
  valid_for_currency   TEXT,                                           -- null = all currencies
  expires_at           TIMESTAMPTZ,
  active               BOOLEAN       NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id    UUID        NOT NULL REFERENCES promo_codes(id),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  discount_applied NUMERIC(10,2),
  months_added     INTEGER,
  redeemed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (promo_code_id, tenant_id)
);

-- Migration 10: Restaurant menu — allergens per dish (reuses products table)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS allergens TEXT;   -- free text, e.g. "gluten, lácteos, frutos secos"

-- Migration 11: Parallel appointment capacity per slot (dentist=1, clinic with N chairs=N)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS appointment_capacity INTEGER NOT NULL DEFAULT 1;

-- Migration 12: Restaurant meal service bands (lunch/dinner windows). JSON: [{label,start,end}]
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS restaurant_meal_bands JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Migration 13: Multi-table reservations (a large group can occupy several joined tables).
-- table_ids holds ALL tables the reservation blocks; table_id stays as the primary/display
-- table. Only reservations WITH assigned tables block availability — pending ones never do.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS table_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Backfill existing single-table reservations into the array form.
UPDATE reservations SET table_ids = jsonb_build_array(table_id)
  WHERE table_id IS NOT NULL AND (table_ids IS NULL OR table_ids = '[]'::jsonb);

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
-- Migration 5: Services catalog
-- ============================================================

-- 5a. Tenants: enable/disable products and services sections independently
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS products_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS services_enabled BOOLEAN NOT NULL DEFAULT false;

-- 5b. Services catalog (separate from products)
CREATE TABLE IF NOT EXISTS services (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  category      TEXT,
  description   TEXT,
  price_type    TEXT        NOT NULL DEFAULT 'fixed'
                            CHECK (price_type IN ('fixed','hourly')),
  price_guarani INTEGER     NOT NULL DEFAULT 0,
  duration_min  INTEGER,
  is_available  BOOLEAN     NOT NULL DEFAULT true,
  image_url     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_services_tenant ON services(tenant_id);

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

-- Migration 14: Email-confirmed phone change + username change columns (if not already present)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS pending_merchant_phone TEXT,
  ADD COLUMN IF NOT EXISTS phone_change_token     TEXT,
  ADD COLUMN IF NOT EXISTS phone_change_expires   TIMESTAMPTZ;

-- Migration 15: Appointment paid status + price
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS paid          BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_guarani INTEGER;

-- Migration 16: Appointment refund/storno flag
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS refunded BOOLEAN NOT NULL DEFAULT false;

-- Migration 17: Service mobility (at-client service for bookings plan)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS service_location       TEXT    NOT NULL DEFAULT 'own',
  ADD COLUMN IF NOT EXISTS service_fee_type       TEXT    NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS service_base_fee       INTEGER          DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_zone_km        NUMERIC          DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_zone_outer_fee INTEGER          DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_per_km         INTEGER          DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_min_value      INTEGER          DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_disabled_dates TEXT;
