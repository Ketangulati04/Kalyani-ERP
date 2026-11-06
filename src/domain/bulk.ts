// Export every master list as CSV in the same columns the importers read, so a file can be edited and loaded back.
import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { assertCan } from '../core/permissions.js';
import { badRequest } from '../core/errors.js';
import * as md from './master-data.js';
import * as bom from './bom.js';
import * as cat from './catalog.js';

const ANY = { anySite: true } as const;
const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = (head: string[], rows: unknown[][]) => [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';

/** Every SKU of every article with its piece and box barcode, like the CRM app's barcodes file. */
export const SKU_CSV = 'article,colour_code,cup,size,piece_barcode,box_barcode';
export const HEADS = {
  vendors: { header: 'code,name,gstin,pan,city,state,phone,email,payment_days,contact_name,contact_phone', sample: ',Om Trims,24AAACO1111F1Z4,AAACO1111F,Surat,Gujarat,9824011122,orders@omtrims.example,30,Raju,9824011122' },
  materials: { header: 'code,type,name,description,hsn,gst,reorder_level,unit', sample: ',KNIT,Single jersey 180 GSM white,,6006,5,500,M' },
  skus: { header: SKU_CSV, sample: 'KL-101,BLK,B,32/M,,' },
} as const;
export type Head = keyof typeof HEADS;

export async function exportCsv(db: Db, userId: string, head: Head): Promise<{ csv: string; rows: number; file: string }> {
  if (head === 'vendors') {
    const list = await md.listParties(db, userId, { role: 'vendor' });
    if (!list) throw badRequest('Your role cannot see this list');
    const ids = list.map((p) => p.id);
    const full = (await db.query('SELECT id, pan FROM partner WHERE id = ANY($1::uuid[])', [ids])).rows; const pan = new Map(full.map((r) => [r.id, r.pan]));
    const ph = (await db.query(`SELECT DISTINCT ON (partner_id) partner_id, name, phone FROM partner_contact WHERE partner_id = ANY($1::uuid[]) ORDER BY partner_id, is_primary DESC, created_at`, [ids])).rows; const ct = new Map(ph.map((r) => [r.partner_id, r]));
    return { rows: list.length, file: `${head}.csv`, csv: toCsv(HEADS[head].header.split(','), list.map((p) => [p.code, p.name, p.gstin, pan.get(p.id), p.city, p.state, p.phone, p.email, p.payment_days, ct.get(p.id)?.name, ct.get(p.id)?.phone])) };
  }
  if (head === 'materials') {
    const list = (await md.listMaterials(db, userId)).filter((m) => m.kind !== 'FG'); // finished goods are articles, on the Finished goods screen
    const desc = new Map((await db.query('SELECT id, description FROM item')).rows.map((r) => [r.id, r.description]));
    const keys = [...new Set(list.flatMap((m) => Object.keys(m.attributes ?? {})))].sort();
    const snake = (k: string) => 'attr_' + k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    return { rows: list.length, file: 'materials.csv', csv: toCsv([...HEADS[head].header.split(','), ...keys.map(snake)], list.map((m) => [m.code, m.type_code, m.name, desc.get(m.id), m.hsn_code, m.gst_rate, m.reorder_level, m.stock_unit, ...keys.map((k) => (m.attributes ?? {})[k]).map((v) => v ?? '')])) };
  }
  await assertCan(db, userId, 'bom.view', ANY);
  const r = (await db.query(`SELECT s.code AS article, k.colour_code, k.cup, k.size, (SELECT code FROM sku_ean e WHERE e.sku_id=k.id AND e.kind='piece') AS pc, (SELECT code FROM sku_ean e WHERE e.sku_id=k.id AND e.kind='box') AS box
       FROM sku k JOIN product_style s ON s.id=k.style_id ORDER BY s.code, k.colour_code, k.cup, array_position(s.sizes, k.size)`)).rows;
  return { rows: r.length, file: 'skus-barcodes.csv', csv: toCsv(SKU_CSV.split(','), r.map((x) => [x.article, x.colour_code, x.cup, x.size, x.pc, x.box])) };
}

/**
 * Rows of article, colour, cup and size. A SKU that does not exist yet is made (with its barcodes); a barcode in the file
 * replaces the one on that SKU (to use labels that are already printed). Colours, cups and sizes must already be on the article.
 */
export async function importSkus(ctx: Ctx, csv: string, dryRun = false): Promise<md.ImportResult & { skipped: number }> {
  await assertCan(ctx.db, ctx.actor.id, 'article.edit', ANY);
  const { head, rows } = md.parseCsv(csv);
  for (const need of ['article', 'colour_code', 'size']) if (!head.includes(need)) throw badRequest(`Header must include "${need}". Expected: ${SKU_CSV}`);
  const errors: md.ImportResult['errors'] = []; let created = 0, skipped = 0, updated = 0;
  await ctx.db.query('SAVEPOINT imp_all');
  for (let n = 0; n < rows.length; n++) {
    const g = (k: string) => (rows[n][head.indexOf(k)] ?? '').trim();
    try {
      await ctx.db.query('SAVEPOINT imp');
      const style = (await ctx.db.query('SELECT * FROM product_style WHERE code=$1', [g('article').toUpperCase()])).rows[0];
      if (!style) throw badRequest(`No article with code "${g('article')}". Add it on the Finished goods screen first`);
      const colour = g('colour_code').toUpperCase(), cup = head.includes('cup') ? g('cup').toUpperCase() : '';
      const size = (style.sizes as string[]).find((x) => x.toUpperCase() === g('size').toUpperCase());
      if (!size) throw badRequest(`Size "${g('size')}" is not on ${style.code}. Add it to the article first`);
      if (!(style.colours as { code: string }[]).some((c) => c.code === colour)) throw badRequest(`Colour ${colour || '(empty)'} is not on ${style.code}. Add it to the article first`);
      if (cup && !(style.cups as string[]).includes(cup)) throw badRequest(`Cup ${cup} is not on ${style.code}`);
      if (!cup && (style.cups as string[]).length) throw badRequest(`${style.code} has cups: give the cup`);
      const r = await bom.createSkus(ctx, { styleId: style.id, combos: [{ size, colour, cup }] });
      created += r.created; skipped += r.skipped;
      const sku = (await ctx.db.query('SELECT id FROM sku WHERE style_id=$1 AND colour_code=$2 AND cup=$3 AND size=$4', [style.id, colour, cup, size])).rows[0];
      for (const [col, kind] of [['piece_barcode', 'piece'], ['box_barcode', 'box']] as const) {
        const code = head.includes(col) ? g(col) : '';
        if (!code) continue;
        const have = (await ctx.db.query('SELECT code FROM sku_ean WHERE sku_id=$1 AND kind=$2', [sku.id, kind])).rows[0]?.code;
        if (have !== code) { await cat.setEan(ctx, { skuId: sku.id, kind, code }); updated++; }
      }
      await ctx.db.query(dryRun ? 'ROLLBACK TO SAVEPOINT imp' : 'RELEASE SAVEPOINT imp');
    } catch (e) { await ctx.db.query('ROLLBACK TO SAVEPOINT imp').catch(() => {}); errors.push({ row: n + 2, message: (e as Error).message }); }
  }
  if (errors.length || dryRun) await ctx.db.query('ROLLBACK TO SAVEPOINT imp_all');
  return { created: errors.length ? 0 : created, updated: errors.length ? 0 : updated, skipped, errors, dryRun };
}
