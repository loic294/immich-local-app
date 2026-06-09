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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthUrlResponse {
    pub authorization_url: String,
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

    let preview = session.access_token.chars().take(8).collect::<String>();

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

    let preview = session.access_token.chars().take(8).collect::<String>();

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

#[tauri::command]
pub async fn get_oauth_authorization_url(
    server_url: String,
    redirect_uri: Option<String>,
    app_state: tauri::State<'_, AppState>,
) -> Result<OAuthUrlResponse, String> {
    let redirect_uri = redirect_uri.unwrap_or_else(|| "app.immich://oauth-callback".to_string());
    println!(
        "[oauth:command:start] server_url={} redirect_uri={}",
        server_url, redirect_uri
    );
    let authorization_url = app_state
        .immich
        .start_oauth(&server_url, &redirect_uri)
        .await
        .map_err(|err| format!("failed to start OAuth: {err}"))?;

    println!(
        "[oauth:command:start] authorization_url={} ",
        authorization_url
    );

    Ok(OAuthUrlResponse { authorization_url })
}

#[tauri::command]
pub async fn complete_oauth_flow(
    server_url: String,
    callback_url: String,
    app_state: tauri::State<'_, AppState>,
) -> Result<AuthResponse, String> {
    println!(
        "[oauth:command:finish] server_url={} callback_url={}",
        server_url, callback_url
    );
    let session = app_state
        .immich
        .finish_oauth(&server_url, &callback_url)
        .await
        .map_err(|err| format!("OAuth authentication failed: {err}"))?;

    // Store the OAuth token and server URL
    app_state
        .db
        .save_oauth_token(&server_url, &session.access_token)
        .map_err(|err| format!("failed to persist OAuth token: {err}"))?;

    let preview = session.access_token.chars().take(8).collect::<String>();
    println!(
        "[oauth:command:finish] success user_id={} user_name={:?}",
        session.user_id, session.user_name
    );

    Ok(AuthResponse {
        access_token_preview: preview,
        user_id: session.user_id,
        user_name: session.user_name,
    })
}
