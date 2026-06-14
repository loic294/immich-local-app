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
    /// `true` when the session was restored from the local cache because the
    /// server was unreachable. The app should enter offline mode and render
    /// cached content rather than failing.
    pub offline: bool,
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

    // Persist the user identity so the session can be restored offline.
    if let Err(err) = state
        .db
        .save_user_info(&session.user_id, session.user_name.as_deref())
    {
        log::warn!("[auth:authenticate] failed to persist user info: {err}");
    }

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
    let Some((server_url, token, is_oauth)) = state
        .db
        .get_auth_credentials()
        .map_err(|err| format!("failed to read credentials: {err}"))?
    else {
        return Ok(None);
    };

    log::info!(
        "[auth:restore] restoring session for server_url={} (oauth={})",
        server_url, is_oauth
    );

    // Local-first: if the server is unreachable, restore the session from the
    // cached user identity so the app can open offline. We only fall back to the
    // login screen when the server is reachable AND rejects the credentials.
    if !state.immich.ping(&server_url).await {
        log::warn!("[auth:restore] server unreachable — entering offline mode");
        let Some((user_id, user_name)) = state
            .db
            .get_user_info()
            .map_err(|err| format!("failed to read cached user info: {err}"))?
        else {
            // No cached identity to restore offline — require a fresh login.
            log::warn!("[auth:restore] offline and no cached user info — login required");
            return Ok(None);
        };

        // Hydrate the in-memory session from cached credentials (without
        // contacting the server) so authenticated cache reads (thumbnails) work
        // offline and requests are ready once connectivity returns.
        if let Err(err) = state
            .immich
            .hydrate_offline_session(&server_url, &token, is_oauth, &user_id, user_name.clone())
            .await
        {
            log::warn!("[auth:restore] failed to hydrate offline session: {err}");
        }

        return Ok(Some(RestoreSessionResponse {
            access_token_preview: token.chars().take(8).collect::<String>(),
            user_id,
            user_name,
            server_url,
            offline: true,
        }));
    }

    // OAuth session tokens authenticate via the session cookie, API keys via the
    // `x-api-key` header — use the mechanism that matches the stored token.
    let session = if is_oauth {
        state
            .immich
            .restore_oauth_session(&server_url, &token)
            .await
            .map_err(|err| format!("session restore failed: {err}"))?
    } else {
        state
            .immich
            .authenticate_with_key(&server_url, &token)
            .await
            .map_err(|err| format!("session restore failed: {err}"))?
    };

    // Refresh the cached user identity for future offline restores.
    if let Err(err) = state
        .db
        .save_user_info(&session.user_id, session.user_name.as_deref())
    {
        log::warn!("[auth:restore] failed to persist user info: {err}");
    }

    let preview = session.access_token.chars().take(8).collect::<String>();

    Ok(Some(RestoreSessionResponse {
        access_token_preview: preview,
        user_id: session.user_id,
        user_name: session.user_name,
        server_url,
        offline: false,
    }))
}

/// Probe whether the configured Immich server is currently reachable. Returns
/// `false` (rather than erroring) when there are no stored credentials or the
/// server is unreachable, so the frontend can drive online/offline UI state.
#[tauri::command]
pub async fn check_server_connection(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let Some((server_url, _token, _is_oauth)) = state
        .db
        .get_auth_credentials()
        .map_err(|err| format!("failed to read credentials: {err}"))?
    else {
        return Ok(false);
    };

    Ok(state.immich.ping(&server_url).await)
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
    log::info!(
        "[oauth:command:start] server_url={} redirect_uri={}",
        server_url, redirect_uri
    );
    let authorization_url = app_state
        .immich
        .start_oauth(&server_url, &redirect_uri)
        .await
        .map_err(|err| format!("failed to start OAuth: {err}"))?;

    log::info!(
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
    log::info!(
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

    // Persist the user identity so the session can be restored offline.
    if let Err(err) = app_state
        .db
        .save_user_info(&session.user_id, session.user_name.as_deref())
    {
        log::warn!("[oauth:command:finish] failed to persist user info: {err}");
    }

    let preview = session.access_token.chars().take(8).collect::<String>();
    log::info!(
        "[oauth:command:finish] success user_id={} user_name={:?}",
        session.user_id, session.user_name
    );

    Ok(AuthResponse {
        access_token_preview: preview,
        user_id: session.user_id,
        user_name: session.user_name,
    })
}
