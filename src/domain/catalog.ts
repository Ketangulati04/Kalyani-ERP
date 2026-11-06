// Catalogue masters for finished goods: brands, categories and colours, plus the piece and box barcodes of every SKU.
// These feed the finished-goods article (a product style), the same way the CRM app's article master works.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan } from '../core/permissions.js';
import { audit } from '../core/audit.js';
import { badRequest, invalidState, notFound, staleVersion } from '../core/errors.js';

const ANY = { anySite: true } as const;

/** Packing types and how many pieces each holds. Rate and MRP are kept per piece; the pack's rate and MRP are worked out. */
export const PACKINGS: { name: string; pcs: number }[] = [
  { name: 'Single piece', pcs: 1 }, { name: 'Hanger pack', pcs: 1 }, { name: 'Pouch of 2', pcs: 2 },
  { name: 'Box of 3', pcs: 3 }, { name: 'Box of 6', pcs: 6 }, { name: 'Box of 10', pcs: 10 }, { name: 'Box of 12', pcs: 12 },
];
export const packPcs = (packing: string) => PACKINGS.find((p) => p.name === packing)?.pcs ?? 1;
export const COMMODITIES = ['Knitted garment', 'Woven garment', 'Brassiere & shapewear', 'Hosiery', 'Accessory'] as const;
export const CUPS = ['A', 'B', 'C', 'D', 'DD', 'E', 'F'] as const;
/** The standard sizes, in order (the CRM app's list). An article can also have other sizes. */
export const SIZES = ['28/XS', '30/S', '32/M', '34/L', '36/XL', '38/2XL', '40/3XL', '42/4XL', '44/5XL', '46', '48', '50', '52'] as const;
/** Article status, as in the CRM app. */
export const ARTICLE_STATUS: Record<string, string> = {
  active: 'Sold and produced',
  close: 'Discontinued: sell the remaining stock, nothing new is planned or made',
  disable: 'Hidden everywhere: cannot be planned, made or sold',
};

/**
 * EAN-13 barcodes are made under the company's GS1 prefix plus a running number.
 * 890 is India and 7654 is a SAMPLE company number (the same one the CRM app uses). Replace it with your own GS1 company prefix
 * before printing real labels: 7 digits here leaves 5 for the running number, so up to 99,999 codes.
 */
export const EAN_PREFIX = '8907654';
export const eanCheck = (d12: string) => String((10 - ([...d12].reduce((a, ch, i) => a + Number(ch) * (i % 2 ? 3 : 1), 0) % 10)) % 10);
export const isEan13 = (s: string) => /^\d{13}$/.test(s) && eanCheck(s.slice(0, 12)) === s[12];

type Kind = 'brand' | 'category' | 'colour';
const TABLE: Record<Kind, string> = { brand: 'brand', category: 'product_category', colour: 'colour' };
const NOUN: Record<Kind, string> = { brand: 'Brand', category: 'Category', colour: 'Colour' };
const CODE_RE: Record<Kind, { re: RegExp; hint: string }> = {
  brand: { re: /^[A-Z0-9][A-Z0-9-]{1,11}$/, hint: '2 to 12 capital letters, digits or dashes, like KLY' },
  category: { re: /^[A-Z0-9][A-Z0-9-]{1,11}$/, hint: '2 to 12 capital letters, digits or dashes, like BRA' },
  colour: { re: /^[A-Z0-9]{2,5}$/, hint: '2 to 5 capital letters or digits, like BLK' },
};

export type MasterInput = { code: string; name: string; hsnCode?: string; commodity?: string; gstRate?: string };

function checkCategoryFields(i: { hsnCode?: string | null; commodity?: string | null; gstRate?: string | null }) {
  if (i.hsnCode && !/^\d{4}(\d{2}){0,2}$/.test(i.hsnCode)) throw badRequest('HSN code: 4, 6 or 8 digits');
  if (i.commodity && !(COMMODITIES as readonly string[]).includes(i.commodity)) throw badRequest(`Commodity type: one of ${COMMODITIES.join(', ')}`);
  if (i.gstRate && !(Number(i.gstRate) >= 0 && Number(i.gstRate) <= 40)) throw badRequest('GST rate: 0 to 40');
}

