import { useEffect, useState } from "preact/hooks";
import type { JobId, JobProgress } from "../api";
import { useApi } from "./frame";

/** Follows a perchd job (profile build, import) and returns its latest progress. */
export function useJob(jobId: JobId | null): JobProgress | null {
  const api = useApi();
  const [progress, setProgress] = useState<JobProgress | null>(null);
  useEffect(() => {
    setProgress(null);
    if (!jobId) return;
    return api.watchJob(jobId, setProgress);
  }, [jobId]);
  return progress;
}
