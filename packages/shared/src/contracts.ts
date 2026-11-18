export type SessionState = "starting" | "running" | "stopping" | "ended";
export type SummaryKind = "short" | "long";
export interface Scope { guildId: string; sessionId: string }
export interface Session extends Scope {
  voiceChannelId: string;
  outputChannelId: string;
  state: SessionState;
  startedAt: number;
  endedAt: number | null;
}
export interface Transcript extends Scope {
  id: number;
  userId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  sequence: number;
}
export type TranscriptInput = Omit<Transcript, "id">;
export interface ShortContent {
  overview: string;
  sourceTranscriptIds: number[];
}
export interface LongContent {
  overview: string;
  decisions: { content: string; status: "confirmed" | "pending" | "cancelled"; sourceTranscriptIds: number[] }[];
  todos: { assigneeId: string | null; content: string; status: "pending" | "completed" | "cancelled"; sourceTranscriptIds: number[] }[];
  topics: { title: string; summary: string; sourceTranscriptIds: number[] }[];
  sourceShortSummaryIds: number[];
}
export interface Summary extends Scope {
  id: number;
  kind: SummaryKind;
  content: ShortContent | LongContent;
  fallback: boolean;
  createdAt: number;
}
export interface Job extends Scope {
  id: number;
  kind: SummaryKind;
  final: boolean;
}
export interface JobInput {
  job: Job;
  session: Session;
  transcripts: Transcript[];
  shortSummaries: Summary[];
  previousLongSummary: Summary | null;
}
export interface PendingStats {
  characters: number;
  firstAt: number | null;
  lastAt: number | null;
  shortCount: number;
  lastShortAt: number;
  lastLongAt: number;
}

/** Synchronous SQLite operations. Network calls occur outside these methods. */
export interface Repository {
  close(): void;
  setOutputChannel(guildId: string, channelId: string): void;
  getOutputChannel(guildId: string): string | null;
  createSession(guildId: string, voiceChannelId: string, now?: number): Session;
  getSession(scope: Scope): Session | null;
  activeSessions(): Session[];
  setSessionState(scope: Scope, state: SessionState, now?: number): void;
  recoverSessions(now?: number): void;
  addParticipant(scope: Scope, userId: string, joined: boolean, now?: number): void;
  addTranscript(input: TranscriptInput): Transcript;
  recordAudioLoss(scope: Scope, reason: string, now?: number): void;
  pendingStats(scope: Scope): PendingStats;
  createShortJob(scope: Scope, final?: boolean, now?: number): Job | null;
  createLongJob(scope: Scope, final?: boolean, now?: number): Job | null;
  claimJob(owner: string, leaseMs: number, now?: number): Job | null;
  renewLease(jobId: number, owner: string, leaseMs: number, now?: number): boolean;
  jobInput(job: Job): JobInput;
  saveSummary(job: Job, owner: string, content: ShortContent | LongContent, fallback: boolean, now?: number): Summary;
  recordPublication(summary: Summary, messageId: string | null, error: string | null): void;
  completeJob(jobId: number, owner: string): void;
  summaryDetails(scope: Scope, kind: SummaryKind, id: number): { summary: Summary; transcripts: Transcript[]; shortSummaries: Summary[] } | null;
  hasPendingJobs(scope: Scope): boolean;
  purgeExpired(retentionDays: number, now?: number): number;
}
