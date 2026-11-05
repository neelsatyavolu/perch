import type { ComponentChildren } from "preact";

type Props = {
  /** Anchor for Settings search; the detail gets `${id}-d` so controls can point at it. */
  readonly id?: string;
  readonly title: ComponentChildren;
  readonly detail?: ComponentChildren;
  readonly icon?: ComponentChildren;
  readonly children?: ComponentChildren;
  readonly hit?: boolean;
  readonly sub?: boolean;
};

/** A settings row: title, a one-line explanation under it, and its control on the right (spec 6.8). */
export function Row({ id, title, detail, icon, children, hit, sub }: Props) {
  return (
    <div id={id} class={`srow ${icon ? "" : "noicon"} ${hit ? "hit" : ""} ${sub ? "sub" : ""}`}>
      {icon}
      <div>
        <div class="n">{title}</div>
        {detail && <div class="d" id={id ? `${id}-d` : undefined}>{detail}</div>}
      </div>
      {children !== undefined && <div class="ctl">{children}</div>}
    </div>
  );
}

export function Group({ label, children, id }: { readonly label: string; readonly children: ComponentChildren; readonly id?: string }) {
  return (
    <section class="group" aria-label={label} id={id}>
      <h3 class="lbl">{label}</h3>
      {children}
    </section>
  );
}
