// Ціни Болгарії з відкритих даних КЗП (kolkostruva.bg): мережі щодня здають ціни кожного магазину.
//   node collector/bg.mjs            — завантажити свіжий архів, зіставити товари, записати data/bg/prices.json
//   node collector/bg.mjs --raw      — додатково зберегти відфільтровані рядки в data/bg/raw.json.gz (для налаштування збігів)
//   node collector/bg.mjs --local    — не завантажувати, взяти data/bg/raw.json.gz (локальна перевірка збігів)
//   node collector/bg.mjs --local --ids=milk,eggs  — показати, які товари обрано, нічого не записувати
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = (f) => path.join(ROOT, 'data', f);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const IDS = args.ids ? new Set(String(args.ids).split(',')) : null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Населені пункти за кодом ЕКАТТЕ і мережі (за початком назви файлу в архіві)
const CITIES = { sofia: ['София', 68134], plovdiv: ['Пловдив', 56784], varna: ['Варна', 10135], burgas: ['Бургас', 7079], ruse: ['Русе', 63427], stara_zagora: ['Стара Загора', 68850] };
const CHAINS = { kaufland: ['Kaufland', /^Кауфланд/], lidl: ['Lidl', /^Лидл/], billa: ['Billa', /^Билла/], fantastico: ['Fantastico', /^ФАНТАСТИКО \(ФАНТАСТИКО ГРУП/], tmarket: ['T Market', /^T Market/], cba: ['CBA', /^Бурлекс/] };
const CODE2CITY = Object.fromEntries(Object.entries(CITIES).map(([k, [, code]]) => [code, k]));

// ---------- ZIP без залежностей ----------
function unzip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('не zip');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const files = [];
  for (let k = 0; k < n; k++) {
    const flags = buf.readUInt16LE(p + 8), comp = buf.readUInt16LE(p + 10), csz = buf.readUInt32LE(p + 20), fl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + fl).toString(flags & 0x800 ? 'utf8' : 'utf8');
    files.push({ name, read: () => { const l = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28); const d = buf.slice(l, l + csz); return (comp === 0 ? d : zlib.inflateRawSync(d)).toString('utf8'); } });
    p += 46 + fl + el + cl;
  }
  return files;
}
function csvRow(l) { const o = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { o.push(cur); cur = ''; continue; } cur += ch; } o.push(cur); return o; }

async function download() {
  for (let back = 0; back < 5; back++) {
    const day = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
    const r = await fetch(`https://kolkostruva.bg/opendata_files/${day}.zip`, { headers: { 'User-Agent': 'ration-builder-price-collector/0.1' } }).catch((e) => ({ ok: false, status: String(e) }));
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 1e5) { log('архів', day, (b.length / 1e6).toFixed(1), 'МБ'); return { day, buf: b }; } }
    log('немає архіву за', day, r.status);
  }
  throw new Error('kolkostruva: немає архіву за останні 5 днів');
}

// rows: [city, chain, store, name, cat, price]
async function loadRows() {
  if (args.local) { const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(D('bg/raw.json.gz'))).toString()); log('локальні рядки', j.rows.length, 'за', j.day); return j; }
  const { day, buf } = await download();
  const rows = [];
  for (const f of unzip(buf)) {
    const chain = Object.keys(CHAINS).find((k) => CHAINS[k][1].test(f.name)); if (!chain) continue;
    // У кожному місті беремо магазин з найбільшим асортиментом (як і для України)
    const byStore = {};
    for (const l of f.read().split(/\r?\n/).slice(1)) {
      if (!l) continue; const c = csvRow(l); const city = CODE2CITY[+c[0]]; if (!city) continue;
      const reg = parseFloat(c[5]) || 0, promo = parseFloat(c[6]) || 0; const price = promo > 0 && (!reg || promo < reg) ? promo : reg; if (!price) continue;
      ((byStore[city] ??= {})[c[1]] ??= []).push([city, chain, c[1], c[2], +c[4], price]);
    }
    for (const city in byStore) { const best = Object.values(byStore[city]).sort((a, b) => b.length - a.length)[0]; rows.push(...best); }
    log(chain, Object.keys(byStore).length, 'міст');
  }
  return { day, rows };
}

