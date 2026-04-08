use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Local;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const IMMICH_API_KEY_HEADER: &str = "x-api-key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStatistics {
    pub total: i32,
    #[serde(default)]
    pub photos: Option<i32>,
    #[serde(default)]
    pub videos: Option<i32>,
    #[serde(default)]
    pub archived: Option<i32>,
    #[serde(default)]
    pub favorites: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub id: String,
    pub original_file_name: String,
    #[serde(default)]
    pub original_path: Option<String>,
    pub file_created_at: Option<String>,
    pub checksum: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub duration: Option<String>,
    #[serde(default)]
    pub live_photo_video_id: Option<String>,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub rating: Option<i32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub thumbhash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMetadata {
    #[serde(default)]
    pub original_path: Option<String>,
    #[serde(default)]
    pub rating: Option<i32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub camera: Option<String>,
    #[serde(default)]
    pub lens: Option<String>,
    #[serde(default)]
    pub file_size_bytes: Option<i64>,
    #[serde(default)]
    pub file_extension: Option<String>,
    #[serde(default)]
    pub people: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub exif_info_json: Option<String>,
    #[serde(default)]
    pub person_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonSummary {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub is_hidden: bool,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumOwnerSummary {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSummary {
    pub id: String,
    pub album_name: String,
    pub album_thumbnail_asset_id: Option<String>,
    pub owner_id: String,
    #[serde(default)]
    pub shared: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub asset_count: Option<u32>,
    pub owner: Option<AlbumOwnerSummary>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub server_url: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub user_id: String,
    pub user_name: Option<String>,
}

pub struct ImmichClient {
    client: reqwest::Client,
    session: Mutex<Option<AuthSession>>,
    playback_downloads: Arc<Mutex<HashSet<String>>>,
    cached_album: Mutex<Option<(String, Vec<AssetSummary>)>>,
    cached_folder: Mutex<Option<(String, Vec<AssetSummary>)>>,
}

impl ImmichClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            session: Mutex::new(None),
            playback_downloads: Arc::new(Mutex::new(HashSet::new())),
            cached_album: Mutex::new(None),
            cached_folder: Mutex::new(None),
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

        let body = response.text().await.map_err(|err| err.to_string())?;
        let value: Value = serde_json::from_str(&body).map_err(|err| err.to_string())?;
        let user_id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "authentication response missing user id".to_string())?
            .to_string();
        let user_name = value
            .get("name")
            .and_then(Value::as_str)
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());

        let session = AuthSession {
            server_url: normalize_base(server_url),
            access_token: api_key.to_string(),
            refresh_token: None,
            user_id,
            user_name,
        };

        let mut guard = self.session.lock().await;
        *guard = Some(session.clone());

        Ok(session)
    }

    pub async fn clear_session(&self) {
        let mut guard = self.session.lock().await;
        *guard = None;

        let mut album_cache = self.cached_album.lock().await;
        *album_cache = None;

        let mut folder_cache = self.cached_folder.lock().await;
        *folder_cache = None;
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

    pub async fn get_assets_by_month(&self, year: i32, month: u32) -> Result<Vec<AssetSummary>, String> {        let session = self
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

        let (next_year, next_month) = if month == 12 {
            (year + 1, 1u32)
        } else {
            (year, month + 1)
        };
        let taken_after = format!("{}-{:02}-01T00:00:00.000Z", year, month);
        let taken_before = format!("{}-{:02}-01T00:00:00.000Z", next_year, next_month);

        let search_url = format!("{}/api/search/metadata", session.server_url);
        let mut all_items: Vec<AssetSummary> = Vec::new();
        let page_size = 1000u32;
        let mut current_page = 1u32;

        loop {
            let search_payload = serde_json::json!({
                "page": current_page,
                "size": page_size,
                "withExif": true,
                "takenAfter": taken_after,
                "takenBefore": taken_before,
            });

            let response = self
                .client
                .post(&search_url)
                .headers(headers.clone())
                .json(&search_payload)
                .send()
                .await
                .map_err(|err| err.to_string())?;

            let status = response.status();
            let body = response.text().await.map_err(|err| err.to_string())?;

            if !status.is_success() {
                return Err(format!(
                    "fetch assets by month failed with status {} ({})",
                    status,
                    truncate_for_log(&body)
                ));
            }

            let result = parse_asset_list(&body)?;
            let has_more = result.has_next_page || result.items.len() >= page_size as usize;
            all_items.extend(result.items);

            if !has_more {
                break;
            }
            current_page += 1;
        }

        Ok(all_items)
    }

    pub async fn get_album_assets_paged(
        &self,
        album_id: &str,
        page: u32,
        page_size: u32,
    ) -> Result<AssetListResult, String> {
        let needs_fetch = {
            let cache = self.cached_album.lock().await;
            cache.as_ref().map_or(true, |(cached_album_id, _)| cached_album_id != album_id)
        };

        if needs_fetch {
            let assets = self.get_album_assets(album_id).await?;
            let mut cache = self.cached_album.lock().await;
            *cache = Some((album_id.to_string(), assets));
        }

        let cache = self.cached_album.lock().await;
        let all_assets = &cache.as_ref().unwrap().1;
        let total = all_assets.len();
        let start = (page as usize) * (page_size as usize);
        let items: Vec<AssetSummary> = all_assets
            .iter()
            .skip(start)
            .take(page_size as usize)
            .cloned()
            .collect();
        let has_next_page = start + items.len() < total;

        Ok(AssetListResult {
            items,
            has_next_page,
        })
    }

    pub async fn get_calendar_assets_paged(
        &self,
        year: i32,
        month: u32,
        page: u32,
        page_size: u32,
    ) -> Result<AssetListResult, String> {
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

        let (next_year, next_month) = if month == 12 {
            (year + 1, 1u32)
        } else {
            (year, month + 1)
        };
        let taken_after = format!("{}-{:02}-01T00:00:00.000Z", year, month);
        let taken_before = format!("{}-{:02}-01T00:00:00.000Z", next_year, next_month);

        let page_number = page + 1;
        let search_url = format!("{}/api/search/metadata", session.server_url);
        let search_payload = serde_json::json!({
            "takenAfter": taken_after,
            "takenBefore": taken_before,
            "page": page_number,
            "size": page_size,
            "withExif": true,
        });

        let response = self
            .client
            .post(&search_url)
            .headers(headers)
            .json(&search_payload)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;

        if !status.is_success() {
            return Err(format!(
                "calendar asset search failed with status {} ({})",
                status,
                truncate_for_log(&body)
            ));
        }

        let mut result = parse_asset_list(&body)?;
        if !result.has_next_page {
            result.has_next_page = result.items.len() >= page_size as usize;
        }
        Ok(result)
    }

    pub async fn get_folder_assets_paged(
        &self,
        path: &str,
        page: u32,
        page_size: u32,
    ) -> Result<AssetListResult, String> {
        // Check if we need to (re)fetch all folder assets
        let needs_fetch = {
            let cache = self.cached_folder.lock().await;
            cache.as_ref().map_or(true, |(cached_path, _)| cached_path != path)
        };

        if needs_fetch {
            let assets = self.get_assets_by_original_path(path).await?;
            let mut cache = self.cached_folder.lock().await;
            *cache = Some((path.to_string(), assets));
        }

        let cache = self.cached_folder.lock().await;
        let all_assets = &cache.as_ref().unwrap().1;
        let total = all_assets.len();
        let start = (page as usize) * (page_size as usize);
        let items: Vec<AssetSummary> = all_assets
            .iter()
            .skip(start)
            .take(page_size as usize)
            .cloned()
            .collect();
        let has_next_page = start + items.len() < total;

        Ok(AssetListResult {
            items,
            has_next_page,
        })
    }

    pub async fn get_asset(&self, asset_id: &str) -> Result<AssetSummary, String> {
        let value = self.get_asset_value(asset_id).await?;
        parse_asset_summary_from_value(&value)
    }

    pub async fn get_asset_metadata(&self, asset_id: &str) -> Result<AssetMetadata, String> {
        let value = self.get_asset_value(asset_id).await?;
        Ok(parse_asset_metadata_from_value(&value))
    }

    async fn get_asset_value(&self, asset_id: &str) -> Result<Value, String> {
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

        let endpoints = [
            format!("{}/api/assets/{}", session.server_url, asset_id),
            format!("{}/api/asset/{}", session.server_url, asset_id),
        ];

        let mut last_error: Option<String> = None;

        for url in endpoints {
            let response = self
                .client
                .get(&url)
                .headers(headers.clone())
                .send()
                .await
                .map_err(|err| err.to_string())?;

            let status = response.status();
            let body = response.text().await.map_err(|err| err.to_string())?;

            if status.is_success() {
                return serde_json::from_str::<Value>(&body).map_err(|err| err.to_string());
            }

            last_error = Some(format!(
                "fetch asset failed: {} -> {} ({})",
                url,
                status,
                truncate_for_log(&body)
            ));
        }

        Err(last_error.unwrap_or_else(|| "fetch asset failed".to_string()))
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

    pub async fn get_albums(&self) -> Result<Vec<AlbumSummary>, String> {
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

        let owned_url = format!("{}/api/albums", session.server_url);
        let shared_url = format!("{}/api/albums", session.server_url);

        let owned_response = self
            .client
            .get(owned_url)
            .headers(headers.clone())
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let owned_status = owned_response.status();
        let owned_body = owned_response.text().await.map_err(|err| err.to_string())?;
        if !owned_status.is_success() {
            return Err(format!(
                "album fetch failed with status {} ({})",
                owned_status,
                truncate_for_log(&owned_body)
            ));
        }

        let shared_response = self
            .client
            .get(shared_url)
            .headers(headers)
            .query(&[("shared", "true")])
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let shared_status = shared_response.status();
        let shared_body = shared_response.text().await.map_err(|err| err.to_string())?;
        if !shared_status.is_success() {
            return Err(format!(
                "shared album fetch failed with status {} ({})",
                shared_status,
                truncate_for_log(&shared_body)
            ));
        }

        let mut albums = parse_album_list(&owned_body)?;
        let shared_albums = parse_album_list(&shared_body)?;

        let mut seen = HashSet::new();
        albums.retain(|album| seen.insert(album.id.clone()));
        for album in shared_albums {
            if seen.insert(album.id.clone()) {
                albums.push(album);
            }
        }

        Ok(albums)
    }

    pub async fn get_unique_original_paths(&self) -> Result<Vec<String>, String> {
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

        let url = format!("{}/api/view/folder/unique-paths", session.server_url);
        let response = self
            .client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "folder path fetch failed with status {} ({})",
                status,
                truncate_for_log(&body)
            ));
        }

        serde_json::from_str::<Vec<String>>(&body).map_err(|err| err.to_string())
    }

    pub async fn get_all_people(&self) -> Result<Vec<PersonSummary>, String> {
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

        let url = format!("{}/api/people", session.server_url);
        let mut page = 1u32;
        let page_size = 1000u32;
        let mut all_people: Vec<PersonSummary> = Vec::new();

        loop {
            let response = self
                .client
                .get(&url)
                .headers(headers.clone())
                .query(&[
                    ("page", page.to_string()),
                    ("size", page_size.to_string()),
                    ("withHidden", "true".to_string()),
                ])
                .send()
                .await
                .map_err(|err| err.to_string())?;

            let status = response.status();
            let body = response.text().await.map_err(|err| err.to_string())?;

            if !status.is_success() {
                return Err(format!(
                    "get all people failed with status {} ({})",
                    status,
                    truncate_for_log(&body)
                ));
            }

            let value: Value = serde_json::from_str(&body).map_err(|err| err.to_string())?;
            let people_items = value
                .get("people")
                .and_then(Value::as_array)
                .map(|items| items.as_slice())
                .unwrap_or(&[]);

            let mut parsed_page: Vec<PersonSummary> = Vec::new();
            for person in people_items {
                let id = person
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "person missing id".to_string())?
                    .to_string();

                parsed_page.push(PersonSummary {
                    id,
                    name: person
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    is_hidden: person
                        .get("isHidden")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    thumbnail_path: person
                        .get("thumbnailPath")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            }

            let parsed_count = parsed_page.len();
            all_people.extend(parsed_page);

            let has_next = value
                .get("hasNextPage")
                .and_then(Value::as_bool)
                .unwrap_or(parsed_count >= page_size as usize);

            if !has_next || parsed_count == 0 {
                break;
            }

            page += 1;
        }

        Ok(all_people)
    }

    pub async fn get_album_assets(&self, album_id: &str) -> Result<Vec<AssetSummary>, String> {
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

        let url = format!("{}/api/albums/{}", session.server_url, album_id);
        let response = self
            .client
            .get(url)
            .headers(headers)
            .query(&[("withoutAssets", "false")])
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "album detail fetch failed with status {} ({})",
                status,
                truncate_for_log(&body)
            ));
        }

        parse_album_assets(&body)
    }

    pub async fn get_assets_by_original_path(&self, path: &str) -> Result<Vec<AssetSummary>, String> {
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

        let url = format!("{}/api/view/folder", session.server_url);
        let response = self
            .client
            .get(url)
            .headers(headers)
            .query(&[("path", path)])
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "folder asset fetch failed with status {} ({})",
                status,
                truncate_for_log(&body)
            ));
        }

        let result = parse_asset_list(&body)?;
        Ok(result.items)
    }

    pub async fn get_profile_image_data_url(&self, user_id: &str) -> Result<Option<String>, String> {
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

        let url = format!("{}/api/users/{}/profile-image", session.server_url, user_id);
        let response = self
            .client
            .get(url)
            .headers(headers)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(format!(
                "profile image request failed for {} with status {}",
                user_id, status
            ));
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_string();

        let bytes = response.bytes().await.map_err(|err| err.to_string())?;
        if bytes.is_empty() {
            return Ok(None);
        }

        Ok(Some(to_data_url(&content_type, bytes.as_ref())))
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

    pub async fn get_asset_playback_file_path(&self, asset_id: &str) -> Result<String, String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not authenticated".to_string())?;

        let cache_dir = video_cache_dir()?;
        fs::create_dir_all(&cache_dir).map_err(|err| err.to_string())?;

        if let Some(cached_path) = read_cached_video_path(&cache_dir, asset_id)? {
            return Ok(cached_path);
        }

        let output_path = cache_dir.join(format!("{}.mp4", asset_id));
        if !output_path.exists() {
            let _ = fs::File::create(&output_path).map_err(|err| err.to_string())?;
        }

        let should_spawn = {
            let mut downloads = self.playback_downloads.lock().await;
            downloads.insert(asset_id.to_string())
        };

        if should_spawn {
            let client = self.client.clone();
            let access_token = session.access_token.clone();
            let server_url = session.server_url.clone();
            let asset_id_string = asset_id.to_string();
            let path_for_download = output_path.clone();
            let downloads = Arc::clone(&self.playback_downloads);

            tokio::spawn(async move {
                let mut headers = HeaderMap::new();
                if let Ok(header_value) = HeaderValue::from_str(&access_token) {
                    headers.insert(IMMICH_API_KEY_HEADER, header_value);
                } else {
                    let mut guard = downloads.lock().await;
                    guard.remove(&asset_id_string);
                    return;
                }

                let url = format!(
                    "{}/api/assets/{}/video/playback",
                    server_url, asset_id_string
                );

                let response_result = client.get(url).headers(headers).send().await;
                let mut response = match response_result {
                    Ok(value) => value,
                    Err(_) => {
                        let mut guard = downloads.lock().await;
                        guard.remove(&asset_id_string);
                        return;
                    }
                };

                if !response.status().is_success() {
                    let mut guard = downloads.lock().await;
                    guard.remove(&asset_id_string);
                    return;
                }

                let file_result = tokio::fs::File::create(&path_for_download).await;
                let mut file = match file_result {
                    Ok(value) => value,
                    Err(_) => {
                        let mut guard = downloads.lock().await;
                        guard.remove(&asset_id_string);
                        return;
                    }
                };

                while let Ok(Some(chunk)) = response.chunk().await {
                    if file.write_all(&chunk).await.is_err() {
                        break;
                    }
                }

                let _ = file.flush().await;

                let mut guard = downloads.lock().await;
                guard.remove(&asset_id_string);
            });
        }

        Ok(output_path.to_string_lossy().to_string())
    }

    pub async fn update_asset_favorite(
        &self,
        asset_id: &str,
        is_favorite: bool,
    ) -> Result<AssetSummary, String> {
        let payload = serde_json::json!({
            "isFavorite": is_favorite,
        });

        self.update_asset_inner(asset_id, payload).await
    }

    pub async fn update_asset_visibility(
        &self,
        asset_id: &str,
        visibility: &str,
    ) -> Result<AssetSummary, String> {
        let payload = serde_json::json!({
            "visibility": visibility,
        });

        self.update_asset_inner(asset_id, payload).await
    }

    pub async fn update_asset_rating(
        &self,
        asset_id: &str,
        rating: Option<i32>,
    ) -> Result<AssetSummary, String> {
        let payload = serde_json::json!({
            "rating": rating,
        });

        self.update_asset_inner(asset_id, payload).await
    }

    pub async fn get_asset_statistics(&self) -> Result<AssetStatistics, String> {
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

        let url = format!("{}/api/assets/statistics", session.server_url);
        let response = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;

        if !status.is_success() {
            return Err(format!(
                "get asset statistics failed with status {} ({})",
                status,
                truncate_for_log(&body)
            ));
        }

        serde_json::from_str(&body).map_err(|err| {
            format!("failed to parse asset statistics: {}", err)
        })
    }

    pub async fn get_all_assets_paginated(
        &self,
        page: u32,
        page_size: u32,
    ) -> Result<AssetListResult, String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "not authenticated".to_string())?;

        self.fetch_assets_inner(&session, page, page_size, None)
            .await
    }

    async fn update_asset_inner(
        &self,
        asset_id: &str,
        payload: Value,
    ) -> Result<AssetSummary, String> {
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

        // First, try to verify the asset exists with a GET request
        let get_url = format!("{}/api/asset/{}", session.server_url, asset_id);
        eprintln!("[update_asset_inner] Verifying asset exists with GET: {}", get_url);
        
        let get_response = self
            .client
            .get(&get_url)
            .headers(headers.clone())
            .send()
            .await
            .map_err(|err| err.to_string())?;
        
        let get_status = get_response.status();
        eprintln!("[update_asset_inner] GET response status: {}", get_status);
        
        if get_status == 404 {
            eprintln!("[update_asset_inner] Asset not found with GET /api/asset/, trying /api/assets/");
            let get_url_plural = format!("{}/api/assets/{}", session.server_url, asset_id);
            let get_response_plural = self
                .client
                .get(&get_url_plural)
                .headers(headers.clone())
                .send()
                .await
                .map_err(|err| err.to_string())?;
            eprintln!("[update_asset_inner] GET /api/assets/ response status: {}", get_response_plural.status());
        }

        // Try PATCH on singular endpoint
        eprintln!("[update_asset_inner] Trying PATCH /api/asset/{}", asset_id);
        let url = format!("{}/api/asset/{}", session.server_url, asset_id);
        
        let response = self
            .client
            .patch(&url)
            .headers(headers.clone())
            .json(&payload)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;
        
        eprintln!("[update_asset_inner] PATCH /api/asset/ status: {}", status);
        eprintln!("[update_asset_inner] PATCH /api/asset/ body: {}", truncate_for_log(&body));
        
        if status == 404 {
            eprintln!("[update_asset_inner] PATCH /api/asset/ returned 404, trying PUT /api/asset/");
            
            let response = self
                .client
                .put(&url)
                .headers(headers.clone())
                .json(&payload)
                .send()
                .await
                .map_err(|err| err.to_string())?;

            let status = response.status();
            let body = response.text().await.map_err(|err| err.to_string())?;
            
            eprintln!("[update_asset_inner] PUT /api/asset/ status: {}", status);
            eprintln!("[update_asset_inner] PUT /api/asset/ body: {}", truncate_for_log(&body));
            
            if status == 404 {
                eprintln!("[update_asset_inner] PUT /api/asset/ returned 404, trying PATCH /api/assets/");
                
                let url_plural = format!("{}/api/assets/{}", session.server_url, asset_id);
                let response = self
                    .client
                    .patch(url_plural.clone())
                    .headers(headers.clone())
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|err| err.to_string())?;

                let status = response.status();
                let body = response.text().await.map_err(|err| err.to_string())?;
                
                eprintln!("[update_asset_inner] PATCH /api/assets/ status: {}", status);
                eprintln!("[update_asset_inner] PATCH /api/assets/ body: {}", truncate_for_log(&body));
                
                if status == 404 {
                    eprintln!("[update_asset_inner] PATCH /api/assets/ returned 404, trying PUT /api/assets/");
                    
                    let response = self
                        .client
                        .put(url_plural)
                        .headers(headers)
                        .json(&payload)
                        .send()
                        .await
                        .map_err(|err| err.to_string())?;

                    let status = response.status();
                    let body = response.text().await.map_err(|err| err.to_string())?;
                    
                    eprintln!("[update_asset_inner] PUT /api/assets/ status: {}", status);
                    eprintln!("[update_asset_inner] PUT /api/assets/ body: {}", truncate_for_log(&body));
                    
                    if !status.is_success() {
                        return Err(format!(
                            "asset update failed with status {} after trying all endpoints ({})",
                            status,
                            truncate_for_log(&body)
                        ));
                    }
                    
                    return parse_asset_summary_from_value(
                        &serde_json::from_str::<Value>(&body).map_err(|err| err.to_string())?,
                    );
                }
                
                if !status.is_success() {
                    return Err(format!(
                        "asset update failed with status {} ({})",
                        status,
                        truncate_for_log(&body)
                    ));
                }
                
                return parse_asset_summary_from_value(
                    &serde_json::from_str::<Value>(&body).map_err(|err| err.to_string())?,
                );
            }
            
            if !status.is_success() {
                return Err(format!(
                    "asset update failed with status {} ({})",
                    status,
                    truncate_for_log(&body)
                ));
            }
            
            return parse_asset_summary_from_value(
                &serde_json::from_str::<Value>(&body).map_err(|err| err.to_string())?,
            );
        }
        
        if !status.is_success() {
            return Err(format!(
                "asset update failed with status {} ({})",
                status,
                truncate_for_log(&body)
            ));
        }

        parse_asset_summary_from_value(
            &serde_json::from_str::<Value>(&body).map_err(|err| err.to_string())?,
        )
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
            items: items.into_iter().map(normalize_asset_summary).collect(),
        });
    }

    let value: Value = serde_json::from_str(payload).map_err(|err| err.to_string())?;
    let has_next_page = extract_has_next_page(&value);

    if let Some(items) = value.get("items") {
        let parsed = parse_asset_array(items)?;
        return Ok(AssetListResult {
            has_next_page,
            items: parsed,
        });
    }

    if let Some(assets) = value.get("assets") {
        if assets.is_array() {
            let parsed = parse_asset_array(assets)?;
            return Ok(AssetListResult {
                has_next_page,
                items: parsed,
            });
        }

        if let Some(items) = assets.get("items") {
            let parsed = parse_asset_array(items)?;
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

fn parse_album_list(payload: &str) -> Result<Vec<AlbumSummary>, String> {
    if let Ok(items) = serde_json::from_str::<Vec<AlbumSummary>>(payload) {
        return Ok(items);
    }

    let value: Value = serde_json::from_str(payload).map_err(|err| err.to_string())?;
    if let Some(items) = value.get("items") {
        return serde_json::from_value::<Vec<AlbumSummary>>(items.clone()).map_err(|err| err.to_string());
    }

    Err("unknown album payload shape".to_string())
}

fn parse_album_assets(payload: &str) -> Result<Vec<AssetSummary>, String> {
    let value: Value = serde_json::from_str(payload).map_err(|err| err.to_string())?;
    let assets = value
        .get("assets")
        .ok_or_else(|| "album response missing assets".to_string())?;

    if assets.is_array() {
        return parse_asset_array(assets);
    }

    if let Some(items) = assets.get("items") {
        return parse_asset_array(items);
    }

    Err("unknown album assets payload shape".to_string())
}

fn parse_asset_array(value: &Value) -> Result<Vec<AssetSummary>, String> {
    let array = value
        .as_array()
        .ok_or_else(|| "asset payload is not an array".to_string())?;

    let mut result = Vec::with_capacity(array.len());
    for item in array {
        if let Ok(parsed) = serde_json::from_value::<AssetSummary>(item.clone()) {
            result.push(enrich_asset_summary_from_value(parsed, item));
            continue;
        }

        result.push(parse_asset_summary_from_value(item)?);
    }

    Ok(result)
}

fn enrich_asset_summary_from_value(mut asset: AssetSummary, value: &Value) -> AssetSummary {
    if asset.r#type.is_none() {
        asset.r#type = value
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| value.get("assetType").and_then(Value::as_str))
            .map(str::to_string);
    }

    if asset.duration.is_none() {
        asset.duration = value
            .get("duration")
            .and_then(value_to_string)
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("duration"))
                    .and_then(value_to_string)
            })
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("videoDurationInSeconds"))
                    .and_then(value_to_string)
            });
    }

    if asset.width.is_none() {
        asset.width = value
            .get("exifInfo")
            .and_then(|v| v.get("imageWidth"))
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("exifImageWidth"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            })
            .or_else(|| value.get("width").and_then(Value::as_u64).map(|v| v as u32));
    }

    if asset.height.is_none() {
        asset.height = value
            .get("exifInfo")
            .and_then(|v| v.get("imageHeight"))
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("exifImageHeight"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            })
            .or_else(|| value.get("height").and_then(Value::as_u64).map(|v| v as u32));
    }

    if asset.original_path.is_none() {
        asset.original_path = value
            .get("originalPath")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    if asset.thumbhash.is_none() {
        asset.thumbhash = value
            .get("thumbhash")
            .and_then(Value::as_str)
            .or_else(|| value.get("thumbHash").and_then(Value::as_str))
            .map(str::to_string);
    }

    normalize_asset_summary(asset)
}

