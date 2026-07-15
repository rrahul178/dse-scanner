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

// ---------- ওয়াচলিস্ট: সম্পূর্ণ স্বয়ংক্রিয় (কোনো নির্দিষ্ট শেয়ার হার্ডকোড করা নেই) ----------
// প্রতিবার স্ক্র্যাপে পুরো মার্কেট (৩৯৬টি শেয়ার) দুই ধাপে স্ক্যান হয়ে "ক্রয়যোগ্য"
// টপ ১০ শেয়ার বের করা হয় ট্রেডিং স্ট্র্যাটেজি (RSI + MA ক্রসওভার + ব্রেকআউট +
// ভলিউম কনফার্মেশন + ক্যান্ডেলস্টিক প্যাটার্ন) অনুযায়ী:
//   ধাপ ১ (প্রি-ফিল্টার): latest.json (আজকের সব শেয়ারের price/volume/change) থেকে
//     শুধু আজ পজিটিভ + পর্যাপ্ত লিকুইডিটি আছে এমন শেয়ারদের মধ্যে থেকে prelim স্কোর
//     দিয়ে টপ CANDIDATE_POOL_SIZE বাছাই - এতে dsebd.org-এ পুরো ৩৯৬টার historical
//     না টেনে অল্প কয়েকটার জন্যই request যায় (bot-block এড়াতে)।
//   ধাপ ২ (স্ট্র্যাটেজি স্কোরিং): শুধু ওই candidate pool-এর জন্য historical OHLC
//     টেনে RSI/MA/breakout/volume-ratio/candlestick pattern হিসাব করে composite
//     buyScore বানানো হয়, সবচেয়ে বেশি স্কোরের TARGET_WATCHLIST_SIZE-টা চূড়ান্ত
//     ওয়াচলিস্ট হিসেবে data/meta.json + data/watchlist.json এ সেভ হয়।
const CANDIDATE_POOL_SIZE = 30; // ধাপ ১ থেকে ধাপ ২ তে যাবে এমন candidate সংখ্যা
const TARGET_WATCHLIST_SIZE = 10; // চূড়ান্ত অটো-ওয়াচলিস্ট সাইজ ("টপ টেন ক্রয়যোগ্য")
const MIN_VALUE_MN = 1; // অন্তত এই ট্রেড ভ্যালু (mn টাকা) না থাকলে illiquid ধরে বাদ
const MIN_BUY_SCORE = 40; // এর কম স্কোরের শেয়ার ওয়াচলিস্টে রাখা হবে না, prelim candidate কম পড়লেও
const STRATEGY_LABEL = "auto: RSI + MA ক্রসওভার + ২০-দিনের ব্রেকআউট + সাপোর্ট/রেজিস্ট্যান্স + Smart Money Concept (Order Block/FVG/Liquidity Sweep) + ক্যান্ডেলস্টিক প্যাটার্ন + ভলিউম কনফার্মেশন";

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

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

