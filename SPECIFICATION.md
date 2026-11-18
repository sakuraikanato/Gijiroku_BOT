# Discord VC文字起こし・要約Bot 仕様書

> 本書はプロダクトの機能・データ・動作仕様のみを扱う。AIエージェントの開発規約・テスト手順は `AI_GUIDELINES.md`、環境構築・インストール・起動手順は `SETUP.md` を参照する。

## 1. 目的とスコープ

Discordのボイスチャンネル（VC）に参加している会話をユーザー単位で文字起こしし、専用テキストチャンネルに短期要約・長期要約を**新規メッセージ**として投稿する。VCに参加できなかったメンバーや途中参加者が、時系列を追いながら議論の進捗・決定事項・未決事項を把握できるようにする。

- 複数のDiscord Guild（サーバー）で同時利用可能とする。
- 初期仕様では1 GuildにつきアクティブなVCセッションは最大1件とする。
- SQLiteを唯一の正本（Source of Truth）とし、Discordへの投稿は表示・通知のための副次的な出力とする。
- 録音の長期保存や過去セッションへの自動再接続は初期スコープに含めない。

## 2. 用語

| 用語 | 定義 |
|---|---|
| Guild | Discordサーバー。設定・セッション・表示権限の分離単位 |
| Session | BotがVCに参加してから終了するまでの1回の会話記録 |
| Transcript | 発言者、音声取得時刻、認識テキストを持つ文字起こし単位 |
| Short Summary | 未処理のTranscriptを対象とする差分要約。表示用の新規投稿 |
| Long Summary | 前回までの長期状態を引き継ぎ、今回追加されたShort Summaryを反映した累積要約。新規投稿 |
| Fallback | AI要約を利用できない期間に、要約の代わりに文字起こしを直接投稿する処理 |

## 3. システム構成

### 3.1 コンポーネント

- **Discord Bot（TypeScript）**: Slash Command、VC接続、ユーザー・音声ストリームの識別、通知、Discordメッセージとボタン操作を担当する。
- **音声処理モジュール（Rust）**: Opusデコード、PCM変換、VAD、音声認識（ASR）、キュー・並列実行を担当する。Node.jsとの境界には `napi-rs` を採用する方針。
- **SQLite**: Guild、Session、Transcript、Summary、Job、投稿結果を永続化する。
- **Summary Worker（独立プロセス）**: 永続化されたJobを取得し、要約API呼び出し、結果検証、DB保存、Discord投稿を担当する。
- **AI Provider**: 初期はOpenAI APIを想定し、将来別プロバイダーへ切り替えられる抽象化を設ける。

### 3.2 処理フロー

1. Slash CommandでSessionを開始し、VCの各参加者の音声を受信する。
2. 取得時刻・発言者IDを付与した音声を共通ASRキューへ渡す。
3. Rust側でOpus → PCM → VAD → ASRを実行し、TranscriptをSQLiteに記録する。
4. トリガー成立時、対象TranscriptのIDを確定してShort Summary Jobを保存する。
5. Workerが対象Transcriptを結合して要約し、結果をSQLiteに保存した後、Discordに新規投稿する。
6. Long Summaryのトリガー成立時、未取り込みShort Summaryを確定して累積要約を生成・保存・新規投稿する。
7. VC終了時は残余音声・Transcript・要約を確定し、Sessionを終了する。

## 4. Discord操作・表示

### 4.1 コマンド

初期コマンド案は以下とする。権限や引数の詳細は実装時に確定する。

| コマンド | 機能 |
|---|---|
| `/setup` | Guild専用の要約投稿先テキストチャンネルを設定する |
| `/start` | 対象VCでSessionを開始する |
| `/stop` | Sessionを正常終了する |
| `/status` | 現在の接続状態・キュー状態・Session状態を確認する |
| `/config` | 設定状況を表示する（JSONの実行時変更は行わない） |

- Guildごとに専用のテキストチャンネルを1つ設定する。
- Short SummaryとLong Summaryは**必ず新規メッセージ**として投稿する。既存投稿の編集で置き換えない。
- キュー負荷・取り込み停止・再開の警告は、要約チャンネルではなく**参加中VCに関連付いたチャット**へ通知する。
- Bot再起動後に以前のVCへ自動再接続しない。

### 4.2 ボタンによる詳細表示

