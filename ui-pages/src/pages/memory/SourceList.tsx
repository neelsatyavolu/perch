import type { FileChoice, SetupSource } from "../../api";
import { Switch } from "../../ui/Switch";

type Props = {
  readonly sources: readonly SetupSource[];
  readonly chosen: readonly string[];
  readonly files: Readonly<Record<string, FileChoice>>;
  readonly disabled: boolean;
  readonly onToggle: (source: SetupSource, on: boolean) => void;
  readonly onChooseFile: (source: SetupSource) => void;
  readonly onOpenFullDiskAccess: () => void;
};

/** The source switches, with the action each source needs before Perch can read it. */
export function SourceList({ sources, chosen, files, disabled, onToggle, onChooseFile, onOpenFullDiskAccess }: Props) {
  return (
    <ul class="src-list">
      {sources.map((s) => {
        const file = files[s.id];
        const detail = s.needs === "export-file" && file ? `From ${file.name}` : s.detail;
        return (
          <li key={s.id} class="src">
            <div>
              <div class="n" id={`src-${s.id}`}>{s.name}</div>
              <div class="d" id={`src-${s.id}-d`}>{detail}</div>
              {s.needs === "export-file" && (
                <button type="button" class="link-btn" disabled={disabled} aria-label={`${file ? "Choose another" : "Choose the"} export file for ${s.name}`} onClick={() => onChooseFile(s)}>
                  {file ? "Choose another file" : "Choose export file"}
                </button>
              )}
              {s.needs === "full-disk-access" && !s.available && (
                <button type="button" class="link-btn" aria-label={`Open System Settings to allow ${s.name}`} onClick={onOpenFullDiskAccess}>
                  Open System Settings
                </button>
              )}
            </div>
            <Switch
              label={s.name}
              describedBy={`src-${s.id}-d`}
              checked={chosen.includes(s.id)}
              disabled={!s.available || disabled}
              onChange={(v) => onToggle(s, v)}
            />
          </li>
        );
      })}
    </ul>
  );
}
