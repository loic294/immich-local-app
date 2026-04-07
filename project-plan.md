# Immich Desktop Client — Architecture Recommendation

## Tauri v2 + React, Local-First Photo Management

---

## Project Overview

A cross-platform desktop application (Windows + macOS) that connects to a user's self-hosted Immich server. The app displays photos for the authenticated user, caches previews locally for offline access, and allows marking folders as "offline" to download original files. Changes to local original files are synced back to the Immich server.

---

## Technology Stack

### Application Framework

- **Tauri v2** (Rust backend + WebView frontend)
  - Rationale: Significantly more performant than Electron for media-heavy workloads. Bundle size ~3–10MB vs Electron's ~150MB. Lower RAM usage. Native Rust backend handles file I/O, file watching, and HTTP efficiently. Frontend remains standard web tech.

### Frontend

- **React** — UI framework
- **TanStack Query** — API data fetching, caching, and pagination
- **TanStack Virtual** — virtualized photo grid (essential for large libraries, 1000s of photos)

### Backend (Rust / Tauri)

- **reqwest** — async HTTP client for Immich API calls
- **rusqlite** — local SQLite database for asset index and sync state
- **notify** — cross-platform file system watcher
- **tokio** — async runtime for download queue and background workers
- **serde / serde_json** — serialization for API responses and local state

### Immich API

- REST API with JWT authentication
- Official `@immich/sdk` npm package available for typed API calls (can be used on frontend side)
- Key endpoints used:
  - `GET /assets` — list assets with pagination
  - `GET /assets/{id}/thumbnail` — fetch preview/thumbnail image
  - `GET /assets/{id}/original` — download original file
  - `POST /assets` — upload new/modified asset
  - `PUT /assets/{id}` — update asset metadata
  - `DELETE /assets/{id}` — remove asset

---

## Architecture Diagram

```
┌─────────────────────────────────────────┐
│           Frontend (React)              │
│                                         │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │  Photo Grid  │  │  Album Browser  │  │
│  │ (Virtualized)│  │                 │  │
│  └──────────────┘  └─────────────────┘  │
│  ┌──────────────────────────────────┐   │
│  │      Offline Folder Manager      │   │
│  └──────────────────────────────────┘   │
└──────────────┬──────────────────────────┘
               │ Tauri IPC (invoke/commands)
┌──────────────▼──────────────────────────┐
│         Rust Backend (Tauri v2)         │
│                                         │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │ Immich API  │  │  Local SQLite DB │  │
│  │   Client    │  │                  │  │
│  │ (reqwest)   │  │  - asset index   │  │
│  └─────────────┘  │  - sync state    │  │
│                   │  - cache refs    │  │
│  ┌─────────────┐  │  - offline map   │  │
│  │ File Watcher│  └──────────────────┘  │
│  │  (notify)   │                        │
│  └─────────────┘  ┌──────────────────┐  │
│                   │  Download Queue  │  │
│  ┌─────────────┐  │  (tokio async    │  │
│  │ XMP Sidecar │  │   worker pool)   │  │
│  │   Handler   │  └──────────────────┘  │
│  └─────────────┘                        │
└─────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│          Local File System              │
│                                         │
│  ~/.config/immich-client/               │
│    thumbnails/{asset_id}.jpg            │
│    db.sqlite                            │
│                                         │
│  ~/Pictures/ImmichOffline/              │
│    <album_name>/                        │
│      IMG_0001.NEF                       │
│      IMG_0001.xmp   ← XMP sidecar      │
└─────────────────────────────────────────┘
```

---

## Core Features and Implementation Notes

### 1. Authentication

- Store Immich server URL and API key (or JWT token) in Tauri's secure store (`tauri-plugin-store`)
- Support multiple server profiles
- Token refresh handled transparently in the Rust HTTP client layer

### 2. Photo Browsing + Thumbnail Cache

- On first load, fetch asset list from `GET /assets` with pagination (cursor-based)
- Store asset metadata (id, filename, date, dimensions, album, checksum) in SQLite
- Thumbnails fetched from `GET /assets/{id}/thumbnail?size=preview` and saved to local cache directory
- TanStack Virtual renders only visible grid items — critical for libraries with tens of thousands of photos
- Thumbnails served directly from disk cache on subsequent loads (no network call)
- Cache eviction policy: LRU, configurable max size (default 2GB)

### 3. Offline Folder Sync

- User selects an album or folder in the UI and marks it "offline"
- A Tauri command triggers a download job: fetches originals via `GET /assets/{id}/original`
- Downloads managed by a tokio-based worker queue (configurable concurrency, e.g. 3 parallel downloads)
- Progress reported back to frontend via Tauri events (`emit`)
- SQLite tracks sync state per asset: `{pending, downloading, synced, modified, conflict}`
- Downloaded files stored at configurable local path (default `~/Pictures/ImmichOffline/<album>/`)

### 4. File Watcher + Sync Back to Immich

- `notify` crate watches all offline folder paths for file system changes
- On file modification detected:
  1. Compute checksum of modified file
  2. Compare against stored checksum in SQLite
  3. If changed: add to upload queue
