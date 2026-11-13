'use client';

/**
 * "Mark topic" in the live header: notes the recording time when the talk
 * moves to another subject, with an optional name. After the call the meeting
 * page offers these as topics to review (lib/topic-markers).
 */
import { useEffect, useRef, useState } from 'react';
import { Milestone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatClock } from '@/lib/dates';
import { TOPIC_MARKERS_EVENT, readLiveMarkers, writeLiveMarkers, type TopicMarker } from '@/lib/topic-markers';

export function TopicMarkerButton({ session, elapsed, disabled }: { session: string; elapsed: number; disabled: boolean }) {
  const [markers, setMarkers] = useState<TopicMarker[]>([]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  // The time is taken when the popover opens, not when the name is typed.
  const markedAt = useRef(0);

  useEffect(() => {
    const sync = () => setMarkers(readLiveMarkers(session));
    sync();
    window.addEventListener(TOPIC_MARKERS_EVENT, sync);
    return () => window.removeEventListener(TOPIC_MARKERS_EVENT, sync);
  }, [session]);

  const add = () => {
    const next = [...markers, { seconds: markedAt.current, title: title.trim() }].sort((a, b) => a.seconds - b.seconds);
    writeLiveMarkers(session, next);
    setTitle('');
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) markedAt.current = elapsed;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled} aria-label="Mark a topic change">
          <Milestone />
          {markers.length > 0 ? `${markers.length} topic${markers.length === 1 ? '' : 's'} marked` : 'Mark topic'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3.5">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <label htmlFor="topic-marker-title" className="block text-xs font-medium text-af-text-2">
            New topic from <span className="tabular-nums">{formatClock(markedAt.current)}</span>
          </label>
          <Input
            id="topic-marker-title"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Name (optional)"
            maxLength={120}
          />
          <Button type="submit" size="sm" className="w-full">
            Mark at {formatClock(markedAt.current)}
          </Button>
        </form>
        {markers.length > 0 && (
          <ul aria-label="Marked topics" className="space-y-1 border-t border-af-border pt-2">
            {markers.map((marker, index) => (
              <li key={`${marker.seconds}-${index}`} className="flex items-center gap-2 text-xs text-af-text-2">
                <span className="tabular-nums text-af-text-3">{formatClock(marker.seconds)}</span>
                <span className="min-w-0 flex-1 truncate">{marker.title || 'Unnamed topic'}</span>
                <button
                  type="button"
                  onClick={() => writeLiveMarkers(session, markers.filter((_, other) => other !== index))}
                  aria-label={`Remove the marker at ${formatClock(marker.seconds)}`}
                  className="rounded p-0.5 text-af-text-4 transition-colors hover:bg-af-hover hover:text-af-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-af-text-3">After the call you review these and each topic gets its own summary.</p>
      </PopoverContent>
    </Popover>
  );
}
