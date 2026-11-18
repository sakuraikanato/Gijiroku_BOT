CREATE TABLE guilds (
  id TEXT PRIMARY KEY,
  output_channel_id TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id),
  voice_channel_id TEXT NOT NULL,
  output_channel_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting','running','stopping','ended')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (guild_id, id),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_session_per_guild ON sessions(guild_id) WHERE state != 'ended';
CREATE TABLE participants (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  FOREIGN KEY (guild_id,session_id) REFERENCES sessions(guild_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_participant_visit ON participants(guild_id,session_id,user_id) WHERE left_at IS NULL;
CREATE TABLE transcripts (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  UNIQUE(guild_id,session_id,id),
  UNIQUE(guild_id,session_id,sequence),
  FOREIGN KEY(guild_id,session_id) REFERENCES sessions(guild_id,id) ON DELETE CASCADE
);
CREATE INDEX transcripts_order ON transcripts(guild_id,session_id,started_at,sequence,id);
CREATE TABLE audio_losses (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(guild_id,session_id) REFERENCES sessions(guild_id,id) ON DELETE CASCADE
);
CREATE TABLE pending_audio (
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  started_at INTEGER NOT NULL,
  PRIMARY KEY(guild_id,session_id,sequence),
  FOREIGN KEY(guild_id,session_id) REFERENCES sessions(guild_id,id) ON DELETE CASCADE
);
CREATE TABLE summary_jobs (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('short','long')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','generated','done')),
  is_final INTEGER NOT NULL CHECK(is_final IN (0,1)),
  previous_long_summary_id INTEGER,
  locked_by TEXT,
  locked_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  error TEXT,
  UNIQUE(guild_id,session_id,id),
  FOREIGN KEY(guild_id,session_id) REFERENCES sessions(guild_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,previous_long_summary_id) REFERENCES long_summaries(guild_id,session_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX jobs_claim ON summary_jobs(state,locked_until,id);
CREATE TABLE short_summaries (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  job_id INTEGER NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  is_fallback INTEGER NOT NULL CHECK(is_fallback IN (0,1)),
  imported_into_long_summary_id INTEGER,
  message_id TEXT,
  publication_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(guild_id,session_id,id),
  UNIQUE(guild_id,session_id,sequence),
  FOREIGN KEY(guild_id,session_id) REFERENCES sessions(guild_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,job_id) REFERENCES summary_jobs(guild_id,session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,imported_into_long_summary_id) REFERENCES long_summaries(guild_id,session_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE long_summaries (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  job_id INTEGER NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  previous_long_summary_id INTEGER,
  content_json TEXT NOT NULL,
  is_fallback INTEGER NOT NULL CHECK(is_fallback IN (0,1)),
  is_final INTEGER NOT NULL CHECK(is_final IN (0,1)),
  message_id TEXT,
  publication_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(guild_id,session_id,id),
  UNIQUE(guild_id,session_id,sequence),
  FOREIGN KEY(guild_id,session_id) REFERENCES sessions(guild_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,job_id) REFERENCES summary_jobs(guild_id,session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,previous_long_summary_id) REFERENCES long_summaries(guild_id,session_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE summary_job_transcripts (
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  transcript_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(job_id,transcript_id),
  UNIQUE(guild_id,session_id,transcript_id),
  UNIQUE(job_id,position),
  FOREIGN KEY(guild_id,session_id,job_id) REFERENCES summary_jobs(guild_id,session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,transcript_id) REFERENCES transcripts(guild_id,session_id,id) ON DELETE CASCADE
);
CREATE TABLE short_summary_transcripts (
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  short_summary_id INTEGER NOT NULL,
  transcript_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(short_summary_id,transcript_id),
  UNIQUE(guild_id,session_id,transcript_id),
  UNIQUE(short_summary_id,position),
  FOREIGN KEY(guild_id,session_id,short_summary_id) REFERENCES short_summaries(guild_id,session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,transcript_id) REFERENCES transcripts(guild_id,session_id,id) ON DELETE CASCADE
);
CREATE TABLE summary_job_short_summaries (
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  short_summary_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(job_id,short_summary_id),
  UNIQUE(guild_id,session_id,short_summary_id),
  UNIQUE(job_id,position),
  FOREIGN KEY(guild_id,session_id,job_id) REFERENCES summary_jobs(guild_id,session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,short_summary_id) REFERENCES short_summaries(guild_id,session_id,id) ON DELETE CASCADE
);
CREATE TABLE long_summary_sources (
  guild_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  long_summary_id INTEGER NOT NULL,
  short_summary_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(long_summary_id,short_summary_id),
  UNIQUE(guild_id,session_id,short_summary_id),
  UNIQUE(long_summary_id,position),
  FOREIGN KEY(guild_id,session_id,long_summary_id) REFERENCES long_summaries(guild_id,session_id,id) ON DELETE CASCADE,
  FOREIGN KEY(guild_id,session_id,short_summary_id) REFERENCES short_summaries(guild_id,session_id,id) ON DELETE CASCADE
);
