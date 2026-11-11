import type { ComponentChildren } from "preact";
import { ChevronRight, Icon } from "./icons";

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

/** A labelled run of rows. `bare` drops the visible label when it would repeat the page title; the section keeps its name. */
export function Group({ label, children, id, bare }: { readonly label: string; readonly children: ComponentChildren; readonly id?: string; readonly bare?: boolean }) {
  return (
    <section class="group" aria-label={label} id={id}>
      {!bare && <h3 class="lbl">{label}</h3>}
      {children}
    </section>
  );
}

/** A row that opens something: the whole row is the button, with a chevron at the right (spec 2.4). */
export function LinkRow({ id, title, detail, onClick }: { readonly id?: string; readonly title: string; readonly detail?: string; readonly onClick: () => void }) {
  return (
    <button type="button" id={id} class="srow noicon link" onClick={onClick}>
      <div>
        <div class="n">{title}</div>
        {detail && <div class="d">{detail}</div>}
      </div>
      <Icon of={ChevronRight} />
    </button>
  );
}
