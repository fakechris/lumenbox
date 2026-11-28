<!-- doc: 110-mobile-clients
     title: Native mobile clients: two repositories, one API over two transports, encrypted relay, and wake-only push
     family: decision
     status: current
     updated: 2026-11-28
-->
# Native mobile clients: two repositories, one API over two transports, encrypted relay, and wake-only push

Decided with Chris on 2026-11-27; §6 tracks what is built.

A person away from their desk needs to see what their agents are doing, answer the decisions that
wait on them, send a message or a photo, inspect a deliverable, and watch an agent's screen — on
both their personal Mac installation and every organisation installation they belong to
(docs/95 §4). Both modes ship together in the first release of two native apps, iOS and Android,
developed in parallel.

## 0. Decisions, in seven sentences

1. **Two native repositories under `PolyForm Shield 1.0.0`.** `lumenbox-ios` (Swift / SwiftUI) and
   `lumenbox-android` (Kotlin / Jetpack Compose) live in separate repositories outside this
   GPL-3.0 tree, licensed under `PolyForm Shield 1.0.0` so the source is readable, compatible with
   App Store distribution, and closed against competing commercial forks or rebranded apps.
2. **One multi-installation model, identical to the desktop shell (docs/95 §4).** The app holds at
   most one personal Mac installation and any number of organisation connections, isolated in
   separate keychain entries and separately encrypted local databases; only per-installation
   `Needs you` counts appear at the top level.
3. **One generated `/api/v1` client over an abstract transport (docs/106 §4).** Both apps generate
   typed models and calls from `docs/api/v1.openapi.json` and run the same business code over two
   transports: direct HTTPS (for organisation servers and reachable local/tailnet hosts) and a
   multiplexed end-to-end encrypted relay channel (for a personal Mac behind NAT).
4. **Personal mode pairs once with a fragment QR and reconnects with `Noise_IK`.** The Mac keeps a
   static X25519 keypair; pairing exchanges a two-minute one-time secret in a URL `#fragment` to
   register each phone's own static public key, and later sessions use
   `Noise_IK_25519_ChaChaPoly_SHA256` so the relay sees nothing and the Mac can revoke a single
   phone without disturbing any other device.
5. **Organisation mode uses native OAuth + PKCE, rotating device credentials, and remote wipe.**
   Phones never hold the 30-day web cookie; they obtain 15-minute access tokens and single-use
   rotating refresh tokens in non-migratable hardware storage, and wipe that organisation's
   encrypted local cache immediately on `401 access-removed`.
6. **One unified wake-only push gateway.** A stateless gateway (`push.lumenbox.com`, configurable
   for white-label builds) wraps native APNs and FCM tokens into opaque capability tokens and
   sends only `{ connId, seq }` with `mutable-content: 1`; the phone wakes in the background and
   fetches the title and summary directly from its own Mac or its own organisation server.
7. **High-impact mobile decisions require biometrics, never grant `"always"`, and watch desktops
   read-only in v1.** Approving external side effects on a small screen requires Face ID / Touch ID
   or `BiometricPrompt`, caps scope to `"once"` or `"session"`, and opens VNC streams with `view`
   tickets (`/vnc-ro/`) only; touch takeover (`control`) waits for a later release.

## 1. Repository boundary, licence, and code generation

- **Why outside this repository.** A GPL-3.0 client conflicts with Apple App Store FairPlay terms
  unless distributed solely by a single copyright holder with no third-party GPL code, and mobile
  toolchains, signing keys and store review schedules differ from the server's release cadence.
  Keeping `lumenbox-ios` and `lumenbox-android` separate under `PolyForm Shield 1.0.0` (with a
  contributor licence agreement if external patches are ever accepted) preserves full commercial
  and white-label rights while forbidding competing commercial redistributions.
- **How the contract crosses repositories.** As part of the server prerequisites (§6), this
  repository will build `src/web/client-api/`, export `docs/api/v1.openapi.json` (guarded by
  `surface-baseline.json`, docs/106 §7), and publish a deterministic fixture bundle of OpenAPI
  examples and encrypted-relay frame test vectors. Once exported, CI here will verify that both the
  Swift (`swift-openapi-generator`) and Kotlin (`openapi-generator` Kotlin client configured with
  `kotlinx.serialization`) generators compile cleanly against every `v1.openapi.json` change.
