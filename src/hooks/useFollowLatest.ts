import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isNearBottom, nextFollowing } from "../utils/activityLogScroll";

export interface UseFollowLatestInput {
  containerRef: RefObject<HTMLElement | null>;
  /** Scrollable content height; growing while following keeps the newest entry in view. */
  contentHeight: number;
  /** Key of the newest item, or null when the list is empty. */
  latestKey: string | null;
  /** Changing this (new filters) resumes following, so the newest matches are shown. */
  resetSignal: unknown;
}

export interface FollowLatest {
  following: boolean;
  /** The newest item's key when the user scrolled away; null while following (or if empty then). */
  pausedAtKey: string | null;
  onScroll: () => void;
  jumpToLatest: () => void;
}

function pinToBottom(element: HTMLElement | null): void {
  if (element) element.scrollTop = element.scrollHeight;
}

/**
 * Tails a growing list like `tail -f`: sticks to the bottom until the user scrolls up, then
 * stays put until they scroll back down or jump to the latest entry.
 */
export function useFollowLatest({
  containerRef,
  contentHeight,
  latestKey,
  resetSignal,
}: UseFollowLatestInput): FollowLatest {
  const [paused, setPaused] = useState<{ atKey: string | null } | null>(null);
  const followingRef = useRef(true);
  const latestKeyRef = useRef(latestKey);
  const lastScrollTopRef = useRef(0);

  useLayoutEffect(() => {
    latestKeyRef.current = latestKey;
  }, [latestKey]);

  useLayoutEffect(() => {
    if (followingRef.current) pinToBottom(containerRef.current);
  }, [containerRef, contentHeight]);

  useLayoutEffect(() => {
    followingRef.current = true;
    setPaused((current) => (current === null ? current : null));
    pinToBottom(containerRef.current);
  }, [containerRef, resetSignal]);

  // A smaller window leaves the bottom row cut off without any scroll event, so re-pin on resize.
  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pinToBottom(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (element === null) return;
    const { scrollTop, scrollHeight, clientHeight } = element;
    const movedUp = scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    const next = nextFollowing(followingRef.current, {
      atBottom: isNearBottom({ scrollTop, scrollHeight, clientHeight }),
      movedUp,
    });
    if (next === followingRef.current) return;
    followingRef.current = next;
    setPaused(next ? null : { atKey: latestKeyRef.current });
  }, [containerRef]);

  const jumpToLatest = useCallback(() => {
    followingRef.current = true;
    setPaused(null);
    pinToBottom(containerRef.current);
  }, [containerRef]);

  return {
    following: paused === null,
    pausedAtKey: paused?.atKey ?? null,
    onScroll,
    jumpToLatest,
  };
}