- **Short Summaryの「元の文字起こし」ボタン**: 当該要約に属するTranscriptのみをEphemeral応答で表示する。長文はページ分割する。
- **Long Summaryの「今回の短期要約」ボタン**: 前回のLong Summary以降に今回取り込んだShort SummaryのみをEphemeral応答で表示する。長文はページ分割する。
- 表示対象はDB上の関連テーブルから決定し、投稿本文を解析して復元しない。
- Discordのメッセージ長、コンポーネント数、Interaction応答期限などの制限を考慮する。

## 5. 音声取得・文字起こし

### 5.1 入力と認識

- DiscordユーザーIDと音声ストリームを対応付け、話者ごとに認識する。
- Opusデコード後、ASRに適したPCMへ変換する。初期候補は16 kHz・16-bit PCM。
- VADにより無音区間を検出し、ASR投入を抑制する。
- ASRエンジンはWhisper系（初期モデル候補: Tiny）を想定する。日本語・英語への対応を考慮する。
- ブラックリストに登録されたユーザーIDの音声は処理対象外とする（音楽Bot等を想定）。
- ASRの同時処理数は設定可能とし、ハードウェアの処理能力に応じて調整する。

### 5.2 順序保証

- Transcriptの時系列は**ASR完了時刻ではなく音声取得時刻**を基準とする。
- 音声取得時にタイムスタンプと安定した取得順序識別子を付与する。
- 同時発話など時刻が重複する場合も、同一Session内で決定的な順序を再現できるようにする。
- DB保存や要約への入力はこの順序を尊重する。

### 5.3 全Guild共通ASRキュー

ASR待ちキューはGuildごとではなく**プロセス全体で共有**する。ユーザー数の固定上限は設けない。

| 設定 | 初期候補値 | 動作 |
|---|---:|---|
| 最大キュー件数 | 100 | 許容量の上限 |
| 第1しきい値 | 60 | 関連VCチャットへ負荷警告を通知 |
| 第2しきい値 | 85 | 全VCの新規音声取り込みを一時停止して通知 |
| 再開条件 | 60未満 | 全VCの音声取り込みを再開して通知 |
| ASR並列数 | 1 | 実測に基づき増加可能 |

これらの数値は**確定値ではなく調整可能な初期候補**とする。満杯・停止中に受け取れなかった音声は黙って捨てず、欠落を検知・記録し、ユーザーへ状況を通知する。音声の無制限なメモリ滞留は認めない。停止・再開時の通知重複は抑制する。

## 6. 短期要約（Short Summary）

### 6.1 役割

未処理Transcriptの差分を、参加できなかった人が素早く追える粒度で要約する。短期要約は**内部状態だけでなく、Discordに投稿する表示物**とする。

### 6.2 生成トリガー

以下は調整可能な初期候補であり、いずれかを満たすと生成を検討する。

- 新規認識テキストが約2,000文字に達する。
- 前回処理から約3分経過する。
- 約30秒の無音が続く。
- 文字数到達後の約30秒のデバウンスを適用する。
- Session終了時に未処理分をフラッシュする。

対象が空の場合は要約を作成しない。複数トリガーが同時に発生しても、同じTranscriptが重複して別の短期要約へ取り込まれないよう、対象IDを永続化して確定する。

### 6.3 出力

- 内容は話題、要点、決定・保留事項などを中心とする。
- 元のTranscriptとの関連を `short_summary_transcripts` に保存する。
- 保存後、専用チャンネルへ新規投稿する。
- 投稿には対応Transcriptを確認できるボタンを付ける。

## 7. 長期要約（Long Summary）

### 7.1 役割

長期要約は単純な追記ログではなく、**それまでの議論の最新状態を表す累積スナップショット**とする。新しい発言によって決定が取り消された場合やTODOが完了した場合、状態を更新する。

### 7.2 生成トリガー

- 前回のLong Summary以降にShort Summaryが3件追加された場合。
- 前回のLong Summaryから約15分経過し、未取り込みShort Summaryが存在する場合。
- Session終了時に未取り込みShort Summaryが存在する場合。

いずれも初期候補値。**新しい差分がない時間経過だけでは生成しない**。

### 7.3 対象と整合性

- `short_summaries.imported_into_long_summary_id IS NULL` の行だけを次回候補とする。
- Job作成時点で対象Short SummaryのIDと順序を `summary_job_short_summaries` に固定する。
- 直前のLong Summaryと今回のShort Summary群を入力として新しい累積状態を生成する。
- Long Summary保存と、対象Short Summaryの `imported_into_long_summary_id` 更新を**同一DBトランザクション**で確定する。
- `long_summary_sources` に取り込み元を保存し、今回追加されたShort Summaryを追跡可能にする。
- 同一SessionのLong Summary生成は直列化し、同時Jobによる二重取り込みを防止する。
- 新しいLong Summaryも必ずDiscordに新規投稿し、今回取り込んだShort Summaryを開くボタンを付ける。