- **Forward compatibility on old app builds.** Store updates lag server rollouts. Both generators
  decode unknown JSON fields by ignoring them and decode unknown enum or discriminated-union tags
  into an explicit `.other(rawTag)` case that renders the item's plain summary sentence and offers
  to open it on the desktop or web, never failing decoding.

## 2. Syncing and streaming on a phone

Mobile operating systems suspend background sockets within seconds of screen lock, and an active
coding turn can emit hundreds of token and tool deltas per minute — enough to wrap the server's
512-frame in-memory SSE replay ring (`src/web/sse-replay.ts`) in under two minutes.

`/api/v1` therefore splits transient streaming from durable catch-up (docs/106 §4.2):

| Channel | Carries | Retention | Used when |
|---|---|---|---|
| `GET /api/v1/conversations/{id}/stream` | Live `thinking`, `text` deltas, and in-flight tool progress for one conversation | Transient only | The person has that conversation open on screen |
| `GET /api/v1/events` | Durable state transitions (`inbox`, `work`, committed messages, deliverables, box state) | Bounded replay ring (`Last-Event-ID`) | The app is in the foreground |
| `GET /api/v1/changes?since=<durableSeq>` | Compact delta of durable records written since `<durableSeq>`, backed by the on-disk ledgers | Across restarts and multi-hour sleep | App launch, foreground resume, or notification service wake |

Every `POST` from the phone carries a persisted UUID as `Idempotency-Key` (24 h window on the
server) and `clientMessageId`, so a retry across a subway tunnel handover never duplicates a prompt
or an approval.

## 3. Personal mode: Mac app, candidate paths, encrypted relay, and sleep

A personal installation (`installation.mode === "single-machine"`, docs/95 §2) runs `agentbox web
--desktop` on `127.0.0.1` on the Owner's Mac (`electron/main.cjs`), ordinarily behind home or
office NAT.

### 3.1 Candidate paths: direct when reachable, relay everywhere else

Each paired Mac record on the phone holds two candidate transports to the same pinned host static
public key:

1. **Direct encrypted link** — local network mDNS (`_lumenbox._tcp`) or a shared tailnet address
   when advertised at pairing or discovered locally. Preferred whenever reachable so large
   deliverables and desktop streams stay local.
2. **Untrusted relay (`wss://relay.lumenbox.com`)** — outbound WebSocket from the Mac daemon and
   outbound WebSocket from the phone, matched by routing id. Requires zero router configuration,
   port forwarding or third-party VPN setup.

Both paths run the same cryptographic handshake and frame layer below, so switching between Wi-Fi
and cellular changes only the underlying socket.

### 3.2 Pairing, mutual zero-knowledge authentication, and per-device revocation

A relay that only authenticates the responder (`Noise_NK` alone) turns the pairing QR into a shared
permanent password and makes revoking one lost phone impossible without resetting the Mac's keypair
and disconnecting every other device. LumenBox separates **first-time pairing** from **session
reconnection**:

- **Host identity.** On first enable of mobile access, the personal installation generates an
  X25519 static keypair (`~/.agentbox/relay-host-key.json`, mode `0600`).
- **One-time QR pairing.** In the Mac app, *Connect a phone* mints a single-use 256-bit
  `pairSecret` valid for 2 minutes and renders a QR URI whose sensitive parameters sit inside the
  URL `#fragment` (`lumenbox://pair#hostPub=<b64u>&relay=<wss>&route=<id>&pairSecret=<b64u>`), so
  no web server or relay ever receives the host public key or secret.
- **Device registration.** The phone generates its own X25519 static keypair (`deviceStaticKey`,
  stored non-migratable in Keychain / Keystore), opens an initial `Noise_NK_25519_ChaChaPoly_SHA256`
  channel keyed to `hostPub`, and sends `{ pairSecret, deviceStaticPub, deviceName, platform }`
  inside the encrypted channel. The Mac consumes `pairSecret`, records `deviceStaticPub` in
  `~/.agentbox/paired-devices.json` with its `deviceId` and scopes, and returns `{ deviceId,
  connId }`.
- **Session reconnection (`Noise_IK_25519_ChaChaPoly_SHA256`).** Every later connection runs
  `Noise_IK` with prologue `lumenbox-relay/1`:
  - Message 1 (`-> e, es, s, ss`) encrypts the phone's `deviceStaticPub` under `es`, hiding which
    device is connecting from the relay while proving possession of `deviceStaticKey` to the Mac.
  - The Mac checks `deviceStaticPub` against `paired-devices.json`; if the Owner removed that
    phone, the handshake is refused immediately while every other paired device keeps working.
  - Message 2 (`<- e, ee, se`) completes fresh forward-secret key agreement. No legacy or
    unauthenticated fallback mode exists.
