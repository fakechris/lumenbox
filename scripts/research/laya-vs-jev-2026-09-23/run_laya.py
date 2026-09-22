"""Run the shared fixture set through laya's three checkpoints, EN vs ZH."""
import json, os, sys, time, pathlib

HERE = pathlib.Path(__file__).parent
FIX = json.loads((HERE / "fixtures.json").read_text())

# (label, subfolder) -- subfolder=None is the root "english" checkpoint
CHECKPOINTS = [("english", None), ("multilingual", "multilingual"), ("typed-decisions", "typed-decisions")]

# (variant, state_lang, question_lang)
VARIANTS = [("en", "en", "en"), ("zh", "zh", "en"), ("zh_q", "zh", "zh")]


def predicted(ans):
    if ans["type"] == "noul":
        return ("true" if ans["noul"] >= 0.5 else "false"), ans["noul"]
    if ans["type"] == "choice":
        probs = ans.get("probabilities") or {}
        return ans["choice"], (max(probs.values()) if probs else ans.get("confidence"))
    raise ValueError(ans["type"])


def main():
    import laya
    rows = []
    for ck_label, sub in CHECKPOINTS:
        t0 = time.time()
        agent = laya.load("convaiinnovations/laya", subfolder=sub)
        load_s = round(time.time() - t0, 1)
        dev = str(agent.device)
        print(f"[{ck_label}] loaded in {load_s}s on {dev}", flush=True)

        for variant, slang, qlang in VARIANTS:
            for case in FIX["pairs"]:
                qdef = FIX["questions"][case["question"]][qlang]
                state = case[slang]
                start = time.perf_counter()
                try:
                    out = agent.predict(state, {"judgment": qdef})
                    ms = round((time.perf_counter() - start) * 1000)
                    pred, conf = predicted(out["answers"]["judgment"])
                    rows.append({
                        "model": f"laya:{ck_label}", "device": dev, "variant": variant,
                        "id": case["id"], "group": case["question"],
                        "expected": case["expected"], "predicted": pred,
                        "correct": pred == case["expected"], "confidence": conf, "ms": ms,
                    })
                except Exception as e:
                    rows.append({
                        "model": f"laya:{ck_label}", "device": dev, "variant": variant,
                        "id": case["id"], "group": case["question"],
                        "expected": case["expected"], "error": f"{type(e).__name__}: {e}",
                    })
            done = [r for r in rows if r["model"] == f"laya:{ck_label}" and r["variant"] == variant]
            acc = sum(1 for r in done if r.get("correct")) / len(done)
            print(f"[{ck_label}] {variant}: {acc:.3f} ({sum(1 for r in done if r.get('correct'))}/{len(done)})", flush=True)
        del agent

    (HERE / "laya-results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(f"\nwrote {len(rows)} rows -> laya-results.json")


if __name__ == "__main__":
    main()
