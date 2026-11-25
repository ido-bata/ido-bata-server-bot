# Portfolio assets — ido-bata-server-bot

**状態: BLOCKED（画像未作成）** — 2026-11-25 時点で受入条件を満たす素材を制作できませんでした。偽の画面・モック・他製品の画像での代替は行っていません。

## ブロッカー

受入条件は「実際のBotが動作する**専用デモDiscordサーバー**で、リアクションロールまたはタイムキーパーの案内・動作が伝わる画面の撮影」。これには以下が必要です:

1. Bot が参加している**専用デモギルド**（実コミュニティサーバーは不可: 実メッセージ・ユーザー名・ID・招待URLを含めない要件のため）
2. そのギルドを閲覧できる Discord クライアント環境
3. （代替案）所有者による条件適合スクリーンショットの提供

## 調査済み事項（実施した確認）

- リポジトリ内に既存のメディア・スクリーンショット資産なし（全ブランチの git 履歴・Issue/PR 本文・コメントを検索、`user-attachments` 画像なし）
- `docs/`・`constitution/`・`organization/` にデモサーバー/検証用ギルドの記載なし
- 実行環境（この Mac）には `DISCORD_TOKEN` / `DISCORD_CLIENT_ID` / `DISCORD_GUILD_ID` が存在しない（`.env` は `.env.example` のみ、環境変数・dotfiles・`~/.config` を確認）
- Bot は Altare ホスティング移行中（`docs/operations/altare-migration.md`）。本番トークンを開発機で起動すると single-instance lease が共有バックエンド（Valkey）を向いていない限り**実ギルドで二重稼働する危険**があるため、安易なローカル起動は行わなかった
- Bot の TUI（`src/tui`）は実プロダクト画面だが、受入条件が「Discordサーバー上の画面」を要求するため代替不可。また TUI 起動にも `DISCORD_TOKEN` が必須（`src/config.ts` の Zod バリデーション）
- Discord.app はこの Mac で起動中だが、デモギルドの存在・Bot参加状況・画面操作権限が不明であり、ユーザーの実アカウント画面を無断で操作・撮影することはプライバシー上も要件上も不適切と判断

## 納品物

- なし（画像・補足ともに未作成）
- 本ファイルはブロッカーの記録として残す

## 再開に必要なもの（所有者アクション）

- [ ] 専用デモギルドの作成（または既存デモギルドの指定）と Bot の招待
- [ ] デモギルドでの reaction-roles または timekeeper の実動作確認
- [ ] 撮影用の資格情報（demo 用 bot token + guild id）を secret manager 経由で Worker に提供、または所有者による撮影
- [ ] 個人情報・実コミュニティ情報を含まない画面構成の確認
