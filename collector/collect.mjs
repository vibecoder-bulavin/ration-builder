// Щоденний збір цін: Сільпо, zakaz.ua (Novus, Metro, Auchan, Megamarket, Ultramarket, ЕКО маркет,
// Таврія В, Восторг, Чудо Маркет) і Фора. Node 20+, без залежностей.
//
//   node collector/collect.mjs                  — повний збір, пише data/prices.json і data/history/<дата>.json
//   node collector/collect.mjs --only=silpo     — лише одне джерело (silpo | zakaz | fora), через кому
//   node collector/collect.mjs --city=kiev      — лише одне місто
//   node collector/collect.mjs --limit=5 --dry  — перші 5 продуктів, нічого не записувати (для перевірки доступу)
//
// Логіка вибору ціни така сама, як у прототипі: пошук за q (і q2), фільтр назви регулярками inc/exc,
// ціна за 1 кг / 1 л / 1 шт, найдешевша підходяща позиція. Явні помилки збігу
// (дорожче 2,5× або дешевше 0,35× медіани по всіх магазинах) відкидаються.
// Якщо магазин сьогодні не віддав ціну, лишаємо вчорашню до 7 днів (поле lastSeen).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = (f) => path.join(ROOT, 'data', f);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const ONLY = args.only ? String(args.only).split(',') : ['silpo', 'zakaz', 'fora'];
const CITY = args.city || null;
const LIMIT = args.limit ? +args.limit : Infinity;
const DRY = !!args.dry;
const KEEP_DAYS = 7;

const IDS = args.ids ? new Set(String(args.ids).split(',')) : null;   // --ids=a,b — перевірка збігу для окремих продуктів, нічого не пише
const products = JSON.parse(fs.readFileSync(D('products.json'), 'utf8')).filter((p) => !IDS || IDS.has(p.id)).slice(0, LIMIT);
const sources = JSON.parse(fs.readFileSync(D('sources.json'), 'utf8'));
const prev = JSON.parse(fs.readFileSync(D('prices.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const cities = Object.keys(sources.cities).filter((c) => !CITY || c === CITY);

const UA = 'ration-builder-price-collector/0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function http(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url, { ...opts, signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
      if (r.status === 429) { const w = Math.min(150, +(r.headers.get('retry-after') || 60)); log('429, чекаю', w, 'с', new URL(url).host); await sleep(w * 1000); continue; }
      if (r.status >= 500) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    } finally { clearTimeout(t); }
  }
  throw new Error('retries exhausted');
}

// "800г", "1кг", "0,5 кг", "900мл", "10шт", "5*80г". \b не працює з кирилицею, тому (?![а-яіїє]).
function sizeOf(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '.');
  const m = t.match(/(?:(\d+)\s*[*x×х]\s*)?(\d+(?:\.\d+)?)\s*(кг|г|л|мл|шт)(?![а-яіїє])/);
  if (!m) return null;
  const n = (m[1] ? +m[1] : 1) * +m[2];
  if (m[3] === 'кг' || m[3] === 'л') return { qty: n * 1000, pcs: false };
  if (m[3] === 'шт') return { qty: n, pcs: true };
  return { qty: n, pcs: false };
}

// rows: {title, price, perKg (ціна вже за кг), size (текст фасовки), weight (г)}
function pick(p, rows) {
  const inc = new RegExp(p.inc, 'i'), exc = p.exc ? new RegExp(p.exc, 'i') : null;
  let best = null;
  for (const r of rows) {
    if (!r.price || !inc.test(r.title) || (exc && exc.test(r.title))) continue;
    let unit = null, pack = null;
    if (p.unit === 'pcs') {
      const s = sizeOf(r.title) || sizeOf(r.size);
      if (s && s.pcs && s.qty > 0) { unit = r.price / s.qty; pack = `${s.qty} шт`; }
    } else if (r.perKg) {
      unit = r.price; pack = 'на вагу';
    } else {
      let s = sizeOf(r.size); if (!s || s.pcs) s = sizeOf(r.title);
      if ((!s || s.pcs) && r.weight > 0) s = { qty: r.weight, pcs: false };
      if (s && !s.pcs && s.qty > 0) { unit = r.price / s.qty * 1000; pack = `${s.qty} ${p.unit === 'ml' ? 'мл' : 'г'}`; }
    }
    if (unit && (!best || unit < best.price)) best = { price: +unit.toFixed(2), title: r.title, pack, packPrice: r.price };
  }
  return best;
}

