---
description: Asset sync policy (quick vs full, on-demand)
alwaysApply: true
applyTo: "**"
---

# Sync Policy

The app MUST NOT continuously re-sync the entire library. Syncing is on demand
and tiered. There are exactly two sync depths plus per-view lazy refreshes.

## Quick sync (default, cheap)

- Command: `check_for_new_assets` (Rust) / `checkForNewAssets()` (frontend).
- Only scans the newest assets and STOPS early as soon as it reaches a page made
  entirely of assets already in the local cache. It is capped at
  `QUICK_SYNC_MAX_PAGES` pages as a safety net.
- It refreshes the people list once, but MUST NOT refresh every album and MUST
  NOT re-enrich the whole library.
- Used by:
  - the All Photos timeline on app boot (once per launch),
  - the sidebar `SyncStatusCard` "Check for New Photos" button,
  - the "Quick Sync" button in Settings,
  - reconnect (offline → online) recovery.

## Full sync (explicit, expensive)

- Commands: `start_asset_sync` (initial / resume) and `force_full_asset_sync`.
- Re-scans every page and refreshes all album caches and metadata.
- Only triggered by:
  - the first-ever sync (no `lastSyncCompletedAt`),
  - resuming an interrupted sync on launch,
  - the "Force Full Sync" button in Settings.
- NEVER trigger a full sync automatically on a timer or on every check.

### Resumability (interrupted full sync)

A full sync MUST be resumable so closing/crashing the app does not force a
complete re-scan:

- `is_syncing` and `processed_assets` are persisted in `sync_state`. They are
  only cleared by `complete_sync`, so an interrupted sync still reports
  `isSyncing: true` on next launch.
- On launch, `App.tsx` re-invokes `start_asset_sync` when `syncStatus.isSyncing`
  is true. `start_asset_sync` (NOT `force_full_asset_sync`) resumes: it computes
  `start_page = processed_assets / page_size` and continues from there.
- Each asset page is upserted and `update_sync_progress` is called atomically per
  page, so `processed_assets` is always a clean page boundary and resume never
  loses or double-counts a page.
- The up-front people list + album cache refresh run ONLY on a fresh sync
  (`start_page == 0`). They complete before any asset page is processed, so a
  resumed sync (`start_page > 0`) skips them and jumps straight to the
  interrupted page instead of redoing that heavy work.
- `force_full_asset_sync` always restarts from page 0 (it ignores saved
  progress). Plain `start_asset_sync` is the resumable entry point.

## Per-view lazy refresh (local-first)

When the user opens a bounded view, render from the local cache first, then
refresh just that view's data from the server in the background:

- Opening an album → `refresh_album_assets(album_id)` (only that album).
- Opening a calendar month → `fetch_assets_by_month(year, month)` (only that month).

After a successful background refresh, invalidate the matching React Query key
and bump a `*RefreshNonce` that the canvas grid's `loadFullLayout` callback
depends on, so the grid reloads from the updated cache. Do NOT refresh sibling
albums/months.

## Hard rules

- No periodic/interval-based re-sync of the full library. `useSyncStatus` MUST
  NOT run a background timer that calls a full sync.
- Any new automatic sync trigger must be quick sync or a single-view lazy
  refresh, never a full library scan.
- All sync paths are local-first: when the server is unreachable they MUST
  return an `offline:`-prefixed marker (via `ImmichClient::ping`) and leave the
  cache intact, instead of erroring or forcing re-login.
- When adding a new browsable view with its own server data, add a per-view lazy
  refresh following the album/calendar pattern instead of widening quick sync.
