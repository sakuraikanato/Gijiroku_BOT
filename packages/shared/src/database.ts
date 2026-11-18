import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Job, JobInput, LongContent, PendingStats, Repository, Scope, Session, SessionState,
  ShortContent, Summary, SummaryKind, Transcript, TranscriptInput,
} from "./contracts";

type Row = Record<string, SQLQueryBindings>;

const sessionColumns = "guild_id AS guildId,id AS sessionId,voice_channel_id AS voiceChannelId,output_channel_id AS outputChannelId,state,started_at AS startedAt,ended_at AS endedAt";
const transcriptColumns = "t.id,t.guild_id AS guildId,t.session_id AS sessionId,t.user_id AS userId,t.text,t.started_at AS startedAt,t.ended_at AS endedAt,t.sequence";
const jobColumns = "id,guild_id AS guildId,session_id AS sessionId,kind,is_final AS final";
const eligibleTranscripts = `
  NOT EXISTS (SELECT 1 FROM summary_job_transcripts j WHERE j.transcript_id=t.id)
  AND NOT EXISTS (
    SELECT 1 FROM pending_audio a
    WHERE a.guild_id=t.guild_id AND a.session_id=t.session_id
      AND (a.started_at<t.started_at OR (a.started_at=t.started_at AND a.sequence<=t.sequence))
  )`;

function assertText(value: string, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
}
function assertInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
}
function tableFor(kind: SummaryKind) {
  if (kind === "short") return "short_summaries";
  if (kind === "long") return "long_summaries";
  throw new Error("Invalid summary kind");
}
function summaryFrom(row: Row, kind: SummaryKind): Summary {
  return {
    id: Number(row.id), guildId: String(row.guild_id), sessionId: String(row.session_id), kind,
    content: JSON.parse(String(row.content_json)), fallback: Boolean(row.is_fallback), createdAt: Number(row.created_at),
  };
}
function jobFrom(row: Row): Job {
  return { id: Number(row.id), guildId: String(row.guildId), sessionId: String(row.sessionId), kind: row.kind as SummaryKind, final: Boolean(row.final) };
}

export class SqliteRepository implements Repository {
  private readonly db: Database;

