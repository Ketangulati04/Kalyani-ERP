import type { World } from './demo.js';
import * as cat from '../domain/catalog.js';
import * as bom from '../domain/bom.js';

// Starting data copied from the CRM app's finished-goods master, so both apps describe the same products the same way.
export const BRANDS: [string, string][] = [['KLY', 'Kalyani'], ['KLP', 'Kalyani Premium'], ['MSH', 'Maashie'], ['PTY', 'Panty']];
/** Category, its default HSN code and commodity type (an article can change both). */
export const CATEGORIES: [string, string, string, string][] = [
  ['BRA', 'Bra', '62121000', 'Brassiere & shapewear'], ['PANTY', 'Panty', '61082100', 'Knitted garment'], ['VEST', 'Vest', '61091000', 'Knitted garment'],
  ['BRIEF', 'Brief', '61071100', 'Knitted garment'], ['TRUNK', 'Trunk', '61071100', 'Knitted garment'], ['CAMI', 'Camisole', '61091000', 'Knitted garment'],
  ['SLIP', 'Slip', '61081100', 'Knitted garment'], ['LEGGINGS', 'Leggings', '61046200', 'Knitted garment'], ['NIGHTSUIT', 'Night suit', '61083100', 'Knitted garment'],
];
export const COLOURS: [string, string][] = [['BLK', 'Black'], ['WHT', 'White'], ['SKN', 'Skin'], ['NVY', 'Navy'], ['MRN', 'Maroon'], ['GRY', 'Grey'], ['PNK', 'Pink'], ['AST', 'Assorted']];

/** Brands, categories and colours. Runs for every database, because articles cannot be made without colours. */
export async function seedCatalog(w: World) {
  for (const [code, name] of BRANDS) await w.as('md', (c) => cat.createMaster(c, 'brand', { code, name }));
  for (const [code, name, hsnCode, commodity] of CATEGORIES) await w.as('md', (c) => cat.createMaster(c, 'category', { code, name, hsnCode, commodity }));
  for (const [code, name] of COLOURS) await w.as('md', (c) => cat.createMaster(c, 'colour', { code, name }));
}

type Art = { code: string; name: string; brand: string; cat: string; colours: string[]; cups: string[]; sizes: string[]; packing: string; rate: number; status: 'active' | 'close' | 'disable'; launched?: string; hsn?: string };
/** The CRM app's sample articles. `rate` is per pack there, as in the CRM; the ERP keeps rate and MRP per piece. */
export const ARTICLES: Art[] = [
  { code: 'KL-101', name: 'Comfort Cotton Bra', brand: 'KLY', cat: 'BRA', colours: ['BLK', 'WHT', 'SKN'], cups: ['B', 'C'], sizes: ['32/M', '34/L', '36/XL', '38/2XL'], packing: 'Box of 12', rate: 1440, status: 'active' },
  { code: 'KL-102', name: 'Classic Brief', brand: 'KLY', cat: 'BRIEF', colours: ['AST'], cups: [], sizes: ['30/S', '32/M', '34/L', '36/XL', '38/2XL', '40/3XL'], packing: 'Single piece', rate: 95, status: 'active' },
  { code: 'KL-210', name: 'Rib Vest', brand: 'KLY', cat: 'VEST', colours: ['WHT', 'GRY'], cups: [], sizes: ['30/S', '32/M', '34/L', '36/XL', '38/2XL', '40/3XL', '42/4XL'], packing: 'Box of 12', rate: 960, status: 'active' },
  { code: 'KL-305', name: 'Old Brief (2024 range)', brand: 'KLY', cat: 'BRIEF', colours: ['AST'], cups: [], sizes: ['32/M', '34/L', '36/XL', '38/2XL', '40/3XL'], packing: 'Box of 3', rate: 240, status: 'close' },
  { code: 'KP-201', name: 'Seamless T-shirt Bra', brand: 'KLP', cat: 'BRA', colours: ['SKN', 'BLK', 'MRN'], cups: ['B', 'C', 'D', 'DD'], sizes: ['32/M', '34/L', '36/XL', '38/2XL'], packing: 'Box of 6', rate: 1320, status: 'active' },
  { code: 'KP-520', name: 'Lace Camisole', brand: 'KLP', cat: 'CAMI', colours: ['BLK', 'SKN'], cups: [], sizes: ['28/XS', '30/S', '32/M', '34/L'], packing: 'Hanger pack', rate: 450, status: 'active', launched: '2026-10-10', hsn: '61099090' },
  { code: 'MS-301', name: 'Ankle Leggings', brand: 'MSH', cat: 'LEGGINGS', colours: ['BLK', 'NVY', 'MRN', 'GRY'], cups: [], sizes: ['30/S', '32/M', '34/L', '36/XL', '38/2XL', '40/3XL', '42/4XL', '44/5XL'], packing: 'Box of 10', rate: 900, status: 'active' },
  { code: 'MS-302', name: 'Cotton Camisole', brand: 'MSH', cat: 'CAMI', colours: ['WHT', 'SKN', 'BLK'], cups: [], sizes: ['30/S', '32/M', '34/L', '36/XL'], packing: 'Single piece', rate: 120, status: 'active', launched: '2026-10-14' },
  { code: 'MS-640', name: 'Cotton Night Suit', brand: 'MSH', cat: 'NIGHTSUIT', colours: ['PNK', 'NVY'], cups: [], sizes: ['34/L', '36/XL', '38/2XL', '40/3XL', '42/4XL', '44/5XL', '46', '48'], packing: 'Single piece', rate: 650, status: 'disable' },
  { code: 'PT-401', name: 'Hipster Panty', brand: 'PTY', cat: 'PANTY', colours: ['AST'], cups: [], sizes: ['28/XS', '30/S', '32/M', '34/L', '36/XL', '38/2XL'], packing: 'Box of 12', rate: 780, status: 'active' },
  { code: 'PT-735', name: 'Plus Brief Panty', brand: 'PTY', cat: 'PANTY', colours: ['SKN', 'BLK'], cups: [], sizes: ['46', '48', '50', '52'], packing: 'Box of 3', rate: 330, status: 'active' },
];

/** The CRM's articles as finished goods, each with every colour · cup · size as a SKU and its piece and box barcodes. */
export async function seedArticles(w: World) {
  const ids = async (t: string) => Object.fromEntries((await w.pool.query(`SELECT code, id FROM ${t}`)).rows.map((r) => [r.code, r.id as string]));
  const brand = await ids('brand'), category = await ids('product_category');
  for (const a of ARTICLES) {
    const pcs = cat.packPcs(a.packing);
    const piece = Math.round((a.rate / pcs) * 100) / 100;
    const mrp = Math.round(piece * 1.8 / 5) * 5 || 5;                      // the CRM's default MRP: 1.8 × the piece rate, to the nearest 5 rupees
    const s = await w.as('md', (c) => bom.createStyle(c, { code: a.code, name: a.name, brandId: brand[a.brand], categoryId: category[a.cat], colours: a.colours, cups: a.cups, sizes: a.sizes,
      packing: a.packing, rate: piece.toFixed(2), mrp: mrp.toFixed(2), hsnCode: a.hsn, launchedOn: a.launched ?? null }));
    if (a.status !== 'disable') await w.as('md', (c) => bom.createSkus(c, { styleId: s.id }));
    if (a.status !== 'active') await w.as('md', (c) => bom.updateStyle(c, { styleId: s.id, expectedVersion: s.version, status: a.status }));
  }
}
