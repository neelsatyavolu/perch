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

/**
 * A modal on the native <dialog>: the browser traps focus, makes the page behind it inert and
 * sends `cancel` on Escape. Focus goes back to whatever opened it.
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
    <dialog ref={ref} class="dlg" aria-labelledby={titleId} style={wide ? { width: "min(720px, calc(100vw - 32px))" } : undefined}>
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
