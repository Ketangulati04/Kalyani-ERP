import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as cat from '../src/domain/catalog.js';
import * as bom from '../src/domain/bom.js';
import * as plan from '../src/domain/planning.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';
import { ARTICLES, BRANDS, CATEGORIES, COLOURS } from '../src/seed/catalog-demo.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World;
const uid = (u: string) => w.actors[u].id;
const idOf = async (t: string, code: string) => (await w.pool.query(`SELECT id FROM ${t} WHERE code=$1`, [code])).rows[0].id as string;
const ver = async (t: string, id: string) => (await w.pool.query(`SELECT version FROM ${t} WHERE id=$1`, [id])).rows[0].version as number;
beforeAll(async () => { w = await freshWorld('catalog'); await seedMastersDemo(w); await w.addUser('pln', 'PLN'); });
afterAll(async () => { await w.pool.end(); });

describe('brand, category and colour masters', () => {
  it('start with the CRM app\'s brands, categories (with default HSN) and colours', async () => {
    expect((await cat.listMasters(w.pool, uid('md'), 'brand')).map((b) => b.name).sort()).toEqual(BRANDS.map((b) => b[1]).sort());
    const cats = await cat.listMasters(w.pool, uid('md'), 'category');
    expect(cats.length).toBe(CATEGORIES.length);
    expect(cats.find((c) => c.code === 'BRA')).toMatchObject({ hsn_code: '62121000', commodity: 'Brassiere & shapewear' });
    expect((await cat.listMasters(w.pool, uid('md'), 'colour')).length).toBe(COLOURS.length);
    expect((await cat.listMasters(w.pool, uid('md'), 'brand')).find((b) => b.code === 'KLY')!.n_articles).toBeGreaterThan(3);
  });
  it('only the master-data steward and engineer manage them; codes and names are checked and unique', async () => {
    await rejects(w.as('buy', (c) => cat.createMaster(c, 'brand', { code: 'NEW', name: 'New brand' })), 'Not permitted');
    await rejects(w.as('md', (c) => cat.createMaster(c, 'colour', { code: 'b-k', name: 'Bad' })), 'Colour code');
    await rejects(w.as('md', (c) => cat.createMaster(c, 'colour', { code: 'BLK2', name: 'black' })), 'already exists');
    await rejects(w.as('md', (c) => cat.createMaster(c, 'category', { code: 'TEE', name: 'T-shirt', hsnCode: '61A9' })), 'HSN');
    await rejects(w.as('md', (c) => cat.createMaster(c, 'category', { code: 'TEE', name: 'T-shirt', commodity: 'Furniture' })), 'Commodity');
    const t = await w.as('eng', (c) => cat.createMaster(c, 'category', { code: 'TEE', name: 'T-shirt', hsnCode: '61091000', commodity: 'Knitted garment' }));
    expect(t.status).toBe('active');
    expect((await w.pool.query(`SELECT 1 FROM audit_log WHERE action='category.create' AND entity_id=$1`, [t.id])).rowCount).toBe(1);
  });
  it('a renamed colour is renamed on its articles; a switched-off one cannot go on new articles', async () => {
    const id = await idOf('colour', 'GRY');
    await w.as('md', async (c) => cat.updateMaster(c, 'colour', { id, expectedVersion: 1, name: 'Grey melange' }));
    expect(((await w.pool.query(`SELECT colours FROM product_style WHERE code='KL-210'`)).rows[0].colours as { code: string; name: string }[]).find((c) => c.code === 'GRY')!.name).toBe('Grey melange');
    await w.as('md', (c) => cat.updateMaster(c, 'colour', { id, expectedVersion: 2, active: false }));
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'KL-999', name: 'Grey thing', colours: ['GRY'], sizes: ['M'] })), 'switched off');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'KL-999', name: 'Red thing', colours: ['RED'], sizes: ['M'] })), 'not in the Colours master');
    await w.as('md', (c) => cat.updateMaster(c, 'colour', { id, expectedVersion: 3, active: true }));
  });
});