fn parse_asset_summary_from_value(value: &Value) -> Result<AssetSummary, String> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "asset missing id".to_string())?
        .to_string();

    let original_file_name = value
        .get("originalFileName")
        .and_then(Value::as_str)
        .or_else(|| value.get("filename").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_string();

    let file_created_at = value
        .get("fileCreatedAt")
        .and_then(Value::as_str)
        .map(str::to_string);

    let checksum = value
        .get("checksum")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut asset = AssetSummary {
        id,
        original_file_name,
        original_path: value
            .get("originalPath")
            .and_then(Value::as_str)
            .map(str::to_string),
        file_created_at,
        checksum,
        r#type: value
            .get("type")
            .and_then(Value::as_str)
            .or_else(|| value.get("assetType").and_then(Value::as_str))
            .map(str::to_string),
        duration: value
            .get("duration")
            .and_then(value_to_string)
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("duration"))
                    .and_then(value_to_string)
            })
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("videoDurationInSeconds"))
                    .and_then(value_to_string)
            }),
        live_photo_video_id: value
            .get("livePhotoVideoId")
            .and_then(Value::as_str)
            .map(str::to_string),
        is_favorite: value
            .get("isFavorite")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_archived: value
            .get("isArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        visibility: value
            .get("visibility")
            .and_then(Value::as_str)
            .map(str::to_string),
        rating: value
            .get("exifInfo")
            .and_then(|v| v.get("rating"))
            .and_then(Value::as_i64)
            .map(|rating| rating as i32),
        width: value
            .get("exifInfo")
            .and_then(|v| v.get("imageWidth"))
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("exifImageWidth"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            })
            .or_else(|| value.get("width").and_then(Value::as_u64).map(|v| v as u32)),
        height: value
            .get("exifInfo")
            .and_then(|v| v.get("imageHeight"))
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .or_else(|| {
                value
                    .get("exifInfo")
                    .and_then(|v| v.get("exifImageHeight"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            })
            .or_else(|| value.get("height").and_then(Value::as_u64).map(|v| v as u32)),
            thumbhash: value
                .get("thumbhash")
                .and_then(Value::as_str)
                .or_else(|| value.get("thumbHash").and_then(Value::as_str))
                .map(str::to_string),
    };

    asset = normalize_asset_summary(asset);
    Ok(asset)
}

