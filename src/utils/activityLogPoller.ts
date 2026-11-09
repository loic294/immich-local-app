export interface PollLoopOptions {
  /** One poll. A rejection counts as a failure and backs the loop off. */
  poll: () => Promise<void>;
  /** While this is false (e.g. the window is hidden) polling parks until `wake()` is called. */
  isActive: () => boolean;
  intervalMs: number;
  maxBackoffMs: number;
  /** Called after every failed poll with the number of failures in a row. */
  onError?: (error: unknown, consecutiveFailures: number) => void;
  /** Called after the first successful poll that follows one or more failures. */
  onRecovered?: () => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PollLoop {
  /** Schedules the first poll right away. */
  start: () => void;
  /** Permanent: cancels the timer and never polls again. An in-flight poll is left to settle. */
  stop: () => void;
  /** Resumes a parked loop; does nothing while a poll or timer is already pending. */
  wake: () => void;
  /**
   * Runs `task` while no poll is in flight and none can start, then resumes polling at once.
   * Tasks run one at a time, in call order. Used for actions that must not interleave with a poll.
   */
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
}

const defaultSetTimer = (callback: () => void, delayMs: number): unknown =>
  setTimeout(callback, delayMs);
const defaultClearTimer = (handle: unknown): void =>
  clearTimeout(handle as ReturnType<typeof setTimeout>);

const noop = (): void => undefined;

/** Observers are best effort: one that throws must not break polling. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Ignored on purpose.
  }
}

export function backoffDelay(intervalMs: number, maxBackoffMs: number, failures: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(maxBackoffMs, intervalMs * 2 ** failures);
}

/**
 * A self-scheduling poll loop: the next poll is only scheduled once the previous one settled,
 * so polls can never overlap, and failures slow it down instead of hammering the backend.
 */
export function createPollLoop(options: PollLoopOptions): PollLoop {
  const { poll, isActive, intervalMs, maxBackoffMs, onError, onRecovered } = options;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;

  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let exclusiveCount = 0;
  let exclusiveQueue: Promise<unknown> = Promise.resolve();
  let failures = 0;

  const canRun = () => !stopped && inFlight === null && exclusiveCount === 0;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function schedule(delayMs: number): void {
    cancelTimer();
    if (!canRun()) return;
    timer = setTimer(tick, delayMs);
  }

  async function runPoll(): Promise<void> {
    let failure: { error: unknown } | null = null;
    try {
      await poll();
    } catch (error) {
      failure = { error };
    }
    if (failure !== null) {
      failures += 1;
      const { error } = failure;
      notify(() => onError?.(error, failures));
    } else if (failures > 0) {
      failures = 0;
      notify(() => onRecovered?.());
    }
  }

  function tick(): void {
    timer = null;
    if (!canRun() || !isActive()) return;
    const current = runPoll();
    inFlight = current;
    void current.then(() => {
      if (inFlight === current) inFlight = null;
      schedule(backoffDelay(intervalMs, maxBackoffMs, failures));
    });
  }

  function start(): void {
    schedule(0);
  }

  function stop(): void {
    stopped = true;
    cancelTimer();
  }

  function wake(): void {
    if (!canRun() || timer !== null) return;
    schedule(0);
  }

  function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    exclusiveCount += 1;
    cancelTimer();
    const result = exclusiveQueue.then(async () => {
      if (inFlight !== null) await inFlight;
      return task();
    });
    exclusiveQueue = result.then(noop, noop);
    return result.finally(() => {
      exclusiveCount -= 1;
      if (exclusiveCount === 0) schedule(0);
    });
  }

  return { start, stop, wake, runExclusive };
}
