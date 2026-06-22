use serde::Serialize;
use std::fs;

use crate::services::db::Account;
use crate::services::immich_client::{AuthSession, ImmichClient};
use crate::AppState;

/// Register the just-authenticated primary account: persist it to the accounts
/// table (the first account becomes primary automatically) and bind the shared
/// primary [`ImmichClient`] to it in the in-memory registry.
fn register_primary_account(
    state: &AppState,
    server_url: &str,
    session: &AuthSession,
    auth_type: &str,
    token: &str,
) {
    match state.db.upsert_account(
        server_url,
        &session.user_id,
        session.user_name.as_deref(),
        None,
        auth_type,
        token,
    ) {
        Ok(account) => {
            state.accounts.insert(account.id.clone(), state.immich.clone());
            // If this is the only account, ensure it is primary.
            if state.db.get_primary_account().ok().flatten().map(|a| a.id) == Some(account.id.clone())
                || state.accounts.primary_id().is_none()
            {
                state.accounts.set_primary(account.id.clone());
            }
            log::info!(
                "[accounts] bound primary client to account id={} user_id={}",
                account.id,
                session.user_id
            );
        }
        Err(err) => log::warn!("[accounts] failed to register primary account: {err}"),
    }
}

/// Restore an account's session into the given client. Returns the resolved
/// `AuthSession` when the server was reachable and accepted the stored
/// credentials, `None` when the server rejected them, and the `offline` flag
/// when the server was unreachable (the client is hydrated from cache so
/// authenticated cache reads still work).
async fn restore_account_into_client(
    client: &ImmichClient,
    account: &Account,
) -> (Option<AuthSession>, bool) {
    if !client.ping(&account.server_url).await {
        if let Err(err) = client
            .hydrate_offline_session(
                &account.server_url,
                &account.token,
                account.uses_cookie_auth(),
                &account.user_id,
                account.user_name.clone(),
            )
            .await
        {
            log::warn!(
                "[accounts] offline hydrate failed for account id={}: {err}",
                account.id
            );
        }
        return (None, true);
    }

    let result = if account.uses_cookie_auth() {
        client
            .restore_oauth_session(&account.server_url, &account.token)
            .await
    } else {
        client
            .authenticate_with_key(&account.server_url, &account.token)
            .await
    };

    match result {
        Ok(session) => (Some(session), false),
        Err(err) => {
            log::warn!(
                "[accounts] server rejected stored credentials for account id={}: {err}",
                account.id
            );
            (None, false)
        }
    }
}


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

    register_primary_account(&state, &server_url, &session, "api_key", &api_key);

    let preview = session.access_token.chars().take(8).collect::<String>();

    Ok(AuthResponse {
        access_token_preview: preview,
        user_id: session.user_id,
        user_name: session.user_name,
    })
}

#[tauri::command]
pub async fn authenticate_with_password(
    server_url: String,
    email: String,
    password: String,
    state: tauri::State<'_, AppState>,
) -> Result<AuthResponse, String> {
    log::info!(
        "[auth:password:command] authenticating server_url={} email={}",
        server_url,
        email
    );

    let session = state
        .immich
        .login_with_credentials(&server_url, &email, &password)
        .await
        .map_err(|err| format!("password authentication failed: {err}"))?;

    // Credential-based login returns a session token; store it in the OAuth
    // slot so existing restore/session-cookie logic can rehydrate it.
    state
        .db
        .save_oauth_token(&server_url, &session.access_token)
        .map_err(|err| format!("failed to persist session token: {err}"))?;

    if let Err(err) = state
        .db
        .save_user_info(&session.user_id, session.user_name.as_deref())
    {
        log::warn!("[auth:password:command] failed to persist user info: {err}");
    }

    register_primary_account(&state, &server_url, &session, "password", &session.access_token);

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
    let primary_response = if !state.immich.ping(&server_url).await {
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

        RestoreSessionResponse {
            access_token_preview: token.chars().take(8).collect::<String>(),
            user_id,
            user_name,
            server_url: server_url.clone(),
            offline: true,
        }
    } else {
        // OAuth session tokens authenticate via the session cookie, API keys via
        // the `x-api-key` header — use the mechanism that matches the stored token.
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

        RestoreSessionResponse {
            access_token_preview: session.access_token.chars().take(8).collect::<String>(),
            user_id: session.user_id,
            user_name: session.user_name,
            server_url: server_url.clone(),
            offline: false,
        }
    };

    // Bind the shared primary client into the registry and restore every
    // secondary account into its own isolated client (offline-tolerant per
    // account so one unreachable server does not block the others).
    restore_all_accounts(&state).await;

    Ok(Some(primary_response))
}