// dsebd.org থেকে বাজার খোলার আগে/পরে স্ক্র্যাপ চালানো হলে LTP/HIGH/LOW/VOLUME
// সব সারিতে 0 আর CHANGE "--" থাকে (কোনো ট্রেড হয়নি এখনও)। এই অবস্থায় ডেটা
// প্রসেস করলে ওয়াচলিস্ট খালি হয়ে যায় এবং পুরনো ভালো ডেটা মুছে যাওয়ার ঝুঁকি থাকে,
// তাই এই "no fresh session" অবস্থা আলাদাভাবে ধরে সেই রানটা স্কিপ করা হয়।
function isNoFreshSession(latestRows) {
  if (!latestRows || !latestRows.length) return true;
  const withTrade = latestRows.filter((r) => {
    const ltp = parseFloat(r["LTP*"]);
    const trade = parseFloat(r["TRADE"]);
    return (Number.isFinite(ltp) && ltp > 0) || (Number.isFinite(trade) && trade > 0);
  });
  // মোট শেয়ারের ৫%-এরও কম-এ ট্রেড ডেটা থাকলে ধরে নেওয়া হয় বাজার এখনো
  // খোলেনি বা ডেটা এখনো আপডেট হয়নি — legitimate "সব শেয়ার রেড" দিনের সাথে
  // এটাকে গুলিয়ে ফেলা যাবে না, তাই থ্রেশহোল্ড কড়া রাখা হয়েছে।
  return withTrade.length < latestRows.length * 0.05;
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

// ---------- সংখ্যা পার্স ----------
function toNum(v) {
  if (v === undefined || v === null) return NaN;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return isNaN(n) ? NaN : n;
}

// ---------- টেকনিক্যাল ইন্ডিকেটর (index.html-এর ক্লায়েন্ট-সাইড লজিকের সাথে মিলিয়ে) ----------
// RSI(14) - Wilder's smoothing method
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
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(arr.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ---------- Candlestick pattern detection (শেষ ১-৩টা ক্যান্ডেল থেকে) ----------
// candles: {open, high, low, close} অ্যারে, পুরনো -> নতুন ক্রমে, শেষেরটাই আজকের ক্যান্ডেল
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
    // বুলিশ এনগাল্ফিং: আগের দিন বেয়ারিশ, আজ তার শরীরকে পুরোপুরি গ্রাস করা বুলিশ ক্যান্ডেল
    if (isBear(c1) && isBull(c0) && c0.open <= c1.close && c0.close >= c1.open && body(c0) > body(c1)) {
      return { name: "বুলিশ এনগাল্ফিং", type: "bullish" };
    }
    // বেয়ারিশ এনগাল্ফিং
    if (isBull(c1) && isBear(c0) && c0.open >= c1.close && c0.close <= c1.open && body(c0) > body(c1)) {
      return { name: "বেয়ারিশ এনগাল্ফিং", type: "bearish" };
    }
  }

  if (n >= 3) {
    const c1 = candles[n - 2], c2 = candles[n - 3];
    // মর্নিং স্টার: বড় বেয়ারিশ -> ছোট শরীরের ক্যান্ডেল -> বড় বুলিশ (রিভার্সাল)
    if (isBear(c2) && body(c2) / range(c2) > 0.4 && body(c1) / range(c1) < 0.3 &&
        isBull(c0) && c0.close > (c2.open + c2.close) / 2) {
      return { name: "মর্নিং স্টার", type: "bullish" };
    }
    // ইভিনিং স্টার: বড় বুলিশ -> ছোট শরীরের ক্যান্ডেল -> বড় বেয়ারিশ (রিভার্সাল)
    if (isBull(c2) && body(c2) / range(c2) > 0.4 && body(c1) / range(c1) < 0.3 &&
        isBear(c0) && c0.close < (c2.open + c2.close) / 2) {
      return { name: "ইভিনিং স্টার", type: "bearish" };
    }
  }

  const bodyRatio = body(c0) / range(c0);
  // হ্যামার: ছোট শরীর, লম্বা নিচের উইক (কমপক্ষে ২x শরীর), সামান্য উপরের উইক
  if (lowerWick(c0) >= 2 * body(c0) && upperWick(c0) <= body(c0) * 0.5 && bodyRatio < 0.35) {
    return { name: "হ্যামার", type: "bullish" };
  }
  // শুটিং স্টার: ছোট শরীর, লম্বা উপরের উইক, সামান্য নিচের উইক
  if (upperWick(c0) >= 2 * body(c0) && lowerWick(c0) <= body(c0) * 0.5 && bodyRatio < 0.35) {
    return { name: "শুটিং স্টার", type: "bearish" };
  }
  // মারুবোজু: প্রায় শূন্য উইক সহ শক্তিশালী ট্রেন্ড ক্যান্ডেল
  if (upperWick(c0) < range(c0) * 0.05 && lowerWick(c0) < range(c0) * 0.05 && bodyRatio > 0.85) {
    return { name: isBull(c0) ? "বুলিশ মারুবোজু" : "বেয়ারিশ মারুবোজু", type: isBull(c0) ? "bullish" : "bearish" };
  }
  // ডোজি: শরীর প্রায় শূন্য (রেঞ্জের তুলনায়)
  if (bodyRatio < 0.1) {
    return { name: "ডোজি", type: "neutral" };
  }
  return null;
}

