use crate::database::models::{Setting, TranscriptSetting};
use crate::database::repositories::custom_provider::CUSTOM_PROVIDER;
use sqlx::SqlitePool;

#[derive(serde::Deserialize, Debug)]
pub struct SaveModelConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct SaveTranscriptConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

/// Ask AI selection. `provider: None` means Ask AI follows the summary selection.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantModelConfig {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub custom_provider_id: Option<String>,
}

pub struct SettingsRepository;

// Transcript providers: localWhisper, deepgram, elevenLabs, groq, openai
// Summary providers: openai, claude, claude-cli, ollama, groq, added openrouter
// NOTE: Handle data exclusion in the higher layer as this is database abstraction layer(using SELECT *)

impl SettingsRepository {
    pub async fn get_model_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<Setting>, sqlx::Error> {
        let setting = sqlx::query_as::<_, Setting>("SELECT * FROM settings LIMIT 1")
            .fetch_optional(pool)
            .await?;
        Ok(setting)
    }

    pub async fn save_model_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
        whisper_model: &str,
        ollama_endpoint: Option<&str>,
        summary_max_tokens: Option<i64>,
        custom_provider_id: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        // Using id '1' for backward compatibility
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, ollamaEndpoint, summaryMaxTokens, customProviderId)
            VALUES ('1', $1, $2, $3, $4, $5, $6)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model,
                whisperModel = excluded.whisperModel,
                ollamaEndpoint = excluded.ollamaEndpoint,
                summaryMaxTokens = excluded.summaryMaxTokens,
                customProviderId = excluded.customProviderId
            "#,
        )
        .bind(provider)
        .bind(model)
        .bind(whisper_model)
        .bind(ollama_endpoint)
        .bind(summary_max_tokens)
        .bind(custom_provider_id)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn get_assistant_model_config(
        pool: &SqlitePool,
    ) -> std::result::Result<AssistantModelConfig, sqlx::Error> {
        let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT assistantProvider, assistantModel, assistantCustomProviderId FROM settings WHERE id = '1'",
        )
        .fetch_optional(pool)
        .await?;
        Ok(row
            .map(|(provider, model, custom_provider_id)| AssistantModelConfig {
                provider,
                model,
                custom_provider_id,
            })
            .unwrap_or_default())
    }

    /// Stores the Ask AI selection; returns false when no settings row exists yet.
    pub async fn save_assistant_model_config(
        pool: &SqlitePool,
        config: &AssistantModelConfig,
    ) -> std::result::Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE settings SET assistantProvider = ?, assistantModel = ?, assistantCustomProviderId = ? WHERE id = '1'",
        )
        .bind(&config.provider)
        .bind(&config.model)
        .bind(&config.custom_provider_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Read the configured cap on summary output length.
    /// `None` means "use the provider default".
    pub async fn get_summary_max_tokens(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<i64>, sqlx::Error> {
        let value: Option<Option<i64>> =
            sqlx::query_scalar("SELECT summaryMaxTokens FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(value.flatten())
    }

    pub async fn save_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom server keys are saved with the server (api_save_custom_provider)
        if provider == CUSTOM_PROVIDER {
            return Err(sqlx::Error::Protocol(
                "custom-openai keys are saved with the custom server, not with save_api_key()".into(),
            ));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "claude" => "anthropicApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            "claude-cli" => return Ok(()), // Auth is owned by the Claude Code CLI
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, "{}")
            VALUES ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column, api_key_column
        );
        sqlx::query(&query).bind(api_key).execute(pool).await?;

        Ok(())
    }

    pub async fn get_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        // Custom servers keep their own key; use the server selected for summaries
        if provider == CUSTOM_PROVIDER {
            let key: Option<Option<String>> = sqlx::query_scalar(
                "SELECT p.api_key FROM settings s JOIN custom_providers p ON p.id = s.customProviderId WHERE s.id = '1'",
            )
            .fetch_optional(pool)
            .await?;
            return Ok(key.flatten());
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(None), // No API key needed
            "claude-cli" => return Ok(None), // Auth is owned by the Claude Code CLI
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "SELECT {} FROM settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query).fetch_optional(pool).await?;
        Ok(api_key)
    }

    pub async fn get_transcript_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<TranscriptSetting>, sqlx::Error> {
        let setting =
            sqlx::query_as::<_, TranscriptSetting>("SELECT * FROM transcript_settings LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(setting)

    }

    pub async fn save_transcript_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, provider, model)
            VALUES ('1', $1, $2)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model
            "#,
        )
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn get_post_call_transcript_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<(String, String)>, sqlx::Error> {
        sqlx::query_as::<_, (String, String)>(
            r#"
            SELECT postCallProvider, postCallModel
            FROM transcript_settings
            WHERE id = '1'
              AND postCallProvider IS NOT NULL
              AND postCallModel IS NOT NULL
            LIMIT 1
            "#,
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn save_post_call_transcript_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, provider, model, postCallProvider, postCallModel)
            VALUES ('1', 'parakeet', $1, $2, $3)
            ON CONFLICT(id) DO UPDATE SET
                postCallProvider = excluded.postCallProvider,
                postCallModel = excluded.postCallModel
            "#,
        )
        .bind(crate::config::DEFAULT_PARAKEET_MODEL)
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(()), // Parakeet doesn't need an API key, return early
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            r#"
            INSERT INTO transcript_settings (id, provider, model, "{}")
            VALUES ('1', 'parakeet', '{}', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column, crate::config::DEFAULT_PARAKEET_MODEL, api_key_column
        );
        sqlx::query(&query).bind(api_key).execute(pool).await?;

        Ok(())
    }

    pub async fn get_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(None), // Parakeet doesn't need an API key
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "SELECT {} FROM transcript_settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query).fetch_optional(pool).await?;
        Ok(api_key)
    }

    pub async fn delete_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom servers keep their own key; clear the server selected for summaries
        if provider == CUSTOM_PROVIDER {
            sqlx::query(
                "UPDATE custom_providers SET api_key = NULL, updated_at = ? \
                 WHERE id = (SELECT customProviderId FROM settings WHERE id = '1')",
            )
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(pool)
            .await?;
            return Ok(());
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            "claude-cli" => return Ok(()), // Auth is owned by the Claude Code CLI
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "UPDATE settings SET {} = NULL WHERE id = '1'",
            api_key_column
        );
        sqlx::query(&query).execute(pool).await?;

        Ok(())
    }

    // ===== CLAUDE CODE CLI METHODS =====

    /// Read the user-configured Claude Code CLI executable path.
    /// `None` (or a blank string) means the backend discovers the binary itself.
    pub async fn get_claude_cli_path(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let path: Option<Option<String>> =
            sqlx::query_scalar("SELECT claudeCliPath FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(path
            .flatten()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()))
    }

    /// Persist an explicit Claude Code CLI path, or clear it to resume auto-discovery.
    pub async fn save_claude_cli_path(
        pool: &SqlitePool,
        path: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        let normalised = path.map(str::trim).filter(|value| !value.is_empty());

        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, claudeCliPath)
            VALUES ('1', 'claude-cli', 'sonnet', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                claudeCliPath = excluded.claudeCliPath
            "#,
        )
        .bind(normalised)
        .execute(pool)
        .await?;

        Ok(())
    }
}
