import { afterEach, expect, test } from "bun:test";
import { render } from "preact";
import { Markdown } from "../src/components/markdown";

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
});

function show(text: string, renderArtifact?: (id: string) => preact.VNode | null): HTMLElement {
  root = document.createElement("div");
  document.body.appendChild(root);
  render(<Markdown text={text} renderArtifact={renderArtifact} />, root);
  return root;
}

test("headings, lists, tables, quotes and code render as elements", () => {
  const el = show(["# Title", "", "Some **bold** and *soft* and `code`.", "", "- one", "- two", "", "1. first", "2. second", "", "| Plan | Cost |", "|---|---:|", "| Music | $10.99 |", "", "> quoted", "", "```ts", "const x = 1;", "```"].join("\n"));
  expect(el.querySelector("h3")!.textContent).toBe("Title");
  expect(el.querySelector("strong")!.textContent).toBe("bold");
  expect(el.querySelector("em")!.textContent).toBe("soft");
  expect(el.querySelector("p code")!.textContent).toBe("code");
  expect([...el.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["one", "two"]);
  expect([...el.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual(["first", "second"]);
  expect(el.querySelector("th")!.textContent).toBe("Plan");
  expect(el.querySelector("td:last-child")!.textContent).toBe("$10.99");
  expect(el.querySelector("blockquote")!.textContent).toBe("quoted");
  expect(el.querySelector("pre code")!.textContent).toBe("const x = 1;");
  expect(el.querySelector("figcaption .mono")!.textContent).toBe("ts");
});

test("raw HTML in a reply stays text", () => {
  const el = show('<img src=x onerror="alert(1)"><script>alert(2)</script>');
  expect(el.querySelector("img")).toBeNull();
  expect(el.querySelector("script")).toBeNull();
  expect(el.textContent).toContain("<script>");
});

test("only web and mail links become links, and they open safely", () => {
  const el = show("[ok](https://example.com) [bad](javascript:alert(1)) [mail](mailto:a@b.co) https://perch.example/x.");
  const links = [...el.querySelectorAll("a")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com", "mailto:a@b.co", "https://perch.example/x"]);
  expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
  expect(el.textContent).toContain("[bad](javascript:alert(1))");
});

test("unfinished input renders without breaking: an open fence is code, half a bold is text", () => {
  const el = show("Working on **it\n\n```py\nprint('hi')");
  expect(el.querySelector("pre code")!.textContent).toBe("print('hi')");
  expect(el.querySelector("p")!.textContent).toBe("Working on **it");
});

test("artifact markers use the page's card and streaming blocks show what is being made", () => {
  const el = show('Here.\n[[artifact:abc-123]]\n```artifact html "Budget"\n<h1>x', (id) => <span class="card-for">{id}</span>);
  expect(el.querySelector(".card-for")!.textContent).toBe("abc-123");
  expect(el.querySelector(".artifact-card.pending")!.textContent).toBe("Making Budget");
  expect(el.textContent).not.toContain("<h1>");
});
