export const TOAST_VIEWPORT_MARGIN_PX = 16;
export const TOAST_DOCK_GAP_PX = 8;

type Listener = () => void;

export interface DockInsetRegistry {
  nextId(): number;
  report(id: number, inset: number): void;
  tallest(): number;
  subscribe(listener: Listener): () => void;
}

/** Distance from the bottom of the window to the top of a bottom-anchored element. */
export function computeDockInset(viewportHeight: number, elementTop: number): number {
  const inset = viewportHeight - elementTop;
  return Number.isFinite(inset) && inset > 0 ? Math.ceil(inset) : 0;
}

/** Bottom offset of the toast stack: 1rem, or just above the tallest docked overlay. */
export function computeToastViewportBottom(tallestInset: number): number {
  return Math.max(TOAST_VIEWPORT_MARGIN_PX, tallestInset + TOAST_DOCK_GAP_PX);
}

export function createDockInsetRegistry(): DockInsetRegistry {
  const insets = new Map<number, number>();
  const listeners = new Set<Listener>();
  let lastId = 0;
  let tallest = 0;

  return {
    nextId: () => ++lastId,
    report(id, inset) {
      if (Number.isFinite(inset) && inset > 0) insets.set(id, inset);
      else insets.delete(id);

      let next = 0;
      for (const value of insets.values()) next = Math.max(next, value);
      if (next === tallest) return;
      tallest = next;
      for (const listener of [...listeners]) listener();
    },
    tallest: () => tallest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const registry = createDockInsetRegistry();

export const nextDockId = registry.nextId;
export const reportDockInset = registry.report;
export const getTallestDockInset = registry.tallest;
export const subscribeToDockInsets = registry.subscribe;
