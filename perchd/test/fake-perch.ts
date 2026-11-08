import { CdpError } from "../src/cdp/connection";

/** A fake pipe: records calls, answers from a table, and can fire events. */
export function fakeConn(answers: Record<string, unknown | Error> = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  return {
    calls,
    fire(event: string, params: unknown) {
      for (const l of listeners.get(event) ?? []) l(params);
    },
    async send<T>(method: string, params: object = {}): Promise<T> {
      calls.push({ method, params });
      const a = answers[method];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new CdpError(method, `'${method}' wasn't found`, -32601);
      return a as T;
    },
    on(event: string, listener: (p: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    },
  };
}

