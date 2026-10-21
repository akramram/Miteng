import { useState, useEffect, useRef } from 'react';
import { useSidebar } from './Sidebar/SidebarProvider';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { useOllamaDownload } from '@/contexts/OllamaDownloadContext';
import { BuiltInModelManager } from '@/components/BuiltInModelManager';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfig } from '@/contexts/ConfigContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Lock, Unlock, Eye, EyeOff, RefreshCw, CheckCircle2, XCircle, ChevronDown, ChevronUp, Download, ExternalLink, Check, ChevronsUpDown, Pencil } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn, isOllamaNotInstalledError } from '@/lib/utils';
import { ClaudeCliSettings } from '@/components/ClaudeCliSettings';
import {
  CLAUDE_CLI_DEFAULT_MODEL,
  CLAUDE_CLI_FALLBACK_MODELS,
  ClaudeCliStatus,
  getClaudeCliPath,
  isClaudeCliReady,
  listClaudeCliModels,
} from '@/lib/claude-cli';
import { toast } from 'sonner';
import { claudeOutputBudget, parseClaudeOutputTokens } from '@/lib/claude-output-tokens';
import { Combobox } from '@/components/ui/combobox';
import { IconButton } from '@/components/ui/icon-button';
import { CustomServerDialog } from '@/components/settings/CustomServers';
import { useCustomProviders } from '@/hooks/useCustomProviders';
import { CUSTOM_PROVIDER, type CustomProvider } from '@/lib/custom-providers';
import type { ModelConfig } from '@/services/configService';

export type { ModelConfig };

/** Select value that opens the add-server form instead of choosing a server. */
const ADD_SERVER_VALUE = '__add_server__';

interface OllamaModel {
  name: string;
  id: string;
  size: string;
  modified: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  prompt_price?: string;
  completion_price?: string;
}

interface OpenAIModel {
  id: string;
}

interface AnthropicModel {
  id: string;
  display_name?: string;
}

interface GroqModel {
  id: string;
  owned_by?: string;
}

// Fallback models for when API fetch fails or no API key provided
const OPENAI_FALLBACK_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1',
  'o1-mini',
  'o3',
  'o3-mini',
];

const CLAUDE_FALLBACK_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101',
  'claude-3-5-sonnet-latest',
];

const GROQ_FALLBACK_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
];

interface ModelSettingsModalProps {
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSave: (config: ModelConfig) => void;
  skipInitialFetch?: boolean; // Optional: skip fetching config from backend if parent manages it
  layout?: 'inline' | 'dialog';
  /**
   * 'assistant' edits the Ask AI model: state comes only from props (never from
   * ConfigContext, which holds the summary model) and summary-only fields are hidden.
   */
  scope?: 'summary' | 'assistant';
}

