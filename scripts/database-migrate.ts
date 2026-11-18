import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadOptions } from "../packages/shared/src/options";
import { SqliteRepository } from "../packages/shared/src/database";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = loadOptions(resolve(root, "options"));
const repository = new SqliteRepository(resolve(root, options.database.path), options.database.busyTimeoutMs);
repository.close();
console.log("SQLite のマイグレーションを適用しました。");
