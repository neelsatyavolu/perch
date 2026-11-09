/**
 * The welcome page's sounds, made with Web Audio so no audio file ships: soft sine tones with a
 * slow attack and a long tail, kept quiet. Three cues: the page opening, a step forward, and
 * setup finishing. Where audio can't start (no Web Audio, or the browser wants a click first)
 * the cue is simply skipped; the page never depends on it.
 */

export type Cue = "open" | "step" | "done";

type Note = { readonly hz: number; readonly at: number; readonly length: number; readonly gain: number };

/** A major with an added ninth, low and open; each cue plays a few of its notes. */
const CUES: Readonly<Record<Cue, readonly Note[]>> = {
  open: [
    { hz: 220.0, at: 0, length: 3.2, gain: 0.05 },
    { hz: 329.63, at: 0.12, length: 3.0, gain: 0.04 },
    { hz: 554.37, at: 0.55, length: 2.6, gain: 0.035 },
    { hz: 493.88, at: 0.95, length: 2.8, gain: 0.03 },
  ],
  step: [
    { hz: 440.0, at: 0, length: 0.9, gain: 0.035 },
    { hz: 659.25, at: 0.07, length: 0.9, gain: 0.025 },
  ],
  done: [
    { hz: 220.0, at: 0, length: 2.6, gain: 0.045 },
    { hz: 440.0, at: 0.1, length: 2.4, gain: 0.035 },
    { hz: 554.37, at: 0.22, length: 2.4, gain: 0.03 },
    { hz: 659.25, at: 0.36, length: 2.6, gain: 0.03 },
  ],
};

export type Sound = { play(cue: Cue): void; setMuted(muted: boolean): void; close(): void };

type AudioWindow = Window & { AudioContext?: typeof AudioContext };

export function createSound(win: AudioWindow = window): Sound {
  let context: AudioContext | null = null;
  let muted = false;

  const ensure = (): AudioContext | null => {
    if (context || !win.AudioContext) return context;
    try {
      context = new win.AudioContext();
    } catch {
      context = null;
    }
    return context;
  };

  const schedule = (ctx: AudioContext, note: Note) => {
    const start = ctx.currentTime + note.at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const soften = ctx.createBiquadFilter();
    osc.type = "sine";
    osc.frequency.value = note.hz;
    soften.type = "lowpass";
    soften.frequency.value = 1800;
    // A slow swell in, then a long fade: nothing clicks, nothing rings sharply.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(note.gain, start + Math.min(0.18, note.length / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.length);
    osc.connect(soften).connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + note.length + 0.05);
  };

  return {
    play(cue) {
      if (muted) return;
      const ctx = ensure();
      if (!ctx) return;
      const go = () => CUES[cue].forEach((note) => schedule(ctx, note));
      if (ctx.state === "suspended") void ctx.resume().then(go, () => undefined);
      else go();
    },
    setMuted(value) {
      muted = value;
    },
    close() {
      void context?.close().catch(() => undefined);
      context = null;
    },
  };
}
