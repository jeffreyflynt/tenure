import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";
import { MongoClient, ClientEncryption, type Db, Binary } from "mongodb";

const KEY_VAULT_NAMESPACE = "tenure.__keyVault";
const KEY_ALT_NAME = "belief-content-key";

export interface BeliefEncryptionConfig {
  masterKey: Buffer;
  mongoClient: MongoClient;
  db: Db;
}

export interface BeliefEncryptionContext {
  clientEncryption: ClientEncryption;
  dataKeyId: Binary;
}

/**
 * Loads or creates a 96-byte local master key used by MongoDB CSFLE
 * to wrap/unwrap the data encryption keys (DEKs).
 *
 * Called once in app.ts and passed through — not re-read per call site.
 */
export function loadOrCreateLocalMasterKey(path: string): Buffer {
  if (existsSync(path)) {
    return readFileSync(path);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(96);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/**
 * Ensures the key vault collection exists with a unique index on keyAltNames,
 * then creates or retrieves the data encryption key (DEK) for belief content.
 */
export async function initBeliefEncryption(
  config: BeliefEncryptionConfig,
): Promise<BeliefEncryptionContext> {
  const kmsProviders = {
    local: { key: config.masterKey },
  };

  const keyVaultDb = config.db.client.db("tenure");
  const keyVaultCol = keyVaultDb.collection("__keyVault");
  await keyVaultCol.createIndex(
    { keyAltNames: 1 },
    {
      unique: true,
      partialFilterExpression: { keyAltNames: { $exists: true } },
    },
  );

  const clientEncryption = new ClientEncryption(config.mongoClient, {
    keyVaultNamespace: KEY_VAULT_NAMESPACE,
    kmsProviders,
  });

  let dataKeyId: Binary;
  const existingKey = await keyVaultCol.findOne({
    keyAltNames: KEY_ALT_NAME,
  });

  if (existingKey) {
    try {
      const testVal = await clientEncryption.encrypt("probe", {
        keyAltName: KEY_ALT_NAME,
        algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Random",
      });
      await clientEncryption.decrypt(testVal);
      dataKeyId = existingKey._id as unknown as Binary;
    } catch {
      throw new Error("Belief encryption key mismatch...");
    }
  } else {
    dataKeyId = await clientEncryption.createDataKey("local", {
      keyAltNames: [KEY_ALT_NAME],
    });
  }

  return { clientEncryption, dataKeyId };
}

/**
 * Builds the autoEncryption options for the MongoClient constructor.
 * Accepts the already-loaded master key so the file is only read once.
 *
 * Encrypts content, why_it_matters, and source_exchanges using the
 * Random algorithm — none of these fields are queried directly.
 */
export function buildAutoEncryptionOptions(
  masterKey: Buffer,
  dataKeyId: Binary,
) {
  const kmsProviders = {
    local: { key: masterKey },
  };

  const schemaMap = {
    "tenure.beliefs": {
      bsonType: "object",
      encryptMetadata: {
        keyId: [dataKeyId],
      },
      properties: {
        content: {
          encrypt: {
            bsonType: "string",
            algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Random",
          },
        },
        why_it_matters: {
          encrypt: {
            bsonType: "string",
            algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Random",
          },
        },
        source_exchanges: {
          encrypt: {
            bsonType: "string",
            algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Random",
          },
        },
      },
    },
  };

  const cryptSharedLibPath =
    process.env.CRYPT_SHARED_LIB_PATH || "/app/vendor/mongo_crypt_v1.so";

  return {
    keyVaultNamespace: KEY_VAULT_NAMESPACE,
    kmsProviders,
    schemaMap,
    extraOptions: {
      cryptSharedLibPath:
        cryptSharedLibPath as `${string}mongo_crypt_v${number}.so`,
      cryptSharedLibRequired: true,
    },
  };
}
