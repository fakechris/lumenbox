---
module: boxd executor
tags: [path, native-helper, environment]
problem_type: runtime-error
found: 2026-09-11, docs/49 A1b
---
# The executor's environment is DISPLAY alone, so a helper found by name is not found

**Symptom.** `list_elements` answers "the accessibility reader is not available (no box-ax)" although `box-ax` is on the image.

**Cause.** The X11 executor runs helpers with an environment of `DISPLAY` only. A lookup by name needs a PATH; the daemon's own PATH is the one the image set.

**Fix.** `nativeHelper(...)` resolves the helper against the daemon's PATH and passes the explicit path; the child's environment stays DISPLAY-only.

**Verify.** `list_elements` on a GTK app returns controls; the boxd log shows no "no box-ax".
