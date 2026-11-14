#!/usr/bin/env bun
/**
 * Signs a built-in extension's release zip (Caveatly, Backrow) for Perch's auto-updates.
 *
 *   bun scripts/sign-extension-release.ts path/to/caveatly.zip     writes caveatly.zip.sig
 *   bun scripts/sign-extension-release.ts --verify path/to/caveatly.zip
 *
 * The signature is Ed25519 over the zip's exact bytes, base64 in a one-line .sig file, attached
 * to the GitHub release next to the zip. Perch rejects any update whose signature doesn't verify
 * against EXTENSION_RELEASE_PUBLIC_KEY (also in build/bundled-extensions.json). The private key
 * is only in 1Password and is read with `op` when signing; it is never written to disk.
 */

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const EXTENSION_RELEASE_PUBLIC_KEY = "ZAhFSipRm7B6RuItyopWK2kiV8dUIZEvgVocRyaOyqk=";
const OP_ACCOUNT = "E3OXZANXQRDOBNXQMPXZ6YBHTY";
const OP_REF = "op://Private/vxfberouofv2iqtnb57c3y6ory/private_key";

function publicKey() {
  const raw = Buffer.from(EXTENSION_RELEASE_PUBLIC_KEY, "base64");
  // SPKI header for an Ed25519 key, then the 32 raw bytes.
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

export function verifies(zip: Uint8Array, signature: string): boolean {
  return verify(null, zip, publicKey(), Buffer.from(signature.trim(), "base64"));
}

async function main(args: string[]) {
  const check = args[0] === "--verify";
  const path = check ? args[1] : args[0];
  if (!path) throw new Error("usage: sign-extension-release.ts [--verify] <release.zip>");
  const zip = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (check) {
    const ok = verifies(zip, await Bun.file(`${path}.sig`).text());
    console.log(ok ? `${path}.sig verifies` : `${path}.sig does NOT verify`);
    process.exit(ok ? 0 : 1);
  }
  const op = Bun.spawnSync(["op", "--account", OP_ACCOUNT, "read", OP_REF], { stdout: "pipe", stderr: "pipe" });
  if (op.exitCode !== 0) throw new Error(`couldn't read the signing key from 1Password: ${op.stderr.toString().trim()}`);
  const signature = sign(null, zip, createPrivateKey(op.stdout.toString())).toString("base64");
  if (!verifies(zip, signature)) throw new Error("the 1Password key doesn't match Perch's public key");
  await Bun.write(`${path}.sig`, `${signature}\n`);
  console.log(`wrote ${path}.sig`);
}

if (import.meta.main) await main(process.argv.slice(2));
