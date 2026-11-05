import type { JobProgress } from "../api";

/** A thin progress bar with the current step in words, announced politely. */
export function Progress({ progress, label }: { readonly progress: JobProgress; readonly label: string }) {
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div class="progress">
      <div class="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      <p role="status" class="progress-step">{progress.step}</p>
    </div>
  );
}
