/** PerchApi over the browser's `window.perch` bridge: one call per method, events for jobs. */

import { API_METHODS, type JobProgress, type PerchApi } from "../api";

export type Bridge = {
  call(method: string, args: readonly unknown[]): Promise<unknown>;
  subscribe(event: string, listener: (data: unknown) => void): () => void;
};

export function isBridge(value: unknown): value is Bridge {
  const v = value as Partial<Bridge> | null | undefined;
  return typeof v?.call === "function" && typeof v?.subscribe === "function";
}

function isJobProgress(value: unknown): value is JobProgress {
  const v = value as Partial<JobProgress> | null;
  return (
    typeof v?.jobId === "string" &&
    (v.state === "running" || v.state === "done" || v.state === "failed") &&
    typeof v.step === "string" &&
    typeof v.done === "number" &&
    typeof v.total === "number"
  );
}

const asError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Perch couldn't finish that. Try again.");

export function createRpcApi(bridge: Bridge): PerchApi {
  const methods = Object.fromEntries(
    API_METHODS.map((name) => [name, (...args: unknown[]) => bridge.call(name, args).catch((e: unknown) => Promise.reject(asError(e)))]),
  );
  return {
    ...methods,
    watchJob(id, listener) {
      // Subscribe first, then ask for the current state: events are not replayed, so a job that
      // moved on (or finished) before the subscription existed is still seen. A snapshot that
      // arrives after a live event is older than it, so it is dropped.
      let live = true;
      let heard = false;
      const stop = bridge.subscribe(`job:${id}`, (data) => {
        if (!live || !isJobProgress(data) || data.jobId !== id) return;
        heard = true;
        listener(data);
      });
      bridge.call("getJob", [id]).then(
        (data) => {
          if (live && !heard && isJobProgress(data) && data.jobId === id) listener(data);
        },
        () => undefined,
      );
      return () => {
        live = false;
        stop();
      };
    },
  } as PerchApi;
}