/** Add a brand, category or colour. Codes are fixed once made; names must be unique. */
export async function createMaster(ctx: Ctx, kind: Kind, i: MasterInput) {
  await assertCan(ctx.db, ctx.actor.id, 'catalog.manage', ANY);
  const code = (i.code ?? '').trim().toUpperCase(); const name = (i.name ?? '').trim();
  if (!CODE_RE[kind].re.test(code)) throw badRequest(`${NOUN[kind]} code: ${CODE_RE[kind].hint}`);
  if (!name || name.length > 60) throw badRequest(`Give the ${NOUN[kind].toLowerCase()} a name (up to 60 characters)`);
  const t = TABLE[kind];
  if ((await ctx.db.query(`SELECT 1 FROM ${t} WHERE code=$1 OR lower(name)=lower($2)`, [code, name])).rowCount) throw badRequest(`A ${NOUN[kind].toLowerCase()} with this code or name already exists`);
  let r;
  if (kind === 'category') {
    checkCategoryFields(i);
    r = (await ctx.db.query(`INSERT INTO product_category(code,name,hsn_code,commodity,gst_rate,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code, name, i.hsnCode?.trim() || null, i.commodity || null, i.gstRate || null, ctx.actor.id])).rows[0];
  } else {
    r = (await ctx.db.query(`INSERT INTO ${t}(code,name,created_by) VALUES ($1,$2,$3) RETURNING *`, [code, name, ctx.actor.id])).rows[0];
  }
  await audit(ctx, { action: `${kind}.create`, entityType: t, entityId: r.id, after: { code, name, hsn: r.hsn_code, commodity: r.commodity } });
  return r;
}

/** Rename, change a category's defaults, or switch on/off. Switching off keeps existing articles as they are but hides it from new ones. */
export async function updateMaster(ctx: Ctx, kind: Kind, i: { id: string; expectedVersion: number; name?: string; hsnCode?: string | null; commodity?: string | null; gstRate?: string | null; active?: boolean }) {
  await assertCan(ctx.db, ctx.actor.id, 'catalog.manage', ANY);
  const t = TABLE[kind];
  const row = (await ctx.db.query(`SELECT * FROM ${t} WHERE id=$1 FOR UPDATE`, [i.id])).rows[0];
  if (!row) throw notFound(NOUN[kind]);
  if (row.version !== i.expectedVersion) throw staleVersion(i.expectedVersion, row.version);
  const name = i.name === undefined ? row.name : i.name.trim();
  if (!name || name.length > 60) throw badRequest(`Give the ${NOUN[kind].toLowerCase()} a name (up to 60 characters)`);
  if (name.toLowerCase() !== String(row.name).toLowerCase() && (await ctx.db.query(`SELECT 1 FROM ${t} WHERE lower(name)=lower($1) AND id<>$2`, [name, row.id])).rowCount) throw badRequest(`Another ${NOUN[kind].toLowerCase()} is already called ${name}`);
  const status = i.active === undefined ? row.status : i.active ? 'active' : 'inactive';
  let r;
  if (kind === 'category') {
    const next = { hsnCode: i.hsnCode === undefined ? row.hsn_code : i.hsnCode?.trim() || null, commodity: i.commodity === undefined ? row.commodity : i.commodity || null, gstRate: i.gstRate === undefined ? row.gst_rate : i.gstRate || null };
    checkCategoryFields(next);
    r = (await ctx.db.query(`UPDATE product_category SET name=$2, hsn_code=$3, commodity=$4, gst_rate=$5, status=$6, version=version+1 WHERE id=$1 RETURNING *`, [row.id, name, next.hsnCode, next.commodity, next.gstRate, status])).rows[0];
  } else {
    r = (await ctx.db.query(`UPDATE ${t} SET name=$2, status=$3, version=version+1 WHERE id=$1 RETURNING *`, [row.id, name, status])).rows[0];
  }
  if (kind === 'colour' && name !== row.name) {
    // articles keep a copy of the colour name; keep it in step
    await ctx.db.query(`UPDATE product_style SET colours = (SELECT jsonb_agg(CASE WHEN c->>'code'=$1 THEN jsonb_build_object('code', c->>'code', 'name', $2::text) ELSE c END) FROM jsonb_array_elements(colours) c) WHERE colours @> $3::jsonb`, [row.code, name, JSON.stringify([{ code: row.code }])]);
  }
  await audit(ctx, { action: `${kind}.update`, entityType: t, entityId: row.id, before: { name: row.name, status: row.status, hsn: row.hsn_code, commodity: row.commodity }, after: { name: r.name, status: r.status, hsn: r.hsn_code, commodity: r.commodity } });
  return r;
}

/** One master list with how many articles use each entry. */
export async function listMasters(db: Db, userId: string, kind: Kind) {
  await assertCan(db, userId, 'item.view', ANY);
  const use = kind === 'brand' ? `(SELECT count(*) FROM product_style s WHERE s.brand_id=m.id)`
    : kind === 'category' ? `(SELECT count(*) FROM product_style s WHERE s.category_id=m.id)`
    : `(SELECT count(*) FROM product_style s WHERE s.colours @> jsonb_build_array(jsonb_build_object('code', m.code)))`;
  return (await db.query(`SELECT m.*, ${use}::int AS n_articles FROM ${TABLE[kind]} m ORDER BY m.status, m.name`)).rows;
}

export async function getColours(db: Db, codes: string[]) {
  if (!codes.length) return [];
  return (await db.query(`SELECT code, name, status FROM colour WHERE code = ANY($1::text[])`, [codes])).rows as { code: string; name: string; status: string }[];
}

// ───────────────────────── SKU barcodes ─────────────────────────
async function nextEan(db: Db) {
  for (let n = 0; n < 50; n++) {
    const seq = (await db.query(`SELECT nextval('ean_seq')::text AS n`)).rows[0].n as string;
    if (seq.length > 5) throw invalidState('The EAN running number is used up for this GS1 prefix');
    const d12 = EAN_PREFIX + seq.padStart(5, '0'); const code = d12 + eanCheck(d12);
    if (!(await db.query('SELECT 1 FROM sku_ean WHERE code=$1', [code])).rowCount) return code;
  }
  throw invalidState('Could not find a free EAN code');
}

/** Give every SKU of an article that is missing one a piece barcode and a box barcode (the box or pack the piece is sold in). */
export async function fillEans(ctx: Ctx, styleId: string) {
  await assertCan(ctx.db, ctx.actor.id, 'article.edit', ANY);
  const s = (await ctx.db.query('SELECT id, code FROM product_style WHERE id=$1', [styleId])).rows[0];
  if (!s) throw notFound('Article');
  const kinds = ['piece', 'box'];
  const missing = (await ctx.db.query(
    `SELECT k.id, kd.kind FROM sku k CROSS JOIN unnest($2::text[]) AS kd(kind)
      WHERE k.style_id=$1 AND NOT EXISTS (SELECT 1 FROM sku_ean e WHERE e.sku_id=k.id AND e.kind=kd.kind) ORDER BY k.code, kd.kind DESC`, [s.id, kinds])).rows;
  for (const m of missing) await ctx.db.query(`INSERT INTO sku_ean(code, sku_id, kind, source, created_by) VALUES ($1,$2,$3,'made',$4)`, [await nextEan(ctx.db), m.id, m.kind, ctx.actor.id]);
  if (missing.length) await audit(ctx, { action: 'sku.ean.fill', entityType: 'product_style', entityId: s.id, after: { made: missing.length } });
  return { made: missing.length };
}

/** Use a barcode that is already printed on a label (scanned in) instead of the one the system made. */
export async function setEan(ctx: Ctx, i: { skuId: string; kind: 'piece' | 'box'; code: string }) {
  await assertCan(ctx.db, ctx.actor.id, 'article.edit', ANY);
  const code = (i.code ?? '').trim();
  if (!['piece', 'box'].includes(i.kind)) throw badRequest('Barcode kind: piece or box');
  if (!isEan13(code)) throw badRequest(`"${code}" is not a valid EAN-13 barcode (13 digits with a correct check digit)`);
  const k = (await ctx.db.query('SELECT k.id, k.code, s.pcs_per_pack FROM sku k JOIN product_style s ON s.id=k.style_id WHERE k.id=$1', [i.skuId])).rows[0];
  if (!k) throw notFound('SKU');
  const other = (await ctx.db.query('SELECT e.kind, k.code FROM sku_ean e JOIN sku k ON k.id=e.sku_id WHERE e.code=$1', [code])).rows[0];
  if (other) throw badRequest(`${code} is already the ${other.kind} barcode of ${other.code}`);
  const before = (await ctx.db.query('SELECT code FROM sku_ean WHERE sku_id=$1 AND kind=$2', [k.id, i.kind])).rows[0]?.code ?? null;
  await ctx.db.query('DELETE FROM sku_ean WHERE sku_id=$1 AND kind=$2', [k.id, i.kind]);
  await ctx.db.query(`INSERT INTO sku_ean(code, sku_id, kind, source, created_by) VALUES ($1,$2,$3,'scanned',$4)`, [code, k.id, i.kind, ctx.actor.id]);
  await audit(ctx, { action: 'sku.ean.set', entityType: 'sku', entityId: k.id, before: { [i.kind]: before }, after: { [i.kind]: code } });
  return { sku: k.code, kind: i.kind, code };
}

/** Which SKU (and piece or box) a scanned EAN belongs to. */
export async function findEan(db: Db, userId: string, code: string) {
  await assertCan(db, userId, 'item.view', ANY);
  return (await db.query(`SELECT e.code, e.kind, k.id AS sku_id, k.code AS sku, s.code AS article, s.name, s.pcs_per_pack FROM sku_ean e JOIN sku k ON k.id=e.sku_id JOIN product_style s ON s.id=k.style_id WHERE e.code=$1`, [code.trim()])).rows[0] ?? null;
}
