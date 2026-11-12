import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { Icon, X } from "./icons";

type Props = {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
  readonly footer?: ComponentChildren;
  readonly wide?: boolean;
};

const FIELDS = "input:not(:disabled):not([type=checkbox]):not([type=radio]), select:not(:disabled), textarea:not(:disabled)";
const FOCUSABLE ="button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * Keeps Tab inside the dialog. A modal <dialog> makes the page behind it inert, but Tab can still
 * leave the page for the browser's own toolbar; this wraps from the last control to the first.
 */
function trapTab(e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  const dlg = e.currentTarget as HTMLElement;
  const items = [...dlg.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden], [inert]"));
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items.at(-1)!;
  const active = document.activeElement;
  if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  }
}

/**
 * A modal on the native <dialog>: the page behind it is inert, Tab wraps inside it, and Escape
 * sends `cancel`. Focus goes back to whatever opened it.
 */
export function Dialog({ open, title, onClose, children, footer, wide }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      opener.current = document.activeElement;
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
      // As on a Mac sheet: focus starts in the first field, or on Cancel for a confirmation, not on the close button.
      const start = dlg.querySelector<HTMLElement>(`.dlg-b :is(${FIELDS}), .dlg-f .btn:not(.primary)`);
      start?.focus();
    }
    if (!open && dlg.open) {
      dlg.close();
      (opener.current as HTMLElement | null)?.focus?.();
    }
  }, [open]);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dlg.addEventListener("cancel", onCancel);
    return () => dlg.removeEventListener("cancel", onCancel);
  }, [onClose]);

  return (
    <dialog ref={ref} class="dlg" aria-labelledby={titleId} onKeyDown={trapTab} style={wide ? { width: "min(720px, calc(100vw - 32px))" } : undefined}>
      {open && (
        <>
          <div class="dlg-h">
            <h2 id={titleId}>{title}</h2>
            <button type="button" class="ib" aria-label="Close" onClick={onClose}>
              <Icon of={X} />
            </button>
          </div>
          <div class="dlg-b">{children}</div>
          {footer && <div class="dlg-f">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
