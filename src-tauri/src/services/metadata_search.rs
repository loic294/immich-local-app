//! Structured metadata search, modeled on Immich's search bar.
//!
//! The query string is parsed into terms. Free text matches every searchable
//! metadata column; `key:value` terms target one part of the metadata:
//!
//! - `name:` / `filename:` / `file:` – original file name
//! - `description:` / `desc:` – asset or EXIF description
//! - `path:` / `folder:` – full original path
//! - `camera:` / `make:` / `model:` – camera make/model
//! - `lens:` – lens model
//! - `person:` / `people:` – recognized person names
//! - `tag:` – tag names
//! - `place:` / `location:` / `city:` / `state:` / `country:` – EXIF location
//! - `type:` / `is:` – photo, video, raw, favorite
//! - `ext:` – file extension
//! - `after:` / `before:` / `date:` – `YYYY`, `YYYY-MM` or `YYYY-MM-DD`
//! - `rating:` – `3`, `>=3`, `<=2`
//!
//! Values may be quoted (`camera:"EOS R5"`) and terms negated (`-tag:work`).
//! Every term becomes an SQL condition evaluated against the `assets` table so
//! paged results, full layouts and scoped views (albums, folders, months) stay
//! aligned. Values are always bound as parameters.

use rusqlite::ToSql;

pub(crate) type QueryParams = Vec<Box<dyn ToSql>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MetadataField {
    Text,
    FileName,
    Description,
    Path,
    Camera,
    Lens,
    Person,
    Tag,
    Place,
    City,
    State,
    Country,
    Type,
    Extension,
    After,
    Before,
    Date,
    Rating,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MetadataQueryTerm {
    pub field: MetadataField,
    pub value: String,
    pub negated: bool,
}

fn field_for_key(key: &str) -> Option<MetadataField> {
    let field = match key.to_ascii_lowercase().as_str() {
        "name" | "filename" | "file" => MetadataField::FileName,
        "description" | "desc" | "caption" => MetadataField::Description,
        "path" | "folder" => MetadataField::Path,
        "camera" | "make" | "model" => MetadataField::Camera,
        "lens" => MetadataField::Lens,
        "person" | "people" | "face" => MetadataField::Person,
        "tag" | "tags" => MetadataField::Tag,
        "place" | "location" | "loc" => MetadataField::Place,
        "city" => MetadataField::City,
        "state" => MetadataField::State,
        "country" => MetadataField::Country,
        "type" | "is" | "media" => MetadataField::Type,
        "ext" | "extension" => MetadataField::Extension,
        "after" | "from" | "since" => MetadataField::After,
        "before" | "until" | "to" => MetadataField::Before,
        "date" | "on" | "year" => MetadataField::Date,
        "rating" | "stars" => MetadataField::Rating,
        _ => return None,
    };
    Some(field)
}

fn read_value(chars: &[char], index: &mut usize) -> String {
    let mut value = String::new();
    if *index < chars.len() && chars[*index] == '"' {
        *index += 1;
        while *index < chars.len() && chars[*index] != '"' {
            value.push(chars[*index]);
            *index += 1;
        }
        if *index < chars.len() {
            *index += 1;
        }
        return value;
    }
    while *index < chars.len() && !chars[*index].is_whitespace() {
        value.push(chars[*index]);
        *index += 1;
    }
    value
}

/// Splits a raw query into structured terms. Unknown `key:value` pairs are
/// treated as free text so searching for e.g. `12:30` still works.
pub(crate) fn parse_metadata_query(input: &str) -> Vec<MetadataQueryTerm> {
    let chars: Vec<char> = input.chars().collect();
    let mut terms = Vec::new();
    let mut index = 0usize;

    while index < chars.len() {
        if chars[index].is_whitespace() {
            index += 1;
            continue;
        }

        let mut negated = false;
        if chars[index] == '-' && index + 1 < chars.len() && !chars[index + 1].is_whitespace() {
            negated = true;
            index += 1;
        }

        let start = index;
        let mut key = String::new();
        while index < chars.len()
            && !chars[index].is_whitespace()
            && chars[index] != ':'
            && chars[index] != '"'
        {
            key.push(chars[index]);
            index += 1;
        }

        let field = if index < chars.len() && chars[index] == ':' && !key.is_empty() {
            field_for_key(&key)
        } else {
            None
        };

        let (field, value) = match field {
            Some(field) => {
                index += 1;
                (field, read_value(&chars, &mut index))
            }
            None => {
                index = start;
                (MetadataField::Text, read_value(&chars, &mut index))
            }
        };

        let value = value.trim().to_string();
        if !value.is_empty() {
            terms.push(MetadataQueryTerm {
                field,
                value,
                negated,
            });
        }
    }

    terms
}

fn like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('%');
    for ch in value.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped.push('%');
    escaped
}

