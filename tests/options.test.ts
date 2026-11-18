import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOptions } from "../packages/shared/src/options";

const optionsDirectory = fileURLToPath(new URL("../options/", import.meta.url));

function withOptions(verify: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "gijiroku-options-"));
  try {
    cpSync(optionsDirectory, directory, { recursive: true });
    verify(directory);
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("loads all startup options and preserves the snapshot until it is reloaded", () => {
  withOptions((directory) => {
    const options = loadOptions(directory);
    expect(Object.keys(options).sort()).toEqual(
      ["ai", "app", "asr", "database", "discord", "prompts", "retention", "summary", "worker"],
    );
    expect(options.prompts.short.userPrompt).toContain("{{transcripts}}");
    expect(options.prompts.long.userPrompt).toContain("{{shortSummaries}}");

    writeFileSync(join(directory, "discord.json"), '{"tokenEnv":"OTHER_TOKEN"}');
    expect(options.discord.tokenEnv).toBe("DISCORD_BOT_TOKEN");
    expect(loadOptions(directory).discord).toEqual({ tokenEnv: "OTHER_TOKEN", commandGuildIds: [] });
  });
});

test("reports the file and any invalid nested fields at startup", () => {
  withOptions((directory) => {
    writeFileSync(join(directory, "discord.json"), "{");
    expect(() => loadOptions(directory)).toThrow("options/discord.json の JSON 構文が不正");

    writeFileSync(join(directory, "discord.json"), '{"tokenEnv":"TOKEN","commandGuildIds":[123]}');
    expect(() => loadOptions(directory)).toThrow(/options\/discord\.json.*commandGuildIds\.0/);
  });

  withOptions((directory) => {
    const { asr } = loadOptions(directory);
    asr.queue.pauseThreshold = asr.queue.maxItems + 1;
    writeFileSync(join(directory, "asr.json"), JSON.stringify(asr));
    expect(() => loadOptions(directory)).toThrow(/options\/asr\.json.*queue\.pauseThreshold/);
  });

  withOptions((directory) => {
    writeFileSync(join(directory, "prompts", "long.json"), JSON.stringify({
      systemPrompt: "要約してください",
      userPrompt: "{{unapprovedVariable}}",
    }));
    expect(() => loadOptions(directory)).toThrow(/options\/prompts\/long\.json.*userPrompt/);
  });
  withOptions((directory) => {
    writeFileSync(join(directory, "prompts", "short.json"), JSON.stringify({
      systemPrompt: "{{transcripts}}",
      userPrompt: "{{transcripts}}",
    }));
    expect(() => loadOptions(directory)).toThrow(/options\/prompts\/short\.json.*systemPrompt/);
  });
  withOptions((directory) => {
    const { asr } = loadOptions(directory);
    asr.vadThreshold = 0;
    writeFileSync(join(directory, "asr.json"), JSON.stringify(asr));
    expect(() => loadOptions(directory)).toThrow(/options\/asr\.json.*vadThreshold/);
  });
});
