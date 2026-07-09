use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, State};

mod audio_capture;
mod config;

use audio_capture::{list_audio_devices, start_capture, CaptureHandle, CaptureOptions, AudioDevice};
use config::ConfigState;

use ollama_rs::{
    generation::completion::{request::GenerationRequest, GenerationResponse},
    Ollama,
};

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
    pub pickup_type: String,
    #[serde(default)]
    pub pickup_window: String,
    #[serde(default)]
    pub delivery_location: String,
    #[serde(default)]
    pub delivery_datetime: String,
    #[serde(default)]
    pub delivery_type: String,
    #[serde(default)]
    pub delivery_window: String,
    #[serde(default)]
    pub stops: String,
    #[serde(default)]
    pub commodity: String,
    #[serde(default)]
    pub equipment_type: String,
    #[serde(default)]
    pub trailer_instructions: String,
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

// ─── Ollama Native API Types ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct OllamaGenerateRequest {
    model: String,
    prompt: String,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

// ─── LLM Extraction ─────────────────────────────────────────────────────────

#[tauri::command]
async fn extract_load_data(
    config: State<'_, ConfigState>,
    req: ExtractionRequest,
) -> Result<LoadFormDataWithConfidence, String> {
    let (base_url, model, api_key, is_local) = {
        let cfg = config.config.lock().unwrap();
        (
            cfg.ollama_base_url.clone(),
            cfg.ollama_model.clone(),
            cfg.ollama_api_key.clone(),
            cfg.is_local_ollama(),
        )
    };

    let prompt = format!(
        r#"You are a logistics data extraction assistant. Given a broker conversation transcript, extract the following fields:
- pickup_location: where the load picks up (city, state)
- pickup_datetime: when the load picks up (day, date, time)
- pickup_type: how the pickup works — "live load" (driver waits while loaded), "drop and hook" (drop empty, grab preloaded), "empty in" (arrive with empty trailer), "preloaded" (trailer already loaded, hook and go)
- pickup_window: time window or appointment type — e.g. "FCFS 10am-4pm", "Appointment 2:00 PM", "ASAP", "24/7"
- delivery_location: where the load delivers (city, state)
- delivery_datetime: when the load delivers (day, date, time)
- delivery_type: how the delivery works — "live unload" (driver waits while unloaded), "drop and hook" (drop loaded, grab empty), "empty out" (leave with empty trailer)
- delivery_window: time window or appointment type for delivery — e.g. "FCFS 8am-5pm", "Appointment 9:00 AM"
- stops: any intermediate stops between pickup and delivery, or "none" if direct. Format as "City, ST → City, ST" for multiple.
- commodity: what is being shipped (be specific: "frozen chicken", "steel coils", "retail goods")
- equipment_type: truck type (reefer, dry van, flatbed, step deck, conestoga, etc.)
- trailer_instructions: full operation chain for drivers without trailers — e.g. "Pick empty nearby → live load → live unload", "Hook preloaded at shipper → drop and hook at receiver", "Empty in → live load → drop and hook"
- rate: pay rate mentioned ($/mile or total amount)
- weight: load weight in lbs
- additional_notes: any other relevant info (lumpers, appointments, hazmat, T-check, pallet jack, etc.)

For each field, provide a confidence score from 0.0 to 1.0.
Return ONLY valid JSON in this exact format with no markdown code blocks:
{{
  "data": {{
    "pickup_location": "...",
    "pickup_datetime": "...",
    "pickup_type": "...",
    "pickup_window": "...",
    "delivery_location": "...",
    "delivery_datetime": "...",
    "delivery_type": "...",
    "delivery_window": "...",
    "stops": "...",
    "commodity": "...",
    "equipment_type": "...",
    "trailer_instructions": "...",
    "rate": "...",
    "weight": "...",
    "additional_notes": "..."
  }},
  "confidence": {{
    "pickup_location": 0.95,
    "pickup_datetime": 0.87,
    "pickup_type": 0.82,
    "pickup_window": 0.90,
    "delivery_location": 0.98,
    "delivery_datetime": 0.91,
    "delivery_type": 0.85,
    "delivery_window": 0.88,
    "stops": 0.95,
    "commodity": 0.82,
    "equipment_type": 0.99,
    "trailer_instructions": 0.75,
    "rate": 0.89,
    "weight": 0.95,
    "additional_notes": 0.75
  }}
}}

Transcript:
{}"#,
        req.transcript
    );

    let raw_content = if is_local {
        // Local Ollama — native ollama-rs
        let ollama = Ollama::default();
        let request = GenerationRequest::new(model, prompt);
        let response: GenerationResponse = ollama
            .generate(request)
            .await
            .map_err(|e| format!("Local Ollama generation failed: {}", e))?;
        response.response
    } else {
        // Remote Ollama — native /api/generate with auth
        let api_req = OllamaGenerateRequest {
            model,
            prompt,
            stream: false,
        };

        let client = reqwest::Client::new();
        let url = format!("{}/api/generate", base_url.trim_end_matches('/'));

        let mut builder = client.post(&url).json(&api_req);
        if !api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = builder.send().await.map_err(|e| format!("HTTP error: {}", e))?;
        let status = response.status();
        let body_text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {}", e))?;

        if !status.is_success() {
            return Err(format!("Ollama API error {}: {}", status, body_text));
        }

        let api_response: OllamaGenerateResponse = serde_json::from_str(&body_text)
            .map_err(|e| format!("Failed to parse Ollama response: {}. Body: {}", e, body_text))?;

        api_response.response
    };

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
    device_id: String,
    mix_system_audio: bool,
) -> Result<(), String> {
    config.config.lock().unwrap().is_valid()?;

    let mut guard = state.handle.lock().unwrap();
    if guard.is_some() {
        return Err("Capture already running".to_string());
    }

    let options = CaptureOptions {
        device_id,
        mix_system_audio,
    };

    let handle = start_capture(
        app,
        config.config.lock().unwrap().deepgram_api_key.clone(),
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

#[derive(Debug, Deserialize)]
struct SetApiKeysPayload {
    deepgram_key: String,
    ollama_key: String,
}

#[tauri::command]
fn set_api_keys(
    state: State<'_, ConfigState>,
    payload: SetApiKeysPayload,
) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_keys(payload.deepgram_key, payload.ollama_key);
    Ok(())
}

#[tauri::command]
fn logout(state: State<'_, ConfigState>) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.deepgram_api_key.clear();
    cfg.ollama_api_key.clear();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ConfigState::default())
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            extract_load_data,
            copy_to_clipboard,
            list_devices,
            start_capture_cmd,
            stop_capture,
            set_api_keys,
            logout,
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
            ..Default::default()
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
