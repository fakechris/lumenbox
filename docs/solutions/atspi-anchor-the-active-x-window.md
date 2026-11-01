---
module: box-ax
tags: [at-spi, accessibility, xfwm4]
problem_type: runtime-error
found: 2026-09-11, docs/49 A1b
---
# The window manager is on the accessibility bus too, so "read the active window" can read an empty success

**Symptom.** `list_elements` on a terminal returns a tree with no controls and no error; the model treats "no controls" as the truth.

**Cause.** xfwm4 registers on the AT-SPI bus with an ACTIVE window of its own. Picking "the active window on the bus" can pick the window manager, whose tree is empty, instead of the app.

**Fix.** Anchor the read to X: `xdotool getactivewindow` → pid and title, then find the bus application with that pid and the window with that title (`box-ax` `x_active_window` / `candidate_windows`). No match is an `error`, never an empty list; two matches is an explicit refusal.

**Verify.** With xterm focused, `box-ax` prints `{"error": "...exposes no accessibility tree"}`; with Thunar focused it prints controls.
