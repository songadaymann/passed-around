import Foundation
import Security
import PassedAroundCore

struct CollectionConnection: Codable, Sendable {
    let collectionId: String
    let token: String
    let siteURL: String

    var baseURL: URL? {
        guard let url = URL(string: siteURL), let host = url.host, url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)),
              url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil else { return nil }
        return url
    }
    var valid: Bool { baseURL != nil && token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil && UUID(uuidString: collectionId) != nil }
}

enum SecureStorage {
    static let service = "org.passedaround.collection"
    static func read(account: String) -> CollectionConnection? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data,
              let connection = try? JSONDecoder().decode(CollectionConnection.self, from: data), connection.valid else { return nil }
        return connection
    }
    static func write(_ connection: CollectionConnection, account: String) throws {
        guard connection.valid else { throw ServiceError.invalidConnection }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let data = try JSONEncoder().encode(connection)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var insert = query; insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw ServiceError.keychain }
        } else if update != errSecSuccess { throw ServiceError.keychain }
    }
    static func remove(account: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
    }
}

enum ServiceError: Error, LocalizedError {
    case invalidConnection, keychain, server(String), redirect
    var errorDescription: String? {
        switch self {
        case .invalidConnection: return "Choose a valid HTTPS site and collection configuration."
        case .keychain: return "The collection key could not be saved in macOS Keychain."
        case .server(let message): return message
        case .redirect: return "The server redirected the request. No collection key was forwarded."
        }
    }
}

// Never forward a collection key on redirects to another host.
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum MusicService {
    private static let delegate = NoRedirect()
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil; config.timeoutIntervalForRequest = 25
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }()
    private struct ErrorBody: Decodable { let error: String }
    static func send(baseURL: URL, path: String, method: String, body: Data? = nil, token: String? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ServiceError.server("The server did not respond.") }
        guard !(300..<400).contains(response.statusCode) else { throw ServiceError.redirect }
        guard (200..<300).contains(response.statusCode) else {
            throw ServiceError.server((try? JSONDecoder().decode(ErrorBody.self, from: data).error) ?? "The server could not complete the request (\(response.statusCode)).")
        }
        return data
    }
    static func register(site: String, invite: String) async throws -> CollectionConnection {
        let dummy = CollectionConnection(collectionId: UUID().uuidString, token: String(repeating: "A", count: 43), siteURL: site)
        guard let base = dummy.baseURL else { throw ServiceError.invalidConnection }
        let body = try JSONSerialization.data(withJSONObject: ["invite": invite])
        let data = try await send(baseURL: base, path: "api/collections", method: "POST", body: body)
        let connection = try JSONDecoder().decode(CollectionConnection.self, from: data)
        guard connection.valid else { throw ServiceError.invalidConnection }
        return connection
    }
    static func publish(_ urls: [String], connection: CollectionConnection, progress: @MainActor (Int) -> Void) async throws {
        guard let base = connection.baseURL else { throw ServiceError.invalidConnection }
        for offset in stride(from: 0, to: urls.count, by: 10) {
            let batch = Array(urls[offset..<min(offset + 10, urls.count)])
            _ = try await send(baseURL: base, path: "api/shares", method: "POST", body: PublishPayload(urls: batch).json(), token: connection.token)
            await progress(offset + batch.count)
            // Stay below the pilot ingest limit. A retry is safe and idempotent.
            if offset + 10 < urls.count { try await Task.sleep(for: .milliseconds(2200)) }
        }
    }
    static func remove(connection: CollectionConnection) async throws {
        guard let base = connection.baseURL else { throw ServiceError.invalidConnection }
        _ = try await send(baseURL: base, path: "api/collection", method: "DELETE", token: connection.token)
    }
}
