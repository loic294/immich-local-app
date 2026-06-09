#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    println!("[oauth:shell] opening external url={}", url);
    open::that(&url).map_err(|err| format!("failed to open url: {err}"))
}
