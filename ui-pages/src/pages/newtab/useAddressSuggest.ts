/**
 * The Search box's address-bar behaviour: the browser's own suggestions for what is typed (history,
 * bookmarks, searches), and its inline completion of the top site. Only the latest query's answer
 * is used, and nothing completes inline right after a deletion, so Backspace works as expected.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import type { AddressMatch } from "../../api";
import { useApi } from "../../ui/frame";

const DEBOUNCE_MS = 40;

export type AddressSuggest = {
  readonly matches: readonly AddressMatch[];
  /** The text the browser would fill in after what was typed; "" when none. */
  readonly inline: string;
  /** -1 while the typed text (with its inline completion) is chosen; else a row of `matches`. */
  readonly selected: number;
  readonly select: (index: number) => void;
  /** Drops the inline completion (after Backspace, or when the caret moves). */
  readonly dropInline: () => void;
  readonly clear: () => void;
};

export function useAddressSuggest(text: string, enabled: boolean, deleting: boolean): AddressSuggest {
  const api = useApi();
  const [matches, setMatches] = useState<readonly AddressMatch[]>([]);
  const [inline, setInline] = useState("");
  const [selected, setSelected] = useState(-1);
  const latest = useRef(0);

  useEffect(() => {
    const query = ++latest.current;
    const typed = text;
    if (!enabled || !typed.trim()) {
      setMatches([]);
      setInline("");
      setSelected(-1);
      return;
    }
    const timer = setTimeout(() => {
      api
        .autocompleteAddress(typed)
        .then(({ matches: found }) => {
          if (query !== latest.current) return;
          setMatches(found);
          setSelected(-1);
          const top = found[0];
          setInline(!deleting && top?.default && top.inline ? top.inline : "");
        })
        .catch(() => {
          if (query === latest.current) setMatches([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, enabled]);

  return {
    matches,
    inline,
    selected,
    select: (index) => setSelected(Math.max(-1, Math.min(matches.length - 1, index))),
    dropInline: () => setInline(""),
    clear: () => {
      latest.current++;
      setMatches([]);
      setInline("");
      setSelected(-1);
    },
  };
}
