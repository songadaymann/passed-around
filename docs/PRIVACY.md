# Privacy design and limits

## Local read boundary

The app is sandboxed with network-client, user-selected read-only file, and bookmark entitlements. It requests a Messages-folder grant through the system picker. macOS may additionally require Full Disk Access. Neither mechanism grants "music links only" access: the underlying database contains multiple conversations.

The app lists conversation names, participant counts, and message counts locally so the user can choose a chat. It reads participant phone/email handles from Messages to identify otherwise unnamed groups; those handles stay in memory on the Mac and are not exported or uploaded. It does not request Contacts/address-book access. Message-content scanning uses a parameterized query restricted to the selected chat ID. SQLite is opened with `SQLITE_OPEN_READONLY`; the app never copies the database or modifies messages.

Message text and decoded attributed-body strings are temporary, in-memory values. Recognized URLs are normalized against exact hostname/path allowlists; query strings and fragments are removed except actual song identifiers. YouTube URLs are excluded from scans, exports and publication payloads. Only music URLs, local occurrence counts and local last-shared dates remain in the review model. The app retains a folder bookmark and collection keys, not a second message archive. The original Messages database remains under Apple's control.

The pure Swift TypedStream decoder parses bytes without instantiating archived Objective-C objects. Undecodable bodies are counted and surfaced as incomplete-scan warnings. Private data is never sent to a language model.

The app does not access attachments, Contacts, microphone, camera, browser history, or unrelated files. Link previews and attachment-only messages may be missed if no recognized URL is present in readable message text.

Local exports are written as URL-only JSON files inside the app's own Application Support/Exports folder and revealed in Finder. They can be moved elsewhere by the user. This keeps the user-selected file entitlement read-only, rather than broadening Messages-folder access just to show a save dialog.

## Network boundary

Scanning and selecting do not use the network. There are distinct network actions:

1. **Load selected song titles:** sends selected, extracted music URLs directly to Spotify oEmbed or song IDs to Apple's catalog lookup. This is explicit, optional, memory-cached, and separate from the Passed Around server. No chat context is included. The app labels this action before use.
2. **Connect collection:** registers an anonymous collection using the configured site's pilot invitation, or imports an existing key into macOS Keychain. The server creates a random UUID and random 256-bit token. The invitation is not a music submission.
3. **Publish selected links:** sends only `{"urls":["https://…"]}` to `POST /api/shares`. A random token is sent as a bearer header. The server rejects extra JSON keys. The local chat ID, name, message text, participants, occurrence counts, and original message dates cannot be encoded by the publication payload type.
4. **Remove collection:** authenticates with its token and deletes that collection and its contributions.
5. **Open website/source/music link:** opens the user's browser or music app in response to the user's action.

Collection credentials are stored in Keychain, not UserDefaults. HTTP redirects are refused so a collection bearer key is never forwarded to a redirected host. Server URLs require HTTPS except localhost development. Automatic local scans do not publish and do not select newly discovered links.

## Server storage and public output

D1 stores random collection IDs, SHA-256 token hashes, canonical music URLs, public recording metadata, platform-link provenance, collection/recording relationships, publication times, resolver jobs and rate-limit counters. It has no fields for chat names, participants, message content or original message dates. Group IDs and token hashes are never in the public feed. Exact public `publishedAt` values describe publication to this service, not when someone sent the original message. Legacy YouTube-only records remain stored but are excluded from the public feed, aggregate counts and metadata work; removing a collection still removes all its contributions, including those hidden records.

The public API returns song metadata, listening links, provenance, aggregate distinct-group counts, and publication dates. Canonical aliases allow an Apple Music link and a Spotify link to contribute to the same recording when a conservative match is found. A collection contributes at most one count per recording.

Removing a collection revokes its token and removes its contributions. Songs with no remaining contributing collection, their source URLs and pending jobs are deleted. Other groups' contributions remain. This is logical deletion from the live database, not a promise to erase hosting-provider backups, external caches or screenshots.

## External services and logs

Matching sends public music URLs or artist/title queries to music providers. The Spotify embed-state enhancement parses only an explicit public-metadata subset and never stores or logs the rest of the page state. Album artwork is served from allowlisted music-provider image hosts; loading artwork exposes ordinary browser network information to those providers.

There are no advertising, analytics, tracking pixels, or third-party JavaScript on the site. Worker observability is disabled in the deployment configuration. Application code does not log incoming bodies, collection keys, private strings, or provider page state. Cloudflare still sees transport metadata, such as source IPs and request paths, to provide hosting and security. Registration abuse counters hash source IP addresses; hashes are not part of public output and expire from the rate-limit table after a day. Infrastructure logging/retention is governed by Cloudflare and the operator.

## Trust and product limits

- Public song contributions can reveal taste. The app's review step is the publishing decision; the operator should obtain group agreement and avoid publishing sensitive or identifying selections.
- A collection is an anonymous contributing group by convention. The software cannot prove distinct friend groups or prevent one person from registering several collections. Pilot invitations reduce casual abuse. Use one collector/key per chat, or deliberately import the same connection for that group, to avoid double-counting it.
- “One group” means one contributing collection **on this service**, not uniqueness across the world's private chats.
- The local app must be trusted with broad database access. Open source permits inspection but does not technically prevent a maliciously modified binary from reading more. This preview is ad-hoc signed, not Developer ID signed/notarized, and has not had an independent audit. Build from the pinned source if desired.
- Copies of history depend on what Messages downloaded to that Mac. Deleted/unsent messages, unsupported links, undecodable records, and attachment-only shares may be absent.
- The public pilot is a prototype, not a complete public community platform. Account recovery, abuse moderation, collection transfer UI, signed/notarized distribution, release attestation and privacy-preserving cross-device group identity are future work.

## Evidence

Native privacy checks exercise actual read-only SQLite scanning, modern attributed-body decoding, query scoping, tracking removal, and the URL-only payload encoder against synthetic data. Worker/D1 integration tests exercise rejection of extra fields, bearer authorization, strict metadata matching, cross-platform deduplication, per-group counts, and removal. They do not substitute for user-approved testing with a real selected Messages conversation.