- **Authenticated record framing and multiplexing.** Application payloads are split into chunks of
  at most 65,509 bytes with `kind(1) || flags(1) || totalLength(u32 BE) || streamId(u32 BE)`
  **inside** the ChaCha20-Poly1305 plaintext (fitting within Noise's 65,535-byte transport message
  ceiling once the 10-byte inner header and 16-byte authentication tag are added) under strictly
  monotonic 64-bit counters. The relay cannot coalesce, truncate, reorder or replay frames; stream
  completion requires an authenticated `stream_close` control frame (or matched expected length),
  and an unauthenticated socket EOF treats any still-open stream as incomplete. Inside the encrypted
  channel, lightweight flow-controlled streams (`streamId` + receive window credits) carry virtual
  `/api/v1` HTTP calls, event streams and read-only VNC sockets directly into `src/web/client-api/`
  in memory without exposing `127.0.0.1:7777` to the LAN.
- **Relay defences.** The relay stores no database, user keys or transcripts. It validates X25519
  public-key canonical encoding and rejects low-order points on handshake envelopes, enforces
  per-IP rate limits (honouring `X-Forwarded-For` only from explicitly configured proxy CIDRs),
  bounds per-socket heap and queued bytes, and sheds load cleanly under memory pressure.

### 3.3 Mac sleep and lid-close behaviour

macOS distinguishes idle sleep from hardware clamshell sleep (closing a MacBook lid with no
external display attached):

1. **Idle sleep prevention (default, zero privilege).** While mobile access is enabled on AC power
   — or while any agent turn is running — `electron/main.cjs` holds
   `powerSaveBlocker.start("prevent-app-suspension")`, keeping the orchestrator, Docker and the
   relay link alive while allowing the display to sleep. Desktop Macs (Mac mini, Mac Studio, iMac)
   stay reachable 24/7 under this default alone.
2. **Immediate suspend notice.** On `powerMonitor.on("suspend")`, the shell sends a signed
   `host_sleeping` control frame over the relay within the pre-sleep window before sockets freeze,
   so the phone immediately shows *Mac is asleep (last seen …)* with cached state rather than
   spinning on a network timeout.
3. **Optional AC-only clamshell awake setting.** An opt-in toggle in the Mac app (*Stay reachable
   with lid closed on power adapter*) toggles macOS's system-wide `disablesleep` flag (`pmset
   disablesleep 1`) via explicit administrator authorization only while AC power is present, clears
   it immediately on battery transition (`on-battery`) or app exit, and reconciles/clears any
   leftover `disablesleep 1` state on startup after an unexpected crash or reboot if AC conditions
   no longer hold.

### 3.4 Clean reinstall handling on iOS

iOS retains Keychain items across app uninstalls. Each app launch checks an install marker in
`UserDefaults` (which iOS deletes on uninstall); when absent on cold start, the app purges all
Keychain entries in its access group before generating a fresh `deviceId`, preventing stale tokens
or orphaned device keys after a reinstall.

## 4. Organisation mode: sign-in, credentials, authorization, and remote wipe

An organisation installation (`installation.mode === "organisation"`, docs/95 §3, docs/109) runs
on the organisation's cluster behind HTTPS (`AGENTBOX_PUBLIC_URL=https://…`, docs/106 §5). Phones
connect directly over HTTPS (over the public ingress or the company's VPN/tailnet, supporting
enterprise MDM root certificates); an air-gapped cluster without member VPN may optionally attach
an outbound encrypted relay connector using §3.2's transport while keeping every organisation rule
below.

1. **Sign-in paths.**
   - *Native OAuth + PKCE (primary):* the app reads `GET /api/v1/meta`, opens `ASWebAuthenticationSession`
     (iOS) or Custom Tabs (Android) with OAuth 2.0 Authorization Code + PKCE (`S256`) against the
     organisation's DingTalk or Feishu channel (docs/109), and exchanges the code at
     `POST /api/v1/auth/oauth/exchange` for a **device credential**. An activated member lands on
     their personal box and agent (docs/109 §2–3); an unactivated member receives the structured
     `asked_to_join` state.
   - *Desktop-to-phone QR pairing (secondary):* a signed-in web or desktop session displays a
     two-minute one-time pairing QR bound to that Principal. Pairing always flows from an already
     authenticated screen to the phone, never the reverse without explicit risk confirmation and
     number matching, preventing QR session-fixation phishing.
