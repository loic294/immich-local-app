use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Local;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

const IMMICH_API_KEY_HEADER: &str = "x-api-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub original_file_name: String,
    pub file_created_at: Option<String>,
    pub checksum: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AssetListResult {
    pub items: Vec<AssetSummary>,
    pub has_next_page: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySummary {
    pub id: String,
    pub title: Option<String>,
    pub memory_at: Option<String>,
    pub year: Option<i32>,
    #[serde(default)]
    pub assets: Vec<AssetSummary>,
}

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub server_url: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
}

pub struct ImmichClient {
    client: reqwest::Client,
    session: Mutex<Option<AuthSession>>,
}

impl ImmichClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            session: Mutex::new(None),
        }
    }

    pub async fn authenticate_with_key(
        &self,
        server_url: &str,
        api_key: &str,
    ) -> Result<AuthSession, String> {
        let url = format!("{}/api/users/me", normalize_base(server_url));
        let mut headers = HeaderMap::new();
        headers.insert(
            IMMICH_API_KEY_HEADER,
            HeaderValue::from_str(api_key).map_err(|err| err.to_string())?,
        );

        let response = self
            .client
            .get(url)
            .headers(headers.clone())
            .send()
            .await
            .map_err(|err| err.to_string())?;

        if !response.status().is_success() {
            return Err(format!("api key validation failed with status {}", response.status()));
        }

        let session = AuthSession {
            server_url: normalize_base(server_url),
            access_token: api_key.to_string(),
            refresh_token: None,
        };

        let mut guard = self.session.lock().await;
        *guard = Some(session.clone());

        Ok(session)
    }

    pub async fn get_assets(
        &self,
        page: u32,
        page_size: u32,
        search_term: Option<&str>,
    ) -> Result<AssetListResult, String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not authenticated".to_string())?;

        self.fetch_assets_inner(&session, page, page_size, search_term)
            .await
    }

    pub async fn get_memories(&self) -> Result<Vec<MemorySummary>, String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not authenticated".to_string())?;

        let mut headers = HeaderMap::new();
        headers.insert(
            IMMICH_API_KEY_HEADER,
            HeaderValue::from_str(&session.access_token).map_err(|err| err.to_string())?,
        );

        let request_date = Local::now().format("%Y-%m-%dT00:00:00").to_string();
        let url = format!("{}/api/memories", session.server_url);

        let response = self
            .client
            .get(url)
            .headers(headers)
            .query(&[("for", request_date.as_str())])
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "memory fetch failed with status {} ({})",
                status,
                truncate_for_log(&body)
            ));
        }

        parse_memories(&body)
    }

    pub async fn get_asset_thumbnail_data_url(&self, asset_id: &str) -> Result<String, String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not authenticated".to_string())?;

        let cache_dir = thumbnail_cache_dir()?;
        fs::create_dir_all(&cache_dir).map_err(|err| err.to_string())?;

        if let Some(cached) = read_cached_thumbnail(&cache_dir, asset_id)? {
            return Ok(cached);
        }

        let mut headers = HeaderMap::new();
        headers.insert(
            IMMICH_API_KEY_HEADER,
            HeaderValue::from_str(&session.access_token).map_err(|err| err.to_string())?,
        );

        let url = format!(
            "{}/api/assets/{}/thumbnail?size=preview",
            session.server_url, asset_id
        );

        let response = self
            .client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "thumbnail request failed for {} with status {}",
                asset_id, status
            ));
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_string();

        let bytes = response.bytes().await.map_err(|err| err.to_string())?;
        let ext = extension_from_mime(&content_type);
        let output = cache_dir.join(format!("{}.{}", asset_id, ext));
        fs::write(&output, bytes.as_ref()).map_err(|err| err.to_string())?;

        Ok(to_data_url(&content_type, bytes.as_ref()))
    }

    async fn fetch_assets_inner(
        &self,
        session: &AuthSession,
        page: u32,
        page_size: u32,
        search_term: Option<&str>,
    ) -> Result<AssetListResult, String> {
        let mut headers = HeaderMap::new();
        headers.insert(
            IMMICH_API_KEY_HEADER,
            HeaderValue::from_str(&session.access_token).map_err(|err| err.to_string())?,
        );

        // Immich metadata search is the canonical paginated endpoint.
        let page_number = page + 1;
        let search_url = format!("{}/api/search/metadata", session.server_url);
        let mut search_payload = serde_json::json!({
            "page": page_number,
            "size": page_size,
            "withExif": true
        });

        if let Some(term) = search_term.map(str::trim).filter(|value| !value.is_empty()) {
            search_payload["originalFileName"] = Value::String(term.to_string());
        }

        let response = self
            .client
            .post(search_url)
            .headers(headers.clone())
            .json(&search_payload)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;

        if status.is_success() {
            if let Ok(mut result) = parse_asset_list(&body) {
                if !result.has_next_page {
                    result.has_next_page = result.items.len() >= page_size as usize;
                }
                return Ok(result);
            }
        }

        // Fallback for variants exposing a flat list endpoint.
        let assets_url = format!(
            "{}/api/assets?page={}&size={}",
            session.server_url, page_number, page_size
        );
        let assets_response = self
            .client
            .get(assets_url)
            .headers(headers)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let assets_status = assets_response.status();
        let assets_body = assets_response.text().await.map_err(|err| err.to_string())?;

        if assets_status.is_success() {
            if let Ok(mut result) = parse_asset_list(&assets_body) {
                if !result.has_next_page {
                    result.has_next_page = result.items.len() >= page_size as usize;
                }
                return Ok(result);
            }
            return Err(format!(
                "unable to parse assets response from /api/assets: {}",
                truncate_for_log(&assets_body)
            ));
        }

        Err(format!(
            "asset fetch failed: /api/search/metadata -> {} ({}), /api/assets -> {} ({})",
            status,
            truncate_for_log(&body),
            assets_status,
            truncate_for_log(&assets_body)
        ))
    }
}

