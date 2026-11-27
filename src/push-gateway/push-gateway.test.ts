import assert from "node:assert/strict";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  HostDevicePushStore,
  ProviderTokenCache,
  PushDeviceStore,
  WakePushDispatcher,
  handleV1DevicePushRoute,
  parseLumenPushToken,
  resolvePushGatewayUrl,
  signApnsJwt,
  signFcmServiceAccountAssertion,
  startPushGatewayServer,
} from "./index.ts";

test("ES256 APNs JWT and RS256 FCM service-account JWT signatures verify cryptographically and cache properly", async () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecPrivPem = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const ecPubPem = ec.publicKey.export({ type: "spki", format: "pem" }).toString();

  const jwt = signApnsJwt({
    keyId: "ABC1234567",
    teamId: "TEAM987654",
    privateKeyPem: ecPrivPem,
    issuedAtSec: 1_795_000_000,
  });
  const [hB64, pB64, sB64] = jwt.split(".");
  assert.ok(hB64 && pB64 && sB64);
  assert.deepEqual(JSON.parse(Buffer.from(hB64, "base64url").toString("utf8")), {
    alg: "ES256",
    kid: "ABC1234567",
  });
  assert.deepEqual(JSON.parse(Buffer.from(pB64, "base64url").toString("utf8")), {
    iss: "TEAM987654",
    iat: 1_795_000_000,
  });
  const rawSig = Buffer.from(sB64, "base64url");
  assert.equal(rawSig.byteLength, 64);
  const okEs256 = createVerify("SHA256")
    .update(`${hB64}.${pB64}`)
    .verify({ key: createPublicKey(ecPubPem), dsaEncoding: "ieee-p1363" }, rawSig);
  assert.equal(okEs256, true);

  // 50-minute JWT cache reuses the token within window and refreshes past 50m
  const cache = new ProviderTokenCache();
  const cached1 = cache.getApnsJwt({
    keyId: "ABC1234567",
    teamId: "TEAM987654",
    privateKeyPem: ecPrivPem,
    nowSec: 1_000,
  });
  const cached2 = cache.getApnsJwt({
    keyId: "ABC1234567",
    teamId: "TEAM987654",
    privateKeyPem: ecPrivPem,
    nowSec: 1_000 + 49 * 60,
  });
  assert.equal(cached1, cached2);
  const cached3 = cache.getApnsJwt({
    keyId: "ABC1234567",
    teamId: "TEAM987654",
    privateKeyPem: ecPrivPem,
    nowSec: 1_000 + 51 * 60,
  });
  assert.notEqual(cached1, cached3);

  // RS256 FCM assertion verification + OAuth token cache
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPrivPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rsaPubPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
  const sa = {
    project_id: "lumenbox-push-test",
    client_email: "push@lumenbox-push-test.iam.gserviceaccount.com",
    private_key: rsaPrivPem,
    token_uri: "http://127.0.0.1/oauth2/token",
  };
  const { assertion } = signFcmServiceAccountAssertion({
    serviceAccount: sa,
    issuedAtSec: 1_795_000_000,
  });
  const [fh, fp, fsig] = assertion.split(".");
  assert.ok(fh && fp && fsig);
  const okRs256 = createVerify("RSA-SHA256")
    .update(`${fh}.${fp}`)
    .verify(createPublicKey(rsaPubPem), Buffer.from(fsig, "base64url"));
  assert.equal(okRs256, true);

  let oauthFetchCalls = 0;
  const tokA = await cache.getFcmAccessToken({
    serviceAccount: sa,
    nowSec: 2_000,
    fetchImpl: async () => {
      oauthFetchCalls += 1;
      return new Response(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }), {
        status: 200,
      });
    },
  });
  const tokB = await cache.getFcmAccessToken({
    serviceAccount: sa,
    nowSec: 2_500,
    fetchImpl: async () => {
      oauthFetchCalls += 1;
      return new Response("{}", { status: 500 });
    },
  });
  assert.equal(tokA, "ya29.mock");
  assert.equal(tokB, "ya29.mock");
  assert.equal(oauthFetchCalls, 1);
});

