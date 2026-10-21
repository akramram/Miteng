'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { ModelSettingsModal } from '@/components/ModelSettingsModal';
import { useCustomProviders } from '@/hooks/useCustomProviders';
import {
  ASSISTANT_MODEL_CHANGED_EVENT,
  getAssistantModelConfig,
  customModelLabel,
  providerDisplayName,
  saveAssistantModelConfig,
  type AssistantModelConfig,
} from '@/lib/custom-providers';
import type { ModelConfig } from '@/services/configService';

interface AssistantModelSettingsProps {
  /** The summary model: what Ask AI follows by default, and the source of shared fields such as the Ollama endpoint. */
  summaryConfig: ModelConfig;
}

/** "Model for Ask AI": follow the summary model, or pick a separate provider and model. */
export function AssistantModelSettings({ summaryConfig }: AssistantModelSettingsProps) {
  const providers = useCustomProviders();
  const [saved, setSaved] = useState<AssistantModelConfig | null>(null);
  const [separate, setSeparate] = useState(false);
  const [draft, setDraft] = useState<ModelConfig>(summaryConfig);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getAssistantModelConfig()
        .then((config) => {
          if (cancelled) return;
          setSaved(config);
          setSeparate(config.provider !== null);
          if (config.provider) {
            const provider = config.provider;
            setDraft((prev) => ({
              ...prev,
              provider,
              model: config.model ?? '',
              customProviderId: config.customProviderId,
            }));
          }
        })
        .catch((error) => console.error('Failed to load the Ask AI model:', error));
    };
    load();
    window.addEventListener(ASSISTANT_MODEL_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(ASSISTANT_MODEL_CHANGED_EVENT, load);
    };
  }, []);

  const save = async (config: ModelConfig) => {
    try {
      await saveAssistantModelConfig({
        provider: config.provider,
        model: config.model,
        customProviderId: config.customProviderId ?? null,
      });
      toast.success('Ask AI model saved');
    } catch (error) {
      toast.error('Could not save the Ask AI model', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const toggleSeparate = async (checked: boolean) => {
    setSeparate(checked);
    if (checked) {
      // Start from the summary model so the editor opens on something that already works
      if (!saved?.provider) setDraft({ ...summaryConfig, apiKey: null });
      return;
    }
    if (!saved?.provider) return;
    try {
      await saveAssistantModelConfig({ provider: null, model: null, customProviderId: null });
      toast.success('Ask AI now uses the summary model');
    } catch (error) {
      setSeparate(true);
      toast.error('Could not save the Ask AI model', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const summaryServer = providers?.find((server) => server.id === summaryConfig.customProviderId);
  const summaryModel = summaryConfig.model ? customModelLabel(summaryServer, summaryConfig.model) : 'no model';
  const summaryLabel = `${providerDisplayName(summaryConfig, providers)} · ${summaryModel}`;

  return (
    <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-af-text">Model for Ask AI</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
            {separate
              ? 'Ask AI answers with the model below; summaries keep their own.'
              : `Same as summaries (${summaryLabel}). Turn on to answer questions with a different model.`}
          </p>
        </div>
        <Switch
          checked={separate}
          onCheckedChange={toggleSeparate}
          disabled={saved === null}
          aria-label="Use a separate model for Ask AI"
          className="shrink-0"
        />
      </div>

      {separate && (
        <div className="mt-5">
          <ModelSettingsModal
            scope="assistant"
            modelConfig={{ ...draft, ollamaEndpoint: summaryConfig.ollamaEndpoint ?? null }}
            setModelConfig={setDraft}
            onSave={save}
            skipInitialFetch
          />
        </div>
      )}
    </div>
  );
}