/// Rehydrate the in-memory account registry from the persisted `accounts` table.
/// The primary account is bound to the shared [`AppState::immich`] client (which
/// `restore_session` has already restored); every secondary account gets its own
/// freshly-created [`ImmichClient`] so each server keeps an isolated cookie jar.
async fn restore_all_accounts(state: &AppState) {
    let accounts = match state.db.list_accounts() {
        Ok(accounts) => accounts,
        Err(err) => {
            log::warn!("[accounts] failed to list accounts for restore: {err}");
            return;
        }
    };

    if accounts.is_empty() {
        return;
    }

    let mut primary_id: Option<String> = None;

    for account in accounts {
        if account.is_primary {
            // The shared primary client was restored above; just bind it.
            state
                .accounts
                .insert(account.id.clone(), state.immich.clone());
            primary_id = Some(account.id.clone());
            continue;
        }

        let client = std::sync::Arc::new(ImmichClient::new());
        let (_session, offline) = restore_account_into_client(&client, &account).await;
        log::info!(
            "[accounts] restored secondary account id={} server={} offline={}",
            account.id,
            account.server_url,
            offline
        );
        state.accounts.insert(account.id.clone(), client);
    }

    if let Some(id) = primary_id {
        state.accounts.set_primary(id);
    }
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
    log::info!("[auth:logout] clearing session, local cache, and local database state");

    // Tear down every account's in-memory session, not just the primary.
    for (account_id, client) in state.accounts.all() {
        client.clear_session().await;
        log::info!("[auth:logout] cleared session for account id={account_id}");
    }
    state.accounts.clear();
    state.immich.clear_session().await;

    if let Err(err) = state.db.clear_all_accounts() {
        log::warn!("[auth:logout] failed to clear accounts table: {err}");
    }

    state
        .db
        .clear_local_library_cache()
        .map_err(|err| format!("failed to clear local database cache: {err}"))?;

    clear_media_cache_dirs().map_err(|err| format!("failed to clear media cache: {err}"))?;

    log::info!("[auth:logout] local sign-out cleanup complete");
    Ok(())
}