2. **Rotating hardware-held tokens with reuse cut-off.**
   - Phones never receive or send the 30-day `agentbox_who` cookie.
   - Access tokens (`Bearer lbxd_<…>`) live 15 minutes in memory only.
   - Refresh tokens are stored as SHA-256 hashes on the server (`deviceId`, `familyId`, `scopes`,
     `expiresAt`, `lastUsedAt`) and kept on the phone under `AfterFirstUnlockThisDeviceOnly`
     (iOS Keychain, excluded from iCloud backup) or hardware-backed Android Keystore. Every refresh
     rotates the token. To prevent false sign-outs on lost responses or concurrent wakes between the
     main app and the notification service extension, both processes serialize refreshes through an
     App Group / process file lock, retries carrying the same `Idempotency-Key` replay the rotated
     pair, and the server grants a 30-second overlap grace window on the just-rotated token for the
     same device; presenting an already-rotated refresh token outside that window immediately
     revokes the entire `familyId` and writes a security audit entry.
3. **Four-way authority intersection and `404` isolation.** Every `/api/v1` request is gated by
   `Principal current role ∩ box membership ∩ device token scopes ∩ pure /api/v1 route table`
   (docs/106 §4.1–4.3). Directory sync marking a person *left* (docs/109), an Admin removing a
   member, or a member deleting a device from *My devices* immediately invalidates that device's
   tokens and runs `OpenDesktops.recheck()` (`src/web/open-desktops.ts`) to drop live streams.
4. **Small-screen approval safety.**
   - Device credentials cannot grant `"always"` standing approvals: `POST /api/v1/approvals/{id}`
     accepts `"once"` or `"session"` only.
   - Approvals carrying external or credential side effects set `stepUpRequired: true`; the mobile
     app prompts local biometric verification (`LAContext` / `BiometricPrompt`) to unlock a
     device-bound hardware signing key registered with the credential and attaches a server-verified
     proof bound to `(approvalId, decision)`, and the server rejects `stepUpRequired` decisions
     lacking a valid proof.
   - Secret requests (`AskSecret`) submit write-only values straight into the server vault and
     never echo through chat messages.
   - Desktop viewing in v1 requests `"view"` tickets only (60 s single-use ticket routed to
     `/vnc-ro/<index>/`, docs/106 §5 R6), preventing accidental touch clicks on a live desktop.
   - *As built (INV-2214 part 1, docs/106 §8.1):* the 30-second grace answers `409 refresh-superseded`
     and issues nothing; only a retry with the first request's `Idempotency-Key` gets the pair again.
     One refresh family per device sign-in, so a family revoked is that device ended. Refresh tokens
     last thirty days from issue and never past a year from the sign-in. The step-up key is registered
     at the exchange or the pairing (`stepUpKeyId`, `stepUpPublicKey`: P-256 SPKI). Organisation pairing
     is `lumenbox://pair#server=<origin>&code=<code>`, shown after a sign-in in the last ten minutes.
   - *As built (INV-2214 part 2, docs/106 §8.1):* the step-up key is the P-256 key registered at sign-in;
     the app creates it to need the person's biometrics for every use (iOS: Secure Enclave with
     `.biometryCurrentSet`; Android: StrongBox/TEE, user authentication for every use, invalidated by a
     new enrolment) and signs `lumenbox-step-up/1\n<deviceId>\n<item id>\n<decision>\n<detail>` (docs/106 §8.1 lists each decision and detail). The server
     checks the signature, not how the key was made: attestation is not checked in v1. `always` is
     refused for every v1 credential. A device's answers are recorded as `user:<person> device:<id>`.
   - *A requirement on both apps before general availability:* receive the sign-in's `redirectUri` on a
     verified https app link (iOS Universal Links, Android App Links with `autoVerify`), not only the
     `lumenbox:` scheme. A custom scheme can be registered by any other app on the phone; with a sign-in
     an attacker started (so holding its PKCE verifier), such an app would receive the victim's code.
     The server accepts the `lumenbox:` scheme until then and checks the exact `redirectUri` on exchange.
