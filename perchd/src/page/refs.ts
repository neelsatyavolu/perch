/** Short refs (e12) for elements the model can act on, stable for the life of a tab. */

/**
 * What a ref points at. Nodes inside a cross-site iframe live in that frame's session, and
 * `owner` is the iframe element in the page, used to turn frame coordinates into page coordinates.
 */
export type RefTarget = { backendNodeId: number; frameId: string; session?: string; owner?: number };

export class RefGone extends Error {
  constructor(ref: string) {
    super(`ref ${ref} is gone; take a new snapshot`);
  }
}

export class RefTable {
  private readonly byNode = new Map<string, string>();
  private readonly byRef = new Map<string, RefTarget>();
  private next = 1;

  refFor(backendNodeId: number, frameId: string, session?: string, owner?: number): string {
    // Node ids repeat across processes, so the key includes the frame's session.
    const key = `${session ?? "main"}:${backendNodeId}`;
    const known = this.byNode.get(key);
    if (known) return known;
    const ref = `e${this.next++}`;
    this.byNode.set(key, ref);
    this.byRef.set(ref, { backendNodeId, frameId, ...(session ? { session } : {}), ...(owner !== undefined ? { owner } : {}) });
    return ref;
  }

  resolve(ref: string): RefTarget {
    const target = this.byRef.get(ref);
    if (!target) throw new RefGone(ref);
    return target;
  }
}

const tables = new WeakMap<object, RefTable>();

export function refsFor(tab: object): RefTable {
  let table = tables.get(tab);
  if (!table) tables.set(tab, (table = new RefTable()));
  return table;
}
