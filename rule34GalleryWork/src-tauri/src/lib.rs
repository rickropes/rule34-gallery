// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod database;
mod state;
mod commands;
mod models;

use commands::{
    library::get_media_count,
    media::list_media,
    media::insert_test_media,
    media::import_media_files,
    media::list_media_tags,
    media::add_media_tag,
    media::remove_media_tag,
    media::list_tag_categories,
    media::list_tags_for_category,
    media::list_search_suggestions,
    media::import_media_url,
    media::delete_media,
    media::add_tag_to_media,
    media::process_media,
    media::media_ids_with_audio,
    media::trim_video,
    media::list_collection_pages
};

#[tauri::command]
fn ping() -> String {
    "pong".to_string()
}


#[tauri::command]
fn reveal_media_file(path: String) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(path);
    if !file_path.exists() {
        return Err("The media file no longer exists on disk.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", file_path.to_string_lossy()))
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&file_path)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = file_path.parent().ok_or_else(|| "Unable to determine the containing folder.".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show()?;
        let _ = window.set_skip_taskbar(false);
        window.set_focus()?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App("index.html".into()),
    )
    .title("rule34-library")
    .inner_size(1500.0, 1100.0)
    .min_inner_size(640.0, 480.0)
    .visible(false)
    .build()?;

    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[cfg(desktop)]
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let open = MenuItem::with_id(app, "open", "Open Gallery", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .tooltip("rule34-library — background importer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = show_main_window(app);
            }
            "quit" => {
                QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    let settings_connection = database::initialize().expect("Failed to initialize settings database");

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                let _ = show_main_window(app);
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ));
    }

    let app = builder
        .manage(state::AppState {
            settings_connection: std::sync::Mutex::new(settings_connection),
            library_connection: std::sync::Mutex::new(None),
            library_path: std::sync::Mutex::new(None),
            import_queue: std::sync::Mutex::new(std::collections::VecDeque::new()),
            next_import_id: std::sync::atomic::AtomicU64::new(1),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            commands::import_server::start_import_server(app.handle().clone());

            // Open the configured library in the backend so extension imports work
            // even while no gallery WebView exists.
            if let Err(error) = commands::library::open_configured_library_state(
                &app.state::<state::AppState>(),
            ) {
                eprintln!("Failed to open configured library in background mode: {error}");
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;

                install_tray(app)?;
                if let Err(error) = app.autolaunch().enable() {
                    eprintln!("Failed to enable launch at startup: {error}");
                }

                let background = std::env::args().any(|arg| arg == "--background");
                if !background {
                    show_main_window(app.handle())?;
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // Destroying the WebView releases the React gallery and decoded media.
                    // The Rust importer and tray icon continue running.
                    let _ = window.destroy();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            reveal_media_file,
            commands::settings::get_library_path,
            commands::settings::set_library_path,
            commands::library::initialize_library,
            commands::library::open_configured_library,
            get_media_count,
            list_media,
            insert_test_media,
            import_media_files,
            list_media_tags,
            add_media_tag,
            remove_media_tag,
            list_tag_categories,
            list_tags_for_category,
            list_search_suggestions,
            import_media_url,
            delete_media,
            add_tag_to_media,
            process_media,
            media_ids_with_audio,
            trim_video,
            list_collection_pages,
            commands::import_server::list_import_queue,
            commands::mobile_queue::get_mobile_queue_settings,
            commands::mobile_queue::set_mobile_queue_settings,
            commands::mobile_queue::sync_mobile_queue
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !QUITTING.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}
