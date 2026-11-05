/**
 * Structured logs with no personal data. The field list is closed on purpose: emails, IPs,
 * tokens, account ids, device ids and error messages (which can quote input) cannot be logged.
 */
export type LogFields = {
  route?: string;
  method?: string;
  status?: number;
  ms?: number;
  error?: string;
  count?: number;
};

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
