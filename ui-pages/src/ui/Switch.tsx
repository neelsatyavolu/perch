type Props = {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  /** Id of the text that describes what the switch does. */
  readonly describedBy?: string;
};

export function Switch({ label, checked, onChange, disabled, describedBy }: Props) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-label={label}
      aria-checked={checked ? "true" : "false"}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
