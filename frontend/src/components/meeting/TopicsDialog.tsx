'use client';

/**
 * Split one meeting into topics: named time ranges that are summarized one by
 * one. Time outside every range is skipped. Opened from the meeting menu, or
 * on its own after a recording with topic changes marked during the call.
 */
import { useMemo, useState } from 'react';
import { Crosshair, Milestone, Plus, Scissors, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatClock, parseClock } from '@/lib/dates';
import { saveMeetingChapters, type Chapter, type ChapterDraft } from '@/lib/workspace-api';

/** Matches the backend's shortest topic. */
const MIN_TOPIC_SECONDS = 5;

interface Row {
  key: number;
  id?: string;
  title: string;
  start: string;
  end: string;
}

let nextKey = 0;
const toRow = (chapter: ChapterDraft): Row => ({
  key: nextKey++,
  id: chapter.id,
  title: chapter.title,
  start: formatClock(chapter.startSeconds),
  end: formatClock(chapter.endSeconds),
});

/** The rows as topics, or the first problem with them. */
function readRows(rows: Row[], durationSeconds: number): { chapters: ChapterDraft[]; error: string | null } {
  const chapters: ChapterDraft[] = [];
  for (const [index, row] of rows.entries()) {
    const name = row.title.trim() || `Topic ${index + 1}`;
    const start = parseClock(row.start);
    const end = parseClock(row.end);
    if (!row.title.trim()) return { chapters, error: `Topic ${index + 1} needs a name.` };
    if (start === null || end === null) return { chapters, error: `"${name}": type times as h:mm:ss or m:ss.` };
    if (end > durationSeconds + 1) return { chapters, error: `"${name}" ends after the recording (${formatClock(durationSeconds)}).` };
    if (end - start < MIN_TOPIC_SECONDS) return { chapters, error: `"${name}" must end at least ${MIN_TOPIC_SECONDS} seconds after it starts.` };
    chapters.push({ id: row.id, title: row.title.trim(), startSeconds: start, endSeconds: Math.min(end, durationSeconds) });
  }
  const sorted = [...chapters].sort((a, b) => a.startSeconds - b.startSeconds);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].startSeconds < sorted[index - 1].endSeconds) {
      return { chapters, error: `"${sorted[index - 1].title}" and "${sorted[index].title}" overlap.` };
    }
  }
  return { chapters: sorted, error: null };
}

