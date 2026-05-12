import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { Db } from "mongodb";
import { DEFAULTS } from "./runtime.js";

export interface AppConfig {
  api_token: string;
}

export interface AppConfigBootstrap {
  onFirstRun?: (token: string, path: string) => void;
  port?: number;
}

export async function loadAppConfig(
  db: Db,
  bootstrap: AppConfigBootstrap = {},
): Promise<AppConfig> {
  const col = db.collection<AppConfig & { _id: string }>("config");
  const existing = await col.findOne({ _id: "app" });
  if (existing) return existing;

  const token = `mp_${randomBytes(24).toString("base64url")}`;
  const doc = { _id: "app" as const, api_token: token };
  await col.insertOne(doc);

  await db.collection("config").insertMany(
    Object.entries(DEFAULTS)
      .filter(
        ([key]) =>
          ![
            "openai_api_key",
            "anthropic_api_key",
            "default_model",
            "openai_base_url",
            "anthropic_base_url",
            "openai_endpoint_flavor",
          ].includes(key),
      )
      .map(([key, value]) => ({
        key,
        value: key === "scope_auto_detect" ? true : value,
        encrypted: false,
        updatedAt: new Date(),
      })),
  );

  const tokenDir = process.env.TENURE_HOME ?? resolve(homedir(), ".tenure");
  const tokenPath = resolve(tokenDir, "token");
  bootstrap.onFirstRun?.(token, tokenPath);

  return doc;
}

export async function rotateApiToken(db: Db): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const token = `mp_${randomBytes(24).toString("base64url")}`;
  const col = db.collection<AppConfig & { _id: string }>("config");
  await col.updateOne(
    { _id: "app" },
    { $set: { api_token: token } },
    { upsert: true },
  );
  return token;
}

export function writeTokenAndPrintBanner(
  token: string,
  tokenPath: string,
  port: number,
): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  try {
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Token file already exists at ${tokenPath} but no matching DB config was found. ` +
          `This usually means the database was reset. Remove the file to generate a fresh token, ` +
          `or restore the DB from backup.`,
      );
    }
    throw err;
  }
  chmodSync(tokenPath, 0o600);
  printBanner(token, tokenPath, port);
}

function printBanner(token: string, tokenPath: string, port: number): void {
  console.log("");
  console.log("━".repeat(60));
  console.log("  First-run setup complete.");
  console.log("");
  console.log(`  API token: ${token}`);
  console.log(`  Saved to:  ${tokenPath}`);
  console.log("");
  console.log("  ┌─ Point your client here ───────────────────────────┐");
  console.log(`  │  Base URL:  http://localhost:${port}/v1`);
  console.log(`  │  API Key:   ${token}`);
  console.log("  └────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  Setup UI: http://localhost:${port}/onboarding?token=${token}`);
  console.log("━".repeat(60));
  console.log("");
}
