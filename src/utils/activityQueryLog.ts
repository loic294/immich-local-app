// Reports failed React Query queries and mutations to the Activity Log (category `query`).
import { isCancelledError, type QueryClient } from "@tanstack/react-query";
import { wasInvokeErrorLogged } from "../api/invoke";
import { describeError } from "./activityInvokePolicy";
import { logActivity } from "./activityLogSink";

const CATEGORY = "query";
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9_.:-]{1,32}$/;

// Query keys carry ids and search text; only the leading name (e.g. "albums") is reported.
function keySegment(queryKey: unknown): string {
  const first = Array.isArray(queryKey) ? queryKey[0] : undefined;
  return typeof first === "string" && SAFE_KEY_SEGMENT.test(first) ? first : "?";
}

export function queryFailureMessage(queryKey: unknown, error: unknown): string {
  return `query [${keySegment(queryKey)}] failed: ${describeError(error)}`;
}

export function mutationFailureMessage(error: unknown): string {
  return `mutation failed: ${describeError(error)}`;
}

// A throwing cache listener would surface inside React Query itself, so nothing may escape.
function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Logging must never disturb React Query.
  }
}

function report(error: unknown, message: () => string): void {
  safely(() => {
    // A failed Tauri command was already recorded, with its duration, by the invoke wrapper.
    if (wasInvokeErrorLogged(error)) return;
    logActivity("warn", CATEGORY, message());
  });
}

function reportQuery(error: unknown, query: { queryKey?: unknown }): void {
  // Cancelling a query (e.g. before an optimistic update) is not a failure.
  if (isCancelledError(error)) return;
  report(error, () => queryFailureMessage(query?.queryKey, error));
}

function reportMutation(error: unknown): void {
  report(error, () => mutationFailureMessage(error));
}

/** For `new QueryCache({ onError })`. */
export function logQueryFailure(error: unknown, query: { queryKey?: unknown }): void {
  reportQuery(error, query);
}

/** For `new MutationCache({ onError })`. */
export function logMutationFailure(error: unknown): void {
  reportMutation(error);
}

const observedClients = new WeakSet<object>();

/**
 * Reports every failed query and mutation of `queryClient`. The client is usually created before
 * this runs, so it is observed through the public cache subscriptions instead of the
 * `QueryCache({ onError })` constructor options. Observing the same client twice is a no-op, and a
 * cache that already reports through `logQueryFailure` / `logMutationFailure` is not subscribed to
 * again (React Query runs the two paths in a different order for queries and mutations, so their
 * reports cannot be paired up reliably).
 */
export function observeQueryClient(queryClient: QueryClient): void {
  if (observedClients.has(queryClient)) return;
  observedClients.add(queryClient);

  const queryCache = queryClient.getQueryCache();
  if (queryCache.config.onError !== logQueryFailure) {
    queryCache.subscribe((event) =>
      safely(() => {
        if (event.type !== "updated" || event.action.type !== "error") return;
        reportQuery(event.action.error, event.query);
      }),
    );
  }

  const mutationCache = queryClient.getMutationCache();
  if (mutationCache.config.onError !== logMutationFailure) {
    mutationCache.subscribe((event) =>
      safely(() => {
        if (event.type !== "updated" || event.action.type !== "error") return;
        reportMutation(event.action.error);
      }),
    );
  }
}
