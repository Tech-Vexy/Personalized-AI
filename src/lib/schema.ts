import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The data model (spec.md > Data Model). Everything except the in-flight
 * pending message lives in the one SQLite file these tables define.
 */

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Derived from the first user words; renaming is recorded later polish. */
  title: text("title").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MessageRole = MessageRow["role"];

/** Long-term store: one distilled fact/decision/topic per row, with provenance. */
export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
  sourceSessionId: integer("source_session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Key/value flags — `onboarding_done` gates the first-launch flow (slice 5). */
export const profile = sqliteTable("profile", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type MemoryRow = typeof memories.$inferSelect;