// ---------- ধাপ ১: prelim candidate বাছাই (শুধু আজকের latest.json ডেটা থেকে) ----------
function parseLatestRow(r) {
  const ltp = toNum(r["LTP*"]);
  const high = toNum(r["HIGH"]);
  const low = toNum(r["LOW"]);
  const ycp = toNum(r["YCP*"]);
  const change = toNum(r["CHANGE"]);
  const changePct = ycp ? (change / ycp) * 100 : 0;
  return {
    code: r["TRADING CODE"],
    ltp, high, low, changePct,
    value: toNum(r["VALUE (mn)"]),
    volume: toNum(r["VOLUME"]),
  };
}

function preliminaryScore(row) {
  if (isNaN(row.ltp) || isNaN(row.high) || isNaN(row.low) || row.high === row.low) return -Infinity;
  const dayPos = (row.ltp - row.low) / (row.high - row.low); // দিনের হাই-এর কতটা কাছে বন্ধ হয়েছে (০-১)
  let score = 0;
  score += row.changePct * 2; // আজকের পজিটিভ মোমেন্টাম
  score += dayPos * 20; // দিনের হাই এর কাছাকাছি বন্ধ = ক্রেতার চাপ বেশি
  score += Math.min(row.value, 50) * 0.5; // লিকুইডিটি (৫০mn পর্যন্ত ক্যাপ করা, অতিরিক্ত ভ্যালু যেন হাইলি ট্রেডেড কয়েকটা শেয়ার পুরো লিস্ট দখল না করে)
  return score;
}

function selectCandidatePool(latestRows) {
  return latestRows
    .map(parseLatestRow)
    .filter((r) => r.code && r.value >= MIN_VALUE_MN && r.changePct > 0)
    .map((r) => ({ ...r, prelimScore: preliminaryScore(r) }))
    .sort((a, b) => b.prelimScore - a.prelimScore)
    .slice(0, CANDIDATE_POOL_SIZE);
}

// ---------- ধাপ ২: historical ডেটা থেকে স্ট্র্যাটেজি ইন্ডিকেটর + কম্পোজিট বাই-স্কোর ----------
function computeStrategyIndicators(histRaw) {
  const rows = histRaw
    .map((r) => ({
      date: r["DATE"],
      open: toNum(r["OPENP*"]), high: toNum(r["HIGH"]), low: toNum(r["LOW"]), close: toNum(r["CLOSEP*"]),
      volume: toNum(r["VOLUME"]),
    }))
    .filter((r) => !isNaN(r.close) && r.close > 0 && r.high > 0 && r.low > 0);

  if (rows.length < 20) return null;

  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);

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

  const recent20 = rows.slice(-20);
  const high20 = Math.max(...recent20.map((r) => r.high));
  const low20 = Math.min(...recent20.map((r) => r.low));
  const ltp = closes[closes.length - 1];
  let breakout = null;
  if (ltp >= high20) breakout = "up";
  else if (ltp <= low20) breakout = "down";

  const avgVol20 = sma(volumes.slice(-21, -1), 20) || sma(volumes, Math.min(20, volumes.length));
  const todayVol = volumes[volumes.length - 1];
  const volRatio = avgVol20 ? todayVol / avgVol20 : null;

  const pattern = detectCandlestickPattern(rows.slice(-3));
  const sr = computeSupportResistance(rows, ltp);
  const orderBlock = detectOrderBlock(rows);
  const fvg = detectFVG(rows);
  const liquiditySweep = detectLiquiditySweep(rows);

  return { rsi, ma20, ma50, maSignal, breakout, volRatio, pattern, sr, orderBlock, fvg, liquiditySweep };
}

