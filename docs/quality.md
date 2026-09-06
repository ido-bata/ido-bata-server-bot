# Verification policy

Stack-aware quality gate. **Quality is not a fixed bundle** — it's compiled from what this project actually is: a small TypeScript ESM Discord bot on Node + Bun tooling.

## Gate

Required for any merge into the active release branch:

```sh
bun install --frozen-lockfile     # reproducible dependency set
bun run lint                       # eslint (typescript-eslint)
bun run type-check                 # tsc --noEmit, no JS emitted
bun run test                       # vitest run (Unit + Component)
bun run build                      # tsc emit to dist/
bun run knip                       # unused files / dependencies / exports
bun run biome                      # formatting + import sort
```

Timekeeper voice changes additionally run `bun run smoke:stage` against the configured stage channel.

## Verification taxonomy applied to this repo

| Level        | When it's required                                                              | Tool used here                              |
| ------------ | ------------------------------------------------------------------------------- | ------------------------------------------- |
| Unit         | Any logic-only change (config parsing, timeline math, playback budgeting)       | Vitest (`tests/*.test.ts`)                  |
| Smoke        | Changes touching startup wiring, DI seams, Discord client construction           | `bun run start` against `.env` with fake token to confirm config validation, plus a Vitest covering the construction path (`tests/create-discord-client.test.ts`) |
| Integration  | Anything that talks to Discord (reactions, voice, message posting)              | Vitest with DI seams (`HandlerDependencies`) — fakes the Discord surface |
| Contract     | Timekeeper timeline shape (12 events for the 5-phase default)                   | Vitest (`tests/timekeeper-timeline.test.ts`) covering event order, names, and WAV-prefix mapping |
| System / E2E | Full voice + stage round-trip — manual `bun run smoke:stage` against real guild | Manual `bun run smoke:stage`                 |

`unit test passing` is **not** accepted as proof of smoke / integration correctness. The two tiers must both be green for that verification band.

## Coverage

We do not enforce a coverage threshold on this project — the signal-to-noise is too low for the current surface area. CI output and knip's unused-export list serve as the lightweight coverage proxy. Add coverage if/when the source tree crosses an order of magnitude in size.

## False-green guard

- Never commit a test with `.only` / `.skip` / `it.todo` left behind.
- Never pipe a validation step through `|| true` or otherwise swallow its exit code.
- A `green` badge from a previous run on a stale base SHA is **not** a green gate; re-run after any rebase.
