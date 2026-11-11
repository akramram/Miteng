'use client';

/**
 * Cut the end off a recording that kept running after the meeting: pick where
 * it really ended (slider or typed time), check the last line that stays, and
 * trim. The untrimmed recording is kept so the trim can be undone, until the
 * user deletes it here.
 */
import { useEffect, useState } from 'react';
import { Headphones, RotateCcw, Scissors, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatClock, parseClock } from '@/lib/dates';
import {
  deleteMeetingOriginal,
  previewMeetingTrim,
  restoreMeetingOriginal,
  trimMeeting,
  type TrimPreview,
  type TrimState,
} from '@/lib/workspace-api';

/** The backend refuses cuts this close to either end. */
const EDGE_SECONDS = 1;
const PREVIEW_DEBOUNCE_MS = 300;
/** "Listen" starts this long before the cut. */
const LISTEN_LEAD_SECONDS = 8;

export type TrimChange = 'trimmed' | 'restored' | 'deleted';

export function TrimRecordingDialog({
  open,
  onOpenChange,
  meetingId,
  state,
  onChanged,
  onListen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  state: TrimState;
  onChanged: (next: TrimState, change: TrimChange) => void;
  /** Plays the recording from a position, to hear where the meeting ended. */
  onListen?: (seconds: number) => void;
}) {
  const max = Math.max(EDGE_SECONDS, Math.floor(state.durationSeconds - EDGE_SECONDS));
  const [end, setEnd] = useState(max);
  const [draft, setDraft] = useState(formatClock(max));
  const [draftError, setDraftError] = useState(false);
  const [deleteNow, setDeleteNow] = useState(false);
  const [preview, setPreview] = useState<TrimPreview | null>(null);
  const [working, setWorking] = useState<'trim' | 'restore' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canTrim = state.durationSeconds > EDGE_SECONDS * 2 + 1;

  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      previewMeetingTrim(meetingId, end)
        .then((result) => !stale && setPreview(result))
        .catch(() => !stale && setPreview(null));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [meetingId, end]);

  const moveTo = (seconds: number) => {
    const next = Math.min(max, Math.max(EDGE_SECONDS, Math.round(seconds)));
    setEnd(next);
    setDraft(formatClock(next));
    setDraftError(false);
  };

  const commitDraft = () => {
    const seconds = parseClock(draft);
    if (seconds === null || seconds < EDGE_SECONDS || seconds > max) {
      setDraftError(true);
      return;
    }
    moveTo(seconds);
  };

  const trim = async () => {
    setWorking('trim');
    try {
      const next = await trimMeeting(meetingId, end, deleteNow);
      onChanged(next, 'trimmed');
      toast.success(`Recording trimmed to ${formatClock(end)}`, {
        description: deleteNow ? 'The original was deleted.' : 'The original is kept until you delete it.',
      });
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not trim the recording', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(null);
    }
  };

  const restore = async () => {
    setWorking('restore');
    try {
      const next = await restoreMeetingOriginal(meetingId);
      onChanged(next, 'restored');
      toast.success('Original recording restored');
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not restore the original', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(null);
    }
  };

  const removeOriginal = async () => {
    try {
      const next = await deleteMeetingOriginal(meetingId);
      onChanged(next, 'deleted');
      toast.success('Original recording deleted');
    } catch (error) {
      toast.error('Could not delete the original', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const removed = state.durationSeconds - end;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !working && onOpenChange(next)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scissors className="h-4 w-4 text-af-accent" />
              Trim recording
            </DialogTitle>
            <DialogDescription>
              Kept recording after the meeting ended? Choose where it ended. Everything after that point is removed from the
              audio and the transcript.
            </DialogDescription>
          </DialogHeader>

          {state.original && (
            <div className="space-y-2 rounded-xl border border-af-border bg-af-panel-2 p-3.5">
              <p className="text-xs text-af-text-2">
                Trimmed from <span className="tabular-nums font-medium text-af-text">{formatClock(state.original.durationSeconds)}</span>{' '}
                on {new Date(state.original.trimmedAt).toLocaleString()}. The original recording is kept, so you can undo the trim.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => void restore()} loading={working === 'restore'} disabled={working !== null}>
                  <RotateCcw />
                  Restore original
                </Button>
                <Button size="sm" variant="danger-ghost" onClick={() => setConfirmDelete(true)} disabled={working !== null}>
                  <Trash2 />
                  Delete original
                </Button>
              </div>
            </div>
          )}

          {canTrim ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] tabular-nums text-af-text-3">
                  <span>0:00</span>
                  <span>{formatClock(state.durationSeconds)}</span>
                </div>
                <input
                  type="range"
                  min={EDGE_SECONDS}
                  max={max}
                  step={1}
                  value={end}
                  onChange={(event) => moveTo(Number(event.target.value))}
                  aria-label="Where the meeting ended"
                  aria-valuetext={formatClock(end)}
                  className="w-full accent-[rgb(var(--af-accent-rgb))]"
                />
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <label htmlFor="trim-end" className="block text-xs font-medium text-af-text-2">
                    Meeting ended at
                  </label>
                  <Input
                    id="trim-end"
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setDraftError(false);
                    }}
                    onBlur={commitDraft}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitDraft();
                      }
                    }}
                    aria-invalid={draftError}
                    aria-describedby="trim-end-hint"
                    className="w-32 tabular-nums"
                  />
                </div>
                {onListen && (
                  <Button variant="ghost" size="sm" onClick={() => onListen(Math.max(0, end - LISTEN_LEAD_SECONDS))}>
                    <Headphones />
                    Listen to the cut
                  </Button>
                )}
              </div>
              <p id="trim-end-hint" className={draftError ? 'text-xs text-af-danger' : 'text-[11px] text-af-text-3'}>
                {draftError
                  ? `Enter a time between ${formatClock(EDGE_SECONDS)} and ${formatClock(max)}, like 1:05:00 or 65 (minutes).`
                  : 'Type h:mm:ss, m:ss, or minutes.'}
              </p>

              <div className="rounded-xl border border-af-border p-3.5 text-xs" aria-live="polite">
                <p className="text-af-text-3">Last line kept</p>
                {preview?.lastKept ? (
                  <p className="mt-1 line-clamp-3 text-af-text">
                    <span className="tabular-nums text-af-text-3">{formatClock(preview.lastKept.startSeconds)}</span>{' '}
                    {preview.lastKept.speaker && <span className="font-medium">{preview.lastKept.speaker}: </span>}
                    {preview.lastKept.text}
                  </p>
                ) : (
                  <p className="mt-1 text-af-text-3">No transcript before this point.</p>
                )}
                <p className="mt-2 text-af-text-2">
                  Removes <span className="tabular-nums font-medium">{formatClock(removed)}</span> of audio
                  {preview ? (
                    <>
                      {' '}and <span className="tabular-nums font-medium">{preview.removedLines}</span> transcript line
                      {preview.removedLines === 1 ? '' : 's'}
                    </>
                  ) : null}
                  .
                </p>
              </div>

              <label className="flex items-start gap-2.5 text-xs text-af-text-2">
                <Checkbox checked={deleteNow} onCheckedChange={(checked) => setDeleteNow(checked === true)} className="mt-px" />
                <span>
                  Delete the original right away
                  <span className="block text-[11px] text-af-text-3">
                    {state.original ? 'Frees the space now. You can no longer restore it.' : 'Otherwise it stays in the recording folder until you delete it here.'}
                  </span>
                </span>
              </label>
            </div>
          ) : (
            <p className="text-sm text-af-text-3">This recording is too short to trim.</p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={working !== null}>
              Cancel
            </Button>
            {canTrim && (
              <Button variant="danger" onClick={() => void trim()} loading={working === 'trim'} disabled={working !== null || draftError}>
                <Scissors />
                Trim to {formatClock(end)}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="danger"
        title="Delete the original recording?"
        description="The untrimmed audio and the removed transcript lines are deleted. The trim can no longer be undone."
        confirmLabel="Delete original"
        onConfirm={removeOriginal}
      />
    </>
  );
}
