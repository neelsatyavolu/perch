import { describe, expect, test } from "bun:test";
import { base32Decode, base32Encode } from "../../src/totp/base32";
import { totp, secondsLeft } from "../../src/totp/totp";
import { parseOtpauth } from "../../src/totp/otpauth";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("RFC 6238 test vectors (Appendix B)", () => {
  const seeds = {
    SHA1: ascii("12345678901234567890"),
    SHA256: ascii("12345678901234567890123456789012"),
    SHA512: ascii("1234567890123456789012345678901234567890123456789012345678901234"),
  } as const;
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  for (const [time, sha1, sha256, sha512] of vectors) {
    test(`T=${time}`, async () => {
      expect(await totp(seeds.SHA1, { time, digits: 8, algorithm: "SHA1" })).toBe(sha1);
      expect(await totp(seeds.SHA256, { time, digits: 8, algorithm: "SHA256" })).toBe(sha256);
      expect(await totp(seeds.SHA512, { time, digits: 8, algorithm: "SHA512" })).toBe(sha512);
    });
  }

  test("six digits are the last six of the same truncation", async () => {
    expect(await totp(seeds.SHA1, { time: 59 })).toBe("287082");
  });

  test("seconds left in the period", () => {
    expect(secondsLeft(59, 30)).toBe(1);
    expect(secondsLeft(60, 30)).toBe(30);
  });
});

describe("base32", () => {
  test("RFC 4648 vectors", () => {
    expect(base32Encode(ascii("foobar"))).toBe("MZXW6YTBOI");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI======"))).toBe("foobar");
    expect(new TextDecoder().decode(base32Decode("mzxw 6ytb oi"))).toBe("foobar");
  });

  test("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("MZXW1")).toThrow();
    expect(() => base32Decode("")).toThrow();
  });
});

describe("parseOtpauth", () => {
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

  test("reads issuer, account and parameters", () => {
    expect(parseOtpauth(`otpauth://totp/Example%20Co:alice%40example.com?secret=${secret}&issuer=Example%20Co&algorithm=SHA256&digits=8&period=60`)).toEqual({
      issuer: "Example Co",
      account: "alice@example.com",
      secret,
      algorithm: "SHA256",
      digits: 8,
      period: 60,
    });
  });

  test("defaults to SHA1, six digits and 30 seconds; issuer can come from the label", () => {
    expect(parseOtpauth(`otpauth://totp/GitHub:octo?secret=${secret.toLowerCase()}`)).toEqual({
      issuer: "GitHub",
      account: "octo",
      secret,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
  });

  test("refuses HOTP, short secrets and bad parameters with a plain reason", () => {
    expect(() => parseOtpauth(`otpauth://hotp/X:y?secret=${secret}&counter=1`)).toThrow("counter-based");
    expect(() => parseOtpauth("otpauth://totp/X:y?secret=MZXW6")).toThrow("too short");
    expect(() => parseOtpauth(`otpauth://totp/X:y?secret=${secret}&digits=4`)).toThrow("digits");
    expect(() => parseOtpauth(`otpauth://totp/X:y?secret=${secret}&algorithm=MD5`)).toThrow("algorithm");
    expect(() => parseOtpauth(`otpauth://totp/X:y?secret=${secret}&period=0`)).toThrow("period");
    expect(() => parseOtpauth("https://example.com")).toThrow("not a setup code");
  });
});
