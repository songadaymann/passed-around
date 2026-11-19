import AppKit
import SwiftUI
import UniformTypeIdentifiers
import PassedAroundCore
import Darwin

@MainActor final class AppModel: ObservableObject {
    @Published var chats: [ChatSummary] = []
    @Published var selectedChat: ChatSummary? { didSet { if oldValue?.id != selectedChat?.id { clearScan(); loadConnection() } } }
    @Published var scan: ScanResult?
    @Published var selectedURLs: Set<String> = []
    @Published var busy = false
    @Published var publishing = false
    @Published var status = "Connect Messages to get started."
    @Published var error: String?
    @Published var demo = false
    @Published var connected = false
    @Published var groupOnly = true
    @Published var chatSearch = ""
    @Published var linkSearch = ""
    @Published var autoScan = false
    @Published var connection: CollectionConnection?
    @Published var hasPilotConnection = false
    @Published var siteURL = "https://passed-around.novox-robot.workers.dev"
    @Published var invitation = ""
    @Published var connecting = false
    @Published var publishedCount = 0
    @Published var titles: [String: String] = [:]
    @Published var loadingTitles = false
    private var folder: URL?
    private var scope: URL?
    private var generation = UUID()
    private var watcher: Task<Void, Never>?
    private let preferences = UserDefaults.standard

    var visibleChats: [ChatSummary] {
        chats.filter { (!groupOnly || $0.participants > 2) && (chatSearch.isEmpty || $0.displayName.localizedCaseInsensitiveContains(chatSearch)) }
    }
    var visibleLinks: [FoundMusicLink] { (scan?.links ?? []).filter { linkSearch.isEmpty || $0.music.url.localizedCaseInsensitiveContains(linkSearch) || $0.music.platform.localizedCaseInsensitiveContains(linkSearch) } }
    var payloadPreview: String { String(data: (try? PublishPayload(urls: Array(selectedURLs)).json(pretty: true)) ?? Data(), encoding: .utf8) ?? "" }
    var account: String? {
        guard let selectedChat, let folder else { return nil }
        // This lookup key stays on this Mac; it is never sent to the server.
        return "\(folder.path):chat:\(selectedChat.id)"
    }

