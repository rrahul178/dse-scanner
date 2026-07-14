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

## ওয়াচলিস্ট বদলানো

`scripts/scrape.js` ফাইলে `WATCHLIST` অ্যারেতে যে শেয়ারের কোড চাও (dsebd.org
এর "TRADING CODE" অনুযায়ী, যেমন `GP`, `ACI`, `SQURPHARMA`) যোগ/বাদ দাও।
বেশি শেয়ার রাখলে scrape করতে বেশি সময় লাগবে ও dsebd.org-এ বেশি লোড পড়বে,
তাই শুরুতে ৫-১০টা দিয়ে টেস্ট করাই ভালো।

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

- [ ] Frontend dashboard (single HTML ফাইল) বানানো যেটা এই JSON fetch করে
      দেখাবে + RSI/MA/breakout/volume-spike criteria দিয়ে filter করবে
- [ ] Watchlist dynamically বড় করা (latest.json থেকে top gainers/losers
      অটো বাছাই করে historical scrape করা)
- [ ] Candlestick pattern detection যোগ করা
