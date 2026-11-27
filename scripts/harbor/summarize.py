"""Summarise a Harbor job (docs/105): per harness pass rate (bootstrap over tasks), time, tokens, cost; per task grid.
A trial is scored when the verifier graded it (timeouts included, as upstream); unscored ones are infra and get rerun."""
import json, sys, random, glob, os
from datetime import datetime as D
from collections import defaultdict
RATES = {"MiniMax-M3.1-Flash": (0.15, 0.60, 0.015)}  # $/M input, output, cache read (planofplan snapshot)
job = sys.argv[1]
rows = []
for f in glob.glob(os.path.join(job, "*", "result.json")):
    r = json.load(open(f)); t = os.path.dirname(f)
    ar = r.get("agent_result") or {}; ex = r.get("exception_info")
    ae = r.get("agent_execution") or {}
    try: secs = (D.fromisoformat(ae["finished_at"].replace("Z", "+00:00")) - D.fromisoformat(ae["started_at"].replace("Z", "+00:00"))).total_seconds()
    except Exception: secs = None
    inp, out, cache = ar.get("n_input_tokens"), ar.get("n_output_tokens"), ar.get("n_cache_tokens")
    u = os.path.join(t, "agent", "home", "usage.jsonl")
    if os.path.exists(u):  # LumenBox's own records
        inp = out = cache = 0
        for line in open(u):
            e = json.loads(line); inp += e.get("inputTokens", 0); out += e.get("outputTokens", 0); cache += e.get("cacheReadTokens", 0)
    reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    rows.append(dict(harness=r["agent_info"]["name"], task=r["task_name"].split("/")[-1], reward=reward, secs=secs,
                     inp=inp, out=out, cache=cache, err=(ex or {}).get("exception_type")))
by = defaultdict(list)
for x in rows: by[x["harness"]].append(x)
def boot(rs):
    tasks = sorted({x["task"] for x in rs}); per = {t: [x["reward"] or 0 for x in rs if x["task"] == t and x["reward"] is not None] for t in tasks}
    per = {t: v for t, v in per.items() if v}; ts = list(per)
    if not ts: return None, None, None
    mean = sum(sum(v) / len(v) for v in per.values()) / len(ts)
    random.seed(7); bs = sorted(sum(sum(per[t]) / len(per[t]) for t in random.choices(ts, k=len(ts))) / len(ts) for _ in range(4000))
    return mean, bs[100], bs[3899]
print(f"{'harness':10} {'scored':>6} {'infra':>5} {'pass':>6} {'95% CI':>13} {'med s':>6} {'in(M)':>7} {'cache(M)':>8} {'out(k)':>7} {'$/trial':>8}")
for h, rs in sorted(by.items()):
    ok = [x for x in rs if x["reward"] is not None]; m, lo, hi = boot(rs)
    secs = sorted(x["secs"] for x in ok if x["secs"]); med = secs[len(secs) // 2] if secs else 0
    tok = [x for x in ok if x["inp"] is not None]
    ti = sum(x["inp"] for x in tok); tc = sum(x["cache"] or 0 for x in tok); to = sum(x["out"] for x in tok)
    a, b, c = RATES["MiniMax-M3.1-Flash"]
    # Harbor's n_input_tokens includes cached ones; LumenBox's inputTokens excludes them.
    fresh = ti - tc if h != "lumenbox" else ti
    cost = (fresh * a + to * b + tc * c) / 1e6 / max(1, len(tok)) if tok else None
    ci = f"{lo:.0%}-{hi:.0%}" if m is not None else "-"
    print(f"{h:10} {len(ok):>6} {len(rs)-len(ok):>5} {m if m is not None else 0:>6.0%} {ci:>13} {med:>6.0f} {ti/1e6 if tok else 0:>7.2f} {tc/1e6 if tok else 0:>8.2f} {to/1e3 if tok else 0:>7.1f} {('$%.3f' % cost) if cost is not None else 'n/a':>8}")
print()
tasks = sorted({x["task"] for x in rows}); hs = sorted(by)
print(f"{'task':28}" + "".join(f"{h:>12}" for h in hs))
for t in tasks:
    cells = []
    for h in hs:
        rs = [x for x in by[h] if x["task"] == t]
        cells.append("".join("E" if x["reward"] is None else ("✓" if x["reward"] == 1 else "·") for x in rs))
    print(f"{t:28}" + "".join(f"{c:>12}" for c in cells))
errs = [(x["harness"], x["task"], x["err"]) for x in rows if x["reward"] is None]
if errs: print("\ninfra/agent errors:", errs)
