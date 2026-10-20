// localhost の web プレビューを実ブラウザ(Chrome headless)で操作して確認する。使い方は README 参照。
// 先に `npm run web`（localhost:8081）を起動しておく。保存は毎回まっさらなブラウザ内だけで、外部には送らない。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const URL_ = process.env.PREVIEW_URL ?? 'http://localhost:8081';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const log = [];
const note = (m) => { log.push(m); console.log(m); };
const page = await browser.newPage();
page.on('pageerror', (e) => note('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') note('CONSOLE ' + m.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => page.evaluate(() => document.body.innerText);
const flat = async (n = 300) => (await text()).replace(/\n/g, ' | ').slice(0, n);

async function clickText(label, exact = true) {
  const ok = await page.evaluate((label, exact) => {
    const els = [...document.querySelectorAll('[role=button],[role=radio],[role=tab],button')];
    const el = els.find((e) => { const t = (e.getAttribute('aria-label') || e.innerText || '').trim(); return exact ? t === label : t.includes(label); });
    if (!el) return false;
    el.click();
    return true;
  }, label, exact);
  if (!ok) throw new Error('not found: ' + label + '\n' + (await flat(400)));
  await sleep(350);
}
const shot = (n) => page.screenshot({ path: `${OUT}${n}.png` });

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await page.goto(URL_, { waitUntil: 'networkidle0', timeout: 120000 });
await sleep(1500);
await shot('01-home-390');
note('HOME: ' + (await flat()));
await page.setViewport({ width: 1280, height: 800 });
await sleep(500);
await shot('02-home-pc');
await page.setViewport({ width: 390, height: 844 });
await sleep(500);

await clickText('学ぶ'); // 学習の入口は「学ぶ」タブ
await sleep(300);
await clickText('5分だけ学ぶ');
await sleep(600);
await shot('03-intro');
note('INTRO: ' + (await flat()));
await clickText('つぎへ');
await shot('04-explain');
await clickText('つぎへ');
await sleep(400);
await shot('05-question');
note('Q1: ' + (await flat(400)));

const radios = await page.$$('[role=radio]');
note('radios=' + radios.length);
await radios[0].click();
await sleep(400);
await shot('06-selected');
note('確認前に正誤/正解が出ていない: ' + !/正解！|正しい答え|ここを覚えておこう|いっしょに確認/.test(await text()));
await clickText('答え合わせ');
await sleep(500);
await shot('07-feedback');
note('FB: ' + (await flat(500)));

// 連打: つぎへを同時に3回押しても1問しか進まない
await page.evaluate(() => {
  const b = [...document.querySelectorAll('[role=button]')].find((e) => e.getAttribute('aria-label') === 'つぎへ');
  b.click(); b.click(); b.click();
});
await sleep(800);
note('連打後の進み: ' + ((await text()).match(/(\d)\/8/) || [])[0]);

await page.reload({ waitUntil: 'networkidle0' });
await sleep(1500);
note('RELOAD後: ' + (await flat()));
await shot('08-after-reload');
await clickText('学ぶ'); // 再読込後は箱庭タブから始まる
await sleep(300);
await clickText('つづきから学ぶ');
await sleep(800);
note('RESUMED: ' + (await flat(200)));
await shot('09-resumed');

for (let i = 0; i < 14; i++) {
  const t = await text();
  if (t.includes('箱庭にもどる')) break;
  const rs = await page.$$('[role=radio]');
  if (rs.length && t.includes('答え合わせ')) {
    if (i % 3 === 1) await clickText('わからない');
    else { await rs[i % 4].click(); await sleep(250); await clickText('答え合わせ'); }
    await sleep(400);
    if (i === 3) await shot('10-feedback-other');
  }
  await clickText('つぎへ');
  await sleep(300);
}
await sleep(500);
await shot('11-complete');
note('COMPLETE: ' + (await flat(500)));
await clickText('箱庭にもどる'); // 完了後は明示的に箱庭タブへ
await sleep(600);
await shot('12-home-after');
note('HOME2: ' + (await flat(400)));

await clickText('学ぶ');
await sleep(300);
await clickText('おさらいする');
await sleep(800);
note('REVIEW: ' + (await flat(250)));
await shot('13-review');
await clickText('閉じる', false);
await sleep(500);
note('CLOSE後: ' + (await flat(200)));

for (const t of ['手帳', 'お店', '箱庭']) {
  await clickText(t);
  await sleep(400);
  await shot('14-tab-' + t);
}
fs.writeFileSync(OUT + 'e2e-log.txt', log.join('\n'));
await browser.close();
