import anyTest, { type TestFn } from "ava";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBootstrapConfig } from "./bootstrap.js";

const test = anyTest.serial as TestFn;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bootstrap-test-"));
}

test("creates config file with defaults when path does not exist", (t) => {
  const dir = tempDir();
  const path = join(dir, "subdir", "config.toml");

  const cfg = loadBootstrapConfig(path);

  t.true(existsSync(path));
  t.is(cfg.mongodb_uri, "mongodb://mongo:27017/?directConnection=true");
  t.is(cfg.mongodb_db, "tenure");
  t.is(cfg.port, 5757);
  t.is(cfg.user_id, "local");
});

test("created file is valid TOML that round-trips", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");

  loadBootstrapConfig(path);
  const second = loadBootstrapConfig(path);

  t.is(second.mongodb_uri, "mongodb://mongo:27017/?directConnection=true");
  t.is(second.mongodb_db, "tenure");
  t.is(second.port, 5757);
  t.is(second.user_id, "local");
});

test("reads all fields from an existing TOML file", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  const toml = `
mongodb_uri = "mongodb://custom:27017"
mongodb_db = "custom_db"
port = 9090
user_id = "alice"
master_key_path = "/tmp/key"
`;
  writeFileSync(path, toml);

  const cfg = loadBootstrapConfig(path);

  t.is(cfg.mongodb_uri, "mongodb://custom:27017");
  t.is(cfg.mongodb_db, "custom_db");
  t.is(cfg.port, 9090);
  t.is(cfg.user_id, "alice");
  t.is(cfg.master_key_path, "/tmp/key");
});

test("merges partial config with defaults", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `port = 3000\n`);

  const cfg = loadBootstrapConfig(path);

  t.is(cfg.port, 3000);
  t.is(cfg.mongodb_uri, "mongodb://mongo:27017/?directConnection=true");
  t.is(cfg.mongodb_db, "tenure");
  t.is(cfg.user_id, "local");
});

test("throws when mongodb_uri is not a string", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `mongodb_uri = 42\n`);

  t.throws(() => loadBootstrapConfig(path), {
    message: /mongodb_uri must be a string/,
  });
});

test("throws when mongodb_db is not a string", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `mongodb_db = true\n`);

  t.throws(() => loadBootstrapConfig(path), {
    message: /mongodb_db must be a string/,
  });
});

test("throws when port is not a number", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `port = "not-a-number"\n`);

  t.throws(() => loadBootstrapConfig(path), {
    message: /port must be a number/,
  });
});

test("throws when user_id is not a string", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `user_id = 123\n`);

  t.throws(() => loadBootstrapConfig(path), {
    message: /user_id must be a string/,
  });
});

test("throws when master_key_path is not a string", (t) => {
  const dir = tempDir();
  const path = join(dir, "config.toml");
  writeFileSync(path, `master_key_path = false\n`);

  t.throws(() => loadBootstrapConfig(path), {
    message: /master_key_path must be a string/,
  });
});
