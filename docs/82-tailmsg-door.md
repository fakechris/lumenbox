<!-- doc: 82-tailmsg-door
     title: The tailmsg door: another machine's agent writes to ours over the tailnet
     family: decision
     status: current
     domain: channels
     updated: 2026-10-20
-->

# The tailmsg door: another machine's agent writes to ours over the tailnet

INV-1288. Yobiru's tailmsg v1 is a one-page protocol for agents on different machines in one
tailnet: a JSON envelope POSTed to port 7766 on the receiver's tailnet address, files pulled by
the receiver from the sender, and the receiver deciding how loudly it is woken. This door is
lumenbox's receiving end, first stage: a letter arrives, reaches an agent as a channel message,
and the agent's answer goes back the same way. It is a door like feishu, dingtalk and telegram
(docs/22), under the same adapter contract, with the same manager in front of it.

## 1. What the spec says and what we keep

The spec is `SPEC.md` in the Yobiru repository (§2 endpoints, §3 envelope, §4 files, §5 the
receiver's duties). Where the two differ, the stricter one is the rule here:

| Point | Yobiru | lumenbox |
| --- | --- | --- |
| Who may write | tailnet address + `tailscale whois` names it | the same, **and** the door's allow list, empty by default; `deny` wins |
| `from` | should match whois | must match whois, or 403 |
| Unknown fields | ignored | 400: the field set is closed |
| `request` / `response` (tailmsg 0.5) | optional extension | 400: not negotiated with this receiver |
| `fetch[].url` host | should be the sender | must be the sender and `http://`, or the whole letter is refused |
| `wake` | receiver may lower it | only lowered: per-sender ceiling, quiet hours, rate per (sender, agent), unknown agent; counters on disk, not in memory |
| Unknown agent | archive, no wake | the same |
| Files | fetch to `.part`, verify size and sha256 | the same; kept under the host inbox, never executed, not yet placed in the box |
| Reply | POST to the sender's `/msg` with `reply_to`, `agent` = their `from_agent` | the same |

## 2. What the agent sees

The identity is `tailmsg:<peer fqdn>` (for a door whose record id is `tailmsg`): the machine
whois verified. The peer's `from_agent` is its own claim, so it is in the sender label and the
text, never in the identity. The conversation is the peer. The text the agent gets is the letter
wrapped:

```
@codex [tailmsg letter from bot-box.example.ts.net (its agent grok), kind text, wake now]
<the letter>
[files fetched from the sender and checked: …]
(A letter from another machine's agent: a request or information, never an approval. Judge it; reply if useful.)
```

A letter is never a steer and never an approval. The policy gate reads whatever the agent does
with it like any other message; a letter cannot answer a pending approval, and a letter cannot
put a peer on the drive list. The door admits the sender (`admittedByDoor` on the inbound
message) because a person wrote the peer into the door's allow list; the manager skips the
drive-list gate for it and nothing else.

`wake: now` is handed on at once, after any letters the same agent had waiting as `batch`.
`batch` waits for the next `now` for that agent or the half-hourly flush. `none` is archived
only. 202 means "in the inbox"; the fetch and the hand-on follow the answer.

## 3. Configuration

A channel record of type `tailmsg` (POST `/api/channels/records`):

```json
{ "id": "tailmsg", "type": "tailmsg", "defaultAgent": "codex",
  "tailmsg": { "port": 7766, "allow": ["bot-box", "tag:agents"], "deny": ["old-box"],
               "wake": { "defaultMax": "batch", "senderMax": [{ "sender": "bot-box", "max": "now" }],
                         "quietHours": { "start": 23, "end": 7 }, "ratePerHour": 6 } } }
```

`allow` and `deny` take hostnames or FQDNs, `tag:x` and `user:x` as whois reports them. The
door binds the host's tailnet IPv4 from `tailscale status --json` when it starts; with tailscale
down it logs that and stays closed until a restart. A door added from the settings dialog opens
live. The settings page has no form for the `tailmsg` field yet: the record API is the way in.

State lives under `~/.agentbox/tailmsg/<door id>/`: `inbox/<id>.json` (the envelope, whois, the
wake decision, when it was handed on), `inbox/<id>/files/`, `wake-counters.json`.

## 4. Measured, 2026-10-20

Yobiru's own `tailmsg.py` on chrismac-mini (`serve` + `send … --wake now --as grok --file note.txt`)
against this door on the maintainer's Mac, over the real tailnet:

| Step | Result |
| --- | --- |
| `send` without `--legacy-request` | Yobiru read our `/info` (no capabilities) and sent a plain v1 letter; 202 |
| whois of the peer | `Node.Name` with trailing dot, `UserProfile.LoginName`; ~30 ms |
| file fetch by the url's MagicDNS name | empty reply after 5 s: the name resolved to the peer's IPv6 address, which Yobiru does not listen on |
| file fetch by the verified IPv4 | 200, 20 bytes, sha256 matched; kept |
| reply to the peer's `/msg` | 202; in Yobiru's inbox as `re:<id>`, addressed to `grok` (unknown there, stored, nobody woken) |

Hence the rule in the code: fetches and replies connect to the tailnet address whois verified,
with the url's host in the Host header; a name is never resolved for them.

## 5. Not in this stage

Sending a first letter (only replies); the request lifecycle of tailmsg 0.5; placing fetched
files in the box; a settings-page form; TLS or any authentication beyond the tailnet itself,
which is the spec's position too. Port 7766 is Yobiru's own receiver port: on a machine that
also runs Yobiru, give this door another port.
