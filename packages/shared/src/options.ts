import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const positiveInteger = z.int().positive();
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const snowflake = z.string().refine(
  (id) => /^[1-9][0-9]{16,19}$/.test(id) && BigInt(id) <= 0xffff_ffff_ffff_ffffn,
  "有効な Discord ID を文字列で指定してください。",
);

const appSchema = z.strictObject({
  environment: z.enum(["development", "test", "production"]),
  timezone: nonEmpty.refine((name) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: name });
      return true;
    } catch {
      return false;
    }
  }, "有効なタイムゾーンを指定してください。"),
});

const discordSchema = z.strictObject({
  tokenEnv: envName,
  commandGuildIds: z.array(snowflake)
    .refine((ids) => new Set(ids).size === ids.length, "Guild ID を重複させないでください。")
    .default([]),
});

const databaseSchema = z.strictObject({
  path: nonEmpty,
  journalMode: z.literal("WAL"),
  busyTimeoutMs: positiveInteger,
});

const queueSchema = z.strictObject({
  maxItems: positiveInteger,
  warningThreshold: positiveInteger,
  pauseThreshold: positiveInteger,
  resumeBelow: positiveInteger,
})
  .refine((queue) => queue.warningThreshold < queue.pauseThreshold, {
    path: ["warningThreshold"],
    message: "pauseThreshold より小さい値を指定してください。",
  })
  .refine((queue) => queue.pauseThreshold <= queue.maxItems, {
    path: ["pauseThreshold"],
    message: "maxItems 以下の値を指定してください。",
  })
  .refine((queue) => queue.resumeBelow <= queue.warningThreshold, {
    path: ["resumeBelow"],
    message: "warningThreshold 以下の値を指定してください。",
  });

const asrSchema = z.strictObject({
  modelPath: nonEmpty,
  language: nonEmpty,
  sampleRate: positiveInteger,
  maxParallelTasks: positiveInteger,
  queue: queueSchema,
  blacklistedUserIds: z.array(snowflake),
});

const summarySchema = z.strictObject({
  short: z.strictObject({
    characterThreshold: positiveInteger,
    elapsedSeconds: positiveInteger,
    silenceSeconds: positiveInteger,
    debounceSeconds: z.int().nonnegative(),
  }),
  long: z.strictObject({
    newShortSummaryThreshold: positiveInteger,
    elapsedSeconds: positiveInteger,
  }),
});

const aiSchema = z.strictObject({
  provider: nonEmpty,
  model: nonEmpty.nullable(),
  timeoutMs: positiveInteger,
  apiKeyEnv: envName,
});

const retentionSchema = z.strictObject({ retentionDays: positiveInteger });
const workerSchema = z.strictObject({
  pollIntervalMs: positiveInteger,
  leaseDurationMs: positiveInteger,
});

function promptSchema(allowedVariables: readonly string[]) {
  const template = nonEmpty.refine((value) => {
    const remainder = value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, variable: string) =>
      allowedVariables.includes(variable) ? "" : match);
    return !remainder.includes("{{") && !remainder.includes("}}");
  }, "許可されたテンプレート変数を指定してください。");
  return z.strictObject({ systemPrompt: template, userPrompt: template });
}

const shortPromptSchema = promptSchema(["transcripts"]);
const longPromptSchema = promptSchema(["previousLongSummary", "shortSummaries"]);

function loadJson<Schema extends z.ZodType>(directory: string, file: string, schema: Schema): z.output<Schema> {
  const label = `options/${file}`;
  let json: string;
  try {
    json = readFileSync(join(directory, file), "utf8");
  } catch {
    throw new Error(`${label} を読み込めません。`);
  }

  let value: unknown;
  try {
    value = JSON.parse(json.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${label} の JSON 構文が不正です。`);
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.length ? issue.path.join(".") : "(ルート)";
      const message = issue.code === "unrecognized_keys" ? "未定義の設定項目があります。" : issue.message;
      return `${field} (${message})`;
    });
    throw new Error(`${label} の設定が不正です。 ${issues.join(", ")}`);
  }
  return result.data;
}

export function loadOptions(directory: string) {
  return {
    app: loadJson(directory, "app.json", appSchema),
    discord: loadJson(directory, "discord.json", discordSchema),
    database: loadJson(directory, "database.json", databaseSchema),
    asr: loadJson(directory, "asr.json", asrSchema),
    summary: loadJson(directory, "summary.json", summarySchema),
    ai: loadJson(directory, "ai.json", aiSchema),
    retention: loadJson(directory, "retention.json", retentionSchema),
    worker: loadJson(directory, "worker.json", workerSchema),
    prompts: {
      short: loadJson(directory, "prompts/short.json", shortPromptSchema),
      long: loadJson(directory, "prompts/long.json", longPromptSchema),
    },
  };
}

export type AppOptions = ReturnType<typeof loadOptions>;
export type DiscordOptions = AppOptions["discord"];