export function ModelSettingsModal({
  modelConfig: propsModelConfig,
  setModelConfig: propsSetModelConfig,
  onSave,
  skipInitialFetch = false,
  layout = 'inline',
  scope = 'summary',
}: ModelSettingsModalProps) {
  // The summary model lives in ConfigContext when available; the Ask AI model is props-only.
  const configContext = useConfig();
  const isAssistant = scope === 'assistant';
  const modelConfig = (!isAssistant && configContext?.modelConfig) || propsModelConfig;
  const setModelConfig = (!isAssistant && configContext?.setModelConfig) || propsSetModelConfig;
  const providerApiKeys = configContext?.providerApiKeys;
  const updateProviderApiKey = configContext?.updateProviderApiKey;
  const customProviders = useCustomProviders();
  const selectedServer = customProviders?.find((entry) => entry.id === modelConfig.customProviderId) ?? null;
  const [serverDialogOpen, setServerDialogOpen] = useState<boolean>(false);
  const [serverDialogTarget, setServerDialogTarget] = useState<CustomProvider | null>(null);

  const [models, setModels] = useState<OllamaModel[]>([]);
  const [error, setError] = useState<string>('');
  const [apiKey, setApiKey] = useState<string | null>(modelConfig.apiKey || null);
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [isApiKeyLocked, setIsApiKeyLocked] = useState<boolean>(!!modelConfig.apiKey?.trim());
  const [isLockButtonVibrating, setIsLockButtonVibrating] = useState<boolean>(false);
  const { serverAddress } = useSidebar();
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [openRouterError, setOpenRouterError] = useState<string>('');
  const [isLoadingOpenRouter, setIsLoadingOpenRouter] = useState<boolean>(false);
  const [ollamaEndpoint, setOllamaEndpoint] = useState<string>(modelConfig.ollamaEndpoint || '');
  const [isLoadingOllama, setIsLoadingOllama] = useState<boolean>(false);
  const [lastFetchedEndpoint, setLastFetchedEndpoint] = useState<string>(modelConfig.ollamaEndpoint || '');
  const [endpointValidationState, setEndpointValidationState] = useState<'valid' | 'invalid' | 'none'>('none');
  const [hasAutoFetched, setHasAutoFetched] = useState<boolean>(false);
  const hasSyncedFromParent = useRef<boolean>(false);
  const hasLoadedInitialConfig = useRef<boolean>(false);
  const [autoGenerateEnabled, setAutoGenerateEnabled] = useState<boolean>(true); // Default to true
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isEndpointSectionCollapsed, setIsEndpointSectionCollapsed] = useState<boolean>(true); // Collapsed by default
  const [ollamaNotInstalled, setOllamaNotInstalled] = useState<boolean>(false); // Track if Ollama is not installed

  // Summary output cap, kept as a string so the field can be emptied
  const [summaryMaxTokens, setSummaryMaxTokens] = useState<string>(
    modelConfig.summaryMaxTokens?.toString() || ''
  );
  // Claude Code CLI state
  const [claudeCliPath, setClaudeCliPath] = useState<string>(modelConfig.claudeCliPath || '');
  const [claudeCliModels, setClaudeCliModels] = useState<string[]>(CLAUDE_CLI_FALLBACK_MODELS);
  const [claudeCliStatus, setClaudeCliStatus] = useState<ClaudeCliStatus | null>(null);

  // Combobox state
  const [modelComboboxOpen, setModelComboboxOpen] = useState<boolean>(false);

  // Dynamic model fetching state for OpenAI, Claude, and Groq
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [claudeModels, setClaudeModels] = useState<string[]>([]);
  const [groqModels, setGroqModels] = useState<string[]>([]);
  const [isLoadingOpenAI, setIsLoadingOpenAI] = useState<boolean>(false);
  const [isLoadingClaude, setIsLoadingClaude] = useState<boolean>(false);
  const [isLoadingGroq, setIsLoadingGroq] = useState<boolean>(false);

  // Use global download context instead of local state
  const { isDownloading, getProgress, downloadingModels } = useOllamaDownload();

  // Built-in AI models state
  const [builtinAiModels, setBuiltinAiModels] = useState<any[]>([]);

  // Cache models by endpoint to avoid refetching when reverting endpoint changes
  const modelsCache = useRef<Map<string, OllamaModel[]>>(new Map());

  // URL validation helper
  const validateOllamaEndpoint = (url: string): boolean => {
    if (!url.trim()) return true; // Empty is valid (uses default)
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  // Debounced URL validation with visual feedback
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = ollamaEndpoint.trim();

      if (!trimmed) {
        setEndpointValidationState('none');
      } else if (validateOllamaEndpoint(trimmed)) {
        setEndpointValidationState('valid');
      } else {
        setEndpointValidationState('invalid');
      }
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [ollamaEndpoint]);

  const fetchApiKey = async (provider: string) => {
    try {
      const data = (await invoke('api_get_api_key', {
        provider,
      })) as string;
      setApiKey(data || '');
    } catch (err) {
      console.error('Error fetching API key:', err);
      setApiKey(null);
    }
  };

  // Auto-unlock when API key becomes empty, 
  useEffect(() => {
    const hasContent = !!apiKey?.trim();
    if (!hasContent) {
      setIsApiKeyLocked(false);
    }
  }, [apiKey]);

  const modelOptions: Record<string, string[]> = {
    ollama: models.map((model) => model.name),
    claude: claudeModels.length > 0 ? claudeModels : CLAUDE_FALLBACK_MODELS,
    'claude-cli': claudeCliModels,
    groq: groqModels.length > 0 ? groqModels : GROQ_FALLBACK_MODELS,
    openai: openaiModels.length > 0 ? openaiModels : OPENAI_FALLBACK_MODELS,
    openrouter: openRouterModels.map((m) => m.id),
    'builtin-ai': builtinAiModels.map((m) => m.name),
    'custom-openai': selectedServer?.models ?? [],
  };

  const requiresApiKey =
    modelConfig.provider === 'claude' ||
    modelConfig.provider === 'groq' ||
    modelConfig.provider === 'openai' ||
    modelConfig.provider === 'openrouter';

  // Check if Ollama endpoint has changed but models haven't been fetched yet
  const ollamaEndpointChanged = modelConfig.provider === 'ollama' &&
    ollamaEndpoint.trim() !== lastFetchedEndpoint.trim();

  // A custom server must still exist and a model name must be chosen or typed
  const isCustomServerInvalid = modelConfig.provider === CUSTOM_PROVIDER && (
    !selectedServer ||
    !modelConfig.model?.trim()
  );

  // The CLI provider has no key to validate, so readiness is the gate instead:
  // saving a provider that cannot run would only fail later, at summary time.
  const isClaudeCliInvalid =
    modelConfig.provider === 'claude-cli' && !isClaudeCliReady(claudeCliStatus);

  const isDoneDisabled =
    (requiresApiKey && (!apiKey || (typeof apiKey === 'string' && !apiKey.trim()))) ||
    (modelConfig.provider === 'ollama' && ollamaEndpointChanged) ||
    isCustomServerInvalid ||
    isClaudeCliInvalid;

  useEffect(() => {
    const fetchModelConfig = async () => {
      // Skip when the parent manages config; the Ask AI model never comes from this summary fetch
      if (skipInitialFetch || isAssistant) {
        hasLoadedInitialConfig.current = true;
        return;
      }

      try {
        const data = (await invoke('api_get_model_config')) as any;
        if (data && data.provider !== null) {
          setModelConfig(data);

          // Fetch API key if not included in response and provider requires it
          if (data.provider !== 'ollama' && data.provider !== 'claude-cli' && !data.apiKey) {
            try {
              const apiKeyData = await invoke('api_get_api_key', {
                provider: data.provider
              }) as string;
              data.apiKey = apiKeyData;
              setApiKey(apiKeyData);
            } catch (err) {
              console.error('Failed to fetch API key:', err);
            }
          }

          // Sync ollamaEndpoint state with fetched config
          if (data.ollamaEndpoint) {
            setOllamaEndpoint(data.ollamaEndpoint);
            // Don't set lastFetchedEndpoint here - it will be set after successful model fetch
          }
          hasLoadedInitialConfig.current = true; // Mark that initial config is loaded

          // Sync the Claude Code CLI path when that provider is already active
          if (data.provider === 'claude-cli') {
            setClaudeCliPath(data.claudeCliPath || '');
            loadClaudeCliModels();
          }
        }
      } catch (error) {
        console.error('Failed to fetch model config:', error);
        hasLoadedInitialConfig.current = true; // Mark as loaded even on error
      }
    };

    fetchModelConfig();
  }, [skipInitialFetch]);

  // Fetch auto-generate setting on mount
  useEffect(() => {
    const fetchAutoGenerateSetting = async () => {
      try {
        const enabled = (await invoke('api_get_auto_generate_setting')) as boolean;
        setAutoGenerateEnabled(enabled);
        console.log('Auto-generate setting loaded:', enabled);
      } catch (err) {
        console.error('Failed to fetch auto-generate setting:', err);
        // Keep default value (true) on error
      }
    };

    fetchAutoGenerateSetting();
  }, []);

  // Sync ollamaEndpoint state when modelConfig.ollamaEndpoint changes from parent
  useEffect(() => {
    const endpoint = modelConfig.ollamaEndpoint || '';
    if (endpoint !== ollamaEndpoint) {
      setOllamaEndpoint(endpoint);
      // Don't set lastFetchedEndpoint here - only after successful model fetch
    }
    // Only mark as synced if we have a valid provider (prevents race conditions during init)
    if (modelConfig.provider) {
      hasSyncedFromParent.current = true; // Mark that we've received prop value
    }
  }, [modelConfig.ollamaEndpoint, modelConfig.provider]);

  // Reset hasAutoFetched flag and clear models when switching away from Ollama
  useEffect(() => {
    if (modelConfig.provider !== 'ollama') {
      setHasAutoFetched(false); // Reset flag so it can auto-fetch again if user switches back
      setModels([]); // Clear models list
      setError(''); // Clear any error state
      setOllamaNotInstalled(false); // Reset installation status
    }
  }, [modelConfig.provider]);

  // Handle endpoint changes - restore cached models or clear
  useEffect(() => {
    if (modelConfig.provider === 'ollama' &&
      ollamaEndpoint.trim() !== lastFetchedEndpoint.trim()) {

      // Check if we have cached models for this endpoint (including empty endpoint = default)
      const cachedModels = modelsCache.current.get(ollamaEndpoint.trim());

      if (cachedModels && cachedModels.length > 0) {
        // Restore cached models and update tracking
        setModels(cachedModels);
        setLastFetchedEndpoint(ollamaEndpoint.trim());
        setError('');
      } else {
        // No cache - clear models and allow refetch
        setHasAutoFetched(false);
        setModels([]);
        setError('');
      }
    }
  }, [ollamaEndpoint, lastFetchedEndpoint, modelConfig.provider]);

  // Sync local apiKey state when provider changes
  useEffect(() => {
    if (providerApiKeys && requiresApiKey && modelConfig.provider !== 'custom-openai') {
      const correctKey = providerApiKeys[modelConfig.provider as keyof typeof providerApiKeys];
      if (correctKey !== apiKey) {
        setApiKey(correctKey || '');
        setIsApiKeyLocked(!!correctKey?.trim());
      }
    }
  }, [modelConfig.provider, providerApiKeys, requiresApiKey]);

  // Adopt an output cap that arrived from the parent (skipInitialFetch callers
  // own the fetch, so the field would otherwise stay on its initial value).
  useEffect(() => {
    setSummaryMaxTokens(modelConfig.summaryMaxTokens?.toString() ?? '');
  }, [modelConfig.summaryMaxTokens]);
  // Adopt a CLI path that arrived from the parent (skipInitialFetch callers own
  // the fetch, so the field would otherwise stay on its initial empty value).
  useEffect(() => {
    if (modelConfig.provider === 'claude-cli' && modelConfig.claudeCliPath) {
      setClaudeCliPath(modelConfig.claudeCliPath);
    }
  }, [modelConfig.provider, modelConfig.claudeCliPath]);

  // Manual fetch function for Ollama models
  const fetchOllamaModels = async (silent = false) => {
    const trimmedEndpoint = ollamaEndpoint.trim();

    // Validate URL if provided
    if (trimmedEndpoint && !validateOllamaEndpoint(trimmedEndpoint)) {
      const errorMsg = 'Invalid Ollama endpoint URL. Must start with http:// or https://';
      setError(errorMsg);
      if (!silent) {
        toast.error(errorMsg);
      }
      return;
    }

    setIsLoadingOllama(true);
    setError(''); // Clear previous errors

    try {
      const endpoint = trimmedEndpoint || null;
      const modelList = (await invoke('get_ollama_models', { endpoint })) as OllamaModel[];
      setModels(modelList);
      setLastFetchedEndpoint(trimmedEndpoint); // Track successful fetch

      // Cache the fetched models for this endpoint
      modelsCache.current.set(trimmedEndpoint, modelList);

      // Successfully fetched models, Ollama is installed
      setOllamaNotInstalled(false);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to load Ollama models';
      setError(errorMsg);

      // Check if error indicates Ollama is not installed
      if (isOllamaNotInstalledError(errorMsg)) {
        setOllamaNotInstalled(true);
      } else {
        setOllamaNotInstalled(false);
      }

      if (!silent) {
        toast.error(errorMsg);
      }
      console.error('Error loading models:', err);
    } finally {
      setIsLoadingOllama(false);
    }
  };

  // Auto-fetch models on initial load only (not on endpoint changes)
  useEffect(() => {
    let mounted = true;

    const initialLoad = async () => {
      // Only auto-fetch on initial load if:
      // 1. Provider is ollama
      // 2. Haven't fetched yet
      // 3. Component is still mounted
      // If skipInitialFetch is true, fetch silently (no error toasts)
      if (modelConfig.provider === 'ollama' &&
        !hasAutoFetched &&
        mounted) {
        await fetchOllamaModels(skipInitialFetch); // Silent if skipInitialFetch=true
        setHasAutoFetched(true);
      }
    };

    initialLoad();

    return () => {
      mounted = false;
    };
  }, [modelConfig.provider]); // Only depend on provider, NOT endpoint

  const loadOpenRouterModels = async () => {
    if (openRouterModels.length > 0) return; // Already loaded

    try {
      setIsLoadingOpenRouter(true);
      setOpenRouterError('');
      const data = (await invoke('get_openrouter_models')) as OpenRouterModel[];
      setOpenRouterModels(data);
    } catch (err) {
      console.error('Error loading OpenRouter models:', err);
      setOpenRouterError(
        err instanceof Error ? err.message : 'Failed to load OpenRouter models'
      );
    } finally {
      setIsLoadingOpenRouter(false);
    }
  };

  const loadBuiltinAiModels = async () => {
    if (builtinAiModels.length > 0) return; // Already loaded

    try {
      const data = (await invoke('builtin_ai_list_models')) as any[];
      setBuiltinAiModels(data);

      // Auto-select first available model if none selected
      if (data.length > 0 && !modelConfig.model) {
        const firstAvailable = data.find((m: any) => m.status?.type === 'available');
        if (firstAvailable) {
          setModelConfig((prev: ModelConfig) => ({ ...prev, model: firstAvailable.name }));
        }
      }
    } catch (err) {
      console.error('Error loading Built-in AI models:', err);
      toast.error('Failed to load Built-in AI models');
    }
  };

  const loadClaudeCliModels = async () => {
    try {
      const data = await listClaudeCliModels();
      if (data.length > 0) {
        setClaudeCliModels(data.map((m) => m.id));
      }
    } catch (err) {
      // The static fallback list is already correct; a failure here is cosmetic.
      console.error('Error loading Claude Code CLI models:', err);
    }
  };

  // Fetch OpenAI models from API
  const loadOpenAIModels = async (key: string | null) => {
    if (!key?.trim()) {
      setOpenaiModels([]); // Will use fallback via modelOptions
      return;
    }
    setIsLoadingOpenAI(true);
    try {
      const data = (await invoke('get_openai_models', { apiKey: key })) as OpenAIModel[];
      setOpenaiModels(data.map((m) => m.id));
    } catch (err) {
      console.error('Error loading OpenAI models:', err);
      setOpenaiModels([]); // Will use fallback via modelOptions
    } finally {
      setIsLoadingOpenAI(false);
    }
  };

  // Fetch Anthropic (Claude) models from API
  const loadClaudeModels = async (key: string | null) => {
    if (!key?.trim()) {
      setClaudeModels([]); // Will use fallback via modelOptions
      return;
    }
    setIsLoadingClaude(true);
    try {
      const data = (await invoke('get_anthropic_models', { apiKey: key })) as AnthropicModel[];
      setClaudeModels(data.map((m) => m.id));
    } catch (err) {
      console.error('Error loading Claude models:', err);
      setClaudeModels([]); // Will use fallback via modelOptions
    } finally {
      setIsLoadingClaude(false);
    }
  };

  // Fetch Groq models from API
  const loadGroqModels = async (key: string | null) => {
    if (!key?.trim()) {
      setGroqModels([]); // Will use fallback via modelOptions
      return;
    }
    setIsLoadingGroq(true);
    try {
      const data = (await invoke('get_groq_models', { apiKey: key })) as GroqModel[];
      setGroqModels(data.map((m) => m.id));
    } catch (err) {
      console.error('Error loading Groq models:', err);
      setGroqModels([]); // Will use fallback via modelOptions
    } finally {
      setIsLoadingGroq(false);
    }
  };

  // Auto-fetch OpenAI models when provider is openai and we have an API key
  useEffect(() => {
    if (modelConfig.provider === 'openai' && apiKey?.trim()) {
      loadOpenAIModels(apiKey);
    }
  }, [modelConfig.provider, apiKey]);

  // Auto-fetch Claude models when provider is claude and we have an API key
  useEffect(() => {
    if (modelConfig.provider === 'claude' && apiKey?.trim()) {
      loadClaudeModels(apiKey);
    }
  }, [modelConfig.provider, apiKey]);

  // Auto-fetch Groq models when provider is groq and we have an API key
  useEffect(() => {
    if (modelConfig.provider === 'groq' && apiKey?.trim()) {
      loadGroqModels(apiKey);
    }
  }, [modelConfig.provider, apiKey]);

  // Restore cached model when async model lists become available
  useEffect(() => {
    // Custom servers pick their model when the server is chosen; a typed model may not be listed
    if (modelConfig.provider === CUSTOM_PROVIDER) return;
    const providerModels = modelOptions[modelConfig.provider];
    if (!providerModels || providerModels.length === 0) return;

    // If current model is already valid, nothing to do
    if (modelConfig.model && providerModels.includes(modelConfig.model)) return;

    // Try to restore from localStorage cache
    const map = JSON.parse(localStorage.getItem('providerModelMap') || '{}');
    const cachedModel = map[modelConfig.provider];
    if (cachedModel && providerModels.includes(cachedModel)) {
      setModelConfig((prev: ModelConfig) => ({ ...prev, model: cachedModel }));
    }
  }, [models, openRouterModels, builtinAiModels, openaiModels, claudeModels, groqModels, modelConfig.provider]);

  const handleSave = async () => {
    let outputTokens = modelConfig.summaryMaxTokens ?? null;
    if (modelConfig.provider === 'claude') {
      try {
        outputTokens = parseClaudeOutputTokens(summaryMaxTokens, modelConfig.model);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const isCustom = modelConfig.provider === CUSTOM_PROVIDER;
    const updatedConfig: ModelConfig = {
      ...modelConfig,
      // A custom server's key lives with the server, not with the model setting
      apiKey: !isCustom && typeof apiKey === 'string' ? apiKey.trim() || null : null,
      ollamaEndpoint: modelConfig.provider === 'ollama'
        ? (ollamaEndpoint.trim() || null)
        : (modelConfig.ollamaEndpoint || null),
      summaryMaxTokens: outputTokens,
      claudeCliPath: modelConfig.provider === 'claude-cli'
        ? (claudeCliPath.trim() || null)
        : (modelConfig.claudeCliPath || null),
      customProviderId: isCustom ? modelConfig.customProviderId ?? null : null,
      model: isCustom ? modelConfig.model.trim() : modelConfig.model,
    };
    setModelConfig(updatedConfig);

    // Remember the summary choice per provider (and per custom server) for quick switching
    if (!isAssistant && updatedConfig.model) {
      const map = JSON.parse(localStorage.getItem('providerModelMap') || '{}');
      map[updatedConfig.provider] = updatedConfig.model;
      if (isCustom) map[`${CUSTOM_PROVIDER}:${updatedConfig.customProviderId}`] = updatedConfig.model;
      localStorage.setItem('providerModelMap', JSON.stringify(map));
    }

    // Update provider-specific key in context
    if (!isAssistant && updateProviderApiKey && updatedConfig.apiKey) {
      updateProviderApiKey(updatedConfig.provider, updatedConfig.apiKey);
    }

    onSave(updatedConfig);
  };

  /** Point the model at a saved server, restoring the model last used with it. */
  const selectServer = (server: CustomProvider) => {
    const map = JSON.parse(localStorage.getItem('providerModelMap') || '{}');
    const cached = map[`${CUSTOM_PROVIDER}:${server.id}`];
    const model = typeof cached === 'string' && cached ? cached : server.models[0] ?? '';
    setModelConfig((prev: ModelConfig) => ({ ...prev, provider: CUSTOM_PROVIDER, customProviderId: server.id, model }));
  };

  const openServerDialog = (server: CustomProvider | null) => {
    setServerDialogTarget(server);
    setServerDialogOpen(true);
  };

  const handleInputClick = () => {
    if (isApiKeyLocked) {
      setIsLockButtonVibrating(true);
      setTimeout(() => setIsLockButtonVibrating(false), 500);
    }
  };

  // Function to download recommended model
  const downloadRecommendedModel = async () => {
    const recommendedModel = 'gemma3:1b';

    // Prevent duplicate downloads (defense in depth - backend also checks)
    if (isDownloading(recommendedModel)) {
      toast.info(`${recommendedModel} is already downloading`, {
        description: `Progress: ${Math.round(getProgress(recommendedModel) || 0)}%`
      });
      return;
    }

    try {
      const endpoint = ollamaEndpoint.trim() || null;

      // The download will be tracked by the global context via events
      // Progress toasts are shown automatically by OllamaDownloadContext
      await invoke('pull_ollama_model', {
        modelName: recommendedModel,
        endpoint
      });

      // Refresh the models list after successful download
      await fetchOllamaModels(true);

      // Note: Model is NOT auto-selected - user must explicitly choose it
      // This respects the database as the single source of truth
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to download model';
      console.error('Error downloading model:', err);

      // Check if Ollama is not installed and show appropriate error
      if (isOllamaNotInstalledError(errorMsg)) {
        toast.error('Ollama is not installed', {
          description: 'Please download and install Ollama before downloading models.',
          duration: 7000,
          action: {
            label: 'Download',
            onClick: () => invoke('open_external_url', { url: 'https://ollama.com/download' })
          }
        });
        // Update the installation status flag
        setOllamaNotInstalled(true);
      }
      // Other errors are handled by the context
    }
  };

  // Function to delete Ollama model
  const deleteOllamaModel = async (modelName: string) => {
    try {
      const endpoint = ollamaEndpoint.trim() || null;
      await invoke('delete_ollama_model', {
        modelName,
        endpoint
      });

      toast.success(`Model ${modelName} deleted`);
      await fetchOllamaModels(true); // Refresh list
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to delete model';
      toast.error(errorMsg);
      console.error('Error deleting model:', err);
    }
  };

  // Track previous downloading models to detect completions
  const previousDownloadingRef = useRef<Set<string>>(new Set());

  // Refresh models list when download completes
  useEffect(() => {
    const current = downloadingModels;
    const previous = previousDownloadingRef.current;

    // Check if any downloads completed (were in previous, not in current)
    for (const modelName of previous) {
      if (!current.has(modelName)) {
        // Download completed, refresh models list
        console.log(`[ModelSettingsModal] Download completed for ${modelName}, refreshing list`);
        fetchOllamaModels(true);
        break; // Only refresh once even if multiple completed
      }
    }

    // Update ref for next comparison
    previousDownloadingRef.current = new Set(current);
  }, [downloadingModels]);

  // Filter Ollama models based on search query
  const filteredModels = models.filter((model) => {
    if (!searchQuery.trim()) return true;

    const query = searchQuery.toLowerCase();
    const isLoaded = modelConfig.model === model.name;
    const loadedText = isLoaded ? 'loaded' : '';

    return (
      model.name.toLowerCase().includes(query) ||
      model.size.toLowerCase().includes(query) ||
      loadedText.includes(query)
    );
  });

  // The server's models, plus a typed model that is not in its list
  const customModelOptions = [...new Set([...(selectedServer?.models ?? []), modelConfig.model].filter(Boolean))].map(
    (id) => ({
      value: id,
      label: id,
      description: selectedServer?.models.includes(id) ? undefined : 'Not in the server list',
    })
  );

  return (
    <div>
      <div className="space-y-4">
        <div>
          <Label>{isAssistant ? 'Provider and model' : 'Summarization Model'}</Label>
          <div className="flex space-x-2 mt-1">
            <Select
              value={modelConfig.provider}
              onValueChange={(value) => {
                const provider = value as ModelConfig['provider'];

                // Clear error state when switching providers
                setError('');

                // Save current provider's model to localStorage before switching
                const map = JSON.parse(localStorage.getItem('providerModelMap') || '{}');
                if (modelConfig.model) {
                  map[modelConfig.provider] = modelConfig.model;
                  localStorage.setItem('providerModelMap', JSON.stringify(map));
                }

                // Try to restore cached model for the new provider
                const savedModel = map[provider];
                const providerModels = modelOptions[provider];
                const defaultModel = providerModels && providerModels.length > 0
                  ? providerModels[0]
                  : '';
                const model = (savedModel && providerModels?.includes(savedModel))
                  ? savedModel
                  : defaultModel;

                setModelConfig({
                  ...modelConfig,
                  provider,
                  model,
                });
                // API key is now synced automatically via useEffect watching providerApiKeys

                // Load OpenRouter models only when OpenRouter is selected
                if (provider === 'openrouter') {
                  loadOpenRouterModels();
                }

                // Load Built-in AI models when selected
                if (provider === 'builtin-ai') {
                  loadBuiltinAiModels();
                }

                // Load the saved CLI path when the Claude Code CLI is selected.
                // ClaudeCliSettings probes for the executable once it mounts.
                if (provider === 'claude-cli') {
                  loadClaudeCliModels();
                  getClaudeCliPath()
                    .then((saved) => setClaudeCliPath(saved || ''))
                    .catch((err) => {
                      console.error('Failed to load Claude Code CLI path:', err);
                    });
                }

                // A custom server needs a saved server; reuse the current one or the first saved
                if (provider === CUSTOM_PROVIDER) {
                  const server = selectedServer ?? customProviders?.[0];
                  if (server) selectServer(server);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent className="max-h-64 overflow-y-auto">
                <SelectItem value="builtin-ai">Built-in AI (Offline, No API needed)</SelectItem>
                <SelectItem value="claude">Claude (API key)</SelectItem>
                <SelectItem value="claude-cli">Claude Code CLI (Claude subscription)</SelectItem>
                <SelectItem value="custom-openai">Custom Server (OpenAI)</SelectItem>
                <SelectItem value="groq">Groq</SelectItem>
                <SelectItem value="ollama">Ollama</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="openrouter">OpenRouter</SelectItem>
              </SelectContent>
            </Select>

            {modelConfig.provider !== 'builtin-ai' && modelConfig.provider !== 'custom-openai' && (
              <Popover open={modelComboboxOpen} onOpenChange={setModelComboboxOpen} modal={true}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={modelComboboxOpen}
                    className="flex-1 max-w-[200px] justify-between font-normal"
                  >
                    <span className="truncate">
                      {modelConfig.model || "Select model..."}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[250px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search models..." />
                    <CommandList className="max-h-[300px]">
                      {(modelConfig.provider === 'openrouter' && isLoadingOpenRouter) ||
                       (modelConfig.provider === 'openai' && isLoadingOpenAI) ||
                       (modelConfig.provider === 'claude' && isLoadingClaude) ||
                       (modelConfig.provider === 'groq' && isLoadingGroq) ? (
                        <div className="py-6 text-center text-sm text-muted-foreground">
                          <RefreshCw className="mx-auto h-4 w-4 animate-spin mb-2" />
                          Loading models...
                        </div>
                      ) : (
                        <>
                          <CommandEmpty>No models found.</CommandEmpty>
                          <CommandGroup>
                            {modelOptions[modelConfig.provider]?.map((model) => (
                              <CommandItem
                                key={model}
                                value={model}
                                onSelect={(currentValue) => {
                                  setModelConfig((prev: ModelConfig) => ({ ...prev, model: currentValue }));
                                  setModelComboboxOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    modelConfig.model === model ? "opacity-100" : "opacity-0"
                                  )}
                                />
                                <span className="truncate">{model}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>

        {modelConfig.provider === CUSTOM_PROVIDER && (
          <div className="space-y-2 border-t border-af-border pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Server</Label>
                <div className="flex items-center gap-1.5">
                  <Select
                    value={selectedServer?.id ?? ''}
                    onValueChange={(value) => {
                      if (value === ADD_SERVER_VALUE) {
                        openServerDialog(null);
                        return;
                      }
                      const server = customProviders?.find((entry) => entry.id === value);
                      if (server) selectServer(server);
                    }}
                  >
                    <SelectTrigger aria-label="Custom server">
                      <SelectValue placeholder={customProviders?.length ? 'Choose a server' : 'No servers yet'} />
                    </SelectTrigger>
                    <SelectContent>
                      {customProviders?.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={ADD_SERVER_VALUE}>Add server…</SelectItem>
                    </SelectContent>
                  </Select>
                  {selectedServer && (
                    <IconButton
                      label={`Edit ${selectedServer.name}`}
                      icon={<Pencil className="size-4" />}
                      onClick={() => openServerDialog(selectedServer)}
                    />
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Model</Label>
                <Combobox
                  aria-label="Custom server model"
                  value={modelConfig.model || null}
                  onChange={(value) => value && setModelConfig((prev: ModelConfig) => ({ ...prev, model: value }))}
                  options={customModelOptions}
                  placeholder={selectedServer ? 'Choose a model' : 'Choose a server first'}
                  searchPlaceholder="Search or type a model…"
                  emptyText="No models"
                  onCreate={(query) => ({ value: query, label: query })}
                  createLabel={(query) => `Use “${query}”`}
                  disabled={!selectedServer}
                />
              </div>
            </div>
            {customProviders?.length === 0 && (
              <p className="text-[12px] text-af-text-3">Add a server to choose one of its models.</p>
            )}
            {modelConfig.customProviderId && customProviders && customProviders.length > 0 && !selectedServer && (
              <p className="text-[12px] text-af-danger">The saved server no longer exists. Choose another one.</p>
            )}
          </div>
        )}

        {requiresApiKey && isAssistant && !apiKey?.trim() && (
          <Alert className="border-af-warning/35 bg-af-warning/10">
            <AlertDescription className="text-af-text">
              No API key is saved for this provider yet. Add one by choosing it once as the summary model.
            </AlertDescription>
          </Alert>
        )}

        {requiresApiKey && !isAssistant && (
          <div>
            <Label>API Key</Label>
            <div className="relative mt-1">
              <Input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey || ''}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={isApiKeyLocked}
                placeholder="Enter your API key"
                className="pr-24"
              />
              {isApiKeyLocked && apiKey?.trim() && (
                <div
                  onClick={handleInputClick}
                  className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-md cursor-not-allowed"
                />
              )}
              <div className="absolute inset-y-0 right-0 pr-1 flex items-center space-x-1">
                {apiKey?.trim() && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setIsApiKeyLocked(!isApiKeyLocked)}
                    className={isLockButtonVibrating ? 'animate-vibrate text-af-danger' : ''}
                    title={isApiKeyLocked ? 'Unlock to edit' : 'Lock to prevent editing'}
                  >
                    {isApiKeyLocked ? <Lock /> : <Unlock />}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* The Anthropic API requires max_tokens, so Claude is the one provider
            where this value always has an effect. Everything else either has its
            own field (Custom Server) or uses its own default. */}
        {modelConfig.provider === 'claude' && !isAssistant && (
          <div>
            <Label htmlFor="summary-max-tokens">Maximum summary length (optional)</Label>
            <Input
              id="summary-max-tokens"
              type="number"
              min="1"
              max={claudeOutputBudget(modelConfig.model).maximum}
              step="1"
              value={summaryMaxTokens}
              onChange={(e) => setSummaryMaxTokens(e.target.value)}
              placeholder={String(claudeOutputBudget(modelConfig.model).defaultTokens)}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty for the app default of {claudeOutputBudget(modelConfig.model).defaultTokens.toLocaleString()} output tokens.
              You can choose up to {claudeOutputBudget(modelConfig.model).maximum.toLocaleString()} for this model.
              A higher limit allows longer summaries and may increase API usage. Incomplete responses are reported as errors.
            </p>
          </div>
        )}

        {/* The Ollama endpoint is shared with summaries, so it is edited there only */}
        {modelConfig.provider === 'ollama' && !isAssistant && (
          <div>
            <div
              className="flex items-center justify-between cursor-pointer py-2"
              onClick={() => setIsEndpointSectionCollapsed(!isEndpointSectionCollapsed)}
            >
              <Label className="cursor-pointer">Custom Endpoint (optional)</Label>
              {isEndpointSectionCollapsed ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              )}
            </div>

            {!isEndpointSectionCollapsed && (
              <>
                <p className="text-sm text-muted-foreground mt-1 mb-2">
                  Leave empty or enter a custom endpoint (e.g., http://x.yy.zz:11434)
                </p>
                <div className="flex gap-2 mt-1">
                  <div className="relative flex-1">
                    <Input
                      type="url"
                      value={ollamaEndpoint}
                      onChange={(e) => {
                        setOllamaEndpoint(e.target.value);
                        // Clear models and errors when endpoint changes to avoid showing stale data
                        if (e.target.value.trim() !== lastFetchedEndpoint.trim()) {
                          setModels([]);
                          setError(''); // Clear error state
                        }
                      }}
                      placeholder="http://localhost:11434"
                      className={cn(
                        "pr-10",
                        endpointValidationState === 'invalid' && "border-af-danger/35"
                      )}
                    />
                    {endpointValidationState === 'valid' && (
                      <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-af-success" />
                    )}
                    {endpointValidationState === 'invalid' && (
                      <XCircle className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-af-danger" />
                    )}
                  </div>
                  <Button
                    type="button"
                    size={'sm'}
                    onClick={() => fetchOllamaModels()}
                    disabled={isLoadingOllama}
                    variant="outline"
                    className="whitespace-nowrap"
                  >
                    {isLoadingOllama ? (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                        Fetching...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Fetch Models
                      </>
                    )}
                  </Button>
                </div>
                {ollamaEndpointChanged && !error && (
                  <Alert className="mt-3 border-af-warning/35 bg-af-warning/10">
                    <AlertDescription className="text-af-text">
                      Endpoint changed. Please click "Fetch Models" to load models from the new endpoint before saving.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </div>
        )}

        {modelConfig.provider === 'ollama' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-bold">Available Ollama Models</h4>
              {lastFetchedEndpoint && models.length > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Using:</span>
                  <code className="px-2 py-1 bg-muted rounded text-xs">
                    {lastFetchedEndpoint || 'http://localhost:11434'}
                  </code>
                </div>
              )}
            </div>
            {models.length > 0 && (
              <div className="mb-4">
                <Input
                  placeholder="Search models..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full"
                />
              </div>
            )}
            {isLoadingOllama ? (
              <div className="text-center py-8 text-muted-foreground">
                <RefreshCw className="mx-auto h-8 w-8 animate-spin mb-2" />
                Loading models...
              </div>
            ) : models.length === 0 ? (
              <div className="space-y-3">
                {ollamaNotInstalled ? (
                  /* Show Ollama download link when not installed */
                  <div className="space-y-4">
                    <Alert className="border-af-warning/35 bg-af-warning/10">
                      <AlertDescription className="text-af-text">
                        Ollama is not installed or not running. Please download and install Ollama to use local models.
                      </AlertDescription>
                    </Alert>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => invoke('open_external_url', { url: 'https://ollama.com/download' })}
                      className="w-full bg-af-accent hover:bg-af-accent-hover"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Download Ollama
                    </Button>
                    <div className="text-sm text-muted-foreground text-center">
                      After installing Ollama, restart this application and click "Fetch Models" to continue.
                    </div>
                  </div>
                ) : (
                  /* Show model download option when Ollama is installed but no models */
                  <>
                    <Alert className="mb-4">
                      <AlertDescription>
                        {ollamaEndpointChanged
                          ? 'Endpoint changed. Click "Fetch Models" to load models from the new endpoint.'
                          : 'No models found. Download a recommended model or click "Fetch Models" to load available Ollama models.'}
                      </AlertDescription>
                    </Alert>
                    {!ollamaEndpointChanged && (
                      <div className="space-y-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={downloadRecommendedModel}
                          disabled={isDownloading('gemma3:1b')}
                          className="w-full"
                        >
                          {isDownloading('gemma3:1b') ? (
                            <>
                              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                              Downloading gemma3:1b...
                            </>
                          ) : (
                            <>
                              <Download className="mr-2 h-4 w-4" />
                              Download gemma3:1b (Recommended, ~800MB)
                            </>
                          )}
                        </Button>

                        {/* Show progress for gemma3:1b download */}
                        {isDownloading('gemma3:1b') && getProgress('gemma3:1b') !== undefined && (
                          <div className="bg-af-panel rounded-md border p-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium text-af-accent">Downloading gemma3:1b</span>
                              <span className="text-sm font-semibold text-af-accent">
                                {Math.round(getProgress('gemma3:1b')!)}%
                              </span>
                            </div>
                            <div className="w-full h-2 bg-af-hover rounded-full overflow-hidden">
                              <div
                                className="h-full bg-af-panel-2 rounded-full transition-all duration-300"
                                style={{ width: `${getProgress('gemma3:1b')}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : !ollamaEndpointChanged && (
              <ScrollArea className="max-h-[calc(100vh-450px)] overflow-y-auto pr-4">
                {filteredModels.length === 0 ? (
                  <Alert>
                    <AlertDescription>
                      No models found matching "{searchQuery}". Try a different search term.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="grid gap-4">
                    {filteredModels.map((model) => {
                      const progress = getProgress(model.name);
                      const modelIsDownloading = isDownloading(model.name);

                      return (
                        <div
                          key={model.id}
                          className={cn(
                            'bg-card p-2 m-0 rounded-md border transition-colors',
                            modelConfig.model === model.name
                              ? 'ring-1 ring-af-accent/50 border-af-accent/40 background-blue-100'
                              : 'hover:bg-muted/50',
                            !modelIsDownloading && 'cursor-pointer'
                          )}
                          onClick={() => {
                            if (!modelIsDownloading) {
                              setModelConfig((prev: ModelConfig) => ({ ...prev, model: model.name }))
                            }
                          }}
                        >
                          <div>
                            <b className="font-bold">{model.name}&nbsp;</b>
                            <span className="text-muted-foreground">with a size of </span>
                            <span className="font-mono font-bold text-sm">{model.size}</span>
                          </div>

                          {/* Progress bar for downloading models */}
                          {modelIsDownloading && progress !== undefined && (
                            <div className="mt-3 pt-3 border-t border-af-border">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-medium text-af-accent">Downloading...</span>
                                <span className="text-sm font-semibold text-af-accent">{Math.round(progress)}%</span>
                              </div>
                              <div className="w-full h-2 bg-af-hover rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-af-panel-2 rounded-full transition-all duration-300"
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            )}
          </div>
        )}

        {/* Claude Code CLI Section */}
        {modelConfig.provider === 'claude-cli' && (
          <ClaudeCliSettings
            path={claudeCliPath}
            onPathChange={setClaudeCliPath}
            model={modelConfig.model || CLAUDE_CLI_DEFAULT_MODEL}
            onStatusChange={setClaudeCliStatus}
          />
        )}

        {/* Built-in AI Models Section */}
        {modelConfig.provider === 'builtin-ai' && (
          <div className="mt-6">
            <BuiltInModelManager
              selectedModel={modelConfig.model}
              layout={layout}
              onModelSelect={(model) =>
                setModelConfig((prev: ModelConfig) => ({ ...prev, model }))
              }
            />
          </div>
        )}
      </div>

      {/* Auto-generate summaries toggle */}
      {/* <div className="mt-6 pt-6 border-t border-af-border">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <Label htmlFor="auto-generate" className="text-base font-medium">
              Auto-generate summaries
            </Label>
            <p className="text-sm text-muted-foreground mt-1">
              Automatically generate summary when opening meetings without one
            </p>
          </div>
          <Switch
            id="auto-generate"
            checked={autoGenerateEnabled}
            onCheckedChange={setAutoGenerateEnabled}
          />
        </div>
      </div> */}

      <div className="mt-6 flex justify-end">
        <Button
          className={cn(
            'px-4 text-sm font-medium text-white rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-af-accent/50',
            isDoneDisabled ? 'bg-af-active cursor-not-allowed' : 'bg-af-accent hover:bg-af-accent-hover'
          )}
          onClick={handleSave}
          disabled={isDoneDisabled}
        >
          Save
        </Button>
      </div>

      <CustomServerDialog
        open={serverDialogOpen}
        onOpenChange={setServerDialogOpen}
        provider={serverDialogTarget}
        onSaved={(saved) => {
          // A newly added server becomes the choice; edits keep the current one
          if (!serverDialogTarget) selectServer(saved);
        }}
      />
    </div>
  );
}
