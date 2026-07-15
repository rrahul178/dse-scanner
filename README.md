# DSE Scanner - Data Scraper

dsebd.org থেকে DSE-র লেটেস্ট প্রাইস, টপ ৩০, DSEX ইনডেক্স, আর ওয়াচলিস্টের
হিস্টোরিক্যাল OHLC ডেটা স্ক্র্যাপ করে `data/` ফোল্ডারে JSON হিসেবে সেভ করে।
GitHub Actions cron দিয়ে প্রতি ১৫ মিনিটে (ট্রেডিং আওয়ারে) অটো-রান হয়ে
রেজাল্ট নিজে নিজে commit+push করে।

## যেভাবে সেটআপ করবে

1. এই ফোল্ডারটা একটা নতুন GitHub repo বানিয়ে push করো:
   ```bash
   cd dse-scanner
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/<তোমার-ইউজারনেম>/dse-scanner.git
   git push -u origin main
   ```

2. GitHub repo সেটিংসে গিয়ে **Settings → Actions → General → Workflow permissions**
   এ "Read and write permissions" সিলেক্ট করো (নাহলে scraper commit/push করতে পারবে না)।

3. **Actions** ট্যাবে গিয়ে "DSE Scraper" workflow-টা দেখতে পাবে। প্রথমবার
   টেস্ট করতে "Run workflow" বাটনে ম্যানুয়ালি ক্লিক করো (workflow_dispatch)।

4. সফল হলে `data/latest.json`, `data/top30.json`, `data/dsex.json`, আর
   `data/historical/GP.json` (ইত্যাদি) ফাইলগুলো repo-তে commit হয়ে যাবে।

5. GitHub Pages চালু করো (Settings → Pages → branch: main) - তাহলে JSON
   ফাইলগুলো এই লিংকে পাবে:
   ```
   https://<username>.github.io/dse-scanner/data/latest.json
   ```
   এই URL সরাসরি তোমার frontend থেকে `fetch()` করা যাবে - কোনো CORS সমস্যা
   হবে না কারণ এটা তোমারই ডোমেইনের static ফাইল।

## ওয়াচলিস্ট এখন সম্পূর্ণ স্বয়ংক্রিয়

আর কোনো নির্দিষ্ট শেয়ার কোড হার্ডকোড করা নেই। প্রতিবার scrape চলার সময় দুই
ধাপে পুরো মার্কেট (৩৯৬টি শেয়ার) স্ক্যান হয়ে ট্রেডিং স্ট্র্যাটেজি অনুযায়ী
সবচেয়ে "ক্রয়যোগ্য" টপ ১০ শেয়ার বাছাই হয়:

1. **ধাপ ১ (প্রি-ফিল্টার)** — `data/latest.json` (আজকের সব শেয়ারের প্রাইস/
   ভলিউম/চেঞ্জ) থেকে শুধু আজ পজিটিভ + পর্যাপ্ত লিকুইডিটি (ট্রেড ভ্যালু) আছে
   এমন শেয়ারদের মধ্যে থেকে টপ ৩০টা candidate বাছা হয় (dsebd.org-এ পুরো ৩৯৬টার
   historical না টেনে অল্প কয়েকটার জন্যই request পাঠানো হয়, bot-block এড়াতে)।
2. **ধাপ ২ (স্ট্র্যাটেজি স্কোরিং)** — ওই ৩০টা candidate-এর জন্য ১২০ দিনের
   historical OHLC টেনে RSI(14), MA20/MA50 ক্রসওভার, ২০-দিনের ব্রেকআউট,
   ভলিউম-রেশিও, আর ক্যান্ডেলস্টিক প্যাটার্ন (Engulfing/Hammer/Shooting Star/
   Doji/Morning-Evening Star/Marubozu) হিসাব করে একটা কম্পোজিট "buyScore"
   (০-১০০) বানানো হয়। সবচেয়ে বেশি স্কোরের টপ ১০ শেয়ার চূড়ান্ত ওয়াচলিস্ট।

ফলাফল সেভ হয় `data/meta.json` (watchlist কোড লিস্ট + strategy বর্ণনা) আর
`data/watchlist.json` (প্রতিটা শেয়ারের buyScore, ইন্ডিকেটর, কারণ) এ। শুধু এই
টপ ১০-এরই `data/historical/*.json` রাখা হয়, বাকিগুলো cleanup হয়ে যায়।

`scripts/scrape.js` এর একদম শুরুতে এই কনফিগ constant গুলো চাইলে টিউন করা যায়:

| Constant | মানে |
|---|---|
| `CANDIDATE_POOL_SIZE` | ধাপ ১ থেকে ধাপ ২ তে কতগুলো candidate যাবে (ডিফল্ট ৩০) |
| `TARGET_WATCHLIST_SIZE` | চূড়ান্ত ওয়াচলিস্ট সাইজ (ডিফল্ট ১০) |
| `MIN_VALUE_MN` | কমপক্ষে কত ট্রেড ভ্যালু (mn টাকা) থাকতে হবে, নাহলে illiquid ধরে বাদ |
| `MIN_BUY_SCORE` | এর কম buyScore এর শেয়ার সাধারণত ওয়াচলিস্টে রাখা হবে না |

⚠️ এটা কোনো বিনিয়োগ পরামর্শ না — শুধু টেকনিক্যাল ইন্ডিকেটরভিত্তিক একটা
স্বয়ংক্রিয় স্ক্যানার।

## লোকালি টেস্ট করা (তোমার নিজের কম্পিউটারে)

```bash
npm install
npm run scrape
```

⚠️ এই কোড sandbox environment থেকে টেস্ট করা যায়নি কারণ dsebd.org এই
sandbox-এর নেটওয়ার্ক থেকে ব্লকড (403)। কিন্তু GitHub Actions বা তোমার
নিজের কম্পিউটার/লোকাল নেটওয়ার্ক থেকে এটা কাজ করার কথা - কারণ এটা
faysal515/bd-stock-api এর পরীক্ষিত scraping logic-ই হুবহু অনুসরণ করে
বানানো (শুধু TypeScript থেকে plain JS-এ রূপান্তরিত, আর latest/historical
আলাদা ফোল্ডারে সেভ করা)।

প্রথমবার রান করে যদি কোনো error দেখো (যেমন dsebd.org selector বদলে গেছে,
বা bot-blocking ধরেছে), সেই error message আমাকে দাও - সাথে সাথে ঠিক করে দেব।

## পরের ধাপ

- [x] Frontend dashboard (single HTML ফাইল) বানানো যেটা এই JSON fetch করে
      দেখাবে + RSI/MA/breakout/volume-spike criteria দিয়ে filter করবে
- [x] Watchlist dynamically বড় করা (latest.json থেকে top candidate অটো
      বাছাই করে historical scrape + composite buyScore দিয়ে টপ ১০ সিলেকশন)
- [x] Candlestick pattern detection যোগ করা (Engulfing/Hammer/Shooting Star/
      Doji/Morning-Evening Star/Marubozu)
- [x] Mobile-friendly layout (responsive grid, stacked toolbar, ছোট স্ক্রিনে
      কম-জরুরি টেবিল কলাম লুকানো)
- [ ] Backtesting: buyScore-এর predictive accuracy পরীক্ষা করা historical
      ডেটার উপর
- [ ] Telegram/email অ্যালার্ট যোগ করা যখন কোনো শেয়ার নতুন করে ওয়াচলিস্টে ঢোকে
