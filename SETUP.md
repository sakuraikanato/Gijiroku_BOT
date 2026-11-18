# 開発環境構築手順

> 対象: Discord VC文字起こし・短期／長期要約Bot  
> **前提**: Rust、Cargo、Bunはインストール済み。本書ではそれらのインストール手順を省略する。  
> 推奨開発環境: Ubuntu Linux（本番候補: Ubuntu Server 24.04 LTS）。macOS・WindowsではOS依存の音声／ネイティブビルド差異を別途確認する。

## 1. 構成方針

- TypeScriptアプリ: Bunで依存関係の管理、スクリプト実行、プロセス起動を行う。
- Rustネイティブ処理: Cargoでビルド・テストを行う。
- Rust↔TypeScript: `napi-rs` でNode-API互換のネイティブモジュールを作成する。**Bunからのロード互換性をPoCで先に検証する**。
- BotとSummary Workerは別プロセスとして起動する。
- DBはSQLite（WALモード）。AIプロバイダーは初期状態でOpenAIを想定するが、キー未設定時の生ログフォールバックを実装する。
- Discordの音声受信は `discord.js`／`@discordjs/voice` を候補とし、DAVE対応を検証してから固定する。

## 2. インストール済みツールの確認

### Windows PowerShell での初期開発環境

このリポジトリの初期構成では、ルートで以下を実行して依存関係と開発環境を確認できる。Rust の MSVC ターゲットには Visual Studio Build Tools の C++ ビルドツールと Windows SDK が必要。

```powershell
# Bun が未導入で、このプロジェクト内に配置する場合だけ実行
npm install --prefix .tools --no-package-lock --no-audit --no-fund bun
# .tools に配置した場合は、新しい PowerShell を開くたびに実行
$env:Path = "$PWD\.tools\node_modules\bun\bin;$env:Path"

# Rust 音声処理のビルドに必要。Python と CMake が利用できる環境で実行
python -m pip install --target .tools/clang libclang==18.1.1
$env:LIBCLANG_PATH = "$PWD\.tools\clang\clang\native"

bun --no-env-file install --frozen-lockfile
bun --no-env-file run typecheck
bun --no-env-file test
cargo check --locked --workspace
bun --no-env-file run build:audio
bun --no-env-file run check:audio
```

`check:audio` は生成した `target/napi/index.node` を読み込み、整数の応答、バッファを使う非同期処理、空バッファのエラー伝搬を確認する。SQLite の検証には一時 DB を使用する。

Bot・Worker の起動は「9. 起動手順」を使用する。音声処理は `opus` と `whisper-rs` を使い、16 kHz のモノラル PCM とエネルギーしきい値による VAD を使用する。`options/asr.json` の `vadThreshold` は省略時 0.008、設定範囲は 0 より大きく 1 以下。ASR 並列数は `maxParallelTasks` で設定する。Windows のネイティブビルドでは長いパスを避けるため一時フォルダーのビルドキャッシュを使用する。

Whisper モデルを `models/ggml-tiny.bin` に配置してから `/start` を実行する。今回検証に使用したのは [whisper.cpp 公開モデル](https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-tiny.bin) で、SHA256 は `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21`。

```powershell
New-Item -ItemType Directory -Force models | Out-Null
Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin' -OutFile models/ggml-tiny.bin
bun run db:migrate
```

モデル、合成音声、DB、音声モジュールは Git 除外対象。音声認識の再検証用に、Windows の SAPI で自作の英文を生成できる。

```powershell
pwsh -File scripts/audio-fixture.ps1
cargo run -p audio --example encode_fixture -- models/audio-fixture.wav models/audio-fixture.opuspackets
bun run test:audio
```

### バージョン確認

```bash
rustc --version
cargo --version
bun --version
```

