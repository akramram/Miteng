'use client';

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  CUSTOM_PROVIDERS_CHANGED_EVENT,
  listCustomProviders,
  type CustomProvider,
} from '@/lib/custom-providers';

/**
 * The saved custom servers, kept current when any window saves or deletes one.
 * Null until loaded.
 */
export function useCustomProviders(): CustomProvider[] | null {
  const [providers, setProviders] = useState<CustomProvider[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listCustomProviders()
        .then((next) => !cancelled && setProviders(next))
        .catch((error) => {
          console.error('Failed to load custom servers:', error);
          if (!cancelled) setProviders([]);
        });
    };
    load();
    window.addEventListener(CUSTOM_PROVIDERS_CHANGED_EVENT, load);
    const unlisten = listen(CUSTOM_PROVIDERS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(CUSTOM_PROVIDERS_CHANGED_EVENT, load);
      void unlisten.then((stop) => stop());
    };
  }, []);

  return providers;
}
