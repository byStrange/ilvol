use std::sync::Arc;

/// Application configuration loaded from .env file.
/// Users never see or enter these — they're compiled/shipped with the app.
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub deepgram_api_key: String,
    pub ollama_base_url: String,
    pub ollama_api_key: String,
    pub ollama_model: String,
}

impl AppConfig {
    pub fn load() -> Self {
        // Load .env from the same directory as the executable
        let _ = dotenvy::dotenv();

        Self {
            deepgram_api_key: std::env::var("DEEPGRAM_API_KEY")
                .unwrap_or_default(),
            ollama_base_url: std::env::var("OLLAMA_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:11434".to_string()),
            ollama_api_key: std::env::var("OLLAMA_API_KEY")
                .unwrap_or_default(),
            ollama_model: std::env::var("OLLAMA_MODEL")
                .unwrap_or_else(|_| "llama3.1".to_string()),
        }
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

// Tauri-managed state wrapper
pub struct ConfigState {
    pub config: Arc<AppConfig>,
}
