import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    videoId: text("video_id").notNull(),
    text: text("text").notNull(),
    playbackTime: real("playback_time").notNull(),
    savedAt: text("saved_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("notes_video_time_idx").on(table.videoId, table.playbackTime),
    index("notes_video_saved_idx").on(table.videoId, table.savedAt),
  ],
);
