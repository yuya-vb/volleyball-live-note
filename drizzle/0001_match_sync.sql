CREATE TABLE `matches` (
  `match_id` text PRIMARY KEY NOT NULL,
  `home_name` text NOT NULL,
  `away_name` text NOT NULL,
  `home_score` integer NOT NULL,
  `away_score` integer NOT NULL,
  `set_number` integer NOT NULL,
  `serving_team` text NOT NULL,
  `home_rotation` text NOT NULL,
  `away_rotation` text NOT NULL,
  `revision` integer NOT NULL,
  `updated_at` text NOT NULL
);
