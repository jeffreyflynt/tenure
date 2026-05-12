import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { BackupExporter } from "../backup/exporter.js";
import { BackupImporter, type ImportOptions } from "../backup/importer.js";

export interface BackupDeps {
  db: Db;
  runtimeStore: RuntimeConfigStore;
  userId: string;
}

export function registerBackupRoutes(
  app: FastifyInstance,
  deps: BackupDeps,
): void {
  app.post<{
    Body: { passphrase: string };
  }>("/v1/backup/export", async (req, reply) => {
    const { passphrase } = req.body;

    if (!passphrase || passphrase.length < 8) {
      return reply.code(400).send({
        error: {
          message: "Passphrase is required and must be at least 8 characters",
        },
      });
    }

    const exporter = new BackupExporter({
      db: deps.db,
      runtimeStore: deps.runtimeStore,
      userId: deps.userId,
    });

    const archive = await exporter.export(passphrase);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `tenure-backup-${timestamp}.enc`;

    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("x-tenure-export-version", "1")
      .send(archive);
  });

  app.post<{
    Body: {
      passphrase: string;
      skip_existing?: boolean;
      import_config?: boolean;
      import_sessions?: boolean;
    };
  }>("/v1/backup/import", async (req, reply) => {
    const { passphrase, skip_existing, import_config, import_sessions } =
      req.body;

    if (!passphrase) {
      return reply.code(400).send({
        error: { message: "Passphrase is required" },
      });
    }

    // The archive is sent as the raw body with passphrase in a header,
    // or as multipart. For simplicity, accept base64-encoded archive in body.
    const archiveField = (req.body as Record<string, unknown>).archive;
    if (!archiveField || typeof archiveField !== "string") {
      return reply.code(400).send({
        error: { message: "archive field (base64) is required" },
      });
    }

    const archive = Buffer.from(archiveField, "base64");

    const options: ImportOptions = {
      skipExisting: skip_existing ?? true,
      importConfig: import_config ?? true,
      importSessions: import_sessions ?? false,
      remapUserId: true,
    };

    const importer = new BackupImporter({
      db: deps.db,
      runtimeStore: deps.runtimeStore,
      userId: deps.userId,
    });

    try {
      const result = await importer.importEncrypted(
        archive,
        passphrase,
        options,
      );
      return reply.send({
        ok: true,
        result,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (
        message.includes("Wrong passphrase") ||
        message.includes("Decryption failed")
      ) {
        return reply.code(401).send({
          error: { message: "Wrong passphrase or corrupted archive" },
        });
      }
      if (message.includes("Unsupported export version")) {
        return reply.code(422).send({
          error: { message },
        });
      }
      throw err;
    }
  });

  app.get("/v1/backup/preview", async (_req, reply) => {
    const exporter = new BackupExporter({
      db: deps.db,
      runtimeStore: deps.runtimeStore,
      userId: deps.userId,
    });

    const payload = await exporter.exportUnencrypted();

    return reply.send({
      version: payload.version,
      exported_at: payload.exported_at,
      user_id: payload.user_id,
      counts: {
        beliefs: payload.beliefs.length,
        beliefs_active: payload.beliefs.filter(
          (b) => b.superseded_by === null && b.resolved_at === null,
        ).length,
        sessions: payload.sessions.length,
        compaction_entries: payload.compaction_log.length,
        has_persona: payload.persona_cache !== null,
        has_config: payload.runtime_config !== null,
      },
    });
  });
}
