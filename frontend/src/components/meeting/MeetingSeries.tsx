'use client';

/**
 * Meeting series UI: pick which earlier meeting a meeting continues, and step
 * between the parts of a series (Part 1 → 2 → 3).
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ChevronDown, ChevronLeft, ChevronRight, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { displayTitle } from '@/lib/meeting-titles';
import { formatShortDate, parseDate } from '@/lib/dates';
import { announceChange } from '@/lib/workspace-api';
import { continuationCandidates, seriesOf, setPreviousMeeting } from '@/lib/meeting-series';

const triggerClass = {
  /** Header chip, beside the group chip. */
  chip: 'inline-flex h-6 max-w-[16rem] items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
  /** Small text line under "Start recording". */
  line: 'mt-0.5 flex max-w-[10rem] items-center gap-1.5 rounded-md text-[11px] font-medium text-af-text-3 transition-colors hover:text-af-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
};

/**
 * Picks the earlier meeting `meetingId` continues. `meetingId` null means the
 * next recording, which can continue any meeting not already continued.
 */
export function ContinuationPicker({
  meetingId,
  value,
  onChange,
  variant = 'chip',
  side = 'bottom',
}: {
  meetingId: string | null;
  value: string | null;
  onChange: (previousMeetingId: string | null) => void;
  variant?: keyof typeof triggerClass;
  side?: 'top' | 'bottom';
}) {
  const { meetings } = useSidebar();
  const { groupById } = useWorkspace();
  const options = useMemo<ComboboxOption[]>(
    () =>
      continuationCandidates(meetings, meetingId).map((meeting) => {
        const date = parseDate(meeting.created_at);
        return {
          value: meeting.id,
          label: displayTitle(meeting.title, meeting.created_at),
          description: date ? formatShortDate(date) : undefined,
          color: groupById(meeting.group_id)?.color,
        };
      }),
    [groupById, meetingId, meetings],
  );
  const previous = value ? meetings.find((meeting) => meeting.id === value) : undefined;
  return (
    <Combobox
      value={previous?.id ?? null}
      onChange={onChange}
      options={options}
      clearLabel="Not a continuation"
      searchPlaceholder="Find the earlier meeting"
      emptyText="No meetings to continue"
      side={side}
      align="start"
      aria-label="Continues meeting"
      trigger={
        <button
          type="button"
          className={cn(
            triggerClass[variant],
            variant === 'chip' &&
              (previous
                ? 'bg-af-panel-2 text-af-text-2 hover:bg-af-hover'
                : 'border border-dashed border-af-border-strong text-af-text-3 hover:border-af-text-4 hover:text-af-text-2'),
          )}
        >
          <Link2 className={variant === 'chip' ? 'h-3.5 w-3.5 shrink-0' : 'h-3 w-3 shrink-0'} />
          <span className="truncate">{previous ? `Continues ${displayTitle(previous.title, previous.created_at)}` : 'Continue a meeting'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      }
    />
  );
}

const stepClass = 'flex h-6 w-6 items-center justify-center rounded-md text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text';

/** "Part 2 of 3" with previous/next links, plus the picker for the earlier part. */
export function MeetingSeriesControl({ meetingId }: { meetingId: string }) {
  const { meetings } = useSidebar();
  const series = useMemo(() => seriesOf(meetings, meetingId), [meetingId, meetings]);
  const index = series.findIndex((meeting) => meeting.id === meetingId);
  const previous = index > 0 ? series[index - 1] : null;
  const next = index >= 0 ? series[index + 1] : undefined;

  const link = async (previousMeetingId: string | null) => {
    try {
      await setPreviousMeeting(meetingId, previousMeetingId);
      announceChange('meetings', { meetingId });
    } catch (error) {
      toast.error('Could not update the series', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="inline-flex items-center gap-1">
      {series.length > 1 && (
        <nav aria-label="Meeting series" className="inline-flex items-center gap-0.5">
          {previous ? (
            <Link href={`/meeting-details?id=${encodeURIComponent(previous.id)}`} className={stepClass} aria-label={`Previous part: ${displayTitle(previous.title, previous.created_at)}`}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Link>
          ) : null}
          <span className="font-medium tabular-nums text-af-text-2">
            Part {index + 1} of {series.length}
          </span>
          {next ? (
            <Link href={`/meeting-details?id=${encodeURIComponent(next.id)}`} className={stepClass} aria-label={`Next part: ${displayTitle(next.title, next.created_at)}`}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          ) : null}
        </nav>
      )}
      <ContinuationPicker meetingId={meetingId} value={previous?.id ?? null} onChange={link} />
    </div>
  );
}
