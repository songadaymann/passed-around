// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "PassedAround",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "PassedAround", targets: ["PassedAround"])],
    dependencies: [
        .package(url: "https://github.com/mattt/Madrid.git", revision: "5245d83ce866666ac3cfcfddde49298dbd4b2732")
    ],
    targets: [
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3", providers: [.brew(["sqlite3"])]),
        .target(name: "PassedAroundCore", dependencies: ["CSQLite", .product(name: "TypedStream", package: "Madrid")]),
        .executableTarget(name: "PassedAround", dependencies: ["PassedAroundCore"], resources: [.copy("Resources/demo-chat.db")]),
        .executableTarget(name: "PrivacyChecks", dependencies: ["PassedAroundCore", "CSQLite"], path: "Tests/PrivacyChecks")
    ]
)
