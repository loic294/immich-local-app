// Module-level external store for toasts. It deliberately has no imports so it can be
// unit-tested in isolation; timers are looked up at call time so test doubles apply.

export type ToastKind = "success" | "info" | "warning" | "error";

export interface ToastParams {
  count?: number;
  [param: string]: string | number | undefined;
}

export interface ToastItem {
  readonly id: number;
  readonly kind: ToastKind;
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly count: number;
  readonly duration: number;
}

export interface ToastEvent {
  readonly kind: ToastKind;
  readonly key: string;
  // Amount added by this push (not the accumulated total of a coalesced toast).
  readonly count: number;
}

export type ToastEventListener = (event: ToastEvent) => void;

export const TOAST_DURATION_MS = 4000;
export const TOAST_ERROR_DURATION_MS = 6000;
export const TOAST_MAX_VISIBLE = 5;
// A toast released after a long hover still stays readable for a moment.
export const TOAST_MIN_RESUME_MS = 1000;

interface ToastEntry {
  item: ToastItem;
  identity: string;
  timer: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
  paused: boolean;
}

export interface ToastStore {
  push(kind: ToastKind, key: string, params?: ToastParams): number | null;
  dismiss(id: number): void;
  clear(): void;
  pause(id: number): void;
  resume(id: number): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly ToastItem[];
  subscribeToEvents(listener: ToastEventListener): () => void;
}

function normalizeCount(count: number | undefined): number | null {
  if (count === undefined) return 1;
  if (!Number.isFinite(count) || count < 1) return null;
  return Math.floor(count);
}

function paramsWithoutCount(params: ToastParams): Record<string, string | number> {
  const rest: Record<string, string | number> = {};
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (name !== "count" && value !== undefined) rest[name] = value;
  }
  return rest;
}

export function durationForKind(kind: ToastKind): number {
  return kind === "error" ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS;
}

export function createToastStore(): ToastStore {
  let entries: ToastEntry[] = [];
  let snapshot: readonly ToastItem[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const eventListeners = new Set<ToastEventListener>();

  const publish = () => {
    snapshot = entries.map((entry) => entry.item);
    for (const listener of Array.from(listeners)) listener();
  };

  const emit = (event: ToastEvent) => {
    for (const listener of Array.from(eventListeners)) {
      try {
        listener(event);
      } catch (error) {
        console.error("[toasts] event listener failed", error);
      }
    }
  };

  const find = (id: number) => entries.find((entry) => entry.item.id === id);

  const stopTimer = (entry: ToastEntry) => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  };

  const remove = (id: number) => {
    const entry = find(id);
    if (!entry) return;
    stopTimer(entry);
    entries = entries.filter((candidate) => candidate !== entry);
    publish();
  };

  const startTimer = (entry: ToastEntry, delay: number) => {
    stopTimer(entry);
    entry.remaining = delay;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => remove(entry.item.id), delay);
  };

  return {
    push(kind, key, params = {}) {
      const increment = normalizeCount(params.count);
      if (increment === null) return null;

      const rest = paramsWithoutCount(params);
      const identity = JSON.stringify([kind, key, rest]);
      const existing = entries.find((entry) => entry.identity === identity);

      let id: number;
      if (existing) {
        id = existing.item.id;
        existing.item = { ...existing.item, count: existing.item.count + increment };
        if (existing.paused) existing.remaining = existing.item.duration;
        else startTimer(existing, existing.item.duration);
      } else {
        id = nextId++;
        const item: ToastItem = {
          id,
          kind,
          key,
          params: rest,
          count: increment,
          duration: durationForKind(kind),
        };
        while (entries.length >= TOAST_MAX_VISIBLE) {
          const [oldest] = entries.splice(0, 1);
          stopTimer(oldest);
        }
        const entry: ToastEntry = {
          item,
          identity,
          timer: null,
          remaining: item.duration,
          startedAt: 0,
          paused: false,
        };
        entries = [...entries, entry];
        startTimer(entry, item.duration);
      }

      publish();
      emit({ kind, key, count: increment });
      return id;
    },

    dismiss: remove,

    clear() {
      if (entries.length === 0) return;
      for (const entry of entries) stopTimer(entry);
      entries = [];
      publish();
    },

    pause(id) {
      const entry = find(id);
      if (!entry || entry.paused) return;
      entry.paused = true;
      if (entry.timer === null) return;
      stopTimer(entry);
      entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
    },

    resume(id) {
      const entry = find(id);
      if (!entry || !entry.paused) return;
      entry.paused = false;
      startTimer(entry, Math.max(entry.remaining, TOAST_MIN_RESUME_MS));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => snapshot,

    subscribeToEvents(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
  };
}

const store = createToastStore();

export const pushToast = store.push;
export const dismissToast = store.dismiss;
export const clearToasts = store.clear;
export const pauseToast = store.pause;
export const resumeToast = store.resume;
export const subscribeToToasts = store.subscribe;
export const getToastSnapshot = store.getSnapshot;
export const subscribeToToastEvents = store.subscribeToEvents;
