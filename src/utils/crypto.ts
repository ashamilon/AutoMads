import crypto from "node:crypto";
import { config } from "../config/index.js";

const ALGO = "aes-256-gcm";

export function encryptJson(obj: unknown): string {
  const key = config.encryptionKey;
  if (!key || key.length < 32) {
    return JSON.stringify(obj);
  }
  const keyBuf = Buffer.from(key.slice(0, 64), "hex").subarray(0, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBuf, iv);
  const plain = JSON.stringify(obj);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptJson<T>(stored: string): T {
  const key = config.encryptionKey;
  if (!key || key.length < 32) {
    return JSON.parse(stored) as T;
  }
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const keyBuf = Buffer.from(key.slice(0, 64), "hex").subarray(0, 32);
  const decipher = crypto.createDecipheriv(ALGO, keyBuf, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  return JSON.parse(dec) as T;
}
