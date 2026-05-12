import type { Collection, Db } from "mongodb";
import type { Collections } from "./collections.js";

interface SearchIndexDescription {
  name: string;
  status: string;
  queryable: boolean;
  latestDefinition: Record<string, unknown>;
}

interface SearchIndexMeta {
  name: string;
  collectionName: "beliefs" | "turns";
  version: number;
  definition: Record<string, unknown>;
}

const SEARCH_INDEXES: SearchIndexMeta[] = [
  {
    name: "beliefs_search",
    collectionName: "beliefs",
    version: 1,
    definition: {
      analyzer: "lucene.standard",
      analyzers: [
        {
          name: "aliases_light",
          tokenizer: { type: "whitespace" },
          tokenFilters: [{ type: "lowercase" }, { type: "englishPossessive" }],
        },
        {
          name: "whole_name_analyzer",
          charFilters: [{ type: "mapping", mappings: { _: " " } }],
          tokenizer: {
            type: "regexCaptureGroup",
            pattern: "[^,;|]+",
            group: 0,
          },
          tokenFilters: [{ type: "lowercase" }, { type: "englishPossessive" }],
        },
        {
          name: "canonical_query_search_analyzer",
          tokenizer: { type: "whitespace" },
          tokenFilters: [
            { type: "lowercase" },
            { type: "englishPossessive" },
            {
              type: "stopword",
              tokens: [
                "a",
                "an",
                "the",
                "and",
                "or",
                "in",
                "of",
                "to",
                "for",
                "with",
                "our",
                "my",
                "we",
                "i",
                "on",
                "at",
                "by",
                "up",
                "their",
                "its",
                "is",
                "are",
                "was",
                "be",
                "that",
                "this",
                "how",
                "what",
                "does",
              ],
            },
            {
              type: "shingle",
              minShingleSize: 2,
              maxShingleSize: 2,
            },
          ],
        },
        {
          name: "alias_search_analyzer",
          tokenizer: { type: "whitespace" },
          tokenFilters: [
            { type: "lowercase" },
            { type: "englishPossessive" },
            {
              type: "shingle",
              minShingleSize: 2,
              maxShingleSize: 2,
            },
          ],
        },
      ],
      mappings: {
        dynamic: false,
        fields: {
          user_id: { type: "token" },
          canonical_name: {
            type: "string",
            analyzer: "whole_name_analyzer",
            searchAnalyzer: "lucene.standard",
            multi: {
              phrase: {
                type: "string",
                analyzer: "whole_name_analyzer",
                searchAnalyzer: "canonical_query_search_analyzer",
              },
            },
          },
          aliases: {
            type: "string",
            analyzer: "whole_name_analyzer",
            searchAnalyzer: "aliases_light",
            multi: {
              shingle: {
                type: "string",
                analyzer: "whole_name_analyzer",
                searchAnalyzer: "alias_search_analyzer",
              },
            },
          },
          content: { type: "string", analyzer: "lucene.english" },
          superseded_by: { type: "token" },
          resolved_at: { type: "date" },
          type: { type: "token" },
          scope: { type: "token" },
          reinforcement_count: { type: "number" },
          confidence: { type: "number" },
          subtype: { type: "token" },
        },
      },
    },
  },
  {
    name: "turns_search",
    collectionName: "turns",
    version: 1,
    definition: {
      analyzer: "lucene.standard",
      mappings: {
        dynamic: false,
        fields: {
          userId: { type: "token" },
          scope: { type: "token" },
          sessionId: { type: "token" },
          userMessage: { type: "string", analyzer: "lucene.standard" },
          assistantMessage: { type: "string", analyzer: "lucene.standard" },
        },
      },
    },
  },
];

