# Full-resolution downloads and editing

- Use the default full-resolution download system for editor originals:
  `commands::shell::copy_assets_to_local_folder` with
  `prefer_album_folder = Some(true)` and `allow_cached_fallback = false`.
- Reuse an existing tracked original when it is present on disk, including
  offline. Never satisfy editing with a preview or transcoded rendition.
- Do not download or copy editor originals into an `Editing` folder or create
  a separate editor-only download implementation.
- Preserve the shared album destination policy, collision protection, progress
  events, and local-file tracking. Watch sidecars beside that same original;
  keep the existing sidecar-driven editing/import workflow.
- This behavior must remain consistent on macOS and Windows.
- If an editor source is deleted outside the app, retire its persisted watcher
  before checking sidecars or rendering previews. Never treat a missing source
  as an importable edit. Do not delete surviving sidecars;
  editing again should use the default original download flow.
- Editor watchers are session-scoped: clear them on Immich Local exit and
  startup (including crash recovery). Only `begin_media_edit` starts watching
  an original again; do not restore old watcher paths automatically.
- File timestamps and byte sizes are not descriptions. Refresh their tracking
  baseline without generating metadata notices or updating asset descriptions.
  Keep missing-local-copy detection and active edit sidecar watching separate.
