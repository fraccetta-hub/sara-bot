-- ============================================================
-- WhatsApp Bot SaaS — Database Schema
-- Run this in the Supabase SQL editor
-- ============================================================

-- Tenants: one row per florist / pastry shop
CREATE TABLE tenants (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT          NOT NULL,
  active                BOOLEAN       NOT NULL DEFAULT true,
  plan_expires          TIMESTAMPTZ,
  phone_number_id       TEXT          NOT NULL UNIQUE,
  whatsapp_token        TEXT,
  bot_name              TEXT          NOT NULL DEFAULT 'Sara',
  bot_personality       TEXT          NOT NULL DEFAULT 'cálida, profesional y entusiasta',
  location_lat          NUMERIC(10,7),
  location_lng          NUMERIC(10,7),
  delivery_base_fee     INTEGER       NOT NULL DEFAULT 5000,
  delivery_per_km       INTEGER       NOT NULL DEFAULT 1000,
  merchant_phone        TEXT,                                    -- WhatsApp number for order alerts & human takeover
  payment_instructions  TEXT,                                    -- shown to customer after confirmed order
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Products catalog — one row per SKU per tenant
CREATE TABLE products (
  id            UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT      NOT NULL,
  category      TEXT,
  price_guarani INTEGER   NOT NULL,
  stock_qty     INTEGER   NOT NULL DEFAULT 0,
  description   TEXT,
  image_url     TEXT,                                            -- public URL (Supabase Storage or CDN)
  is_available  BOOLEAN   NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orders placed by customers via the bot
CREATE TABLE orders (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_phone  TEXT        NOT NULL,
  items_json      JSONB       NOT NULL,   -- [{"name":"...", "qty":1, "price_guarani":12345}]
  total_guarani   INTEGER     NOT NULL DEFAULT 0,
  delivery_fee    INTEGER     NOT NULL DEFAULT 0,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','confirmed','preparing','delivering','delivered','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversation history per customer per tenant (multi-turn Claude context)
CREATE TABLE conversations (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_phone              TEXT        NOT NULL,
  messages_json               JSONB       NOT NULL DEFAULT '[]',
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  takeover_active             BOOLEAN     NOT NULL DEFAULT false,
  takeover_started_at         TIMESTAMPTZ,
  last_pending_order_id       UUID        REFERENCES orders(id) ON DELETE SET NULL,
  last_pending_customer_phone TEXT,
  UNIQUE (tenant_id, customer_phone)
);

-- Indexes
CREATE INDEX idx_products_tenant       ON products(tenant_id);
CREATE INDEX idx_orders_tenant         ON orders(tenant_id);
CREATE INDEX idx_orders_customer       ON orders(customer_phone);
CREATE INDEX idx_orders_created        ON orders(created_at DESC);
CREATE INDEX idx_conversations_lookup  ON conversations(tenant_id, customer_phone);

-- ============================================================
-- Sample tenant + products (edit values as needed)
-- ============================================================

INSERT INTO tenants (name, phone_number_id, bot_name, bot_personality, location_lat, location_lng)
VALUES (
  'Florería Las Orquídeas',
  '1172627905930070',
  'Sara',
  'cálida, apasionada por las flores y muy profesional',
  -25.2867,
  -57.6470
);

INSERT INTO products (tenant_id, name, category, price_guarani, stock_qty, description)
SELECT id, 'Ramo de Rosas Rojas (12 unidades)', 'Ramos', 150000, 20, 'Rosas frescas importadas, atadas con lazo de seda'
FROM tenants WHERE name = 'Florería Las Orquídeas'
UNION ALL
SELECT id, 'Arreglo Floral Mixto', 'Arreglos', 120000, 15, 'Combinación de gerberas, lilies y verdes decorativos'
FROM tenants WHERE name = 'Florería Las Orquídeas'
UNION ALL
SELECT id, 'Orquídea en Maceta', 'Plantas', 95000, 8, 'Orquídea Phalaenopsis, ideal para regalo'
FROM tenants WHERE name = 'Florería Las Orquídeas';
