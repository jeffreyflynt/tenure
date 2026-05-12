import type { FastifyInstance } from "fastify";
import type { PersonaCache } from "../context/personaCache.js";
import type { PersonaSummaryService } from "../context/personaSummary.js";

export interface PersonaDeps {
  persona: PersonaCache;
  personaSummary: PersonaSummaryService;
  userId: string;
}

export function registerPersonaRoutes(
  app: FastifyInstance,
  deps: PersonaDeps,
): void {
  app.get("/v1/persona", async () => {
    const doc = await deps.persona.get(deps.userId);
    return {
      universal: doc?.universal ?? null,
      generated_at: doc?.generated_at ?? null,
    };
  });

  app.post("/v1/persona/regenerate", async () => {
    await deps.personaSummary.regenerate(deps.userId);
    return { ok: true };
  });
}
