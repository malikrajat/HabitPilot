#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod secrets;
mod state_db;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    version: String,
    platform: String,
    data_dir: String,
    database_path: String,
    credential_backend: String,
    ai_proxy: bool,
}

#[tauri::command]
fn desktop_info(app: AppHandle) -> Result<DesktopInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not resolve the app data directory.".to_string())?;
    Ok(DesktopInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
        database_path: data_dir.join("habitpilot.db").to_string_lossy().to_string(),
        credential_backend: secrets::backend_name(),
        ai_proxy: true,
    })
}

fn open_folder(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|_| "Could not open Explorer.".to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|_| "Could not open Finder.".to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|_| "Could not open the file manager.".to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Opening folders is not supported on this platform.".to_string())
}

#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not resolve the app data directory.".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not create the data directory.".to_string())?;
    open_folder(&dir)
}

fn main() {
    tauri::Builder::default()
        // Camera and microphone are granted only to HabitPilot's own trusted
        // origin. Every other permission and origin is denied. The user still
        // has to press "Enable" in Sensors & observations, and capture stops
        // when they revoke or leave the screen.
        .on_permission_request(|webview, kind| {
            let trusted = webview
                .url()
                .ok()
                .map(|url| {
                    let host = url.host_str().unwrap_or("");
                    url.scheme() == "tauri" || host == "tauri.localhost" || host == "localhost"
                })
                .unwrap_or(false);
            if !trusted {
                return PermissionResponse::Deny;
            }
            match kind {
                PermissionKind::Camera | PermissionKind::Microphone => {
                    PermissionResponse::Allow
                }
                _ => PermissionResponse::Deny,
            }
        })
        .setup(|app| {
            let database = state_db::init(app.handle())
                .map_err(|message| -> Box<dyn std::error::Error> { message.into() })?;
            app.manage(database);

            let go = Submenu::with_items(
                app.handle(),
                "Go",
                true,
                &[
                    &MenuItem::with_id(app.handle(), "nav:dashboard", "Dashboard", true, Some("CmdOrCtrl+1"))?,
                    &MenuItem::with_id(app.handle(), "nav:assistant", "AI Assistant", true, Some("CmdOrCtrl+2"))?,
                    &MenuItem::with_id(app.handle(), "nav:sensors", "Sensors & observations", true, Some("CmdOrCtrl+3"))?,
                    &MenuItem::with_id(app.handle(), "nav:privacy", "Privacy & AI Settings", true, Some("CmdOrCtrl+4"))?,
                    &MenuItem::with_id(app.handle(), "nav:audit", "Consent audit log", true, Some("CmdOrCtrl+5"))?,
                    &MenuItem::with_id(app.handle(), "nav:setup", "Run setup again", true, None::<&str>)?,
                ],
            )?;

            let app_menu = Submenu::with_items(
                app.handle(),
                "HabitPilot",
                true,
                &[
                    &MenuItem::with_id(app.handle(), "open-data", "Open data folder", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app.handle())?,
                    &MenuItem::with_id(app.handle(), "quit", "Quit HabitPilot", true, Some("CmdOrCtrl+Q"))?,
                ],
            )?;

            app.set_menu(Menu::with_items(app.handle(), &[&app_menu, &go])?)?;

            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                match id {
                    "quit" => app.exit(0),
                    "open-data" => {
                        let _ = open_data_folder(app.clone());
                    }
                    other if other.starts_with("nav:") => {
                        let page = other.trim_start_matches("nav:");
                        let _ = app.emit("habitpilot:navigate", page);
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state_db::state_load,
            state_db::state_save,
            state_db::state_clear,
            secrets::secret_set,
            secrets::secret_status,
            secrets::secret_delete,
            secrets::credential_backend,
            ai::ai_complete,
            ai::desktop_ai_ready,
            desktop_info,
            open_data_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HabitPilot");
}
