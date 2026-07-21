use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn initialize_library(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let library_path = PathBuf::from(path.trim());

    if library_path.as_os_str().is_empty() {
        return Err("The selected library path is empty.".to_string());
    }

    // The folder picker normally returns an existing directory.
    // This also permits a manually supplied path that does not yet exist.
    fs::create_dir_all(&library_path)
        .map_err(|error| format!("Failed to create the library folder: {error}"))?;

    if !library_path.is_dir() {
        return Err("The selected path is not a directory.".to_string());
    }

    create_library_directories(&library_path)?;

    activate_library(&library_path, &state)?;

    let normalized_path = library_path.to_string_lossy().into_owned();

    let connection = state
        .settings_connection
        .lock()
        .map_err(|_| "Failed to access the settings database.".to_string())?;

    crate::database::settings::set_setting(
        &connection,
        "library_path",
        &normalized_path,
    )
    .map_err(|error| format!("Failed to save the library path: {error}"))?;

    Ok(normalized_path)
}

fn create_library_directories(library_path: &Path) -> Result<(), String> {
    let directories = [
        library_path.join("media").join("images"),
        library_path.join("media").join("videos"),
        library_path.join("cache").join("thumbnails"),
        library_path.join("metadata"),
    ];

    for directory in directories {
        fs::create_dir_all(&directory).map_err(|error| {
            format!(
                "Failed to create '{}': {error}",
                directory.display()
            )
        })?;
    }

    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryValidation {
    pub valid: bool,
    pub path: Option<String>,
    pub reason: Option<String>,
}


#[tauri::command]
pub fn get_media_count(
    state: tauri::State<'_, AppState>,
) -> Result<i64, String> {
    let library = state
        .library_connection
        .lock()
        .map_err(|_| {
            "Failed to access the library database.".to_string()
        })?;

    let connection = library
        .as_ref()
        .ok_or_else(|| {
            "No library is currently open.".to_string()
        })?;

    connection
        .query_row(
            "SELECT COUNT(*) FROM media",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Failed to count media: {error}"))
}

#[tauri::command]
pub fn open_configured_library(
    state: tauri::State<'_, AppState>,
) -> Result<LibraryValidation, String> {
    open_configured_library_state(&state)
}

pub fn open_configured_library_state(
    state: &AppState,
) -> Result<LibraryValidation, String> {
    let saved_path = {
        let connection = state
            .settings_connection
            .lock()
            .map_err(|_| {
                "Failed to access the settings database."
                    .to_string()
            })?;

        crate::database::settings::get_setting(
            &connection,
            "library_path",
        )
        .map_err(|error| {
            format!("Failed to read the library path: {error}")
        })?
    };

    let Some(saved_path) = saved_path else {
        return Ok(LibraryValidation {
            valid: false,
            path: None,
            reason: Some(
                "No library has been configured.".to_string(),
            ),
        });
    };

    let library_path = std::path::PathBuf::from(&saved_path);

    if !library_path.is_dir() {
        return Ok(LibraryValidation {
            valid: false,
            path: Some(saved_path),
            reason: Some(
                "The configured library folder no longer exists."
                    .to_string(),
            ),
        });
    }

    let required_directories = [
        library_path.join("media").join("images"),
        library_path.join("media").join("videos"),
        library_path.join("cache").join("thumbnails"),
        library_path.join("metadata"),
    ];

    if let Some(missing) = required_directories
        .iter()
        .find(|directory| !directory.is_dir())
    {
        return Ok(LibraryValidation {
            valid: false,
            path: Some(saved_path),
            reason: Some(format!(
                "The library is incomplete. Missing folder: {}",
                missing.display()
            )),
        });
    }

    activate_library(&library_path, &state)?;

    Ok(LibraryValidation {
        valid: true,
        path: Some(saved_path),
        reason: None,
    })
}

fn activate_library(
    library_path: &Path,
    state: &AppState,
) -> Result<(), String> {
    let connection =
        crate::database::library::open_library_database(
            library_path,
        )
        .map_err(|error| {
            format!(
                "Failed to open the library database: {error}"
            )
        })?;

    {
        let mut active_connection = state
            .library_connection
            .lock()
            .map_err(|_| {
                "Failed to access the active library connection."
                    .to_string()
            })?;

        *active_connection = Some(connection);
    }

    {
        let mut active_path = state
            .library_path
            .lock()
            .map_err(|_| {
                "Failed to access the active library path."
                    .to_string()
            })?;

        *active_path = Some(library_path.to_path_buf());
    }

    Ok(())
}