pub const ASSETS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  original_file_name TEXT NOT NULL,
  file_created_at TEXT,
  checksum TEXT,
  updated_at INTEGER NOT NULL
);
"#;
