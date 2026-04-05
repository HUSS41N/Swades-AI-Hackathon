import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Example table for chunk acknowledgment flow (extend as the pipeline grows). */
export const chunkAcks = pgTable("chunk_acks", {
  id: uuid("id").defaultRandom().primaryKey(),
  chunkId: text("chunk_id").notNull().unique(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ChunkAck = typeof chunkAcks.$inferSelect;
export type NewChunkAck = typeof chunkAcks.$inferInsert;
