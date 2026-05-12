import { loadBootstrapConfig } from "./config/bootstrap.js";
import { buildApp } from "./app.js";
import { MongoClient } from "mongodb";

const subcommand = process.argv[2];

if (subcommand === "token") {
  const config = loadBootstrapConfig();
  const client = new MongoClient(config.mongodb_uri);
  try {
    await client.connect();
    const doc = await client
      .db(config.mongodb_db)
      .collection<{ _id: string; api_token: string }>("config")
      .findOne({ _id: "app" });
    if (!doc?.api_token) {
      console.error("No token found. Has Tenure been started at least once?");
      process.exit(1);
    }
    console.log(doc.api_token);
  } finally {
    await client.close();
  }
  process.exit(0);
}

try {
  const config = loadBootstrapConfig();
  const { server, close } = await buildApp(config);
  await server.listen({ port: config.port, host: "0.0.0.0" });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      await close();
      process.exit(0);
    });
  }
} catch (err) {
  console.error("Failed to start server:", err);
  process.exit(1);
}
