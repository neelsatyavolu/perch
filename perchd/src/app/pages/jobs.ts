/**
 * Long jobs the pages start (import, building the memory profile): each has an id, its latest
 * progress for `getJob`, and a `job:<id>` event on every change. Finished jobs are kept for a while
 * so a page that reloads still sees how one ended.
 */

import type { JobProgress } from "../../../../ui-pages/src/api";

const KEEP = 50;

export type JobRun = {
  readonly id: string;
  step(step: string, done: number): void;
  finish(summary: readonly string[]): void;
  fail(error: string): void;
};

export class Jobs {
  private jobs: ReadonlyMap<string, JobProgress> = new Map();

  constructor(private readonly emit: (event: string, data: unknown) => void) {}

  get(id: string): JobProgress | null {
    return this.jobs.get(id) ?? null;
  }

  running(id: string | null): boolean {
    return id !== null && this.jobs.get(id)?.state === "running";
  }

  /** Starts a job and runs `work` in the background; an error thrown by it fails the job. */
  start(total: number, firstStep: string, work: (job: JobRun) => Promise<void>): string {
    const id = `job-${crypto.randomUUID()}`;
    let current: JobProgress = { jobId: id, state: "running", step: firstStep, done: 0, total };
    const set = (next: JobProgress) => {
      if (this.jobs.get(id)?.state !== "running") return;
      current = next;
      this.put(next);
    };
    const run: JobRun = {
      id,
      step: (step, done) => set({ ...current, step, done: Math.min(done, total) }),
      finish: (summary) => set({ ...current, state: "done", step: "Done", done: total, summary }),
      fail: (error) => set({ ...current, state: "failed", error }),
    };
    this.put(current);
    void work(run).then(
      () => run.finish([]),
      (error: unknown) => run.fail(error instanceof Error ? error.message : "The job stopped. Try again."),
    );
    return id;
  }

  private put(progress: JobProgress): void {
    const kept = [...this.jobs].filter(([key]) => key !== progress.jobId).slice(-(KEEP - 1));
    this.jobs = new Map([...kept, [progress.jobId, progress]]);
    this.emit(`job:${progress.jobId}`, progress);
  }
}
