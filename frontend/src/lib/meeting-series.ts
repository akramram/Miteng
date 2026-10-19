/**
 * Meeting series: a meeting can continue one earlier meeting (after a break or
 * on another day), forming a straight line Part 1 → 2 → 3. The backend stores
 * `previous_meeting_id` and rejects loops and branches; everything here is
 * derived from the meeting list the sidebar already holds.
 */
import { invoke } from '@tauri-apps/api/core';

export interface SeriesMeeting {
  id: string;
  created_at?: string;
  previous_meeting_id?: string | null;
}

export interface PartPosition {
  part: number;
  total: number;
}

function nextById(meetings: ReadonlyArray<SeriesMeeting>) {
  const next = new Map<string, string>();
  for (const meeting of meetings) {
    if (meeting.previous_meeting_id) next.set(meeting.previous_meeting_id, meeting.id);
  }
  return next;
}

function walkDown(start: string, next: Map<string, string>) {
  const ids = [start];
  const seen = new Set(ids);
  for (let id = next.get(start); id && !seen.has(id); id = next.get(id)) {
    ids.push(id);
    seen.add(id);
  }
  return ids;
}

/** Every part of the series `meetingId` belongs to, first part first. */
export function seriesOf<T extends SeriesMeeting>(meetings: ReadonlyArray<T>, meetingId: string): T[] {
  const byId = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  let first = meetingId;
  const seen = new Set([first]);
  for (let previous = byId.get(first)?.previous_meeting_id; previous && byId.has(previous) && !seen.has(previous); previous = byId.get(previous)?.previous_meeting_id) {
    first = previous;
    seen.add(previous);
  }
  return walkDown(first, nextById(meetings)).flatMap((id) => byId.get(id) ?? []);
}

/** "Part 2 of 3" for every meeting that is in a series of two or more. */
export function partPositions(meetings: ReadonlyArray<SeriesMeeting>): Map<string, PartPosition> {
  const ids = new Set(meetings.map((meeting) => meeting.id));
  const next = nextById(meetings);
  const positions = new Map<string, PartPosition>();
  for (const meeting of meetings) {
    const isFirst = !meeting.previous_meeting_id || !ids.has(meeting.previous_meeting_id);
    if (!isFirst || !next.has(meeting.id)) continue;
    const parts = walkDown(meeting.id, next);
    parts.forEach((id, index) => positions.set(id, { part: index + 1, total: parts.length }));
  }
  return positions;
}

/**
 * Meetings `meetingId` (or, with null, the next recording) can continue: any
 * earlier meeting not already continued by another, excluding its own later parts.
 */
export function continuationCandidates<T extends SeriesMeeting>(meetings: ReadonlyArray<T>, meetingId: string | null): T[] {
  const next = nextById(meetings);
  const later = new Set(meetingId ? walkDown(meetingId, next) : []);
  const startedAt = Date.parse(meetings.find((meeting) => meeting.id === meetingId)?.created_at ?? '');
  return meetings.filter((meeting) => {
    if (later.has(meeting.id)) return false;
    if (Date.parse(meeting.created_at ?? '') >= startedAt) return false;
    const continuedBy = next.get(meeting.id);
    return !continuedBy || continuedBy === meetingId;
  });
}

export const setPreviousMeeting = (meetingId: string, previousMeetingId: string | null) =>
  invoke<void>('api_set_previous_meeting', { meetingId, previousMeetingId });

/**
 * The meeting the next (or current) recording continues. Like the pending
 * group, it lives in session storage and is applied when the meeting is saved.
 */
export const PENDING_CONTINUATION_KEY = 'pendingRecordingContinuation';
export const PENDING_CONTINUATION_EVENT = 'af-pending-continuation';

export function readPendingContinuation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return sessionStorage.getItem(PENDING_CONTINUATION_KEY) || null;
  } catch {
    return null;
  }
}

export function writePendingContinuation(meetingId: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (meetingId) sessionStorage.setItem(PENDING_CONTINUATION_KEY, meetingId);
    else sessionStorage.removeItem(PENDING_CONTINUATION_KEY);
  } catch {
    // Without storage the choice simply isn't remembered.
  }
  window.dispatchEvent(new CustomEvent(PENDING_CONTINUATION_EVENT));
}
