//! Local SQLite state for the desktop app.
//!
//! Only app state lives here: consent records, provider configuration (without
//! credentials), settings and local health data. Provider API keys are stored
//! in the OS secret store and are never written to SQLite or backups.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager, State};

pub struct StateDb(pub Mutex<Connection>);

const ALLOWED_KEYS: [&str; 5] = [
    "consent",
    "consentMirror",
    "settings",
    "providers",
    "localHealth",
];

fn validate_key(key: &str) -> Result<&str, String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(key)
    } else {
        Err("Unsupported state key.".to_string())
    }
}

pub fn init(app: &AppHandle) -> Result<StateDb, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not resolve the app data directory.".to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not create the app data directory.".to_string())?;
    let connection = Connection::open(directory.join("habitpilot.db"))
        .map_err(|_| "Could not open the local database.".to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS app_state (
               key TEXT PRIMARY KEY,
               json TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );",
        )
        .map_err(|_| "Could not initialise the local database.".to_string())?;
    Ok(StateDb(Mutex::new(connection)))
}

#[tauri::command]
pub fn state_load(db: State<StateDb>, key: String) -> Result<Option<String>, String> {
    let key = validate_key(&key)?;
    let connection = db
        .0
        .lock()
        .map_err(|_| "Local database is unavailable.".to_string())?;
    connection
        .query_row(
            "SELECT json FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "Could not read local state.".to_string())
}

#[tauri::command]
pub fn state_save(db: State<StateDb>, key: String, json: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    let connection = db
        .0
        .lock()
        .map_err(|_| "Local database is unavailable.".to_string())?;
    connection
        .execute(
            "INSERT INTO app_state (key, json, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
            params![key, json],
        )
        .map_err(|_| "Could not save local state.".to_string())?;
    Ok(())
}

/// Deletes only local app state. It cannot touch OS secret storage.
#[tauri::command]
pub fn state_clear(db: State<StateDb>, key: String) -> Result<(), String> {
    let key = validate_key(&key)?;
    let connection = db
        .0
        .lock()
        .map_err(|_| "Local database is unavailable.".to_string())?;
    connection
        .execute("DELETE FROM app_state WHERE key = ?1", params![key])
        .map_err(|_| "Could not clear local state.".to_string())?;
    Ok(())
}
