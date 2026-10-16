CREATE TABLE competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  rsn TEXT NOT NULL,
  normalized_rsn TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (competition_id, normalized_rsn)
);

CREATE TABLE competition_players (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  rsn TEXT NOT NULL,
  normalized_rsn TEXT NOT NULL,
  participant_id TEXT UNIQUE REFERENCES participants(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (competition_id, normalized_rsn)
);

CREATE TABLE rsn_change_codes (
  id TEXT PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE competition_events (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX participants_competition_idx ON participants(competition_id);
CREATE INDEX competition_players_participant_idx ON competition_players(participant_id);
CREATE INDEX rsn_change_codes_lookup_idx ON rsn_change_codes(participant_id, code_hash, used_at);
CREATE INDEX competition_events_participant_idx ON competition_events(participant_id, created_at);