fn parse_asset_list(payload: &str) -> Result<AssetListResult, String> {
    if let Ok(items) = serde_json::from_str::<Vec<AssetSummary>>(payload) {
        return Ok(AssetListResult {
            has_next_page: !items.is_empty(),
            items,
        });
    }

    let value: Value = serde_json::from_str(payload).map_err(|err| err.to_string())?;
    let has_next_page = extract_has_next_page(&value);

    if let Some(items) = value.get("items") {
        let parsed =
            serde_json::from_value::<Vec<AssetSummary>>(items.clone()).map_err(|err| err.to_string())?;
        return Ok(AssetListResult {
            has_next_page,
            items: parsed,
        });
    }

    if let Some(assets) = value.get("assets") {
        if assets.is_array() {
            let parsed =
                serde_json::from_value::<Vec<AssetSummary>>(assets.clone()).map_err(|err| err.to_string())?;
            return Ok(AssetListResult {
                has_next_page,
                items: parsed,
            });
        }

        if let Some(items) = assets.get("items") {
            let parsed = serde_json::from_value::<Vec<AssetSummary>>(items.clone())
                .map_err(|err| err.to_string())?;
            return Ok(AssetListResult {
                has_next_page,
                items: parsed,
            });
        }
    }

    Err("unknown asset payload shape".to_string())
}

fn parse_memories(payload: &str) -> Result<Vec<MemorySummary>, String> {
    if let Ok(mut memories) = serde_json::from_str::<Vec<MemorySummary>>(payload) {
        memories.retain(|memory| !memory.assets.is_empty());
        return Ok(memories);
    }

    let value: Value = serde_json::from_str(payload).map_err(|err| err.to_string())?;
    if let Some(items) = value.get("items") {
        let mut memories =
            serde_json::from_value::<Vec<MemorySummary>>(items.clone()).map_err(|err| err.to_string())?;
        memories.retain(|memory| !memory.assets.is_empty());
        return Ok(memories);
    }

    Err("unknown memories payload shape".to_string())
}

fn extract_has_next_page(value: &Value) -> bool {
    if let Some(next_page) = value.get("nextPage") {
        if !next_page.is_null() {
            return true;
        }
    }

    if let Some(has_next) = value.get("hasNextPage").and_then(Value::as_bool) {
        return has_next;
    }

    if let Some(assets) = value.get("assets") {
        if let Some(next_page) = assets.get("nextPage") {
            if !next_page.is_null() {
                return true;
            }
        }

        if let Some(has_next) = assets.get("hasNextPage").and_then(Value::as_bool) {
            return has_next;
        }
    }

    false
}

fn truncate_for_log(input: &str) -> String {
    const LIMIT: usize = 240;
    if input.len() <= LIMIT {
        input.to_string()
    } else {
        format!("{}...", &input[..LIMIT])
    }
}

fn normalize_base(input: &str) -> String {
    input.trim_end_matches('/').to_string()
}

fn thumbnail_cache_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "cannot resolve home directory".to_string())?;
    Ok(Path::new(&home)
        .join(".config")
        .join("immich-local-app")
        .join("thumbnails"))
}

fn read_cached_thumbnail(cache_dir: &Path, asset_id: &str) -> Result<Option<String>, String> {
    for ext in ["jpg", "jpeg", "webp", "png"] {
        let candidate = cache_dir.join(format!("{}.{}", asset_id, ext));
        if candidate.exists() {
            let data = fs::read(&candidate).map_err(|err| err.to_string())?;
            let content_type = match ext {
                "png" => "image/png",
                "webp" => "image/webp",
                _ => "image/jpeg",
            };
            return Ok(Some(to_data_url(content_type, &data)));
        }
    }

    Ok(None)
}

fn extension_from_mime(content_type: &str) -> &'static str {
    if content_type.contains("png") {
        "png"
    } else if content_type.contains("webp") {
        "webp"
    } else {
        "jpg"
    }
}

fn to_data_url(content_type: &str, bytes: &[u8]) -> String {
    let encoded = STANDARD.encode(bytes);
    format!("data:{};base64,{}", content_type, encoded)
}
