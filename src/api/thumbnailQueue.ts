export interface ThumbnailRequestOptions {
  priority?: "visible" | "background";
  signal?: AbortSignal;
}

interface Subscriber {
  priority: ThumbnailRequestOptions["priority"];
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

interface Request {
  key: string;
  load: () => Promise<string>;
  started: boolean;
  subscribers: Set<Subscriber>;
}

/** Bounded, deduplicated IPC queue. Unmounted consumers do not hold queued slots. */
export class ThumbnailQueue {
  private active = 0;
  private requests = new Map<string, Request>();
  private pending: Request[] = [];

  constructor(private readonly concurrency: number) {}

  has(key: string): boolean {
    return this.requests.has(key);
  }

  request(
    key: string,
    load: () => Promise<string>,
    { priority = "background", signal }: ThumbnailRequestOptions = {},
  ): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    let request = this.requests.get(key);
    if (!request) {
      request = { key, load, started: false, subscribers: new Set() };
      this.requests.set(key, request);
      this.pending.push(request);
    }
    const task = request;
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const subscriber: Subscriber = {
        priority,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        task.subscribers.delete(subscriber);
        subscriber.reject(signal?.reason);
        if (!task.started && task.subscribers.size === 0) {
          this.pending = this.pending.filter((item) => item !== task);
          this.requests.delete(key);
        }
      };
      task.subscribers.add(subscriber);
      signal?.addEventListener("abort", abort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const visibleIndex = this.pending.findIndex((task) =>
        [...task.subscribers].some((subscriber) => subscriber.priority === "visible"),
      );
      const [task] = this.pending.splice(Math.max(0, visibleIndex), 1);
      task.started = true;
      this.active += 1;
      void this.run(task);
    }
  }

  private async run(task: Request): Promise<void> {
    try {
      const value = await task.load();
      for (const subscriber of task.subscribers) subscriber.resolve(value);
    } catch (error) {
      console.warn("[thumbnail queue] request failed", { key: task.key, error });
      for (const subscriber of task.subscribers) subscriber.reject(error);
    } finally {
      this.requests.delete(task.key);
      this.active -= 1;
      this.pump();
    }
  }
}
