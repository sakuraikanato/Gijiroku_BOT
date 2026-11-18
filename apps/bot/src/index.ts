import { fileURLToPath } from "node:url";
import { loadOptions } from "@gijiroku/shared/options";
import { createBot, readBotToken } from "./bot";

async function main() {
  const options = loadOptions(fileURLToPath(new URL("../../../options/", import.meta.url)));
  const token = readBotToken(options.discord, process.env);
  const bot = createBot(options.discord);
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
    if (!stopping) console.log("Discord Gateway に接続し、/start・/stop・/status を登録しました。");
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