export function TopicsDialog({
  open,
  onOpenChange,
  meetingId,
  durationSeconds,
  chapters,
  draft,
  playhead,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  durationSeconds: number;
  chapters: Chapter[];
  /** Topics proposed from markers placed during the call, shown instead of the saved ones. */
  draft?: ChapterDraft[] | null;
  /** Current playback position, when the recording is loaded. */
  playhead: number | null;
  onSaved: (chapters: Chapter[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => (draft ?? chapters).map(toRow));
  const [saving, setSaving] = useState(false);
  const { chapters: parsed, error } = useMemo(() => readRows(rows, durationSeconds), [rows, durationSeconds]);

  const update = (key: number, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const lastEnd = parsed.reduce((max, chapter) => Math.max(max, chapter.endSeconds), 0);
  const canAdd = durationSeconds - lastEnd >= MIN_TOPIC_SECONDS;
  const addTopic = () =>
    setRows((current) => [
      ...current,
      toRow({ title: `Topic ${current.length + 1}`, startSeconds: lastEnd, endSeconds: durationSeconds }),
    ]);

  // Split the topic playing now at the playback position, or the whole recording when there are none.
  const splitAt = playhead !== null && playhead > MIN_TOPIC_SECONDS && playhead < durationSeconds - MIN_TOPIC_SECONDS ? Math.floor(playhead) : null;
  const splitTarget =
    splitAt === null
      ? null
      : rows.length === 0
        ? 'all'
        : rows.find((row) => {
            const start = parseClock(row.start);
            const end = parseClock(row.end);
            return start !== null && end !== null && splitAt - start >= MIN_TOPIC_SECONDS && end - splitAt >= MIN_TOPIC_SECONDS;
          }) ?? null;
  const split = () => {
    if (splitAt === null || !splitTarget) return;
    if (splitTarget === 'all') {
      setRows([
        toRow({ title: 'Topic 1', startSeconds: 0, endSeconds: splitAt }),
        toRow({ title: 'Topic 2', startSeconds: splitAt, endSeconds: durationSeconds }),
      ]);
      return;
    }
    setRows((current) =>
      current.flatMap((row) =>
        row.key === splitTarget.key
          ? [
              { ...row, end: formatClock(splitAt) },
              { key: nextKey++, title: `Topic ${current.length + 1}`, start: formatClock(splitAt), end: row.end },
            ]
          : [row],
      ),
    );
  };

  const save = async (next: ChapterDraft[]) => {
    setSaving(true);
    try {
      const saved = await saveMeetingChapters(meetingId, next);
      onSaved(saved);
      onOpenChange(false);
    } catch (failure) {
      toast.error('Could not save the topics', { description: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setSaving(false);
    }
  };

  const skipped = durationSeconds - parsed.reduce((sum, chapter) => sum + (chapter.endSeconds - chapter.startSeconds), 0);

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Milestone className="h-4 w-4 text-af-accent" />
            Topics
          </DialogTitle>
          <DialogDescription>
            {draft
              ? 'You marked topic changes during the call. Check the ranges and names; each topic gets its own summary.'
              : 'Split this meeting into topics. Each gets its own summary; time outside every topic is skipped.'}
          </DialogDescription>
        </DialogHeader>

        <div aria-hidden className="relative h-3 overflow-hidden rounded-full bg-af-panel-2 ring-1 ring-inset ring-af-border">
          {durationSeconds > 0 &&
            parsed.map((chapter, index) => (
              <span
                key={`${chapter.startSeconds}-${index}`}
                className={cn('absolute inset-y-0 border-x border-af-panel', index % 2 ? 'bg-af-accent/60' : 'bg-af-accent')}
                style={{
                  left: `${(chapter.startSeconds / durationSeconds) * 100}%`,
                  width: `${((chapter.endSeconds - chapter.startSeconds) / durationSeconds) * 100}%`,
                }}
              />
            ))}
          {playhead !== null && durationSeconds > 0 && (
            <span className="absolute inset-y-0 w-0.5 bg-af-text" style={{ left: `${(playhead / durationSeconds) * 100}%` }} />
          )}
        </div>
        <div className="-mt-2 flex justify-between text-[11px] tabular-nums text-af-text-3">
          <span>0:00</span>
          <span>{skipped >= 1 && parsed.length > 0 ? `${formatClock(skipped)} skipped` : ''}</span>
          <span>{formatClock(durationSeconds)}</span>
        </div>

        {rows.length > 0 ? (
          <ol className="max-h-[45vh] space-y-2 overflow-y-auto pr-1">
            {rows.map((row, index) => (
              <li key={row.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-af-border p-2.5">
                <span className="w-5 text-center text-xs tabular-nums text-af-text-3">{index + 1}</span>
                <Input
                  value={row.title}
                  onChange={(event) => update(row.key, { title: event.target.value })}
                  aria-label={`Topic ${index + 1} name`}
                  placeholder="Topic name"
                  maxLength={120}
                  className="h-8 min-w-[10rem] flex-1 text-sm"
                />
                {(['start', 'end'] as const).map((field) => (
                  <span key={field} className="flex items-center gap-0.5">
                    {field === 'end' && <span className="px-0.5 text-af-text-4">–</span>}
                    <Input
                      value={row[field]}
                      onChange={(event) => update(row.key, { [field]: event.target.value })}
                      aria-label={`Topic ${index + 1} ${field}`}
                      className="h-8 w-[5.5rem] text-sm tabular-nums"
                    />
                    {playhead !== null && (
                      <button
                        type="button"
                        onClick={() => update(row.key, { [field]: formatClock(playhead) })}
                        aria-label={`Set topic ${index + 1} ${field} to the playback position`}
                        title="Use the playback position"
                        className="rounded p-1 text-af-text-4 transition-colors hover:bg-af-hover hover:text-af-accent"
                      >
                        <Crosshair className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}
                  aria-label={`Remove topic ${index + 1}`}
                  className="rounded p-1 text-af-text-4 transition-colors hover:bg-af-hover hover:text-af-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-xl border border-dashed border-af-border p-4 text-center text-sm text-af-text-3">
            No topics. The meeting is summarized as a whole.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={addTopic} disabled={!canAdd}>
            <Plus />
            Add topic
          </Button>
          {splitAt !== null && (
            <Button variant="ghost" size="sm" onClick={split} disabled={!splitTarget}>
              <Scissors />
              Split at {formatClock(splitAt)}
            </Button>
          )}
        </div>
        {error && rows.length > 0 && (
          <p role="alert" className="text-xs text-af-danger">
            {error}
          </p>
        )}
        <p className="text-[11px] text-af-text-3">
          Times are h:mm:ss or m:ss. Play the recording and use <Crosshair className="inline h-3 w-3" /> to take its position. Saving
          writes the summary again, one section per topic.
        </p>

        <DialogFooter className="sm:justify-between">
          {chapters.length > 0 ? (
            <Button variant="danger-ghost" onClick={() => void save([])} disabled={saving}>
              Remove all topics
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              {draft ? 'Summarize as a whole' : 'Cancel'}
            </Button>
            <Button onClick={() => void save(parsed)} loading={saving} disabled={!!error || rows.length === 0}>
              Save topics
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
