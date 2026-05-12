import anyTest, { type TestFn } from "ava";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CredentialVault } from "./encryption.js";

const test = anyTest.serial as TestFn;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "encryption-test-"));
}

function keyPath(): string {
  return join(tempDir(), "master.key");
}

test("auto-generates a master key file when none exists", (t) => {
  const path = join(tempDir(), "nested", "master.key");

  new CredentialVault(path);

  t.true(existsSync(path));
  const key = readFileSync(path);
  t.is(key.length, 32);
});

test("loads an existing master key without overwriting", (t) => {
  const path = keyPath();
  const existing = randomBytes(32);
  writeFileSync(path, existing, { mode: 0o600 });

  new CredentialVault(path);

  const loaded = readFileSync(path);
  t.deepEqual(loaded, existing);
});

test("decrypt reverses encrypt for a simple string", (t) => {
  const vault = new CredentialVault(keyPath());
  const plaintext = "sk-test-key-12345";

  const ciphertext = vault.encrypt(plaintext);
  const result = vault.decrypt(ciphertext);

  t.is(result, plaintext);
});

test("round-trips empty string", (t) => {
  const vault = new CredentialVault(keyPath());

  t.is(vault.decrypt(vault.encrypt("")), "");
});

test("round-trips unicode content", (t) => {
  const vault = new CredentialVault(keyPath());
  const plaintext = "日本語テスト 🔐 émojis & spëcial";

  t.is(vault.decrypt(vault.encrypt(plaintext)), plaintext);
});

test("round-trips long plaintext (10 KB)", (t) => {
  const vault = new CredentialVault(keyPath());
  const plaintext = "x".repeat(10_240);

  t.is(vault.decrypt(vault.encrypt(plaintext)), plaintext);
});

test("ciphertext is valid base64", (t) => {
  const vault = new CredentialVault(keyPath());
  const ct = vault.encrypt("hello");

  t.notThrows(() => Buffer.from(ct, "base64"));
  t.is(Buffer.from(ct, "base64").toString("base64"), ct);
});

test("encrypting the same plaintext twice produces different ciphertexts", (t) => {
  const vault = new CredentialVault(keyPath());
  const a = vault.encrypt("same-value");
  const b = vault.encrypt("same-value");

  t.not(a, b);
});

test("different plaintexts produce different ciphertexts", (t) => {
  const vault = new CredentialVault(keyPath());
  const a = vault.encrypt("alpha");
  const b = vault.encrypt("bravo");

  t.not(a, b);
});

test("decrypt throws on tampered ciphertext", (t) => {
  const vault = new CredentialVault(keyPath());
  const ct = vault.encrypt("secret");

  const buf = Buffer.from(ct, "base64");
  buf[buf.length - 1] ^= 0xff;
  const tampered = buf.toString("base64");

  t.throws(() => vault.decrypt(tampered));
});

test("decrypt throws on truncated ciphertext", (t) => {
  const vault = new CredentialVault(keyPath());
  const ct = vault.encrypt("secret");

  const buf = Buffer.from(ct, "base64");
  const truncated = buf.subarray(0, 10).toString("base64");

  t.throws(() => vault.decrypt(truncated));
});

test("vault with different key cannot decrypt", (t) => {
  const vault1 = new CredentialVault(keyPath());
  const vault2 = new CredentialVault(keyPath());

  const ct = vault1.encrypt("cross-key-test");

  t.throws(() => vault2.decrypt(ct));
});