5. **Encrypted local cache and automatic remote wipe.** Each organisation connection on the phone
   stores its offline SQLite cache under a distinct 256-bit key held in the hardware keychain.
   Whenever any call or background refresh receives `401` with `code: "access-removed"`, the app
   destroys that connection's keychain key and deletes its cache directory immediately.

## 5. Unified wake-only push gateway

Apple APNs and Google FCM require the developer's private signing credentials (`.p8` key and FCM
service account) bound to the store bundle identifier, which self-hosted Macs and customer
Kubernetes servers can never hold. At the same time, neither personal transcripts nor enterprise
task titles may pass in cleartext through a vendor-hosted push service.

LumenBox runs one stateless push gateway (`push.lumenbox.com`, overridable via
`AGENTBOX_PUSH_GATEWAY_URL` for white-label enterprise builds re-signed under a customer's own
store identity):

1. **Opaque capability registration.** The mobile app registers `(appId, deviceId, platform,
   nativePushToken)` with the gateway and receives an unguessable capability wrapper
   `LumenPushToken[<22-char-base62>]` (~131 bits). Re-registering the same `(appId, deviceId)`
   updates the underlying token in place; registering the same native token under a fresh
   `deviceId` marks the superseded row inactive so stale servers receive `DeviceNotRegistered` and
   clean up automatically. The phone sends `LumenPushToken[…]` and a local random connection handle
   `connId` to its Mac or organisation server via `PUT /api/v1/devices/self/push`.
2. **Zero-content wake payload.** When an `inbox` decision arrives or long work finishes, the Mac
   or organisation server POSTs `{ to: "LumenPushToken[…]", connId, seq }` to the gateway — no
   server URL, no person name, no agent name, no task or message text. Rate limits apply per
   recipient token, not per sender IP.
3. **Background pull from the authoritative source.** The gateway dispatches an alert push with
   `mutable-content: 1` (iOS `apns-priority: 10`, avoiding silent-push throttling) and a generic
   fallback body, or a high-priority data message (Android). On iOS, `UNNotificationServiceExtension`
   wakes before banner presentation; on Android, the messaging service immediately posts the generic
   fallback notification upon receiving the data message and then updates it in place via supported
   background work. In both cases, the handler looks up `connId` in the local App Group / encrypted
   keychain, connects directly to that personal Mac (over `Noise_IK`) or that organisation's own
   server (`GET /api/v1/notifications/{seq}`), and replaces the notification text locally
   (respecting an organisation's lock-screen redaction policy when set). If the server is on a
   disconnected intranet VPN or slow to respond, the generic fallback banner remains visible.
4. **Domestic Android delivery.** Where Google Play Services are unavailable, Android builds pair
   vendor system push channels (carrying the same zero-content `{ connId, seq }` envelope) with
   deep-link buttons (`lumenbox://open/…`) inside the organisation's existing DingTalk and Feishu
   cards (docs/109).

## 6. Build order before client UI work

Both personal and organisation modes ship in the first release of both apps, gated on five
server-side and infrastructure prerequisites in order:

1. **Private-network remote access baseline** (docs/106 §5 R1–R8, committed as INV-2204).
2. **`/api/v1` read and durable-sync slice** (`src/web/client-api/`, pure default-deny route table
   with `404` isolation, `/meta`, `/me`, `/agents`, `/work`, `/board`, `/events`,
   `/changes?since=`, OpenAPI ratchet, Swift + Kotlin codegen CI check; INV-2213).
3. **`/api/v1` device credentials, conversations, uploads, and polymorphic decisions** (`/auth/*`
   PKCE + pairing + rotating refresh tokens with reuse cut-off, `/devices/*`, `/inbox` +
   `stepUpRequired` + no-`"always"` rule, `/conversations/*`, `/uploads`, `/deliverables/*`,
   read-only `/desktops/*/tickets`; INV-2214).
4. **Unified wake-only push gateway** (`push.lumenbox.com` service + host push dispatcher and
   per-device notification preferences; INV-2215).
5. **Personal-mode encrypted relay and Mac sleep integration** (stateless relay service,
   `Noise_NK` pairing + `Noise_IK` session transport with multiplexed streams, LAN/tailnet direct
   probing, `paired-devices.json` revocation, and Electron three-tier sleep handling; INV-2216),
   followed by the public remote-access review items (docs/106 §5 R9–R10) and exported protocol
   fixtures for `lumenbox-ios` and `lumenbox-android` (INV-2217).
