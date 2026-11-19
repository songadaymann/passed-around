import Foundation
import CSQLite
import TypedStream

public struct ChatSummary: Identifiable, Hashable, Sendable {
    public let id: Int64
    public let name: String
    public let participants: Int
    public let messageCount: Int
    public let latest: Date?
    public let participantsLocal: String
    public var displayName: String { name.isEmpty ? (participantsLocal.isEmpty ? "Conversation \(id)" : participantsLocal) : name }
}

public struct FoundMusicLink: Identifiable, Hashable, Sendable {
    public var id: String { music.url }
    public let music: MusicURL
    public var occurrences: Int
    public var lastShared: Date?
}

public struct ScanResult: Sendable {
    public let links: [FoundMusicLink]
    public let scannedMessages: Int
    public let undecodedMessages: Int
}

public enum MessagesError: Error, LocalizedError {
    case permission, database(String), invalidDatabase
    public var errorDescription: String? {
        switch self {
        case .permission: return "macOS hasn’t granted access to Messages. Select your Messages folder, or allow Passed Around in System Settings → Privacy & Security → Full Disk Access. Then quit and reopen the app."
        case .database(let message): return "Messages could not be read: \(message)"
        case .invalidDatabase: return "This folder doesn’t contain a readable Messages chat.db database."
        }
    }
}

public final class MessagesStore {
    private var database: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    public init(databaseURL: URL) throws {
        guard FileManager.default.fileExists(atPath: databaseURL.path) else { throw MessagesError.permission }
        // READONLY is deliberate. Never copy the private database or attach files.
        let result = sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil)
        if result != SQLITE_OK {
            if let database { sqlite3_close(database) }; database = nil
            throw MessagesError.permission
        }
        sqlite3_busy_timeout(database, 3000)
        let fields = try columns(in: "message")
        guard fields.contains("text"), fields.contains("date") else {
            if let database { sqlite3_close(database) }; database = nil
            throw MessagesError.invalidDatabase
        }
    }
    deinit { if let database { sqlite3_close(database) } }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw MessagesError.database(String(cString: sqlite3_errmsg(database)))
        }
        return statement
    }
    private func text(_ statement: OpaquePointer, _ index: Int32) -> String {
        guard let pointer = sqlite3_column_text(statement, index) else { return "" }
        return String(cString: pointer)
    }
    private func columns(in table: String) throws -> Set<String> {
        // Only literal internal table names are passed here.
        let statement = try prepare("PRAGMA table_info(\(table))"); defer { sqlite3_finalize(statement) }
        var names: Set<String> = []
        while sqlite3_step(statement) == SQLITE_ROW { names.insert(text(statement, 1)) }
        return names
    }
    private func appleDate(_ value: Double) -> Date? {
        guard value > 0 else { return nil }
        return Date(timeIntervalSinceReferenceDate: value > 1_000_000_000_000 ? value / 1_000_000_000 : value)
    }

    public func chats() throws -> [ChatSummary] {
        let hasHandles = try columns(in: "handle").contains("id")
        let localParticipants = hasHandles ? "(SELECT GROUP_CONCAT(h.id, ', ') FROM handle h JOIN chat_handle_join p ON p.handle_id=h.ROWID WHERE p.chat_id=c.ROWID)" : "''"
        let statement = try prepare("""
        SELECT c.ROWID,COALESCE(c.display_name,''),
          (SELECT COUNT(*) FROM chat_handle_join h WHERE h.chat_id=c.ROWID),
          COUNT(m.ROWID),MAX(m.date),\(localParticipants)
        FROM chat c LEFT JOIN chat_message_join j ON j.chat_id=c.ROWID
        LEFT JOIN message m ON m.ROWID=j.message_id
        GROUP BY c.ROWID ORDER BY MAX(m.date) DESC
        """)
        defer { sqlite3_finalize(statement) }
        var result: [ChatSummary] = []; var code: Int32
        repeat {
            code = sqlite3_step(statement)
            if code == SQLITE_ROW {
                result.append(ChatSummary(id: sqlite3_column_int64(statement, 0), name: text(statement, 1), participants: Int(sqlite3_column_int64(statement, 2)) + 1, messageCount: Int(sqlite3_column_int64(statement, 3)), latest: appleDate(sqlite3_column_double(statement, 4)), participantsLocal: text(statement, 5)))
            }
        } while code == SQLITE_ROW
        guard code == SQLITE_DONE else { throw MessagesError.database("The chat list could not be read.") }
        return result
    }

    public static func strings(fromAttributedBody data: Data) throws -> [String] {
        guard data.count <= 2_000_000 else { return [] }
        // Pure Swift decoding; never instantiate arbitrary archived Obj-C objects.
        let items = try TypedStreamDecoder.decode(data)
        return items.flatMap { item -> [String] in
            let values: [TypedStream.Object]
            switch item {
            case .object(_, let objects), .data(let objects): values = objects
            default: return []
            }
            return values.compactMap { if case .string(let value) = $0 { return value }; return nil }
        }
    }

    public func scan(chatID: Int64) throws -> ScanResult {
        let fields = try columns(in: "message")
        let body = fields.contains("attributedBody") ? "m.attributedBody" : "NULL"
        var filters = ["j.chat_id=?"]
        if fields.contains("associated_message_type") { filters.append("COALESCE(m.associated_message_type,0)<2000") }
        if fields.contains("is_system_message") { filters.append("COALESCE(m.is_system_message,0)=0") }
        let statement = try prepare("SELECT m.text,\(body),m.date FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID WHERE \(filters.joined(separator: " AND ")) ORDER BY m.date")
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, chatID)
        var found: [String: FoundMusicLink] = [:]; var scanned = 0; var undecoded = 0; var code: Int32
        repeat {
            code = sqlite3_step(statement)
            if code == SQLITE_ROW {
                scanned += 1
                // The message strings exist only for this iteration. They are
                // never persisted, printed, encoded, sent to an AI, or uploaded.
                var strings = [text(statement, 0)]
                if let pointer = sqlite3_column_blob(statement, 1) {
                    let bytes = Int(sqlite3_column_bytes(statement, 1))
                    if bytes > 0 {
                        do { strings += try Self.strings(fromAttributedBody: Data(bytes: pointer, count: bytes)) }
                        catch { if strings[0].isEmpty { undecoded += 1 } }
                    }
                }
                let date = appleDate(sqlite3_column_double(statement, 2))
                let links = Set(strings.flatMap { MusicURLParser.extract(from: $0) })
                for link in links {
                    if var existing = found[link.url] { existing.occurrences += 1; existing.lastShared = date ?? existing.lastShared; found[link.url] = existing }
                    else { found[link.url] = FoundMusicLink(music: link, occurrences: 1, lastShared: date) }
                }
            }
        } while code == SQLITE_ROW
        guard code == SQLITE_DONE else { throw MessagesError.database("The selected conversation could not be fully read.") }
        return ScanResult(links: found.values.sorted { ($0.lastShared ?? .distantPast) > ($1.lastShared ?? .distantPast) }, scannedMessages: scanned, undecodedMessages: undecoded)
    }
}
