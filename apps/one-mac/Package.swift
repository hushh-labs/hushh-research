// swift-tools-version:5.10
// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import PackageDescription

let package = Package(
    name: "OneMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "OneShared", targets: ["OneShared"]),
        .library(name: "OneIndexer", targets: ["OneIndexer"]),
        .library(name: "OneMCPServer", targets: ["OneMCPServer"]),
        .executable(name: "OneMac", targets: ["OneMac"]),
        .executable(name: "OneDaemon", targets: ["OneDaemon"]),
    ],
    targets: [
        .target(name: "OneShared"),
        .target(name: "OneIndexer", dependencies: ["OneShared"]),
        .target(name: "OneMCPServer", dependencies: ["OneShared", "OneIndexer"]),
        .executableTarget(name: "OneMac", dependencies: ["OneShared"]),
        .executableTarget(name: "OneDaemon", dependencies: ["OneShared", "OneIndexer", "OneMCPServer"]),
        .testTarget(name: "OneSharedTests", dependencies: ["OneShared"]),
    ]
)
