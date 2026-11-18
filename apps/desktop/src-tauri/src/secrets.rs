//! Provider credentials in the operating-system secret store.
//!
//! Windows uses Credential Manager (DPAPI-protected). The secret is write-only
//! from the webview's perspective: no command returns it. Provider calls are
//! executed in Rust so the credential never enters JavaScript.

use keyring::Entry;

const SERVICE: &str = "app.habitpilot.desktop";

const ALLOWED_PROVIDERS: [&str; 7] = [
    "ollama",
    "lmstudio",
    "openai-compatible",
    "deepseek",
    "openai",
    "anthropic",
    "gemini",
];

fn validate_provider(provider_id: &str) -> Result<&str, String> {
    if ALLOWED_PROVIDERS.contains(&provider_id) {
        Ok(provider_id)
    } else {
        Err("Unsupported AI provider.".to_string())
    }
}

pub fn read_secret(provider_id: &str) -> Result<String, String> {
    let provider_id = validate_provider(provider_id)?;
    let entry = Entry::new(SERVICE, provider_id)
        .map_err(|_| "Could not open the OS secret store.".to_string())?;
    entry
        .get_password()
        .map_err(|_| "No credential is stored for this provider.".to_string())
}

#[tauri::command]
pub fn secret_set(provider_id: String, secret: String) -> Result<(), String> {
    let provider_id = validate_provider(&provider_id)?;
    if secret.trim().is_empty() {
        return Err("The credential cannot be empty.".to_string());
    }
    if secret.len() > 4096 {
        return Err("The credential is too long.".to_string());
    }
    let entry = Entry::new(SERVICE, provider_id)
        .map_err(|_| "Could not open the OS secret store.".to_string())?;
    entry
        .set_password(secret.trim())
        .map_err(|_| "Could not store the credential in the OS secret store.".to_string())
}

#[tauri::command]
pub fn secret_status(provider_id: String) -> Result<bool, String> {
    let provider_id = validate_provider(&provider_id)?;
    let entry = Entry::new(SERVICE, provider_id)
        .map_err(|_| "Could not open the OS secret store.".to_string())?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Could not read the OS secret store.".to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(provider_id: String) -> Result<(), String> {
    let provider_id = validate_provider(&provider_id)?;
    let entry = Entry::new(SERVICE, provider_id)
        .map_err(|_| "Could not open the OS secret store.".to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the stored credential.".to_string()),
    }
}

pub fn backend_name() -> String {
    if cfg!(target_os = "windows") {
        "windows-credential-manager".to_string()
    } else if cfg!(target_os = "macos") {
        "macos-keychain".to_string()
    } else {
        "os-secret-store".to_string()
    }
}

#[tauri::command]
pub fn credential_backend() -> String {
    backend_name()
}
