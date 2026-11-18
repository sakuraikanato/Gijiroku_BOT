import { randomUUID } from "node:crypto";
import type { JobInput, LongContent, Repository, ShortContent } from "../../../packages/shared/src/contracts";
import type { AppOptions } from "../../../packages/shared/src/options";
import { OpenAiProvider, validateSummary, type SummaryProvider } from "./provider";
import { DiscordPublisher, renderTranscripts, type SummaryPublisher } from "./publication";

export interface WorkerDependencies {
  provider?: SummaryProvider;
  publisher?: SummaryPublisher;
  environment?: NodeJS.ProcessEnv;
  owner?: string;
  signal?: AbortSignal;
}

function fallbackContent(input: JobInput): ShortContent | LongContent {
  if (input.job.kind === "short") {
    return {
      overview: renderTranscripts(input.transcripts),
      sourceTranscriptIds: input.transcripts.map((transcript) => transcript.id),
    };
  }
  const sourceIds = new Set(input.shortSummaries.flatMap((summary) =>
    "sourceTranscriptIds" in summary.content ? summary.content.sourceTranscriptIds : []));
  const current = input.transcripts.filter((transcript) => sourceIds.has(transcript.id));
  const previous = input.previousLongSummary?.content as LongContent | undefined;
  return {
    overview: [previous?.overview, renderTranscripts(current)].filter(Boolean).join("\n\n"),
    decisions: previous?.decisions ?? [],
    todos: previous?.todos ?? [],
    topics: previous?.topics ?? [],
    sourceShortSummaryIds: input.shortSummaries.map((summary) => summary.id),
  };
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<T> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([parent, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(new Error("Operation interrupted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation(signal), aborted.promise]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function processOne(
  repository: Repository,
  options: AppOptions,
  dependencies: WorkerDependencies = {},
): Promise<boolean> {
  dependencies.signal?.throwIfAborted();
  const owner = dependencies.owner ?? randomUUID();
  const leaseMs = options.worker.leaseDurationMs;
  const job = repository.claimJob(owner, leaseMs);
  if (!job) return false;

  const leaseAbort = new AbortController();
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, leaseAbort.signal])
    : leaseAbort.signal;
  let leaseLost = false;
  function renew() {
    try {
      if (repository.renewLease(job!.id, owner, leaseMs)) return true;
    } catch {
      // A failed heartbeat must fence further external output.
    }
    leaseLost = true;
    leaseAbort.abort();
    return false;
  }
  const heartbeat = setInterval(renew, Math.max(1, Math.min(1000, Math.floor(leaseMs / 3))));

  try {
    const input = repository.jobInput(job);
    const environment = dependencies.environment ?? process.env;
    const provider = dependencies.provider ?? new OpenAiProvider(environment);
    const token = environment[options.discord.tokenEnv]?.trim()
      || (options.discord.tokenEnv === "DISCORD_BOT_TOKEN" ? environment.TOKEN?.trim() : "");
    const publisher = dependencies.publisher ?? new DiscordPublisher(token ?? "");
    let fallback = false;
    let content: ShortContent | LongContent;
    try {
      if (input.job.kind === "long" &&
        (input.previousLongSummary?.fallback || input.shortSummaries.some((summary) => summary.fallback))) {
        throw new Error("Preserve previously published fallback intervals");
      }
      const result = await bounded((abort) => provider.summarize(input, options, abort), options.ai.timeoutMs, signal);
      content = validateSummary(result, input);
    } catch {
      if (leaseLost || dependencies.signal?.aborted) return true;
      content = fallbackContent(input);
      fallback = true;
    }
    if (!renew() || signal.aborted) return true;
    const summary = repository.saveSummary(job, owner, content, fallback);

    let messageId: string | null = null;
    let publicationError: string | null = null;
    try {
      messageId = await bounded((abort) => publisher.publish(summary, input, abort), options.ai.timeoutMs, signal);
    } catch {
      publicationError = "discord_publication_failed";
    }
    if (!renew() || signal.aborted) return true;
    repository.recordPublication(summary, messageId, publicationError);
    repository.completeJob(job.id, owner);
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}