fn exif(path: &str) -> String {
    format!(
        "COALESCE(json_extract(CASE WHEN json_valid(exif_info_json) THEN exif_info_json END, '$.{}'), '')",
        path
    )
}

fn like_any(columns: &[String], index: usize) -> String {
    let parts: Vec<String> = columns
        .iter()
        .map(|column| format!("{} LIKE ?{} ESCAPE '\\' COLLATE NOCASE", column, index))
        .collect();
    format!("({})", parts.join(" OR "))
}

fn person_condition(index: usize) -> String {
    format!(
        "(COALESCE(people, '') LIKE ?{0} ESCAPE '\\' COLLATE NOCASE OR id IN (SELECT ap.asset_id FROM asset_people ap JOIN people p ON p.id = ap.person_id WHERE COALESCE(p.name, '') LIKE ?{0} ESCAPE '\\' COLLATE NOCASE))",
        index
    )
}

/// Normalizes `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (also `/` or `.` separated) into
/// a dash-separated prefix comparable with ISO `file_created_at` values.
pub(crate) fn normalize_date_prefix(value: &str) -> Option<String> {
    let normalized = value.trim().replace(['/', '.'], "-");
    let parts: Vec<&str> = normalized.split('-').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let year = parts[0];
    if year.len() != 4 || !year.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut out = year.to_string();
    for (position, part) in parts.iter().enumerate().skip(1) {
        let number: u32 = part.parse().ok()?;
        let valid = if position == 1 {
            (1..=12).contains(&number)
        } else {
            (1..=31).contains(&number)
        };
        if !valid {
            return None;
        }
        out.push_str(&format!("-{:02}", number));
    }
    Some(out)
}

fn type_condition(value: &str, video: &str, raw: &str) -> Option<String> {
    let condition = match value.to_ascii_lowercase().as_str() {
        "video" | "videos" | "movie" => video.to_string(),
        "photo" | "photos" | "image" | "images" | "picture" => format!("NOT {}", video),
        "raw" => format!("(NOT {} AND {})", video, raw),
        "jpg" | "jpeg" | "nonraw" => format!("(NOT {} AND NOT {})", video, raw),
        "favorite" | "favorites" | "fav" | "favourite" => "is_favorite = 1".to_string(),
        "archived" | "archive" => "(is_archived = 1 OR visibility = 'archive')".to_string(),
        _ => return None,
    };
    Some(condition)
}

