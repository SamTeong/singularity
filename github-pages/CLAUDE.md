# CLAUDE.md — editing the deck

This app is a **slide deck**: fifteen chapters ("slides") mounted as real DOM
inside one persistent Three.js world, toured by a scroll-driven camera on rails.
Adding, removing, and reordering slides is the routine edit; its runbook is
`../.claude/rules-reference/deck-editing.md`.

Read `README.md` first for the architecture. This file is only about editing slides.

## The mental model

A slide is **one row in a ledger plus one React component**. Everything else is
derived:

```
src/config/chapters.ts   ← the ledger. Order, ids, camera placement, HUD copy,
                            per-slide atmosphere. THE source of truth.
        │
        ├──► Chapters.tsx renders one <Spacer> + <Section> per entry, in ledger
        ├──► the scroll conductor derives anchors from each entry's `weight`
        ├──► the world derives camera waypoints from `u` / `yaw` / `pitch` /
        │      `fill` / `lift` — you never author a camera position
        └──► the HUD, chapter rail and top bar read `num` / `jp` / `code` /
               `title` / `sub`
```

**Never hand-author a camera position.** Waypoints are computed: each is the
slide's anchor pushed out along its own face normal by exactly the distance that
frames it at the current aspect ratio (`framingDistance` in `cameraPath.ts`).
That is why the composition survives any window size. Tune `u`/`yaw`/`fill`, not
the camera.

---

Add/remove/reorder slide steps, and how to choose `u`/`yaw`/`pitch`: read `../.claude/rules-reference/deck-editing.md` before such an edit. Invariants, auto-loaded on `github-pages/**` edits (React/CSS3DObject contract, `three` import limit, BASE_URL, no-WebGL fallback, autoplay, reduced motion): `../.claude/rules/deck-invariants.md`.

## After editing — always

```bash
pnpm build && pnpm lint          # the unions and the component map are exhaustive
node scripts/verify-world.mjs    # 32 checks: boots, panels mount, scroll drives
                                 # the camera, fallback + teardown are clean
```

`verify-world.mjs` needs the app served — `pnpm build && npx vite preview --port 4319`,
or point it elsewhere with `APP_URL=…`. It uses the root repo's `playwright-core`
under SwiftShader, so its FPS numbers are meaningless; ignore them.

Then **look at it**: `pnpm dev` and scroll the whole deck. This project's history
is explicit that every real bug in the original build was found by looking at
rendered output and none by DOM assertions. A slide can be structurally perfect
and still be facing the wrong way, clipped by its bezel, or parked inside a wall.
