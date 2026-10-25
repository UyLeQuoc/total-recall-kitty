import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM for users' delegate private keys at rest. Output: base64(iv).base64(tag).base64(ct) */
export function encryptSecret(plaintextHex: string, kekHex: string): string {
  const key = Buffer.from(kekHex, "hex");
  if (key.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintextHex, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload: string, kekHex: string): string {
  const key = Buffer.from(kekHex, "hex");
  const [ivB64, tagB64, ctB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString(
    "utf8",
  );
}
