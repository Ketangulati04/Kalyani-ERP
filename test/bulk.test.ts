import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshWorld } from './helpers.js';
import type { World } from '../src/seed/demo.js';
import * as md from '../src/domain/master-data.js';
import * as bulk from '../src/domain/bulk.js';
import { seedMastersDemo } from '../src/seed/masters-demo.js';

async function rejects(p: Promise<unknown>, part: string) {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === part || (err.message ?? '').toLowerCase().includes(part.toLowerCase())) return err;
    throw new Error(`Expected "${part}" but got ${err.code}: ${err.message}`);
  }
  throw new Error(`Expected a refusal containing "${part}" but it succeeded`);
}
let w: World;
beforeAll(async () => { w = await freshWorld('bulk'); await seedMastersDemo(w); });
afterAll(async () => { await w.pool.end(); });
const uid = (u: string) => w.actors[u].id;

describe('import and export', () => {
  it('importing the export of a list changes nothing and creates nothing', async () => {
    for (const head of ['vendors', 'materials'] as const) {
      const { csv, rows } = await bulk.exportCsv(w.pool, uid('md'), head);
      expect(rows, head).toBeGreaterThan(0);
      const who = head === 'vendors' ? 'buy' : 'md';
      const r = await w.as(who, (c) => (head === 'vendors' ? md.importParties(c, csv, true, 'vendor') : md.importMaterials(c, csv, true, 'materials')));
      expect(r.errors, head).toEqual([]);
      expect(r.created, head).toBe(0);
      expect(r.updated, head).toBe(rows);
    }
  });
  it('adds new rows and changes rows that carry a code, all or nothing', async () => {
    const csv = 'code,name,gstin,pan,city,state,phone,email,payment_days,contact_name,contact_phone\n,Om Trims,24AAACO1111F1Z4,AAACO1111F,Surat,Gujarat,9824011122,o@om.example,30,Raju,9824011122\nV-001,Sunrise Textiles,,,Mysuru,,,,,,\n';
    const r = await w.as('buy', (c) => md.importParties(c, csv, false, 'vendor'));
    expect(r).toMatchObject({ created: 1, updated: 1, errors: [] });
    expect((await w.pool.query(`SELECT city FROM partner WHERE code='V-001'`)).rows[0].city).toBe('Mysuru');
    const bad = csv.replace('Om Trims', 'Om Trims Two').replace('24AAACO1111F1Z4', '24AAACO2222F1Z4').replace('AAACO1111F', 'AAACO2222F') + ',Bad Row,,,,Atlantis,,,,,\n';
    const r2 = await w.as('buy', (c) => md.importParties(c, bad, false, 'vendor'));
    expect(r2.errors.length).toBeGreaterThan(0);
    expect((await w.pool.query(`SELECT 1 FROM partner WHERE name='Om Trims Two'`)).rowCount).toBe(0);
  });
  it('the vendor list refuses distributors and retailers: they are kept in the CRM app', async () => {
    const wrong = await w.as('buy', (c) => md.importParties(c, 'name,role\nBig Dist,distributor\nLittle Shop,retailer\n', true));
    expect(wrong.errors.map((e) => e.row)).toEqual([2, 3]); expect(wrong.errors[0].message).toContain('CRM app');
    expect(Object.keys(bulk.HEADS)).not.toContain('distributors'); expect(Object.keys(bulk.HEADS)).not.toContain('retailers');
  });
  it('SKU and barcode file: exported, loaded back unchanged, makes missing SKUs and takes printed barcodes', async () => {
    const e = await bulk.exportCsv(w.pool, uid('md'), 'skus');
    expect(e.csv.split('\n')[0]).toBe('article,colour_code,cup,size,piece_barcode,box_barcode');
    const same = await w.as('md', (c) => bulk.importSkus(c, e.csv, true));
    expect(same).toMatchObject({ created: 0, updated: 0, errors: [] }); expect(same.skipped).toBe(e.rows);
    // KL-101 is a bra with cups; take one SKU away to see it made again, and give another SKU a printed barcode
    const free = '8901234567890'; // a valid EAN-13 that the system did not make
    const csv = `article,colour_code,cup,size,piece_barcode\nKL-101,BLK,B,32/M,${free}\nKL-101,NOPE,B,32/M,\n`;
    const bad = await w.as('md', (c) => bulk.importSkus(c, csv, false));
    expect(bad.errors.map((x) => x.row)).toEqual([3]); expect(bad.errors[0].message).toContain('Colour NOPE');
    const ok = await w.as('md', (c) => bulk.importSkus(c, csv.split('\n').slice(0, 2).join('\n'), false));
    expect(ok).toMatchObject({ created: 0, updated: 1, errors: [] });
    expect((await w.pool.query(`SELECT e.source FROM sku_ean e JOIN sku k ON k.id=e.sku_id WHERE e.code=$1 AND k.code='KL-101-BLK-B-32M'`, [free])).rows[0].source).toBe('scanned');
    const nocup = await w.as('md', (c) => bulk.importSkus(c, 'article,colour_code,size\nKL-101,BLK,32/M\n', true));
    expect(nocup.errors[0].message).toContain('has cups');
    const wrong = await w.as('md', (c) => bulk.importSkus(c, 'article,colour_code,cup,size,piece_barcode\nKL-101,BLK,C,32/M,8901234567898\n', true));
    expect(wrong.errors[0].message).toContain('not a valid EAN-13');
    await rejects(w.as('sto', (c) => bulk.importSkus(c, csv, true)), 'Not permitted');
  });
  it('exports SKUs and quotes values with commas', async () => {
    const e = await bulk.exportCsv(w.pool, uid('md'), 'skus');
    expect(e.rows).toBeGreaterThan(150);                      // the CRM's articles and the BRF-01 demo article
    expect(bulk.toCsv(['a'], [['x, "y"']])).toBe('a\n"x, ""y"""\n');
  });
});
