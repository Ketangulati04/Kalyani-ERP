// Finished goods, the same article master as the CRM app, and the Brand, Category and Colour masters it uses.
import { html, raw, money, chip, esc, type Raw } from './lib.js';
import { uid, read, val, act, head, denied, R, opts, toast, kv } from './ctx.js';
import * as bom from '../src/domain/bom.js';
import * as cat from '../src/domain/catalog.js';
import { can } from '../src/core/permissions.js';
import { bulkBar } from './views-bulk.js';

const ANY = { anySite: true } as const;
type Kind = 'brand' | 'category' | 'colour';
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const st = {
  edit: { brand: '', category: '', colour: '' } as Record<Kind, string>, adding: { brand: false, category: false, colour: false } as Record<Kind, boolean>,
  f: { q: '', brand: '', cat: '', status: '' }, sel: '', form: '' as '' | 'new' | 'edit', draft: {} as Record<string, string>,
};
const verOf = (table: string, id: string) => read(async (db) => (await db.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version as number);
const rs = (v: unknown) => (v == null || v === '' ? '–' : money(String(v)));
const STATUS_TONE: Record<string, string> = { active: 'ok', close: 'warn', disable: 'bad', inactive: 'neutral' };
const STATUS_LABEL: Record<string, string> = { active: 'Active', close: 'Close', disable: 'Disable', inactive: 'Switched off' };
const sChip = (s: string) => html`<span class="chip ${STATUS_TONE[s] ?? 'neutral'}">${STATUS_LABEL[s] ?? s}</span>`;
const sizesText = (z: string[]) => (z.length > 4 ? `${z[0]} – ${z[z.length - 1]} (${z.length})` : z.join(', '));

// ───────────────────────── Brands, categories, colours ─────────────────────────
const TITLE: Record<Kind, [string, string, string]> = {
  brand: ['Brands', 'The brands articles are sold under. The CRM app uses the same names.', 'KLY'],
  category: ['Categories', 'What kind of garment an article is. Each category gives new articles a default HSN code and commodity type.', 'BRA'],
  colour: ['Colours', 'Colour codes used by articles and SKUs (BLK, WHT…). A SKU code is article, colour, cup and size.', 'BLK'],
};
async function masterView(kind: Kind): Promise<Raw> {
  const [title, sub, ph] = TITLE[kind];
  const d = await read(async (db) => ({ list: await cat.listMasters(db, uid(), kind).catch(() => null) as Row[] | null, manage: await can(db, uid(), 'catalog.manage', ANY) }));
  if (!d.list) return denied(title, sub, 'Your role cannot see the catalogue masters.');
  const C = kind === 'category';
  const extra = (r: Row = {}) => C ? html`<label>Default HSN<input id="cm-hsn" inputmode="numeric" value="${r.hsn_code ?? ''}" placeholder="62121000" /></label>
    <label>Default commodity type<select id="cm-com">${opts(cat.COMMODITIES.map((x) => ({ id: x, label: x })), r.commodity ?? '', 'None')}</select></label>
    <label>Default GST % <small>(optional)</small><input id="cm-gst" inputmode="decimal" value="${r.gst_rate ?? ''}" /></label>` : '';
  const addForm = st.adding[kind] && d.manage ? html`<form class="card form" data-form="ct-master" data-kind="${kind}"><h2>New ${title.slice(0, -1).toLowerCase().replace(/ie$/, 'y')}</h2>
    <div class="grid2"><label>Code<input id="cm-code" placeholder="${ph}" required /></label><label>Name<input id="cm-name" required /></label>${extra()}</div>
    <div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="ct-add" data-id="${kind}">Cancel</button></div></form>` : '';
  const rows = d.list.map((r) => st.edit[kind] === r.id && d.manage ? html`<tr><td colspan="${C ? 7 : 5}"><form class="form" data-form="ct-master-edit" data-kind="${kind}" data-id="${r.id}">
      <div class="grid2"><label>Code<input value="${r.code}" disabled /></label><label>Name<input id="cm-name" value="${r.name}" required /></label>${extra(r)}</div>
      <div class="row"><button class="primary" type="submit">Save</button><button type="button" data-act="ct-edit" data-id="${kind}:${r.id}">Cancel</button></div></form></td></tr>`
    : html`<tr><td class="mono">${r.code}</td><td>${r.name}</td>${C ? html`<td class="mono">${r.hsn_code ?? '–'}</td><td>${r.commodity ?? '–'}</td>` : ''}<td class="r">${r.n_articles}</td><td>${sChip(r.status)}</td>
      <td class="r">${d.manage ? html`<button class="sm" data-act="ct-edit" data-id="${kind}:${r.id}">Edit</button> <button class="sm" data-act="ct-toggle" data-id="${kind}:${r.id}:${r.status === 'active' ? 'off' : 'on'}">${r.status === 'active' ? 'Switch off' : 'Switch on'}</button>` : ''}</td></tr>`);
  return html`${head(title, sub, d.manage ? html`<button class="primary" data-act="ct-add" data-id="${kind}">New</button>` : undefined)}${addForm}
  <section class="card">${d.list.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Code</th><th>Name</th>${C ? html`<th>HSN</th><th>Commodity type</th>` : ''}<th class="r">Articles</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : html`<p class="empty">None yet.</p>`}<p class="sub">Switching one off keeps the articles that already use it, but it cannot be picked for new ones.</p></section>`;
}
export const brandsView = () => masterView('brand');
export const categoriesView = () => masterView('category');
export const coloursView = () => masterView('colour');

// ───────────────────────── Finished goods (articles) ─────────────────────────
export async function finishedView(): Promise<Raw> {
  const d = await read(async (db) => {
    const list = await bom.listStyles(db, uid()).catch(() => null) as Row[] | null;
    if (!list) return null;
    const sel = st.sel && list.some((s) => s.id === st.sel) ? await bom.getStyle(db, uid(), st.sel) : null;
    const m = async (k: Kind) => (await cat.listMasters(db, uid(), k).catch(() => [])) as Row[];
    return { list, sel, brands: await m('brand'), cats: await m('category'), colours: await m('colour'), create: await can(db, uid(), 'article.edit', ANY) };
  });
  if (!d) return denied('Finished goods', 'Every article you make and sell.', 'Your role cannot see finished goods.');
  const f = st.f; const q = f.q.trim().toLowerCase();
  const list = d.list.filter((x) => (!f.brand || x.brand_id === f.brand) && (!f.cat || x.category_id === f.cat) && (!f.status || x.status === f.status)
    && (!q || x.code.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || (x.colours as { name: string }[]).some((c) => c.name.toLowerCase().includes(q))));
  const n = (s: string) => d.list.filter((x) => x.status === s).length;
  const skus = d.list.reduce((a, x) => a + x.n_skus, 0); const bcs = d.list.reduce((a, x) => a + Math.min(x.n_piece_bc, x.n_box_bc), 0);
  const tiles = html`<section class="card crm-sum"><div class="crm-k"><span>Articles</span><b>${d.list.length}</b></div><div class="crm-k"><span>Active</span><b>${n('active')}</b></div>
    <div class="crm-k"><span>Close</span><b class="${n('close') ? 'warn-t' : ''}">${n('close')}</b></div><div class="crm-k"><span>Disable</span><b class="${n('disable') ? 'bad-t' : ''}">${n('disable')}</b></div>
    <div class="crm-k"><span>SKUs</span><b>${skus}</b></div><div class="crm-k"><span>SKUs with barcodes</span><b class="${bcs < skus ? 'warn-t' : ''}">${bcs} / ${skus}</b></div></section>`;
  const filters = html`<div class="row"><input id="ct-q" type="search" placeholder="Code, name or colour" value="${f.q}" style="flex:1;min-width:160px" aria-label="Search articles" />
    <select id="ct-fb" aria-label="Brand">${opts(d.brands.map((b) => ({ id: b.id, label: b.name })), f.brand, 'All brands')}</select>
    <select id="ct-fc" aria-label="Category">${opts(d.cats.map((c) => ({ id: c.id, label: c.name })), f.cat, 'All categories')}</select>
    <select id="ct-fs" aria-label="Status">${opts(Object.keys(cat.ARTICLE_STATUS).map((s) => ({ id: s, label: STATUS_LABEL[s] })), f.status, 'Any status')}</select></div>`;
  const table = list.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Article</th><th>Brand · category</th><th>Colours</th><th>Cup</th><th>Sizes</th><th>Packing</th>
      <th class="r">Rate / pc</th><th class="r">Rate / pack</th><th class="r">MRP / pc</th><th class="r">MRP / pack</th><th class="r">SKUs</th><th>Status</th><th></th></tr></thead><tbody>${list.map((x) => {
      const pk = x.pcs_per_pack > 1;
      return html`<tr class="pick ${x.id === st.sel ? 'on' : ''}" tabindex="0" data-act="ct-pick" data-id="${x.id}"><td><b class="mono">${x.code}</b><br>${x.name}<br><small>HSN ${x.hsn_code ?? '–'}${x.commodity ? ' · ' + x.commodity : ''}</small></td>
        <td>${x.brand ?? '–'}<br><small>${x.category_name ?? x.category ?? '–'}</small></td><td>${(x.colours as { name: string }[]).map((c) => c.name).join(', ')}</td><td>${(x.cups as string[]).join(', ') || '–'}</td>
        <td>${sizesText(x.sizes)}</td><td>${x.packing}</td><td class="r">${rs(x.rate)}</td><td class="r">${pk && x.rate ? money(String(Number(x.rate) * x.pcs_per_pack)) : '–'}</td>
        <td class="r"><b>${rs(x.mrp)}</b></td><td class="r">${pk && x.mrp ? money(String(Number(x.mrp) * x.pcs_per_pack)) : '–'}</td>
        <td class="r">${x.n_skus}<br><small title="Barcodes made: piece and box">▥ ${x.n_piece_bc} · box ${x.n_box_bc}</small></td><td>${sChip(x.status)}</td>
        <td class="r"><button class="sm" data-act="ct-view" data-id="${x.id}">View</button>${d.create ? html` <button class="sm" data-act="ct-editrow" data-id="${x.id}">Edit</button>` : ''}</td></tr>`;
    })}</tbody></table></div>` : html`<p class="empty">No articles match.</p>`;
  return html`${head('Finished goods', 'Every article: brand, category, colours, cups, sizes, packing, rate and MRP, HSN, status and barcodes. Articles are added and changed here; the CRM app uses the same list.', d.create ? html`<button class="primary" data-act="ct-new">New article</button>` : undefined)}
  ${bulkBar('skus', d.create)}${tiles}${st.form === 'new' && d.create ? articleForm(d, null) : ''}
  ${d.sel ? detail(d, d.sel, d.list.find((x) => x.id === st.sel)!) : ''}
  <section class="card">${filters}${table}</section>`;
}

type FD = { brands: Row[]; cats: Row[]; colours: Row[] };
function articleForm(d: FD, s: Row | null): Raw {
  const v = (k: string, dflt: unknown = '') => st.draft[k] ?? String(dflt ?? '');
  const on = (list: Row[], keep: string[]) => list.filter((x) => x.status === 'active' || keep.includes(x.id) || keep.includes(x.code));
  const picked = (k: string, from: string[]) => (st.draft[k] !== undefined ? st.draft[k].split(',').filter(Boolean) : from);
  const sizesNow = picked('ct-size', (s?.sizes ?? []) as string[]);
  const otherSizes = [...new Set([...((s?.sizes ?? []) as string[]), ...sizesNow])].filter((z) => !(cat.SIZES as readonly string[]).includes(z));
  const cols = picked('ct-col', ((s?.colours ?? []) as { code: string }[]).map((c) => c.code)); const cups = picked('ct-cup', (s?.cups ?? []) as string[]);
  const pcs = cat.packPcs(v('ct-pack', s?.packing ?? 'Single piece'));
  return html`<form class="card form" data-form="ct-article" data-id="${s?.id ?? ''}"><h2>${s ? `Change ${s.code}` : 'New article'}</h2>
    <div class="grid2">${s ? html`<label>Article code<input value="${s.code}" disabled /></label>` : html`<label>Article code<input id="ct-code" placeholder="KL-101" value="${v('ct-code')}" required /></label>`}
      <label>Article name<input id="ct-name" value="${v('ct-name', s?.name)}" required /></label>
      <label>Brand<select id="ct-brand">${opts(on(d.brands, [s?.brand_id]).map((b) => ({ id: b.id, label: b.name })), v('ct-brand', s?.brand_id), 'Choose…')}</select></label>
      <label>Category<select id="ct-cat">${opts(on(d.cats, [s?.category_id]).map((c) => ({ id: c.id, label: c.name })), v('ct-cat', s?.category_id), 'Choose…')}</select></label>
      <label>HSN code <small>(blank = the category's)</small><input id="ct-hsn" inputmode="numeric" value="${v('ct-hsn', s?.hsn_code)}" /></label>
      <label>Commodity type <small>(blank = the category's)</small><select id="ct-com">${opts(cat.COMMODITIES.map((x) => ({ id: x, label: x })), v('ct-com', s?.commodity), 'From the category')}</select></label>
      <label>Packing<select id="ct-pack">${opts(cat.PACKINGS.map((p) => ({ id: p.name, label: p.pcs > 1 ? `${p.name} (${p.pcs} pcs)` : p.name })), v('ct-pack', s?.packing ?? 'Single piece'))}</select></label>
      <label>Rate per piece (₹)<input id="ct-rate" inputmode="decimal" value="${v('ct-rate', s?.rate)}" /></label>
      <label>MRP per piece (₹)<input id="ct-mrp" inputmode="decimal" value="${v('ct-mrp', s?.mrp)}" placeholder="Printed MRP of one piece" /></label>
      <label>Launched on <small>(optional)</small><input id="ct-launch" type="date" value="${v('ct-launch', s?.launched_on)}" /></label>
      ${s ? html`<label>Status<select id="ct-status">${opts(Object.entries(cat.ARTICLE_STATUS).map(([k, t]) => ({ id: k, label: `${STATUS_LABEL[k]}: ${t}` })), v('ct-status', s.status))}</select></label>` : ''}</div>
    ${pcs > 1 ? html`<p class="sub">${v('ct-pack', s?.packing)}: ${pcs} pieces a pack. Rate and MRP per pack are worked out from the piece figures.</p>` : html`<p class="sub">One piece a pack, so the pack's rate and MRP are the piece's.</p>`}
    <fieldset><legend>Colours <small>(from the Colours master)</small></legend><div class="row">${on(d.colours, cols).map((c) => html`<label class="chk"><input type="checkbox" name="ct-col" value="${c.code}" ${cols.includes(c.code) ? raw('checked') : ''} /> ${c.name} <small class="mono">${c.code}</small></label>`)}</div></fieldset>
    <fieldset><legend>Cups <small>(bras only; leave all unticked for other garments)</small></legend><div class="row">${cat.CUPS.map((c) => html`<label class="chk"><input type="checkbox" name="ct-cup" value="${c}" ${cups.includes(c) ? raw('checked') : ''} /> ${c}</label>`)}</div></fieldset>
    <fieldset><legend>Sizes</legend><div class="row">${[...cat.SIZES, ...otherSizes].map((z) => html`<label class="chk"><input type="checkbox" name="ct-size" value="${z}" ${sizesNow.includes(z) ? raw('checked') : ''} /> ${z}</label>`)}</div>
      <label>Other sizes <small>(not in the list above, separated by commas, up to 8 characters each)</small><input id="ct-size-other" value="${v('ct-size-other')}" placeholder="26/XXS, 54" /></label></fieldset>
    <p class="sub">Saving makes a SKU for every colour · cup · size, and gives each one a piece barcode and a box barcode automatically. A size, colour or cup that SKUs already use cannot be removed.</p>
    <div class="row"><button class="primary" type="submit">Save article</button><button type="button" data-act="ct-cancel">Cancel</button></div></form>`;
}

/** Everything about one article, shown above the list: its details, then every SKU with its barcodes. */
function detail(d: FD & { create: boolean }, sel: Awaited<ReturnType<typeof bom.getStyle>>, row: Row): Raw {
  const s = sel.style as Row; const pk = s.pcs_per_pack > 1;
  const colName = new Map((s.colours as { code: string; name: string }[]).map((c) => [c.code, c.name]));
  const missing = (s.colours as unknown[]).length * Math.max(1, (s.cups as string[]).length) * (s.sizes as string[]).length - sel.skus.length;
  const noBc = sel.skus.filter((k: Row) => !k.ean_piece || !k.ean_box).length;
  if (st.form === 'edit' && d.create) return html`<div id="ct-detail">${articleForm(d, s)}</div>`;
  const pack = (v: unknown) => (pk && v ? money(String(Number(v) * s.pcs_per_pack)) : '–');
  const info = html`<div class="kvs">${kv('Brand', row.brand ?? '–')}${kv('Category', row.category_name ?? s.category ?? '–')}${kv('HSN code', s.hsn_code ?? '–')}${kv('Commodity type', s.commodity ?? '–')}
    ${kv('GST', s.gst_rate != null ? `${Number(s.gst_rate)} %` : '–')}${kv('Packing', pk ? `${s.packing} (${s.pcs_per_pack} pcs)` : s.packing)}
    ${kv('Rate per piece', rs(s.rate))}${kv('Rate per pack', pack(s.rate))}${kv('MRP per piece', rs(s.mrp))}${kv('MRP per pack', pack(s.mrp))}
    ${kv('Colours', (s.colours as { code: string; name: string }[]).map((c) => `${c.name} (${c.code})`).join(', ') || '–')}${kv('Cups', (s.cups as string[]).join(', ') || 'None')}
    ${kv('Sizes', (s.sizes as string[]).join(', '))}${kv('Launched on', s.launched_on ? String(s.launched_on).slice(0, 10) : '–')}
    ${kv('BOM', row.active_version ? `Version ${row.active_version} in use` : row.open_status ? `Being prepared (${row.open_status})` : 'None yet')}${kv('Added by', sel.style.creator ?? '–')}</div>
    ${s.description ? html`<p>${s.description}</p>` : ''}`;
  return html`<section class="card" id="ct-detail"><div class="row between"><h2>${s.code} · ${s.name} ${sChip(s.status)}</h2>
    <div class="row">${d.create ? html`<button class="primary" data-act="ct-edit-art">Edit article</button>` : ''}<button data-act="ct-close">Close</button></div></div>
    ${info}${d.create ? '' : html`<p class="sub">Only the business owner, the master-data steward or the engineer can change articles.</p>`}
    ${d.create ? html`<div class="row">${missing > 0 && s.status !== 'disable' ? html`<button data-act="ct-skus">Make ${missing} missing SKU${missing === 1 ? '' : 's'}</button>` : ''}${noBc ? html`<button data-act="ct-bc">Make missing barcodes</button>` : ''}</div>` : ''}
    <p class="sub">Status: ${STATUS_LABEL[s.status]} — ${cat.ARTICLE_STATUS[s.status]}.</p>
    <h3>SKUs and barcodes</h3><p class="sub">Every SKU has a piece barcode and a box barcode${pk ? ` (the box of ${s.pcs_per_pack})` : ''}, made automatically: EAN-13 under the GS1 prefix ${cat.EAN_PREFIX.slice(0, 3)} ${cat.EAN_PREFIX.slice(3)} (a sample prefix until yours is set), never repeated. To use a label that is already printed, scan or type its barcode over the one shown. For many at once, use the SKU CSV above.</p>
    ${sel.skus.length ? html`<div class="scroll"><table class="mini"><thead><tr><th>Colour</th><th>Cup</th><th>Size</th><th>SKU</th><th>Piece barcode</th><th>Box barcode</th><th>Stock item</th></tr></thead><tbody>${sel.skus.map((k: Row) => html`<tr>
      <td>${colName.get(k.colour_code) ?? k.colour_code}</td><td>${k.cup || '–'}</td><td>${k.size}</td><td class="mono">${k.code}</td>
      <td>${d.create ? html`<input class="mono" data-ctbc="${k.id}|piece" value="${k.ean_piece ?? ''}" inputmode="numeric" placeholder="Scan piece barcode" aria-label="Piece barcode ${esc(k.code)}" style="width:150px" />` : html`<span class="mono">${k.ean_piece ?? '–'}</span>`}</td>
      <td>${d.create ? html`<input class="mono" data-ctbc="${k.id}|box" value="${k.ean_box ?? ''}" inputmode="numeric" placeholder="Scan box barcode" aria-label="Box barcode ${esc(k.code)}" style="width:150px" />` : html`<span class="mono">${k.ean_box ?? '–'}</span>`}</td>
      <td>${chip(k.status === 'active' ? 'active' : 'draft', k.status === 'active' ? 'ready' : 'waiting for BOM')}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No SKUs yet.</p>`}
    <p class="sub">A SKU's stock item becomes ready when the article's BOM is approved on the BOM &amp; packs screen.</p></section>`;
}

// ───────────────────────── events ─────────────────────────
/** Bring the open article (details or edit form) into view. */
const toDetail = () => requestAnimationFrame(() => document.getElementById('ct-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
const checks = (name: string) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((e) => (e as HTMLInputElement).value);
const capture = () => {
  document.querySelectorAll('form[data-form=ct-article] input[id], form[data-form=ct-article] select[id]').forEach((e) => { const i = e as HTMLInputElement; st.draft[i.id] = i.value; });
  st.draft['ct-col'] = checks('ct-col').join(','); st.draft['ct-cup'] = checks('ct-cup').join(','); st.draft['ct-size'] = checks('ct-size').join(',');
};

export async function onClick(t: HTMLElement): Promise<boolean> {
  const b = t.closest('[data-act]') as HTMLElement | null; if (!b) return false;
  const a = b.dataset.act!, id = b.dataset.id ?? '';
  const done = async () => { await R.render(); return true; };
  switch (a) {
    case 'ct-add': { const k = id as Kind; st.adding[k] = !st.adding[k]; return done(); }
    case 'ct-edit': { const [k, rid] = id.split(':') as [Kind, string]; st.edit[k] = st.edit[k] === rid ? '' : rid; return done(); }
    case 'ct-toggle': {
      const [k, rid, to] = id.split(':') as [Kind, string, string];
      const v = await verOf(k === 'category' ? 'product_category' : k, rid);
      await act(to === 'off' ? 'Switched off' : 'Switched on', (c) => cat.updateMaster(c, k, { id: rid, expectedVersion: v, active: to === 'on' })); return true;
    }
    case 'ct-new': st.form = st.form === 'new' ? '' : 'new'; st.draft = {}; return done();
    case 'ct-cancel': st.form = ''; st.draft = {}; await R.render(); toDetail(); return true;
    case 'ct-pick': case 'ct-view': st.sel = a === 'ct-pick' && st.sel === id ? '' : id; if (st.form === 'edit') st.form = ''; await R.render(); toDetail(); return true;
    case 'ct-editrow': st.sel = id; st.form = 'edit'; st.draft = {}; await R.render(); toDetail(); return true;
    case 'ct-edit-art': st.form = 'edit'; st.draft = {}; await R.render(); toDetail(); return true;
    case 'ct-close': st.sel = ''; if (st.form === 'edit') st.form = ''; return done();
    case 'ct-skus': { const r = await act('SKUs made', (c) => bom.createSkus(c, { styleId: st.sel })); if (r) toast(`${r.created} SKU${r.created === 1 ? '' : 's'} and ${r.barcodes} barcode${r.barcodes === 1 ? '' : 's'} made`); return true; }
    case 'ct-bc': { const r = await act('Barcodes made', (c) => cat.fillEans(c, st.sel)); if (r) toast(`${r.made} barcode${r.made === 1 ? '' : 's'} made`); return true; }
  }
  return false;
}

export async function onSubmit(form: string, f?: HTMLElement): Promise<boolean> {
  if (form === 'ct-master' || form === 'ct-master-edit') {
    const k = f!.dataset.kind as Kind; const C = k === 'category';
    const extra = C ? { hsnCode: val('cm-hsn') || undefined, commodity: val('cm-com') || undefined, gstRate: val('cm-gst') || undefined } : {};
    if (form === 'ct-master') { const r = await act('Saved', (c) => cat.createMaster(c, k, { code: val('cm-code'), name: val('cm-name'), ...extra })); if (r) { st.adding[k] = false; await R.render(); } return true; }
    const rid = f!.dataset.id!; const v = await verOf(C ? 'product_category' : k, rid);
    const r = await act('Saved', (c) => cat.updateMaster(c, k, { id: rid, expectedVersion: v, name: val('cm-name'), ...(C ? { hsnCode: val('cm-hsn') || null, commodity: val('cm-com') || null, gstRate: val('cm-gst') || null } : {}) }));
    if (r) { st.edit[k] = ''; await R.render(); } return true;
  }
  if (form !== 'ct-article') return false;
  const sid = f!.dataset.id || '';
  const fields = {
    name: val('ct-name'), brandId: val('ct-brand') || null, categoryId: val('ct-cat') || null, hsnCode: val('ct-hsn') || undefined, commodity: val('ct-com') || null,
    packing: val('ct-pack'), rate: val('ct-rate') || null, mrp: val('ct-mrp') || null, launchedOn: val('ct-launch') || null,
    sizes: [...new Set([...checks('ct-size'), ...val('ct-size-other').split(',').map((x) => x.trim()).filter(Boolean)])], colours: checks('ct-col'), cups: checks('ct-cup'),
  };
  if (!sid) {
    const r = await act('Article saved with its SKUs and barcodes', async (c) => { const s = await bom.createStyle(c, { code: val('ct-code'), ...fields }); await bom.createSkus(c, { styleId: s.id }); return s; });
    if (r) { st.form = ''; st.draft = {}; st.sel = r.id; await R.render(); } return true;
  }
  const v = await verOf('product_style', sid); const status = (val('ct-status') || undefined) as 'active' | 'close' | 'disable' | undefined;
  const r = await act('Article saved', async (c) => { const s = await bom.updateStyle(c, { styleId: sid, expectedVersion: v, ...fields, status }); if (s.status !== 'disable') await bom.createSkus(c, { styleId: sid }); return s; });
  if (r) { st.form = ''; st.draft = {}; await R.render(); toDetail(); } return true;
}

export async function onChange(t: HTMLInputElement): Promise<boolean> {
  if (t.dataset.ctbc) {
    const [skuId, kind] = t.dataset.ctbc.split('|') as [string, 'piece' | 'box'];
    if (!t.value.trim()) { await R.render(); return true; }
    await act(`${kind === 'piece' ? 'Piece' : 'Box'} barcode saved`, (c) => cat.setEan(c, { skuId, kind, code: t.value.trim() })); return true;
  }
  if (t.id === 'ct-pack') { capture(); await R.render(); return true; }
  const set: Record<string, () => void> = { 'ct-fb': () => { st.f.brand = t.value; }, 'ct-fc': () => { st.f.cat = t.value; }, 'ct-fs': () => { st.f.status = t.value; } };
  if (!set[t.id]) return false;
  set[t.id](); await R.render(); return true;
}
export async function onInput(t: HTMLInputElement): Promise<boolean> {
  if (t.id !== 'ct-q') return false;
  st.f.q = t.value; await R.render(); const el = document.getElementById('ct-q') as HTMLInputElement | null; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } return true;
}
