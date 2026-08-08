import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const matches = sqliteTable("matches", {
  matchId: text("match_id").primaryKey(),
  homeName: text("home_name").notNull(),
  awayName: text("away_name").notNull(),
  homeScore: integer("home_score").notNull(),
  awayScore: integer("away_score").notNull(),
  setNumber: integer("set_number").notNull(),
  servingTeam: text("serving_team").notNull(),
  homeRotation: text("home_rotation").notNull(),
  awayRotation: text("away_rotation").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});
