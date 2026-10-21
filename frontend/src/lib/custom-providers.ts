/**
 * Saved OpenAI-compatible servers ("custom servers") and the Ask AI model choice.
 *
 * A server holds an endpoint, an optional key and the models the user wants to
 * offer. Summaries and Ask AI each pick one server plus a model; the provider
 * string for all of them stays 'custom-openai'.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ModelConfig } from '@/services/configService';

/** `id` is what the API receives; `name` is the server's human-readable label, if any. */
export interface CustomModel {
  id: string;
  name?: string | null;
}

export interface CustomProvider {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string | null;
  models: CustomModel[];
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
}

export interface CustomProviderInput extends Omit<CustomProvider, 'id'> {
  /** Null creates a new server. */
  id: string | null;
}

/** Ask AI's own model. `provider: null` follows the summary model. */
export interface AssistantModelConfig {
  provider: ModelConfig['provider'] | null;
  model: string | null;
  customProviderId: string | null;
}

export interface ConnectionTestResult {
  status: string;
  message: string;
}

export const CUSTOM_PROVIDER = 'custom-openai';

/** Emitted by the backend (Tauri) and by this module (window) after a server is saved or deleted. */
export const CUSTOM_PROVIDERS_CHANGED_EVENT = 'custom-providers-changed';

/** Window event for Ask AI model changes; `model-config-updated` carries the summary model only. */
export const ASSISTANT_MODEL_CHANGED_EVENT = 'assistant-model-config-updated';

export async function listCustomProviders(): Promise<CustomProvider[]> {
  return invoke<CustomProvider[]>('api_list_custom_providers');
}

export async function saveCustomProvider(provider: CustomProviderInput): Promise<CustomProvider> {
  const saved = await invoke<CustomProvider>('api_save_custom_provider', { provider });
  window.dispatchEvent(new Event(CUSTOM_PROVIDERS_CHANGED_EVENT));
  return saved;
}

export async function deleteCustomProvider(id: string): Promise<void> {
  await invoke<void>('api_delete_custom_provider', { id });
  window.dispatchEvent(new Event(CUSTOM_PROVIDERS_CHANGED_EVENT));
}

/** Models from the server's `/models` endpoint, with display names when the server gives them. */
export async function fetchCustomProviderModels(endpoint: string, apiKey: string | null): Promise<CustomModel[]> {
  return invoke<CustomModel[]>('api_fetch_custom_provider_models', { endpoint, apiKey });
}

/** Sends a tiny chat completion to check endpoint, key and model together. */
export async function testCustomProviderConnection(
  endpoint: string,
  apiKey: string | null,
  model: string
): Promise<ConnectionTestResult> {
  return invoke<ConnectionTestResult>('api_test_custom_provider_connection', { endpoint, apiKey, model });
}

export async function getAssistantModelConfig(): Promise<AssistantModelConfig> {
  return invoke<AssistantModelConfig>('api_get_assistant_model_config');
}

export async function saveAssistantModelConfig(config: AssistantModelConfig): Promise<void> {
  await invoke<void>('api_save_assistant_model_config', {
    provider: config.provider,
    model: config.provider ? config.model : null,
    customProviderId: config.provider === CUSTOM_PROVIDER ? config.customProviderId : null,
  });
  window.dispatchEvent(new Event(ASSISTANT_MODEL_CHANGED_EVENT));
}

/** The provider as people know it: a custom server's own name, otherwise the provider id. */
export function providerDisplayName(
  config: { provider: string; customProviderId?: string | null },
  providers: CustomProvider[] | null
): string {
  if (config.provider !== CUSTOM_PROVIDER) return config.provider;
  return providers?.find((entry) => entry.id === config.customProviderId)?.name ?? 'Custom server';
}

/** A custom model's display name, falling back to its id (also for ids not in the list). */
export function customModelLabel(provider: CustomProvider | null | undefined, modelId: string): string {
  return provider?.models.find((model) => model.id === modelId)?.name || modelId;
}