test("PushDeviceStore preserves token across updates, supersedes stale install on reinstall, and guards race deactivation", () => {
  const store = new PushDeviceStore(":memory:");
  try {
    const first = store.register({
      appId: "io.lumenbox.app",
      deviceId: "dev-uuid-1111",
      platform: "ios",
      provider: "apns",
      nativeToken: "AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899",
      environment: "production",
    });
    assert.ok(parseLumenPushToken(first.token));

    // Rotating native token for the same (appId, deviceId) returns the exact same LumenPushToken
    const rotated = store.register({
      appId: "io.lumenbox.app",
      deviceId: "dev-uuid-1111",
      platform: "ios",
      provider: "apns",
      nativeToken: "1111222233334444555566667777888811112222333344445555666677778888",
      environment: "development",
    });
    assert.equal(rotated.token, first.token);

    // Reinstall generates a new deviceId ("dev-uuid-2222") with the same native token -> supersedes old row!
    const reinstalled = store.register({
      appId: "io.lumenbox.app",
      deviceId: "dev-uuid-2222",
      platform: "ios",
      provider: "apns",
      nativeToken: "1111222233334444555566667777888811112222333344445555666677778888",
      environment: "development",
    });
    assert.notEqual(reinstalled.token, first.token);
    const oldRow = store.getByTokenId(first.tokenId);
    assert.equal(oldRow?.active, false);
    assert.equal(oldRow?.inactiveReason, "superseded");

    // Race-safe deactivation: if an old send fails for an outdated native token after the install
    // already registered a fresh native token, the fresh native token stays active!
    store.register({
      appId: "io.lumenbox.app",
      deviceId: "dev-uuid-2222",
      platform: "ios",
      provider: "apns",
      nativeToken: "9999999999999999999999999999999999999999999999999999999999999999",
      environment: "production",
    });
    const deactivatedStale = store.deactivateIfMatchingNativeToken(
      reinstalled.tokenId,
      "1111222233334444555566667777888811112222333344445555666677778888",
    );
    assert.equal(deactivatedStale, false);
    assert.equal(store.getByTokenId(reinstalled.tokenId)?.active, true);
  } finally {
    store.close();
  }
});

