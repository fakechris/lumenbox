// swift-tools-version:5.9
// The Swift side of the client API's generation check (docs/110 §1, INV-2213): swift-openapi-generator
// builds types and a client from docs/api/v1.openapi.json (linked into Sources/LumenBoxAPI), and the
// tests decode answers from a newer server through that client. Run by CI's client-codegen job:
//   swift test --package-path clients/codegen/swift
import PackageDescription

let package = Package(
    name: "LumenBoxAPICheck",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.6.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.0.0"),
    ],
    targets: [
        .target(
            name: "LumenBoxAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .testTarget(
            name: "LumenBoxAPITests",
            dependencies: ["LumenBoxAPI", .product(name: "HTTPTypes", package: "swift-http-types")]
        ),
    ]
)
