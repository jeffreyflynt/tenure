import type { FastifyInstance } from "fastify";

export interface CommandEntry {
  command: string;
  effect: string;
  scope: "session" | "global" | "skill";
}

export const TENURE_COMMANDS: readonly CommandEntry[] = [
  {
    command: "!extract off",
    effect:
      "Pauses extraction for this session only. Existing beliefs are still injected.",
    scope: "session",
  },
  {
    command: "!extract on",
    effect: "Resumes extraction for this session.",
    scope: "session",
  },
  {
    command: "!extract global off",
    effect:
      "Pauses extraction everywhere. No new beliefs will be extracted from any session.",
    scope: "global",
  },
  {
    command: "!extract global on",
    effect: "Re-enables extraction everywhere.",
    scope: "global",
  },
  {
    command: "!inject off",
    effect:
      "Pauses belief injection for this session only. Extraction continues.",
    scope: "session",
  },
  {
    command: "!inject on",
    effect: "Resumes belief injection for this session.",
    scope: "session",
  },
  {
    command: "!inject global off",
    effect:
      "Disables belief injection everywhere. The model receives no context from your world model.",
    scope: "global",
  },
  {
    command: "!inject global on",
    effect: "Re-enables belief injection everywhere.",
    scope: "global",
  },
  {
    command: "!scope domain:<slug>",
    effect:
      "Sets scope to a top-level domain for this session. Example: !scope domain:code",
    scope: "session",
  },
  {
    command: "!scope domain:<slug>/<tech>",
    effect:
      "Sets scope to a technology sub-domain. Example: !scope domain:code/typescript",
    scope: "session",
  },
  {
    command: "!scope project:<slug>",
    effect: "Sets scope to a named project. Example: !scope project:myapp",
    scope: "session",
  },
  {
    command: "!tenure",
    effect:
      "Reports whether Tenure is running and shows a link to your world model.",
    scope: "skill",
  },
  {
    command: "!tenure onboarding",
    effect:
      "Runs the full conversational onboarding flow: provider setup, model selection, and world model seeding.",
    scope: "skill",
  },
  {
    command: "!tenure update",
    effect: "Pulls the latest Tenure image and restarts the containers.",
    scope: "skill",
  },
  {
    command: "!tenure start",
    effect: "Brings Tenure back up after the containers were stopped.",
    scope: "skill",
  },
] as const;

export function registerCommandsRoute(app: FastifyInstance): void {
  app.get("/v1/commands", async () => ({
    commands: TENURE_COMMANDS,
    total: TENURE_COMMANDS.length,
  }));
}