  constructor(path: string, busyTimeoutMs = 5000) {
    assertInteger(busyTimeoutMs, "busy timeout");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL;`);
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL)");
    this.db.transaction(() => {
      if (this.db.query("SELECT version FROM schema_migrations WHERE version=1").get()) return;
      this.db.exec(readFileSync(new URL("../../../migrations/001_initial.sql", import.meta.url), "utf8"));
      this.db.query("INSERT INTO schema_migrations VALUES(1,?)").run(Date.now());
    }).immediate();
  }

  close() { this.db.close(); }

  private scopeSession(scope: Scope) {
    const session = this.getSession(scope);
    if (!session) throw new Error("Unknown Guild/Session");
    return session;
  }

  setOutputChannel(guildId: string, channelId: string) {
    assertText(guildId, "Guild ID");
    assertText(channelId, "channel ID");
    this.db.query("INSERT INTO guilds(id,output_channel_id) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET output_channel_id=excluded.output_channel_id")
      .run(guildId, channelId);
  }

  getOutputChannel(guildId: string): string | null {
    const row = this.db.query<{ output_channel_id: string }, [string]>("SELECT output_channel_id FROM guilds WHERE id=?").get(guildId);
    return row?.output_channel_id ?? null;
  }

  createSession(guildId: string, voiceChannelId: string, now = Date.now()): Session {
    assertText(voiceChannelId, "voice channel ID");
    assertInteger(now, "start time");
    const outputChannelId = this.getOutputChannel(guildId);
    if (!outputChannelId) throw new Error("Summary output channel is not configured");
    const sessionId = randomUUID();
    this.db.query("INSERT INTO sessions(id,guild_id,voice_channel_id,output_channel_id,state,started_at) VALUES(?,?,?,?,'starting',?)")
      .run(sessionId, guildId, voiceChannelId, outputChannelId, now);
    return this.scopeSession({ guildId, sessionId });
  }

  getSession(scope: Scope): Session | null {
    return this.db.query<Session, [string, string]>(`SELECT ${sessionColumns} FROM sessions WHERE guild_id=? AND id=?`)
      .get(scope.guildId, scope.sessionId);
  }

  activeSessions(): Session[] {
    return this.db.query<Session, []>(`SELECT ${sessionColumns} FROM sessions WHERE state!='ended' ORDER BY started_at,id`).all();
  }

  setSessionState(scope: Scope, state: SessionState, now = Date.now()) {
    this.db.transaction(() => {
      const session = this.scopeSession(scope);
      const allowed: Record<SessionState, SessionState[]> = {
        starting: ["running", "ended"], running: ["stopping"], stopping: ["ended"], ended: [],
      };
      if (session.state === state) return;
      if (!allowed[session.state].includes(state)) throw new Error("Invalid Session state transition");
      if (state === "ended" && session.state !== "starting" && this.hasPendingJobs(scope)) {
        throw new Error("Session has unfinished summary jobs");
      }
      if (state === "ended" && session.state !== "starting" && this.db.query(`
        SELECT 1 FROM transcripts t WHERE t.guild_id=? AND t.session_id=?
          AND NOT EXISTS(SELECT 1 FROM short_summary_transcripts s WHERE s.transcript_id=t.id)
        UNION ALL SELECT 1 FROM pending_audio WHERE guild_id=? AND session_id=?
        UNION ALL SELECT 1 FROM short_summaries WHERE guild_id=? AND session_id=? AND imported_into_long_summary_id IS NULL
        LIMIT 1`).get(scope.guildId, scope.sessionId, scope.guildId, scope.sessionId, scope.guildId, scope.sessionId)) {
        throw new Error("Session has unfinished audio or summary inputs");
      }
      this.db.query("UPDATE sessions SET state=?,ended_at=? WHERE guild_id=? AND id=?")
        .run(state, state === "ended" ? now : null, scope.guildId, scope.sessionId);
      if (state === "ended") {
        this.db.query("UPDATE participants SET left_at=? WHERE guild_id=? AND session_id=? AND left_at IS NULL")
          .run(now, scope.guildId, scope.sessionId);
      }
    }).immediate();
  }

  recoverSessions(now = Date.now()) {
    this.db.transaction(() => {
      this.db.query(`INSERT INTO audio_losses(guild_id,session_id,reason,created_at)
        SELECT DISTINCT guild_id,session_id,'volatile_audio_lost_on_restart',? FROM pending_audio`).run(now);
      this.db.exec("DELETE FROM pending_audio");
      this.db.query("UPDATE participants SET left_at=? WHERE left_at IS NULL").run(now);
      this.db.query("UPDATE sessions SET state='ended',ended_at=? WHERE state='starting'").run(now);
      this.db.exec("UPDATE sessions SET state='stopping' WHERE state='running'");
      this.cleanupInterrupted(now);
    }).immediate();
  }

  addParticipant(scope: Scope, userId: string, joined: boolean, now = Date.now()) {
    assertText(userId, "user ID");
    this.scopeSession(scope);
    if (joined) {
      this.db.query("INSERT OR IGNORE INTO participants(guild_id,session_id,user_id,joined_at) VALUES(?,?,?,?)")
        .run(scope.guildId, scope.sessionId, userId, now);
    } else {
      this.db.query("UPDATE participants SET left_at=? WHERE guild_id=? AND session_id=? AND user_id=? AND left_at IS NULL")
        .run(now, scope.guildId, scope.sessionId, userId);
    }
  }

  beginAudio(scope: Scope, sequence: number, startedAt: number) {
    assertInteger(sequence, "audio sequence");
    assertInteger(startedAt, "audio acquisition time");
    if (this.scopeSession(scope).state !== "running") throw new Error("Session is not accepting audio");
    this.db.query("INSERT INTO pending_audio VALUES(?,?,?,?)").run(scope.guildId, scope.sessionId, sequence, startedAt);
  }

  endAudio(scope: Scope, sequence: number) {
    this.scopeSession(scope);
    this.db.query("DELETE FROM pending_audio WHERE guild_id=? AND session_id=? AND sequence=?")
      .run(scope.guildId, scope.sessionId, sequence);
  }

  addTranscript(input: TranscriptInput): Transcript {
    assertText(input.userId, "user ID");
    assertText(input.text, "transcript text");
    assertInteger(input.startedAt, "audio start");
    assertInteger(input.endedAt, "audio end");
    assertInteger(input.sequence, "audio sequence");
    const session = this.scopeSession(input);
    if (session.state !== "running") throw new Error("Session is not accepting transcripts");
    if (input.endedAt < input.startedAt) throw new Error("Invalid audio time range");
    const result = this.db.query("INSERT INTO transcripts(guild_id,session_id,user_id,text,started_at,ended_at,sequence) VALUES(?,?,?,?,?,?,?)")
      .run(input.guildId, input.sessionId, input.userId, input.text, input.startedAt, input.endedAt, input.sequence);
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  recordAudioLoss(scope: Scope, reason: string, now = Date.now()) {
    this.scopeSession(scope);
    // Only stable reason codes are persisted; utterances and exception messages are never accepted here.
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(reason)) throw new Error("Invalid audio loss reason code");
    this.db.query("INSERT INTO audio_losses(guild_id,session_id,reason,created_at) VALUES(?,?,?,?)")
      .run(scope.guildId, scope.sessionId, reason, now);
  }

  pendingStats(scope: Scope): PendingStats {
    const session = this.scopeSession(scope);
    const pending = this.db.query<{ characters: number; firstAt: number | null; lastAt: number | null }, [string, string]>(
      `SELECT COALESCE(SUM(length(t.text)),0) AS characters,MIN(t.started_at) AS firstAt,MAX(t.ended_at) AS lastAt
      FROM transcripts t WHERE t.guild_id=? AND t.session_id=? AND ${eligibleTranscripts}`,
    ).get(scope.guildId, scope.sessionId)!;
    const shorts = this.db.query<{ count: number; lastAt: number | null }, [string, string]>(
      "SELECT COUNT(*) AS count,MAX(created_at) AS lastAt FROM short_summaries WHERE guild_id=? AND session_id=? AND imported_into_long_summary_id IS NULL",
    ).get(scope.guildId, scope.sessionId)!;
    const lastShort = this.db.query<{ lastAt: number | null }, [string, string]>(
      "SELECT MAX(created_at) AS lastAt FROM short_summaries WHERE guild_id=? AND session_id=?",
    ).get(scope.guildId, scope.sessionId)!.lastAt;
    const lastLong = this.db.query<{ lastAt: number | null }, [string, string]>(
      "SELECT MAX(created_at) AS lastAt FROM long_summaries WHERE guild_id=? AND session_id=?",
    ).get(scope.guildId, scope.sessionId)!.lastAt;
    return { ...pending, shortCount: shorts.count, lastShortAt: lastShort ?? session.startedAt, lastLongAt: lastLong ?? session.startedAt };
  }

  createShortJob(scope: Scope, final = false, now = Date.now()): Job | null {
    return this.db.transaction(() => {
      const session = this.scopeSession(scope);
      if (!["running", "stopping"].includes(session.state)) return null;
      const transcripts = this.db.query<{ id: number }, [string, string]>(
        `SELECT t.id FROM transcripts t WHERE t.guild_id=? AND t.session_id=? AND ${eligibleTranscripts} ORDER BY t.started_at,t.sequence,t.id`,
      ).all(scope.guildId, scope.sessionId);
      if (!transcripts.length) return null;
      const job = this.insertJob(scope, "short", final, null, now);
      const insert = this.db.query("INSERT INTO summary_job_transcripts VALUES(?,?,?,?,?)");
      for (const [position, transcript] of transcripts.entries()) {
        insert.run(scope.guildId, scope.sessionId, job.id, transcript.id, position);
      }
      return job;
    }).immediate();
  }

  createLongJob(scope: Scope, final = false, now = Date.now()): Job | null {
    return this.db.transaction(() => {
      const session = this.scopeSession(scope);
      if (!["running", "stopping"].includes(session.state)) return null;
      if (this.db.query("SELECT 1 FROM summary_jobs WHERE guild_id=? AND session_id=? AND kind='long' AND state!='done'")
        .get(scope.guildId, scope.sessionId)) return null;
      const shorts = this.db.query<{ id: number }, [string, string]>(`SELECT s.id FROM short_summaries s
        JOIN summary_jobs j ON j.id=s.job_id WHERE s.guild_id=? AND s.session_id=? AND s.imported_into_long_summary_id IS NULL
        AND j.state='done' AND NOT EXISTS(SELECT 1 FROM summary_job_short_summaries x WHERE x.short_summary_id=s.id)
        ORDER BY s.sequence,s.id`).all(scope.guildId, scope.sessionId);
      if (!shorts.length) return null;
      const previous = this.db.query<{ id: number }, [string, string]>(
        "SELECT id FROM long_summaries WHERE guild_id=? AND session_id=? ORDER BY sequence DESC LIMIT 1",
      ).get(scope.guildId, scope.sessionId);
      const job = this.insertJob(scope, "long", final, previous?.id ?? null, now);
      const insert = this.db.query("INSERT INTO summary_job_short_summaries VALUES(?,?,?,?,?)");
      for (const [position, summary] of shorts.entries()) {
        insert.run(scope.guildId, scope.sessionId, job.id, summary.id, position);
      }
      return job;
    }).immediate();
  }

  private insertJob(scope: Scope, kind: SummaryKind, final: boolean, previousId: number | null, now: number): Job {
    const result = this.db.query("INSERT INTO summary_jobs(guild_id,session_id,kind,is_final,previous_long_summary_id,created_at) VALUES(?,?,?,?,?,?)")
      .run(scope.guildId, scope.sessionId, kind, Number(final), previousId, now);
    return { ...scope, id: Number(result.lastInsertRowid), kind, final };
  }

  private cleanupInterrupted(now: number) {
    for (const kind of ["short", "long"] as const) {
      this.db.query(`UPDATE ${tableFor(kind)} SET publication_error=COALESCE(publication_error,'publication_interrupted')
        WHERE message_id IS NULL AND job_id IN(SELECT id FROM summary_jobs WHERE state='generated' AND locked_until<=?)`).run(now);
    }
    this.db.query("UPDATE summary_jobs SET state='done',error='publication_interrupted' WHERE state='generated' AND locked_until<=?")
      .run(now);
  }

  claimJob(owner: string, leaseMs: number, now = Date.now()): Job | null {
    assertText(owner, "lease owner");
    assertInteger(leaseMs, "lease duration");
    if (!leaseMs) throw new Error("Lease duration must be positive");
    return this.db.transaction(() => {
      this.cleanupInterrupted(now);
      const row = this.db.query<Row, [number]>(`SELECT ${jobColumns} FROM summary_jobs j
        WHERE (j.state='pending' OR (j.state='running' AND j.locked_until<=?))
        AND NOT EXISTS (SELECT 1 FROM summary_jobs earlier
          WHERE earlier.guild_id=j.guild_id AND earlier.session_id=j.session_id
            AND earlier.state!='done' AND earlier.id<j.id)
        ORDER BY j.id LIMIT 1`).get(now);
      if (!row) return null;
      this.db.query("UPDATE summary_jobs SET state='running',locked_by=?,locked_until=?,attempts=attempts+1 WHERE id=?")
        .run(owner, now + leaseMs, row.id);
      return jobFrom(row);
    }).immediate();
  }

  renewLease(jobId: number, owner: string, leaseMs: number, now = Date.now()): boolean {
    assertInteger(leaseMs, "lease duration");
    if (!leaseMs) return false;
    return this.db.query("UPDATE summary_jobs SET locked_until=? WHERE id=? AND locked_by=? AND locked_until>? AND state IN ('running','generated')")
      .run(now + leaseMs, jobId, owner, now).changes === 1;
  }

  jobInput(job: Job): JobInput {
    this.verifyJob(job);
    const session = this.scopeSession(job);
    let transcripts: Transcript[];
    let shortSummaries: Summary[] = [];
    let previousLongSummary: Summary | null = null;
    if (job.kind === "short") {
      transcripts = this.db.query<Transcript, [number]>(`SELECT ${transcriptColumns} FROM transcripts t
        JOIN summary_job_transcripts s ON s.transcript_id=t.id WHERE s.job_id=? ORDER BY s.position`).all(job.id);
    } else {
      const shorts = this.db.query<Row, [number]>(`SELECT s.* FROM short_summaries s
        JOIN summary_job_short_summaries j ON j.short_summary_id=s.id WHERE j.job_id=? ORDER BY j.position`).all(job.id);
      shortSummaries = shorts.map((row) => summaryFrom(row, "short"));
      const previous = this.db.query<Row, [number]>(`SELECT s.* FROM long_summaries s
        JOIN summary_jobs j ON j.previous_long_summary_id=s.id WHERE j.id=?`).get(job.id);
      previousLongSummary = previous ? summaryFrom(previous, "long") : null;
      // All cumulative source transcripts, plus this job's fixed new inputs, belong to this Session.
      transcripts = this.db.query<Transcript, [string, string, number]>(`SELECT DISTINCT ${transcriptColumns} FROM transcripts t
        JOIN short_summary_transcripts st ON st.transcript_id=t.id
        JOIN short_summaries s ON s.id=st.short_summary_id
        WHERE t.guild_id=? AND t.session_id=? AND (
          s.imported_into_long_summary_id IS NOT NULL OR s.id IN(
            SELECT short_summary_id FROM summary_job_short_summaries WHERE job_id=?
          )) ORDER BY t.started_at,t.sequence,t.id`).all(job.guildId, job.sessionId, job.id);
    }
    return { job, session, transcripts, shortSummaries, previousLongSummary };
  }

  private verifyJob(job: Job) {
    const row = this.db.query<Row, [number, string, string]>(
      `SELECT ${jobColumns} FROM summary_jobs WHERE id=? AND guild_id=? AND session_id=?`,
    ).get(job.id, job.guildId, job.sessionId);
    if (!row || row.kind !== job.kind || Boolean(row.final) !== job.final) throw new Error("Unknown or mismatched summary job");
  }

  saveSummary(job: Job, owner: string, content: ShortContent | LongContent, fallback: boolean, now = Date.now()): Summary {
    return this.db.transaction(() => {
      this.verifyJob(job);
      const lease = this.db.query<Row, [number, string, number]>(`SELECT state FROM summary_jobs
        WHERE id=? AND locked_by=? AND locked_until>? AND state IN('running','generated')`).get(job.id, owner, now);
      if (!lease) throw new Error("Summary job lease was lost");
      const table = tableFor(job.kind);
      const existing = this.db.query<Row, [number]>(`SELECT * FROM ${table} WHERE job_id=?`).get(job.id);
      if (existing) return summaryFrom(existing, job.kind);

      this.validateContent(job, content);
      const sequence = this.db.query<{ sequence: number }, [string, string]>(
        `SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM ${table} WHERE guild_id=? AND session_id=?`,
      ).get(job.guildId, job.sessionId)!.sequence;
      let summaryId: number;
      if (job.kind === "short") {
        const result = this.db.query(`INSERT INTO short_summaries(guild_id,session_id,job_id,sequence,content_json,is_fallback,created_at)
          VALUES(?,?,?,?,?,?,?)`).run(job.guildId, job.sessionId, job.id, sequence, JSON.stringify(content), Number(fallback), now);
        summaryId = Number(result.lastInsertRowid);
        this.db.query(`INSERT INTO short_summary_transcripts
          SELECT guild_id,session_id,?,transcript_id,position FROM summary_job_transcripts WHERE job_id=?`).run(summaryId, job.id);
      } else {
        const result = this.db.query(`INSERT INTO long_summaries(guild_id,session_id,job_id,sequence,previous_long_summary_id,content_json,is_fallback,is_final,created_at)
          SELECT guild_id,session_id,id,?,previous_long_summary_id,?,?,is_final,? FROM summary_jobs WHERE id=?`)
          .run(sequence, JSON.stringify(content), Number(fallback), now, job.id);
        summaryId = Number(result.lastInsertRowid);
        this.db.query(`INSERT INTO long_summary_sources
          SELECT guild_id,session_id,?,short_summary_id,position FROM summary_job_short_summaries WHERE job_id=?`).run(summaryId, job.id);
        this.db.query(`UPDATE short_summaries SET imported_into_long_summary_id=? WHERE imported_into_long_summary_id IS NULL
          AND id IN(SELECT short_summary_id FROM summary_job_short_summaries WHERE job_id=?)`).run(summaryId, job.id);
      }
      this.db.query("UPDATE summary_jobs SET state='generated' WHERE id=?").run(job.id);
      return summaryFrom(this.db.query<Row, [number]>(`SELECT * FROM ${table} WHERE id=?`).get(summaryId)!, job.kind);
    }).immediate();
  }

  private validateContent(job: Job, content: ShortContent | LongContent) {
    assertText(content.overview, "summary overview");
    const input = this.jobInput(job);
    const transcriptIds = new Set(input.transcripts.map((t) => t.id));
    const checkIds = (ids: number[]) => {
      if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || !transcriptIds.has(id))) {
        throw new Error("Summary references transcripts outside its fixed Session input");
      }
    };
    if (job.kind === "short") {
      if (!("sourceTranscriptIds" in content)) throw new Error("Invalid short summary");
      checkIds(content.sourceTranscriptIds);
      if (new Set(content.sourceTranscriptIds).size !== transcriptIds.size || content.sourceTranscriptIds.length !== transcriptIds.size) {
        throw new Error("Incomplete short summary sources");
      }
      return;
    }
    if (!("sourceShortSummaryIds" in content)) throw new Error("Invalid long summary");
    const expected = input.shortSummaries.map((s) => s.id);
    if (JSON.stringify(content.sourceShortSummaryIds) !== JSON.stringify(expected)) throw new Error("Invalid short summary sources");
    for (const item of [...content.decisions, ...content.todos, ...content.topics]) checkIds(item.sourceTranscriptIds);
  }

  recordPublication(summary: Summary, messageId: string | null, error: string | null) {
    // A stable error code prevents Discord API errors from leaking tokens or conversation text.
    const safeError = error === null ? null : "discord_publication_failed";
    const result = this.db.query(`UPDATE ${tableFor(summary.kind)} SET message_id=?,publication_error=?
      WHERE id=? AND guild_id=? AND session_id=? AND message_id IS NULL`)
      .run(messageId, safeError, summary.id, summary.guildId, summary.sessionId);
    if (!result.changes) {
      const existing = this.summaryDetails(summary, summary.kind, summary.id);
      if (!existing) throw new Error("Unknown summary");
    }
  }

  completeJob(jobId: number, owner: string) {
    const result = this.db.query("UPDATE summary_jobs SET state='done' WHERE id=? AND locked_by=? AND locked_until>? AND state='generated'")
      .run(jobId, owner, Date.now());
    if (!result.changes) throw new Error("Summary job lease was lost");
  }

  summaryDetails(scope: Scope, kind: SummaryKind, id: number) {
    const row = this.db.query<Row, [number, string, string]>(
      `SELECT * FROM ${tableFor(kind)} WHERE id=? AND guild_id=? AND session_id=?`,
    ).get(id, scope.guildId, scope.sessionId);
    if (!row) return null;
    let transcripts: Transcript[] = [];
    let shortSummaries: Summary[] = [];
    if (kind === "short") {
      transcripts = this.db.query<Transcript, [number]>(`SELECT ${transcriptColumns} FROM transcripts t
        JOIN short_summary_transcripts s ON s.transcript_id=t.id WHERE s.short_summary_id=? ORDER BY s.position`).all(id);
    } else {
      shortSummaries = this.db.query<Row, [number]>(`SELECT s.* FROM short_summaries s
        JOIN long_summary_sources l ON l.short_summary_id=s.id WHERE l.long_summary_id=? ORDER BY l.position`)
        .all(id).map((short) => summaryFrom(short, "short"));
    }
    return { summary: summaryFrom(row, kind), transcripts, shortSummaries };
  }

  hasPendingJobs(scope: Scope) {
    return Boolean(this.db.query("SELECT 1 FROM summary_jobs WHERE guild_id=? AND session_id=? AND state!='done'")
      .get(scope.guildId, scope.sessionId));
  }

  purgeExpired(retentionDays: number, now = Date.now()) {
    assertInteger(retentionDays, "retention days");
    if (!retentionDays) throw new Error("Retention must be positive");
    return this.db.transaction(() => this.db.query("DELETE FROM sessions WHERE state='ended' AND ended_at<=?")
      .run(now - retentionDays * 86400_000).changes).immediate();
  }
}
