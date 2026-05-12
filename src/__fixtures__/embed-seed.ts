/**
 * embed-seed.ts
 *
 * One-time script: reads beliefs_seed.json, calls Ollama to embed each belief,
 * and writes beliefs_seed_embedded.json with an `embedding` field added.
 *
 * Run once offline, commit beliefs_seed_embedded.json, and the vector eval
 * harness never calls Ollama at test runtime.
 *
 * Usage:
 *   OLLAMA_URL=http://localhost:11434 npx tsx src/__fixtures__/embed-seed.ts
 *
 * Or with a different model:
 *   OLLAMA_EMBED_MODEL=mxbai-embed-large npx tsx src/__fixtures__/embed-seed.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ollamaEmbed,
  beliefEmbedText,
} from "../context/beliefsReaderVector.js";

const INPUT = resolve("src/__fixtures__/beliefs.seed.json");
const OUTPUT = resolve("src/__fixtures__/beliefs.seed.embedded.json");

const CONCURRENCY = 1; // Ollama handles 4 concurrent embed calls comfortably

async function chunk<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    console.log(
      `  embedded ${Math.min(i + size, items.length)} / ${items.length}`,
    );
  }
  return results;
}

async function main(): Promise<void> {
  const raw = JSON.parse(readFileSync(INPUT, "utf8")) as Record<
    string,
    unknown
  >[];
  console.log(`Embedding ${raw.length} beliefs from ${INPUT}`);
  console.log(`Model: ${process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text"}`);
  console.log(
    `Ollama: ${process.env.OLLAMA_URL ?? "http://localhost:11434"}\n`,
  );

  const embedded = await chunk(raw, CONCURRENCY, async (belief) => {
    const text = beliefEmbedText({
      canonical_name: belief.canonical_name as string,
      aliases: (belief.aliases as string[]) ?? [],
    });
    const embedding = await ollamaEmbed(text);
    return { ...belief, embedding };
  });

  writeFileSync(OUTPUT, JSON.stringify(embedded, null, 2));
  console.log(`\nWrote ${OUTPUT}`);
  console.log(
    `Dimensions: ${(embedded[0] as Record<string, unknown>).embedding ? ((embedded[0] as Record<string, unknown>).embedding as number[]).length : "unknown"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