/// Builds SQL conditions (to be AND-ed, evaluated against `assets`) for a raw
/// metadata query. Placeholders are numbered from `start_index`; the returned
/// params must be bound in order immediately after the caller's params.
pub(crate) fn metadata_query_conditions(
    query: &str,
    start_index: usize,
    video_predicate: &str,
    raw_predicate: &str,
) -> (Vec<String>, QueryParams) {
    let mut conditions = Vec::new();
    let mut params: QueryParams = Vec::new();
    let mut next = start_index;

    for term in parse_metadata_query(query) {
        let value = term.value.as_str();
        let like_columns = |columns: Vec<String>, next: &mut usize, params: &mut QueryParams| {
            let condition = like_any(&columns, *next);
            params.push(Box::new(like_pattern(value)));
            *next += 1;
            condition
        };

        let condition = match term.field {
            MetadataField::Text => Some(format!(
                "({} OR {})",
                like_columns(
                    vec![
                        "original_file_name".into(),
                        "COALESCE(description, '')".into(),
                        "COALESCE(original_path, '')".into(),
                        "COALESCE(camera, '')".into(),
                        "COALESCE(lens, '')".into(),
                        "COALESCE(file_extension, '')".into(),
                        "COALESCE(tags, '')".into(),
                        exif("description"),
                        exif("make"),
                        exif("model"),
                        exif("city"),
                        exif("state"),
                        exif("country"),
                    ],
                    &mut next,
                    &mut params,
                ),
                {
                    let condition = person_condition(next - 1);
                    condition
                }
            )),
            MetadataField::FileName => Some(like_columns(
                vec!["original_file_name".into()],
                &mut next,
                &mut params,
            )),
            MetadataField::Description => Some(like_columns(
                vec!["COALESCE(description, '')".into(), exif("description")],
                &mut next,
                &mut params,
            )),
            MetadataField::Path => Some(like_columns(
                vec!["COALESCE(original_path, '')".into()],
                &mut next,
                &mut params,
            )),
            MetadataField::Camera => Some(like_columns(
                vec!["COALESCE(camera, '')".into(), exif("make"), exif("model")],
                &mut next,
                &mut params,
            )),
            MetadataField::Lens => Some(like_columns(
                vec!["COALESCE(lens, '')".into(), exif("lensModel")],
                &mut next,
                &mut params,
            )),
            MetadataField::Tag => Some(like_columns(
                vec!["COALESCE(tags, '')".into()],
                &mut next,
                &mut params,
            )),
            MetadataField::Place => Some(like_columns(
                vec![exif("city"), exif("state"), exif("country")],
                &mut next,
                &mut params,
            )),
            MetadataField::City => Some(like_columns(vec![exif("city")], &mut next, &mut params)),
            MetadataField::State => Some(like_columns(vec![exif("state")], &mut next, &mut params)),
            MetadataField::Country => {
                Some(like_columns(vec![exif("country")], &mut next, &mut params))
            }
            MetadataField::Person => {
                params.push(Box::new(like_pattern(value)));
                next += 1;
                Some(person_condition(next - 1))
            }
            MetadataField::Extension => {
                params.push(Box::new(value.trim_start_matches('.').to_ascii_lowercase()));
                next += 1;
                Some(format!(
                    "LOWER(COALESCE(file_extension, '')) = ?{}",
                    next - 1
                ))
            }
            MetadataField::Type => type_condition(value, video_predicate, raw_predicate),
            MetadataField::After | MetadataField::Before | MetadataField::Date => {
                normalize_date_prefix(value).map(|prefix| {
                    let op = match term.field {
                        MetadataField::After => ">=",
                        MetadataField::Before => "<=",
                        _ => "=",
                    };
                    let condition = format!(
                        "(file_created_at IS NOT NULL AND substr(file_created_at, 1, {}) {} ?{})",
                        prefix.len(),
                        op,
                        next
                    );
                    params.push(Box::new(prefix));
                    next += 1;
                    condition
                })
            }
            MetadataField::Rating => {
                let (op, digits) = if let Some(rest) = value.strip_prefix(">=") {
                    (">=", rest)
                } else if let Some(rest) = value.strip_prefix("<=") {
                    ("<=", rest)
                } else if let Some(rest) = value.strip_prefix('>') {
                    (">", rest)
                } else if let Some(rest) = value.strip_prefix('<') {
                    ("<", rest)
                } else {
                    ("=", value.trim_start_matches('='))
                };
                digits
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .filter(|n| (0..=5).contains(n))
                    .map(|rating| {
                        params.push(Box::new(rating));
                        next += 1;
                        format!("COALESCE(rating, 0) {} ?{}", op, next - 1)
                    })
            }
        };

        match condition {
            Some(condition) if term.negated => conditions.push(format!("NOT {}", condition)),
            Some(condition) => conditions.push(condition),
            None => log::warn!(
                "[search.metadata] ignoring unsupported term field={:?} value={:?}",
                term.field,
                term.value
            ),
        }
    }

    (conditions, params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE assets (id TEXT PRIMARY KEY, original_file_name TEXT NOT NULL, description TEXT,
                original_path TEXT, file_created_at TEXT, asset_type TEXT, is_favorite BOOLEAN DEFAULT 0,
                is_archived BOOLEAN DEFAULT 0, visibility TEXT, rating INTEGER, camera TEXT, lens TEXT,
                file_extension TEXT, people TEXT, tags TEXT, exif_info_json TEXT);
             CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE asset_people (asset_id TEXT, person_id TEXT);
             INSERT INTO assets VALUES ('a','IMG_1.JPG','Beach day','/lib/2023/trip/IMG_1.JPG','2023-07-14T10:00:00.000Z','IMAGE',1,0,'timeline',4,'Sony A7','FE 35mm','jpg','','summer','{\"city\":\"Paris\",\"country\":\"France\",\"make\":\"Sony\"}');
             INSERT INTO assets VALUES ('b','CLIP.MOV',NULL,'/lib/2024/CLIP.MOV','2024-01-02T10:00:00.000Z','VIDEO',0,0,'timeline',0,'iPhone',NULL,'mov','Alice','work','not json');
             INSERT INTO people VALUES ('p1','Bob');
             INSERT INTO asset_people VALUES ('a','p1');",
        )
        .unwrap();
        conn
    }

    fn ids(conn: &Connection, query: &str) -> Vec<String> {
        let (conditions, params) = metadata_query_conditions(
            query,
            1,
            "(UPPER(COALESCE(asset_type, '')) = 'VIDEO')",
            "(LOWER(COALESCE(file_extension, '')) IN ('dng'))",
        );
        let where_clause = if conditions.is_empty() {
            "1=1".to_string()
        } else {
            conditions.join(" AND ")
        };
        let sql = format!("SELECT id FROM assets WHERE {} ORDER BY id", where_clause);
        let mut stmt = conn.prepare(&sql).unwrap();
        let refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
        stmt.query_map(refs.as_slice(), |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn parses_keys_quotes_and_negation() {
        let terms = parse_metadata_query("beach camera:\"EOS R5\" -tag:work 12:30");
        assert_eq!(terms.len(), 4);
        assert_eq!(terms[1].field, MetadataField::Camera);
        assert_eq!(terms[1].value, "EOS R5");
        assert!(terms[2].negated);
        assert_eq!(terms[3].field, MetadataField::Text);
        assert_eq!(terms[3].value, "12:30");
    }

    #[test]
    fn filters_by_structured_terms() {
        let conn = setup();
        assert_eq!(ids(&conn, "paris"), vec!["a"]);
        assert_eq!(ids(&conn, "bob"), vec!["a"]);
        assert_eq!(ids(&conn, "person:alice"), vec!["b"]);
        assert_eq!(ids(&conn, "type:video"), vec!["b"]);
        assert_eq!(ids(&conn, "-type:video"), vec!["a"]);
        assert_eq!(ids(&conn, "after:2024"), vec!["b"]);
        assert_eq!(ids(&conn, "before:2023-07-14"), vec!["a"]);
        assert_eq!(ids(&conn, "date:2023-07"), vec!["a"]);
        assert_eq!(ids(&conn, "rating:>=3 is:favorite"), vec!["a"]);
        assert_eq!(ids(&conn, "path:2024 ext:.mov"), vec!["b"]);
        assert_eq!(ids(&conn, "camera:\"sony a7\" lens:35"), vec!["a"]);
        assert_eq!(ids(&conn, "description:beach"), vec!["a"]);
        assert_eq!(ids(&conn, "name:100%"), Vec::<String>::new());
        assert_eq!(ids(&conn, "after:notadate"), vec!["a", "b"]);
    }
}
