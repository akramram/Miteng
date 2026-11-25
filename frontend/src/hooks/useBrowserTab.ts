'use client';

/** Whether a browser tab is sending its audio to Miteng through the extension. */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface BrowserTabStatus {
  /** Miteng is listening for the extension. */
  listening: boolean;
  connected: boolean;
  title: string | null;
  url: string | null;
}

export function useBrowserTab(): BrowserTabStatus | null {
  const [status, setStatus] = useState<BrowserTabStatus | null>(null);

  useEffect(() => {
    let active = true;
    const unlisten = listen<BrowserTabStatus>('browser-tab-status', (event) => setStatus(event.payload));
    invoke<BrowserTabStatus>('get_browser_tab_status')
      .then((current) => active && setStatus(current))
      .catch((error) => console.error('Could not read the browser tab status:', error));
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  return status;
}
