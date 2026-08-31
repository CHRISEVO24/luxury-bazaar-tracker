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
    // Filter by Product Type attribute (taxonomy: pa_product_type, term ID: 47884 = Luxury Watches)
    const { json, headers } = await fetchJson(
      `${SITE_URL}/wp-json/wc/store/products?per_page=${PER_PAGE}&page=${page}&stock_status=${status}&attribute=pa_product_type&attribute_term=47884`
    );
    if (!Array.isArray(json) || !json.length) break;
    // Belt-and-suspenders: only keep items that have "Watches" or "Luxury Watches" in Product Type
    const watchesOnly = json.filter(p => {
      const pt = (p.attributes || []).find(a => a.name === 'Product Type' || a.taxonomy === 'pa_product_type');
      return pt?.terms?.some(t => t.name === 'Watches' || t.name === 'Luxury Watches');
    });
    all.push(...watchesOnly);
    totalPages = parseInt(headers['x-wp-totalpages'] || '1', 10);
    process.stdout.write('.');
    page++;
    await sleep(300);
  }
  console.log(` (${all.length})`);
  return all;
}

async function loadHistoryFromRepo() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return {};
  const repo = process.env.GITHUB_REPOSITORY || 'CHRISEVO24/luxury-bazaar-tracker';
  try {
    const result = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/history.json`,
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'LBTracker', 'Accept': 'application/vnd.github.v3+json' }
      };
      https.get(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    if (result.content) {
      const decoded = Buffer.from(result.content.replace(/\n/g,''), 'base64').toString('utf8');
      const history = JSON.parse(decoded);
      console.log(`Loaded ${Object.keys(history).length} snapshots from repo history.json`);
      return history;
    }
  } catch(e) { console.log('Could not load history from repo:', e.message); }
  return {};
}

async function main() {
  // ET timestamp using system TZ (set by workflow env or toLocaleString)
  const nowUtc = new Date();
  const etStr = nowUtc.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  // etStr format: "MM/DD/YYYY, HH:MM" — convert to "YYYY-MM-DD HH:MM ET"
  const [datePart, timePart] = etStr.replace(',', '').trim().split(' ');
  const [mo, da, yr] = datePart.split('/');
  const timestamp = `${yr}-${mo}-${da} ${timePart} ET`;

  console.log('Luxury Bazaar — Inventory Snapshot');
  console.log('Timestamp :', timestamp);

  // Load existing history from disk (downloaded from releases by workflow)
  let history = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      // Only keep slim watch-only snapshots (filter out old pre-watch-filter ones)
      Object.keys(history).forEach(k => {
        if (Object.keys(history[k]).length > 6000) delete history[k];
      });
      console.log('History snapshots loaded:', Object.keys(history).length);
    } catch(e) { console.log('Could not parse history:', e.message); }
  }

  // Fetch current products
  const inStock    = await fetchByStatus('instock');
  const outOfStock = await fetchByStatus('outofstock');
  const all        = [...inStock, ...outOfStock];
  console.log(`Total: ${all.length} | In Stock: ${inStock.length} | Out of Stock: ${outOfStock.length}`);

  // Build current snapshot
  const snapshot = {};
  for (const p of all) snapshot[p.id] = buildProduct(p);

  // Build slim snapshot for history.json (only fields needed for comparison)
  const HIST_KEEP = new Set(['id','sku','name','brand','referenceNumber','price','regularPrice',
    'stockStatus','inStock','categories','url','condition','caseSize','dialColor']);
  const slimForHistory = {};
  for (const [id, item] of Object.entries(snapshot)) {
    slimForHistory[id] = Object.fromEntries(Object.entries(item).filter(([k]) => HIST_KEEP.has(k)));
  }

  // Add to history and trim
  history[timestamp] = slimForHistory;
  // Trim to last 20 snapshots (~48MB) — well under GitHub's 100MB git limit
  const hkeys = Object.keys(history).sort();
  if (hkeys.length > 20) hkeys.slice(0, hkeys.length - 20).forEach(k => delete history[k]);

  // Save full history (uploaded to releases by workflow)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  console.log(`history.json: ${hkeys.length} snapshots, ${all.length} products each`);

  // Save SLIM latest.json — only current snapshot, only display fields (~2MB)
  // latest.json has ALL watches (in-stock + out-of-stock) — ~5MB for watches only
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

  // Files are committed via git in the workflow (API push removed — fails for files >1MB)
  console.log('Files saved to disk — workflow will git-commit them');
}

async function pushFileViaAPI(filename, content) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) { console.log('No token - skipping API push for', filename); return; }
  const repo = process.env.GITHUB_REPOSITORY || 'CHRISEVO24/luxury-bazaar-tracker';

  // Get current SHA
  let sha = '';
  try {
    const getResp = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.github.com',
        path: `/repos/${repo}/contents/${filename}`,
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'LBTracker', 'Accept': 'application/vnd.github.v3+json' }
      };
      https.get(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    sha = getResp.sha || '';
  } catch(e) {}

  const body = JSON.stringify({
    message: `Auto update [skip ci] - ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}`,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {})
  });

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${repo}/contents/${filename}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'LBTracker',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const result = JSON.parse(d);
        if (result.content) console.log(`✅ ${filename} pushed via API`);
        else console.log(`❌ ${filename} push failed:`, result.message);
        resolve(result);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
