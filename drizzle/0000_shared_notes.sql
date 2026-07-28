CREATE TABLE `notes` (
  `id` text PRIMARY KEY NOT NULL,
  `video_id` text NOT NULL,
  `text` text NOT NULL,
  `playback_time` real NOT NULL,
  `saved_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notes_video_time_idx` ON `notes` (`video_id`, `playback_time`);
--> statement-breakpoint
CREATE INDEX `notes_video_saved_idx` ON `notes` (`video_id`, `saved_at`);
