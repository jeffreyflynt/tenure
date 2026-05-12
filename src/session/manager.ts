import type { Collection, Db } from "mongodb";

export type SessionType = "chat" | "onboarding";

export interface Session {
  _id: string;
  userId: string;
  type: SessionType;
  providerId: string | null;
  model: string | null;
  activeScope: string[];
  turnCounter: number;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface SessionPatch {
  type?: SessionType;
  providerId?: string;
  model?: string;
  activeScope?: string[];
}

export class SessionManager {
  private readonly col: Collection<Session>;

  constructor(db: Db) {
    this.col = db.collection<Session>("sessions");
  }

  async getOrCreate(
    sessionId: string,
    userId: string,
    type: SessionType = "chat",
  ): Promise<Session> {
    const now = new Date();
    const res = await this.col.findOneAndUpdate(
      { _id: sessionId, userId },
      {
        $setOnInsert: {
          _id: sessionId,
          userId,
          type,
          providerId: null,
          model: null,
          activeScope: [],
          turnCounter: 0,
          createdAt: now,
        },
        $set: { lastUsedAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (!res) throw new Error(`session upsert failed: ${sessionId}`);
    return res;
  }

  async get(sessionId: string, userId: string): Promise<Session | null> {
    return this.col.findOne({ _id: sessionId, userId });
  }

  async update(
    sessionId: string,
    userId: string,
    patch: SessionPatch,
  ): Promise<Session | null> {
    const set: Record<string, unknown> = { lastUsedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) set[k] = v;
    }
    return this.col.findOneAndUpdate(
      { _id: sessionId, userId },
      { $set: set },
      { returnDocument: "after" },
    );
  }

  async touch(sessionId: string, userId: string): Promise<void> {
    await this.col.updateOne(
      { _id: sessionId, userId },
      { $set: { lastUsedAt: new Date() } },
    );
  }

  async requireBound(
    sessionId: string,
    userId: string,
  ): Promise<Session & { providerId: string; model: string }> {
    const s = await this.getOrCreate(sessionId, userId);
    if (!s.providerId || !s.model) {
      throw new SessionNotBoundError(sessionId);
    }
    return s as Session & { providerId: string; model: string };
  }

  async allocateTurnIndex(sessionId: string, userId: string): Promise<number> {
    const res = await this.col.findOneAndUpdate(
      { _id: sessionId, userId },
      { $inc: { turnCounter: 1 }, $set: { lastUsedAt: new Date() } },
      { returnDocument: "after", upsert: false },
    );
    if (!res)
      throw new Error(
        `cannot allocate turn index: session ${sessionId} missing`,
      );
    return res.turnCounter - 1;
  }
}

export class SessionNotBoundError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has no provider/model bound`);
    this.name = "SessionNotBoundError";
  }
}
