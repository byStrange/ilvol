use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

mod audio_capture;
mod config;

use audio_capture::{list_audio_devices, start_capture, CaptureHandle, CaptureOptions, AudioDevice};
use config::{AppConfig, ConfigState};

// ─── Shared State ───────────────────────────────────────────────────────────

pub struct CaptureState {
    handle: Mutex<Option<CaptureHandle>>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
        }
    }
}

// ─── Data Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct LoadFormData {
    #[serde(default)]
    pub pickup_location: String,
    #[serde(default)]
    pub pickup_datetime: String,
    #[serde(default)]
    pub delivery_location: String,
    #[serde(default)]
    pub delivery_datetime: String,
    #[serde(default)]
    pub commodity: String,
    #[serde(default)]
    pub equipment_type: String,
    #[serde(default)]
    pub rate: String,
    #[serde(default)]
    pub weight: String,
    #[serde(default)]
    pub additional_notes: String,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct LoadFormDataWithConfidence {
    #[serde(default)]
    pub data: LoadFormData,
    #[serde(default)]
    pub confidence: HashMap<String, f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractionRequest {
    pub transcript: String,
}

// ─── Ollama Cloud / OpenAI Compatible API Types ───────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f64,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatCompletionChoice>,
}

// ─── LLM Extraction ─────────────────────────────────────────────────────────

#[tauri::command]
async fn extract_load_data(
    config: State<'_ , ConfigState>,
    req: ExtractionRequest,
) -> Result<LoadFormDataWithConfidence, String> {
    let base_url = config.config.ollama_base_url.clone();
    let model = config.config.ollama_model.clone();
    let api_key = config.config.ollama_api_key.clone();

    if api_key.is_empty() {
        return Err("OLLAMA_API_KEY not configured".to_string());
    }

    let prompt = format!(
        r#"You are a logistics data extraction assistant. Given a broker conversation transcript, extract the following fields:
- pickup_location: where the load picks up (city, state)
- pickup_datetime: when the load picks up (day, date, time)
- delivery_location: where the load delivers (city, state)  
- delivery_datetime: when the load delivers (day, date, time)
- commodity: what is being shipped
- equipment_type: truck type (reefer, dry van, flatbed, step deck, etc.)
- rate: pay rate mentioned ($/mile or total amount)
- weight: load weight in lbs
- additional_notes: any other relevant info (lumpers, appointments, hazmat, etc.)

For each field, provide a confidence score from 0.0 to 1.0.
Return ONLY valid JSON in this exact format with no markdown code blocks:
{{
  "data": {{
    "pickup_location": "...",
    "pickup_datetime": "...",
    "delivery_location": "...",
    "delivery_datetime": "...",
    "commodity": "...",
    "equipment_type": "...",
    "rate": "...",
    "weight": "...",
    "additional_notes": "..."
  }},
  "confidence": {{
    "pickup_location": 0.95,
    "pickup_datetime": 0.87,
    "delivery_location": 0.98,
    "delivery_datetime": 0.91,
    "commodity": 0.82,
    "equipment_type": 0.99,
    "rate": 0.89,
    "weight": 0.95,
    "additional_notes": 0.75
  }}
}}

Transcript:
{}"#,
        req.transcript
    );

    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", base_url);

    let api_req = ChatCompletionRequest {
        model,
        messages: vec![ChatMessage {
            role: "system".to_string(),
            content: prompt,
        }],
        temperature: 0.1,
    };

    let mut builder = client.post(&url).json(&api_req);

    builder = builder.header("Authorization", format!("Bearer {}", api_key));

    let response = builder.send().await.map_err(|e| format!("HTTP error: {}", e))?;

    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        return Err(format!("API error {}: {}", status, body_text));
    }

    // Parse the LLM response
    let api_response: ChatCompletionResponse =
        serde_json::from_str(&body_text).map_err(|e| {
            format!("Failed to parse API response as JSON: {}. Body: {}", e, body_text)
        })?;

        let raw_content = api_response
        .choices
        .get(0)
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    // The LLM response may contain markdown code blocks — strip them
    let cleaned = raw_content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: LoadFormDataWithConfidence = serde_json::from_str(cleaned).map_err(|e| {
        format!(
            "Failed to parse LLM output as LoadFormDataWithConfidence: {}. Raw: {}",
            e, raw_content
        )
    })?;

    Ok(parsed)
}

