use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Which LLM backend `extract_load_data` talks to.
///
/// This lives in the config rather than travelling as a parameter on every
/// extraction call because it is a user *setting*, not a property of a given
/// transcript: auto-extract fires from a timer inside main.js with no user in
/// the loop, and the widget can trigger extraction from a window that never saw
/// the settings modal. Keeping one authoritative copy in Rust means every call
/// site agrees on the provider without having to thread it through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmProvider {
    Ollama,
    Gemini,
}

impl LlmProvider {
    /// Parses the wire form used by the `set_llm_provider` command and the
    /// frontend's `localStorage` value. Unknown strings are rejected rather
    /// than silently falling back, so a typo surfaces in the UI instead of
    /// quietly extracting against the wrong model.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ollama" => Ok(Self::Ollama),
            "gemini" => Ok(Self::Gemini),
            other => Err(format!(
                "Unknown LLM provider '{}'. Expected 'ollama' or 'gemini'.",
                other
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::Gemini => "gemini",
        }
    }
}

/// Application configuration with runtime-mutable API keys.
/// Keys are fetched from Supabase at runtime, not from .env files.
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub deepgram_api_key: String,
    pub ollama_base_url: String,
    pub ollama_api_key: String,
    pub ollama_model: String,
    pub gemini_api_key: String,
    pub gemini_model: String,
    pub provider: LlmProvider,
}

impl AppConfig {
    /// Creates a new config with empty API keys.
    /// Use this when keys will be set at runtime via `set_keys`.
    pub fn new_empty() -> Self {
        Self {
            deepgram_api_key: String::new(),
            ollama_base_url: "https://ollama.com".to_string(),
            ollama_api_key: String::new(),
            ollama_model: "gemma4:31b-cloud".to_string(),
            gemini_api_key: String::new(),
            gemini_model: "gemini-2.5-flash".to_string(),
            provider: LlmProvider::Ollama,
        }
    }

    /// Loads config from environment (legacy method, .env no longer required).
    pub fn load() -> Self {
        // Note: dotenvy removed — keys now fetched from Supabase at runtime
        Self {
            deepgram_api_key: std::env::var("DEEPGRAM_API_KEY")
                .unwrap_or_default(),
            ollama_base_url: std::env::var("OLLAMA_BASE_URL")
                .unwrap_or_else(|_| "https://ollama.com".to_string()),
            ollama_api_key: std::env::var("OLLAMA_API_KEY")
                .unwrap_or_default(),
            ollama_model: std::env::var("OLLAMA_MODEL")
                .unwrap_or_else(|_| "gemma4:31b-cloud".to_string()),
            gemini_api_key: std::env::var("GEMINI_API_KEY").unwrap_or_default(),
            gemini_model: std::env::var("GEMINI_MODEL")
                .unwrap_or_else(|_| "gemini-2.5-flash".to_string()),
            // The provider is a UI choice restored from localStorage, not an
            // environment concern — start on the historical default.
            provider: LlmProvider::Ollama,
        }
    }

    /// Sets the API keys at runtime. Used by `set_api_keys` command.
    pub fn set_keys(&mut self, deepgram: String, ollama: String) {
        self.deepgram_api_key = deepgram;
        self.ollama_api_key = ollama;
    }

    /// Separate from [`set_keys`] so that a Supabase deployment without a
    /// `gemini` row leaves the existing key alone instead of blanking it.
    pub fn set_gemini_key(&mut self, gemini: String) {
        self.gemini_api_key = gemini;
    }

    pub fn is_local_ollama(&self) -> bool {
        self.ollama_base_url.contains("localhost") ||
        self.ollama_base_url.contains("127.0.0.1")
    }

    pub fn is_valid(&self) -> Result<(), String> {
        if self.deepgram_api_key.is_empty() {
            return Err(
                "Deepgram API key not set. Please sign in to fetch your keys from Supabase.".to_string());
        }
        // Only the selected provider's key matters — a user running on Gemini
        // shouldn't be blocked from capturing because the Ollama row is absent.
        match self.provider {
            LlmProvider::Ollama => {
                // API key only required for remote Ollama endpoints
                if !self.is_local_ollama() && self.ollama_api_key.is_empty() {
                    return Err(
                        "Ollama API key not set (required for remote Ollama). For local Ollama, set OLLAMA_BASE_URL=http://localhost:11434".to_string());
                }
            }
            LlmProvider::Gemini => {
                if self.gemini_api_key.is_empty() {
                    return Err(
                        "Gemini API key not set. Add a 'gemini' row to your Supabase api_keys table, or switch the LLM provider back to Ollama in Settings.".to_string());
                }
            }
        }
        Ok(())
    }
}

// Tauri-managed state wrapper with interior mutability for runtime key updates
pub struct ConfigState {
    pub config: Arc<Mutex<AppConfig>>,
}

impl Default for ConfigState {
    fn default() -> Self {
        Self {
            config: Arc::new(Mutex::new(AppConfig::new_empty())),
        }
    }
}
