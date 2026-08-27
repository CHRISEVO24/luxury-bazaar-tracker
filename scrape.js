#!/usr/bin/env node
// scrape.js — Luxury Bazaar Inventory Tracker

const https = require('https');
const fs    = require('fs');

const SITE_URL    = 'https://www.luxurybazaar.com';
const PER_PAGE    = 100;
const CACHE_FILE  = 'attribute-cache.json';
const HISTORY_FILE= 'history.json';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJsonWithHeaders(url) {
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
  if (!cents || cents === '0') return '';
  const n = parseInt(cents);
  if (!n) return '';
  return '$' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildProduct(api) {
  const attrs = api.attributes || [];
  return {
    id:              api.id,
    sku:             api.sku || String(api.id),
    name:            api.name || '',
    brand:           getAttr(attrs, 'Brand'),
    referenceNumber: getAttr(attrs, 'Reference Number'),
    condition:       getAttr(attrs, 'Condition'),
    collection:      getAttr(attrs, 'Collection'),
    gender:          getAttr(attrs, 'Gender'),
    caseMaterial:    getAttr(attrs, 'Case Material'),
    caseSize:        getAttr(attrs, 'Case Size'),
    dialColor:       getAttr(attrs, 'Dial Color'),
    movement:        getAttr(attrs, 'Movement'),
    bezel:           getAttr(attrs, 'Bezel'),
    bracelet:        getAttr(attrs, 'Band Type'),
    box:             getAttr(attrs, 'Box'),
    papers:          getAttr(attrs, 'Papers'),
    caliber:         getAttr(attrs, 'Caliber'),
    functions:       getAttr(attrs, 'Watch Functions'),
    price:           formatPrice(api.prices?.price),
    regularPrice:    formatPrice(api.prices?.regular_price),
    salePrice:       api.prices?.sale_price && api.prices.sale_price !== api.prices.regular_price
                       ? formatPrice(api.prices.sale_price) : '',
    stockStatus:     api.is_in_stock ? 'In Stock' : 'Out of Stock',
    inStock:         !!api.is_in_stock,
    categories:      (api.categories || []).map(c => c.name).join(', '),
    images:          (api.images || []).slice(0, 5).map(img => img.src || '').filter(Boolean),
    url:             api.permalink || '',
    description:     (api.short_description || '').replace(/<[^>]*>/g, '').slice(0, 200),
  };
}

async function fetchByStatus(stockStatus) {
  const all = [];
  let page = 1, totalPages = 1;
  process.stdout.write(`  Fetching ${stockStatus} products`);
  while (page <= totalPages) {
    const { json, headers } = await fetchJsonWithHeaders(
      `${SITE_URL}/wp-json/wc/store/products?per_page=${PER_PAGE}&page=${page}&stock_status=${stockStatus}`
    );
    if (!Array.isArray(json) || json.length === 0) break;
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
  // Timestamp in ET
  const nowEt = new Date();
  const etMs = nowEt.getTime() - 4 * 3600000;
  const etDate = new Date(etMs);
  const pad = n => String(n).padStart(2,'0');
  const timestamp = `${etDate.getUTCFullYear()}-${pad(etDate.getUTCMonth()+1)}-${pad(etDate.getUTCDate())} ${pad(etDate.getUTCHours())}:${pad(etDate.getUTCMinutes())} ET`;

  console.log('Luxury Bazaar — Inventory Snapshot');
  console.log('Timestamp :', timestamp);

  // Load existing history
  let history = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  }

  // Track existing SKUs for new item detection
  const existingSkus = new Set();
  Object.values(history).forEach(snap => Object.keys(snap).forEach(k => existingSkus.add(k)));
  console.log('Existing SKUs:', existingSkus.size);

  // Fetch all products (in stock + out of stock)
  const inStock    = await fetchByStatus('instock');
  const outOfStock = await fetchByStatus('outofstock');
  const allProducts = [...inStock, ...outOfStock];
  console.log(`Total: ${allProducts.length} products\n`);

  // Build snapshot
  const snapshot = {};
  for (const p of allProducts) {
    snapshot[p.id] = buildProduct(p);
  }

  const inStockCount = Object.values(snapshot).filter(p => p.inStock).length;
  console.log(`In Stock: ${inStockCount} / Out of Stock: ${allProducts.length - inStockCount}`);

  // Save
  history[timestamp] = snapshot;

  // Keep last 500 snapshots
  const keys = Object.keys(history).sort();
  if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete history[k]);

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  // Save latest.json — slim version of current snapshot for fast dashboard loading
  // Only keep fields needed for display (strip images array to save space)
  const slimSnapshot = {};
  for (const [id, item] of Object.entries(snapshot)) {
    slimSnapshot[id] = {
      id:              item.id,
      sku:             item.sku,
      name:            item.name,
      brand:           item.brand,
      referenceNumber: item.referenceNumber,
      condition:       item.condition,
      caseMaterial:    item.caseMaterial,
      caseSize:        item.caseSize,
      dialColor:       item.dialColor,
      movement:        item.movement,
      box:             item.box,
      papers:          item.papers,
      price:           item.price,
      regularPrice:    item.regularPrice,
      salePrice:       item.salePrice,
      stockStatus:     item.stockStatus,
      inStock:         item.inStock,
      categories:      item.categories,
      url:             item.url,
      image:           item.images && item.images[0] ? item.images[0] : '',
      description:     item.description,
      year:            item.year || '',
    };
  }
  const latestExport = {};
  latestExport[timestamp] = slimSnapshot;
  fs.writeFileSync('latest.json', JSON.stringify(latestExport));
  console.log(`Saved ${Object.keys(snapshot).length} products`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