// কম্পোজিট "ক্রয়যোগ্যতা" স্কোর (০-১০০) - RSI + MA ক্রসওভার + ব্রেকআউট + ভলিউম + ক্যান্ডেলস্টিক
function computeBuyScore(ind) {
  let score = 50;
  if (ind.rsi != null) {
    if (ind.rsi >= 70) score -= 20; // ওভারবট - রিস্কি
    else if (ind.rsi > 65) score += 5;
    else if (ind.rsi >= 40) score += 15; // সুস্থ momentum জোন
    else if (ind.rsi >= 30) score += 5;
    else score -= 5; // গভীর ওভারসোল্ড - reversal অনিশ্চিত
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

function buildReasons(ind) {
  const reasons = [];
  if (ind.maSignal === "golden") reasons.push("গোল্ডেন ক্রস - MA20 এইমাত্র MA50 কে ক্রস করেছে (নতুন আপট্রেন্ড)");
  else if (ind.maSignal === "bullish") reasons.push("আপট্রেন্ডে আছে (MA20 > MA50)");
  if (ind.breakout === "up") reasons.push("২০-দিনের হাই ব্রেকআউট");
  if (ind.volRatio && ind.volRatio >= 1.3) reasons.push(`ভলিউম কনফার্মেশন (২০-দিনের গড়ের ${ind.volRatio.toFixed(1)}x)`);
  if (ind.rsi != null && ind.rsi >= 40 && ind.rsi < 65) reasons.push(`RSI ${ind.rsi.toFixed(0)} - সুস্থ momentum জোনে (ওভারবট নয়)`);
  if (ind.pattern && ind.pattern.type === "bullish") reasons.push(`${ind.pattern.name} ক্যান্ডেলস্টিক প্যাটার্ন (বুলিশ)`);
  if (ind.orderBlock && ind.orderBlock.type === "bullish") reasons.push(`বুলিশ অর্ডার ব্লক জোনের উপরে (৳${ind.orderBlock.zoneLow.toFixed(1)}-${ind.orderBlock.zoneHigh.toFixed(1)})`);
  if (ind.fvg && ind.fvg.type === "bullish") reasons.push(`বুলিশ Fair Value Gap (৳${ind.fvg.bottom.toFixed(1)}-${ind.fvg.top.toFixed(1)})`);
  if (ind.liquiditySweep && ind.liquiditySweep.type === "bullish") reasons.push(`লিকুইডিটি সুইপ - স্টপ-হান্টের পর রিভার্সাল (৳${ind.liquiditySweep.level.toFixed(1)}-এর নিচে)`);
  return reasons;
}

// পুরনো ওয়াচলিস্টে থাকলেও নতুনটায় নেই এমন historical ফাইল মুছে রিপো ছোট রাখা
function cleanupHistoricalDir(keepCodes) {
  const keep = new Set(keepCodes);
  if (!fs.existsSync(HIST_DIR)) return;
  for (const file of fs.readdirSync(HIST_DIR)) {
    const code = file.replace(/\.json$/, "");
    if (!keep.has(code)) {
      fs.unlinkSync(path.join(HIST_DIR, file));
    }
  }
}

// ---------- Support & Resistance (swing high/low ক্লাস্টারিং) ----------
// fractal পদ্ধতি: একটা ক্যান্ডেলের high/low যদি দুই পাশের `lookback`টা ক্যান্ডেলের
// চেয়ে বেশি/কম হয়, সেটা swing high/low ধরা হচ্ছে
function findSwingPoints(rows, lookback = 5) {
  const swingHighs = [], swingLows = [];
  for (let i = lookback; i < rows.length - lookback; i++) {
    const windowSlice = rows.slice(i - lookback, i + lookback + 1);
    if (windowSlice.every((r) => r.high <= rows[i].high)) swingHighs.push(rows[i].high);
    if (windowSlice.every((r) => r.low >= rows[i].low)) swingLows.push(rows[i].low);
  }
  return { swingHighs, swingLows };
}

// কাছাকাছি লেভেলগুলো ক্লাস্টার করে "কতবার টাচ হয়েছে" সহ শক্তিশালী জোন বের করা
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
    resistanceTouches: resistances[0] ? resistances[0].touches : 0,
    support: supports[0] ? supports[0].level : null,
    supportTouches: supports[0] ? supports[0].touches : 0,
  };
}