describe('finished-goods articles (the CRM article master)', () => {
  it('has the CRM\'s articles, with every colour · cup · size as a SKU', async () => {
    const list = await bom.listStyles(w.pool, uid('md'));
    for (const a of ARTICLES) expect(list.some((s) => s.code === a.code), a.code).toBe(true);
    const kl101 = list.find((s) => s.code === 'KL-101')!;
    expect(kl101).toMatchObject({ brand: 'Kalyani', category_name: 'Bra', packing: 'Box of 12', pcs_per_pack: 12, rate: '120.00', hsn_code: '62121000', commodity: 'Brassiere & shapewear', status: 'active' });
    expect(kl101.n_skus).toBe(3 * 2 * 4);                        // 3 colours × 2 cups × 4 sizes
    expect((await w.pool.query(`SELECT 1 FROM sku WHERE code='KL-101-BLK-B-32M' AND cup='B'`)).rowCount).toBe(1);
    expect(list.find((s) => s.code === 'KP-520')!.hsn_code).toBe('61099090'); // the article can change its category's HSN
    expect(list.find((s) => s.code === 'KL-305')!.status).toBe('close');
    expect(list.find((s) => s.code === 'MS-640')).toMatchObject({ status: 'disable', n_skus: 0 });
  });
  it('every SKU gets a piece barcode and a box barcode automatically; none repeat', async () => {
    const r = (await w.pool.query(`SELECT s.code, s.pcs_per_pack, e.kind, e.code AS ean FROM sku_ean e JOIN sku k ON k.id=e.sku_id JOIN product_style s ON s.id=k.style_id`)).rows;
    expect(r.every((x) => cat.isEan13(x.ean) && x.ean.startsWith(cat.EAN_PREFIX))).toBe(true);
    expect(new Set(r.map((x) => x.ean)).size).toBe(r.length);
    expect(r.filter((x) => x.code === 'KL-102' && x.kind === 'box').length).toBe(6); // single piece still gets a box barcode
    const n = (await w.pool.query(`SELECT count(*)::int AS n FROM sku`)).rows[0].n;
    expect(r.filter((x) => x.kind === 'piece').length).toBe(n); expect(r.filter((x) => x.kind === 'box').length).toBe(n);
    const kl101 = r.filter((x) => x.code === 'KL-101');
    expect(kl101.filter((x) => x.kind === 'piece').length).toBe(24); expect(kl101.filter((x) => x.kind === 'box').length).toBe(24);
    const one = r.find((x) => x.code === 'KL-101' && x.kind === 'box')!;
    expect(await cat.findEan(w.pool, uid('sto'), one.ean)).toMatchObject({ kind: 'box', article: 'KL-101', pcs_per_pack: 12 });
  });
  it('a printed barcode can replace the made one, but only a valid, unused EAN-13', async () => {
    const k = (await w.pool.query(`SELECT k.id, (SELECT code FROM sku_ean WHERE sku_id=k.id AND kind='piece') AS pc FROM sku k WHERE k.code='KL-102-AST-32M'`)).rows[0];
    const other = (await w.pool.query(`SELECT e.code FROM sku_ean e JOIN sku k ON k.id=e.sku_id WHERE k.code='KL-102-AST-34L' AND e.kind='piece'`)).rows[0].code;
    await rejects(w.as('md', (c) => cat.setEan(c, { skuId: k.id, kind: 'piece', code: '8901234567891' })), 'not a valid EAN-13');
    await rejects(w.as('md', (c) => cat.setEan(c, { skuId: k.id, kind: 'piece', code: other })), 'already the piece barcode of KL-102-AST-34L');
    await rejects(w.as('sto', (c) => cat.setEan(c, { skuId: k.id, kind: 'piece', code: '8901234567890' })), 'Not permitted');
    await w.as('md', (c) => cat.setEan(c, { skuId: k.id, kind: 'piece', code: '8901234567890' }));
    expect((await w.pool.query(`SELECT code, source FROM sku_ean WHERE sku_id=$1 AND kind='piece'`, [k.id])).rows[0]).toEqual({ code: '8901234567890', source: 'scanned' });
  });
  it('takes brand, category defaults, packing and prices; refuses bad ones', async () => {
    const kly = await idOf('brand', 'KLY'), bra = await idOf('product_category', 'BRA');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'KL-150', name: 'Test bra', brandId: kly, categoryId: bra, colours: ['BLK'], cups: ['B1'], sizes: ['34/L'] })), 'Cup "B1"');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'KL-150', name: 'Test bra', colours: ['BLK'], sizes: ['34/L'], packing: 'Crate of 99' })), 'Packing');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'KL-150', name: 'Test bra', colours: ['BLK'], sizes: ['34/L'], rate: '100', mrp: '90' })), 'MRP per piece is below');
    await rejects(w.as('md', (c) => bom.createStyle(c, { code: 'KL-150', name: 'Test bra', colours: ['BLK'], sizes: ['34/L'], rate: '1.234' })), 'Rate per piece');
    const s = await w.as('md', (c) => bom.createStyle(c, { code: 'KL-150', name: 'Test bra', brandId: kly, categoryId: bra, colours: ['BLK', 'SKN'], cups: ['B', 'C'], sizes: ['32/M', '34/L'], packing: 'Box of 6', rate: '110', mrp: '199' }));
    expect(s).toMatchObject({ category: 'Bra', hsn_code: '62121000', commodity: 'Brassiere & shapewear', pcs_per_pack: 6 });
    const r = await w.as('md', (c) => bom.createSkus(c, { styleId: s.id }));
    expect(r).toMatchObject({ created: 8, barcodes: 16 });
    // grow it: a new cup makes its SKUs; a cup or size in use cannot be dropped
    const v = await ver('product_style', s.id);
    await rejects(w.as('md', (c) => bom.updateStyle(c, { styleId: s.id, expectedVersion: v, cups: ['B'] })), 'Cup C already has SKUs');
    await w.as('md', (c) => bom.updateStyle(c, { styleId: s.id, expectedVersion: v, cups: ['B', 'C', 'D'] }));
    expect((await w.as('md', (c) => bom.createSkus(c, { styleId: s.id }))).created).toBe(4);
    const v2 = await ver('product_style', s.id);
    await w.as('md', (c) => bom.updateStyle(c, { styleId: s.id, expectedVersion: v2, packing: 'Single piece' }));
    expect((await w.pool.query(`SELECT pcs_per_pack FROM product_style WHERE id=$1`, [s.id])).rows[0].pcs_per_pack).toBe(1);
  });
  it('a BOM line can apply to some cups only', async () => {
    const s = (await w.pool.query(`SELECT id FROM product_style WHERE code='KL-150'`)).rows[0];
    const cupB = (await w.pool.query(`SELECT id FROM item WHERE name='Moulded cup B'`)).rows[0].id;
    const b = await w.as('md', (c) => bom.startBom(c, { styleId: s.id }));
    await rejects(w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [{ section: 'CUP', itemId: cupB, qty: '2', cups: ['E'] }] })), 'cup is not in this article');
    const saved = await w.as('md', (c) => bom.saveBomLines(c, { bomId: b.id, expectedRev: b.rev, lines: [{ section: 'CUP', itemId: cupB, qty: '2', cups: ['B'] }] }));
    const skuB = (await w.pool.query(`SELECT id FROM sku WHERE code='KL-150-BLK-B-34L'`)).rows[0].id, skuC = (await w.pool.query(`SELECT id FROM sku WHERE code='KL-150-BLK-C-34L'`)).rows[0].id;
    expect((await bom.skuBom(w.pool, uid('md'), { bomId: b.id, skuId: skuB })).lines.length).toBe(1);
    expect((await bom.skuBom(w.pool, uid('md'), { bomId: b.id, skuId: skuC })).lines.length).toBe(0);
    expect((await bom.checkBom(w.pool, b.id)).problems.join(' ')).toContain('would get no materials');
    void saved;
  });
  it('the business owner, master-data steward and engineer may edit articles; others may only look', async () => {
    const kly = await idOf('brand', 'KLY');
    const o = await w.as('own', (c) => bom.createStyle(c, { code: 'KL-160', name: 'Owner tee', brandId: kly, colours: ['WHT'], sizes: ['34/L'] }));
    expect((await w.as('own', (c) => bom.createSkus(c, { styleId: o.id }))).barcodes).toBe(2);
    await w.as('own', async (c) => bom.updateStyle(c, { styleId: o.id, expectedVersion: o.version, mrp: '299' }));
    await w.as('own', (c) => cat.createMaster(c, 'colour', { code: 'BGE', name: 'Beige' }));
    const e = await w.as('eng', (c) => bom.createStyle(c, { code: 'KL-161', name: 'Engineer tee', colours: ['BGE'], sizes: ['34/L'] }));
    expect(e.code).toBe('KL-161');
    await rejects(w.as('sto', (c) => bom.createStyle(c, { code: 'KL-162', name: 'Store tee', colours: ['WHT'], sizes: ['34/L'] })), 'article.edit');
    await rejects(w.as('own', (c) => bom.startBom(c, { styleId: o.id })), 'bom.create');          // editing articles does not mean building BOMs
    expect((await bom.listStyles(w.pool, uid('sto'))).some((x) => x.code === 'KL-160')).toBe(true); // the storekeeper can still look
  });
  it('closed and disabled articles are not planned; a disabled one makes no SKUs', async () => {
    const brf = await idOf('product_style', 'BRF-01');
    const skuItem = (await w.pool.query(`SELECT item_id FROM sku WHERE code='BRF-01-BLK-M'`)).rows[0].item_id;
    await w.as('pln', (c) => plan.setItemPlan(c, { itemId: skuItem, monthlyDemand: '100' }));
    expect((await plan.computePlan(w.pool, uid('pln'))).skus.some((k) => k.code === 'BRF-01-BLK-M')).toBe(true);
    const v = await ver('product_style', brf);
    await rejects(w.as('md', (c) => bom.updateStyle(c, { styleId: brf, expectedVersion: v, status: 'gone' as never })), 'Status');
    await w.as('md', (c) => bom.updateStyle(c, { styleId: brf, expectedVersion: v, status: 'close' }));
    expect((await plan.computePlan(w.pool, uid('pln'))).skus.some((k) => k.code === 'BRF-01-BLK-M')).toBe(false);
    await w.as('md', (c) => bom.updateStyle(c, { styleId: brf, expectedVersion: v + 1, status: 'active' }));
    const ms = await idOf('product_style', 'MS-640');
    await rejects(w.as('md', (c) => bom.createSkus(c, { styleId: ms })), 'disabled');
  });
});