const out = {};      // out[city][store][pid] = {price,title,pack,packPrice}
const put = (c, s, pid, v) => { if (!v) return; ((out[c] ??= {})[s] ??= {})[pid] = v; };
const stats = {};
const stat = (k, ok) => { stats[k] ??= { ok: 0, miss: 0, err: 0 }; stats[k][ok]++; };

async function silpo() {
  for (const c of cities) {
    const branch = sources.silpo[c]; if (!branch) continue;
    for (const p of products) {
      const rows = [];
      for (const q of [p.q, p.q2].filter(Boolean)) {
        const url = `https://sf-ecom-api.silpo.ua/v1/uk/branches/${branch}/products?limit=60&offset=0&deliveryType=DeliveryHome&includeChildCategories=true&inStock=true&search=${encodeURIComponent(q)}`;
        try {
          const j = await http(url);
          for (const it of j.items || []) rows.push({ title: it.title, price: it.displayPrice, size: it.displayRatio, perKg: /^(1\s*)?кг$/i.test(String(it.displayRatio || '').trim()) });
        } catch (e) { stat(`silpo/${c}`, 'err'); log('silpo', c, p.id, e.message); }
        await sleep(250);
      }
      const b = pick(p, rows); put(c, 'silpo', p.id, b); stat(`silpo/${c}`, b ? 'ok' : 'miss');
    }
    log('silpo', c, JSON.stringify(stats[`silpo/${c}`]));
  }
}

async function zakaz() {
  const jobs = [];
  for (const c of cities) for (const [store, id] of Object.entries(sources.zakaz[c] || {})) for (const p of products) jobs.push({ c, store, id, p });
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const { c, store, id, p } = jobs[i++];
      const rows = [];
      for (const q of [p.q, p.q2].filter(Boolean)) {
        try {
          const j = await http(`https://stores-api.zakaz.ua/stores/${id}/products/search/?q=${encodeURIComponent(q)}&per_page=40`, { headers: { 'Accept-Language': 'uk' } });
          for (const it of j.results || []) rows.push({ title: it.title, price: it.price / 100, perKg: it.unit === 'kg', weight: it.weight || 0 });
        } catch (e) { stat(`${store}/${c}`, 'err'); log('zakaz', store, c, p.id, e.message); }
        await sleep(400);
      }
      const b = pick(p, rows); put(c, store, p.id, b); stat(`${store}/${c}`, b ? 'ok' : 'miss');
    }
  };
  await Promise.all([worker(), worker()]);
  log('zakaz', JSON.stringify(Object.fromEntries(Object.entries(stats).filter(([k]) => !k.startsWith('silpo') && !k.startsWith('fora')))));
}

async function fora() {
  for (const c of cities) {
    const cfg = sources.fora[c]; if (!cfg) continue;
    for (const p of products) {
      const rows = [];
      for (const q of [p.q, p.q2].filter(Boolean)) {
        try {
          const j = await http('https://api.catalog.ecom.fora.ua/api/2.0/exec/EcomCatalogGlobal', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'GetSimpleCatalogItems', data: { merchantId: 2, customFilter: q, deliveryType: cfg.deliveryType, filialId: cfg.filialId, From: 1, To: 40 } }),
          });
          for (const it of j.items || []) rows.push({ title: it.name, price: it.price, size: it.unit, perKg: it.unit === 'кг' || it.unit === 'л' });
        } catch (e) { stat(`fora/${c}`, 'err'); log('fora', c, p.id, e.message); }
        await sleep(300);
      }
      const b = pick(p, rows); put(c, 'fora', p.id, b); stat(`fora/${c}`, b ? 'ok' : 'miss');
    }
    log('fora', c, JSON.stringify(stats[`fora/${c}`]));
  }
}

const runners = { silpo, zakaz, fora };
log('старт:', ONLY.join(','), 'міста:', cities.join(','), 'продуктів:', products.length);
await Promise.all(ONLY.map((s) => runners[s]()));

// Медіана по всіх магазинах і містах на кожен продукт — для відсіву явних помилок збігу
const all = {};
for (const c in out) for (const s in out[c]) for (const pid in out[c][s]) (all[pid] ??= []).push(out[c][s][pid].price);
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const med = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, median(v)]));
const dropped = [];
for (const c in out) for (const s in out[c]) for (const pid in out[c][s]) {
  const v = out[c][s][pid].price, m = med[pid];
  if (all[pid].length >= 3 && (v > 2.5 * m || v < 0.35 * m)) { dropped.push({ city: c, store: s, pid, price: v, median: +m.toFixed(2), title: out[c][s][pid].title }); delete out[c][s][pid]; }
}

