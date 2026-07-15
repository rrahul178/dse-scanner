/**
 * DSE (dsebd.org) Scraper
 * ------------------------------------------------------------
 * bd-stock-api (faysal515/bd-stock-api) এর logic অনুসরণ করে বানানো।
 * GitHub Actions cron দিয়ে এই script রান হবে, output data/*.json ফাইলে
 * সেভ হয়ে repo-তে commit হবে। Frontend সেই raw JSON fetch করবে
 * (GitHub Pages/Netlify থেকে) - কোনো CORS সমস্যা নেই কারণ এটা নিজের
 * ডোমেইনেরই static ফাইল।
 *
 * চালানোর নিয়ম: node scripts/scrape.js
 */

const axios = require("axios");
const axiosRetry = require("axios-retry").default || require("axios-retry");
const cheerio = require("cheerio");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------- Config ----------
const DSE_BASE_URL = "https://dsebd.org";

const URLS = {
  LATEST: `${DSE_BASE_URL}/latest_share_price_scroll_l.php`,
  TOP_30: `${DSE_BASE_URL}/dse30_share.php`,
  DSEX: `${DSE_BASE_URL}/dseX_share.php`,
  HISTORICAL: `${DSE_BASE_URL}/day_end_archive.php`,
};

// এখানে যেসব শেয়ারের historical OHLC (RSI/MA calc এর জন্য) লাগবে, সেই তালিকা।
// পুরো ~৪০০+ শেয়ারের historical প্রতি ১৫ মিনিটে টানলে dsebd.org block করে দিতে পারে,
// তাই দুই ধাপে scan করা হচ্ছে:
//   ধাপ ১: latest.json (সব শেয়ারের আজকের price/volume/change) - সস্তা, ১ request
//   ধাপ ২: শুধু WATCHLIST এর শেয়ারের জন্য historical OHLC (RSI/MA/ATR calc)
// চাইলে এই লিস্ট বড় করতে পারো, বা latest.json থেকে top gainers/losers অটো বাছাই
// করে dynamically watchlist বানাতে পারো (পরের ধাপে করা যাবে)।
const WATCHLIST = ["GP", "BEXIMCO", "SQURPHARMA", "ACI", "BATBC"];

const HIST_DAYS = 120; // RSI(14), MA(50) ইত্যাদির জন্য যথেষ্ট history

const OUTPUT_DIR = path.join(__dirname, "..", "data");
const HIST_DIR = path.join(OUTPUT_DIR, "historical");

// ---------- HTTP client ----------
const client = axios.create({
  headers: {
    // dsebd.org কিছু bot-blocker থাকলে plain UA ছাড়া রিকোয়েস্ট রিজেক্ট করতে পারে
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  },
  timeout: 20000,
  // dsebd.org এর SSL certificate chain অসম্পূর্ণ (intermediate certificate সার্ভ করে না),
  // ফলে Node.js এ "unable to verify the first certificate" error আসে যদিও browser এ
  // সমস্যা হয় না (browser নিজে থেকে missing cert fetch করে নেয়)। এটা শুধু dsebd.org
  // এর জন্যই প্রযোজ্য - পাবলিক স্টক ডেটা read করার জন্য নিরাপদ।
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

axiosRetry(client, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    err.code === "ECONNABORTED",
});

// ---------- Helpers ----------
function ensureDirs() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(HIST_DIR, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✔ লেখা হলো: ${path.relative(process.cwd(), filePath)} (${Array.isArray(data) ? data.length : "1"} rows)`);
}

async function fetchHtml(url, params = {}) {
  const res = await client.get(url, { params });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} ফেরত এসেছে: ${url}`);
  }
  return cheerio.load(res.data);
}

// dsebd.org এর সব টেবিলের structure একইরকম:
// প্রথম <tr> এর <th> গুলো header, তারপরের <tr> গুলোর <td> সেই header অনুযায়ী map হয়
function parseTable($, selector, skipFirstRow = true) {
  const headers = [];
  $(selector)
    .first()
    .find("th")
    .each((_, th) => headers.push($(th).text().trim()));

  // কিছু পেজে header row আলাদাভাবে টেবিলের বাইরে থাকে, তাই fallback হিসেবে
  // পুরো টেবিলের প্রথম row থেকেও চেষ্টা করা হচ্ছে
  const rows = [];
  $(selector).each((index, el) => {
    if (index === 0 && skipFirstRow && headers.length) return;
    const tds = $(el).find("td");
    if (!tds.length) return;
    const row = {};
    headers.forEach((h, idx) => {
      row[h || `col_${idx}`] = $(tds[idx]).text().trim().replace(/,/g, "");
    });
    rows.push(row);
  });
  return rows;
}

// ---------- Scrapers ----------
async function scrapeLatest() {
  const $ = await fetchHtml(URLS.LATEST);
  return parseTable($, "table.table-bordered tr");
}

async function scrapeTop30() {
  const $ = await fetchHtml(URLS.TOP_30);
  return parseTable($, "table.table-bordered tr");
}

async function scrapeDsex() {
  const $ = await fetchHtml(URLS.DSEX);
  return parseTable($, "table.table-bordered tr");
}

async function scrapeHistorical(code, days = HIST_DAYS) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);

  const fmt = (d) => d.toISOString().slice(0, 10);

  const $ = await fetchHtml(URLS.HISTORICAL, {
    startDate: fmt(start),
    endDate: fmt(end),
    inst: code,
    archive: "data",
  });

  const rows = parseTable($, "table.table-bordered tbody tr", false);
  // পুরনো থেকে নতুন তারিখের ক্রমে সাজানো (RSI/MA calc এর জন্য সুবিধাজনক)
  return rows.reverse();
}

// ---------- Main ----------
async function main() {
  ensureDirs();
  const startedAt = new Date().toISOString();
  console.log(`\n🔎 DSE scrape শুরু: ${startedAt}\n`);

  const results = { latest: null, top30: null, dsex: null };

  try {
    results.latest = await scrapeLatest();
    writeJson(path.join(OUTPUT_DIR, "latest.json"), results.latest);
  } catch (err) {
    console.error("✗ latest.json স্ক্র্যাপ ব্যর্থ:", err.message);
  }

  try {
    results.top30 = await scrapeTop30();
    writeJson(path.join(OUTPUT_DIR, "top30.json"), results.top30);
  } catch (err) {
    console.error("✗ top30.json স্ক্র্যাপ ব্যর্থ:", err.message);
  }

  try {
    results.dsex = await scrapeDsex();
    writeJson(path.join(OUTPUT_DIR, "dsex.json"), results.dsex);
  } catch (err) {
    console.error("✗ dsex.json স্ক্র্যাপ ব্যর্থ:", err.message);
  }

  for (const code of WATCHLIST) {
    try {
      const hist = await scrapeHistorical(code);
      writeJson(path.join(HIST_DIR, `${code}.json`), hist);
    } catch (err) {
      console.error(`✗ ${code} historical স্ক্র্যাপ ব্যর্থ:`, err.message);
    }
    // dsebd.org কে একসাথে অনেক রিকোয়েস্টে চাপ না দিতে সামান্য delay
    await new Promise((r) => setTimeout(r, 1500));
  }

  // meta info - frontend এ "last updated" দেখানোর জন্য
  writeJson(path.join(OUTPUT_DIR, "meta.json"), {
    lastScrapedAt: new Date().toISOString(),
    watchlist: WATCHLIST,
  });

  console.log("\n✅ স্ক্র্যাপ সম্পন্ন\n");
}

main().catch((err) => {
  console.error("❌ Scraper পুরোপুরি ব্যর্থ:", err);
  process.exit(1);
});