### 7.4 出力データモデル案

```typescript
interface LongSummary {
  overview: string;
  decisions: {
    content: string;
    status: "confirmed" | "pending" | "cancelled";
    sourceTranscriptIds: number[];
  }[];
  todos: {
    assigneeId: string | null;
    content: string;
    status: "pending" | "completed" | "cancelled";
    sourceTranscriptIds: number[];
  }[];
  topics: {
    title: string;
    summary: string;
    sourceTranscriptIds: number[];
  }[];
  sourceShortSummaryIds: number[];
}
```

出力には概要、話題、決定事項、未決事項、TODOと担当者、事実と推測の区別を含める。AIが返す参照IDは入力に存在する同一Session内のIDに限る。

## 8. AI要約・フォールバック

- 要約APIはプロバイダーを抽象化し、初期候補としてOpenAIを利用する。
- 応答は構造化JSONとし、スキーマ・列挙値・参照IDを検証する。
- AI入力には必要なTranscriptやShort SummaryをDBから組み立てて渡す。
- 発言テキストは信頼できない入力として扱い、要約処理への命令として解釈しない。
- APIキー未設定、API障害、タイムアウト、検証不合格などで要約不能な場合は、該当期間の**文字起こしを直接Discordへ投稿**する。
- フォールバック期間は後から自動で要約し直さない。
- タイムアウト初期候補は60秒とし、設定可能にする。
- フォールバックした対象IDと結果をDBへ記録し、通常要約との重複処理を防止する。

## 9. データベース仕様

### 9.1 基本方針

- SQLiteを正本とする。Discord投稿が失敗しても、保存済みTranscript・Summaryは消さない。
- SQLiteはWALとbusy timeoutを利用する。
- AI APIやDiscord APIの通信中にDBトランザクションを保持しない。
- 全Guild/Session所属データは `guild_id`・`session_id` を持ち、複合外部キー・一意制約・アプリケーション検証で越境参照を防ぐ。
- IDの大小や連番範囲からGuild/Session所属を推定しない。

### 9.2 主要テーブル

| テーブル | 主な内容 |
|---|---|
| `guilds` | Guild ID、投稿先チャンネル、Guild固有設定 |
| `sessions` | ID、Guild ID、VC ID、投稿先ID、状態、開始・終了時刻、要約連番 |
| `participants` | Guild/Session、DiscordユーザーID、入退室時刻 |
| `transcripts` | Guild/Session、ユーザーID、テキスト、取得開始・終了時刻、順序、認識メタデータ |
| `short_summaries` | Guild/Session、連番、JSON内容、取り込み先Long Summary ID（nullable）、状態、Discord投稿ID、時刻 |
| `short_summary_transcripts` | Short SummaryとTranscriptの対応、順序 |
| `long_summaries` | Guild/Session、連番、直前のLong Summary ID、JSON内容、最終フラグ、投稿情報 |
| `long_summary_sources` | Long Summaryに今回取り込んだShort Summaryの対応 |
| `summary_jobs` | Guild/Session、種類、状態、ロック・期限、試行回数、エラー、時刻 |
| `summary_job_short_summaries` | Long Summary Jobに固定されたShort Summary IDと順序 |

Short Summary JobのTranscript対象も作成時に固定し、永続化する。必要なら専用のJob–Transcript対応テーブルを追加する。`imported_into_long_summary_id` は同一Session内のLong Summaryだけを参照可能とする。

### 9.3 Job処理

- BotとWorkerは別プロセスとし、DBを介して作業を受け渡す。
- Workerは期限付きリース（`locked_by`、`locked_until`）を用い、異常終了後にJobを再取得できるようにする。
- Session間の処理は並列化可能だが、同一SessionのLong Summaryは順序保証する。
- Short SummaryのDiscord投稿順もSession内で維持する。
- Discordへの投稿はDBコミットと原子的に扱えない。**投稿失敗時の自動再送は初期仕様では必須としない**。必要なら投稿結果・エラーを記録する。
- 再試行時は要約の二重生成や取り込み重複を防ぐ。Discord投稿の厳密なexactly-once保証は行わない。

## 10. 設定仕様

プロジェクトルートの `options/` 以下にJSONを配置する。**設定は各プロセスの起動時に一度だけ読み込む**。稼働中にファイルを書き換えても反映されず、該当プロセスの再起動で反映される。BotとWorkerはそれぞれ独立して設定を読み込む。

