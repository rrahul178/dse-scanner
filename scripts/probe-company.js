/**
 * সাময়িক probe: old.dsebd.org এর কোম্পানি পেজের গঠন দেখার জন্য।
 * কয়েকটা কোডের পেজের টেবিলগুলো টেক্সট আকারে data/debug/ এ সেভ করে।
 * ফান্ডামেন্টাল স্ক্র্যাপার তৈরি হয়ে গেলে এই ফাইল মুছে ফেলা হবে।
 */
const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const fs = require("fs");
const path = require("path");

const BASE = "https://old.dsebd.org";
const CODES = ["GP", "SQURPHARMA", "BRACBANK"];
const OUT = path.join(__dirname, "..", "data", "debug");

const client = axios.create({
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
  timeout: 30000,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const code of CODES) {
    try {
      const res = await client.get(`${BASE}/displayCompany.php`, { params: { name: code } });
      const $ = cheerio.load(res.data);
      const lines = [`# ${code} — HTTP ${res.status}, ${res.data.length} bytes`];
      $("table").each((i, t) => {
        lines.push(`\n## table ${i}`);
        $(t).find("tr").each((_, tr) => {
          const cells = $(tr).find("th,td").map((__, c) => $(c).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
          if (cells.length) lines.push(cells.join(" | "));
        });
      });
      fs.writeFileSync(path.join(OUT, `${code}.txt`), lines.join("\n"));
      console.log(`✔ probe ${code}: ${lines.length} lines`);
    } catch (err) {
      console.error(`✗ probe ${code} ব্যর্থ:`, err.response ? `HTTP ${err.response.status}` : err.message);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main();
