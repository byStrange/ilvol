use std::sync::{Arc, Mutex};

/// Application configuration with runtime-mutable API keys.
/// Keys are fetched from Supabase at runtime, not from .env files.
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub deepgram_api_key: String,
    pub ollama_base_url: String,
    pub ollama_api_key: String,
    pub ollama_model: String,
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
        }
    }

    /// Sets the API keys at runtime. Used by `set_api_keys` command.
    pub fn set_keys(&mut self, deepgram: String, ollama: String) {
        self.deepgram_api_key = deepgram;
        self.ollama_api_key = ollama;
    }

    pub fn is_local_ollama(&self) -> bool {
        self.ollama_base_url.contains("localhost") ||
        self.ollama_base_url.contains("127.0.0.1")
    }

    pub fn is_valid(&self) -> Result<(), String> {
        if self.deepgram_api_key.is_empty() {
            return Err(
                "DEEPGRAM_API_KEY not set. Please create a .env file in the app folder.".to_string());
        }
        // API key only required for remote Ollama endpoints
        if !self.is_local_ollama() && self.ollama_api_key.is_empty() {
            return Err(
                "OLLAMA_API_KEY not set (required for remote Ollama). For local Ollama, set OLLAMA_BASE_URL=http://localhost:11434".to_string());
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
