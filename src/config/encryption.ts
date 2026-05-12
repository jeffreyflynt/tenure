import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

export class CredentialVault {
  private readonly masterKey: Buffer;

  constructor(masterKeyPath: string) {
    this.masterKey = this.loadOrCreateKey(masterKeyPath);
  }

  encrypt(plaintext: string): string {
    const salt = randomBytes(SALT_LEN);
    const iv = randomBytes(IV_LEN);
    const derived = scryptSync(this.masterKey, salt, KEY_LEN);
    const cipher = createCipheriv(ALGO, derived, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
  }

  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, "base64");
    const salt = buf.subarray(0, SALT_LEN);
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16);
    const encrypted = buf.subarray(SALT_LEN + IV_LEN + 16);
    const derived = scryptSync(this.masterKey, salt, KEY_LEN);
    const decipher = createDecipheriv(ALGO, derived, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  }

  private loadOrCreateKey(path: string): Buffer {
    if (existsSync(path)) return readFileSync(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(KEY_LEN);
    writeFileSync(path, key, { mode: 0o600 });
    chmodSync(path, 0o600);
    return key;
  }
}
