---
name: engine-check
description: Install a coding engine (Claude Code, pi or opencode) into this box on request and prove the delegation path end to end — the install, a real delegated task through the host's model relay, a permission prompt that reaches the person, and a resumed thread. Use when someone says "装一下 Claude Code", "test the delegate engine", "engine check", or asks whether delegation works here.
description_zh: "按需安装编码引擎并端到端验证委托链路：安装、真实任务、审批卡、续会话"
description_en: "Install a coding engine on demand and verify delegation end to end"
version: 1.0.0
allowed-tools: Delegate,Jobs,bash,read_file,AskUser,Tasks
---

# Engine check

You are proving that this box can hand work to a coding engine and that the four things the
design promises actually happen. Do the steps in order, report what you saw at each one,
and never claim a step worked because the tool said it would — read the job's output.

## Before anything: where the credentials are, so you never ask for them

You do not set any `ANTHROPIC_*` variable, export any key, or ask the person for one. The
host injects the engine's environment per run — `ANTHROPIC_BASE_URL` pointing at the host's
relay, a one-job token as `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` — and the host
attaches the real provider key on its side. If the person says "use my env" or "use
MiniMax-M3", that is already what happens: say so in one line and carry on with the steps.
If the tool's reply ever says the host has no credential for the provider, report that
line verbatim and stop; it is the operator's fix, not yours.

## 0. Ask which engine

Ask the person which engine to check: `claude` (Claude Code), `pi`, or `opencode`. Tell them
an install takes a few minutes and lands on the work volume, so it survives a box rebuild.
Do not install anything they did not name.

## 1. Install, if it is not here

Call `Delegate` with the chosen `preset` and any short `prompt`. If the reply says the engine
is not in this box, call `Delegate` again with `install: true`. That starts a job; use
`Jobs` with `action: "wait"` on the job id it names, then read the tail of the log with
`bash tail -20 <log_path>`. The last line should say `installed <engine> <version> under
/home/box/work/.lumenbox/engines`. If it says anything else, stop and report the log.

## 2. A real task through the relay

Make a small repository to work in:

```
mkdir -p ~/work/engine-check && cd ~/work/engine-check && git init -q && printf 'def add(a, b):\n    return a - b\n' > calc.py && printf 'from calc import add\nassert add(2, 3) == 5\n' > test_calc.py
```

Then `Delegate` with `cwd: "/home/box/work/engine-check"` and this brief:

> The test in test_calc.py fails. Fix calc.py so it passes, run `python3 test_calc.py` to
> confirm, and say in one line what you changed.

Read the tool's reply. It must say the engine's model traffic goes through this host and
that no credential is in the box — that line is the relay. Wait for the job with `Jobs`,
read the log, then run `python3 test_calc.py` yourself. Report: did the engine fix the file,
did the test pass when *you* ran it, and what the reply said about the relay.

## 3. A permission prompt that reaches the person (Claude Code only)

Tell the person that the next step will make the engine attempt a command on the approval
list, and that they should expect a consent card or a line in the app saying
`[delegated engine job-…]` — ask them to answer it, allow or refuse, and to tell you which.
Then `Delegate` (same `cwd`) with:

> Create a directory named scratch, then remove it with `rm -rf scratch`. Say whether the
> removal was allowed.

Wait for the job and read its log. Report three things: whether the person saw the request,
what they answered, and whether the engine's own log agrees (a refusal should show the
engine saying it was not allowed; an approval should show the directory gone). If the
person saw nothing, that is the finding — say so plainly.

## 4. A resumed thread, and a rotated one (Claude Code only)

`Delegate` once more with the same `cwd` and the brief:

> What did you change in this repository earlier? One line.

The tool's reply should say it resumes the thread from this conversation's last delegation,
and the engine's answer should name the calc.py fix without re-reading anything. Then
`Delegate` with a different `cwd` (`/home/box/work`) and the same brief: the reply should
say it starts a fresh thread and give the reason (the working directory changed), and the
engine should not know about calc.py.

## 5. Report

One message, five lines, one per step, each starting with `ok` or `failed` and the evidence:
the version installed, the test result you ran, what the person saw on the card, what the
resumed engine remembered, why the last thread was fresh. Then tell the person they can see
the spend in Settings under usage, listed as `delegate`.

If any step failed, do not retry it more than once. Report it as it happened; a failed
step here is exactly the information this check exists to produce.
