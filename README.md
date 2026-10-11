# Immich Local App

<img width="3128" height="2186" alt="Immich Local App screenshot" src="https://github.com/user-attachments/assets/ef15dfd3-600a-4a93-900b-85825c9bbb22" />

Immich Local App is a cross-platform desktop companion for your self-hosted
[Immich](https://immich.app/) server. It gives you a fast way to browse and
manage your photo library from macOS or Windows, while keeping a local SQLite
cache so the app can continue to show cached library data when the server is
unavailable.

## What it solves

Your photo library should still be useful when your network or Immich server is
temporarily offline. This app keeps library data on your device, restores cached
sessions offline, and queues supported asset changes for the next time the
server is reachable. It is a desktop client for Immich, not a replacement for
the Immich server.

## Features

- Browse a virtualized photo timeline, albums, folders, calendar views,
  favorites, and deleted assets.
- Filter and sort the library by available details such as people, camera,
  media type, rating, favorite status, and account.
- View photos and videos with metadata, location maps, and memories.
- Manage multiple Immich accounts and sign in with an API key, password, or
  OAuth.
- Cache library data locally and browse cached content while offline.
- Queue supported changes to favorites, visibility, ratings, and descriptions
  while offline, then replay them when the server reconnects.
- Run a full library sync when needed, or use quick and view-specific refreshes
  to check only for new assets or update the current album/month.
- Save album assets locally and detect changes to saved files.
- Share albums and manage album access where supported by the Immich server.

Albums render from the local cache first and refresh their list when opened
online, without syncing every album's photos. Both legacy `ownerId` responses
and newer Immich `albumUsers` ownership responses are supported for browsing
and album creation. Server refresh errors are shown without discarding cached
albums.
Album photos use embedded assets on older servers or paginated, album-scoped
metadata search on newer servers that omit assets from album details.

**People** in the Library sidebar shows cached face thumbnails and photo counts.
Choose a person to open the shared Photos timeline with its People filter already
selected; the remaining filters and fullscreen controls work as in All Photos.

**Map** clusters cached GPS-tagged photos into thumbnail markers. Select a marker
or cluster to browse its photos on the right, or pan the map to browse the visible
area. The map reads coordinates from SQLite and refreshes at most 100 photos in
the current view, never the whole library. Without network access, the background
map is unavailable but cached photo markers and photos remain usable. From the
fullscreen info panel, choose **Open in map** to jump to that photo's location.
Click the filename to reveal or hide its cached file path.

**Search** accepts text and metadata terms such as `camera:sony`, `person:Alex`,
`after:2025-01-01`, `type:video`, and `-tag:private`. Use the search options
popover to build a query. Queries run against SQLite across Photos, Albums,
Folders, and Calendar. **Update time** adjusts selected photos by an offset,
optionally calculated from a reference photo in the same view. It changes
Immich metadata and the local cache, never the original files, and queues
changes while offline.

**Import** scans a chosen folder or suggests newly connected removable media.
Choose an album and select photos/videos in the virtualized grid; previously
imported checksums are labelled. Originals are copied safely to the configured
local `Albums/<album name>` folder and retained there. Offline uploads are
durable, account-scoped, and replay when connectivity returns; failed uploads
remain visible in the queue with a retry action. JPEG/PNG/WebP/TIFF thumbnails
are decoded locally; RAW/HEIC previews use the macOS or Windows native codecs
when installed, otherwise an explicit placeholder is shown.

**Editing** opens the original image in RapidRAW (or the configured editor),
downloading it first if needed. **Edit all photos** passes every cached image
in the album to one GUI launch as file arguments; the editor must support
that invocation. Sidecar changes trigger an export suggestion. The default
CLI export produces a quality-100 JPEG with metadata, retained beside the
original as `<name>-edited-YYYYMMDD.jpg`, then queues an upload. The newest
edit becomes the stack primary in Immich and local browsing, including the
original's albums; version thumbnails in Info open the other versions.
Re-editing always uses the original. Editor executable, export arguments,
and watched sidecars are configurable in Settings. Immich accepts XMP metadata
sidecars, not RapidRAW `.rrdata`/`.xml` projects; those remain locally retained.

**Settings** groups preferences into subpages. Storage & cache shows real disk
usage and enforces a disposable-cache limit without deleting retained originals
or pending uploads. A currently playing video is protected and any resulting
over-limit state is explicitly shown. Video quality selects either the
server-transcoded source or original source independently for streaming and
offline downloads; available resolutions depend on server capabilities.

**Privacy:** allowlisted generic page and feature events are sent to the
project's Umami analytics endpoint by default. Photo names, paths, account
details, server URLs, and credentials are never included. Disable analytics
in Settings > Privacy to persist an opt-out and send one final disabled event.

## Technology

- **Desktop:** [Tauri 2](https://v2.tauri.app/) with a Rust backend
- **UI:** React, TypeScript, Vite, Tailwind CSS, and daisyUI
- **Local data:** SQLite
- **Server:** Immich's HTTP API

## Work on the app

### Prerequisites

Install Node.js (LTS), Rust (stable), and the platform-specific tools required
by Tauri 2. See the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
for macOS and Windows setup.

### Run in development

```sh
git clone https://github.com/loic294/immich-local-app.git
cd immich-local-app
npm ci
npm run tauri dev
```

The desktop app will open. Connect it to your Immich server and sign in using
the authentication method configured for your account.

### Build

```sh
npm run build       # Type-check and build the frontend
npm run tauri build # Build the desktop app for the current platform
```

Run the Tauri build on macOS or Windows to produce that platform's app bundle or
installer.

## Optional map configuration

The fullscreen info panel uses MapTiler's `dataviz-v4-dark` style when a
MapTiler API key is configured. Add the key to a `.env` file in the project
root:

```env
VITE_MAPTILER_API_KEY=your_maptiler_api_key
```

Restart the Vite/Tauri development process after changing environment
variables. Without a key, the info panel falls back to an OpenStreetMap embed and
the Map page uses OpenStreetMap tiles.
