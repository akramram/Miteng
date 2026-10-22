'use client';

/**
 * Compact model picker for Ask AI. It changes the saved Ask AI model (the same
 * setting as Settings → Summaries → Model for Ask AI), so the choice sticks
 * across meetings and the live assistant.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ChevronDown, Sparkles } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useCustomProviders } from '@/hooks/useCustomProviders';
import {
  ASSISTANT_MODEL_CHANGED_EVENT,
  CUSTOM_PROVIDER,
  customModelLabel,
  getAssistantModelConfig,
  providerDisplayName,
  saveAssistantModelConfig,
  type AssistantModelConfig,
} from '@/lib/custom-providers';
import type { ModelConfig } from '@/services/configService';

const FOLLOW_SUMMARY = '__summary__';
const SEPARATOR = '\u0000';

export function AskModelSwitcher({ summaryConfig }: { summaryConfig: ModelConfig | null | undefined }) {
  const providers = useCustomProviders();
  const [assistant, setAssistant] = useState<AssistantModelConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getAssistantModelConfig()
        .then((config) => !cancelled && setAssistant(config))
        .catch((error) => console.error('Failed to load the Ask AI model:', error));
    };
    load();
    window.addEventListener(ASSISTANT_MODEL_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(ASSISTANT_MODEL_CHANGED_EVENT, load);
    };
  }, []);

  const describe = (config: { provider: string; model: string; customProviderId?: string | null }) => {
    const server = providers?.find((entry) => entry.id === config.customProviderId);
    const model = config.provider === CUSTOM_PROVIDER ? customModelLabel(server, config.model) : config.model;
    return { model, provider: providerDisplayName(config, providers) };
  };

  const summary = summaryConfig?.provider && summaryConfig.model ? describe(summaryConfig) : null;
  const current = assistant?.provider && assistant.model
    ? { provider: assistant.provider, model: assistant.model, customProviderId: assistant.customProviderId }
    : null;
  const value = current ? [current.provider, current.customProviderId ?? '', current.model].join(SEPARATOR) : FOLLOW_SUMMARY;
  const options: ComboboxOption[] = [
    {
      value: FOLLOW_SUMMARY,
      label: 'Same as summaries',
      description: summary ? `${summary.provider} · ${summary.model}` : undefined,
    },
  ];
  for (const server of providers ?? []) {
    for (const model of server.models) {
      options.push({
        value: [CUSTOM_PROVIDER, server.id, model.id].join(SEPARATOR),
        label: model.name || model.id,
        description: server.name,
        keywords: [model.id, server.name],
      });
    }
  }
  // A built-in provider chosen in Settings stays selectable here.
  if (current && !options.some((option) => option.value === value)) {
    const shown = describe(current);
    options.push({ value, label: shown.model, description: shown.provider });
  }

  const choose = async (next: string | null) => {
    if (!next || next === value) return;
    const [provider, customProviderId, model] = next === FOLLOW_SUMMARY ? [] : next.split(SEPARATOR);
    try {
      await saveAssistantModelConfig({
        provider: (provider as AssistantModelConfig['provider']) ?? null,
        model: model ?? null,
        customProviderId: customProviderId || null,
      });
    } catch (error) {
      toast.error('Could not switch the Ask AI model', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const label = current ? describe(current).model : summary ? summary.model : 'Model';

  return (
    <Combobox
      value={value}
      onChange={choose}
      options={options}
      searchPlaceholder="Search models…"
      emptyText="No models. Add a custom server in Settings."
      align="end"
      aria-label="Ask AI model"
      footer={
        <Link href="/settings" className="block px-2 py-1.5 text-[12px] text-af-text-3 hover:text-af-text">
          More providers in Settings → Summaries
        </Link>
      }
      trigger={
        <button
          type="button"
          title={current ? 'Ask AI model' : 'Ask AI follows the summary model'}
          className="inline-flex h-7 max-w-[14rem] items-center gap-1.5 rounded-md px-2 text-xs font-medium text-af-text-2 transition-colors hover:bg-af-hover hover:text-af-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-af-text-3" />
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      }
    />
  );
}
