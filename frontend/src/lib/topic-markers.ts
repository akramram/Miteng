/**
 * Topic changes marked while recording. During the call they live in session
 * storage, tagged with the recording they belong to. When the meeting is
 * saved they become a draft for that meeting (local storage, so a restart
 * keeps it), which the meeting page turns into topics after the user reviews
 * them.
 */
import type { ChapterDraft } from '@/lib/workspace-api';

export interface TopicMarker {
  /** Recording time of the change. */
  seconds: number;
  title: string;
}

const LIVE_KEY = 'af-live-topic-markers';
const DRAFT_PREFIX = 'af-topic-draft:';
export const TOPIC_MARKERS_EVENT = 'af-live-topic-markers';
/** Shorter topics are folded into a neighbour (the backend refuses them). */
const MIN_TOPIC_SECONDS = 5;

function validMarkers(value: unknown): TopicMarker[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is TopicMarker => Number.isFinite(entry?.seconds) && typeof entry?.title === 'string')
    .sort((a, b) => a.seconds - b.seconds);
}

/** Markers of the recording identified by `session` (the live session's start time). */
export function readLiveMarkers(session: string): TopicMarker[] {
  try {
    const stored = JSON.parse(sessionStorage.getItem(LIVE_KEY) ?? 'null') as { session?: string; markers?: unknown } | null;
    return stored?.session === session ? validMarkers(stored.markers) : [];
  } catch {
    return [];
  }
}

export function writeLiveMarkers(session: string, markers: TopicMarker[] | null) {
  try {
    if (!markers) sessionStorage.removeItem(LIVE_KEY);
    else sessionStorage.setItem(LIVE_KEY, JSON.stringify({ session, markers }));
  } catch {
    // Without storage the markers last as long as this page.
  }
  window.dispatchEvent(new CustomEvent(TOPIC_MARKERS_EVENT));
}

export function readTopicDraft(meetingId: string): TopicMarker[] {
  try {
    return validMarkers(JSON.parse(localStorage.getItem(DRAFT_PREFIX + meetingId) ?? '[]'));
  } catch {
    return [];
  }
}

export function writeTopicDraft(meetingId: string, markers: TopicMarker[] | null) {
  try {
    if (!markers?.length) localStorage.removeItem(DRAFT_PREFIX + meetingId);
    else localStorage.setItem(DRAFT_PREFIX + meetingId, JSON.stringify(markers));
  } catch {
    // The draft is lost; the meeting is summarized as a whole.
  }
}

/**
 * Topics covering the whole recording, split at each marker; the part before
 * the first marker is a topic of its own. A topic too short to keep joins the
 * one before it, or names the first topic when it is at the very start.
 */
export function markersToChapters(markers: TopicMarker[], durationSeconds: number): ChapterDraft[] {
  const chapters: ChapterDraft[] = [];
  let start: TopicMarker = { seconds: 0, title: '' };
  const cuts = markers.filter((marker) => marker.seconds > 0 && marker.seconds < durationSeconds);
  for (let index = 0; index <= cuts.length; index++) {
    const end = index < cuts.length ? cuts[index].seconds : durationSeconds;
    const next = index < cuts.length ? cuts[index] : null;
    if (end - start.seconds >= MIN_TOPIC_SECONDS) {
      chapters.push({ title: start.title.trim() || `Topic ${chapters.length + 1}`, startSeconds: start.seconds, endSeconds: end });
      if (next) start = next;
    } else if (chapters.length > 0) {
      chapters[chapters.length - 1].endSeconds = end;
      if (next) start = { ...next, seconds: end };
    } else if (next) {
      start = { seconds: 0, title: next.title };
    }
  }
  return chapters;
}
