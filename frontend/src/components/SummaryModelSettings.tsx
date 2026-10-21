'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ModelConfig, ModelSettingsModal } from '@/components/ModelSettingsModal';
import { SummaryLanguageSettings } from '@/components/SummaryLanguageSettings';
import { CustomServers } from '@/components/settings/CustomServers';
import { AssistantModelSettings } from '@/components/settings/AssistantModelSettings';
import { Switch } from './ui/switch';
import { useConfig } from '@/contexts/ConfigContext';
import { configService } from '@/services/configService';

interface SummaryModelSettingsProps {
  refetchTrigger?: number; // Change this to trigger refetch
}

export function SummaryModelSettings({ refetchTrigger }: SummaryModelSettingsProps) {
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'ollama',
    model: 'llama3.2:latest',
    whisperModel: 'large-v3',
    apiKey: null,
    ollamaEndpoint: null
  });

  const { isAutoSummary, toggleIsAutoSummary } = useConfig();

  // Reusable fetch function
  const fetchModelConfig = useCallback(async () => {
    try {
      const data = await configService.getModelConfig();
      if (data && data.provider !== null) {
        // Fetch API key if not included and provider requires it
        if (data.provider !== 'ollama' && data.provider !== 'builtin-ai' && data.provider !== 'claude-cli' && data.provider !== 'custom-openai' && !data.apiKey) {
          try {
            const apiKeyData = await invoke('api_get_api_key', {
              provider: data.provider
            }) as string;
            data.apiKey = apiKeyData;
          } catch (err) {
            console.error('Failed to fetch API key:', err);
          }
        }
        setModelConfig(data);
      }
    } catch (error) {
      console.error('Failed to fetch model config:', error);
      toast.error('Failed to load model settings');
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchModelConfig();
  }, [fetchModelConfig]);

  // Refetch when trigger changes (optional external control)
  useEffect(() => {
    if (refetchTrigger !== undefined && refetchTrigger > 0) {
      fetchModelConfig();
    }
  }, [refetchTrigger, fetchModelConfig]);

  // Listen for model config updates from other components
  useEffect(() => {
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<ModelConfig>('model-config-updated', (event) => {
        console.log('SummaryModelSettings received model-config-updated event:', event.payload);
        setModelConfig(event.payload);
      });

      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then(fn => cleanup = fn);

    return () => {
      cleanup?.();
    };
  }, []);

  // Save handler
  const handleSaveModelConfig = async (config: ModelConfig) => {
    try {
      await configService.saveModelConfig(config);

      setModelConfig(config);

      // Emit event to sync other components
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success('Model settings saved successfully');
    } catch (error) {
      console.error('Error saving model config:', error);
      toast.error('Failed to save model settings', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className='flex flex-col gap-4'>
      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-semibold text-af-text">Summarize automatically</h3>
            <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">Write a summary as soon as a recording is saved. When off, generate one from the meeting page whenever you like.</p>
          </div>
          <Switch checked={isAutoSummary} onCheckedChange={toggleIsAutoSummary} className="shrink-0" />
        </div>
      </div>

      <SummaryLanguageSettings />

      <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
        <h3 className="text-[15px] font-semibold text-af-text">Summary model</h3>
        <p className="mb-5 mt-0.5 text-[13px] leading-relaxed text-af-text-3">
          Writes summaries, and answers Ask AI unless you pick another model for it below. Local models keep everything on this computer; a cloud provider receives the parts of a meeting it needs.
        </p>

        <ModelSettingsModal
          modelConfig={modelConfig}
          setModelConfig={setModelConfig}
          onSave={handleSaveModelConfig}
          skipInitialFetch={true}
        />
      </div>

      <AssistantModelSettings summaryConfig={modelConfig} />

      <CustomServers />
    </div>
  );
}
