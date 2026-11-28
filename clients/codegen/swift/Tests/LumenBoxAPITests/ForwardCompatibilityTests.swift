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

    func testAnErrorWithAnUnknownCode() async throws {
        let answer = try await client(.unauthorized, "error.json").getMe()
        guard case .unauthorized(let refusal) = answer else { return XCTFail("401 is the documented refusal: \(answer)") }
        let body = try refusal.body.json
        XCTAssertEqual(body.code, "api-teapot")
        XCTAssertFalse(body.requestId.isEmpty)
    }
}