Ubuntuでは追加で基本的なネイティブビルドツールとSQLite開発ヘッダーを用意する。

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev libsqlite3-dev git ca-certificates
```

> `whisper-rs`／whisper.cpp、Silero VAD／ONNX Runtime、Opus関連クレートの組み合わせによっては、CMake、Clang、Opus開発ライブラリ等が追加で必要になる。実際に選定したクレートのビルドエラーと公式要件に従って導入する。不要な依存を先に大量導入しない。

## 3. ディレクトリ構成

```text
project/
├── apps/
│   ├── bot/
│   │   ├── src/
│   │   └── package.json
│   └── worker/
│       ├── src/
│       └── package.json
├── crates/
│   └── audio/
│       ├── src/
│       └── Cargo.toml
├── packages/
│   └── shared/
│       └── package.json
├── migrations/
├── options/
│   ├── app.json
│   ├── discord.json
│   ├── database.json
│   ├── asr.json
│   ├── summary.json
│   ├── ai.json
│   ├── retention.json
│   ├── worker.json
│   └── prompts/
│       ├── short.json
│       └── long.json
├── models/
├── data/
├── logs/
├── package.json
├── Cargo.toml
├── AI_GUIDELINES.md
└── SETUP.md
```

ルートはBun workspace、Rust側はCargo workspaceとして管理する。

### ルート `package.json` の例

```json
{
  "name": "discord-vc-summary",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev:bot": "bun run --cwd apps/bot dev",
    "dev:worker": "bun run --cwd apps/worker dev",
    "typecheck": "bun run --filter '*' typecheck",
    "test": "bun test"
  }
}
```

> 各workspaceの`dev`／`typecheck`スクリプトは実装時に定義する。`bun run --filter '*' typecheck` は全workspaceに対象スクリプトがある構成を前提とするため、実際のパッケージ構成に合わせて調整する。

### ルート `Cargo.toml` の例

```toml
[workspace]
members = ["crates/audio"]
resolver = "3"
```

### `crates/audio/Cargo.toml` の最小例

```toml
[package]
name = "audio"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "3", features = ["napi4"] }
napi-derive = "3"
```

> バージョンは構成例であり、採用時点で最新の互換性とロックファイルを確認する。Rust単体テスト用に `rlib` を併記する構成も検討する。

## 4. TypeScriptの依存関係

ルートで以下を実行する。

```bash
bun install
```

新規作成時のパッケージ追加例:

```bash
# Discord Bot
cd apps/bot
bun add discord.js @discordjs/voice
bun add -d typescript @types/bun

# Summary Worker
cd ../worker
bun add zod
bun add -d typescript @types/bun

cd ../..
```

- SQLiteアクセスにはBun組み込みの `bun:sqlite` を利用する案がある。Bot・WorkerがともにBun実行であることを前提に採用可否を決める。
- 共通型は `packages/shared` にまとめる。
- Discord音声の受信・暗号化対応とBun互換性は、**実際にVCへ参加し音声フレームを受信できるか**を確認する。単にインストールや接続に成功しただけでは完了としない。
- AI SDKは実装するプロバイダーに応じてWorkerへ追加する（例: `bun add openai`）。
- Whisperモデル・VADモデルは通常、Gitへコミットせず `models/` に配置する。

## 5. Rustネイティブモジュールのビルド

まずCargoの構成を確認する。

```bash
cargo check --workspace
cargo test --workspace
```

`napi-rs` のビルド用CLIを開発依存に追加する例:

```bash
bun add -d @napi-rs/cli
```

ネイティブモジュールの実際の生成手順は、採用する`napi-rs`バージョンとパッケージ構成に合わせて設定する。最初に以下の最小PoCを成立させる。

1. Rustから文字列または整数を返す `#[napi]` 関数を公開する。
2. `napi-rs` CLIで `.node` ファイルを生成する。
3. Bunで `.node` ファイルを読み込み、戻り値を確認する。
4. 音声バッファの受け渡し、エラー、非同期処理、プロセス終了時の解放を検証する。

> **重要**: `.node` の生成場所やCLI引数を、未確認のまま固定しない。`bunx napi --help` と利用中の公式ドキュメントで確認してからスクリプト化する。

## 6. Discord Botの準備

1. Discord Developer PortalでアプリケーションとBotを作成する。
2. Botトークンを取得する。トークンはGitにコミットしない。
3. 必要なGateway Intentsを選択する。VC参加者情報・コマンド・音声受信の要件に合わせ、実装で必要な権限のみを許可する。
4. Botをテスト用Guildに招待し、Slash Commandの利用、VCへの接続、対象テキストチャンネルへの投稿・履歴参照に必要な権限を与える。
5. `/setup` でGuildごとの要約投稿先チャンネルを登録できるようにする。
6. 実機で音声受信の可否、発話者との紐付け、DAVE対応を検証する。

