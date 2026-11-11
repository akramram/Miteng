'use client';

import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import type { RawModelInfo } from '@/hooks/useTranscriptionModels';
import { canTranslate, pickTranslationModel } from '@/lib/whisper-models';

/**
 * Sets the transcription language, first switching the live model to an
 * installed Whisper model when the current one can't handle the choice.
 */
export function useApplyTranscriptionLanguage() {
  const { setSelectedLanguage, transcriptModelConfig, setTranscriptModelConfig } = useConfig();

  // Parakeet can't be pinned to a language (and lacks many, e.g. Indonesian); picking one switches live transcription to Whisper.
  const isParakeet = transcriptModelConfig.provider === 'parakeet';
  const liveModelCannotTranslate = isParakeet || !canTranslate(transcriptModelConfig.model);

  /** Returns false when no suitable Whisper model is installed. */
  const switchWhisperModel = useCallback(
    async (forTranslation: boolean): Promise<boolean> => {
      const models = await invoke<RawModelInfo[]>('whisper_get_available_models');
      // `.en` models are English-only.
      const installed = models.filter(m => m.status === 'Available' && !m.name.endsWith('.en'));
      const model = forTranslation ? pickTranslationModel(installed.map(m => m.name)) : installed[0]?.name;
      if (!model) return false;
      await invoke('api_save_transcript_config', { provider: 'localWhisper', model, apiKey: null });
      setTranscriptModelConfig(prev => ({ ...prev, provider: 'localWhisper', model, apiKey: null }));
      toast.info(forTranslation ? 'Switched to a Whisper model that can translate' : 'Switched to Whisper for multi-language support', {
        description: `Live model: ${model}`,
      });
      return true;
    },
    [setTranscriptModelConfig],
  );

  /** Returns false (after telling the user why) when the language was not applied. */
  const applyLanguage = useCallback(
    async (languageCode: string): Promise<boolean> => {
      if (languageCode === 'auto-translate' && liveModelCannotTranslate && !(await switchWhisperModel(true))) {
        toast.warning('Download a Whisper model that can translate', {
          description: 'Parakeet and Whisper Large v3 Turbo only transcribe in the original language. Install Whisper Medium or Small in Settings → Speech model, then pick this option again.'
        });
        return false;
      }
      if (isParakeet && languageCode !== 'auto' && languageCode !== 'auto-translate' && languageCode !== 'en'
        && !(await switchWhisperModel(false))) {
        toast.warning('Download a multilingual Whisper model', {
          description: 'Parakeet can\'t transcribe a chosen language. Install Whisper Base or Small in Settings → Speech model, then pick this language again.'
        });
        return false;
      }
      setSelectedLanguage(languageCode);
      return true;
    },
    [isParakeet, liveModelCannotTranslate, setSelectedLanguage, switchWhisperModel],
  );

  return { applyLanguage, switchWhisperModel, liveModelCannotTranslate };
}
