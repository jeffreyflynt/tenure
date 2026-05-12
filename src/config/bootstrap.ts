import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";

export interface BootstrapConfig {
  mongodb_uri: string;
  mongodb_db: string;
  port: number;
  user_id: string;
  master_key_path: string;
}

const CONFIG_PATH = resolve(homedir(), ".tenure/config.toml");

const DEFAULT: BootstrapConfig = {
  mongodb_uri: "mongodb://mongo:27017/?directConnection=true",
  mongodb_db: "tenure",
  port: 5757,
  user_id: "local",
  master_key_path: resolve(homedir(), ".tenure/master.key"),
};

const CONFIG_TOML = (c: BootstrapConfig) => `mongodb_uri = "${c.mongodb_uri}"
mongodb_db = "${c.mongodb_db}"
port = ${c.port}
user_id = "${c.user_id}"
master_key_path = "${c.master_key_path}"
`;

function validateConfig(raw: Record<string, unknown>): BootstrapConfig {
  const merged = { ...DEFAULT, ...raw };

  if (typeof merged.mongodb_uri !== "string")
    throw new Error("config: mongodb_uri must be a string");
  if (typeof merged.mongodb_db !== "string")
    throw new Error("config: mongodb_db must be a string");
  if (typeof merged.port !== "number")
    throw new Error("config: port must be a number");
  if (typeof merged.user_id !== "string")
    throw new Error("config: user_id must be a string");
  if (typeof merged.master_key_path !== "string")
    throw new Error("config: master_key_path must be a string");

  return merged as BootstrapConfig;
}

export function loadBootstrapConfig(path = CONFIG_PATH): BootstrapConfig {
  let config: BootstrapConfig;

  if (!existsSync(path)) {
    console.log(`No config found at ${path}, generating defaults...`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, CONFIG_TOML(DEFAULT));
    config = DEFAULT;
  } else {
    const raw = parseToml(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    config = validateConfig(raw);
  }

  const envPort = process.env.TENURE_PORT ?? process.env.PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) config.port = parsed;
  }

  const envMongoUri = process.env.MONGODB_URI;
  if (envMongoUri) {
    config.mongodb_uri = envMongoUri;
  }

  return config;
}
