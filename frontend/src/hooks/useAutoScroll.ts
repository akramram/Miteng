import { useRef, useState, useEffect, useCallback, RefObject } from "react";
import { Virtualizer } from "@tanstack/react-virtual";

interface UseAutoScrollProps {
    scrollRef: RefObject<HTMLDivElement | null>;
    segments: ReadonlyArray<{ id: string }>;
    /**
     * Changes whenever visible content grows, including lines merged into the
     * last segment (which leave `segments.length` unchanged). Defaults to
     * `segments.length`.
     */
    contentKey?: string | number;
    isRecording: boolean;
    isPaused: boolean;
    activeSegmentId?: string;
    virtualizer?: Virtualizer<HTMLDivElement, Element>;
    virtualizationThreshold?: number;
    disableAutoScroll?: boolean; // Completely disable auto-scroll behavior (for meeting details page)
}

interface UseAutoScrollReturn {
    autoScroll: boolean;
    setAutoScroll: (value: boolean) => void;
    scrollToBottom: () => void;
}

// Threshold in pixels to consider "at the bottom"
const SCROLL_THRESHOLD = 100;

/**
 * Custom hook to manage auto-scrolling behavior for transcript
 *
 * Features:
 * - Auto-scrolls to bottom when new content arrives during recording
 * - Pauses auto-scroll when user manually scrolls up
 * - Resumes auto-scroll when user scrolls back to the bottom
 *
 * @param segments - Array of transcript segments
 * @param isRecording - Whether recording is in progress
 * @param isPaused - Whether recording is paused
 * @param activeSegmentId - ID of the currently active segment
 * @returns Scroll ref, auto-scroll state, and scroll control functions
 */
export function useAutoScroll({
    scrollRef,
    segments,
    contentKey = segments.length,
    isRecording,
    isPaused,
    activeSegmentId,
    virtualizer,
    virtualizationThreshold = 10,
    disableAutoScroll = false,
}: UseAutoScrollProps): UseAutoScrollReturn {
    const useVirtualization = virtualizer && segments.length >= virtualizationThreshold;
    const [autoScroll, setAutoScroll] = useState(true);
    // Ref to always have current autoScroll value in effects
    const autoScrollRef = useRef(autoScroll);
    autoScrollRef.current = autoScroll;

    // Track if user has manually scrolled (to disable auto-scroll temporarily)
    const userScrolledRef = useRef(false);
    // Track if we're doing a programmatic scroll
    const isProgrammaticScrollRef = useRef(false);
    // Previous content key, to detect new content
    const prevContentKeyRef = useRef(contentKey);

    /**
     * Check if the user is scrolled near the bottom
     */
    const isNearBottom = useCallback(() => {
        if (!scrollRef.current) return true;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
    }, [scrollRef]);

    /**
     * Scroll to bottom programmatically
     */
    const scrollToBottom = useCallback(() => {
        if (scrollRef.current) {
            isProgrammaticScrollRef.current = true;
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            userScrolledRef.current = false;
            setAutoScroll(true);

            // Reset the flag after a small delay to account for scroll event propagation
            setTimeout(() => {
                isProgrammaticScrollRef.current = false;
            }, 50);
        }
    }, [scrollRef]);

    // Handle scroll events to detect manual scrolling
    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        let scrollTimeout: ReturnType<typeof setTimeout> | undefined;

        const handleScroll = () => {
            // Skip if this is a programmatic scroll
            if (isProgrammaticScrollRef.current) {
                return;
            }

            // Record the intent at once: content that arrives during the
            // debounce must not pull a reader who just scrolled up back down.
            const nearBottom = isNearBottom();
            autoScrollRef.current = nearBottom;
            userScrolledRef.current = !nearBottom;

            // Debounce the state update to prevent rapid re-renders
            clearTimeout(scrollTimeout);

            scrollTimeout = setTimeout(() => {
                setAutoScroll(isNearBottom());
            }, 100);
        };

        container.addEventListener("scroll", handleScroll, { passive: true });

        return () => {
            container.removeEventListener("scroll", handleScroll);
            clearTimeout(scrollTimeout);
        };
    }, [isNearBottom, scrollRef]);

    // Follow new content during recording while the reader is at the bottom
    useEffect(() => {
        // EARLY RETURN: If auto-scroll is completely disabled (e.g., meeting details page)
        if (disableAutoScroll) {
            return;
        }

        const hasNewContent = contentKey !== prevContentKeyRef.current;
        prevContentKeyRef.current = contentKey;

        // "At the bottom" is the reader's last scroll position, not a measurement
        // taken now: the new content has already pushed the bottom further down.
        if (hasNewContent && autoScrollRef.current && isRecording && !isPaused && segments.length > 0) {

            isProgrammaticScrollRef.current = true;

            if (useVirtualization && virtualizer) {
                // Use scrollToOffset with a large value to ensure we're at the bottom
                const totalSize = virtualizer.getTotalSize();
                virtualizer.scrollToOffset(totalSize + 1000, { align: "end" });

                // Also set scrollTop directly as backup after virtualizer updates
                setTimeout(() => {
                    if (scrollRef.current) {
                        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                    }
                }, 50);
            } else if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }

            // Reset the flag after a longer delay for virtualization
            setTimeout(() => {
                isProgrammaticScrollRef.current = false;
            }, 150);
        }
    }, [contentKey, segments.length, isRecording, isPaused, useVirtualization, virtualizer, scrollRef, disableAutoScroll]);

    // Auto-scroll to active segment (when clicking on search results, etc.)
    useEffect(() => {
        if (activeSegmentId) {
            isProgrammaticScrollRef.current = true;

            if (useVirtualization && virtualizer) {
                const index = segments.findIndex((s) => s.id === activeSegmentId);
                if (index >= 0) {
                    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
                }
            } else {
                const element = document.getElementById(`segment-${activeSegmentId}`);
                if (element) {
                    element.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }

            // Reset the flag after scroll animation completes
            setTimeout(() => {
                isProgrammaticScrollRef.current = false;
            }, 500);
        }
    }, [activeSegmentId, useVirtualization, virtualizer, segments]);

    return {
        autoScroll,
        setAutoScroll,
        scrollToBottom,
    };
}