export async function ensureIndexes(cols: Collections): Promise<void> {
  await cols.turns.createIndexes([
    { key: { sessionId: 1, turnIndex: 1 }, unique: true },
    { key: { userId: 1, createdAt: -1 } },
    { key: { userId: 1, scope: 1, createdAt: -1 } },
  ]);

  await cols.sessions.createIndexes([{ key: { userId: 1, lastUsedAt: -1 } }]);

  await cols.beliefs.createIndexes([
    {
      key: { user_id: 1, canonical_name: 1 },
      name: "user_canonical_unique_active",
      unique: true,
      partialFilterExpression: {
        superseded_by: null,
        resolved_at: null,
      },
    },
    { key: { user_id: 1, scope: 1, superseded_by: 1 } },
    {
      key: { user_id: 1, aliases: 1 },
      partialFilterExpression: { superseded_by: null },
    },
    { key: { user_id: 1, pinned: 1 } },
    {
      key: { user_id: 1, last_reinforced_at: -1 },
      partialFilterExpression: { superseded_by: null },
    },
  ]);

  await cols.jobs.createIndexes([
    {
      key: { status: 1, run_after: 1 },
      partialFilterExpression: { status: "pending" },
    },
    { key: { turn_id: 1, status: 1 } },
    {
      key: { completed_at: 1 },
      expireAfterSeconds: 60 * 60 * 24 * 7,
    },
    { key: { user_id: 1, created_at: -1 } },
  ]);

  await cols.errors.createIndexes([
    { key: { occurred_at: 1 }, expireAfterSeconds: 60 * 60 * 24 * 30 },
    { key: { severity: 1, occurred_at: -1 } },
    { key: { resolved: 1, occurred_at: -1 } },
  ]);

  await cols.topic_index.createIndexes([
    { key: { user_id: 1, topic: 1 }, unique: true },
    { key: { user_id: 1, updated_at: -1 } },
  ]);

  await cols.config.createIndexes([{ key: { key: 1 }, unique: true }]);

  await cols.persona_cache.createIndexes([
    { key: { generated_at: -1 } },
    { key: { beliefs_hash: 1 } },
  ]);

  await cols.compaction_log.createIndex(
    { user_id: 1, scope: 1, ran_at: -1 },
    { name: "compaction_log_cooldown" },
  );
}

export async function ensureSearchIndexes(db: Db): Promise<void> {
  const meta = db.collection("_search_index_meta");

  for (const idx of SEARCH_INDEXES) {
    const existing = await meta.findOne({ name: idx.name });
    const collection = db.collection(idx.collectionName);

    if (existing && existing.version === idx.version) {
      try {
        const currentIndexes = (await collection
          .listSearchIndexes()
          .toArray()) as SearchIndexDescription[];
        const found = currentIndexes.find((i) => i.name === idx.name);
        if (found && found.status === "READY") {
          continue;
        }
      } catch {
        // Fall through to recreation
      }
    }

    try {
      const currentIndexes = (await collection
        .listSearchIndexes()
        .toArray()) as SearchIndexDescription[];
      const found = currentIndexes.find((i) => i.name === idx.name);
      if (found) {
        console.log(
          `Dropping outdated search index: ${idx.name} (v${existing?.version ?? "?"})`,
        );
        await collection.dropSearchIndex(idx.name);
        await waitForIndexDrop(collection, idx.name);
      }
    } catch {
      console.log(`No existing index to drop: ${idx.name}`);
    }

    console.log(`Creating search index: ${idx.name} (v${idx.version})`);
    await collection.createSearchIndex({
      name: idx.name,
      definition: idx.definition,
    });

    await waitForIndexReady(collection, idx.name);

    await meta.updateOne(
      { name: idx.name },
      { $set: { name: idx.name, version: idx.version, updatedAt: new Date() } },
      { upsert: true },
    );

    console.log(`Search index ${idx.name} v${idx.version} is ready`);
  }
}

async function waitForIndexDrop(
  collection: Collection,
  name: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const indexes = (await collection
      .listSearchIndexes()
      .toArray()) as SearchIndexDescription[];
    if (!indexes.find((i) => i.name === name)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for search index ${name} to drop`);
}

async function waitForIndexReady(
  collection: Collection,
  name: string,
  timeoutMs = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const indexes = (await collection
      .listSearchIndexes()
      .toArray()) as SearchIndexDescription[];
    const idx = indexes.find((i) => i.name === name);
    if (idx && idx.status === "READY") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for search index ${name} to become ready`);
}
