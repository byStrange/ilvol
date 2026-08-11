use std::sync::{Arc, Mutex};

/// Application configuration.
///
/// Deliberately holds NO provider credentials. Deepgram and Ollama keys live
/// only in Supabase Edge Function secrets — the desktop process receives a
/// short-lived Deepgram token per capture and never sees an Ollama key at all.
/// What remains here is the local-Ollama development path.
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub ollama_base_url: String,
    pub ollama_model: String,
}

impl AppConfig {
    /// Reads the local-development overrides from the environment.
    pub fn load() -> Self {
        Self {
            ollama_base_url: std::env::var("OLLAMA_BASE_URL")
                .unwrap_or_else(|_| "https://ollama.com".to_string()),
            ollama_model: std::env::var("OLLAMA_MODEL")
                .unwrap_or_else(|_| "gemma4:31b-cloud".to_string()),
        }
    }

    pub fn is_local_ollama(&self) -> bool {
        self.ollama_base_url.contains("localhost") || self.ollama_base_url.contains("127.0.0.1")
    }
}

// Tauri-managed state wrapper.
pub struct ConfigState {
    pub config: Arc<Mutex<AppConfig>>,
}

impl Default for ConfigState {
    fn default() -> Self {
        Self {
            config: Arc::new(Mutex::new(AppConfig::load())),
        }
    }
}
