# ido-bata-server-bot

Discord server bot for local development first, with future hosted deployment.

## Setup

1. Install Bun 1.3 or later.
2. Run `bun install`.
3. Provide the required environment variables — see [Environment](#environment). The exact source is left to the host (CI secret, secret manager, exported shell variables, or — only as a last resort — a local `.env` file that **is not committed**). `.env.example` documents the schema and is the source of truth; do not rely on it for real secrets.

If a bot token is ever pasted into chat, logs, a commit, or an agent result, rotate it immediately in the Discord Developer Portal and re-source the new value from your secret manager.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token from the Discord Developer Portal |
| `DISCORD_CLIENT_ID` | yes | Application (bot) client ID |
| `DISCORD_GUILD_ID` | yes | Development guild ID |
| `DISCORD_ENABLE_MESSAGE_CONTENT` | no | Set to `true` to enable the privileged Message Content intent (also enable it on the Developer Portal side) |
| `TIMEKEEPER_RUN_ON_READY` | no | `true` runs the timekeeper session immediately on `ClientReady` and compresses in-session minutes to 1 second for testing. Without it the timekeeper schedules for the next 21:00 JST. |

Validation lives in `src/config.ts` (Zod). The bot refuses to start with a clear error if a required variable is missing or empty.

## Commands

- `bun run dev`: Start the bot in watch mode.
- `bun run start`: Start the bot once.
- `bun run lint`: Run ESLint.
- `bun run test`: Run tests.
- `bun run build`: Type-check and build to `dist/`.

`bun` is used as the package manager and script runner, but the bot itself runs on Node via `tsx`. This is intentional because Discord voice features are more reliable there.

## Discord app notes

- Enable `MESSAGE CONTENT INTENT` and `SERVER MEMBERS INTENT` in the Discord Developer Portal.
- `DISCORD_ENABLE_MESSAGE_CONTENT=true` is only needed after `MESSAGE CONTENT INTENT` is enabled in the Discord Developer Portal.
- Avoid using an invite URL with `permissions=8` unless you intentionally want full administrator access.
- For early development, invite the bot with only the permissions it currently needs.

## Current scope

- Environment variable validation
- Discord client bootstrap with intents for:
  - guild events
  - message reactions
  - message content
  - voice state tracking

Next, feature handlers can be added for reaction roles, pinned templates, and voice timers.

## Reaction roles

Reaction role rules are defined in [`src/features/reaction-roles/config.ts`](./src/features/reaction-roles/config.ts).

Each rule needs:

- `messageId`: the target message to watch
- `emoji`: a unicode emoji like `🔥`, or a custom emoji ID
- `roleId`: the role to add or remove

Replace the placeholder values in that file with your real Discord IDs before testing the feature.

## Timekeeper

The daily timekeeper is configured in [`src/features/timekeeper/config.ts`](./src/features/timekeeper/config.ts).

Current behavior:

- Starts every day at `21:00` JST
- Joins the configured voice channel
- Plays one audio clip at each phase start
- Plays another audio clip one minute before each phase ends
- Sends a text message only at phase start

Before using it:

- Replace `textChannelId` and `voiceChannelId` with real Discord channel IDs
- Keep the generated wav files under `tmp-audio/`
- Ensure the bot can `View Channel`, `Send Messages`, `Connect`, and `Speak`
