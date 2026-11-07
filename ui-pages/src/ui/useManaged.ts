import { managedRows, type RowId } from "../lib/managed";
import { useLoad } from "./frame";

/** The policy as Settings sees it: which rows are locked, and whether anything is managed. */
export function useManaged(): { readonly locked: (row: RowId) => boolean; readonly managed: boolean } {
  const policy = useLoad((a) => a.getPolicy());
  const rows = managedRows(policy.data?.values);
  return { locked: (row) => rows.has(row), managed: policy.data?.managed ?? false };
}