const fresh = Object.values(out).flatMap((x) => Object.values(x)).reduce((n, x) => n + Object.keys(x).length, 0);
const prevCount = ONLY.reduce((n, src) => n + cities.reduce((m, c) => m + Object.entries(prev.prices[c] || {})
  .filter(([s]) => (src === 'silpo' ? s === 'silpo' : src === 'fora' ? s === 'fora' : Object.keys(sources.zakaz[c] || {}).includes(s)))
  .reduce((k, [, v]) => k + Object.keys(v).length, 0), 0), 0);
log(`свіжих цін: ${fresh}, було: ${prevCount}, відкинуто як помилки збігу: ${dropped.length}`);
for (const d of dropped.slice(0, 20)) log('  відкинуто', d.city, d.store, d.pid, d.price, 'медіана', d.median, '·', d.title);

if (IDS) {
  for (const pid of IDS) for (const c in out) for (const st in out[c]) { const v = out[c][st][pid]; if (v) log('збіг', pid, c, st, v.price, 'грн/кг|шт', '·', v.title, '·', v.pack, v.packPrice); }
  for (const pid of IDS) log('магазинів зі збігом', pid, Object.values(out).reduce((n, x) => n + Object.values(x).filter((y) => y[pid]).length, 0));
  log('--ids: нічого не записую'); process.exit(0);
}
if (DRY) { log('--dry: нічого не записую'); process.exit(0); }
if (LIMIT !== Infinity || CITY) { log('часткова перевірка (--limit/--city): нічого не записую'); process.exit(0); }
if (prevCount && fresh < prevCount * 0.3) {
  console.error(`Свіжих цін підозріло мало (${fresh} проти ${prevCount}). Ймовірно, доступ заблоковано. prices.json не змінюю.`);
  process.exit(1);
}

// Злиття: нові ціни + вчорашні (до KEEP_DAYS днів), якщо магазин сьогодні не віддав товар
const lastSeen = prev.lastSeen || {};
const prices = {};
const ageDays = (d) => (Date.parse(today) - Date.parse(d)) / 864e5;
for (const c of Object.keys(sources.cities)) {
  prices[c] = {};
  const stores = new Set([...Object.keys(prev.prices[c] || {}), ...Object.keys(out[c] || {})]);
  for (const s of stores) {
    const manual = (sources.manual?.[s] || []).includes(c);
    const collected = !manual && (s === 'silpo' ? ONLY.includes('silpo') : s === 'fora' ? ONLY.includes('fora') : ONLY.includes('zakaz'));
    prices[c][s] = {};
    for (const p of JSON.parse(fs.readFileSync(D('products.json'), 'utf8'))) {
      const key = `${c}/${s}/${p.id}`;
      const now = out[c]?.[s]?.[p.id];
      if (now) { prices[c][s][p.id] = now.price; lastSeen[key] = today; continue; }
      const old = prev.prices[c]?.[s]?.[p.id];
      if (old == null) continue;
      const seen = lastSeen[key] || prev.date?.slice(0, 10) || today;
      if (!collected || ageDays(seen) <= KEEP_DAYS) { prices[c][s][p.id] = old; lastSeen[key] = seen; }
      else delete lastSeen[key];
    }
  }
}

const result = {
  date: today,
  unit: 'грн за 1 кг / 1 л / 1 шт (яйця)',
  cities: sources.cities,
  storeNames: sources.storeNames,
  notes: { varus: 'ціни внесені вручну 23–24.11.2026, автозбору поки немає' },
  stats,
  dropped_outliers: dropped,
  lastSeen,
  prices,
};
fs.writeFileSync(D('prices.json'), JSON.stringify(result, null, 1));
fs.mkdirSync(D('history'), { recursive: true });
const compact = {}; for (const c in out) for (const s in out[c]) for (const pid in out[c][s]) ((compact[c] ??= {})[s] ??= {})[pid] = [out[c][s][pid].price, out[c][s][pid].pack];
fs.writeFileSync(D(`history/${today}.json`), JSON.stringify({ date: today, prices: compact }));
// Які саме товари обрано — для ручної перевірки збігів (перезаписується щодня)
fs.writeFileSync(D('matches.json'), JSON.stringify({ date: today, matches: out }, null, 1));
log('записано data/prices.json, data/matches.json і data/history/' + today + '.json');
