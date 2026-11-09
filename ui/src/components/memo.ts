/**
 * preact/compat's memo without compat itself, which would add weight and rewrite events app-wide:
 * the component re-renders only when a prop changes identity.
 */

import { createElement, type Component, type FunctionComponent } from "preact";

function changed(a: object, b: object): boolean {
  for (const k in a) if (!(k in b)) return true;
  for (const k in b) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return true;
  return false;
}

export function memo<P extends object>(render: FunctionComponent<P>): FunctionComponent<P> {
  function Memo(this: Component<P>, props: P) {
    this.shouldComponentUpdate = (next: P) => changed(this.props, next);
    return createElement(render, props);
  }
  Memo.displayName = `Memo(${render.displayName ?? render.name})`;
  return Memo as FunctionComponent<P>;
}