// ---------- Smart Money Concept (SMC) - সরলীকৃত, দৈনিক ক্যান্ডেলভিত্তিক approximation ----------
// (আসল SMC সাধারণত ইন্ট্রাডে/লোয়ার টাইমফ্রেমে করা হয় - এখানে dsebd.org থেকে
// শুধু দৈনিক OHLC পাওয়া যায় বলে সুইং-লেভেলে adaption করা হয়েছে)

// অর্ডার ব্লক: শেষ বিপরীত-রঙের ক্যান্ডেল যার পরে একটা শক্তিশালী ইমপালসিভ মুভ এসে
// তার high/low ব্রেক করেছে - সেই ক্যান্ডেলের রেঞ্জটাই অর্ডার ব্লক জোন
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

// Fair Value Gap (FVG): ৩-ক্যান্ডেল ইম্ব্যালেন্স, ১ম ক্যান্ডেলের high আর ৩য়
// ক্যান্ডেলের low এর মাঝে ফাঁকা জায়গা (বুলিশ), বা উল্টো (বেয়ারিশ)
function detectFVG(rows) {
  const n = rows.length;
  if (n < 3) return null;
  const c1 = rows[n - 3], c3 = rows[n - 1];
  if (c1.high < c3.low) return { type: "bullish", top: c3.low, bottom: c1.high };
  if (c1.low > c3.high) return { type: "bearish", top: c1.low, bottom: c3.high };
  return null;
}

// লিকুইডিটি সুইপ: গত ~২১ দিনের লো/হাই এর সামান্য নিচে/উপরে wick করে আবার তার
// ভেতরে ফিরে ক্লোজ করা (স্টপ-হান্ট এর পর রিভার্সাল সিগন্যাল)
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

// ---------- ধাপ ২ (পুনঃব্যবহারযোগ্য): candidate pool → historical + composite buy-score → top N ----------
async function scoreCandidatesAndBuildWatchlist(pool) {
  const scored = [];
  for (const cand of pool) {
    try {
      const hist = await scrapeHistorical(cand.code);
      const ind = computeStrategyIndicators(hist);
      if (ind) {
        const buyScore = computeBuyScore(ind);
        scored.push({ ...cand, ...ind, buyScore, reasons: buildReasons(ind), _hist: hist });
        console.log(`  ✔ ${cand.code}: buyScore=${buyScore}, RSI=${ind.rsi ? ind.rsi.toFixed(0) : "N/A"}, MA=${ind.maSignal}, breakout=${ind.breakout || "-"}`);
      }
    } catch (err) {
      console.error(`✗ ${cand.code} historical/স্কোরিং ব্যর্থ:`, err.message);
    }
    // dsebd.org কে একসাথে অনেক রিকোয়েস্টে চাপ না দিতে সামান্য delay
    await new Promise((r) => setTimeout(r, 1500));
  }

  let finalWatchlist = scored
    .filter((s) => s.buyScore >= MIN_BUY_SCORE)
    .sort((a, b) => b.buyScore - a.buyScore)
    .slice(0, TARGET_WATCHLIST_SIZE);

  if (finalWatchlist.length < TARGET_WATCHLIST_SIZE) {
    // MIN_BUY_SCORE পার করা যথেষ্ট শেয়ার না পেলে, সেরা যা আছে তা দিয়েই পূরণ করা
    const rest = scored
      .filter((s) => !finalWatchlist.includes(s))
      .sort((a, b) => b.buyScore - a.buyScore);
    finalWatchlist = finalWatchlist.concat(rest).slice(0, TARGET_WATCHLIST_SIZE);
  }

  return finalWatchlist;
}

function saveFinalWatchlist(finalWatchlist) {
  cleanupHistoricalDir(finalWatchlist.map((s) => s.code));
  for (const s of finalWatchlist) {
    writeJson(path.join(HIST_DIR, `${s.code}.json`), s._hist);
  }
  writeJson(path.join(OUTPUT_DIR, "watchlist.json"), finalWatchlist.map((s) => ({
    code: s.code, buyScore: s.buyScore, rsi: s.rsi, maSignal: s.maSignal,
    breakout: s.breakout, volRatio: s.volRatio, pattern: s.pattern, reasons: s.reasons,
    sr: s.sr, orderBlock: s.orderBlock, fvg: s.fvg, liquiditySweep: s.liquiditySweep,
  })));
  console.log(`\n🏆 চূড়ান্ত অটো-ওয়াচলিস্ট (টপ ${finalWatchlist.length} ক্রয়যোগ্য): ${finalWatchlist.map((s) => `${s.code}(${s.buyScore})`).join(", ")}\n`);
}

