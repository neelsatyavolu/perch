// swift-tools-version: 6.2
// Perch Keys: wraps each profile's root key with a Secure Enclave key (plan 3b, task 3).
// Build for the bundle with `swift build -c release --arch arm64` (perch-build stages it).
import PackageDescription

let package = Package(
    name: "PerchKeys",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "PerchKeys", targets: ["PerchKeys"]),
    ],
    targets: [
        .target(name: "PerchKeysCore"),
        .executableTarget(name: "PerchKeys", dependencies: ["PerchKeysCore"]),
        .testTarget(name: "PerchKeysTests", dependencies: ["PerchKeysCore"]),
    ]
)
