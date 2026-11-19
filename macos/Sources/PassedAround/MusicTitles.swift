import Foundation
import PassedAroundCore

enum MusicTitles {
    static func fetch(_ music: MusicURL) async -> String? {
        guard let original = URL(string: music.url) else { return nil }
        let endpoint: String
        switch music.platform {
        case "Spotify": endpoint = "https://open.spotify.com/oembed?url=\(music.url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
        case "Apple Music":
            let components = URLComponents(url: original, resolvingAgainstBaseURL: false)
            let id = components?.queryItems?.first(where: { $0.name == "i" })?.value ?? original.lastPathComponent
            endpoint = "https://itunes.apple.com/lookup?id=\(id)&country=US"
            // Apple documents approximately 20 requests/minute for this API.
            try? await Task.sleep(for: .milliseconds(3100))
        default: return nil
        }
        guard let url = URL(string: endpoint) else { return nil }
        // Direct provider lookup is an explicit action. No Passed Around server
        // is contacted, and only an already-extracted music URL is used.
        do {
            let config = URLSessionConfiguration.ephemeral; config.urlCache = nil; config.httpCookieStorage = nil
            let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: url); request.timeoutInterval = 6
            let (data, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200, data.count < 200_000,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            if let results = object["results"] as? [[String: Any]], let item = results.first,
               let name = (item["trackName"] ?? item["collectionName"]) as? String {
                let artist = item["artistName"] as? String ?? ""
                return String("\(name)\(artist.isEmpty ? "" : " · \(artist)")".prefix(300))
            }
            return (object["title"] as? String).map { String($0.prefix(300)) }
        } catch { return nil }
    }
}
