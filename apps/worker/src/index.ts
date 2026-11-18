import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteRepository } from "../../../packages/shared/src/database";
import { loadOptions } from "../../../packages/shared/src/options";
import { tickRepository } from "../../../packages/shared/src/scheduling";
import { processOne } from "./processor";

async function main() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const options = loadOptions(resolve(root, "options"));
  const repository = new SqliteRepository(resolve(root, options.database.path), options.database.busyTimeoutMs);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Summary Worker を起動しました。");
  let lastPurge = 0;
  try {
    while (!abort.signal.aborted) {
      try {
        const now = Date.now();
        tickRepository(repository, options, now);
        if (now - lastPurge >= 60_000) {
          repository.purgeExpired(options.retention.retentionDays, now);
          lastPurge = now;
        }
        if (await processOne(repository, options, { signal: abort.signal })) continue;
      } catch {
        if (!abort.signal.aborted) console.error("Worker の処理でエラーが発生しました。期限切れのジョブは再取得されます。");
      }
      if (!abort.signal.aborted) {
        await new Promise<void>((done) => {
          const finish = () => {
            clearTimeout(timer);
            abort.signal.removeEventListener("abort", finish);
            done();
          };
          const timer = setTimeout(finish, options.worker.pollIntervalMs);
          abort.signal.addEventListener("abort", finish, { once: true });
        });
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    repository.close();
    console.log("Summary Worker を停止しました。");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith("options/")
      ? error.message
      : "Summary Worker を起動できませんでした。設定と DB のアクセス権を確認してください。");
    process.exitCode = 1;
  }
}
