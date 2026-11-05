/**
 * What each model can do: image input (vision), tool use, image output, context size and the
 * effort levels it accepts. Known models come from the providers' documentation (checked
 * 2026-11-05); unknown ones get conservative guesses from their ids or from the provider's
 * own `/models` reply when it says more (OpenRouter, Gemini).
 */

import type { ProviderId, RoleEffort } from "./ids";

export type Tier = "flagship" | "standard" | "fast";
export type ModelInfo = {
  id: string;
  label: string;
  provider: ProviderId;
  vision: boolean;
  tools: boolean;
  imageOutput: boolean;
  /** Input tokens, or null when the provider does not say. */
  context: number | null;
  /** Effort levels the role menu offers; empty when the model has no reasoning control. */
  efforts: RoleEffort[];
  tier?: Tier;
};

type Known = Omit<ModelInfo, "id" | "provider">;

const FULL: RoleEffort[] = ["off", "low", "medium", "high", "max"];
const CLAUDE_EFFORTS: RoleEffort[] = ["low", "medium", "high", "max"];
const THREE: RoleEffort[] = ["low", "medium", "high"];
const chat = (label: string, context: number | null, efforts: RoleEffort[], tier?: Tier, vision = true): Known => ({
  label, vision, tools: true, imageOutput: false, context, efforts, ...(tier ? { tier } : {}),
});
const image = (label: string): Known => ({ label, vision: true, tools: false, imageOutput: true, context: null, efforts: [] });

const KNOWN: Readonly<Record<string, Known>> = Object.freeze({
  "claude-fable-5-1": chat("Claude Fable 5.1", 1_000_000, CLAUDE_EFFORTS, "flagship"),
  "claude-opus-5-5": chat("Claude Opus 5.5", 1_000_000, CLAUDE_EFFORTS, "flagship"),
  "claude-sonnet-5-5": chat("Claude Sonnet 5.5", 1_000_000, CLAUDE_EFFORTS, "standard"),
  "claude-haiku-5-5": chat("Claude Haiku 5.5", 1_000_000, CLAUDE_EFFORTS, "fast"),
  "gpt-6-astra": chat("GPT-6 Astra", null, FULL, "flagship"),
  "gpt-6.1-sol": chat("GPT-6.1 Sol", null, FULL, "standard"),
  "gpt-6.1-terra": chat("GPT-6.1 Terra", null, FULL, "standard"),
  "gpt-6-luna": chat("GPT-6 Luna", null, FULL, "fast"),
  "grok-4.7": chat("Grok 4.7", 500_000, THREE, "flagship"),
  "grok-4.6": chat("Grok 4.6", null, THREE, "standard"),
  "gemini-3.1-pro-preview": chat("Gemini 3.1 Pro", 1_048_576, THREE, "flagship"),
  "gemini-3.8-flash": chat("Gemini 3.8 Flash", 1_048_576, THREE, "standard"),
  "gemini-3.5-flash-lite": chat("Gemini 3.5 Flash-Lite", 1_048_576, THREE, "fast"),
  "openrouter/auto": chat("OpenRouter Auto", null, [], undefined, false),
  "gpt-image-2.5-sunburst": image("GPT Image 2.5 Sunburst"),
  "gpt-image-2.5-flare": image("GPT Image 2.5 Flare"),
  "grok-imagine-image-2.0": image("Grok Imagine 2.0"),
  "gemini-nano-banana-2.1": image("Nano Banana 2.1"),
  "gemini-3-pro-image": image("Nano Banana Pro"),
});

const IMAGE_OUTPUT = /(^|[-/:_.])(image|imagine|dall-e)([-/:_.]|$)|banana|flux|stable-diffusion|sdxl/i;
const VISION = /claude|gpt-[4-9]|gemini|grok-4|llava|vision|[-_.:]vl\b|vl[-_:]|pixtral|gemma-?3|llama-?4|minicpm-v|moondream/i;
const NO_TOOLS = /embed|whisper|tts|rerank|moderation/i;

/** Metadata for a model id from a provider, exact when known and guessed otherwise. */
export function describeModel(provider: ProviderId, id: string): ModelInfo {
  const bare = provider === "openrouter" ? id.replace(/^[^/]+\//, "") : id;
  const known = KNOWN[id] ?? KNOWN[bare];
  // The Claude Code runner takes no effort setting, so its models offer none.
  if (known) return { id, provider, ...known, ...(provider === "claude-code" ? { efforts: [] } : {}) };
  const imageOutput = IMAGE_OUTPUT.test(id);
  return { id, provider, label: id, vision: imageOutput || VISION.test(id), tools: !imageOutput && !NO_TOOLS.test(id), imageOutput, context: null, efforts: [] };
}

const SKIP_OPENAI = /embedding|tts|whisper|audio|realtime|transcribe|moderation|search|davinci|babbage|dall-e-2/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function fromOpenRouter(entry: Record<string, unknown>): ModelInfo | null {
  const id = str(entry.id);
  if (!id) return null;
  const base = describeModel("openrouter", id);
  const arch = isRecord(entry.architecture) ? entry.architecture : {};
  const inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
  const outputs = Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  return {
    ...base,
    label: str(entry.name) ?? base.label,
    vision: inputs.includes("image"),
    imageOutput: outputs.includes("image"),
    tools: params.includes("tools"),
    context: typeof entry.context_length === "number" ? entry.context_length : base.context,
    efforts: params.includes("reasoning") ? THREE : base.efforts,
  };
}

function fromGemini(entry: Record<string, unknown>): ModelInfo | null {
  const id = str(entry.name)?.replace(/^models\//, "");
  const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
  if (!id || !methods.includes("generateContent")) return null;
  const base = describeModel("gemini", id);
  return { ...base, label: base.label === id ? (str(entry.displayName) ?? id) : base.label, context: typeof entry.inputTokenLimit === "number" ? entry.inputTokenLimit : base.context };
}

/** Turns a provider's `/models` reply into model metadata; anything malformed is dropped. */
export function parseModelList(provider: ProviderId, body: unknown): ModelInfo[] {
  if (!isRecord(body)) return [];
  if (provider === "gemini") {
    return (Array.isArray(body.models) ? body.models : []).filter(isRecord).map(fromGemini).filter((m): m is ModelInfo => m !== null);
  }
  const data = (Array.isArray(body.data) ? body.data : []).filter(isRecord);
  if (provider === "openrouter") return data.map(fromOpenRouter).filter((m): m is ModelInfo => m !== null);
  return data.flatMap((entry) => {
    const id = str(entry.id);
    if (!id || (provider === "openai" && (SKIP_OPENAI.test(id) || !/^(gpt-|o\d|chatgpt-)/.test(id)))) return [];
    const info = describeModel(provider, id);
    const label = str(entry.display_name);
    return [label && info.label === id ? { ...info, label } : info];
  });
}
