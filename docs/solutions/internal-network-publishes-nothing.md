---
module: box networking (src/box)
tags: [docker, orbstack, egress, internal-network, publish]
problem_type: measurement
found: 2026-11-19, INV-816
---
# A container on an internal network has no published port, and a firewall rule in its namespace fails open

**Symptom.** Confining a box's outbound traffic looks like one flag — `docker network create --internal` — and then the host cannot reach the box at all: `docker port` prints nothing for a `--publish` given at `run`, the container's address does not answer from the Mac, and `host.docker.internal` does not resolve or route from inside.

**Cause.** Measured on Docker 29 / OrbStack: an internal network gives the container no default route (its routing table is the one subnet), no DNS beyond container names, and the engine silently drops the publication. The other usual answer — iptables rules written into the box's network namespace by a privileged helper — does hold against `sudo` in the box (no `NET_ADMIN`), but the namespace is rebuilt on every container restart and the rules are not, so the box comes back open and says nothing.

**Fix.** Topology, not rules (`src/box/box-network.ts`): the box on the internal network alone, and a gate container on that network and an ordinary one, forwarding a fixed list of TCP ports — the daemon's inwards (the gate carries the `--publish`), the relay's and the web port outwards. The gate takes the alias `host.docker.internal` on the box's network; the box must then not be given `--add-host host.docker.internal:host-gateway`, which would shadow the alias with an address it cannot reach. A restart of either container, or the engine, restores the same shape; a gate that is down cuts the box off instead of opening it.

**Verify.** `npm run test:egress -- --name lumenbox-egress-check-1` (a real box of its own; 11 checks). By hand: `docker exec -u box <box> env -u HTTP_PROXY -u HTTPS_PROXY curl -m 5 https://example.com` must fail, and `docker port <box>-gate 1337/tcp` must print the loopback publication.
