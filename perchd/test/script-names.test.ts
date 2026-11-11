import { expect, test } from "bun:test";
import { declaredNames } from "../src/agent/script-names";

test("top-level declarations are found; nested ones, strings and comments are not", () => {
  expect(declaredNames(`const a = 1; let b = f(1, 2), c = [3, 4]\nvar d`)).toEqual(["a", "b", "c", "d"]);
  expect(declaredNames(`const { x, y: z, ...rest } = o; const [p, [q], r = 2] = arr;`)).toEqual(["x", "z", "rest", "p", "q", "r"]);
  expect(declaredNames(`async function go() { const inner = 1 }\nclass Tab {}\nfunction* gen() {}`)).toEqual(["go", "Tab", "gen"]);
  expect(declaredNames(`for (const i of xs) { let t = i }\nif (ok) { const hidden = 2 }`)).toEqual([]);
  expect(declaredNames(`log("const fake = 1"); // let alsoFake = 2\n/* var no */ const s1 = \`\${"const n = 3"}\`;`)).toEqual(["s1"]);
  expect(declaredNames(`const page1 = await openTab(\n  "https://x.test"\n);\nconst s2 = await snapshot(page1)`)).toEqual(["page1", "s2"]);
  expect(declaredNames(`const f = (a, b) => a + b, g = 2`)).toEqual(["f", "g"]);
});
