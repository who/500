# 500

Five Hundred — card game engine, bots, and web UI monorepo.

## End-to-end smoke test

```bash
pnpm e2e
```

One command, no external services: builds every package, boots the built
server (which serves the built client), and drives a real headless Chromium
through a full scripted hand — create room, seat one human plus three Easy
bots, pass through the auction, play legal cards to the hand-end overlay —
asserting the seeded contract and zero browser console errors.

Determinism comes from `TEST_SEED`, an env var the server honors only when
set: it fixes the game seed and removes bot pacing delays. The pinned seed
and the contract it produces live in `e2e/seed.ts`; if engine or bot changes
shift the seeded decision stream, the contract assertion fails loudly —
rerun `e2e/pick-seed.ts` (instructions in its header) to pick a new seed.

First run may need the Playwright browser: `pnpm exec playwright install chromium`.
