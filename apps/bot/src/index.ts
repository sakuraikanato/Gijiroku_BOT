import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadOptions } from "@gijiroku/shared/options";
import { SqliteRepository } from "@gijiroku/shared/database";
import { AudioPipeline } from "@gijiroku/shared/audio";
import { createBot, createBotClient, readBotToken } from "./bot";
import { RecordingSessions } from "./recording";

async function main() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const options = loadOptions(resolve(root, "options"));
  const token = readBotToken(options.discord, process.env);
  const repository = new SqliteRepository(resolve(root, options.database.path), options.database.busyTimeoutMs);
  repository.recoverSessions();
  const client = createBotClient();
  const audio = new AudioPipeline(options.asr, {
    onTranscript: (transcript) => { repository.addTranscript(transcript); },
    onSettled: (scope, sequence) => { repository.endAudio(scope, sequence); },
    onLoss: (scope, reason) => { repository.recordAudioLoss(scope, reason); },
    onLoad: (event) => {
      const message = {
        warning: "文字起こしの処理待ちが増えています。",
        paused: "処理待ちのため全 VC の音声取り込みを一時停止しました。この間の発言が欠落する可能性があります。",
        resumed: "音声取り込みを再開しました。",
      }[event];
      for (const session of recording.active()) {
        void client.channels.fetch(session.voiceChannelId).then(async (channel) => {
          if (channel?.isTextBased() && "send" in channel) {
            await channel.send({ content: message, allowedMentions: { parse: [] } });
          }
        }).catch(() => console.error("VC チャットへの負荷通知に失敗しました。"));
      }
    },
  }, root);
  const recording = new RecordingSessions(repository, audio, options, root);
  const bot = createBot(options.discord, client, recording, { repository, options });
  let stopping: Promise<void> | undefined;

  function stop() {
    stopping ??= (async () => {
      try {
        await bot.shutdown();
        console.log("Bot を停止しました。");
      } catch {
        process.exitCode = 1;
        console.error("Bot の終了処理でエラーが発生しました。");
      } finally {
        repository.close();
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    })();
    return stopping;
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await bot.start(token);
    if (!stopping) console.log("Discord Gateway に接続し、コマンドを登録しました。");
  } catch (error) {
    if (stopping) return;
    process.exitCode = 1;
    console.error(error instanceof Error ? error.message : "Bot を起動できませんでした。");
    await stop();
  }
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : "Bot を起動できませんでした。");
}