| ファイル | 内容 |
|---|---|
| `options/app.json` | 実行環境、タイムゾーンなど |
| `options/discord.json` | Discord接続・Guild/チャンネル関連設定 |
| `options/database.json` | DBパス、WAL、busy timeout |
| `options/asr.json` | ASRモデル、言語、VAD、キュー上限・しきい値、並列数、ユーザーブラックリスト |
| `options/summary.json` | 短期・長期要約のトリガー値 |
| `options/ai.json` | AIプロバイダー、モデル、タイムアウト等 |
| `options/retention.json` | 保存期間、削除設定 |
| `options/worker.json` | Job取得間隔、リース期間等 |
| `options/prompts/short.json` | 短期要約用 `systemPrompt` / `userPrompt` |
| `options/prompts/long.json` | 長期要約用 `systemPrompt` / `userPrompt` |

- JSON構文・型・値域は起動時に検証し、不正なら対象ファイル・項目を明示して起動失敗とする。
- プロンプトはWorker起動時に読み込む。**プロンプトのバージョン管理機能は実装しない**。
- プロンプトの変数展開は許可済み変数だけとし、任意コードを実行しない。
- APIトークンなどの秘密情報をGitにコミットしない。秘密値の受け渡し方法は運用設定で定める。

## 11. Sessionの状態遷移と復旧

### 11.1 状態

`starting` → `running` → `stopping` → `ended` を基本遷移とする。失敗時も最終的に終了状態へ移す。

### 11.2 正常終了

1. 新しい音声取り込みを停止する。
2. 受信済み音声とASR待ち処理を可能な範囲で完了する。
3. 残りのTranscriptから最後のShort Summary（またはFallback）を確定する。
4. 未取り込みShort Summaryがあれば最後のLong Summaryを確定する。
5. DB保存と必要なDiscord投稿を処理し、Sessionを終了状態にする。
6. VC接続と処理資源を解放する。

### 11.3 再起動時

- 既存のVC接続は切断し、過去Sessionへ自動再接続しない。
- `starting`: 最終要約を作らず終了扱いにする。
- `running`: **永続化済み**の残作業を処理して最終出力を確定し、終了扱いにする。
- `stopping`: 永続化済みの残作業を完了させて終了扱いにする方針とする。
- 復旧不能なSessionは終了扱いにし、理由を記録する。
- 未保存のメモリ上の音声は復元できない。Workerの途中Jobはリース期限切れ後に回収する。

## 12. 保存期間・アクセス制御

- Transcript、Short Summary、Long Summary、関連Jobなどの保存期間は**約1年（初期候補365日）**とする。
- 保存期間の起点は原則Session終了時刻とする。
- 期限切れデータは関連テーブルの参照整合性を保って定期的に削除する。
- Guildメンバーのみが専用テキストチャンネルの投稿を閲覧できるよう、Discordのチャンネル権限を設定する。
- ボタンからの詳細閲覧でもGuild/Sessionの一致と閲覧権限を検証し、他Guildの情報を漏らさない。
- 認証情報・音声・文字起こしのログ出力は必要最小限にし、秘密情報を出力しない。

## 13. 非機能要件・未確定事項

### 13.1 非機能要件

- 複数Guild間のデータ分離と、Session内の決定的な時系列を保証する。
- メモリ上の音声・ASRキューは有界とし、負荷上昇を検知・通知する。
- SQLiteへの永続化をDiscord投稿より優先する。
- リアルタイム性を重視するが、固定の遅延SLOは現時点で定めない。
- 要約が利用できない場合も、文字起こしを通じて議論の内容を追えるようにする。

### 13.2 実装前・実機で確認する事項

1. 使用するDiscord音声受信ライブラリのDAVE対応と、ユーザー別受信の実現性。
2. VCに関連付いたチャットへの通知方法と必要なDiscord権限。
3. `napi-rs`を介したRust音声処理とBun/Node互換実行環境の動作。
4. 想定CPUでのWhisperモデル別処理速度、VAD精度、実用並列数。
5. キュー停止時の欠落記録の粒度、ASR入力単位、再開時の扱い。
6. 同時発話時のTranscript区切り・タイムスタンプ精度。
7. Discord投稿失敗時の表示上の扱いと、必要な観測情報。
8. 要約・Fallbackの境界、Jobリースの競合、異常終了時の最終出力確定。

---

**文書の境界**: 本書はアプリケーション仕様のみ。AIエージェントの制約・テスト実施フローは `AI_GUIDELINES.md`、開発環境の準備・コマンド・起動方法は `SETUP.md` に記載する。
