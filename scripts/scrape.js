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

// আগে এখানে fixed ৫টা শেয়ারের নাম ছিল। এখন থেকে সেই পদ্ধতি বাদ - প্রতিবার
// scrape এর সময় latest.json (আজকের সব ৩৯৬ শেয়ারের ডেটা) থেকে সবচেয়ে বেশি
// লিকুইড (ট্রেড ভ্যালু বেশি) ও পেনি-স্টক নয় এমন শেয়ারগুলো bottom-up বাছাই
// করা হয়, আর শুধু তাদেরই historical OHLC আনা হয়। Frontend পরে এই candidate
// লিস্ট থেকে RSI/MA/breakout/candlestick স্কোর করে টপ ১০ "buy" সিগন্যাল বের করে।
const CANDIDATE_COUNT = 40; // কতগুলো লিকুইড শেয়ারের historical আনা হবে
const MIN_PRICE = 5; // এর নিচে দামের পেনি/জাঙ্ক শেয়ার বাদ

const HIST_DAYS = 380; // ৫২ সপ্তাহ (৩৬৫ দিন) + বাফার কভার করার জন্য - 52-week high/low, RSI(14), MA(50) সবকিছুর জন্য যথেষ্ট

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

// dsebd.org এর সব টেবিলের structure একইরকম, কিন্তু কিছু পেজে (যেমন historical
// archive) header row (<th>) ডেটা রো গুলোর মতো একই <tbody>-তে থাকে না।
// তাই header আর row খোঁজার selector আলাদা রাখা হচ্ছে - header যেকোনো <tr>
// থেকে (thead/tbody নির্বিশেষে) প্রথমটা থেকে নেওয়া হয়, আর row নির্দিষ্ট
// selector (যেমন শুধু tbody tr) থেকে।
function parseTable($, tableSelector, rowSelector, skipFirstRow = true) {
  const headers = [];
  $(`${tableSelector} tr`)
    .first()
    .find("th")
    .each((_, th) => headers.push($(th).text().trim()));

  const rows = [];
  $(rowSelector).each((index, el) => {
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

// ---------- Candidate selection ----------
// আজকের ট্রেড ভ্যালু (VALUE mn) অনুযায়ী সবচেয়ে বেশি লিকুইড শেয়ারগুলো বাছাই
// করা হয় - এগুলোই RSI/MA/breakout/candlestick বিশ্লেষণের candidate।
function selectCandidates(latestRows) {
  return latestRows
    .filter((r) => {
      const ltp = parseFloat(r["LTP*"]);
      const value = parseFloat(r["VALUE (mn)"]);
      return r["TRADING CODE"] && !isNaN(ltp) && ltp >= MIN_PRICE && !isNaN(value) && value > 0;
    })
    .sort((a, b) => parseFloat(b["VALUE (mn)"]) - parseFloat(a["VALUE (mn)"]))
    .slice(0, CANDIDATE_COUNT)
    .map((r) => r["TRADING CODE"]);
}

// ---------- ট্রেডিং স্ট্র্যাটেজি স্কোরিং (frontend এর analyzeWatchlistStock/
// computeBuyScore থেকে পোর্ট করা - server-side এ এই একই লজিক দিয়ে ৪০টা
// candidate থেকে টপ ১০ "ক্রয়যোগ্য" বাছাই করা হয়) ----------
function num(v) {
  if (v === undefined || v === null) return NaN;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return isNaN(n) ? NaN : n;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(arr.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function detectCandlestickPattern(candles) {
  const n = candles.length;
  if (n < 1) return null;
  const c0 = candles[n - 1];
  const body = (c) => Math.abs(c.close - c.open);
  const range = (c) => Math.max(c.high - c.low, 0.0001);
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;
  const upperWick = (c) => c.high - Math.max(c.open, c.close);
  const lowerWick = (c) => Math.min(c.open, c.close) - c.low;

  if (n >= 2) {
    const c1 = candles[n - 2];
    if (isBear(c1) && isBull(c0) && c0.open <= c1.close && c0.close >= c1.open && body(c0) > body(c1)) {
      return { name: "বুলিশ এনগাল্ফিং", type: "bullish" };
    }
    if (isBull(c1) && isBear(c0) && c0.open >= c1.close && c0.close <= c1.open && body(c0) > body(c1)) {
      return { name: "বেয়ারিশ এনগাল্ফিং", type: "bearish" };
    }
  }
  if (n >= 3) {
    const c1 = candles[n - 2], c2 = candles[n - 3];
    if (isBear(c2) && body(c2) / range(c2) > 0.4 && body(c1) / range(c1) < 0.3 &&
        isBull(c0) && c0.close > (c2.open + c2.close) / 2) {
      return { name: "মর্নিং স্টার", type: "bullish" };
    }
    if (isBull(c2) && body(c2) / range(c2) > 0.4 && body(c1) / range(c1) < 0.3 &&
        isBear(c0) && c0.close < (c2.open + c2.close) / 2) {
      return { name: "ইভিনিং স্টার", type: "bearish" };
    }
  }
  const bodyRatio = body(c0) / range(c0);
  if (lowerWick(c0) >= 2 * body(c0) && upperWick(c0) <= body(c0) * 0.5 && bodyRatio < 0.35) {
    return { name: "হ্যামার", type: "bullish" };
  }
  if (upperWick(c0) >= 2 * body(c0) && lowerWick(c0) <= body(c0) * 0.5 && bodyRatio < 0.35) {
    return { name: "শুটিং স্টার", type: "bearish" };
  }
  if (upperWick(c0) < range(c0) * 0.05 && lowerWick(c0) < range(c0) * 0.05 && bodyRatio > 0.85) {
    return { name: isBull(c0) ? "বুলিশ মারুবোজু" : "বেয়ারিশ মারুবোজু", type: isBull(c0) ? "bullish" : "bearish" };
  }
  if (bodyRatio < 0.1) return { name: "ডোজি", type: "neutral" };
  return null;
}

function detectOrderBlock(rows) {
  const n = rows.length;
  if (n < 10) return null;
  const recent = rows.slice(-10);
  for (let i = recent.length - 1; i >= 1; i--) {
    const ob = recent[i - 1];
    const move = recent[i];
    const moveBody = Math.abs(move.close - move.open);
    const moveRange = Math.max(move.high - move.low, 0.0001);
    const isImpulsive = moveBody / moveRange > 0.55;
    if (ob.close < ob.open && move.close > move.open && isImpulsive && move.close > ob.high) {
      return { type: "bullish", zoneLow: ob.low, zoneHigh: ob.high };
    }
    if (ob.close > ob.open && move.close < move.open && isImpulsive && move.close < ob.low) {
      return { type: "bearish", zoneLow: ob.low, zoneHigh: ob.high };
    }
  }
  return null;
}

function detectFVG(rows) {
  const n = rows.length;
  if (n < 3) return null;
  const c1 = rows[n - 3], c3 = rows[n - 1];
  if (c1.high < c3.low) return { type: "bullish", top: c3.low, bottom: c1.high };
  if (c1.low > c3.high) return { type: "bearish", top: c1.low, bottom: c3.high };
  return null;
}

function detectLiquiditySweep(rows) {
  const n = rows.length;
  if (n < 22) return null;
  const lookback = rows.slice(-22, -1);
  const priorLow = Math.min(...lookback.map((r) => r.low));
  const priorHigh = Math.max(...lookback.map((r) => r.high));
  const today = rows[n - 1];
  if (today.low < priorLow && today.close > priorLow) return { type: "bullish", level: priorLow };
  if (today.high > priorHigh && today.close < priorHigh) return { type: "bearish", level: priorHigh };
  return null;
}

// ---------- Support & Resistance (risk/reward হিসাবের জন্য দরকার) ----------
function findSwingPoints(rows, lookback = 5) {
  const swingHighs = [], swingLows = [];
  for (let i = lookback; i < rows.length - lookback; i++) {
    const windowSlice = rows.slice(i - lookback, i + lookback + 1);
    if (windowSlice.every((r) => r.high <= rows[i].high)) swingHighs.push(rows[i].high);
    if (windowSlice.every((r) => r.low >= rows[i].low)) swingLows.push(rows[i].low);
  }
  return { swingHighs, swingLows };
}

function clusterLevels(levels, tolerancePct = 0.015) {
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters = [];
  for (const lvl of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(lvl - last.avg) / last.avg <= tolerancePct) {
      last.values.push(lvl);
      last.avg = last.values.reduce((a, b) => a + b, 0) / last.values.length;
    } else {
      clusters.push({ avg: lvl, values: [lvl] });
    }
  }
  return clusters.map((c) => ({ level: c.avg, touches: c.values.length }));
}

function computeSupportResistance(rows, ltp) {
  const { swingHighs, swingLows } = findSwingPoints(rows, 5);
  const resistances = clusterLevels(swingHighs).filter((c) => c.level > ltp).sort((a, b) => a.level - b.level);
  const supports = clusterLevels(swingLows).filter((c) => c.level < ltp).sort((a, b) => b.level - a.level);
  return {
    resistance: resistances[0] ? resistances[0].level : null,
    support: supports[0] ? supports[0].level : null,
  };
}

// ---------- ADX(14) - Wilder's Average Directional Index ----------
function computeADX(history, period = 14) {
  if (history.length < period * 2) return null;
  const plusDM = [], minusDM = [], TR = [];
  for (let i = 1; i < history.length; i++) {
    const upMove = history[i].high - history[i - 1].high;
    const downMove = history[i - 1].low - history[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    TR.push(Math.max(
      history[i].high - history[i].low,
      Math.abs(history[i].high - history[i - 1].close),
      Math.abs(history[i].low - history[i - 1].close)
    ));
  }
  // Wilder smoothing
  const smooth = (arr) => {
    const out = [arr.slice(0, period).reduce((a, b) => a + b, 0)];
    for (let i = period; i < arr.length; i++) {
      out.push(out[out.length - 1] - out[out.length - 1] / period + arr[i]);
    }
    return out;
  };
  const smTR = smooth(TR), smPlusDM = smooth(plusDM), smMinusDM = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < smTR.length; i++) {
    const plusDI = (smPlusDM[i] / smTR[i]) * 100;
    const minusDI = (smMinusDM[i] / smTR[i]) * 100;
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }
  if (dx.length < period) return null;
  // ADX = DX এর Wilder-smoothed গড়
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return adx;
}

// ---------- MFI(14) - Money Flow Index ----------
function computeMFI(history, period = 14) {
  if (history.length < period + 1) return null;
  const tp = history.map((h) => (h.high + h.low + h.close) / 3);
  const rmf = tp.map((t, i) => t * history[i].volume);
  let posFlow = 0, negFlow = 0;
  const start = history.length - period;
  for (let i = Math.max(1, start); i < history.length; i++) {
    if (tp[i] > tp[i - 1]) posFlow += rmf[i];
    else if (tp[i] < tp[i - 1]) negFlow += rmf[i];
  }
  if (negFlow === 0) return 100;
  const ratio = posFlow / negFlow;
  return 100 - 100 / (1 + ratio);
}

// ---------- OBV (On-Balance Volume) ট্রেন্ড ----------
function computeOBVTrend(history, lookback = 10) {
  if (history.length < lookback + 1) return null;
  let obv = 0;
  const series = [obv];
  for (let i = 1; i < history.length; i++) {
    if (history[i].close > history[i - 1].close) obv += history[i].volume;
    else if (history[i].close < history[i - 1].close) obv -= history[i].volume;
    series.push(obv);
  }
  const n = series.length;
  const recent = series[n - 1];
  const past = series[n - 1 - lookback];
  if (past === 0) return "flat";
  const changePct = ((recent - past) / Math.abs(past)) * 100;
  if (changePct > 3) return "rising";
  if (changePct < -3) return "falling";
  return "flat";
}

function computeBuyScore(ind) {
  let score = 50;
  if (ind.rsi != null) {
    if (ind.rsi >= 70) score -= 20;
    else if (ind.rsi > 65) score += 5;
    else if (ind.rsi >= 40) score += 15;
    else if (ind.rsi >= 30) score += 5;
    else score -= 5;
  }
  if (ind.maSignal === "golden") score += 25;
  else if (ind.maSignal === "bullish") score += 12;
  else if (ind.maSignal === "death") score -= 25;
  else if (ind.maSignal === "bearish") score -= 12;
  if (ind.breakout === "up") score += 15;
  else if (ind.breakout === "down") score -= 15;
  if (ind.volRatio != null) {
    if (ind.volRatio >= 2) score += 12;
    else if (ind.volRatio >= 1.3) score += 6;
    else if (ind.volRatio < 0.5) score -= 8;
  }
  if (ind.pattern) {
    if (ind.pattern.type === "bullish") score += 12;
    else if (ind.pattern.type === "bearish") score -= 12;
  }
  if (ind.orderBlock) {
    if (ind.orderBlock.type === "bullish") score += 10;
    else if (ind.orderBlock.type === "bearish") score -= 10;
  }
  if (ind.fvg) {
    if (ind.fvg.type === "bullish") score += 8;
    else if (ind.fvg.type === "bearish") score -= 8;
  }
  if (ind.liquiditySweep) {
    if (ind.liquiditySweep.type === "bullish") score += 10;
    else if (ind.liquiditySweep.type === "bearish") score -= 10;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// historical raw rows (scraper ফরম্যাট) থেকে একটা কোডের জন্য পূর্ণ স্কোর হিসাব
function scoreStock(code, historyRaw) {
  const history = historyRaw
    .map((r) => ({
      close: num(r["CLOSEP*"]), high: num(r["HIGH"]), low: num(r["LOW"]),
      open: num(r["OPENP*"]), volume: num(r["VOLUME"]),
    }))
    .filter((r) => !isNaN(r.close) && r.close > 0 && r.high > 0 && r.low > 0);

  if (history.length < 20) return null;

  const closes = history.map((h) => h.close);
  const volumes = history.map((h) => h.volume);
  const rsi = computeRSI(closes, 14);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, Math.min(50, closes.length - 1));
  const prevMa20 = sma(closes.slice(0, -1), 20);
  const prevMa50 = sma(closes.slice(0, -1), Math.min(50, closes.length - 2));

  let maSignal = "neutral";
  if (ma20 && ma50 && prevMa20 && prevMa50) {
    if (prevMa20 <= prevMa50 && ma20 > ma50) maSignal = "golden";
    else if (prevMa20 >= prevMa50 && ma20 < ma50) maSignal = "death";
    else if (ma20 > ma50) maSignal = "bullish";
    else maSignal = "bearish";
  }

  const ltp = closes[closes.length - 1];
  const recent20 = history.slice(-20);
  const high20 = Math.max(...recent20.map((h) => h.high));
  const low20 = Math.min(...recent20.map((h) => h.low));
  let breakout = null;
  if (ltp >= high20) breakout = "up";
  else if (ltp <= low20) breakout = "down";

  const avgVol20 = sma(volumes.slice(-21, -1), 20) || sma(volumes, Math.min(20, volumes.length));
  const todayVol = volumes[volumes.length - 1];
  const volRatio = avgVol20 ? todayVol / avgVol20 : null;

  const pattern = detectCandlestickPattern(history.slice(-3));
  const orderBlock = detectOrderBlock(history);
  const fvg = detectFVG(history);
  const liquiditySweep = detectLiquiditySweep(history);

  const buyScore = computeBuyScore({ rsi, maSignal, breakout, volRatio, pattern, orderBlock, fvg, liquiditySweep });

  const sr = computeSupportResistance(history, ltp);
  const adx = computeADX(history, 14);
  const mfi = computeMFI(history, 14);
  const obvTrend = computeOBVTrend(history, 10);

  let riskReward = null;
  if (sr.support && sr.resistance) {
    const risk = ltp - sr.support;
    const reward = sr.resistance - ltp;
    if (risk > 0 && reward > 0) {
      riskReward = { ratio: Math.round((reward / risk) * 10) / 10 };
    }
  }

  return { code, buyScore, riskReward, adx, mfi, obvTrend };
}

// ---------- Scrapers ----------
async function scrapeLatest() {
  const $ = await fetchHtml(URLS.LATEST);
  return parseTable($, "table.table-bordered", "table.table-bordered tr", true);
}

async function scrapeTop30() {
  const $ = await fetchHtml(URLS.TOP_30);
  return parseTable($, "table.table-bordered", "table.table-bordered tr", true);
}

async function scrapeDsex() {
  const $ = await fetchHtml(URLS.DSEX);
  return parseTable($, "table.table-bordered", "table.table-bordered tr", true);
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

  const rows = parseTable($, "table.table-bordered", "table.table-bordered tbody tr", false);
  // পুরনো থেকে নতুন তারিখের ক্রমে সাজানো (RSI/MA calc এর জন্য সুবিধাজনক)
  return rows.reverse();
}

// ---------- Main ----------
async function main() {
  ensureDirs();
  const startedAt = new Date().toISOString();
  console.log(`\n🔎 DSE scrape শুরু: ${startedAt}\n`);

  // আগের রানের meta.json পড়ে রাখা হচ্ছে - বাজার বন্ধ থাকা অবস্থায় (weekend/
  // প্রি-মার্কেট) রান হলে watchlist ও lastScrapedAt যেন খালি/মুছে না যায়,
  // বরং গতকালের শেষ সফল লাইভ রানের মানই থেকে যায়
  let previousMeta = {};
  try {
    previousMeta = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, "meta.json"), "utf-8"));
  } catch (err) {
    // প্রথমবার রান হলে meta.json থাকবে না, এটা normal
  }

  const scoredList = [];
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

  let candidates = [];
  if (results.latest) {
    candidates = selectCandidates(results.latest);
    writeJson(path.join(OUTPUT_DIR, "candidates.json"), candidates);
  } else {
    console.error("✗ latest.json না থাকায় candidate বাছাই করা যায়নি, historical scrape স্কিপ করা হচ্ছে");
  }

  // আগের রানের historical ফাইল থেকে যেগুলো এখন আর candidate লিস্টে নেই,
  // সেগুলো মুছে ফেলা হচ্ছে (repo তে অপ্রয়োজনীয় পুরনো ফাইল জমা এড়াতে)
  try {
    const existing = fs.readdirSync(HIST_DIR).filter((f) => f.endsWith(".json"));
    for (const f of existing) {
      const code = f.replace(/\.json$/, "");
      if (!candidates.includes(code)) {
        fs.unlinkSync(path.join(HIST_DIR, f));
        console.log(`🗑 পুরনো ফাইল মুছে ফেলা হলো: data/historical/${f}`);
      }
    }
  } catch (err) {
    // HIST_DIR প্রথমবার খালি থাকলে এটা normal, সমস্যা না
  }

  for (const code of candidates) {
    try {
      const hist = await scrapeHistorical(code);
      writeJson(path.join(HIST_DIR, `${code}.json`), hist);
      scoredList.push(scoreStock(code, hist));
    } catch (err) {
      console.error(`✗ ${code} historical স্ক্র্যাপ ব্যর্থ:`, err.message);
    }
    // dsebd.org কে একসাথে অনেক রিকোয়েস্টে চাপ না দিতে সামান্য delay
    await new Promise((r) => setTimeout(r, 1000));
  }

  // ৪০টা candidate থেকে স্ট্র্যাটেজি স্কোর (RSI+MA+breakout+volume+candlestick+SMC)
  // অনুযায়ী সবচেয়ে "ক্রয়যোগ্য" টপ ১০ বাছাই - এটাই frontend এর watchlist
  const validScores = scoredList.filter(Boolean).sort((a, b) => b.buyScore - a.buyScore).slice(0, 10);
  const top10 = validScores.map((s) => s.code);

  // আগের রানের watchlist.json থেকে rank তুলনা করে rankChange (↑/↓) ও নতুন
  // এন্ট্রি (status: "new") বের করা হচ্ছে - dashboard এ এটা দেখানো হয়
  let previousWatchlist = [];
  try {
    previousWatchlist = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, "watchlist.json"), "utf-8"));
  } catch (err) {
    // প্রথমবার রান হলে থাকবে না, normal
  }
  const prevRankByCode = {};
  previousWatchlist.forEach((w) => { prevRankByCode[w.code] = w.rank; });

  const watchlistDetailed = validScores.map((s, idx) => {
    const rank = idx + 1;
    const prevRank = prevRankByCode[s.code];
    return {
      code: s.code,
      rank,
      rankChange: prevRank ? prevRank - rank : null,
      status: prevRank ? undefined : "new",
      riskReward: s.riskReward,
      adx: s.adx,
      mfi: s.mfi,
      obvTrend: s.obvTrend,
    };
  });

  if (watchlistDetailed.length) {
    writeJson(path.join(OUTPUT_DIR, "watchlist.json"), watchlistDetailed);
  }

  // আজকের লাইভ সেশন এখনো শুরু হয়েছে কিনা যাচাই (বাজার বন্ধ/প্রি-মার্কেটে
  // dsebd.org এ CHANGE কলাম প্রায় সব শেয়ারে 0/খালি থাকে)
  let noFreshSession = true;
  if (results.latest && results.latest.length) {
    const withChange = results.latest.filter((r) => {
      const c = parseFloat(r["CHANGE"]);
      return !isNaN(c) && c !== 0;
    });
    noFreshSession = withChange.length < results.latest.length * 0.03;
  }

  // meta info - frontend এ "last updated" ও watchlist দেখানোর জন্য
  const now = new Date().toISOString();
  writeJson(path.join(OUTPUT_DIR, "meta.json"), {
    lastAttemptedAt: now,
    lastScrapedAt: noFreshSession ? previousMeta.lastScrapedAt || now : now,
    candidateCount: candidates.length,
    watchlist: top10.length ? top10 : previousMeta.watchlist || [],
    strategy: "RSI(14) + MA20/50 ক্রসওভার + ২০-দিন ব্রেকআউট + ভলিউম স্পাইক + ক্যান্ডেলস্টিক প্যাটার্ন + SMC (Order Block/FVG/Liquidity Sweep)",
    noFreshSession,
  });

  console.log("\n✅ স্ক্র্যাপ সম্পন্ন\n");
}

main().catch((err) => {
  console.error("❌ Scraper পুরোপুরি ব্যর্থ:", err);
  process.exit(1);
});
