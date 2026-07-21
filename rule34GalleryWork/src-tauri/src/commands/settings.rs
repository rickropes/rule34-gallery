use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn get_library_path(
    state: State<AppState>,
) -> Result<Option<String>, String> {
    let conn = state.settings_connection.lock().unwrap();

    crate::database::settings::get_setting(
        &conn,
        "library_path",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_library_path(
    path: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.settings_connection.lock().unwrap();

    crate::database::settings::set_setting(
        &conn,
        "library_path",
        &path,
    )
    .map_err(|e| e.to_string())
}