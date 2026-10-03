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
npm install
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
variables. Without a key, the info panel falls back to an OpenStreetMap embed.
