import Foundation

public struct MusicURL: Hashable, Sendable {
    public let url: String
    public let platform: String
    public let kind: String
    public init(url: String, platform: String, kind: String) { self.url = url; self.platform = platform; self.kind = kind }
}

public enum MusicURLParser {
    private static func groups(_ value: String, _ pattern: String) -> [String]? {
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) else { return nil }
        return (1..<match.numberOfRanges).map { i in
            Range(match.range(at: i), in: value).map { String(value[$0]) } ?? ""
        }
    }

    public static func normalize(_ input: String) -> MusicURL? {
        guard input.count <= 2048, let components = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.user == nil, components.password == nil, components.port == nil,
              let host = components.host?.lowercased() else { return nil }
        let path = components.percentEncodedPath.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        func result(_ url: String, _ platform: String, _ kind: String) -> MusicURL { MusicURL(url: url, platform: platform, kind: kind) }
        if host == "open.spotify.com", let g = groups(path, "^/(?:intl-[a-z-]+/)?(track|album)/([A-Za-z0-9]{22})$") {
            return result("https://open.spotify.com/\(g[0])/\(g[1])", "Spotify", g[0])
        }
        if ["spotify.link", "spotify.app.link", "apple.co"].contains(host), groups(path, "^/([A-Za-z0-9_-]{3,100})$") != nil {
            return result("https://\(host)\(path)", "Music short link", "track")
        }
        if host == "music.apple.com", let g = groups(path, "^/[a-z]{2}/(album|song)/(?:[^/]+/)?([0-9]+)$") {
            let song = components.queryItems?.first(where: { $0.name == "i" })?.value
            if let song, groups(song, "^([0-9]+)$") == nil { return nil }
            return result("https://music.apple.com\(path)\(song.map { "?i=\($0)" } ?? "")", "Apple Music", song != nil || g[0] == "song" ? "track" : "album")
        }
        if groups(host, "^([a-z0-9-]+)\\.bandcamp\\.com$") != nil, let g = groups(path, "^/(track|album)/([A-Za-z0-9%_-]+)$") {
            return result("https://\(host)\(path)", "Bandcamp", g[0])
        }
        if ["deezer.com", "www.deezer.com"].contains(host), let g = groups(path, "^/(?:[a-z]{2}/)?(track|album)/([0-9]+)$") {
            return result("https://www.deezer.com/\(g[0])/\(g[1])", "Deezer", g[0])
        }
        if ["tidal.com", "www.tidal.com", "listen.tidal.com"].contains(host), let g = groups(path, "^/(?:browse/)?(track|album)/([0-9]+)$") {
            return result("https://tidal.com/browse/\(g[0])/\(g[1])", "Tidal", g[0])
        }
        if ["soundcloud.com", "www.soundcloud.com"].contains(host), groups(path, "^/([A-Za-z0-9_-]+/(?:sets/)?[A-Za-z0-9_-]+)$") != nil {
            return result("https://soundcloud.com\(path)", "SoundCloud", path.contains("/sets/") ? "album" : "track")
        }
        return nil
    }

    public static func extract(from text: String) -> [MusicURL] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        let links = detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            match.url.flatMap { normalize($0.absoluteString) }
        }
        return Array(Set(links)).sorted { $0.url < $1.url }
    }
}

// The only publish/export payload type. No message, chat, person, date or local
// database identifier can be encoded by this type.
public struct PublishPayload: Encodable, Sendable {
    public let urls: [String]
    public init(urls: [String]) { self.urls = Array(Set(urls.compactMap { MusicURLParser.normalize($0)?.url })).sorted() }
    public func json(pretty: Bool = false) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}
