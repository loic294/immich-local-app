---
description: Local-first / offline architecture policy
alwaysApply: true
applyTo: "**"
---

# Local-First & Offline Policy

This app is **local-first**: the local SQLite cache is the source of truth for the
UI. The Immich backend is treated as a sync target that may be temporarily
unavailable. Features MUST degrade gracefully when the server is unreachable
rather than failing.

## Core rules

- On startup, render from the local cache/database first, then probe the backend
  in the background. Never block the main UI on a network call.
- When the server is unreachable, show an explicit **offline** state (e.g. the
  `OfflineBanner`) instead of erroring or bouncing the user to the login screen.
- Distinguish "server unreachable" (offline → degrade) from "server rejected the
  request" (e.g. HTTP 401/403 → surface the error / require re-login). Use
  `ImmichClient::ping` to make this decision; do not parse error strings.
- Session restore (`restore_session`) MUST succeed offline using locally cached
  credentials + cached user identity. Only force re-login when the server is
  reachable AND rejects the stored credentials, or when no cached identity exists.
- Reads (`get_cached_*`) must never touch the network. They already read from
  SQLite — keep it that way.

## Writes while offline (mutation queue)

- Asset mutations (favorite, visibility, rating, description) apply optimistically
  to the local cache and are enqueued in the `pending_mutations` table when the
  server is unreachable. They are replayed in order by `flush_pending_mutations`
  once connectivity returns.
- A queued mutation that the server later rejects (while reachable) is dropped so
  the queue cannot get permanently stuck.
- New mutation kinds MUST be added to both the enqueue path and the
  `flush_pending_mutations` replay switch.

## Connection detection & recovery

- The frontend `useConnection` hook polls `check_server_connection` on an interval
  and exposes `isOnline` + `pendingCount`.
- On an offline → online transition, the hook flushes the queue and triggers a
  re-check for new assets. Auto-sync effects in `App.tsx` are gated on
  `isOnline === true`.
- The Rust HTTP client sets `connect_timeout` / `timeout` so offline probes fail
  fast instead of hanging.

## Networking

- Network-only features (sync, OAuth login, sharing, profile images, memories)
  may require connectivity. When offline, return a clear, recognizable marker
  (e.g. an error prefixed `offline:`) rather than a raw/opaque failure.
- Follow the cross-platform policy: offline behavior must work identically on
  macOS and Windows.
