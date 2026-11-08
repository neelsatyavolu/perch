import type { BookmarkChange, BookmarkNode, HistoryVisit, OpenWindow, PerchDomainApi } from "../src/browser/perch-domain";

/** A browser's bookmarks, history and tabs in memory, behind the Perch domain's calls. */
export function fakeBrowser() {
  let next = 100;
  const roots: BookmarkNode[] = [
    { id: "1", title: "Bookmarks bar", children: [] },
    { id: "2", title: "Other bookmarks", children: [] },
  ];
  const visits: HistoryVisit[] = [];
  const added: HistoryVisit[] = [];
  let windows: OpenWindow[] = [];
  const find = (id: string, nodes: BookmarkNode[] = roots): { node: BookmarkNode; parent: BookmarkNode[] } | null => {
    for (const n of nodes) {
      if (n.id === id) return { node: n, parent: nodes };
      const inner = n.children ? find(id, n.children) : null;
      if (inner) return inner;
    }
    return null;
  };
  const domain: Pick<PerchDomainApi, "getBookmarks" | "applyBookmarkChanges" | "getHistory" | "addHistory" | "getOpenTabs"> = {
    async getBookmarks() {
      return { roots: structuredClone(roots) };
    },
    async applyBookmarkChanges({ changes }: { changes: BookmarkChange[] }) {
      const idMap: Record<number, string> = {};
      changes.forEach((c, i) => {
        if (c.op === "add") {
          const id = String(next++);
          find(c.parentId)!.node.children!.push(c.url ? { id, title: c.title, url: c.url } : { id, title: c.title, children: [] });
          idMap[i] = id;
        } else if (c.op === "remove") {
          const f = find(c.id)!;
          f.parent.splice(f.parent.indexOf(f.node), 1);
        } else if (c.op === "update") {
          Object.assign(find(c.id)!.node, c.title !== undefined ? { title: c.title } : {}, c.url !== undefined ? { url: c.url } : {});
        }
      });
      return { applied: changes.length, idMap };
    },
    async getHistory({ since }) {
      return { visits: visits.filter((v) => v.time > since) };
    },
    async addHistory({ visits: v }) {
      added.push(...v);
      return { added: v.length };
    },
    async getOpenTabs() {
      return { windows };
    },
  };
  return {
    domain,
    roots,
    visits,
    added,
    setWindows: (w: OpenWindow[]) => (windows = w),
    addBookmark: (parent: number, title: string, url: string) => roots[parent]!.children!.push({ id: String(next++), title, url }),
  };
}

