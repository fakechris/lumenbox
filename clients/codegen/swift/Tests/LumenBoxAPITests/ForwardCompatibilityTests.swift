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

    // Decisions (INV-2214): an inbox item of a kind this client does not know is shown by its words; a new action, tier or outcome arrives as itself.
    func testAnInboxWithKindsThisClientDoesNotKnow() async throws {
        let page = try await client(.ok, "inbox-page.json").listInbox().ok.body.json
        XCTAssertEqual(page.items.map(\.kind), ["approval", "meeting-invite", "outbox"])
        XCTAssertEqual(page.items[1].title, "Writer invites you to a review at 15:00", "an unknown kind still has its words")
        XCTAssertEqual(page.items[1].actions, ["open-on-page"])
        XCTAssertEqual(page.items[0].approval?.tier, "teleport")
        XCTAssertEqual(page.items[0].actions, ["allow", "deny", "delegate"])
        XCTAssertEqual(page.items[2].draft?.kind, "fax")
    }

    func testADecisionWithAnOutcomeThisClientDoesNotKnow() async throws {
        let body = Components.Schemas.ApprovalDecision(decision: "deny")
        let ack = try await client(.ok, "decision-ack.json").decideApproval(path: .init(id: "ap-1"), body: .json(body)).ok.body.json
        XCTAssertEqual(ack.outcome, "escalated")
    }

    // Conversations (INV-2214): a message, a conversation, a live event and an upload of a kind this client does not know arrive as themselves.
    func testMessagesOfAKindThisClientDoesNotKnow() async throws {
        let page = try await client(.ok, "message-page.json").listMessages(path: .init(id: "c1")).ok.body.json
        XCTAssertEqual(page.items.map(\.kind), ["person", "card", "poll", "steps"])
        XCTAssertEqual(page.items[2].text, "Red or blue?", "an unknown kind still has its words")
        XCTAssertEqual(page.items[1].card?.surfaceId, "pick")
        XCTAssertEqual(page.items[0].sentIds, ["v1-abc"])
    }

    func testConversationsOfAKindThisClientDoesNotKnow() async throws {
        let page = try await client(.ok, "conversation-page.json").listConversations().ok.body.json
        XCTAssertEqual(page.items.map(\.kind), ["group", "main"])
        XCTAssertEqual(page.items[0].canWrite, false)
    }

    func testALiveEventOfAKindThisClientDoesNotKnow() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../fixtures/conversation-event.json").standardized
        let event = try JSONDecoder().decode(Components.Schemas.ConversationEvent.self, from: Data(contentsOf: url))
        XCTAssertEqual(event.kind, "thinking", "skipped by the app, never a decoding failure")
        XCTAssertNil(event.text)
    }

    func testAnUploadOfAKindThisClientDoesNotKnow() async throws {
        let upload = try await client(.ok, "upload.json").uploadFile(query: .init(conversationId: "c1", name: "clip.mov"), body: .binary(HTTPBody("bytes"))).ok.body.json
        XCTAssertEqual(upload.kind, "video")
        XCTAssertEqual(upload.sizeBytes, 5000000000, "a size past 2^32 decodes")
    }

    func testAnErrorWithAnUnknownCode() async throws {
        let answer = try await client(.unauthorized, "error.json").getMe()
        guard case .unauthorized(let refusal) = answer else { return XCTFail("401 is the documented refusal: \(answer)") }
        let body = try refusal.body.json
        XCTAssertEqual(body.code, "api-teapot")
        XCTAssertFalse(body.requestId.isEmpty)
    }
}