> Developer Portal上の項目名や音声受信の仕様は変更される場合があるため、実装時点のDiscord公式ドキュメントを確認する。

## 7. 設定ファイルの準備

`options/` の各JSONを作成する。次は**設定項目の構成例**であり、実装の正式なJSON Schemaと一致させてから使用する。

### `options/asr.json` の例

```json
{
  "modelPath": "models/ggml-tiny.bin",
  "language": "auto",
  "sampleRate": 16000,
  "maxParallelTasks": 1,
  "queue": {
    "maxItems": 100,
    "warningThreshold": 60,
    "pauseThreshold": 85,
    "resumeBelow": 60
  },
  "blacklistedUserIds": []
}
```

### `options/summary.json` の例

```json
{
  "short": {
    "characterThreshold": 2000,
    "elapsedSeconds": 180,
    "silenceSeconds": 30,
    "debounceSeconds": 30
  },
  "long": {
    "newShortSummaryThreshold": 3,
    "elapsedSeconds": 900
  }
}
```

### `options/database.json` の例

```json
{
  "path": "data/database.sqlite",
  "journalMode": "WAL",
  "busyTimeoutMs": 5000
}
```

### `options/ai.json` の例

```json
{
  "provider": "openai",
  "model": "<利用可能なモデル名>",
  "timeoutMs": 60000,
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

### `options/prompts/short.json` の例

```json
{
  "systemPrompt": "会話の事実関係を保ち、推測を事実として扱わずに短期要約してください。",
  "userPrompt": "次の文字起こしを要約してください: {{transcripts}}"
}
```

`long.json` も同様に `systemPrompt` と `userPrompt` を持つ。テンプレート変数は実装側で許可したものだけを使用する。**プロンプトのバージョン管理は不要**。

### 秘密情報の管理

推奨はトークンやAPIキーを環境変数に格納し、JSONには環境変数名のみを記述する方式。

```bash
export DISCORD_BOT_TOKEN='...'
export OPENAI_API_KEY='...'
```

`options/discord.json` の `tokenEnv` は既定で `DISCORD_BOT_TOKEN` を参照する。ローカルではリポジトリ直下の `.env` を Bun が読み込む。既定の変数が未設定の場合に限り、既存の `TOKEN` も使用できる。

**Git除外の例**:

```gitignore
.env
.env.*
!.env.example
node_modules/
target/
data/
logs/
models/
*.node
```

設定JSONに実際の秘密情報を直書きする場合、そのファイルもGit除外対象にし、コミットするのは秘密情報を含まない `.example.json` のみとする。

## 8. SQLiteの初期化

1. `data/` を作成する。
2. マイグレーションを実装する。
3. 起動時または専用コマンドでマイグレーションを適用する。
4. 外部キー制約、WAL、busy timeoutを**各DB接続で適切に設定**する。
5. 複数Guild／Session間の参照が混ざらないことをテストする。

```bash
mkdir -p data logs models
```

SQLiteの例:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

> `journal_mode` はDBファイルに保持される設定だが、`foreign_keys` と `busy_timeout` は接続ごとに設定する。`bun run db:migrate` で migration を適用でき、Bot と Worker の起動時にも適用される。

## 9. 起動手順

### Bot の初期設定

1. テスト用アプリをテスト用 Guild にインストールする。Bot に通常のボイスチャンネルの「チャンネルを見る」「接続」と VC チャットへの投稿、要約用テキストチャンネルの閲覧・投稿・メッセージ履歴参照を許可する。テスト担当者がアプリコマンドを使えることも確認する。
2. ルートの `.env` に `DISCORD_BOT_TOKEN` を設定する。既存の `TOKEN` でも起動できる。
3. `options/discord.json` の `commandGuildIds` にテスト用 Guild の ID を文字列で指定する。2つの Guild で試す場合は両方の ID を指定する。空配列の場合、コマンドはアプリをインストールした全 Guild に登録される。
4. リポジトリのルートで Worker と Bot を別ターミナルから起動する。Windows で Bun を `.tools` に入れた場合は第2節の PATH 設定を両ターミナルで実行する。Bot のコンソールに Gateway 接続とコマンド登録の完了が表示される。
5. サーバー管理権限を持つメンバーが、要約を投稿したいテキストチャンネルで `/setup` を実行する。そのチャンネルが Guild の投稿先として DB に保存される。`/config` で確認でき、変更は次の Session から反映される。
6. AI 要約を使用する場合は `.env` に `OPENAI_API_KEY` を設定し、`options/ai.json` の `model` に利用するモデル名を設定して Worker を再起動する。モデルが null、キー未設定、API 障害、応答不正のときは文字起こしを直接投稿する。

実機テストの5つのフロー、前提条件、期待結果、報告する観察点は [TEST_RESULTS.md](TEST_RESULTS.md) に記載する。

各項目の結果を「成功／失敗／一部成功／実施不可」で記録する。失敗時はコマンドへの応答、発生時刻と起動・終了ログを記録する。Bot は自己ミュートで参加し、ユーザー別に音声を受信する。実機 DAVE 音声受信は人間による確認対象とする。

### Bot・Worker の起動手順

両プロセスを**別ターミナル**で起動する。Worker を起動してから Bot で `/start` を実行する。終了時は Bot を停止し、最終出力と VC 退出が完了してから Worker を停止する。Bot は最終出力の完了を待つため、Worker が停止中なら Worker を再開する。

ターミナル1:

```bash
bun run dev:bot
```

ターミナル2:

```bash
bun run dev:worker
```

起動時には以下を確認する。

- 各プロセスが `options/` のJSONを読み込み、スキーマ検証に成功する。
- SQLiteに接続し、必要なmigrationが適用されている。
- Rust `.node` モジュールをロードできる。
- BotがDiscord Gatewayへ接続できる。
- Workerが永続化済みジョブを監視できる。
- APIキー未設定時にも、生ログフォールバック方針に沿って動作する。

設定ファイルの変更後は、変更を利用する**BotまたはWorkerを再起動**する。実行中の自動反映は行わない。

## 10. 初回動作確認の推奨順序

1. `cargo check --workspace` と `cargo test --workspace` が成功する。
2. `bun install`、TypeScript型チェック、単体テストが成功する。
3. BunからRustネイティブ関数を呼び出せる。
4. SQLiteマイグレーションとGuild分離テストが成功する。
5. AIプロバイダーとDiscord投稿をモックにしたWorker結合テストが成功する。
6. 音声テストファイルでASRと取得時刻順序を検証する。
7. BotのVC接続・音声受信・発話者紐付けを検証する。
8. Mainエージェントが最終段階でユーザーに**最大5件のDiscord手動テスト**をまとめて依頼する（詳細は `AI_GUIDELINES.md`）。

## 11. 本番運用へ移る前の確認

- CPU上のWhisper Tiny／Baseの実測処理速度、VAD精度、メモリ使用量を測定する。
- 複数Guildの同時使用、グローバルキューの停止・再開、Workerクラッシュ復旧を検証する。
- BotとWorkerのsystemdサービス化、再起動ポリシー、ログ管理を設計する。
- SQLiteバックアップはオンラインバックアップAPI等の整合性を保つ方法で取得する。
- 保持期限（初期案: Session終了から約1年）の削除処理を確認する。
- Discord投稿失敗時はDBの正本を保持する。自動再送が実装済みであると仮定しない。
- 音声の取得・保存・公開範囲について、参加者への周知と適用されるルールを確認する。

## 12. 未確定・実機検証が必要な点

- Discord音声受信のDAVE対応、`@discordjs/voice`とBunの組み合わせ。
- 日本語の実会話と長時間運転での音声認識・VAD 精度。
- Ubuntu・macOS での Opus／Whisper のビルドと実行。
- 5世代Core i5相当のCPUで達成できるASR速度・同時セッション性能。
- VCに関連付くテキストチャットへの負荷警告の実機表示。
- 実 AI モデルの会話内容に対する要約品質と累積状態の更新。

これらはPoCと実測で決定し、推測で「対応済み」と記載しない。
