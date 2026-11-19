# Passed Around

Good music travels between friends. Passed Around collects the music links people are already sharing in a Messages conversation, while keeping the conversation on their Mac.

This is an early, open-source pilot: a native SwiftUI Mac app plus a Cloudflare Worker, D1 database, and browser listening room. The public pilot is at **https://passed-around.novox-robot.workers.dev**.

## What it does

- Opens the local Messages database **read-only**, after macOS permission and an explicit conversation selection.
- Extracts recognized Spotify, Apple Music, Bandcamp, Deezer, Tidal, and SoundCloud track/album URLs. YouTube shares, artist profiles and playlists are skipped.
- Lets you review, select, optionally load song titles from providers, and export or publish canonical music URLs.
- Uploads **only `{ "urls": [...] }`**, authenticated by a random collection key. No chat names, participant identities, message bodies, original message dates, or local database IDs are uploaded.
- Counts distinct contributing collections per release. Reposting a song in the same collection does not increase its group count.
- Adds conservative Apple Music and Deezer recording matches where artist, full title, and duration agree. Missing services are labeled **Search**, not falsely reported as available.
- Can check the selected conversation every minute. **Automatic scanning never automatically publishes.**

The Mac app's local scan works without an account or invitation. Publishing to the public pilot is invitation-only. A copy of the sample chat and a clearly marked sample feed are included; they never count as real contributions.

## Download and use

Download the universal Apple silicon + Intel build from the [listening room](https://passed-around.novox-robot.workers.dev/#get-the-app) or [GitHub releases](https://github.com/songadaymann/passed-around/releases). macOS 14 or later is required.

1. Unzip **Passed Around.app** and move it to Applications.
2. This developer preview is **ad-hoc signed, not Developer ID signed or Apple-notarized**. Inspect/build the source if preferred. If macOS blocks it after an open attempt, System Settings → Privacy & Security may offer **Open Anyway**. Do not disable Gatekeeper.
3. Click **Connect Messages** and select your `Library/Messages` folder. If macOS denies access, use **System Settings → Privacy & Security → Full Disk Access**, add Passed Around, then quit and reopen it. This is broader permission than music links; the app applies its own per-conversation restriction.
4. Choose a conversation and click **Find music links**. Nothing is uploaded.
5. Select links and optionally **Load selected song titles**. This contacts music providers directly with the selected URLs. **Preview upload JSON** shows the exact publication body.
6. Export locally, or connect a pilot collection and publish selected links. Publishing makes the songs and aggregate counts public. Choose a single collector per chat to avoid counting the same group twice.

One member's synced copy can supply the links for a group. It includes only history actually downloaded on that Mac. Agree with the group about contributing its music before publishing. Remove a collection's contributions using the app's removal control.

## Build the Mac app

Swift 6 or later and Apple's Command Line Tools are sufficient; a full Xcode installation is not required.

```sh
swift run --package-path macos PrivacyChecks
npm run build:mac
open "build/Passed Around.app"
```

`scripts/build-mac.sh` builds each architecture separately, combines the executables, creates the app icon, applies sandbox entitlements and an ad-hoc signature, and produces a zip and SHA-256 checksum under `public/downloads/`. The only remote Swift dependency is the MIT-licensed [Madrid TypedStream decoder](https://github.com/mattt/Madrid), pinned to a full commit. There is no auto-updater, analytics SDK, or AI dependency.

## Run the website locally

Requires Node.js 22+.

```sh
npm ci
npm run db:local
npm run dev
```

Open `http://localhost:8787`. Copy `.dev.vars.example` to `.dev.vars` and set a local invitation to create test collections. Never commit credentials. The in-browser example feed is separate from the database.

```sh
npm run check
npm test
npm run test:integration
swift run --package-path macos PrivacyChecks
```

The integration test runs the real Worker and D1 schema in Miniflare, with deterministic provider fixtures. It verifies authorization, rejection of message fields, cross-platform merging, per-group idempotency, public-data boundaries, search, and removal.

## Deploy your own Cloudflare instance

The checked-in Wrangler file identifies the public pilot's resources; replace `account_id` and `d1_databases[0].database_id` with **your own** before deploying. They are resource identifiers, not credentials. Do not deploy to the pilot's resources unless you maintain it.

```sh
npx wrangler login
npx wrangler d1 create your-passed-around-database
# Edit wrangler.jsonc: your Worker name, account_id, database name and ID.
npm run db:remote
npm run deploy
npx wrangler secret put PILOT_INVITE
```

Enter a strong, private invitation when prompted. In the Mac app, enter your HTTPS site URL and invitation after selecting a conversation. Each conversation needs a separate collection key. Never embed a shared ingestion key in a downloadable app. To disable registration, delete the `PILOT_INVITE` secret; existing collection keys remain valid.

`scripts/provision-pilot.mjs` is an optional maintainer helper. It sets the invitation via stdin and registers an empty pilot collection, then hands the key to the compiled Mac app through stdin for storage in Keychain. It does not scan Messages or publish music. It stores the owner invitation in ignored, mode-600 `.local/` storage and never prints secrets.

## Matching limits

See [MATCHING.md](docs/MATCHING.md). This is **not** universal availability verification. The retired Odesli API is not used. Spotify's public embed-state format is an undocumented enhancement with an official oEmbed fallback. Apple/Deezer matches are metadata-based, not guaranteed ISRC identity. Alternate versions remain separate. YouTube-only imports are excluded from the feed and counts; existing records are retained privately for reversibility. YouTube remains a listening search for music shared from another service. Original Bandcamp links are preserved without scraping Bandcamp. Search links remain available for all supported services.

## Privacy and security

Read [the data-flow and threat model](docs/PRIVACY.md), [third-party notices](docs/THIRD_PARTY.md), and the [API contract](docs/API.md). Open source makes inspection possible; it is not a claim that this preview has had an independent security audit.

## Project layout

```text
macos/       Native app, read-only scanner, payload boundary, native checks
worker/      Public catalog, authenticated ingestion, metadata matching
migrations/  D1 schema (no message/participant/chat-name fields)
public/      Listening room and isolated example feed
tests/       URL/matching tests and full Worker/D1 integration test
scripts/     Build, sample-data and optional pilot provisioning tools
```

MIT licensed. Contributions welcome.
