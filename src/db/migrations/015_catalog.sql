-- Finished goods like the CRM app's article master: brand, category and colour masters, and an article (a product style)
-- with brand, category, cups, packing, rate and MRP per piece, commodity type, status and a piece and box EAN-13 barcode per SKU.

CREATE TABLE brand (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,11}$'),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version    int  NOT NULL DEFAULT 1,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brand_name ON brand(lower(name));

CREATE TABLE product_category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,11}$'),
  name       text NOT NULL,
  hsn_code   text CHECK (hsn_code ~ '^\d{4}(\d{2}){0,2}$'),   -- default HSN for its articles
  commodity  text,                                            -- default commodity type for its articles
  gst_rate   numeric(5,2) CHECK (gst_rate BETWEEN 0 AND 40),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version    int  NOT NULL DEFAULT 1,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_category_name ON product_category(lower(name));

CREATE TABLE colour (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,5}$'),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version    int  NOT NULL DEFAULT 1,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX colour_name ON colour(lower(name));

-- the article
ALTER TABLE product_style
  ADD COLUMN brand_id     uuid REFERENCES brand(id),
  ADD COLUMN category_id  uuid REFERENCES product_category(id),
  ADD COLUMN commodity    text,
  ADD COLUMN cups         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN packing      text NOT NULL DEFAULT 'Single piece',
  ADD COLUMN pcs_per_pack int  NOT NULL DEFAULT 1 CHECK (pcs_per_pack BETWEEN 1 AND 100),
  ADD COLUMN rate         numeric(12,2) CHECK (rate >= 0),   -- per piece
  ADD COLUMN mrp          numeric(12,2) CHECK (mrp >= 0),    -- per piece
  ADD COLUMN launched_on  date;
-- Active: sold and made. Close: discontinued, sell what is left, nothing new is planned. Disable: hidden everywhere.
ALTER TABLE product_style DROP CONSTRAINT product_style_status_check;
UPDATE product_style SET status = 'disable' WHERE status = 'inactive';
ALTER TABLE product_style ADD CONSTRAINT product_style_status_check CHECK (status IN ('active','close','disable'));

-- a SKU is one colour · cup · size of an article (cup is '' when the article has no cups)
ALTER TABLE sku ADD COLUMN cup text NOT NULL DEFAULT '';
ALTER TABLE sku DROP CONSTRAINT sku_style_id_size_colour_code_key;
ALTER TABLE sku ADD CONSTRAINT sku_variant UNIQUE (style_id, colour_code, cup, size);
-- a BOM line can apply to some cups only (NULL = every cup), like sizes and colours
ALTER TABLE bom_line ADD COLUMN cups text[];

-- piece and box barcodes: EAN-13, unique across the whole master
CREATE TABLE sku_ean (
  code       text PRIMARY KEY CHECK (code ~ '^\d{13}$'),
  sku_id     uuid NOT NULL REFERENCES sku(id),
  kind       text NOT NULL CHECK (kind IN ('piece','box')),
  source     text NOT NULL DEFAULT 'made' CHECK (source IN ('made','scanned')),
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, kind)
);
CREATE SEQUENCE ean_seq;
