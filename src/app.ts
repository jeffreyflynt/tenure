import { Db, MongoClient } from "mongodb";
import { getCollections } from "./db/collections.js";
import { ensureIndexes, ensureSearchIndexes } from "./db/indexes.js";
import { SessionManager } from "./session/manager.js";
import { HistoryManager } from "./history/manager.js";
import { BeliefsReader } from "./context/beliefsReader.js";
import { ContextBuilder } from "./context/contextBuilder.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { ProviderRegistry } from "./providers/registry.js";
import { buildServer } from "./server.js";
import type { BootstrapConfig } from "./config/bootstrap.js";
import { loadAppConfig, writeTokenAndPrintBanner } from "./config/appConfig.js";
import { CredentialVault } from "./config/encryption.js";
import { RuntimeConfigStore } from "./config/runtime.js";
import { OpenAIAdapter } from "./providers/openai.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { ErrorLogger } from "./errors/logger.js";
import { PersonaCache } from "./context/personaCache.js";
import { BeliefCompactionRunner } from "./jobs/compactionRunner.js";
import { ExtractionWorker } from "./extraction/worker.js";
import { PersonaSummaryService } from "./context/personaSummary.js";
import {
  buildAutoEncryptionOptions,
  loadOrCreateLocalMasterKey,
} from "./config/beliefEncryption.js";
import { getBeliefMasterKeyPath } from "./config/beliefEncryptionMasterKey.js";
import { initBeliefEncryption } from "./config/beliefEncryption.js";
import { randomBytes } from "node:crypto";

async function verifyEncryptionActive(
  db: Db,
  mongoUri: string,
  mongoDbName: string,
): Promise<void> {
  const testCol = db.collection("beliefs");
  const testId = randomBytes(8).toString("hex"); // string id, not ObjectId
  const testContent = `encryption-verify-${randomBytes(8).toString("hex")}`;

  try {
    await testCol.insertOne({
      _id: testId as unknown as any,
      content: testContent,
      user_id: "__encryption_verify__",
      canonical_name: `__verify__${testId}`,
      created_at: new Date(),
    });

    const decrypted = await testCol.findOne({ _id: testId as unknown as any });
    if (decrypted?.content !== testContent) {
      throw new Error("Encrypted read did not return expected plaintext");
    }

    const rawClient = new MongoClient(mongoUri);
    await rawClient.connect();
    try {
      const rawDoc = await rawClient
        .db(mongoDbName)
        .collection("__encryption_check")
        .findOne({ _id: testId as unknown as any });

      if (rawDoc?.content === testContent) {
        throw new Error("CSFLE MISCONFIGURED: content stored as plaintext...");
      }
      if (typeof rawDoc?.content === "string") {
        throw new Error(
          "CSFLE MISCONFIGURED: content is a string, not Binary...",
        );
      }
    } finally {
      await rawClient.close();
    }
  } finally {
    await testCol.deleteOne({ _id: testId as unknown as any }).catch(() => {});
  }
}

export async function buildApp(config: BootstrapConfig) {
  const beliefKeyPath = getBeliefMasterKeyPath();
  const beliefMasterKey = loadOrCreateLocalMasterKey(beliefKeyPath);

  console.log("Initializing belief encryption key...");
  const bootstrapClient = new MongoClient(config.mongodb_uri);
  await bootstrapClient.connect();

  const { dataKeyId } = await initBeliefEncryption({
    masterKey: beliefMasterKey,
    mongoClient: bootstrapClient,
    db: bootstrapClient.db(config.mongodb_db),
  });

  await bootstrapClient.close();

  console.log("Connecting to MongoDB...");
  const autoEncryption = buildAutoEncryptionOptions(beliefMasterKey, dataKeyId);

  const client = new MongoClient(config.mongodb_uri, {
    autoEncryption,
  });
  await client.connect();
  console.log("MongoDB connected (CSFLE enabled)");

  const db = client.db(config.mongodb_db);

  console.log("Verifying CSFLE is active...");
  await verifyEncryptionActive(db, config.mongodb_uri, config.mongodb_db);
  console.log("CSFLE verified — belief content is encrypted at rest");

  const cols = getCollections(db);
  await ensureIndexes(cols);
  await ensureSearchIndexes(db);

  console.log("Loading app config...");
  const appConfig = await loadAppConfig(db, {
    onFirstRun: (token, path) =>
      writeTokenAndPrintBanner(token, path, config.port),
  });
  console.log("App config loaded");

  const sessions = new SessionManager(db);
  const history = new HistoryManager(db);
  const beliefs = new BeliefsReader(cols.beliefs);
  const persona = new PersonaCache(cols.persona_cache);
  const context = new ContextBuilder(beliefs, persona);
  const jobs = new ExtractionJobQueue(db);
  const vault = new CredentialVault(config.master_key_path);
  const runtimeStore = new RuntimeConfigStore(cols, vault);
  const runtimeConfig = await runtimeStore.load();
  const errorLogger = new ErrorLogger(cols);

  const providers = new ProviderRegistry();
  if (runtimeConfig.openai_api_key) {
    providers.register(
      new OpenAIAdapter(
        runtimeConfig.openai_api_key,
        runtimeConfig.openai_base_url ?? undefined,
        runtimeConfig.openai_endpoint_flavor,
      ),
    );
  }
  if (runtimeConfig.anthropic_api_key) {
    providers.register(new AnthropicAdapter(runtimeConfig.anthropic_api_key));
  }

  const resolveAdapter = () => {
    if (providers.listRegistered().includes("anthropic"))
      return providers.resolve("anthropic");
    if (providers.listRegistered().includes("openai"))
      return providers.resolve("openai");
    throw new Error("No provider configured, add credentials in the UI");
  };

  const personaSummary = new PersonaSummaryService({
    beliefs: cols.beliefs,
    cache: persona,
    adapter: resolveAdapter,
    modelId: runtimeConfig.default_model ?? "",
  });

  const compactionRunner = new BeliefCompactionRunner(
    cols.beliefs,
    cols.compaction_log,
    resolveAdapter,
    runtimeConfig.default_model,
    persona,
    personaSummary,
  );

  const extractionWorker = new ExtractionWorker({
    db,
    beliefs: cols.beliefs,
    personaSummary,
  });

  const server = await buildServer({
    db,
    cols,
    sessions,
    history,
    context,
    providers,
    jobs,
    runtimeStore,
    errorLogger,
    persona,
    apiToken: appConfig.api_token,
    userId: config.user_id,
    compactionRunner,
    extractionWorker,
    personaSummary,
  });

  return {
    server,
    async close() {
      await server.close();
      await client.close();
    },
  };
}
