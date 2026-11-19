import Foundation
import CSQLite
import PassedAroundCore

enum CheckFailure: Error { case failed(String, Int) }
func expect(_ value: @autoclosure () -> Bool, _ explanation: String = "Privacy check failed", line: Int = #line) throws {
    if !value() { throw CheckFailure.failed(explanation, line) }
}

struct PrivacyChecks {
    func testURLAllowlistAndTrackingRemoval() throws {
        let input = "Keep this private. https://example.com/private?secret=bad https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=secret https://youtu.be/dQw4w9WgXcQ?t=12"
        let result = MusicURLParser.extract(from: input)
        try expect(Set(result.map(\.url)) == ["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"])
        try expect(MusicURLParser.normalize("https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC") == nil)
        try expect(MusicURLParser.normalize("https://user:secret@open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC") == nil)
        try expect(MusicURLParser.normalize("https://open.spotify.com/playlist/4uLU6hMCjMI75M1A2tKUQC") == nil)
        try expect(MusicURLParser.normalize("file:///etc/passwd") == nil)
        try expect(MusicURLParser.normalize("https://music.apple.com/us/album/a-song/123?i=456&uo=4")?.url == "https://music.apple.com/us/album/a-song/123?i=456")
    }

    func testPublicationTypeCanEncodeOnlyCanonicalURLs() throws {
        let payload = PublishPayload(urls: ["https://youtu.be/dQw4w9WgXcQ?private=bad", "my friend said this", "https://example.com/private"])
        let object = try JSONSerialization.jsonObject(with: payload.json()) as! [String: Any]
        try expect(Set(object.keys) == ["urls"])
        try expect(object["urls"] as? [String] == ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"])
    }

    func testTypedStreamExtractsModernAttributedMessagesWithoutUnarchivingObjects() throws {
        let text = "PRIVATE SENTENCE https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=tracking"
        let data = NSArchiver.archivedData(withRootObject: NSAttributedString(string: text))
        let strings = try MessagesStore.strings(fromAttributedBody: data)
        try expect(strings.contains(where: { $0.contains("PRIVATE SENTENCE") }))
        try expect(strings.flatMap { MusicURLParser.extract(from: $0) }.first?.url == "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")
    }

    func testScanStaysInSelectedChatSkipsTapbacksAndDoesNotWriteDatabase() throws {
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        let file = temp.appendingPathComponent("chat.db")
        var db: OpaquePointer?
        try expect(sqlite3_open(file.path, &db) == SQLITE_OK)
        let sql = """
        CREATE TABLE chat(ROWID INTEGER PRIMARY KEY,display_name TEXT);
        CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);
        CREATE TABLE handle(ROWID INTEGER PRIMARY KEY,id TEXT);
        CREATE TABLE message(ROWID INTEGER PRIMARY KEY,text TEXT,attributedBody BLOB,date INTEGER,associated_message_type INTEGER DEFAULT 0,is_system_message INTEGER DEFAULT 0);
        CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
        INSERT INTO chat VALUES(1,'LOCAL PRIVATE NAME'),(2,'OTHER PRIVATE CHAT');
        INSERT INTO chat_handle_join VALUES(1,1),(1,2),(1,3);
        INSERT INTO handle VALUES(1,'PRIVATE-PERSON@example.test'),(2,'OTHER-PERSON@example.test'),(3,'ANOTHER-PERSON@example.test');
        INSERT INTO message(ROWID,text,date) VALUES
          (1,'NEVER UPLOAD THIS https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=secret',816000000000000000),
          (2,'Repeat https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',816000000000000001),
          (3,'OTHER CHAT https://youtu.be/dQw4w9WgXcQ',816000000000000002),
          (4,'Liked https://youtu.be/dQw4w9WgXcQ',816000000000000003);
        UPDATE message SET associated_message_type=2001 WHERE ROWID=4;
        INSERT INTO chat_message_join VALUES(1,1),(1,2),(2,3),(1,4);
        """
        try expect(sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(db)
        let before = try Data(contentsOf: file)
        let store = try MessagesStore(databaseURL: file)
        let chats = try store.chats()
        try expect(chats.first(where: { $0.id == 1 })?.participants == 4)
        try expect(chats.first(where: { $0.id == 1 })?.participantsLocal.contains("PRIVATE-PERSON") == true)
        let result = try store.scan(chatID: 1)
        try expect(result.scannedMessages == 2)
        try expect(result.links.count == 1)
        try expect(result.links.first?.occurrences == 2)
        let exported = try PublishPayload(urls: result.links.map(\.id)).json(pretty: true)
        let text = String(decoding: exported, as: UTF8.self)
        try expect(!text.contains("PRIVATE")); try expect(!text.contains("NEVER")); try expect(!text.contains("secret")); try expect(!text.contains("dQw4w9WgXcQ"))
        let after = try Data(contentsOf: file)
        try expect(before == after)
    }
}

let checks = PrivacyChecks()
try checks.testURLAllowlistAndTrackingRemoval()
try checks.testPublicationTypeCanEncodeOnlyCanonicalURLs()
try checks.testTypedStreamExtractsModernAttributedMessagesWithoutUnarchivingObjects()
try checks.testScanStaysInSelectedChatSkipsTapbacksAndDoesNotWriteDatabase()
print("Passed 4 native privacy checks: URL allowlist, payload boundary, typedstream decoding, selected-chat read-only scan.")
