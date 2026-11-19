# Recording matching

Original canonical URLs are always retained and labeled `shared`. Additional catalog links are labeled `metadata`. Search destinations are constructed separately and never stored as confirmed availability.

## Current adapters

| Service | Metadata or matching | Unavailable match behavior |
|---|---|---|
| Spotify | Public embed entity for title/artist/duration/artwork; official oEmbed fallback for title/artwork | Preserve original; offer searches |
| Apple Music | Public iTunes lookup/search | Exact full normalized title and artist, duration within 2 seconds, track-only |
| Deezer | Public track/album metadata and search | Same strict recording predicate |
| YouTube | Official oEmbed for original videos | Uploader is not assumed to be artist; do not automatically merge videos |
| Bandcamp | Preserve original track/album URL; readable slug fallback | Labeled Bandcamp search; no catalog scraping |
| Tidal | Preserve original track/album URL | Labeled search |
| SoundCloud | Original URL and public oEmbed title when available | Labeled search; no title-only merge |

Spotify's embed-state JSON is **undocumented and may change**. Only the explicit title, artists, duration and image fields are retained; anonymous session fields elsewhere in the page are discarded. If it fails, official oEmbed still supplies a title and cover, but without an artist/duration no recording match is inferred.

Version terms such as "live", "remix", "instrumental" and remaster years remain in the normalized title. Duration must be known for both candidates. Matching is deliberately conservative; even these agreements are not a guarantee of identical masters. No fuzzy or first-result matching is used. Albums remain albums and are not expanded into invented track shares. Failed metadata jobs retry with backoff, at most three attempts.

YouTube thumbnails are derived from the validated video ID immediately, before metadata lookup finishes. Other original-provider artwork is saved as soon as it is available. An unavailable/deleted video can still have no usable thumbnail; the UI labels that fallback.

The resolver uses a 30-second batch lease, three concurrent jobs, up to 36 jobs/pass, bounded fetch timeouts and a shared ceiling of 40 external requests/pass. A separate database budget caps Apple requests at 16 per minute, regardless of how many upload/cron invocations run. A provider-budget deferral does not consume an error retry. Saved metadata/artwork is reused when retrying cross-service matches, so slow catalog searches do not cause repeated cover lookups. Apple originals use the link's storefront instead of assuming US availability.

D1 retains pending jobs for later passes. The page shows pending metadata progress and refreshes the already-loaded results automatically, including after loading additional pages. Local explicit Apple title lookups are paced separately.

For repairing an existing import, maintainers can run `node scripts/backfill-artwork.mjs https://their-site` to prepare public-metadata-only updates, then add `--apply` to apply them to the configured D1 database. It reads only the public feed and source-provider metadata, does not open Messages or read collection credentials, and does not alter group contributions. Cross-service searches are skipped during this repair.

## References checked 2026-11-19

- [Spotify oEmbed](https://developer.spotify.com/documentation/embeds/reference/oembed)
- [Apple Search API](https://performance-partners.apple.com/search-api)
- [YouTube search API](https://developers.google.com/youtube/data/reference/rest/v3/search/list) — authenticated search is a future adapter, not silently scraped
- [Bandcamp developer APIs](https://bandcamp.com/developer) and [acceptable-use policy](https://get.bandcamp.help/en/articles/15263124-bandcamp-s-acceptable-use-and-moderation-policy)
- [Odesli API retirement notice](https://linktree.notion.site/API-d0ebe08a5e304a55928405eb682f6741) — live public endpoints returned `PUBLIC_API_ACCESS_DEPRECATED`; not used
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API) — possible future identifier/relationship adapter; not a dependency of this release

Future work can add authenticated official Spotify/YouTube APIs, ISRC identity, reviewable link corrections, regional availability and optional paid resolution. It should preserve link provenance and never turn uncertain search results into asserted availability.
