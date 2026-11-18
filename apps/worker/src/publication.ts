import type { JobInput, LongContent, Summary, Transcript } from "../../../packages/shared/src/contracts";

export interface SummaryPublisher {
  publish(summary: Summary, input: JobInput, signal: AbortSignal): Promise<string | null>;
}

export function splitMessage(value: string, limit = 2000): string[] {
  if (!Number.isInteger(limit) || limit < 2 || limit > 2000) throw new Error("Invalid Discord message limit");
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > limit) {
    let end = limit;
    const char = remaining.charCodeAt(end - 1);
    if (char >= 0xd800 && char <= 0xdbff) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function renderTranscripts(transcripts: Transcript[]): string {
  return transcripts.map((transcript) =>
    `[${new Date(transcript.startedAt).toISOString()}] ${transcript.userId}\n${transcript.text}`,
  ).join("\n\n");
}

export function renderSummary(summary: Summary) {
  const title = summary.kind === "short" ? "短期要約" : "長期要約";
  let content = `${title}${summary.fallback ? "（文字起こしによるフォールバック）" : ""}\n${summary.content.overview}`;
  if (summary.kind === "long") {
    const long = summary.content as LongContent;
    const lines = [
      ...long.decisions.map((item) => `決定 [${item.status}] ${item.content}`),
      ...long.todos.map((item) => `TODO [${item.status}] ${item.assigneeId ?? "担当未定"} ${item.content}`),
      ...long.topics.map((item) => `${item.title}\n${item.summary}`),
    ];
    if (lines.length) content += `\n\n${lines.join("\n")}`;
  }
  return content;
}

export class DiscordPublisher implements SummaryPublisher {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async publish(summary: Summary, input: JobInput, signal: AbortSignal): Promise<string | null> {
    if (!this.token) throw new Error("Discord token missing");
    const chunks = splitMessage(renderSummary(summary));
    let firstId: string | null = null;
    for (const [index, content] of chunks.entries()) {
      signal.throwIfAborted();
      const response = await this.request(
        `https://discord.com/api/v10/channels/${input.session.outputChannelId}/messages`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bot ${this.token}` },
          body: JSON.stringify({
            content,
            allowed_mentions: { parse: [] },
            components: index === 0 ? [{
              type: 1,
              components: [{
                type: 2, style: 2,
                label: summary.kind === "short" ? "元の文字起こし" : "今回の短期要約",
                custom_id: `summary:${summary.kind}:${summary.sessionId}:${summary.id}:0`,
              }],
            }] : [],
          }),
        },
      );
      if (!response.ok) throw new Error("Discord publication failed");
      const message: unknown = await response.json();
      if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "string") {
        throw new Error("Discord response invalid");
      }
      firstId ??= message.id;
    }
    return firstId;
  }
}