fn normalize_asset_summary(mut asset: AssetSummary) -> AssetSummary {
    if asset.r#type.is_none() {
        let lower = asset.original_file_name.to_lowercase();
        if lower.ends_with(".mp4")
            || lower.ends_with(".mov")
            || lower.ends_with(".webm")
            || lower.ends_with(".m4v")
            || lower.ends_with(".mkv")
            || lower.ends_with(".avi")
        {
            asset.r#type = Some("VIDEO".to_string());
        }
    }

    asset
}

fn parse_asset_metadata_from_value(value: &Value) -> AssetMetadata {
    let exif_info = value.get("exifInfo");
    let original_path = value
        .get("originalPath")
        .and_then(Value::as_str)
        .map(str::to_string);

    let file_extension = original_path
        .as_deref()
        .and_then(|path| Path::new(path).extension().and_then(|ext| ext.to_str()))
        .or_else(|| {
            value
                .get("originalFileName")
                .and_then(Value::as_str)
                .and_then(|name| Path::new(name).extension().and_then(|ext| ext.to_str()))
        })
        .map(|ext| ext.to_ascii_lowercase());

    let people_items = extract_items_array(value.get("people"));
    let tags_items = extract_items_array(value.get("tags"));
    let (people, person_ids) = extract_people_data(people_items);

    AssetMetadata {
        original_path,
        rating: exif_info
            .and_then(|v| v.get("rating"))
            .and_then(Value::as_i64)
            .map(|v| v as i32)
            .or_else(|| value.get("rating").and_then(Value::as_i64).map(|v| v as i32)),
        width: value
            .get("width")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .or_else(|| {
                exif_info
                    .and_then(|v| v.get("imageWidth"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            })
            .or_else(|| {
                exif_info
                    .and_then(|v| v.get("exifImageWidth"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            }),
        height: value
            .get("height")
            .and_then(Value::as_u64)
            .map(|v| v as u32)
            .or_else(|| {
                exif_info
                    .and_then(|v| v.get("imageHeight"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            })
            .or_else(|| {
                exif_info
                    .and_then(|v| v.get("exifImageHeight"))
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
            }),
        camera: exif_info
            .and_then(|v| v.get("model"))
            .and_then(Value::as_str)
            .or_else(|| exif_info.and_then(|v| v.get("cameraModel")).and_then(Value::as_str))
            .map(str::to_string),
        lens: exif_info
            .and_then(|v| v.get("lensModel"))
            .and_then(Value::as_str)
            .map(str::to_string),
        file_size_bytes: exif_info
            .and_then(|v| v.get("fileSizeInByte"))
            .and_then(Value::as_i64)
            .or_else(|| {
                exif_info
                    .and_then(|v| v.get("fileSizeInByte"))
                    .and_then(Value::as_u64)
                    .map(|v| v as i64)
            })
            .or_else(|| value.get("sizeInBytes").and_then(Value::as_i64))
            .or_else(|| value.get("sizeInBytes").and_then(Value::as_u64).map(|v| v as i64)),
        file_extension,
        people,
        tags: extract_name_list(tags_items, &["name", "value"], &[]),
        exif_info_json: exif_info.and_then(|data| {
            if data.is_null() {
                None
            } else {
                serde_json::to_string(data).ok()
            }
        }),
        person_ids,
    }
}

fn extract_people_data(items: &[Value]) -> (Option<String>, Vec<String>) {
    let mut names: Vec<String> = Vec::new();
    let mut ids: Vec<String> = Vec::new();

    for item in items {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            let trimmed_id = id.trim();
            if !trimmed_id.is_empty() {
                ids.push(trimmed_id.to_string());
            }
        }

        if let Some(name) = item.get("name").and_then(Value::as_str) {
            let trimmed_name = name.trim();
            if !trimmed_name.is_empty() {
                names.push(trimmed_name.to_string());
            }
        }

        if let Some(person) = item.get("person") {
            if let Some(id) = person.get("id").and_then(Value::as_str) {
                let trimmed_id = id.trim();
                if !trimmed_id.is_empty() {
                    ids.push(trimmed_id.to_string());
                }
            }

            if let Some(name) = person.get("name").and_then(Value::as_str) {
                let trimmed_name = name.trim();
                if !trimmed_name.is_empty() {
                    names.push(trimmed_name.to_string());
                }
            }
        }
    }

    names.sort_unstable();
    names.dedup();
    ids.sort_unstable();
    ids.dedup();

    let people = if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    };

    (people, ids)
}

fn extract_items_array<'a>(value: Option<&'a Value>) -> &'a [Value] {
    if let Some(items) = value.and_then(Value::as_array) {
        return items.as_slice();
    }

    if let Some(items) = value
        .and_then(|v| v.get("items"))
        .and_then(Value::as_array)
    {
        return items.as_slice();
    }

    &[]
}

fn extract_name_list(items: &[Value], direct_keys: &[&str], nested_object_keys: &[&str]) -> Option<String> {
    let mut names: Vec<String> = Vec::new();

    for item in items {
        if let Some(name) = item.as_str() {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                names.push(trimmed.to_string());
                continue;
            }
        }

        for key in direct_keys {
            if let Some(name) = item.get(*key).and_then(Value::as_str) {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    names.push(trimmed.to_string());
                    break;
                }
            }
        }

        for nested_key in nested_object_keys {
            if let Some(obj) = item.get(*nested_key) {
                for key in direct_keys {
                    if let Some(name) = obj.get(*key).and_then(Value::as_str) {
                        let trimmed = name.trim();
                        if !trimmed.is_empty() {
                            names.push(trimmed.to_string());
                            break;
                        }
                    }
                }
            }
        }
    }

    if names.is_empty() {
        return None;
    }

    names.sort_unstable();
    names.dedup();
    Some(names.join(", "))
}

fn value_to_string(value: &Value) -> Option<String> {
    if let Some(string_value) = value.as_str() {
        return Some(string_value.to_string());
    }

    value
        .as_f64()
        .map(|number| number.to_string())
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

    fn video_cache_dir() -> Result<PathBuf, String> {
        let home = std::env::var("HOME").map_err(|_| "cannot resolve home directory".to_string())?;
        Ok(Path::new(&home)
        .join(".config")
        .join("immich-local-app")
        .join("videos"))
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

fn read_cached_video_path(cache_dir: &Path, asset_id: &str) -> Result<Option<String>, String> {
    for ext in ["mp4", "webm", "mov", "m4v"] {
        let candidate = cache_dir.join(format!("{}.{}", asset_id, ext));
        if candidate.exists() {
            return Ok(Some(candidate.to_string_lossy().to_string()));
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
