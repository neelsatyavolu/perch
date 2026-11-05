/** The screenshot page: shows the capture, lets you mark it up with a pen or boxes, then copy or save it. */

import { takeShot } from "../shot/store";

type Point = { x: number; y: number };
type Mark = { kind: "pen"; points: Point[] } | { kind: "box"; from: Point; to: Point };
type Tool = Mark["kind"];

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const status = document.getElementById("status")!;
const buttons = {
  pen: document.getElementById("pen") as HTMLButtonElement,
  box: document.getElementById("box") as HTMLButtonElement,
  undo: document.getElementById("undo") as HTMLButtonElement,
  copy: document.getElementById("copy") as HTMLButtonElement,
  save: document.getElementById("save") as HTMLButtonElement,
};

let image: ImageBitmap | null = null;
let marks: readonly Mark[] = [];
let drawing: Mark | null = null;
let tool: Tool = "pen";
let fileName = "screenshot.png";

function markColour(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4C8DFF";
}

function redraw(): void {
  if (!image) return;
  ctx.drawImage(image, 0, 0);
  const scale = canvas.width / canvas.getBoundingClientRect().width || 1;
  ctx.strokeStyle = markColour();
  ctx.lineWidth = Math.max(3, 3 * scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const mark of drawing ? [...marks, drawing] : marks) {
    ctx.beginPath();
    if (mark.kind === "pen") {
      mark.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    } else {
      ctx.rect(mark.from.x, mark.from.y, mark.to.x - mark.from.x, mark.to.y - mark.from.y);
    }
    ctx.stroke();
  }
  buttons.undo.disabled = marks.length === 0;
}

function point(event: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return { x: ((event.clientX - rect.left) / rect.width) * canvas.width, y: ((event.clientY - rect.top) / rect.height) * canvas.height };
}

canvas.addEventListener("pointerdown", (event) => {
  if (!image) return;
  canvas.setPointerCapture(event.pointerId);
  const p = point(event);
  drawing = tool === "pen" ? { kind: "pen", points: [p] } : { kind: "box", from: p, to: p };
});
canvas.addEventListener("pointermove", (event) => {
  if (!drawing) return;
  const p = point(event);
  drawing = drawing.kind === "pen" ? { ...drawing, points: [...drawing.points, p] } : { ...drawing, to: p };
  redraw();
});
canvas.addEventListener("pointerup", () => {
  if (drawing) marks = [...marks, drawing];
  drawing = null;
  redraw();
});

function choose(next: Tool): void {
  tool = next;
  buttons.pen.setAttribute("aria-pressed", String(next === "pen"));
  buttons.box.setAttribute("aria-pressed", String(next === "box"));
}
buttons.pen.addEventListener("click", () => choose("pen"));
buttons.box.addEventListener("click", () => choose("box"));
buttons.undo.addEventListener("click", () => {
  marks = marks.slice(0, -1);
  redraw();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "z") {
    event.preventDefault();
    buttons.undo.click();
  }
});

function pngBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))), "image/png"));
}

buttons.save.addEventListener("click", async () => {
  const url = URL.createObjectURL(await pngBlob());
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  status.textContent = `Saved as ${fileName} in your downloads folder.`;
});
buttons.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob() })]);
    status.textContent = "Copied to the clipboard.";
  } catch {
    status.textContent = "The image could not be copied. Save it instead.";
  }
});

async function main(): Promise<void> {
  const id = new URLSearchParams(location.search).get("id") ?? "";
  const shot = /^[0-9a-f-]{36}$/.test(id) ? await takeShot(id) : null;
  if (!shot) {
    status.textContent = "This screenshot is no longer available. Take a new one from the page.";
    for (const b of Object.values(buttons)) b.disabled = true;
    return;
  }
  image = await createImageBitmap(shot.blob);
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.dataset.ready = "true";
  const host = (() => {
    try {
      return new URL(shot.url).hostname;
    } catch {
      return "page";
    }
  })();
  const stamp = new Date(shot.created).toISOString().slice(0, 19).replace(/[T:]/g, "-");
  fileName = `${host}-${stamp}.png`;
  document.title = `Screenshot of ${shot.title || host}`;
  document.getElementById("title")!.textContent = shot.title || host;
  document.getElementById("meta")!.textContent = `${host} · ${image.width} × ${image.height}${shot.truncated ? " · cut at the maximum image height" : ""}`;
  redraw();
}

void main();
