//! Server-side (native) provider calls.
//!
//! The webview sends the minimized payload and provider metadata, never a key.
//! Rust reads the key from the OS secret store, performs the HTTP request and
//! returns only the generated text. Request bodies and credentials are never
//! logged.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::secrets;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    provider_id: String,
    model: String,
    endpoint: String,
    system_prompt: String,
    user_content: String,
}

#[derive(Serialize)]
pub struct AiResponse {
    text: String,
    model: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "Could not create the network client.".to_string())
}

fn endpoint_ok(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/').to_string();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("The provider endpoint must use http or https.".to_string());
    }
    Ok(trimmed)
}

fn key_for(provider_id: &str) -> Option<String> {
    if provider_id == "ollama" || provider_id == "lmstudio" {
        return None;
    }
    secrets::read_secret(provider_id).ok()
}

fn text_from_openai(body: &Value) -> Option<String> {
    body.get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

fn text_from_anthropic(body: &Value) -> Option<String> {
    let parts = body.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn text_from_gemini(body: &Value) -> Option<String> {
    let parts = body
        .get("candidates")?
        .get(0)?
        .get("content")?
        .get("parts")?
        .as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[tauri::command]
pub async fn ai_complete(request: AiRequest) -> Result<AiResponse, String> {
    let endpoint = endpoint_ok(&request.endpoint)?;
    let http = client()?;
    let api_key = key_for(&request.provider_id);

    let response = match request.provider_id.as_str() {
        "anthropic" => {
            let key = api_key.ok_or_else(|| {
                "No credential is stored for this provider. Add one in Privacy & AI Settings."
                    .to_string()
            })?;
            http.post(format!("{endpoint}/messages"))
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&serde_json::json!({
                    "model": request.model,
                    "max_tokens": 700,
                    "system": request.system_prompt,
                    "messages": [{ "role": "user", "content": request.user_content }]
                }))
                .send()
                .await
                .map_err(|_| "The provider could not be reached.".to_string())?
        }
        "gemini" => {
            let key = api_key.ok_or_else(|| {
                "No credential is stored for this provider. Add one in Privacy & AI Settings."
                    .to_string()
            })?;
            http.post(format!(
                "{endpoint}/models/{}:generateContent",
                urlencoding(&request.model)
            ))
            .header("x-goog-api-key", key)
            .json(&serde_json::json!({
                "systemInstruction": { "parts": [{ "text": request.system_prompt }] },
                "contents": [{ "role": "user", "parts": [{ "text": request.user_content }] }],
                "generationConfig": { "temperature": 0.4, "maxOutputTokens": 700 }
            }))
            .send()
            .await
            .map_err(|_| "The provider could not be reached.".to_string())?
        }
        _ => {
            let mut builder = http
                .post(format!("{endpoint}/chat/completions"))
                .json(&serde_json::json!({
                    "model": request.model,
                    "temperature": 0.4,
                    "max_tokens": 700,
                    "messages": [
                        { "role": "system", "content": request.system_prompt },
                        { "role": "user", "content": request.user_content }
                    ]
                }));
            if let Some(key) = api_key {
                builder = builder.header("authorization", format!("Bearer {key}"));
            }
            builder
                .send()
                .await
                .map_err(|_| "The provider could not be reached.".to_string())?
        }
    };

    if !response.status().is_success() {
        // Upstream bodies can echo personal data; discard them.
        return Err(format!(
            "The provider refused the request (status {}).",
            response.status().as_u16()
        ));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|_| "The provider returned an unreadable response.".to_string())?;

    let text = match request.provider_id.as_str() {
        "anthropic" => text_from_anthropic(&body),
        "gemini" => text_from_gemini(&body),
        _ => text_from_openai(&body),
    }
    .ok_or_else(|| "The provider returned an empty response.".to_string())?;

    Ok(AiResponse {
        text,
        model: request.model,
    })
}

fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[tauri::command]
pub fn desktop_ai_ready(provider_id: String) -> bool {
    matches!(provider_id.as_str(), "ollama" | "lmstudio") || secrets::read_secret(&provider_id).is_ok()
}
