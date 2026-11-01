---
module: cua x11 typing
tags: [xdotool, unicode, keymap]
problem_type: runtime-error
found: 2026-08-18, docs/49
---
# `xdotool type` drops characters it had to borrow a keycode for

**Symptom.** `Aprenderás` arrives as `Aprenders`; `Á` arrives as `á`; xdotool exits 0.

**Cause.** For a character not in the keymap, xdotool binds a spare keycode and releases it at once; an application resolving the keystroke against its stale copy of the keymap loses it. One alphabetic keysym in a `keycode N = U00C1` line is expanded by X into [lower, upper], so the upper case is lost.

**Fix.** Bind every unmapped character up front with `xmodmap`, writing each keysym twice (`keycode N = UHHHH UHHHH`), sleep ~300 ms for MappingNotify, type the whole run, sleep again, then release.

**Verify.** Type a string with accented capitals and CJK into a GTK entry and read it back (`set_value` readback or the clipboard); every character must be present and cased as sent.