// ─── Clipboard ──────────────────────────────────────────────────────────────

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        use arboard::Clipboard;
        let mut clipboard =
            Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;
        clipboard
            .set_text(text)
            .map_err(|e| format!("Failed to set clipboard text: {}", e))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Clipboard not supported on this platform".to_string())
    }
}

// ─── Tauri Entry ────────────────────────────────────────────────────────────

#[tauri::command]
fn list_devices() -> Vec<AudioDevice> {
    list_audio_devices()
}

#[tauri::command]
fn start_capture_cmd(
    state: State<'_, CaptureState>,
    config: State<'_, ConfigState>,
    app: AppHandle,
    options: CaptureOptions,
) -> Result<(), String> {
    config.config.is_valid()?;

    let mut guard = state.handle.lock().unwrap();
    if guard.is_some() {
        return Err("Capture already running".to_string());
    }

    let handle = start_capture(
        app,
        config.config.deepgram_api_key.clone(),
        options,
    )?;
    *guard = Some(handle);
    Ok(())
}

#[tauri::command]
fn stop_capture(state: State<'_, CaptureState>) -> Result<(), String> {
    let mut guard = state.handle.lock().unwrap();
    if let Some(handle) = guard.take() {
        handle.stop();
        Ok(())
    } else {
        Err("No capture running".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = Arc::new(AppConfig::load());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ConfigState { config: config.clone() })
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            extract_load_data,
            copy_to_clipboard,
            list_devices,
            start_capture_cmd,
            stop_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_form_data_serialization() {
        let data = LoadFormData {
            pickup_location: "Amarillo, TX".to_string(),
            pickup_datetime: "Tue 6/24, 8:00 AM".to_string(),
            delivery_location: "Tulsa, OK".to_string(),
            delivery_datetime: "Thu 6/26, 6:00 AM".to_string(),
            commodity: "Frozen chicken".to_string(),
            equipment_type: "Reefer".to_string(),
            rate: "$2.80/mile ($2,100 total)".to_string(),
            weight: "43,000 lbs".to_string(),
            additional_notes: "Lumpers required".to_string(),
        };

        let json = serde_json::to_string(&data).unwrap();
        let back: LoadFormData = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pickup_location, "Amarillo, TX");
        assert_eq!(back.equipment_type, "Reefer");
    }

    #[test]
    fn test_confidence_parsing() {
        let raw = r#"{
            "data": {
                "pickup_location": "Amarillo, TX",
                "pickup_datetime": "Tue 6/24, 8:00 AM",
                "delivery_location": "Tulsa, OK",
                "delivery_datetime": "Thu 6/26, 6:00 AM",
                "commodity": "Frozen chicken",
                "equipment_type": "Reefer",
                "rate": "$2.80/mile",
                "weight": "43,000 lbs",
                "additional_notes": ""
            },
            "confidence": {
                "pickup_location": 0.98,
                "pickup_datetime": 0.87,
                "delivery_location": 0.96,
                "delivery_datetime": 0.91,
                "commodity": 0.82,
                "equipment_type": 0.99,
                "rate": 0.89,
                "weight": 0.95,
                "additional_notes": 0.0
            }
        }"#;

        let parsed: LoadFormDataWithConfidence = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.data.pickup_location, "Amarillo, TX");
        assert_eq!(
            parsed.confidence.get("pickup_location"),
            Some(&0.98)
        );
        assert_eq!(
            parsed.confidence.get("additional_notes"),
            Some(&0.0)
        );
    }

    #[test]
    fn test_markdown_code_block_stripping() {
        let raw = r#"```json
        {
            "data": {"pickup_location": "Test"},
            "confidence": {"pickup_location": 0.95}
        }
        ```"#;

        let cleaned = raw
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        let parsed: LoadFormDataWithConfidence = serde_json::from_str(cleaned).unwrap();
        assert_eq!(parsed.data.pickup_location, "Test");
    }
}
