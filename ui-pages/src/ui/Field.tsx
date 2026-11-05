import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";

export type FieldProps = {
  readonly id: string;
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: "true";
};

type Props = {
  readonly label: string;
  readonly hint?: ComponentChildren;
  readonly error?: string | null;
  readonly children: (props: FieldProps) => JSX.Element;
};

/** A labelled input whose hint and error are read after the label, not as part of it. */
export function Field({ label, hint, error, children }: Props) {
  const id = useId();
  const described = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div class="label">
      <label for={id}>{label}</label>
      {children({ id, "aria-describedby": described, "aria-invalid": error ? "true" : undefined })}
      {hint && <span id={`${id}-hint`}>{hint}</span>}
      {error && <span class="field-error" id={`${id}-err`} role="alert">{error}</span>}
    </div>
  );
}
