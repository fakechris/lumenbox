---
module: box-ax
tags: [at-spi, python-gi, set_value]
problem_type: runtime-error
found: 2026-09-22, handoff-2026-09-22-cua-fixes
---
# GI's Text methods cannot be called through the object's convenience interface; call `Atspi.Text.get_text` explicitly

**Symptom.** `set_value` reports "native operation or readback failed (TypeError)" on a real GTK entry while the value was in fact written.

**Cause.** With the Python GI bindings, `node.get_text_iface().get_text(...)` dispatches by a method name that the convenience interface does not resolve the way the C API suggests.

**Fix.** Call the interface function explicitly: `Atspi.Text.get_text(node, 0, node.get_character_count())`, then compare with what was sent.

**Verify.** `docker/cua-test` matrix: Chinese and English `set_value` readbacks match and the fixture's changed-callback state file agrees.
