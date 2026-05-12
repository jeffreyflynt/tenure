import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "mongodb";

import { SessionManager } from "./session/manager.js";
import { HistoryManager } from "./history/manager.js";
import { ContextBuilder } from "./context/contextBuilder.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { registerChatRoute, type ChatDeps } from "./routes/chat.js";
import { registerAdminRoutes, type AdminDeps } from "./routes/admin.js";
import { registerBeliefsRoutes, type BeliefsDeps } from "./routes/beliefs.js";
import type { RuntimeConfigStore } from "./config/runtime.js";
import type { ErrorLogger } from "./errors/logger.js";
import type { Collections } from "./db/collections.js";
import {
  registerOnboardingRoutes,
  type OnboardingDeps,
} from "./routes/onboarding.js";
import { registerBeliefsUiRoute } from "./routes/beliefs-ui.js";
import { registerAdminUiRoute } from "./routes/admin-ui.js";
import type { PersonaCache } from "./context/personaCache.js";
import type { BeliefCompactionRunner } from "./jobs/compactionRunner.js";
import fastifySchedule from "@fastify/schedule";
import { SimpleIntervalJob, AsyncTask } from "toad-scheduler";
import type { ExtractionWorker } from "./extraction/worker.js";
import type { PersonaSummaryService } from "./context/personaSummary.js";
import { fileURLToPath } from "node:url";
import path, { dirname } from "node:path";
import fastifyStatic from "@fastify/static";
import { registerBackupRoutes, type BackupDeps } from "./routes/backup.js";
import { registerPersonaRoutes, type PersonaDeps } from "./routes/persona.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ServerDeps {
  db: Db;
  cols: Collections;
  sessions: SessionManager;
  history: HistoryManager;
  context: ContextBuilder;
  providers: ProviderRegistry;
  jobs: ExtractionJobQueue;
  runtimeStore: RuntimeConfigStore;
  errorLogger: ErrorLogger;
  persona: PersonaCache;
  apiToken: string;
  userId: string;
  compactionRunner: BeliefCompactionRunner;
  extractionWorker: ExtractionWorker;
  personaSummary: PersonaSummaryService;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });
  let liveToken = deps.apiToken;

  app.register(fastifyStatic, { root: path.join(__dirname, "static") });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/v1/")) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${liveToken}`) {
        return reply.code(401).send({ error: { message: "unauthorized" } });
      }
    }
  });

  app.setErrorHandler((error, req, reply) => {
    req.log.error({ err: error, method: req.method, url: req.url });

    const fastifyError = error as { statusCode?: number; message: string };

    deps.errorLogger
      .log({
        severity:
          fastifyError.statusCode && fastifyError.statusCode < 500
            ? "warning"
            : "error",
        stage: req.url.startsWith("/v1/chat")
          ? "provider_call"
          : req.url.startsWith("/admin")
            ? "config"
            : req.url.startsWith("/v1/beliefs")
              ? "belief_write"
              : "provider_call",
        message: fastifyError.message,
        error: error instanceof Error ? error : new Error(fastifyError.message),
        user_id: deps.userId,
      })
      .catch(() => {});

    if (reply.sent) return;

    const statusCode = fastifyError.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        error: { message: fastifyError.message, type: "client_error" },
      });
    }
    return reply.status(500).send({
      error: { message: "internal server error", type: "internal_error" },
    });
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await deps.db.command({ ping: 1 });
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: "database unreachable" });
    }
  });

  app.get("/v1/models", async () => {
    const models = await deps.providers.listModels();
    return { object: "list", data: models };
  });

  const chatDeps: ChatDeps = {
    sessions: deps.sessions,
    history: deps.history,
    context: deps.context,
    providers: deps.providers,
    jobs: deps.jobs,
    userId: deps.userId,
    extractionWorker: deps.extractionWorker,
    runtimeStore: deps.runtimeStore,
    errorLogger: deps.errorLogger,
  };
  registerChatRoute(app, chatDeps);

  const adminDeps: AdminDeps = {
    runtimeStore: deps.runtimeStore,
    providers: deps.providers,
    db: deps.db,
    updateToken: (t: string) => {
      liveToken = t;
    },
  };
  registerAdminRoutes(app, adminDeps);

  const beliefsDeps: BeliefsDeps = {
    beliefs: deps.cols.beliefs,
    userId: deps.userId,
    jobs: deps.jobs,
    extractionWorker: deps.extractionWorker,
    runtimeStore: deps.runtimeStore,
    providers: deps.providers,
  };
  registerBeliefsRoutes(app, beliefsDeps);

  const onboardingDeps: OnboardingDeps = {
    runtimeStore: deps.runtimeStore,
    jobs: deps.jobs,
    providers: deps.providers,
    extractionWorker: deps.extractionWorker,
    userId: deps.userId,
    personaSummary: deps.personaSummary,
  };
  registerOnboardingRoutes(app, onboardingDeps);

  registerBeliefsUiRoute(app);
  registerAdminUiRoute(app);

  const backupDeps: BackupDeps = {
    db: deps.db,
    runtimeStore: deps.runtimeStore,
    userId: deps.userId,
  };
  registerBackupRoutes(app, backupDeps);

  const personaDeps: PersonaDeps = {
    userId: deps.userId,
    persona: deps.persona,
    personaSummary: deps.personaSummary,
  };

  registerPersonaRoutes(app, personaDeps);

  await app.register(fastifySchedule);

  app.addHook("onReady", async () => {
    const task = new AsyncTask(
      "belief-compaction",
      () => deps.compactionRunner.run(deps.userId),
      (err: Error) => {
        deps.errorLogger
          .log({
            severity: "warning",
            stage: "belief_extraction",
            message: err.message,
            error: err,
            user_id: deps.userId,
          })
          .catch(() => {});
      },
    );

    app.scheduler.addSimpleIntervalJob(
      new SimpleIntervalJob({ minutes: 30, runImmediately: false }, task, {
        id: "belief-compaction",
        preventOverrun: true,
      }),
    );
  });

  app.addHook("onReady", async () => {
    const extractionSweep = new AsyncTask(
      "extraction-sweep",
      () => deps.extractionWorker.sweep(20),
      (err: Error) => {
        deps.errorLogger
          .log({
            severity: "warning",
            stage: "belief_extraction",
            message: err.message,
            error: err,
            user_id: deps.userId,
          })
          .catch(() => {});
      },
    );

    app.scheduler.addSimpleIntervalJob(
      new SimpleIntervalJob(
        { minutes: 1, runImmediately: true },
        extractionSweep,
        {
          id: "extraction-sweep",
          preventOverrun: true,
        },
      ),
    );
  });

  app.get("/", async (_req, reply) => {
    const cfg = await deps.runtimeStore.load();
    const target =
      cfg.onboarding_status === "completed" ? "/beliefs" : "/onboarding";
    return reply.redirect(target, 302);
  });

  return app;
}
