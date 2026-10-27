import { createHash, randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "rk_live_";
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Issues `rk_live_<32 chars>`. Only the hash is stored; the key is shown to the user once. */
export function generateApiKey(prefix = API_KEY_PREFIX): { key: string; hash: string; displayPrefix: string } {
  const bytes = randomBytes(32);
  let body = "";
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length];
  const key = `${prefix}${body}`;
  return { key, hash: hashApiKey(key), displayPrefix: key.slice(0, prefix.length + 4) };
}

/** Extracts the key from "Authorization: Bearer rk_live_..." */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}
