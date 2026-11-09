/** Keeps only reading markup from an extracted article: no scripts, handlers, frames, forms or styles. */

const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
  "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p",
  "picture", "pre", "q", "s", "samp", "section", "small", "source", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
]);
const DROP_WITH_CONTENT = new Set(["script", "style", "noscript", "template", "iframe", "frame", "object", "embed", "form", "input", "button", "select", "textarea", "link", "meta", "base", "svg", "math", "canvas", "audio", "video"]);
const ALLOWED_ATTRS = new Set(["href", "src", "srcset", "alt", "title", "colspan", "rowspan", "datetime", "width", "height", "media", "type", "sizes"]);
const URL_ATTRS = new Set(["href", "src"]);

export function sanitizeArticle(html: string, baseUrl: string): HTMLElement {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const container = document.createElement("div");
  container.className = "content";
  for (const child of [...parsed.body.childNodes]) {
    const clean = cleanNode(child, baseUrl);
    if (clean) container.append(clean);
  }
  return container;
}

function cleanNode(node: Node, baseUrl: string): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const source = node as Element;
  const tag = source.localName;
  if (DROP_WITH_CONTENT.has(tag)) return null;
  const children = [...source.childNodes].map((c) => cleanNode(c, baseUrl)).filter((c): c is Node => c !== null);
  if (!ALLOWED_TAGS.has(tag)) {
    const fragment = document.createDocumentFragment();
    fragment.append(...children);
    return fragment;
  }
  const out = document.createElement(tag);
  for (const attr of source.attributes) {
    if (!ALLOWED_ATTRS.has(attr.name)) continue;
    if (URL_ATTRS.has(attr.name)) {
      const url = safeUrl(attr.value, baseUrl);
      if (url) out.setAttribute(attr.name, url);
    } else if (attr.name === "srcset") {
      if (!/javascript:|data:/i.test(attr.value)) out.setAttribute(attr.name, attr.value);
    } else out.setAttribute(attr.name, attr.value);
  }
  if (tag === "a") out.setAttribute("rel", "noopener noreferrer");
  if (tag === "img") {
    out.setAttribute("loading", "lazy");
    out.setAttribute("referrerpolicy", "no-referrer");
  }
  out.append(...children);
  return out;
}

function safeUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}
