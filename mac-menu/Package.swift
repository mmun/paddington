// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "WalkingPadMenuBar",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "walkingpad-menu", targets: ["WalkingPadMenuBar"])
    ],
    targets: [
        .executableTarget(
            name: "WalkingPadMenuBar"
        )
    ]
)
