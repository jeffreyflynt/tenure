import type { Collection } from "mongodb";

export interface PersonaDoc {
  _id: string;
  universal: string;
  contributing_belief_ids: string[];
  beliefs_hash: string;
  generated_at: Date;
  model: string;
}

export class PersonaCache {
  constructor(private readonly col: Collection<PersonaDoc>) {}

  async get(userId: string): Promise<PersonaDoc | null> {
    return this.col.findOne({ _id: userId });
  }

  async put(doc: PersonaDoc): Promise<void> {
    await this.col.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }

  async regenerate(userId: string): Promise<void> {
    await this.invalidate(userId);

    await this.get(userId);
  }

  async invalidate(userId: string): Promise<void> {
    await this.col.updateOne(
      { _id: userId },
      { $set: { beliefs_hash: "__stale__" } },
    );
  }
}
