// Run the shared fixture set through TypeSafe Jev, EN vs ZH. Same inputs as run_laya.py.
import { readFile, writeFile } from 'node:fs/promises';

const HERE = new URL('./', import.meta.url);
const FIX = JSON.parse(await readFile(new URL('fixtures.json', HERE), 'utf8'));
const KEY = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_TOKEN;
const MODEL = process.env.JEV_MODEL ?? 'jev-1.13.0';

if (!KEY) { console.error('missing TYPESAFE_TOKEN'); process.exit(1); }

const VARIANTS = [['en', 'en', 'en'], ['zh', 'zh', 'en'], ['zh_q', 'zh', 'zh']];

const predicted = (a) => {
  if (a.type === 'noul') return [a.noul >= 0.5 ? 'true' : 'false', a.noul];
  if (a.type === 'choice') {
    const p = a.probabilities ?? {};
    return [a.choice, Object.keys(p).length ? Math.max(...Object.values(p)) : a.confidence];
  }
  throw new Error('unexpected answer type ' + a.type);
};

const rows = [];
for (const [variant, slang, qlang] of VARIANTS) {
  for (const c of FIX.pairs) {
    const qdef = FIX.questions[c.question][qlang];
    const state = c[slang];
    const start = performance.now();
    try {
      const r = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, state, questions: { judgment: qdef } }),
        signal: AbortSignal.timeout(20000),
      });
      const ms = Math.round(performance.now() - start);
      if (!r.ok) { rows.push({ model: 'jev', variant, id: c.id, group: c.question, expected: c.expected, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`, ms }); continue; }
      const d = await r.json();
      const [pred, conf] = predicted(d.answers.judgment);
      rows.push({ model: d.model ?? MODEL, variant, id: c.id, group: c.question, expected: c.expected, predicted: pred, correct: pred === c.expected, confidence: conf, ms, usage: d.usage });
    } catch (e) {
      rows.push({ model: 'jev', variant, id: c.id, group: c.question, expected: c.expected, error: `${e.name}: ${e.message}`, ms: Math.round(performance.now() - start) });
    }
  }
  const done = rows.filter((r) => r.variant === variant);
  const ok = done.filter((r) => r.correct).length;
  console.log(`[jev] ${variant}: ${(ok / done.length).toFixed(3)} (${ok}/${done.length})  errors=${done.filter((r) => r.error).length}`);
}

await writeFile(new URL('jev-results.json', HERE), JSON.stringify(rows, null, 2));
const toks = rows.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0);
console.log(`wrote ${rows.length} rows -> jev-results.json; input_tokens=${toks} est_usd=${(toks * 0.042 / 1e6).toFixed(5)}`);
