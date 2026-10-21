-- Named OpenAI-compatible servers. Each server lists the models it offers; the summary
-- selection (settings.customProviderId + settings.model) and the optional Ask AI
-- selection (settings.assistant*) point at one server and one model.
CREATE TABLE custom_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    api_key TEXT,
    models TEXT NOT NULL DEFAULT '[]', -- JSON array of model ids
    max_tokens INTEGER,
    temperature REAL,
    top_p REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_custom_providers_name ON custom_providers(lower(name));

ALTER TABLE settings ADD COLUMN customProviderId TEXT;
-- NULL assistantProvider means Ask AI follows the summary selection.
ALTER TABLE settings ADD COLUMN assistantProvider TEXT;
ALTER TABLE settings ADD COLUMN assistantModel TEXT;
ALTER TABLE settings ADD COLUMN assistantCustomProviderId TEXT;

-- Carry the single legacy server over. When it was the active provider, the model in
-- use is settings.model, so keep it in the list next to the blob's model.
INSERT INTO custom_providers
    (id, name, endpoint, api_key, models, max_tokens, temperature, top_p, created_at, updated_at)
SELECT
    'custom-' || lower(hex(randomblob(16))),
    'Custom server',
    trim(json_extract(customOpenAIConfig, '$.endpoint')),
    NULLIF(trim(COALESCE(json_extract(customOpenAIConfig, '$.apiKey'), '')), ''),
    CASE
        WHEN provider = 'custom-openai'
            AND trim(model) <> ''
            AND trim(model) <> trim(json_extract(customOpenAIConfig, '$.model'))
        THEN json_array(trim(json_extract(customOpenAIConfig, '$.model')), trim(model))
        ELSE json_array(trim(json_extract(customOpenAIConfig, '$.model')))
    END,
    CAST(json_extract(customOpenAIConfig, '$.maxTokens') AS INTEGER),
    CAST(json_extract(customOpenAIConfig, '$.temperature') AS REAL),
    CAST(json_extract(customOpenAIConfig, '$.topP') AS REAL),
    datetime('now'),
    datetime('now')
FROM settings
WHERE id = '1'
  AND customOpenAIConfig IS NOT NULL
  AND json_valid(customOpenAIConfig)
  AND json_type(customOpenAIConfig) = 'object'
  AND trim(COALESCE(json_extract(customOpenAIConfig, '$.endpoint'), '')) <> ''
  AND trim(COALESCE(json_extract(customOpenAIConfig, '$.model'), '')) <> '';

UPDATE settings
SET customProviderId = (SELECT id FROM custom_providers LIMIT 1)
WHERE id = '1' AND provider = 'custom-openai';

UPDATE settings SET customOpenAIConfig = NULL;
