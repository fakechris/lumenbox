// Answers from a server newer than this client (clients/codegen/fixtures), decoded by the client
// swift-openapi-generator made from docs/api/v1.openapi.json, with its default configuration: what a
// phone app built today does when the server gains a field or a value (docs/106 §4.1). A field it
// does not know is ignored; a value of an open enumeration it does not know arrives as itself, for
// the app's own `.other(raw)`.
import Foundation
import HTTPTypes
import LumenBoxAPI
import OpenAPIRuntime
import XCTest

/// Answers every request with one fixture, as a server would over HTTPS or the relay.
struct Canned: ClientTransport {
    let status: HTTPResponse.Status
    let fixture: String

    func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../fixtures/\(fixture)").standardized
        let bytes = try Data(contentsOf: url)
        return (HTTPResponse(status: status, headerFields: [.contentType: "application/json"]), HTTPBody(bytes))
    }
}

func client(_ status: HTTPResponse.Status, _ fixture: String) -> Client {
    Client(serverURL: URL(string: "https://box.example.test")!, transport: Canned(status: status, fixture: fixture))
}

final class ForwardCompatibilityTests: XCTestCase {
    func testMetaWithUnknownFieldsAndValues() async throws {
        let meta = try await client(.ok, "meta.json").getMeta().ok.body.json
        XCTAssertEqual(meta.api, "1.7")
        XCTAssertEqual(meta.installation.mode, "federation", "an installation mode this client does not know is kept, not refused")
        XCTAssertTrue(meta.capabilities.contains("listGalaxies"))
    }

    func testMeWithUnknownFieldsAndValues() async throws {
        let me = try await client(.ok, "me.json").getMe().ok.body.json
        XCTAssertEqual(me.role, "overseer")
        XCTAssertEqual(me.credential.kind, "robot")
        XCTAssertEqual(me.credential.scopes, ["work:read", "time:travel"])
        XCTAssertEqual(me.credential.view?.agentIds, ["a7"])
        XCTAssertNotNil(me.credential.lastUsedAt, "a time to the second decodes with the default transcoder")
    }

    func testWorkWithAStateThisClientDoesNotKnow() async throws {
        let page = try await client(.ok, "work-page.json").listWork().ok.body.json
        XCTAssertEqual(page.items.first?.state, "paused", "a state added after this client was built arrives as itself, for .other")
        XCTAssertEqual(page.items.first?.waitKind, "sign-off")
        XCTAssertEqual(page.items.first?.waitsOnMe, true)
        XCTAssertNotNil(page.nextCursor)
    }

    func testChangesOfAKindThisClientDoesNotKnow() async throws {
        let changes = try await client(.ok, "changes.json").getChanges(query: .init(since: 0)).ok.body.json
        XCTAssertEqual(changes.items.map(\._type), ["work", "conversation"], "a change type added later arrives as itself: the client skips or reloads, and never fails")
        XCTAssertEqual(changes.items.last?.op, "archive")
        XCTAssertEqual(changes.durableSeq, 9007199254740001, "a sequence past 2^32 decodes")
    }

    // A device's sign-in (INV-2214): what a phone app built today does with a newer server's providers, statuses and devices.
    func testProvidersOfATypeThisClientDoesNotKnow() async throws {
        let providers = try await client(.ok, "auth-providers.json").listAuthProviders().ok.body.json
        XCTAssertEqual(providers.items.map(\._type), ["dingtalk", "wecom"], "a sign-in channel added later arrives as itself")
    }

    func testASignInWithUnknownFieldsAndValues() async throws {
        let body = Components.Schemas.OAuthExchange(code: "c", codeVerifier: String(repeating: "v", count: 43), redirectUri: "lumenbox://oauth/callback", deviceName: "phone", platform: "ios")
        let signedIn = try await client(.ok, "device-sign-in.json").exchangeOAuthCode(body: .json(body)).ok.body.json
        XCTAssertEqual(signedIn.status, "authenticated")
        XCTAssertEqual(signedIn.tokens?.tokenType, "DPoP", "a token type added later arrives as itself")
        XCTAssertEqual(signedIn.tokens?.expiresInSeconds, 900)
        XCTAssertEqual(signedIn.me?.credential.kind, "device")
        let other = try await client(.ok, "device-sign-in-other.json").exchangeOAuthCode(body: .json(body)).ok.body.json
        XCTAssertEqual(other.status, "mfa_required", "a status added later: the app shows the message and points to the web")
        XCTAssertNil(other.tokens)
        XCTAssertEqual(other.message, "Confirm on your other device.")
    }

    func testDevicesOfAPlatformThisClientDoesNotKnow() async throws {
        let page = try await client(.ok, "device-page.json").listDevices().ok.body.json
        XCTAssertEqual(page.items.map(\.platform), ["visionos", "ios"])
        XCTAssertEqual(page.items.first?.signInMethod, "passkey")
        XCTAssertEqual(page.items.first?.current, true)
    }

    func testAnErrorWithAnUnknownCode() async throws {
        let answer = try await client(.unauthorized, "error.json").getMe()
        guard case .unauthorized(let refusal) = answer else { return XCTFail("401 is the documented refusal: \(answer)") }
        let body = try refusal.body.json
        XCTAssertEqual(body.code, "api-teapot")
        XCTAssertFalse(body.requestId.isEmpty)
    }
}
