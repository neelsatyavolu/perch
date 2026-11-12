/** The browser tools, identical for every model, and a small validator for their arguments. */

import { APP_TOOLS } from "../apps/index";
import type { ToolSpec } from "../models/types";
import { FILL_TOOL_SPECS } from "./fill-tools";

type Prop = { type: "string" | "number" | "boolean" | "array"; description?: string; items?: { type: "string" } | { type: "object"; properties: Record<string, unknown>; required?: string[] } };

function spec(name: string, description: string, properties: Record<string, Prop>, required: string[] = []): ToolSpec {
  return { name, description, parameters: { type: "object", properties, required, additionalProperties: false } };
}

const ref: Prop = { type: "string", description: "Element ref from the snapshot, like e12" };
/** What a script-like step is for, shown to the user in the chat's step list. */
const title: Prop = { type: "string", description: "A few words saying what this step is for, shown to the user, e.g. \"Read each pen's reviews\"" };

export const TOOL_SPECS: ToolSpec[] = [
  spec("navigate", "Open a URL in the current agent tab. Returns the page snapshot.", { url: { type: "string" } }, ["url"]),
  spec("snapshot", "Read the page as text. Interactive elements have refs like e12. Set full to include content far from the viewport.", { full: { type: "boolean" } }),
  spec("click", "Click an element by ref.", { ref }, ["ref"]),
  spec("type", "Replace the text in a field by ref, typing key by key. Also sets dates, colours and sliders. Set submit to press Enter after.", { ref, text: { type: "string" }, submit: { type: "boolean" } }, ["ref", "text"]),
  spec("select", "Choose a dropdown option by its label or value.", { ref, value: { type: "string" } }, ["ref", "value"]),
  spec("press", "Press a key in the focused element, such as Enter, Escape, Tab or Meta+A.", { key: { type: "string" } }, ["key"]),
  spec("scroll", "Scroll by pixels (positive is down), or bring a ref into view.", { dy: { type: "number" }, ref }),
  spec("drag", "Drag an element by ref onto another element (to), or by dx, dy pixels. For sliders, sortable lists, maps and drop zones.", { ref, to: { type: "string", description: "Ref of the element to drop on" }, dx: { type: "number" }, dy: { type: "number" } }, ["ref"]),
  spec("hover", "Move the mouse over an element by ref, for menus and tooltips.", { ref }, ["ref"]),
  spec("upload", "Attach local files to a file input by ref.", { ref, paths: { type: "array", items: { type: "string" } } }, ["ref", "paths"]),
  spec("write_file", "Save a text file in this chat's own folder, for example to upload it to a form. Returns its path.", { name: { type: "string" }, content: { type: "string" } }, ["name", "content"]),
  spec("wait_for", "Wait until text appears on the page, or wait a number of seconds and return the page.", { text: { type: "string" }, timeout_s: { type: "number" }, seconds: { type: "number" } }),
  spec("back", "Go back one page in the current tab.", {}),
  spec("screenshot", "See the visible page as an image. Use when the snapshot cannot describe it, as on canvas, maps and charts.", {}),
  spec("click_at", "Click at x, y in the last screenshot's pixels.", { x: { type: "number" }, y: { type: "number" } }, ["x", "y"]),
  spec("repl", "Run JavaScript in the page and return the result as JSON. Use return in multi-line code. Secret fields cannot be read.", { code: { type: "string" }, title }, ["code"]),
  spec("type_text", "Type text at the keyboard focus, without a ref: for editors drawn on canvas such as Google Sheets and Docs. Click the cell or spot first; press Enter or Tab after to move on.", { text: { type: "string" } }, ["text"]),
  spec("save_pdf", "Save the current page as a PDF in the user's Downloads folder. Returns its path.", { name: { type: "string", description: "File name, without .pdf" } }),
  spec("downloads", "List files downloaded in the last hour (newest first), with their paths, so a download can be found or uploaded.", {}),
  spec(
    "batch",
    "Run actions you already know in a row (fill a form: type, type, select, click). Each is approved as usual; stops at the first that fails or needs a change of plan. Returns the page after the last.",
    { actions: { type: "array", description: "Up to 10 of: click, type, select, press, scroll, hover, drag, type_text, wait_for", items: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name"] } }, title },
    ["actions"],
  ),
  spec(
    "script",
    "Run JavaScript that calls browser tools in a row, with loops and checks, to save turns: search several queries and read each, open results and pull their prices. Each action is approved as usual.",
    {
      code: {
        type: "string",
        description:
          "Body of an async function; use await, and return or log() only what you need. Functions: navigate(url), snapshot({full}), click(ref), type(ref, text, {submit}), select(ref, value), press(key), scroll(dy), hover(ref), wait_for({text, seconds}), back(), tabs(), open_tab(url), switch_tab(id), js(code) (runs code in the page, returns its JSON result), sleep(s), log(...). Each returns what the tool of that name returns; a failed call throws. No network, fetch or DOM here: use js() for the page.",
      },
      title,
    },
    ["code"],
  ),
  spec("tabs", "List open tabs with their ids. The current agent tab is marked with *.", {}),
  spec("open_tab", "Open a URL in a new agent tab and make it current.", { url: { type: "string" } }, ["url"]),
  spec("switch_tab", "Make another tab current, by id from tabs.", { id: { type: "string" } }, ["id"]),
  spec("done", "Finish the task with a short answer for the user.", { answer: { type: "string" } }, ["answer"]),
  ...FILL_TOOL_SPECS,
];

const BY_NAME = new Map([...TOOL_SPECS, ...APP_TOOLS.map((t) => t.spec)].map((s) => [s.name, s]));

/** Short notes on arguments whose meaning is not obvious from the name, for argument errors. */
const HINTS: Record<string, string> = { "scroll.dy": "pixels, negative is up" };

/** "scroll takes dy (pixels, negative is up), ref": so a model that guessed wrong can fix the call. */
function takes(name: string, schema: { properties: Record<string, Prop> }): string {
  const keys = Object.keys(schema.properties).map((k) => (HINTS[`${name}.${k}`] ? `${k} (${HINTS[`${name}.${k}`]})` : k));
  return keys.length ? `; ${name} takes ${keys.join(", ")}` : `; ${name} takes no arguments`;
}

/** Returns a plain error for the model, or null when the arguments fit the tool's schema. */
export function validate(name: string, args: Record<string, unknown>): string | null {
  const tool = BY_NAME.get(name);
  if (!tool) return `unknown tool "${name}"`;
  if ("__unparsed" in args) return `the arguments for "${name}" were not valid JSON`;
  const schema = tool.parameters as { properties: Record<string, Prop>; required: string[] };
  for (const key of schema.required) if (args[key] === undefined || args[key] === null) return `missing argument "${key}"${takes(name, schema)}`;
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) return `unexpected argument "${key}"${takes(name, schema)}`;
    if (value === undefined || value === null) continue;
    const ok =
      prop.type === "array"
        ? Array.isArray(value) && value.every((v) => (prop.items?.type === "object" ? typeof v === "object" && v !== null && !Array.isArray(v) : typeof v === "string"))
        : typeof value === prop.type && !(prop.type === "number" && !Number.isFinite(value));
    if (!ok) return `argument "${key}" must be ${prop.type === "array" ? (prop.items?.type === "object" ? "a list of objects" : "a list of strings") : `a ${prop.type}`}`;
  }
  return null;
}
