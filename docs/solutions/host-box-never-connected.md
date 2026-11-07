---
module: host orchestrator
tags: [host-box, attached-box, connect, revoke]
problem_type: runtime-error
found: 2026-11-07, INV-1697
---
# A host box at an endpoint was never connected, and a revoked box was redialled

**Symptom.** A native-environment box (`kind: "host"`) registered with an installation — by `host up`, `box connect --kind host` or an organisation node — stays "not connected" forever; the log says `<name>: not an attached box`. Separately, a box revoked with `POST /api/boxes/revoke` came back after a restart, or when the box watch redialled it.

**Cause.** `Orchestrator.connectAttached` refused every entry whose kind was not exactly `attached`, so the `host` kind (added later, INV-438) never got a client; only tests that inject a client saw it work. Revocation lived in an in-memory set checked only by `reconnectBox`, not by `connectAttached`, which the start-up pass and `checkAttachedBoxes` call.

**Fix.** `connectAttached` refuses only the Docker box (no endpoint) and any revoked box, first thing. The server cuts off every registration `connect.json` records as revoked (`ConnectCodeStore.revokedBoxIds`) before it connects any box.

**Verify.** `node --experimental-transform-types --test src/web/node-enrol.test.ts`: a node's native environment registers `connected`, and after the node is revoked both its boxes read `connected: false` and a re-registration is refused.
