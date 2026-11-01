---
module: box display
tags: [xvfb, xfwm4, focus]
problem_type: runtime-error
found: 2026-08-18, docs/49
---
# Without a window manager dialogs stay unmapped and typing goes nowhere

**Symptom.** A dialog "opened" but no screenshot shows it; keystrokes land in no window; the browser never takes focus.

**Cause.** Xvfb alone maps nothing and assigns no focus. A window manager is what maps windows and routes keyboard focus.

**Fix.** Run xfwm4 (enough) on every display, started by `start-display` before any application.

**Verify.** `xdotool getactivewindow` returns an id after an app starts; a typed string appears in the focused entry.
