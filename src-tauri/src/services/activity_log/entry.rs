use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl ActivityLevel {
    /// Lenient parse for levels sent by the frontend; unknown values read as `info`.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "error" | "err" | "fatal" | "critical" => Self::Error,
            "warn" | "warning" => Self::Warn,
            "debug" | "trace" | "verbose" => Self::Debug,
            _ => Self::Info,
        }
    }

    pub fn from_log(level: log::Level) -> Self {
        match level {
            log::Level::Error => Self::Error,
            log::Level::Warn => Self::Warn,
            log::Level::Info => Self::Info,
            log::Level::Debug | log::Level::Trace => Self::Debug,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivitySource {
    Rust,
    Frontend,
}

/// One line of the activity log, serialized with camelCase keys for the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// Monotonic within one app session; assigned by the buffer. Restarts at 1 every launch.
    pub id: u64,
    pub timestamp_ms: i64,
    pub level: ActivityLevel,
    pub category: String,
    pub source: ActivitySource,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub slow: bool,
}

impl ActivityEntry {
    /// Builds an entry without an id; `Buffer::push` assigns the real one.
    pub fn draft(
        timestamp_ms: i64,
        level: ActivityLevel,
        source: ActivitySource,
        category: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: 0,
            timestamp_ms,
            level,
            category: category.into(),
            source,
            message: message.into(),
            duration_ms: None,
            slow: false,
        }
    }

    pub fn with_duration(mut self, duration_ms: u64, slow: bool) -> Self {
        self.duration_ms = Some(duration_ms);
        self.slow = slow;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ActivityEntry {
        ActivityEntry::draft(
            1_700_000_000_123,
            ActivityLevel::Warn,
            ActivitySource::Rust,
            "http",
            "GET /api/albums → 200 in 1,480ms",
        )
        .with_duration(1480, true)
    }

    #[test]
    fn serializes_with_camel_case_keys_and_lowercase_enums() {
        let mut entry = sample();
        entry.id = 7;
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["id"], 7);
        assert_eq!(json["timestampMs"], 1_700_000_000_123_i64);
        assert_eq!(json["level"], "warn");
        assert_eq!(json["source"], "rust");
        assert_eq!(json["category"], "http");
        assert_eq!(json["durationMs"], 1480);
        assert_eq!(json["slow"], true);
        assert!(json.get("timestamp_ms").is_none());
    }

    #[test]
    fn omits_duration_when_absent() {
        let entry =
            ActivityEntry::draft(1, ActivityLevel::Info, ActivitySource::Frontend, "ui", "x");
        let json = serde_json::to_value(&entry).unwrap();
        assert!(json.get("durationMs").is_none());
        assert_eq!(json["slow"], false);
        assert_eq!(json["source"], "frontend");
    }

    #[test]
    fn round_trips_through_json() {
        let mut entry = sample();
        entry.id = 42;
        let text = serde_json::to_string(&entry).unwrap();
        let back: ActivityEntry = serde_json::from_str(&text).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn deserializes_lines_missing_optional_fields() {
        let back: ActivityEntry = serde_json::from_str(
            r#"{"id":1,"timestampMs":5,"level":"error","category":"app","source":"rust","message":"boom"}"#,
        )
        .unwrap();
        assert_eq!(back.duration_ms, None);
        assert!(!back.slow);
        assert_eq!(back.level, ActivityLevel::Error);
    }

    #[test]
    fn parses_frontend_levels_leniently() {
        assert_eq!(ActivityLevel::parse("ERROR"), ActivityLevel::Error);
        assert_eq!(ActivityLevel::parse(" warning "), ActivityLevel::Warn);
        assert_eq!(ActivityLevel::parse("trace"), ActivityLevel::Debug);
        assert_eq!(ActivityLevel::parse("log"), ActivityLevel::Info);
        assert_eq!(ActivityLevel::parse("nonsense"), ActivityLevel::Info);
    }

    #[test]
    fn levels_order_by_severity() {
        assert!(ActivityLevel::Debug < ActivityLevel::Info);
        assert!(ActivityLevel::Info < ActivityLevel::Warn);
        assert!(ActivityLevel::Warn < ActivityLevel::Error);
    }

    #[test]
    fn maps_log_crate_levels() {
        assert_eq!(
            ActivityLevel::from_log(log::Level::Trace),
            ActivityLevel::Debug
        );
        assert_eq!(
            ActivityLevel::from_log(log::Level::Error),
            ActivityLevel::Error
        );
    }
}