fn clear_media_cache_dirs() -> Result<(), String> {
    let home = crate::util::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
    let cache_root = home.join(".config").join("immich-local-app");

    for dir_name in ["thumbnails", "videos"] {
        let cache_dir = cache_root.join(dir_name);
        if cache_dir.exists() {
            fs::remove_dir_all(&cache_dir)
                .map_err(|err| format!("failed to remove {} cache dir: {err}", dir_name))?;
        }
        fs::create_dir_all(&cache_dir)
            .map_err(|err| format!("failed to recreate {} cache dir: {err}", dir_name))?;
    }

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

    register_primary_account(&app_state, &server_url, &session, "oauth", &session.access_token);

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

// ---------------------------------------------------------------------------
// Multi-account management
// ---------------------------------------------------------------------------

/// List every locally-registered account. Tokens are never serialized (the
/// `Account` struct marks `token` as `skip_serializing`).
#[tauri::command]
pub async fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<Account>, String> {
    state.db.list_accounts()
}

/// Change which account is primary. The primary account drives album creation
/// and acts as the default for single-account code paths.
#[tauri::command]
pub async fn set_primary_account(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.db.set_primary_account(&account_id)?;
    state.accounts.set_primary(account_id.clone());
    log::info!("[accounts] primary account changed to id={account_id}");
    Ok(())
}

/// Remove a secondary account (or promote the next account if the primary is
/// removed). Returns the id of the new primary account when it changed.
#[tauri::command]
pub async fn remove_account(
    account_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let new_primary = state.db.remove_account(&account_id)?;
    state.accounts.remove(&account_id);
    if let Some(ref primary_id) = new_primary {
        state.accounts.set_primary(primary_id.clone());
        log::warn!(
            "[accounts] removed primary account id={account_id}; promoted id={primary_id} \
             (shared primary client will refresh on next restart)"
        );
    }
    Ok(new_primary)
}

/// Add a secondary account using an API key. Creates an isolated client so the
/// account's server keeps its own session, then registers it.
#[tauri::command]
pub async fn add_account_with_key(
    server_url: String,
    api_key: String,
    state: tauri::State<'_, AppState>,
) -> Result<Account, String> {
    let client = std::sync::Arc::new(ImmichClient::new());
    let session = client
        .authenticate_with_key(&server_url, &api_key)
        .await
        .map_err(|err| format!("authentication failed: {err}"))?;

    let account = state.db.upsert_account(
        &server_url,
        &session.user_id,
        session.user_name.as_deref(),
        None,
        "api_key",
        &api_key,
    )?;
    state.accounts.insert(account.id.clone(), client);
    log::info!(
        "[accounts] added account id={} server={} via api_key",
        account.id,
        server_url
    );
    Ok(account)
}

/// Add a secondary account using email + password.
#[tauri::command]
pub async fn add_account_with_password(
    server_url: String,
    email: String,
    password: String,
    state: tauri::State<'_, AppState>,
) -> Result<Account, String> {
    let client = std::sync::Arc::new(ImmichClient::new());
    let session = client
        .login_with_credentials(&server_url, &email, &password)
        .await
        .map_err(|err| format!("password authentication failed: {err}"))?;

    let account = state.db.upsert_account(
        &server_url,
        &session.user_id,
        session.user_name.as_deref(),
        Some(&email),
        "password",
        &session.access_token,
    )?;
    state.accounts.insert(account.id.clone(), client);
    log::info!(
        "[accounts] added account id={} server={} via password",
        account.id,
        server_url
    );
    Ok(account)
}

/// Begin an add-account OAuth flow. Creates a dedicated client and stashes it so
/// the same client (with its PKCE state) can finish the flow.
#[tauri::command]
pub async fn add_account_oauth_url(
    server_url: String,
    redirect_uri: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<OAuthUrlResponse, String> {
    let redirect_uri = redirect_uri.unwrap_or_else(|| "app.immich://oauth-callback".to_string());
    let client = std::sync::Arc::new(ImmichClient::new());
    let authorization_url = client
        .start_oauth(&server_url, &redirect_uri)
        .await
        .map_err(|err| format!("failed to start OAuth: {err}"))?;
    state
        .accounts
        .stash_pending_oauth(server_url.clone(), client);
    log::info!("[accounts] started add-account OAuth flow server={server_url}");
    Ok(OAuthUrlResponse { authorization_url })
}

/// Complete an add-account OAuth flow started by [`add_account_oauth_url`].
#[tauri::command]
pub async fn add_account_complete_oauth(
    server_url: String,
    callback_url: String,
    state: tauri::State<'_, AppState>,
) -> Result<Account, String> {
    let client = state
        .accounts
        .take_pending_oauth(&server_url)
        .ok_or_else(|| "no pending OAuth flow for this server".to_string())?;
    let session = client
        .finish_oauth(&server_url, &callback_url)
        .await
        .map_err(|err| format!("OAuth authentication failed: {err}"))?;

    let account = state.db.upsert_account(
        &server_url,
        &session.user_id,
        session.user_name.as_deref(),
        None,
        "oauth",
        &session.access_token,
    )?;
    state.accounts.insert(account.id.clone(), client);
    log::info!(
        "[accounts] added account id={} server={} via oauth",
        account.id,
        server_url
    );
    Ok(account)
}
