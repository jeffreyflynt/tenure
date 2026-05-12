import { MongoClient } from "mongodb";
import { loadBootstrapConfig } from "../src/config/bootstrap.js";
import {
  initBeliefEncryption,
  buildAutoEncryptionOptions,
  loadOrCreateLocalMasterKey,
} from "../src/config/beliefEncryption.js";
import { getBeliefMasterKeyPath } from "../src/config/beliefEncryptionMasterKey.js";
import type { Belief } from "../src/types/belief.js";
import process from "node:process";

/**
 * One-time migration: reads all beliefs and re-writes them through
 * the encrypted client so content and why_it_matters become encrypted.
 *
 * Safe to run multiple times. Already-encrypted documents (Binary type
 * on the content field) are skipped.
 *
 * Usage: npx tsx src/scripts/migrate-encrypt-beliefs.ts
 */
async function main() {
  const config = loadBootstrapConfig();
  const beliefKeyPath = getBeliefMasterKeyPath();
  const beliefMasterKey = loadOrCreateLocalMasterKey(beliefKeyPath);

  // Plain client for reading unencrypted docs
  const plainClient = new MongoClient(config.mongodb_uri);
  await plainClient.connect();

  const { dataKeyId } = await initBeliefEncryption({
    masterKey: beliefMasterKey,
    mongoClient: plainClient,
    db: plainClient.db(config.mongodb_db),
  });

  const autoEncryption = buildAutoEncryptionOptions(beliefMasterKey, dataKeyId);
  const encryptedClient = new MongoClient(config.mongodb_uri, {
    autoEncryption,
  });
  await encryptedClient.connect();

  const plainDb = plainClient.db(config.mongodb_db);
  const plainBeliefs = plainDb.collection<Belief>("beliefs");
  const encryptedBeliefs = encryptedClient
    .db(config.mongodb_db)
    .collection<Belief>("beliefs");

  const cursor = plainBeliefs.find({
    content: { $type: "string" },
  });

  let migrated = 0;
  let skipped = 0;

  for await (const doc of cursor) {
    if (typeof doc.content !== "string") {
      skipped++;
      continue;
    }

    await plainBeliefs.deleteOne({ _id: doc._id });
    await encryptedBeliefs.insertOne(doc);
    migrated++;

    if (migrated % 100 === 0) {
      console.log(`  Migrated ${migrated} beliefs...`);
    }
  }

  console.log(`Migration complete. Migrated: ${migrated}, Skipped: ${skipped}`);

  await plainClient.close();
  await encryptedClient.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