test("End-to-end: Wake-Only Push Gateway + HostDevicePushStore + /api/v1 routes enforce zero plaintext, rate limits, preferences, pull privacy, and DeviceNotRegistered cleanup", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lumenbox-push-e2e-"));
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecPrivPem = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPrivPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const capturedApnsCalls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const capturedFcmCalls: Array<{ url: string; body: unknown }> = [];
  let apnsShouldReturnUnregistered = false;

  const mockProviderFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "fcm-access-tok", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.includes("/3/device/")) {
      capturedApnsCalls.push({
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      if (apnsShouldReturnUnregistered) {
        return new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
      }
      return new Response("", { status: 200 });
    }
    if (url.includes("/messages:send")) {
      capturedFcmCalls.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ name: "projects/p/messages/m1" }), { status: 200 });
    }
    throw new Error(`Unexpected provider URL: ${url}`);
  };

  const gateway = await startPushGatewayServer(0, "127.0.0.1", {
    allowedAppIds: ["io.lumenbox.ios", "io.lumenbox.android"],
    sendRateLimitPerRecipientPerMinute: 2,
    registerRateLimitPerMinute: 10,
    fetchImpl: mockProviderFetch,
    apns: {
      keyId: "KEY1234567",
      teamId: "TEAM123456",
      privateKeyPem: ecPrivPem,
      productionOrigin: "http://127.0.0.1:9",
    },
    fcm: {
      project_id: "lumenbox-proj",
      client_email: "svc@lumenbox-proj.iam.gserviceaccount.com",
      private_key: rsaPrivPem,
      token_uri: "http://127.0.0.1:9/oauth2/token",
      apiOrigin: "http://127.0.0.1:9",
    },
  });

  // Spin up minimal host server mounting handleV1DevicePushRoute
  const hostStore = new HostDevicePushStore(tmpHome);
  const hostServer = http.createServer(async (req, res) => {
    const principalId = String(req.headers["x-principal"] ?? "person_alice");
    const deviceId = String(req.headers["x-device"] ?? "dev_ios_1");
    const handled = await handleV1DevicePushRoute(
      req,
      res,
      { principalId, deviceId, requestId: "req_test_1" },
      hostStore,
    );
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
  const hostPort = (hostServer.address() as net.AddressInfo).port;
  const hostUrl = `http://127.0.0.1:${hostPort}`;

  try {
    // 1. Disallowed appId is rejected with 403 APP_NOT_ALLOWED
    const badAppRes = await fetch(`${gateway.url}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "device-00000001",
        appId: "com.evil.clone",
        platform: "ios",
        pushToken: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      }),
    });
    assert.equal(badAppRes.status, 403);

    // 2. Register iOS and Android devices on the gateway
    const iosReg = (await (
      await fetch(`${gateway.url}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "ios-install-0001",
          appId: "io.lumenbox.ios",
          platform: "ios",
          pushToken: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        }),
      })
    ).json()) as { token: string };
    assert.ok(parseLumenPushToken(iosReg.token));

    const androidReg = (await (
      await fetch(`${gateway.url}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "and-install-0001",
          appId: "io.lumenbox.android",
          platform: "android",
          pushToken: "fcm_registration_token_example_1234567890",
        }),
      })
    ).json()) as { token: string };
    assert.ok(parseLumenPushToken(androidReg.token));

    // 3. Gateway strictly rejects any request attempting to send plaintext title/body!
    const leakAttempt = await fetch(`${gateway.url}/v1/push/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: iosReg.token,
        connId: "conn_corp_a",
        seq: 1,
        title: "Secret M&A Project",
      }),
    });
    assert.equal(leakAttempt.status, 400);

    // 4. Both devices register their LumenPushToken + preferences on the host via PUT /api/v1/devices/self/push
    //    - iOS sets mode: "needs-you"
    //    - Android sets mode: "all"
    const putIos = await fetch(`${hostUrl}/api/v1/devices/self/push`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-principal": "person_alice",
        "x-device": "dev_ios_1",
      },
      body: JSON.stringify({
        pushToken: iosReg.token,
        connId: "conn_alice_org",
        preferences: { mode: "needs-you" },
      }),
    });
    assert.equal(putIos.status, 200);

    const putAndroid = await fetch(`${hostUrl}/api/v1/devices/self/push`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-principal": "person_alice",
        "x-device": "dev_and_1",
      },
      body: JSON.stringify({
        pushToken: androidReg.token,
        connId: "conn_alice_org",
        preferences: { mode: "all" },
      }),
    });
    assert.equal(putAndroid.status, 200);

    // 5. Override gateway URL via AGENTBOX_PUSH_GATEWAY_URL resolution
    const resolvedGateway = resolvePushGatewayUrl({ envUrl: gateway.url });
    const dispatcher = new WakePushDispatcher({
      store: hostStore,
      gatewayUrl: resolvedGateway,
      redactOnLockScreen: true,
    });

    // Event 1: "task-completed" -> only Android ("all") is woken; iOS ("needs-you") is filtered out!
    const r1 = await dispatcher.dispatchEvent({
      principalId: "person_alice",
      kind: "task-completed",
      title: "季度财报分析已完成",
      body: "交付物 report.pdf 已生成",
    });
    assert.equal(r1.seq, 1);
    assert.equal(r1.sent, 1);
    assert.equal(capturedApnsCalls.length, 0);
    assert.equal(capturedFcmCalls.length, 1);
    // Verify FCM payload has ZERO plaintext title/body — only { kind: "wake", connId, seq: "1" }!
    assert.deepEqual(capturedFcmCalls[0]?.body, {
      message: {
        token: "fcm_registration_token_example_1234567890",
        android: { priority: "HIGH", ttl: "3600s" },
        data: { kind: "wake", connId: "conn_alice_org", seq: "1" },
      },
    });

    // Event 2: "needs-you" -> wakes BOTH iOS (mutable-content: 1, apns-priority: 10) and Android!
    const r2 = await dispatcher.dispatchEvent({
      principalId: "person_alice",
      kind: "needs-you",
      title: "审批请求：执行生产迁移",
      body: "Agent operator 请求运行 migrate.sh",
      ref: "apr_99",
    });
    assert.equal(r2.seq, 2);
    assert.equal(r2.sent, 2);
    assert.equal(capturedApnsCalls.length, 1);
    assert.equal(capturedApnsCalls[0]?.headers.get("apns-priority"), "10");
    assert.equal(capturedApnsCalls[0]?.headers.get("apns-push-type"), "alert");
    assert.equal(capturedApnsCalls[0]?.headers.get("apns-topic"), "io.lumenbox.ios");
    assert.deepEqual(capturedApnsCalls[0]?.body, {
      aps: {
        alert: { title: "LumenBox", body: "New activity waiting" },
        "mutable-content": 1,
        sound: "default",
      },
      body: { connId: "conn_alice_org", seq: 2 },
    });

    // 6. Phone NotificationServiceExtension pulls real summary directly from host via GET /api/v1/notifications/2
    const pullAlice = await fetch(`${hostUrl}/api/v1/notifications/2`, {
      headers: { "x-principal": "person_alice", "x-device": "dev_ios_1" },
    });
    assert.equal(pullAlice.status, 200);
    const pulledJson = (await pullAlice.json()) as {
      seq: number;
      title: string;
      body: string;
      redactOnLockScreen: boolean;
    };
    assert.equal(pulledJson.seq, 2);
    assert.equal(pulledJson.title, "审批请求：执行生产迁移");
    assert.equal(pulledJson.redactOnLockScreen, true);

    // Principal B querying Alice's notification seq receives 404 (not 403)!
    const pullBob = await fetch(`${hostUrl}/api/v1/notifications/2`, {
      headers: { "x-principal": "person_bob", "x-device": "dev_bob_1" },
    });
    assert.equal(pullBob.status, 404);

    // 7. Per-recipient rate limit: Android already received 2 sends in this minute (limit=2),
    //    while iOS received 1. Sending to both now throttles Android ONLY while iOS succeeds!
    const batchRes = await fetch(`${gateway.url}/v1/push/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: [iosReg.token, androidReg.token],
        connId: "conn_alice_org",
        seq: 2,
      }),
    });
    const batchTickets = (await batchRes.json()) as {
      data: Array<{ status: string; details?: { error?: string } }>;
    };
    assert.equal(batchTickets.data[0]?.status, "ok");
    assert.equal(batchTickets.data[1]?.status, "error");
    assert.equal(batchTickets.data[1]?.details?.error, "MessageRateExceeded");

    // 8. Automatic DeviceNotRegistered cleanup: register a fresh iOS device, simulate APNs 410 Unregistered,
    //    and verify WakePushDispatcher automatically prunes it from device-pushes.json!
    const iosDeadReg = (await (
      await fetch(`${gateway.url}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "ios-uninstalled-0099",
          appId: "io.lumenbox.ios",
          platform: "ios",
          pushToken: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        }),
      })
    ).json()) as { token: string };

    await fetch(`${hostUrl}/api/v1/devices/self/push`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-principal": "person_carol",
        "x-device": "dev_carol_old",
      },
      body: JSON.stringify({
        pushToken: iosDeadReg.token,
        connId: "conn_carol",
      }),
    });
    assert.equal(hostStore.listForPrincipal("person_carol").length, 1);

    apnsShouldReturnUnregistered = true;
    const rDead = await dispatcher.dispatchEvent({
      principalId: "person_carol",
      kind: "needs-you",
      title: "待确认",
      body: "测试卸载自动清理",
    });
    assert.equal(rDead.pruned, 1);
    assert.equal(hostStore.listForPrincipal("person_carol").length, 0);
  } finally {
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    await gateway.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
