import SwiftUI
import AppKit
import PassedAroundCore

@main enum EntryPoint {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--pair-stdin") {
            do {
                let data = FileHandle.standardInput.readDataToEndOfFile()
                guard data.count < 16_000 else { throw ServiceError.invalidConnection }
                let value = try JSONDecoder().decode(CollectionConnection.self, from: data)
                try SecureStorage.write(value, account: "pending")
                FileHandle.standardOutput.write(Data("Pilot connection saved in macOS Keychain. No music was published.\n".utf8))
                return
            } catch { FileHandle.standardError.write(Data("Could not save pilot connection: \(error.localizedDescription)\n".utf8)); exit(1) }
        }
        PassedAroundApp.main()
    }
}

struct PassedAroundApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup("Passed Around") {
            ContentView().environmentObject(model).preferredColorScheme(.light).frame(minWidth: 1080, minHeight: 730).task { await model.launch() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 820)
        .commands { CommandGroup(replacing: .newItem) { Button("Connect Messages…") { model.chooseFolder() }.keyboardShortcut("o") } }
    }
}

private let ink = Color(red: 0.13, green: 0.15, blue: 0.11)
private let paper = Color(red: 0.98, green: 0.985, blue: 0.965)
private let lime = Color(red: 0.84, green: 0.96, blue: 0.28)

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @State private var showPayload = false
    @State private var showPrivacy = false
    @State private var confirmPublish = false
    @State private var confirmRemoval = false
    var body: some View {
        VStack(spacing: 0) {
            header
            HSplitView {
                sidebar.frame(minWidth: 245, idealWidth: 270, maxWidth: 300)
                VStack(alignment: .leading, spacing: 0) {
                    if model.demo { Label("SAMPLE CHAT · No private messages opened. Publishing is disabled.", systemImage: "sparkles").font(.system(size: 12, weight: .medium)).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.purple.opacity(0.12)) }
                    if let error = model.error {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                            Text(error).font(.system(size: 13)).textSelection(.enabled)
                            Spacer(minLength: 5)
                            Button { model.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss error")
                        }.padding(14).background(Color.orange.opacity(0.08))
                    }
                    if !model.connected { welcome }
                    else if let chat = model.selectedChat { review(chat) }
                    else { chooseChat }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).background(paper)
            }
            HStack(spacing: 8) {
                Image(systemName: "lock.shield").foregroundStyle(.green)
                Text(model.status).lineLimit(2).font(.system(size: 12))
                Spacer()
                if model.busy || model.publishing || model.connecting || model.loadingTitles { ProgressView().controlSize(.small) }
                Text("v0.1.0 · Open source").font(.system(size: 11)).foregroundStyle(.secondary)
            }.padding(.horizontal, 20).padding(.vertical, 11).background(Color.white)
        }.foregroundStyle(ink).tint(ink)
        .sheet(isPresented: $showPayload) { payloadSheet }
        .sheet(isPresented: $showPrivacy) { privacySheet }
        .confirmationDialog("Publish \(model.selectedURLs.count) selected music links?", isPresented: $confirmPublish, titleVisibility: .visible) {
            Button("Publish music links") { Task { await model.publish() } }
            Button("Cancel", role: .cancel) { }
        } message: { Text("These songs will appear publicly on \(model.connection?.siteURL ?? "your site"). No chat names, participants, messages, or original message dates are sent. Publish only music your group is comfortable contributing.") }
        .confirmationDialog("Remove this collection’s public contributions?", isPresented: $confirmRemoval, titleVisibility: .visible) {
            Button("Remove collection", role: .destructive) { Task { await model.removeCollection() } }
        } message: { Text("This removes this collection’s contributions and revokes its key. Songs contributed by other groups remain. Your Messages database is never changed.") }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "opticaldisc.fill").font(.system(size: 31)).foregroundStyle(ink).background(lime, in: Circle())
            VStack(alignment: .leading, spacing: 0) { Text("passed around").font(.system(size: 23, weight: .bold, design: .rounded)); Text("Good music travels between friends.").font(.system(size: 11)).foregroundStyle(.secondary) }
            Spacer()
            Button("How privacy works") { showPrivacy = true }.buttonStyle(.borderless)
            Button { model.openSite() } label: { Label("Open listening room", systemImage: "safari") }.buttonStyle(.bordered)
        }.padding(.horizontal, 24).padding(.top, 32).padding(.bottom, 20).background(paper)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack { Text("ON THIS MAC").font(.system(size: 10, weight: .bold)).tracking(1.5); Spacer(); if model.connected { Image(systemName: "checkmark.shield.fill").foregroundStyle(.green) } }
            Button { model.chooseFolder() } label: { Label(model.connected && !model.demo ? "Reconnect Messages…" : "Connect Messages…", systemImage: "message") }.buttonStyle(.bordered).disabled(model.busy || model.publishing)
            if model.connected {
                Divider()
                Text("CONVERSATIONS").font(.system(size: 10, weight: .bold)).tracking(1.3)
                TextField("Find a conversation", text: $model.chatSearch).textFieldStyle(.roundedBorder)
                Toggle("Group conversations only", isOn: $model.groupOnly).font(.system(size: 12)).toggleStyle(.checkbox)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 5) {
                        ForEach(model.visibleChats) { chat in
                            Button { model.selectedChat = chat } label: {
                                HStack(alignment: .top, spacing: 9) {
                                    Image(systemName: "person.2.circle.fill").font(.system(size: 21)).foregroundStyle(model.selectedChat == chat ? ink : Color.gray)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(chat.displayName).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                                        Text("\(chat.participants) people · \(chat.messageCount.formatted()) messages").font(.system(size: 11)).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 0)
                                }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(model.selectedChat == chat ? lime.opacity(0.65) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                            }.buttonStyle(.plain).disabled(model.busy || model.publishing)
                        }
                    }
                }
                if model.visibleChats.isEmpty { Text("No matching conversations. Turn off the group filter to see one-to-one chats.").font(.system(size: 12)).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 8) {
                Label("Messages are read-only.", systemImage: "lock.fill").font(.system(size: 12, weight: .medium))
                Text("Conversation names and participant counts stay on this Mac.").font(.system(size: 11)).foregroundStyle(.secondary)
                if model.connected { Button("Disconnect Messages") { model.disconnectMessages() }.font(.system(size: 11)).buttonStyle(.borderless).disabled(model.busy || model.publishing) }
            }.padding(13).background(Color.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
        }.padding(18).frame(maxHeight: .infinity).background(Color(red: 0.94, green: 0.95, blue: 0.915))
    }

    private var welcome: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("JUST THE MUSIC.").font(.system(size: 11, weight: .bold)).tracking(2)
                Text("There’s a great collection\nhiding in your group chat.").font(.system(size: 39, weight: .bold)).tracking(-1.4).fixedSize(horizontal: false, vertical: true)
                Text("Find the songs you’ve been sending each other. Keep the conversation on your Mac.").font(.system(size: 17)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 16) {
                    step("1", "Connect Messages", "Select your Library/Messages folder. macOS may also ask for Full Disk Access.")
                    step("2", "Choose one conversation", "Only the selected conversation’s message contents are examined.")
                    step("3", "Review before publishing", "Keep it local, export music links, or publish selected URLs to the listening room.")
                }.padding(23).background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                HStack(spacing: 17) {
                    Button("Connect Messages…") { model.chooseFolder() }.buttonStyle(.borderedProminent).controlSize(.large)
                    Button("Try a sample chat") { Task { await model.loadDemo() } }.buttonStyle(.borderless)
                }.disabled(model.busy)
                Button("Open Full Disk Access settings") { model.openPrivacySettings() }.buttonStyle(.borderless).font(.system(size: 12))
                Text("No account is needed to scan. Publishing to the pilot site requires a collection connection. The app never changes your messages.").font(.system(size: 12)).foregroundStyle(.secondary)
            }.padding(45).frame(maxWidth: 780, alignment: .leading)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func step(_ number: String, _ title: String, _ description: String) -> some View {
        HStack(alignment: .top, spacing: 13) {
            Text(number).font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 24).background(lime, in: Circle())
            VStack(alignment: .leading, spacing: 3) { Text(title).font(.system(size: 14, weight: .semibold)); Text(description).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
    }

    private var chooseChat: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.2.wave.2").font(.system(size: 48)).foregroundStyle(.secondary)
            Text("Which conversation has the good stuff?").font(.system(size: 26, weight: .bold)).tracking(-0.8)
            Text("Choose one from the sidebar. Scanning won’t start until you ask.").font(.system(size: 14)).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(35)
    }

    private func review(_ chat: ChatSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text("YOUR CONVERSATION · LOCAL ONLY").font(.system(size: 10, weight: .bold)).tracking(1.5)
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(chat.displayName).font(.system(size: 29, weight: .bold)).tracking(-0.9).lineLimit(2)
                        Text("\(chat.participants) people · \(chat.messageCount.formatted()) messages on this Mac").font(.system(size: 13)).foregroundStyle(.secondary)
                        if !chat.participantsLocal.isEmpty { Text(chat.participantsLocal).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled) }
                    }
                    Spacer()
                    Button { Task { await model.scanSelected(keepSelection: model.scan != nil) } } label: { Label(model.scan == nil ? "Find music links" : "Scan again", systemImage: "magnifyingglass") }.buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy || model.publishing)
                }
                Toggle("Check this conversation every minute (review still required)", isOn: $model.autoScan).toggleStyle(.checkbox).font(.system(size: 12)).disabled(model.demo)
            }.padding(25)
            Divider()
            if let scan = model.scan {
                HStack(spacing: 15) {
                    Text("\(scan.links.count) music links").font(.system(size: 15, weight: .semibold))
                    Text("\(model.selectedURLs.count) selected").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Select all") { model.selectedURLs = Set(scan.links.map(\.id)) }.buttonStyle(.borderless)
                    Button("Clear") { model.selectedURLs = [] }.buttonStyle(.borderless)
                    TextField("Filter links", text: $model.linkSearch).textFieldStyle(.roundedBorder).frame(width: 160)
                }.padding(.horizontal, 25).padding(.vertical, 15).disabled(model.publishing)
                if scan.undecodedMessages > 0 { Text("\(scan.undecodedMessages) messages used an unreadable text format and were skipped. The scan may be incomplete.").font(.system(size: 12)).foregroundStyle(.orange).padding(.horizontal, 25).padding(.bottom, 10) }
                if scan.links.isEmpty { VStack(spacing: 12) { Image(systemName: "music.note").font(.system(size: 38)); Text("No supported music links found yet.").font(.system(size: 20, weight: .semibold)); Text("Spotify, Apple Music, YouTube, Bandcamp, Deezer, Tidal and SoundCloud links are supported. Playlists and artist profiles are skipped.").font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center) }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(35) }
                else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(model.visibleLinks) { link in linkRow(link); Divider().padding(.leading, 66) }
                        }
                    }
                }
                HStack {
                    Button(model.loadingTitles ? "Loading titles…" : "Load selected song titles") { Task { await model.loadTitles() } }.buttonStyle(.borderless).disabled(model.selectedURLs.isEmpty || model.loadingTitles || model.publishing)
                    Text("Optional · contacts music providers directly").font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    Button("Preview upload JSON") { showPayload = true }.buttonStyle(.borderless).disabled(model.selectedURLs.isEmpty)
                }.font(.system(size: 12)).padding(.horizontal, 25).padding(.vertical, 12)
            } else { VStack(spacing: 13) { Image(systemName: "music.note.list").font(.system(size: 44)).foregroundStyle(.secondary); Text("Find the music. Keep the conversation.").font(.system(size: 22, weight: .semibold)); Text("The scan runs locally. Nothing is uploaded.").font(.system(size: 14)).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(35) }
            Divider()
            publishingPanel
        }
    }

    private func linkRow(_ link: FoundMusicLink) -> some View {
        HStack(spacing: 13) {
            Toggle("Select \(link.music.platform) link", isOn: Binding(get: { model.selectedURLs.contains(link.id) }, set: { if $0 { model.selectedURLs.insert(link.id) } else { model.selectedURLs.remove(link.id) } })).labelsHidden().toggleStyle(.checkbox).disabled(model.publishing)
            Image(systemName: link.music.kind == "album" ? "square.stack.fill" : link.music.kind == "video" ? "play.rectangle.fill" : "music.note").font(.system(size: 21)).frame(width: 38, height: 42).background(link.music.platform == "Bandcamp" ? Color.purple.opacity(0.17) : lime.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 5) {
                Text(model.titles[link.id] ?? defaultTitle(link)).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                Text(link.music.url).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Text("\(link.music.platform) · \(link.music.kind.capitalized) · \(link.occurrences) share\(link.occurrences == 1 ? "" : "s")\(link.lastShared.map { " · \($0.formatted(date: .abbreviated, time: .omitted))" } ?? "")").font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 3)
            Button { if let url = URL(string: link.music.url) { NSWorkspace.shared.open(url) } } label: { Image(systemName: "safari") }.buttonStyle(.borderless).help("Open this music link")
        }.padding(.horizontal, 25).padding(.vertical, 13)
    }

    private func defaultTitle(_ link: FoundMusicLink) -> String {
        if link.music.platform == "Bandcamp", let url = URL(string: link.music.url) { return url.lastPathComponent.replacingOccurrences(of: "-", with: " ").capitalized }
        return "\(link.music.platform) \(link.music.kind)"
    }

    private var publishingPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.connection == nil && !model.demo && model.selectedChat != nil {
                if model.hasPilotConnection {
                    HStack { VStack(alignment: .leading, spacing: 4) { Text("Your pilot connection is ready.").font(.system(size: 14, weight: .semibold)); Text("Attach it to this conversation. No music is published yet.").font(.system(size: 12)).foregroundStyle(.secondary) }; Spacer(); Button("Connect this chat") { model.usePilotConnection() }.buttonStyle(.borderedProminent) }
                } else {
                    Text("Connect a collection to publish (optional)").font(.system(size: 13, weight: .semibold))
                    HStack { TextField("Site URL", text: $model.siteURL).textFieldStyle(.roundedBorder); SecureField("Pilot invitation", text: $model.invitation).textFieldStyle(.roundedBorder).frame(width: 150); Button("Connect") { Task { await model.register() } }.disabled(model.invitation.isEmpty || model.connecting); Button("Import key…") { model.importConnection() }.buttonStyle(.borderless) }.font(.system(size: 12))
                }
            }
            HStack(spacing: 13) {
                VStack(alignment: .leading, spacing: 3) { Label("Only selected music URLs leave your Mac.", systemImage: "lock.shield").font(.system(size: 12, weight: .semibold)); Text(model.demo ? "Sample mode: publishing is disabled." : "No messages, names, contacts or original message dates.").font(.system(size: 11)).foregroundStyle(.secondary) }
                Spacer()
                Button("Export locally…") { model.export() }.buttonStyle(.bordered).disabled(model.selectedURLs.isEmpty || model.publishing)
                Button(model.publishing ? "Publishing \(model.publishedCount)…" : "Publish selected links") { confirmPublish = true }.buttonStyle(.borderedProminent).disabled(model.demo || model.connection == nil || model.selectedURLs.isEmpty || model.publishing)
            }
            if model.connection != nil {
                HStack { Text("Collection key stored in macOS Keychain.").font(.system(size: 11)).foregroundStyle(.secondary); Spacer(); Button("Remove public contributions…") { confirmRemoval = true }.font(.system(size: 11)).buttonStyle(.borderless).disabled(model.publishing) }
            }
        }.padding(20).background(Color.white.opacity(0.8))
    }

    private var payloadSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Exactly what will be sent").font(.title2.bold())
            Text("POST /api/shares · authenticated with a random collection key. The body below contains only selected, cleaned music URLs.").font(.system(size: 13)).foregroundStyle(.secondary)
            ScrollView { Text(model.payloadPreview).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(15) }.background(Color.gray.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            HStack { Text("Your chat name, messages and participants are absent.").font(.system(size: 12)); Spacer(); Button("Done") { showPayload = false }.keyboardShortcut(.defaultAction) }
        }.padding(25).frame(width: 680, height: 500)
    }

    private var privacySheet: some View {
        VStack(alignment: .leading, spacing: 17) {
            Text("The music leaves. The conversation stays.").font(.title2.bold())
            Text("Messages access is broader than one conversation. After you grant access, this app restricts message-content scanning to your selected chat. It uses a read-only database connection and never copies your Messages database.")
            Text("Scanning does not use the network. Loading selected song titles is optional and contacts music providers with those music URLs. Publishing sends only selected music URLs and a random collection key; the website makes the songs and aggregate group counts public.")
            Text("Automatic scanning is optional and never automatically publishes. This first preview is not Apple-notarized. Source and build instructions are available for inspection.")
            HStack { Button("Read source and privacy design") { NSWorkspace.shared.open(URL(string: "https://github.com/songadaymann/passed-around/blob/main/docs/PRIVACY.md")!) }.buttonStyle(.borderless); Spacer(); Button("Done") { showPrivacy = false }.keyboardShortcut(.defaultAction) }
        }.font(.system(size: 14)).padding(28).frame(width: 650)
    }
}
