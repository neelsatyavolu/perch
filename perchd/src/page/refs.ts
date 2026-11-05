/** Short refs (e12) for elements the model can act on, stable for the life of a tab. */

export type RefTarget = { backendNodeId: number; frameId: string };

export class RefGone extends Error {
  constructor(ref: string) {
    super(`ref ${ref} is gone; take a new snapshot`);
  }
}

export class RefTable {
  private readonly byNode = new Map<number, string>();
  private readonly byRef = new Map<string, RefTarget>();
  private next = 1;

  refFor(backendNodeId: number, frameId: string): string {
    const known = this.byNode.get(backendNodeId);
    if (known) return known;
    const ref = `e${this.next++}`;
    this.byNode.set(backendNodeId, ref);
    this.byRef.set(ref, { backendNodeId, frameId });
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