    func launch() async {
        if CommandLine.arguments.contains("--demo") { await loadDemo(); return }
        if let data = preferences.data(forKey: "messagesFolderBookmark") {
            var stale = false
            do {
                let restored = try URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
                scope = restored; _ = restored.startAccessingSecurityScopedResource()
                await load(folder: restored, isDemo: false)
            } catch { self.error = "Select your Messages folder again to restore access." }
        }
        hasPilotConnection = SecureStorage.read(account: "pending") != nil
        watcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { break }
                if let self, self.autoScan, !self.busy, !self.publishing, self.selectedChat != nil { await self.scanSelected(keepSelection: true) }
            }
        }
    }

    func chooseFolder() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
        let actualHome = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        panel.allowsMultipleSelection = false; panel.directoryURL = URL(fileURLWithPath: actualHome).appendingPathComponent("Library/Messages")
        panel.title = "Choose your Messages folder"
        panel.message = "Select Library/Messages. If needed, press Shift–Command–G and enter ~/Library/Messages. Message text stays on your Mac; the database is read-only."
        panel.prompt = "Connect Messages"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        scope?.stopAccessingSecurityScopedResource(); scope = url
        _ = url.startAccessingSecurityScopedResource()
        do {
            let bookmark = try url.bookmarkData(options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess], includingResourceValuesForKeys: nil, relativeTo: nil)
            preferences.set(bookmark, forKey: "messagesFolderBookmark")
        } catch { self.error = "The folder could not be remembered. You can still use it for this session." }
        Task { await load(folder: url, isDemo: false) }
    }

    func load(folder: URL, isDemo: Bool) async {
        guard !publishing else { return }
        generation = UUID(); busy = true; error = nil; demo = isDemo; autoScan = false
        selectedChat = nil; clearScan(); chats = []; connected = false; self.folder = folder
        let databaseURL = folder.appendingPathComponent(isDemo ? "demo-chat.db" : "chat.db")
        do {
            let summaries = try await Task.detached(priority: .userInitiated) { try MessagesStore(databaseURL: databaseURL).chats() }.value
            chats = summaries; connected = true
            status = isDemo ? "Sample data only. No private messages have been opened." : "Connected locally. Choose a conversation to scan."
        } catch { self.error = error.localizedDescription; status = "Messages access needs your permission." }
        busy = false
    }

    func loadDemo() async {
        guard let url = Bundle.main.url(forResource: "demo-chat", withExtension: "db") ?? Bundle.module.url(forResource: "demo-chat", withExtension: "db") else { error = "Sample chat is missing from this build."; return }
        await load(folder: url.deletingLastPathComponent(), isDemo: true)
        // The packaged fixture uses its explicit filename, never the user's DB.
        if let first = chats.first(where: { $0.id == 1 }) ?? chats.first { selectedChat = first; await scanSelected() }
    }

    func clearScan() {
        generation = UUID(); scan = nil; selectedURLs = []; linkSearch = ""; publishedCount = 0
    }

    func scanSelected(keepSelection: Bool = false) async {
        guard let selectedChat, let folder, !busy, !publishing else { return }
        let marker = UUID(); generation = marker; busy = true; error = nil
        let previous = selectedURLs; let previousKnown = Set(scan?.links.map(\.id) ?? [])
        let url = folder.appendingPathComponent(demo ? "demo-chat.db" : "chat.db")
        status = "Looking for music links in this conversation, on your Mac…"
        do {
            let id = selectedChat.id
            let result = try await Task.detached(priority: .userInitiated) { try MessagesStore(databaseURL: url).scan(chatID: id) }.value
            guard generation == marker else { busy = false; return }
            scan = result
            // New discoveries are not selected or uploaded by the background watcher.
            selectedURLs = keepSelection ? previous.intersection(Set(result.links.map(\.id))) : []
            let newCount = Set(result.links.map(\.id)).subtracting(previousKnown).count
            status = keepSelection ? "\(newCount) new music links found. Review before publishing." : "\(result.links.count) music links found. Nothing has been uploaded."
        } catch { self.error = error.localizedDescription }
        busy = false
    }

    private func loadConnection() {
        connection = !demo ? account.flatMap { SecureStorage.read(account: $0) } : nil
        hasPilotConnection = !demo && SecureStorage.read(account: "pending") != nil
        if let connection { siteURL = connection.siteURL }
    }

    func usePilotConnection() {
        guard !demo, let account, let pending = SecureStorage.read(account: "pending") else { return }
        do {
            try SecureStorage.write(pending, account: account)
            SecureStorage.remove(account: "pending"); connection = pending; hasPilotConnection = false
            status = "Your pilot collection is connected to this chat. Publishing is still a separate action."
        } catch { self.error = error.localizedDescription }
    }

    func register() async {
        guard !demo, let account, !connecting else { return }
        connecting = true; error = nil
        do {
            let value = try await MusicService.register(site: siteURL.trimmingCharacters(in: .whitespacesAndNewlines), invite: invitation)
            try SecureStorage.write(value, account: account); connection = value; invitation = ""
            status = "Anonymous collection connected. Review your selection before publishing."
        } catch { self.error = error.localizedDescription }
        connecting = false
    }

    func importConnection() {
        guard !demo, let account else { return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.title = "Import a collection connection"
        panel.message = "This file contains a secret collection key. It will be stored in macOS Keychain."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url); guard data.count < 10_000 else { throw ServiceError.invalidConnection }
            let value = try JSONDecoder().decode(CollectionConnection.self, from: data)
            try SecureStorage.write(value, account: account); connection = value; siteURL = value.siteURL
            status = "Collection connected. No music has been published yet."
        } catch { self.error = error.localizedDescription }
    }

    func publish() async {
        guard !demo, let connection, !selectedURLs.isEmpty, !publishing else { return }
        publishing = true; error = nil; publishedCount = 0
        let urls = Array(selectedURLs).sorted()
        do {
            try await MusicService.publish(urls, connection: connection) { [weak self] count in self?.publishedCount = count }
            status = "\(urls.count) selected links published. The site is finding listening links in the background."
            selectedURLs = []
        } catch { self.error = "\(error.localizedDescription) \(publishedCount) links were accepted. Retrying the same links is safe." }
        publishing = false
    }

    func export() {
        guard !selectedURLs.isEmpty else { return }
        // Save inside our own sandbox and reveal in Finder. This preserves the
        // user-selected READ-ONLY entitlement for Messages access; an NSSavePanel
        // would require broadening that entitlement to read-write.
        do {
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Passed Around/Exports", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
            let url = directory.appendingPathComponent("music-links-\(stamp).json")
            try PublishPayload(urls: Array(selectedURLs)).json(pretty: true).write(to: url, options: .atomic)
            NSWorkspace.shared.activateFileViewerSelecting([url])
            status = "Selected music links exported locally. Finder shows the JSON file."
        }
        catch { self.error = error.localizedDescription }
    }

    func loadTitles() async {
        guard !loadingTitles else { return }
        loadingTitles = true
        let links = (scan?.links ?? []).filter { selectedURLs.contains($0.id) && titles[$0.id] == nil }.prefix(100)
        for link in links {
            if let title = await MusicTitles.fetch(link.music) { titles[link.id] = title }
        }
        loadingTitles = false
        status = "Titles loaded from music providers. No message text or chat details were sent."
    }

    func removeCollection() async {
        guard let connection, let account, !publishing else { return }
        publishing = true; error = nil
        do {
            try await MusicService.remove(connection: connection); SecureStorage.remove(account: account); self.connection = nil
            status = "This collection’s public contributions and key have been removed. Your local scan is unchanged."
        } catch { self.error = error.localizedDescription }
        publishing = false
    }

    func disconnectMessages() {
        guard !busy, !publishing else { return }
        autoScan = false; generation = UUID(); selectedChat = nil; chats = []; clearScan(); connected = false
        folder = nil; scope?.stopAccessingSecurityScopedResource(); scope = nil
        preferences.removeObject(forKey: "messagesFolderBookmark")
        status = "Messages disconnected. Existing public contributions can be removed after reconnecting the same chat."
    }

    func openPrivacySettings() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!) }
    func openSite() { NSWorkspace.shared.open(connection?.baseURL ?? URL(string: "https://passed-around.novox-robot.workers.dev")!) }
}
