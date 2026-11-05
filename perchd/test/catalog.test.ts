import { expect, test } from "bun:test";
import { describeModel, parseModelList } from "../src/models/catalog";
import { checkApiKey, PROVIDERS } from "../src/models/providers";
import { PROVIDER_IDS } from "../src/models/ids";

test("every provider is described, and default models carry the capabilities their role needs", () => {
  for (const id of PROVIDER_IDS) {
    const def = PROVIDERS[id];
    expect(def.id).toBe(id);
    if (def.defaults.visual) expect(describeModel(id, def.defaults.visual).vision).toBe(true);
    if (def.defaults.image) expect(describeModel(id, def.defaults.image).imageOutput).toBe(true);
    for (const role of ["default", "fast", "standard", "deep"] as const) {
      const model = def.defaults[role];
      if (model) expect(describeModel(id, model).tools).toBe(true);
    }
  }
});

test("known models have exact metadata", () => {
  expect(describeModel("anthropic", "claude-opus-5-5")).toMatchObject({ label: "Claude Opus 5.5", vision: true, tools: true, context: 1_000_000, tier: "flagship" });
  expect(describeModel("anthropic", "claude-opus-5-5").efforts).toContain("max");
  expect(describeModel("grok", "grok-4.7")).toMatchObject({ context: 500_000, vision: true, tools: true });
  expect(describeModel("openai", "gpt-image-2.5-sunburst")).toMatchObject({ imageOutput: true, tools: false });
  // OpenRouter ids carry the vendor in front.
  expect(describeModel("openrouter", "anthropic/claude-sonnet-5-5")).toMatchObject({ label: "Claude Sonnet 5.5", vision: true, provider: "openrouter", id: "anthropic/claude-sonnet-5-5" });
});

test("unknown models get conservative guesses", () => {
  expect(describeModel("ollama", "llava:13b")).toMatchObject({ vision: true, tools: true, context: null, label: "llava:13b" });
  expect(describeModel("ollama", "qwen3:8b")).toMatchObject({ vision: false, tools: true, imageOutput: false });
  expect(describeModel("custom", "some-image-model")).toMatchObject({ imageOutput: true, tools: false });
});

test("parses each provider's model list into capabilities", () => {
  const openai = parseModelList("openai", { data: [{ id: "gpt-6-astra" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }, { id: "gpt-image-2.5-flare" }, { id: "tts-1" }] });
  expect(openai.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-image-2.5-flare"]);

  const gemini = parseModelList("gemini", {
    models: [
      { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-005", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
    ],
  });
  expect(gemini).toHaveLength(1);
  expect(gemini[0]).toMatchObject({ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", context: 1048576, vision: true });

  const router = parseModelList("openrouter", {
    data: [
      { id: "acme/vision-1", name: "Acme Vision", context_length: 64000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"] },
      { id: "acme/plain", name: "Acme Plain", context_length: 8000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: [] },
    ],
  });
  expect(router[0]).toMatchObject({ label: "Acme Vision", vision: true, tools: true, context: 64000 });
  expect(router[0]!.efforts.length).toBeGreaterThan(0);
  expect(router[1]).toMatchObject({ vision: false, tools: false });

  const anthropic = parseModelList("anthropic", { data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] });
  expect(anthropic[0]).toMatchObject({ label: "Claude Haiku 5.5", tier: "fast" });

  expect(parseModelList("ollama", { nonsense: true })).toEqual([]);
  expect(parseModelList("ollama", { data: [{ id: 5 }, { id: "llama3.3" }] }).map((m) => m.id)).toEqual(["llama3.3"]);
});

test("API keys are checked for shape without revealing them", () => {
  expect(checkApiKey("sk-test-abcdefghijklmnop")).toBe("sk-test-abcdefghijklmnop");
  expect(checkApiKey("  sk-test-abcdefghijklmnop \n")).toBe("sk-test-abcdefghijklmnop");
  expect(() => checkApiKey("short")).toThrow("too short");
  expect(() => checkApiKey("sk has spaces in the middle ok")).toThrow("spaces");
  try {
    checkApiKey("sk has spaces in the middle ok");
  } catch (error) {
    expect(String(error)).not.toContain("middle");
  }
});
