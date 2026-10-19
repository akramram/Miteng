import { useState, useEffect, useRef } from 'react';
import { TranscriptSegmentData } from '@/types';

const INTERVAL_MS = 15; // Character reveal interval
const DURATION_MS = 800; // Time to reveal newly arrived text
const INITIAL_CHARS = 5; // Show first N characters of a new turn immediately

interface Revealed {
  id: string;
  /** Characters of the turn's current text shown so far. */
  visible: number;
}

/**
 * Typewriter effect for the newest live turn.
 *
 * The newest turn keeps its id while later lines from the same speaker merge
 * into it, so the reveal follows the turn's text length rather than its id:
 * merged text is revealed after what is already shown, never frozen.
 */
export function useTranscriptStreaming(
  segments: TranscriptSegmentData[],
  isRecording: boolean,
  enableStreaming: boolean
) {
  const [streaming, setStreaming] = useState<Revealed | null>(null);
  const revealed = useRef<Revealed | null>(null);

  const latest = segments[segments.length - 1];
  const latestId = isRecording && enableStreaming ? latest?.id : undefined;
  const latestLength = latest?.text.length ?? 0;

  useEffect(() => {
    if (latestId === undefined) {
      revealed.current = null;
      setStreaming(null);
      return;
    }
    if (revealed.current?.id !== latestId) {
      revealed.current = { id: latestId, visible: Math.min(INITIAL_CHARS, latestLength) };
      setStreaming(revealed.current);
    }
    const remaining = latestLength - revealed.current.visible;
    if (remaining <= 0) return;

    const step = Math.max(2, Math.ceil(remaining / (DURATION_MS / INTERVAL_MS)));
    const timer = setInterval(() => {
      const visible = Math.min(latestLength, (revealed.current?.visible ?? 0) + step);
      revealed.current = { id: latestId, visible };
      setStreaming(revealed.current);
      if (visible >= latestLength) clearInterval(timer);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [latestId, latestLength]);

  /**
   * Get the display text for a segment, with streaming effect if applicable
   */
  const getDisplayText = (segment: TranscriptSegmentData): string =>
    streaming && segment.id === streaming.id ? segment.text.slice(0, streaming.visible) : segment.text;

  return {
    streamingSegmentId: streaming && streaming.visible < latestLength ? streaming.id : null,
    getDisplayText,
  };
}
