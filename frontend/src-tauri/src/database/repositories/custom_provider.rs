//! Named OpenAI-compatible servers ("custom providers"). Each server holds an endpoint,
//! an optional API key, the models it offers and optional sampling parameters. Summaries
//! and Ask AI select one server by id (`settings.customProviderId` /
//! `settings.assistantCustomProviderId`) while their provider is `custom-openai`.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub const CUSTOM_PROVIDER: &str = "custom-openai";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub api_key: Option<String>,
    pub models: Vec<String>,
    pub max_tokens: Option<i32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub endpoint: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub max_tokens: Option<i32>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
}

#[derive(Debug)]
pub enum CustomProviderError {
    Invalid(String),
    NotFound,
    InUse { name: String, purpose: &'static str },
    Db(sqlx::Error),
}

impl From<sqlx::Error> for CustomProviderError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl std::fmt::Display for CustomProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::NotFound => f.write_str("That custom server no longer exists"),
            Self::InUse { name, purpose } => {
                write!(f, "{name} is selected for {purpose}; choose another model first")
            }
            Self::Db(error) => write!(f, "Failed to update custom servers: {error}"),
        }
    }
}

#[derive(sqlx::FromRow)]
struct CustomProviderRow {
    id: String,
    name: String,
    endpoint: String,
    api_key: Option<String>,
    models: String,
    max_tokens: Option<i64>,
    temperature: Option<f64>,
    top_p: Option<f64>,
}

impl From<CustomProviderRow> for CustomProvider {
    fn from(row: CustomProviderRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            endpoint: row.endpoint,
            api_key: row.api_key,
            models: serde_json::from_str(&row.models).unwrap_or_default(),
            max_tokens: row.max_tokens.map(|tokens| tokens as i32),
            temperature: row.temperature.map(|value| value as f32),
            top_p: row.top_p.map(|value| value as f32),
        }
    }
}

const SELECT_COLUMNS: &str =
    "SELECT id, name, endpoint, api_key, models, max_tokens, temperature, top_p FROM custom_providers";

/// Validates an endpoint as an absolute http(s) URL and returns it trimmed.
pub fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim();
    match reqwest::Url::parse(endpoint) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.has_host() => {
            Ok(endpoint.to_string())
        }
        _ => Err("Endpoint must be a URL starting with http:// or https://".to_string()),
    }
}

fn invalid(message: impl Into<String>) -> CustomProviderError {
    CustomProviderError::Invalid(message.into())
}

fn validate(input: CustomProviderInput) -> Result<CustomProviderInput, CustomProviderError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(invalid("Server name is required"));
    }
    let endpoint = normalize_endpoint(&input.endpoint).map_err(CustomProviderError::Invalid)?;

    let mut models: Vec<String> = Vec::with_capacity(input.models.len());
    for model in &input.models {
        let model = model.trim();
        if !model.is_empty() && !models.iter().any(|existing| existing == model) {
            models.push(model.to_string());
        }
    }
    if models.is_empty() {
        return Err(invalid("Add at least one model"));
    }

    if input.max_tokens.is_some_and(|tokens| tokens < 1) {
        return Err(invalid("Max tokens must be at least 1"));
    }
    if input.temperature.is_some_and(|value| !(0.0..=2.0).contains(&value)) {
        return Err(invalid("Temperature must be between 0 and 2"));
    }
    if input.top_p.is_some_and(|value| !(0.0..=1.0).contains(&value)) {
        return Err(invalid("Top P must be between 0 and 1"));
    }

    Ok(CustomProviderInput {
        id: input.id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty()),
        name,
        endpoint,
        api_key: input
            .api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty()),
        models,
        max_tokens: input.max_tokens,
        temperature: input.temperature,
        top_p: input.top_p,
    })
}

pub struct CustomProviderRepository;

impl CustomProviderRepository {
    /// All servers, sorted by name (case-insensitive).
    pub async fn list(pool: &SqlitePool) -> Result<Vec<CustomProvider>, sqlx::Error> {
        let rows = sqlx::query_as::<_, CustomProviderRow>(SELECT_COLUMNS)
            .fetch_all(pool)
            .await?;
        let mut providers: Vec<CustomProvider> = rows.into_iter().map(Into::into).collect();
        providers.sort_by_cached_key(|provider| provider.name.to_lowercase());
        Ok(providers)
    }

    pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<CustomProvider>, sqlx::Error> {
        let row = sqlx::query_as::<_, CustomProviderRow>(&format!("{SELECT_COLUMNS} WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(Into::into))
    }

    /// Creates the server when `input.id` is empty, otherwise updates it.
    pub async fn save(
        pool: &SqlitePool,
        input: CustomProviderInput,
    ) -> Result<CustomProvider, CustomProviderError> {
        let input = validate(input)?;
        let lowered = input.name.to_lowercase();
        let duplicate = Self::list(pool).await?.into_iter().any(|existing| {
            existing.name.to_lowercase() == lowered && Some(&existing.id) != input.id.as_ref()
        });
        if duplicate {
            return Err(invalid(format!(
                "A custom server named \"{}\" already exists",
                input.name
            )));
        }

        let models = serde_json::to_string(&input.models)
            .map_err(|error| invalid(format!("Could not store the model list: {error}")))?;
        let now = chrono::Utc::now().to_rfc3339();

        let id = match input.id {
            Some(id) => {
                let updated = sqlx::query(
                    "UPDATE custom_providers SET name = ?, endpoint = ?, api_key = ?, models = ?, \
                     max_tokens = ?, temperature = ?, top_p = ?, updated_at = ? WHERE id = ?",
                )
                .bind(&input.name)
                .bind(&input.endpoint)
                .bind(&input.api_key)
                .bind(&models)
                .bind(input.max_tokens)
                .bind(input.temperature)
                .bind(input.top_p)
                .bind(&now)
                .bind(&id)
                .execute(pool)
                .await?;
                if updated.rows_affected() == 0 {
                    return Err(CustomProviderError::NotFound);
                }
                id
            }
            None => {
                let id = format!("custom-{}", uuid::Uuid::new_v4().simple());
                sqlx::query(
                    "INSERT INTO custom_providers (id, name, endpoint, api_key, models, max_tokens, \
                     temperature, top_p, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&id)
                .bind(&input.name)
                .bind(&input.endpoint)
                .bind(&input.api_key)
                .bind(&models)
                .bind(input.max_tokens)
                .bind(input.temperature)
                .bind(input.top_p)
                .bind(&now)
                .bind(&now)
                .execute(pool)
                .await?;
                id
            }
        };

        Self::get(pool, &id).await?.ok_or(CustomProviderError::NotFound)
    }

    /// Deletes a server unless summaries or Ask AI currently use it.
    pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), CustomProviderError> {
        let mut tx = pool.begin().await?;
        let name: String = sqlx::query_scalar("SELECT name FROM custom_providers WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(CustomProviderError::NotFound)?;

        let selection: Option<(String, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT provider, customProviderId, assistantProvider, assistantCustomProviderId \
                 FROM settings WHERE id = '1'",
            )
            .fetch_optional(&mut *tx)
            .await?;
        if let Some((provider, summary_id, assistant_provider, assistant_id)) = selection {
            if provider == CUSTOM_PROVIDER && summary_id.as_deref() == Some(id) {
                return Err(CustomProviderError::InUse { name, purpose: "summaries" });
            }
            if assistant_provider.as_deref() == Some(CUSTOM_PROVIDER)
                && assistant_id.as_deref() == Some(id)
            {
                return Err(CustomProviderError::InUse { name, purpose: "Ask AI" });
            }
        }

        // Drop references that are not active (another provider is selected).
        sqlx::query(
            "UPDATE settings SET \
             customProviderId = CASE WHEN customProviderId = ?1 THEN NULL ELSE customProviderId END, \
             assistantCustomProviderId = CASE WHEN assistantCustomProviderId = ?1 THEN NULL \
             ELSE assistantCustomProviderId END",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM custom_providers WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Checks a provider/model/server selection and returns the server id to store:
    /// the existing server for `custom-openai`, `None` for every other provider.
    pub async fn validate_selection(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
        custom_provider_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        if provider != CUSTOM_PROVIDER {
            return Ok(None);
        }
        if model.trim().is_empty() {
            return Err("Choose a model for the custom server".to_string());
        }
        let id = custom_provider_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "Choose a custom server".to_string())?;
        match Self::get(pool, id).await {
            Ok(Some(provider)) => Ok(Some(provider.id)),
            Ok(None) => Err("The selected custom server no longer exists".to_string()),
            Err(error) => Err(format!("Failed to read custom servers: {error}")),
        }
    }

    /// Resolves the server a `custom-openai` selection points at, with user-facing errors.
    pub async fn resolve(
        pool: &SqlitePool,
        custom_provider_id: Option<&str>,
    ) -> Result<CustomProvider, String> {
        let id = custom_provider_id
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                "No custom server is selected. Choose one in Model Settings.".to_string()
            })?;
        Self::get(pool, id)
            .await
            .map_err(|error| format!("Failed to read custom servers: {error}"))?
            .ok_or_else(|| {
                "The selected custom server no longer exists. Choose another in Model Settings."
                    .to_string()
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn input(name: &str, models: &[&str]) -> CustomProviderInput {
        CustomProviderInput {
            name: name.to_string(),
            endpoint: "http://localhost:8000/v1".to_string(),
            models: models.iter().map(|model| model.to_string()).collect(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn migration_moves_legacy_blob_into_a_named_server() {
        use sqlx::migrate::Migrator;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let migrator: Migrator = sqlx::migrate!("./migrations");
        let (before, after): (Vec<_>, Vec<_>) = migrator
            .iter()
            .cloned()
            .partition(|migration| migration.version < 20261021000000);
        let legacy = Migrator {
            migrations: std::borrow::Cow::Owned(before),
            ..Migrator::DEFAULT
        };
        legacy.run(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO settings (id, provider, model, whisperModel, customOpenAIConfig) \
             VALUES ('1', 'custom-openai', 'qwen3:8b', 'large-v3', ?)",
        )
        .bind(r#"{"endpoint":" http://box:8000/v1 ","apiKey":"sk-1","model":"qwen3:8b","maxTokens":2048,"temperature":0.4,"topP":0.9}"#)
        .execute(&pool)
        .await
        .unwrap();

        let rest = Migrator {
            migrations: std::borrow::Cow::Owned(after),
            ignore_missing: true,
            ..Migrator::DEFAULT
        };
        rest.run(&pool).await.unwrap();

        let providers = CustomProviderRepository::list(&pool).await.unwrap();
        assert_eq!(providers.len(), 1);
        let server = &providers[0];
        assert!(server.id.starts_with("custom-") && server.id.len() == 39);
        assert_eq!(server.name, "Custom server");
        assert_eq!(server.endpoint, "http://box:8000/v1");
        assert_eq!(server.api_key.as_deref(), Some("sk-1"));
        assert_eq!(server.models, vec!["qwen3:8b".to_string()]);
        assert_eq!(server.max_tokens, Some(2048));
        assert_eq!(server.temperature, Some(0.4));
        assert_eq!(server.top_p, Some(0.9));

        let (selected, blob): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT customProviderId, customOpenAIConfig FROM settings WHERE id = '1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(selected.as_deref(), Some(server.id.as_str()));
        assert_eq!(blob, None);
    }

    #[tokio::test]
    async fn save_validates_names_and_models() {
        let pool = migrated_pool().await;
        let created = CustomProviderRepository::save(&pool, input("Lab box", &[" a ", "a", "b", ""]))
            .await
            .unwrap();
        assert_eq!(created.models, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(created.api_key, None);

        let duplicate = CustomProviderRepository::save(&pool, input("LAB BOX", &["c"])).await;
        assert!(
            matches!(&duplicate, Err(CustomProviderError::Invalid(message)) if message.contains("already exists"))
        );

        let empty = CustomProviderRepository::save(&pool, input("Other", &["  "])).await;
        assert!(
            matches!(&empty, Err(CustomProviderError::Invalid(message)) if message == "Add at least one model")
        );

        // Renaming a server to its own name in another case is not a duplicate.
        let renamed = CustomProviderRepository::save(
            &pool,
            CustomProviderInput {
                id: Some(created.id.clone()),
                api_key: Some("key".to_string()),
                ..input("lab BOX", &["z"])
            },
        )
        .await
        .unwrap();
        assert_eq!(renamed.id, created.id);
        assert_eq!(renamed.name, "lab BOX");
        assert_eq!(renamed.api_key.as_deref(), Some("key"));
    }

    #[tokio::test]
    async fn delete_refuses_servers_in_use() {
        let pool = migrated_pool().await;
        let summary = CustomProviderRepository::save(&pool, input("Summary box", &["m"]))
            .await
            .unwrap();
        let ask = CustomProviderRepository::save(&pool, input("Ask box", &["m"]))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO settings (id, provider, model, whisperModel, customProviderId, \
             assistantProvider, assistantModel, assistantCustomProviderId) \
             VALUES ('1', 'custom-openai', 'm', 'large-v3', ?, 'custom-openai', 'm', ?)",
        )
        .bind(&summary.id)
        .bind(&ask.id)
        .execute(&pool)
        .await
        .unwrap();

        let error = CustomProviderRepository::delete(&pool, &summary.id).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "Summary box is selected for summaries; choose another model first"
        );
        let error = CustomProviderRepository::delete(&pool, &ask.id).await.unwrap_err();
        assert_eq!(error.to_string(), "Ask box is selected for Ask AI; choose another model first");

        sqlx::query("UPDATE settings SET assistantProvider = NULL, assistantModel = NULL")
            .execute(&pool)
            .await
            .unwrap();
        CustomProviderRepository::delete(&pool, &ask.id).await.unwrap();
        assert!(CustomProviderRepository::get(&pool, &ask.id).await.unwrap().is_none());
        let stale: Option<String> =
            sqlx::query_scalar("SELECT assistantCustomProviderId FROM settings WHERE id = '1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stale, None);
    }
}
