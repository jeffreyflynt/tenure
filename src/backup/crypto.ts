import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export function encryptArchive(data: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, encrypted]);
}

export function decryptArchive(archive: Buffer, passphrase: string): Buffer {
  if (archive.length < SALT_LEN + IV_LEN + 16) {
    throw new Error("Archive too short to contain valid encrypted data");
  }

  const salt = archive.subarray(0, SALT_LEN);
  const iv = archive.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = archive.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16);
  const encrypted = archive.subarray(SALT_LEN + IV_LEN + 16);

  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error(
      "Decryption failed. Wrong passphrase or corrupted archive.",
    );
  }
}
