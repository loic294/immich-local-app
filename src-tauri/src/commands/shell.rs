#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|err| format!("failed to open url: {err}"))
}
