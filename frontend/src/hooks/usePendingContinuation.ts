'use client';

import { useEffect, useState } from 'react';
import { PENDING_CONTINUATION_EVENT, readPendingContinuation, writePendingContinuation } from '@/lib/meeting-series';

/** The meeting the next recording continues, shared by the record card and the live header. */
export function usePendingContinuation() {
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setPending(readPendingContinuation());
    sync();
    window.addEventListener(PENDING_CONTINUATION_EVENT, sync);
    return () => window.removeEventListener(PENDING_CONTINUATION_EVENT, sync);
  }, []);

  return [pending, writePendingContinuation] as const;
}
