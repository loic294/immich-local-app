use serde::Serialize;

use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub access_token_preview: String,
    pub user_id: String,
    pub user_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionResponse {
    pub access_token_preview: String,
    pub user_id: String,
    pub user_name: Option<String>,
    pub server_url: String,
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

    state
        .db
        .save_auth_credentials(&server_url, &api_key)
        .map_err(|err| format!("failed to persist credentials: {err}"))?;

    let preview = session
        .access_token
        .chars()
        .take(8)
        .collect::<String>();

    Ok(AuthResponse {
        access_token_preview: preview,
        user_id: session.user_id,
        user_name: session.user_name,
    })
}

#[tauri::command]
pub async fn restore_session(
    state: tauri::State<'_, AppState>,
) -> Result<Option<RestoreSessionResponse>, String> {
    let Some((server_url, api_key)) = state
        .db
        .get_auth_credentials()
        .map_err(|err| format!("failed to read credentials: {err}"))?
    else {
        return Ok(None);
    };

    let session = state
        .immich
        .authenticate_with_key(&server_url, &api_key)
        .await
        .map_err(|err| format!("session restore failed: {err}"))?;

    let preview = session
        .access_token
        .chars()
        .take(8)
        .collect::<String>();

    Ok(Some(RestoreSessionResponse {
        access_token_preview: preview,
        user_id: session.user_id,
        user_name: session.user_name,
        server_url,
    }))
}

#[tauri::command]
pub async fn logout(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .db
        .clear_auth_credentials()
        .map_err(|err| format!("failed to clear credentials: {err}"))?;
    state.immich.clear_session().await;
    Ok(())
}

#[tauri::command]
pub async fn get_profile_image(
    user_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    state
        .immich
        .get_profile_image_data_url(&user_id)
        .await
        .map_err(|err| format!("failed to get profile image: {err}"))
}