// ---------- зіставлення ----------
function sizeOf(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '.').replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
  const m = t.match(/(?:(\d+)\s*[*x×х]\s*)?(\d+(?:\.\d+)?)\s*(кг|гр?|л|мл|бр|броя|бр\.)(?![а-я])/);
  if (!m) return /(^|[\s,/.])кг(\.|$|\s)|насип|\/кг|за кг|1\s*кг/.test(t) ? { qty: 1000, pcs: false, kg: true } : null;
  const n = (m[1] ? +m[1] : 1) * +m[2];
  if (m[3] === 'кг' || m[3] === 'л') return { qty: n * 1000, pcs: false };
  if (m[3].startsWith('бр')) return { qty: n, pcs: true };
  return { qty: n, pcs: false };
}
const bgp = JSON.parse(fs.readFileSync(D('bg/products-bg.json'), 'utf8'));
const products = JSON.parse(fs.readFileSync(D('products.json'), 'utf8'));
function pick(p, m, rows) {
  const inc = new RegExp(m.inc, 'i'), exc = m.exc ? new RegExp(m.exc, 'i') : null, cats = m.cats ? new Set(m.cats) : null;
  let best = null;
  for (const r of rows) {
    const title = r[3];
    if ((cats && !cats.has(r[4])) || !inc.test(title) || (exc && exc.test(title))) continue;
    const s = sizeOf(title); let unit = null, pack = null;
    if (p.unit === 'pcs') { if (s && s.pcs && s.qty > 0) { unit = r[5] / s.qty; pack = `${s.qty} бр`; } else if (m.pcsDefault) { unit = r[5] / m.pcsDefault; pack = `${m.pcsDefault} бр`; } }
    else if (s && !s.pcs && s.qty > 0) { unit = r[5] / s.qty * 1000; pack = s.kg ? 'на вагу' : `${s.qty} ${p.unit === 'ml' ? 'мл' : 'г'}`; }
    if (unit && (!best || unit < best.price)) best = { price: +unit.toFixed(3), title, pack, packPrice: r[5] };
  }
  return best;
}

const { day, rows } = await loadRows();
if (args.raw) { fs.mkdirSync(D('bg'), { recursive: true }); fs.writeFileSync(D('bg/raw.json.gz'), zlib.gzipSync(JSON.stringify({ day, rows }))); log('записано data/bg/raw.json.gz', rows.length, 'рядків'); }
const groups = {}; for (const r of rows) ((groups[r[0]] ??= {})[r[1]] ??= []).push(r);
const out = {};
for (const city in groups) for (const chain in groups[city]) for (const p of products) {
  const m = bgp[p.id]; if (!m) continue; if (IDS && !IDS.has(p.id)) continue;
  const b = pick(p, m, groups[city][chain]); if (b) ((out[city] ??= {})[chain] ??= {})[p.id] = b;
}
// Відкидаємо явні помилки збігу (у 2,5 раза дорожче/дешевше за медіану)
const all = {}; for (const c in out) for (const s in out[c]) for (const pid in out[c][s]) (all[pid] ??= []).push(out[c][s][pid].price);
const median = (a) => { const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const dropped = [];
for (const c in out) for (const s in out[c]) for (const pid in out[c][s]) { const v = out[c][s][pid].price, md = median(all[pid]); if (all[pid].length >= 3 && (v > 2.5 * md || v < 0.35 * md)) { dropped.push([c, s, pid, v, md, out[c][s][pid].title]); delete out[c][s][pid]; } }

if (IDS) {
  for (const pid of IDS) for (const c in out) for (const s in out[c]) { const v = out[c][s][pid]; if (v) log(pid, c, s, v.price, '€/кг|бр ·', v.title, '·', v.pack, v.packPrice); }
  for (const d of dropped) log('відкинуто', ...d);
  process.exit(0);
}
const prices = {}; for (const c in out) { prices[c] = {}; for (const s in out[c]) prices[c][s] = Object.fromEntries(Object.entries(out[c][s]).map(([k, v]) => [k, v.price])); }
const cover = Object.fromEntries(products.map((p) => [p.id, Object.values(out).reduce((n, x) => n + Object.values(x).filter((y) => y[p.id]).length, 0)]));
const missing = Object.entries(cover).filter(([, n]) => !n).map(([k]) => k);
log('цін:', Object.values(prices).reduce((n, x) => n + Object.values(x).reduce((m, y) => m + Object.keys(y).length, 0), 0), '· без жодного збігу:', missing.join(', '), '· відкинуто:', dropped.length);
if (!Object.keys(prices).length) { console.error('Порожній результат, prices.json не змінюю'); process.exit(args.raw ? 0 : 1); }
fs.mkdirSync(D('bg'), { recursive: true });
fs.writeFileSync(D('bg/prices.json'), JSON.stringify({
  date: day, unit: '€ за 1 кг / 1 л / 1 шт', source: 'kolkostruva.bg (відкриті дані КЗП)',
  cities: Object.fromEntries(Object.entries(CITIES).map(([k, [n]]) => [k, n])),
  storeNames: Object.fromEntries(Object.entries(CHAINS).map(([k, [n]]) => [k, n])),
  dropped_outliers: dropped, prices,
}, null, 1));
fs.writeFileSync(D('bg/matches.json'), JSON.stringify({ date: day, matches: out }, null, 1));
log('записано data/bg/prices.json і data/bg/matches.json');
