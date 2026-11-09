/** A small element builder for the extension's pages. Text goes in as text, never as HTML. */

type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: (Node | string | null | false)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const [event, handler] of Object.entries(props.on ?? {})) node.addEventListener(event, handler as EventListener);
  for (const child of children) if (child) node.append(child);
  return node;
}

export function switchButton(label: string, checked: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const button = h("button", { class: "switch", attrs: { role: "switch", "aria-checked": String(checked), "aria-label": label } });
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    button.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return button;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
