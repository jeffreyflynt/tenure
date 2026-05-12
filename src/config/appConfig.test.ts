import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db, type ObjectId } from "mongodb";
import { loadAppConfig } from "./appConfig.js";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await db.collection("config").deleteMany({});
});

test("returns the config document when it exists", async (t) => {
  await db.collection("config").insertOne({
    _id: "app" as unknown as ObjectId,
    api_token: "tok-abc-123",
  });

  const cfg = await loadAppConfig(db);

  t.is(cfg.api_token, "tok-abc-123");
});

test("returns additional fields stored on the config document", async (t) => {
  await db.collection("config").insertOne({
    _id: "app" as unknown as ObjectId,
    api_token: "tok-xyz",
    feature_flag_beta: true,
  });

  const cfg = await loadAppConfig(db);

  t.is(cfg.api_token, "tok-xyz");
  t.is((cfg as any).feature_flag_beta, true);
});

test("returns the document even if api_token is empty string", async (t) => {
  await db.collection("config").insertOne({
    _id: "app" as unknown as ObjectId,
    api_token: "",
  });

  const cfg = await loadAppConfig(db);

  t.is(cfg.api_token, "");
});

test("auto-provisions a config document when none exists", async (t) => {
  const cfg = await loadAppConfig(db);

  t.truthy(cfg.api_token);
  t.regex(cfg.api_token, /^mp_[A-Za-z0-9_-]+$/);

  const persisted = await db
    .collection("config")
    .findOne({ _id: "app" as unknown as ObjectId });
  t.is(persisted?.api_token, cfg.api_token);
});

test("auto-provisions when only a foreign _id exists", async (t) => {
  await db.collection("config").insertOne({
    _id: "other" as unknown as ObjectId,
    api_token: "tok-nope",
  });

  const cfg = await loadAppConfig(db);

  t.truthy(cfg.api_token);
  t.not(cfg.api_token, "tok-nope");

  const appDoc = await db
    .collection("config")
    .findOne({ _id: "app" as unknown as ObjectId });
  t.truthy(appDoc);
  t.is(appDoc?.api_token, cfg.api_token);
});

test("returns the same token on subsequent calls", async (t) => {
  const first = await loadAppConfig(db);
  const second = await loadAppConfig(db);
  t.is(first.api_token, second.api_token);
});
