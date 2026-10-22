'use client';

import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { cn } from '@/lib/utils';

/**
 * Locks settings that change how a running recording is captured or
 * transcribed. A disabled fieldset turns off every native control inside it;
 * pointer-events covers clickable cards that are not form controls.
 */
export function RecordingLock({ children }: { children: ReactNode }) {
  const { isRecording } = useRecordingState();
  return (
    <>
      {isRecording && (
        <p className="flex items-center gap-2 rounded-xl border border-af-border bg-af-panel-2 px-3.5 py-2.5 text-[13px] text-af-text-2">
          <Lock className="h-3.5 w-3.5 shrink-0 text-af-text-3" />
          These settings are locked while recording. Stop the recording to change them.
        </p>
      )}
      <fieldset
        disabled={isRecording}
        aria-disabled={isRecording}
        className={cn('min-w-0 space-y-5', isRecording && 'pointer-events-none select-none opacity-60')}
      >
        {children}
      </fieldset>
    </>
  );
}
