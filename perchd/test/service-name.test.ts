import { expect, test } from "bun:test";
import { ownService } from "../src/secure/service-name";

test("without a suffix every name is unchanged", () => {
  expect(ownService("Perch Data Key", {})).toBe("Perch Data Key");
});

test("a development suffix renames Perch's own items once, and nobody else's", () => {
  const env = { PERCH_KEYCHAIN_SUFFIX: " (dev)" };
  expect(ownService("Perch", env)).toBe("Perch (dev)");
  expect(ownService("Perch Data Key", env)).toBe("Perch Data Key (dev)");
  expect(ownService("com.perch.perchd", env)).toBe("com.perch.perchd (dev)");
  expect(ownService("co.xanom.perch.sync", env)).toBe("co.xanom.perch.sync (dev)");
  expect(ownService("Perch Data Key (dev)", env)).toBe("Perch Data Key (dev)");
  expect(ownService("Chrome Safe Storage", env)).toBe("Chrome Safe Storage");
  expect(ownService("Perch Safe Storage", env)).toBe("Perch Safe Storage");
});
