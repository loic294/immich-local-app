import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import {
  computeDockInset,
  getTallestDockInset,
  nextDockId,
  reportDockInset,
  subscribeToDockInsets,
} from "./dockInsetStore";

interface DockTracker {
  attach(element: HTMLElement | null): void;
  dispose(): void;
}

function createDockTracker(): DockTracker {
  const id = nextDockId();
  let current: HTMLElement | null = null;
  let stopObserving: (() => void) | null = null;

  function detach() {
    stopObserving?.();
    stopObserving = null;
    current = null;
    reportDockInset(id, 0);
  }

  return {
    attach(element) {
      if (element === current) return;
      detach();
      if (!element) return;

      current = element;
      const measure = () =>
        reportDockInset(
          id,
          computeDockInset(window.innerHeight, element.getBoundingClientRect().top),
        );
      measure();
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
      observer?.observe(element);
      window.addEventListener("resize", measure);
      stopObserving = () => {
        observer?.disconnect();
        window.removeEventListener("resize", measure);
      };
    },
    dispose: detach,
  };
}

/**
 * Registers a bottom-anchored overlay so toasts stack above it. The ref's element
 * may mount and unmount between renders; unmounting the host reports an inset of 0.
 */
export function useDockInset(ref: RefObject<HTMLElement | null>): void {
  const trackerRef = useRef<DockTracker | null>(null);
  if (trackerRef.current === null) trackerRef.current = createDockTracker();

  // No dependency list: the docked element can appear or disappear on any render.
  useLayoutEffect(() => {
    trackerRef.current?.attach(ref.current);
  });

  useEffect(() => {
    const tracker = trackerRef.current;
    return () => tracker?.dispose();
  }, []);
}

export function useTallestDockInset(): number {
  return useSyncExternalStore(subscribeToDockInsets, getTallestDockInset, () => 0);
}