// আজকের লাইভ সেশন এখনো শুরু না হলেও (LTP/change সব 0) historical/আর্কাইভ ডেটা
// dsebd.org-এ ঠিকই পাওয়া যায় (এটা গতকাল পর্যন্ত সম্পন্ন সেশনের ডেটা, লাইভ প্রাইসের
// উপর নির্ভরশীল না)। তাই candidate pool বাছাইয়ের জন্য যেই ৩০টা কোড লাগবে, সেটা
// শেষ successful fresh-session রান থেকে ক্যাশে রাখা হয় এবং পরের যেকোনো
// no-fresh-session রানে reuse করা হয় — এতে বাজার খোলার আগেও গতকালের হিস্টোরিক্যাল
// ডেটা দিয়ে স্ট্র্যাটেজি-স্কোরিং করে টপ ১০ দেখানো যায়, খালি স্ক্রিন দেখাতে হয় না।
const LAST_POOL_FILE = path.join(OUTPUT_DIR, "lastPool.json");

function saveCandidatePoolCache(pool) {
  writeJson(LAST_POOL_FILE, pool.map((r) => r.code));
}

function loadFallbackCandidatePool(latestRows, prevWatchlistCodes) {
  // ১) সবচেয়ে সাম্প্রতিক successful লাইভ-সেশন রান থেকে ক্যাশড পুল (৩০টা, লিকুইডিটি-ভিত্তিক)
  const cached = readJson(LAST_POOL_FILE, null);
  if (Array.isArray(cached) && cached.length) {
    return cached.map((code) => ({ code }));
  }
  // ২) latest.json থেকে সমানভাবে বিস্তৃত (evenly-spaced) sample - পুরো ৩৯৬টা জুড়ে
  // কভারেজ দেয়। এটাকে "আগের watchlist" ফলব্যাকের আগে রাখা জরুরি, কারণ আগের
  // watchlist-এ ঠিক TARGET_WATCHLIST_SIZE(১০)-টা কোড থাকে - সেটাকেই candidate pool
  // ধরলে সবক'টাই ট্রিভিয়ালি ফাইনাল ওয়াচলিস্টে থেকে যায় এবং প্রতিটা no-fresh-session
  // রানে ঠিক একই ১০টা শেয়ার self-lock হয়ে চিরস্থায়ী হয়ে যায় (আগে এই বাগটাই ছিল)।
  if (latestRows && latestRows.length) {
    const codes = latestRows.map((r) => r["TRADING CODE"]).filter(Boolean);
    const step = Math.max(1, Math.floor(codes.length / CANDIDATE_POOL_SIZE));
    // প্রতিদিন ভিন্ন সাবসেট পেতে day-of-year দিয়ে শুরুর অফসেট ঘোরানো হয় - নাহলে
    // লাইভ স্ক্যান সফল না হওয়া পর্যন্ত প্রতিদিন হুবহু একই ৩০টা কোড আসত
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const offset = dayOfYear % step;
    const sampled = [];
    for (let i = offset; i < codes.length && sampled.length < CANDIDATE_POOL_SIZE; i += step) {
      sampled.push({ code: codes[i] });
    }
    return sampled;
  }
  // ৩) latest.json-ই না থাকলে (স্ক্র্যাপ সম্পূর্ণ ব্যর্থ) আগের meta.json watchlist
  if (Array.isArray(prevWatchlistCodes) && prevWatchlistCodes.length) {
    return prevWatchlistCodes.map((code) => ({ code }));
  }
  // ৪) একদম শেষ অবলম্বন - আগে থেকে সেভ করা historical ফাইলগুলোর কোড
  if (fs.existsSync(HIST_DIR)) {
    const codes = fs.readdirSync(HIST_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    if (codes.length) return codes.map((code) => ({ code }));
  }
  return [];
}


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

  // ---------- প্রি-মার্কেট / "কোনো ফ্রেশ সেশন নেই" ডিটেকশন ----------
  // dsebd.org বাজার খোলার আগে (~সকাল ১০টা BD টাইমের আগে) কল করলে সব রো-তে
  // LTP/HIGH/LOW/VOLUME = 0 আর CHANGE = "--" রিটার্ন করে। আগে এই অবস্থায়
  // prelim filter-এ কোনো candidate না পেয়ে ওয়াচলিস্ট খালি দেখানো হতো। এখন
  // এই কেসে আজকের লাইভ প্রাইসের বদলে গতকাল পর্যন্ত সম্পন্ন historical ডেটা
  // দিয়েই স্ট্র্যাটেজি স্কোরিং চালিয়ে টপ ১০ দেখানো হয় (candidate pool ক্যাশ থেকে আসে)।
  const noFreshSession = isNoFreshSession(results.latest);
  const prevMeta = readJson(path.join(OUTPUT_DIR, "meta.json"), {});

  let pool;
  if (noFreshSession) {
    console.warn("⚠ কোনো ফ্রেশ ট্রেড সেশন ডেটা পাওয়া যায়নি (বাজার এখনো খোলেনি বা dsebd.org আপডেট হয়নি)।");
    console.warn("⚠ গতকাল পর্যন্ত সম্পন্ন historical ডেটা দিয়ে স্ট্র্যাটেজি স্কোরিং চালানো হচ্ছে (ক্যাশড candidate pool থেকে)।\n");
    pool = loadFallbackCandidatePool(results.latest, prevMeta.watchlist);
  } else if (results.latest && results.latest.length) {
    pool = selectCandidatePool(results.latest);
    saveCandidatePoolCache(pool);
  } else {
    pool = [];
  }

  if (!pool.length) {
    console.error("✗ candidate pool খালি (live ও cached ফলব্যাক দুটোই ব্যর্থ) - আগের ওয়াচলিস্ট/historical অপরিবর্তিত থাকবে");
    writeJson(path.join(OUTPUT_DIR, "meta.json"), {
      ...prevMeta,
      lastScrapedAt: prevMeta.lastScrapedAt || null,
      lastAttemptedAt: new Date().toISOString(),
      watchlist: prevMeta.watchlist || [],
      noFreshSession,
      scrapeFailed: !results.latest || !results.latest.length,
      strategy: prevMeta.strategy || STRATEGY_LABEL,
    });
    console.log("\n✅ স্ক্র্যাপ সম্পন্ন (candidate pool খালি, পুরনো ওয়াচলিস্ট রাখা হয়েছে)\n");
    return;
  }

  console.log(`🔎 ধাপ ১ সম্পন্ন: ${pool.length}টা candidate পাওয়া গেছে ${noFreshSession ? "(ক্যাশড পুল, no-fresh-session)" : "(prelim স্কোর অনুযায়ী)"} → এখন historical/স্ট্র্যাটেজি স্কোরিং শুরু\n`);

  // ---------- ধাপ ২: candidate pool এর জন্য historical + composite buy-score ----------
  const finalWatchlist = await scoreCandidatesAndBuildWatchlist(pool);
  saveFinalWatchlist(finalWatchlist);

  // meta info - frontend এ "last updated" ও ডাইনামিক ওয়াচলিস্ট কোড দেখানোর জন্য
  writeJson(path.join(OUTPUT_DIR, "meta.json"), {
    lastScrapedAt: noFreshSession ? (prevMeta.lastScrapedAt || null) : new Date().toISOString(),
    lastAttemptedAt: new Date().toISOString(),
    watchlist: finalWatchlist.map((s) => s.code),
    noFreshSession,
    scrapeFailed: false,
    strategy: STRATEGY_LABEL,
  });

  console.log("\n✅ স্ক্র্যাপ সম্পন্ন\n");
}

main().catch((err) => {
  console.error("❌ Scraper পুরোপুরি ব্যর্থ:", err);
  process.exit(1);
});
