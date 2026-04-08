pub const ASSETS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  original_file_name TEXT NOT NULL,
  file_created_at TEXT,
  checksum TEXT,
  updated_at INTEGER NOT NULL,
  asset_type TEXT,
  duration TEXT,
  is_favorite BOOLEAN DEFAULT 0,
  is_archived BOOLEAN DEFAULT 0,
  visibility TEXT,
  rating INTEGER,
  camera TEXT,
  lens TEXT,
  file_size_bytes INTEGER,
  file_extension TEXT,
  people TEXT,
  tags TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  id TEXT PRIMARY KEY,
  total_assets INTEGER NOT NULL,
  processed_assets INTEGER NOT NULL DEFAULT 0,
  is_syncing BOOLEAN DEFAULT 0,
  last_sync_completed_at TEXT,
  last_checked_at TEXT,
  check_status TEXT DEFAULT 'idle',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;
