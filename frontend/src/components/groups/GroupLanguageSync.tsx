'use client';

/**
 * Choosing a group for a recording (record card, live header, sidebar)
 * switches transcription to the group's language, if it has one.
 */
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useApplyTranscriptionLanguage } from '@/hooks/useApplyTranscriptionLanguage';
import { LANGUAGES } from '@/components/LanguageSelection';
import { PENDING_GROUP_EVENT, readPendingGroup } from '@/lib/groups';

export function GroupLanguageSync() {
  const { groupById } = useWorkspace();
  const { selectedLanguage } = useConfig();
  const { applyLanguage } = useApplyTranscriptionLanguage();
  // The listener lives for the whole app; it reads the current values from here.
  const latest = useRef({ groupById, selectedLanguage, applyLanguage });
  latest.current = { groupById, selectedLanguage, applyLanguage };

  useEffect(() => {
    // Only a new choice applies the language: a reload must not undo a manual pick.
    let chosen = readPendingGroup()?.id ?? null;
    const onChange = () => {
      const id = readPendingGroup()?.id ?? null;
      if (id === chosen) return;
      chosen = id;
      const { groupById, selectedLanguage, applyLanguage } = latest.current;
      const group = id ? groupById(id) : undefined;
      const language = group?.language;
      if (!group || !language || language === selectedLanguage) return;
      void applyLanguage(language).then((applied) => {
        if (!applied) return;
        const name = LANGUAGES.find((entry) => entry.code === language)?.name ?? language;
        toast.success(`Transcription language: ${name}`, { description: `Set by the group ${group.name}` });
      });
    };
    window.addEventListener(PENDING_GROUP_EVENT, onChange);
    return () => window.removeEventListener(PENDING_GROUP_EVENT, onChange);
  }, []);

  return null;
}
