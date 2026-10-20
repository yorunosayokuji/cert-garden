// `wrangler dev --local`（実CLI経路）に対するスモーク。リモートへは繋がない。
// 使い方: node scripts/smoke-local.mjs http://127.0.0.1:8799
const base = process.argv[2] ?? 'http://127.0.0.1:8799';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('ローカル以外には使えません');
const out = [];
const h = await fetch(base + '/health');
out.push(['health', h.status, h.headers.get('cache-control'), await h.json()]);
const c = await fetch(base + '/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google' }) });
out.push(['challenge(未設定)', c.status, (await c.json()).error?.code]);
const b = await fetch(base + '/v1/backup');
out.push(['backup(未認証)', b.status]);
console.log(JSON.stringify(out, null, 1));
