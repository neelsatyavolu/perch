import { expect, test } from "bun:test";
import { toAnthropicMessages } from "../src/models/anthropic";
import { imageMediaType } from "../src/models/types";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");
const gif = Buffer.from("GIF89a....").toString("base64");
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]).toString("base64");

test("an image's type comes from its bytes, whatever its name said", () => {
  expect(imageMediaType(png)).toBe("image/png");
  expect(imageMediaType(jpeg)).toBe("image/jpeg");
  expect(imageMediaType(gif)).toBe("image/gif");
  expect(imageMediaType(webp)).toBe("image/webp");
});

test("a PNG tool result goes to Claude as a PNG", () => {
  const out = JSON.stringify(toAnthropicMessages([{ role: "tool", callId: "1", content: "logo.png (image)", image: png } as never]));
  expect(out).toContain('"media_type":"image/png"');
  expect(out).not.toContain("image/jpeg");
});
