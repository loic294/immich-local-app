use serde::Serialize;

use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub access_token_preview: String,
    pub user_id: String,
}

#[tauri::command]
pub async fn authenticate(
    server_url: String,
    api_key: String,
    state: tauri::State<'_, AppState>,
) -> Result<AuthResponse, String> {
    let session = state
        .immich
        .authenticate_with_key(&server_url, &api_key)
        .await
        .map_err(|err| format!("authentication failed: {err}"))?;

    let preview = session
        .access_token
        .chars()
        .take(8)
        .collect::<String>();

    Ok(AuthResponse {
        access_token_preview: preview,
        user_id: session.user_id,
    })
}
