// Read-only, offline audit of frozen research evidence. No product imports or credentials.
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const root = new URL('../../../../', import.meta.url);
const base = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, base), 'utf8');
const json = path => JSON.parse(read(path));
const hash = value => createHash('sha256').update(value).digest('hex');
const recorded = json('business/validation.json');
for (const [path, expected] of Object.entries(recorded.sha256))
  assert.equal(hash(readFileSync(new URL(path, root))), expected, `Prior artifact changed: ${path}`);
const claims = json('report-audit/claims.json');
const report = readFileSync(new URL('docs/66-awesome-jev-lumenbox-opportunities.md', root), 'utf8');
assert.equal(hash(report), claims.report_sha256);
for (const c of claims.cases) {
  assert(report.split('\n')[c.report_line - 1].includes(c.claim), `Claim location: ${c.id}`);
  assert.equal(hash(c.source.text), c.source.excerpt_sha256);
  assert(c.source.url.includes(c.source.commit));
}
const catalog = json('awesome-projects.json');
const inventory = json('awesome-source-review.json').catalog;
assert.equal(hash(read('awesome-projects.json')), inventory.sha256);
assert.equal(catalog.projects.length, inventory.total);
const categories = {};
for (const p of catalog.projects) categories[p.category] = (categories[p.category] ?? 0) + 1;
assert.deepEqual(categories, inventory.categories);

const calls = {};
for (const prefix of ['business/', 'business/diagnostic/']) {
  // Original runner reconstructs every citation/retrieval/lead result from frozen inputs.
  execFileSync(process.execPath, [new URL('business/evaluate.mjs', base).pathname,
    ...(prefix.includes('diagnostic') ? ['--diagnostic'] : []), '--replay'], {stdio:'pipe'});
  const rows = read(`${prefix}observations.jsonl`).trim().split('\n').map(JSON.parse);
  const result = json(`${prefix}results.json`);
  assert.equal(new Set(rows.map(r => `${r.provider}:${r.id}`)).size, rows.length);
  calls[prefix] = {};
  for (const provider of ['jev', 'deepseek']) {
    const rs = rows.filter(r => r.provider === provider);
    const ok = rs.filter(r => r.status === 'ok');
    const times = ok.map(r => r.ms).sort((a,b) => a-b);
    const usage = {};
    for (const r of ok) for (const [key, value] of Object.entries(r.usage))
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
    const summary = result.summaries[provider];
    const measured = {requests:rs.length, errors:rs.length-ok.length,
      p50_ms:times[Math.ceil(times.length*.5)-1], p95_ms:times[Math.ceil(times.length*.95)-1], usage};
    for (const [key,value] of Object.entries(measured)) assert.deepEqual(value,summary[key]);
    // Historical price assumptions, not a fresh price lookup or billed charges.
    const peak = provider === 'jev' ? usage.input_tokens*.042/1e6
      : (usage.prompt_cache_hit_tokens*.006 + usage.prompt_cache_miss_tokens*.3 + usage.completion_tokens*1.2)/1e6;
    calls[prefix][provider] = {...measured, models:[...new Set(ok.map(r=>r.model))],
      estimated_usd_at_recorded_peak_rates:peak,
      ...(provider === 'deepseek' ? {estimated_usd_at_recorded_offpeak_rates:peak/2} : {})};
  }
}
const output = {date:'2026-09-22', status:'verified', previous_artifact_hashes_checked:Object.keys(recorded.sha256).length,
  actual_report_claim_locations_checked:claims.cases.length, catalog:{total:inventory.total,categories}, calls,
  semantic_review:'Same-agent inspection recorded in claims.json; not independently adjudicated or accuracy-tested.',
  network_calls:0, product_changes:false};
if (process.argv.includes('--record')) writeFileSync(new URL('verification.json', import.meta.url),JSON.stringify(output,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(output,null,2));
