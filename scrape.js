#!/usr/bin/env node
// scrape.js — Luxury Bazaar Inventory Tracker

const https = require('https');
const fs    = require('fs');

const SITE_URL     = 'https://www.luxurybazaar.com';
const PER_PAGE     = 100;
const HISTORY_FILE = 'history.json';
const LATEST_FILE  = 'latest.json';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'LBTracker/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ json: JSON.parse(d), headers: res.headers }); }
        catch(e) { resolve({ json: null, headers: res.headers }); }
      });
    }).on('error', reject);
  });
}

function getAttr(attributes, name) {
  const attr = (attributes || []).find(a => a.name === name);
  return attr?.terms?.map(t => t.name).join(', ') || '';
}

function formatPrice(cents) {
  const n = parseInt(cents || '0');
  if (!n) return '';
  return '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function buildProduct(api) {
  const a = api.attributes || [];
  return {
    id:              api.id,
    sku:             api.sku || String(api.id),
    name:            api.name || '',
    brand:           getAttr(a, 'Brand'),
    referenceNumber: getAttr(a, 'Reference Number'),
    condition:       getAttr(a, 'Condition'),
    collection:      getAttr(a, 'Collection'),
    caseMaterial:    getAttr(a, 'Case Material'),
    caseSize:        getAttr(a, 'Case Size'),
    dialColor:       getAttr(a, 'Dial Color'),
    movement:        getAttr(a, 'Movement'),
    bezel:           getAttr(a, 'Bezel'),
    bracelet:        getAttr(a, 'Band Type'),
    box:             getAttr(a, 'Box'),
    papers:          getAttr(a, 'Papers'),
    price:           formatPrice(api.prices?.price),
    regularPrice:    formatPrice(api.prices?.regular_price),
    stockStatus:     api.is_in_stock ? 'In Stock' : 'Out of Stock',
    inStock:         !!api.is_in_stock,
    categories:      (api.categories || []).map(c => c.name).join(', '),
    url:             api.permalink || '',
    image:           api.images?.[0]?.src || '',
    description:     (api.short_description || '').replace(/<[^>]*>/g, '').slice(0, 150),
    year:            '',
  };
}

async function fetchByStatus(status) {
  const all = [];
  let page = 1, totalPages = 1;
  process.stdout.write(`  Fetching ${status}`);
  while (page <= totalPages) {
    const { json, headers } = await fetchJson(
      `${SITE_URL}/wp-json/wc/store/products?per_page=${PER_PAGE}&page=${page}&stock_status=${status}`
    );
    if (!Array.isArray(json) || !json.length) break;
    all.push(...json);
    totalPages = parseInt(headers['x-wp-totalpages'] || '1', 10);
    process.stdout.write('.');
    page++;
    await sleep(300);
  }
  console.log(` (${all.length})`);
  return all;
}

async function main() {
  // ET timestamp (UTC-4)
  const nowEt = new Date(Date.now() - 4 * 3600000);
  const p = n => String(n).padStart(2, '0');
  const timestamp = `${nowEt.getUTCFullYear()}-${p(nowEt.getUTCMonth()+1)}-${p(nowEt.getUTCDate())} ${p(nowEt.getUTCHours())}:${p(nowEt.getUTCMinutes())} ET`;

  console.log('Luxury Bazaar — Inventory Snapshot');
  console.log('Timestamp :', timestamp);

  // Load existing history (from releases download in workflow)
  let history = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
    console.log('History snapshots:', Object.keys(history).length);
  }

  // Fetch current products
  const inStock    = await fetchByStatus('instock');
  const outOfStock = await fetchByStatus('outofstock');
  const all        = [...inStock, ...outOfStock];
  console.log(`Total: ${all.length} | In Stock: ${inStock.length} | Out of Stock: ${outOfStock.length}`);

  // Build current snapshot
  const snapshot = {};
  for (const p of all) snapshot[p.id] = buildProduct(p);

  // Add to history and trim
  history[timestamp] = snapshot;
  const hkeys = Object.keys(history).sort();
  if (hkeys.length > 500) hkeys.slice(0, hkeys.length - 500).forEach(k => delete history[k]);

  // Save full history (uploaded to releases by workflow)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  console.log(`history.json: ${hkeys.length} snapshots, ${all.length} products each`);

  // Save SLIM latest.json — only current snapshot, only display fields (~2MB)
  const slim = {};
  for (const [id, item] of Object.entries(snapshot)) {
    slim[id] = {
      id: item.id, sku: item.sku, name: item.name,
      brand: item.brand, referenceNumber: item.referenceNumber,
      condition: item.condition, caseMaterial: item.caseMaterial,
      caseSize: item.caseSize, dialColor: item.dialColor,
      movement: item.movement, box: item.box, papers: item.papers,
      price: item.price, regularPrice: item.regularPrice,
      stockStatus: item.stockStatus, inStock: item.inStock,
      categories: item.categories, url: item.url, image: item.image,
      description: item.description,
    };
  }
  const latestOut = {};
  latestOut[timestamp] = slim;
  fs.writeFileSync(LATEST_FILE, JSON.stringify(latestOut));
  console.log(`latest.json: 1 snapshot, ${Object.keys(slim).length} products, ~${Math.round(JSON.stringify(latestOut).length/1024)}KB`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
