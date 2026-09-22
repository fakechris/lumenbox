import json, pathlib, statistics as st
from collections import defaultdict

HERE = pathlib.Path(__file__).parent
rows = json.loads((HERE / "laya-results.json").read_text())
rows += [{**r, "model": "jev"} for r in json.loads((HERE / "jev-results.json").read_text())]

MODELS = ["jev", "laya:english", "laya:multilingual", "laya:typed-decisions"]
VARIANTS = [("en", "EN state / EN question"), ("zh", "ZH state / EN question"), ("zh_q", "ZH state / ZH question")]
GROUPS = ["risk_gate", "authorized", "triage", "intent"]

idx = defaultdict(list)
for r in rows:
    idx[(r["model"], r["variant"])].append(r)

print("=" * 78)
print("OVERALL ACCURACY  (22 cases per cell; random baseline 0.375)")
print("=" * 78)
print(f"{'model':<24}" + "".join(f"{v:>14}" for v, _ in VARIANTS) + f"{'ZH drop':>10}")
for m in MODELS:
    cells = []
    for v, _ in VARIANTS:
        rs = idx[(m, v)]
        cells.append(sum(1 for r in rs if r.get("correct")) / len(rs))
    best_zh = max(cells[1], cells[2])
    print(f"{m:<24}" + "".join(f"{c:>14.3f}" for c in cells) + f"{best_zh - cells[0]:>+10.3f}")

print()
print("=" * 78)
print("BY QUESTION GROUP  (noul: risk_gate=8, authorized=4 | choice: triage=5/5-way, intent=5/4-way)")
print("=" * 78)
for g in GROUPS:
    print(f"\n-- {g} --")
    print(f"{'model':<24}" + "".join(f"{v:>14}" for v, _ in VARIANTS))
    for m in MODELS:
        cells = []
        for v, _ in VARIANTS:
            rs = [r for r in idx[(m, v)] if r["group"] == g]
            cells.append(sum(1 for r in rs if r.get("correct")) / len(rs))
        print(f"{m:<24}" + "".join(f"{c:>14.3f}" for c in cells))

print()
print("=" * 78)
print("CONFIDENTLY WRONG  (wrong answer held at >=0.70 confidence) -- the dangerous failure mode")
print("=" * 78)
for m in MODELS:
    for v, label in VARIANTS:
        rs = idx[(m, v)]
        wrong = [r for r in rs if not r.get("correct") and r.get("confidence") is not None]
        cw = [r for r in wrong if (r["confidence"] if r["confidence"] >= 0.5 else 1 - r["confidence"]) >= 0.70]
        if cw:
            print(f"{m:<22} {v:<6} {len(cw)}/{len(wrong)} wrong answers were high-confidence:")
            for r in cw:
                c = r["confidence"] if r["confidence"] >= 0.5 else 1 - r["confidence"]
                print(f"      {r['id']:<24} said {str(r['predicted']):<12} want {str(r['expected']):<10} conf {c:.3f}")

print()
print("=" * 78)
print("CASES laya GETS WRONG IN ZH BUT RIGHT IN EN  (pure language cost)")
print("=" * 78)
for m in MODELS[1:]:
    en_ok = {r["id"] for r in idx[(m, "en")] if r.get("correct")}
    for v in ("zh", "zh_q"):
        broke = sorted(r["id"] for r in idx[(m, v)] if not r.get("correct") and r["id"] in en_ok)
        fixed = sorted(r["id"] for r in idx[(m, v)] if r.get("correct") and r["id"] not in en_ok)
        print(f"{m:<22} {v:<6} broke_in_zh={broke}")
        print(f"{'':<22} {'':<6} fixed_in_zh={fixed}")

print()
print("=" * 78)
print("LATENCY (ms per single-question request)")
print("=" * 78)
for m in MODELS:
    ms = sorted(r["ms"] for r in rows if r["model"] == m and "ms" in r)
    print(f"{m:<24} n={len(ms):<4} p50={ms[len(ms)//2]:>6}  p95={ms[int(len(ms)*0.95)]:>6}  min={ms[0]:>6}")