- Upload strategy (Immich does not support "replace asset"):
  1. Upload modified file as new asset via `POST /assets`
  2. Copy album membership and metadata from original asset
  3. Move original asset to a "Pre-edit Archive" album (or delete — user preference)
  4. Update SQLite with new Immich asset ID
- Debounce file watcher events (500ms) to avoid triggering on partial writes

### 5. XMP Sidecar Handling

- When an original file is downloaded, check Immich for existing XMP sidecar
- Write a companion `.xmp` file alongside the original using the `crs:` namespace (Adobe Camera Raw / Lightroom-compatible)
- Fields written to XMP: rating, description/caption, GPS, tags, keywords
- When file watcher detects changes to `.xmp` files, parse and sync metadata back to Immich via `PUT /assets/{id}`
- XMP written using `quick-xml` Rust crate

---

## SQLite Schema

```sql
-- Asset index
CREATE TABLE assets (
  id TEXT PRIMARY KEY,               -- Immich asset UUID
  filename TEXT NOT NULL,
  local_path TEXT,                   -- NULL if not downloaded
  thumbnail_path TEXT,
  checksum TEXT,
  date_taken INTEGER,                -- Unix timestamp
  album_id TEXT,
  sync_state TEXT DEFAULT 'remote',  -- remote | pending | downloading | synced | modified | conflict
  immich_checksum TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

-- Offline folder configuration
CREATE TABLE offline_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_sync INTEGER
);

-- Upload/download job queue
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  operation TEXT NOT NULL,           -- download | upload | metadata_sync
  status TEXT DEFAULT 'pending',     -- pending | in_progress | done | failed
  retry_count INTEGER DEFAULT 0,
  created_at INTEGER,
  error TEXT
);
```

---

## Tauri IPC Commands (Rust → Frontend Interface)

```
get_assets(album_id, page, page_size) → Vec<AssetSummary>
get_asset_thumbnail(asset_id) → local file path or base64
set_album_offline(album_id, local_path) → ()
get_sync_status() → SyncStatus
get_offline_folders() → Vec<OfflineFolder>
update_asset_metadata(asset_id, metadata) → ()
```

Tauri events emitted from Rust → Frontend:

```
sync:progress { asset_id, progress, total }
sync:complete { album_id }
sync:error { asset_id, error }
file_changed { asset_id, local_path }
```

---

## Key Design Decisions

### Why Tauri over Electron

- Photo grids with thumbnail images benefit significantly from lower memory overhead
- Rust file watcher and download queue are more efficient than Node.js equivalents
- ~5MB installer vs ~150MB for Electron
- Tauri's `reqwest` HTTP client handles large file downloads (originals) better than Node fetch

### Conflict Resolution (v1)

- "Server wins" policy for metadata conflicts
- "Last write wins" for file content (based on file modification timestamp)
- Conflicts surfaced in UI as a badge on the affected photo — user can manually resolve

### Offline-First Behavior

- App is fully functional for browsing cached thumbnails without network
- Upload queue persists in SQLite — survives app restart
- Sync resumes automatically on reconnect

### Immich API Limitations to Design Around

- No "replace asset" endpoint — uploads always create new assets
- XMP sidecar support in Immich is metadata-only (title, description, rating, tags) — develop/color settings are stored in XMP but not parsed by Immich
- Rate limiting: implement exponential backoff on 429 responses

---

## Suggested Project Structure

```
src-tauri/
  src/
    main.rs
    commands/
      assets.rs        # get_assets, get_thumbnail
      sync.rs          # download, upload, queue management
      offline.rs       # offline folder management
    services/
      immich_client.rs # reqwest-based Immich API wrapper
      file_watcher.rs  # notify integration
      xmp.rs           # XMP sidecar read/write
      download_queue.rs # tokio worker pool
    db/
      schema.rs
      assets.rs
      sync_queue.rs
  tauri.conf.json

src/                   # React frontend
  components/
    PhotoGrid/
    AlbumBrowser/
    OfflineFolderManager/
    SyncStatus/
  hooks/
    useAssets.ts
    useSyncStatus.ts
  api/
    tauri.ts           # typed wrappers around Tauri invoke calls
```

---

## Development Phases (Suggested)

**Phase 1 — Core browsing**

- Tauri app scaffold + auth screen
- Asset list fetch + SQLite cache
- Virtualized thumbnail grid
- Thumbnail download and local cache

**Phase 2 — Offline folders**

- Offline folder UI + configuration
- Original file download queue with progress
- SQLite sync state tracking

**Phase 3 — Sync back**

- File watcher integration
- Upload queue + Immich upload
- XMP sidecar write on download

**Phase 4 — Polish**

- Conflict resolution UI
- Multiple server profiles
- Background sync on app startup
- Bandwidth throttling for downloads

---

## References

- Tauri v2 docs: https://v2.tauri.app
- Immich API docs: https://immich.app/docs/api
- Immich XMP sidecar docs: https://immich.app/docs/features/xmp-sidecars
- TanStack Virtual: https://tanstack.com/virtual
- Adobe XMP spec / crs: namespace: http://www.exiv2.org/tags-xmp-crs.html
