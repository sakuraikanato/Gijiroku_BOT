import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const clang = resolve(root, ".tools", "clang", "clang", "native");
const environment = { ...process.env };
if (process.platform === "win32" && !environment.LIBCLANG_PATH && existsSync(resolve(clang, "libclang.dll"))) {
  environment.LIBCLANG_PATH = clang;
}
// MSBuild's temporary compiler projects still have a 260-character path limit.
const targetArguments = process.platform === "win32"
  ? ["--target-dir", resolve(tmpdir(), "gj-audio-" + createHash("sha256").update(root).digest("hex").slice(0, 8))]
  : [];
const result = Bun.spawnSync([
  process.execPath, "run", "napi", "build",
  "--manifest-path", "crates/audio/Cargo.toml",
  "--output-dir", "target/napi",
  ...targetArguments,
  ...process.argv.slice(2),
], { cwd: root, env: environment, stdout: "inherit", stderr: "inherit" });
process.exitCode = result.exitCode;
