# Pilot API

All requests use HTTPS (localhost may use HTTP during development). JSON bodies are capped at 24 KB. Errors are JSON with `error`. No CORS wildcard is provided; browser writes from other origins are rejected. Native clients use bearer keys and have no browser Origin header.

## POST /api/collections

Body: `{"invite":"owner-provided invitation"}`.

Returns 201: `{ "collectionId": "random UUID", "token": "random 43-character base64url key", "siteURL": "https://your-site" }`.

The token is returned only at creation. Store it in Keychain. The server stores only its SHA-256 hash. Registration is disabled unless the operator sets `PILOT_INVITE`. Bad invitations return 403; registration is rate-limited.

## POST /api/shares

Header: `Authorization: Bearer <token>`.

Body: `{"urls":["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"]}`.

One to ten supported canonical music URLs. Extra fields, unsupported destinations, userinfo/ports, private message bodies, and non-music hostnames are rejected. The entire batch is validated before writing. Repeated requests are idempotent for a collection/recording pair. Returns 202 with an accepted count; metadata work continues in the background. Ingestion is rate-limited to 30 requests/minute per key.

## GET /api/feed

Query parameters: `sort=recent|popular|rare`, optional `q`, optional `platform`, `limit` (1–60), `offset`.

Returns `tracks`, `total`, and `hasMore`. Each track includes title, artist, kind (`track|album|video`), artwork, status, duration, `groupCount`, publication date, `links` with provenance, and separately labeled `searches`. It never includes collection IDs, chat information, or keys.

## GET /api/stats

Returns aggregate `tracks`, `groups`, `rare` (releases with one contributing collection) and `connections` (distinct collection/recording relationships). Empty registered collections are not included in group counts.

## GET /api/collection

Authenticated. Returns connectivity and this collection's current release count.

## DELETE /api/collection

Authenticated. Removes this collection and its contributions, deletes unreferenced releases, and revokes the key. Returns `{ "removed": true }`.

## GET /api/health and GET /api/config

Public version/health and source-link information. Secrets are never returned. There is no endpoint for listing group identities.
