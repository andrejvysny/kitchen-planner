# TODO — active milestone only

Completed milestones live in HISTORY.md. The forward plan lives in ROADMAP.md.
Architecture, invariants and gotchas live in CLAUDE.md.

Green gate for every step (not just at the end of a milestone):

```bash
npm run lint && npm run typecheck && npm run test:unit && npm run build \
  && node test/interact.mjs && npx playwright test
```

`interact.mjs` needs `npx vite preview` on :4173 against a fresh `dist/`.

---

# M11 — Close the React migration seam + editor-core skeleton

Plan: `~/.claude/plans/act-as-senior-software-distributed-church.md`

The React migration is done as a migration; what was left were three seams that
would only get more expensive once new editor services existed: a
bootstrap↔ui.ts module cycle, two pieces of DOM the bootstrap built by hand, and
eight keyboard behaviours with no names.

- [x] T0 baseline re-verified on the merge commit: lint · typecheck · 592 unit ·
      build · interact **104/104, ERRORS: none**.
- [x] T1 `src/editor/commands/` — `CommandRegistry` (unknown id = no-op
      returning false, never a throw) + 16 seed commands lifted verbatim from
      the keyboard map. `Plan2D`/`PartStudio` enter as the structural
      `PlanToolPort`/`ModalPort` declared in `src/editor`, which is what breaks
      the cycle by inversion. `test/unit/editor/commands.test.ts` (20 tests).
- [x] T2 `src/editor/keyboard/` — the key map as DATA (`bindings.ts`, pure and
      DOM-free) plus `KeyboardController`, an `attach`/`dispose` adapter.
      `preventDefault` now follows one rule (`registry.execute` returned true)
      instead of eight guards. `test/unit/editor/keyboard.test.ts` (13 tests).
- [x] T3 `src/ui/ui.ts` and `mountLegacyUI()` DELETED. Recovery banner →
      `<RecoveryBanner/>`; `#wall-label` → a `shellState` field rendered by
      `<WallNav/>`. bootstrap creates no DOM at all. `e2e/recovery.spec.ts`.
- [x] T4 `AppServices` — `src/app/services.ts` `createServices()` +
      `src/ui/react/services.tsx` provider/hooks. All 28 direct bootstrap
      imports rewritten; `App.tsx` is the only one left and an eslint
      `no-restricted-imports` rule keeps it that way.
- [x] T5 Phase C contracts, TYPES ONLY: `src/editor/input/types.ts`
      (`PointerInput`/`KeyInput`, no DOM), `src/editor/tools/Tool.ts`
      (`Tool`/`ToolContext`/`ToolResult`), `src/editor/README.md` with the M12
      migration order. No `ToolManager` — it lands with the first real tool.
- [x] T6 `units.ts`: a dimensioned expression may no longer come out
      dimensionless. `1m / 2m` is a ratio, so `parseLength` rejects it instead
      of reading 0.5 as 0.5 mm; bare `600-18*2` is unchanged.
- [x] T7 docs restructured: HISTORY.md (M1–M10), ROADMAP.md (replaces the stale
      NEXT_STEPS.md), TODO.md active-only, CLAUDE.md updated.

Cycle-end gates: lint · typecheck · **630 unit** · build · interact
**104/104** · Playwright specs.

## Known, deliberately unchanged

`Ctrl+R` rotates the selected item and swallows the browser's reload, because
the old listener's `r` branch never checked for a modifier. M11 preserved
behaviour byte-for-byte, so the binding table reproduces it. Worth a decision
of its own — the fix is one `mod: false` in `KEY_BINDINGS`.

---

# WS — Workspace redesign (WS-SPEC, Phases 1–4)

Plan: `~/.claude/plans/act-as-senior-software-glowing-seahorse.md`

Four task-focused workspaces — Plan · Furnish · Workshop · Output — as filters +
toolsets (never locks). One commit per WP on master (`ws1.3: …` style); the
green gate above runs per WP.

## Phase 1 — shell + navigation

- [x] WP 1.1 `workspaceState` module + `'workspace'` bridge channel + storageKeys TODO
- [x] WP 1.2 workspace tabs in topbar + `workspace.*` commands + `1`–`4` keys
- [x] WP 1.3 catalog filtering by workspace + search
- [x] WP 1.4 tool scoping per workspace
- [x] WP 1.5 sidebar per workspace (WorkshopPartsPanel / output caption)
- [x] WP 1.6 hosted Part Studio (WorkshopPane) + caption fix
      (follow-up noted: openInWorkshop skips setTool('select')/drawer close;
      declined re-open confirm leaves workshopTarget naming the other part)
- [x] WP 1.7 topbar slimming + settings menu + canvas overlays
- [x] WP 1.8 output pane (six export cards)
- [x] WP 1.9 test + docs migration sweep; Phase 1 exit criteria walk —
      `window.__kp` gains `workspace`/`setWorkspace` (the GUARDED switch) +
      e2e/kp.d.ts; interact and tools.spec assert the seam; screenshot.mjs
      gains one shot per workspace; README workflow rewritten around the four
      workspaces, CLAUDE.md gains the workspace-shell contract and drops the
      "Part Studio is a modal" / topbar-owns-view-and-scene claims.

**Phase 1 shipped.** Gate: lint · typecheck · **657 unit** · build · interact
**106/106** (was 104 — two workspace-state assertions added) · **51/51
Playwright** (layout.spec's topbar-height check passed here too) · exit-criteria
walk **34/34**, no console errors. Known cosmetic follow-ups, both out of WP 1.9's
scope: `#wsp-back` inherits `.btn { flex: 1 }` and stretches across the Workshop
pane head, and the zone canvas' footer caption is clipped at the pane's width.

## Phase 2 — discoverability + onboarding

- [x] WP 2.1 context menu (plan + 3D) + pure `contextMenuModel`
      (`Plan2D.hitAt` / `View3D.pickItem` façades; no per-item "Open fronts"
      entry — `store.openFronts` has no per-ITEM toggle to call)
- [x] WP 2.2 cursor hint chip (`HintChip.tsx`, rAF-positioned, no re-render per
      pointermove; 2D covers every armed tool, 3D only `place`)
- [x] WP 2.3 hover affordances in the plan (renderPlan paint-only, redraw
      requested only while over a handle)
- [x] WP 2.4 empty states — plan starter card (pristine-design trigger; the
      spec's no-rooms one is unreachable), furnish nudge, workshop caption
- [x] WP 2.5 coach marks + shortcuts cheatsheet — committed on a fast gate
      only (tsc · typecheck · lint · 687 unit); the browser gates (interact +
      full Playwright) were NOT re-run after the implementing agent was
      interrupted — see the handoff below — `ONBOARDED_KEY` +
      `src/ui/onboarded.ts`; `firstRun` decided in `createServices()` (no
      second storage parse, and never together with the recovery banner) and
      forcing `setWorkspace('plan')` before React mounts; `<CoachMarks/>`
      three dismiss-anywhere bubbles over `#ws-tabs`/`#catalog`/`#props`;
      `src/ui/shortcuts.ts` as the one gesture list behind `<Cheatsheet/>`,
      raised by `?` (`help.shortcuts` + `HelpPort`) or ⚙ → *Shortcuts…*, both
      overlays owning Escape in the capture phase. Every suite seeds
      ONBOARDED_KEY at page init — a cleared profile is a first run.

**Phase 2 status:** WPs 2.1–2.5 fully gated and committed. WP 2.5's browser
gates were re-verified 2026-08-18 (post render-pipeline merge): interact
106/106, Playwright 77/77 — the four longest coach-marks/cheatsheet walks
needed `test.slow()` (they blow the 60s budget under full-suite parallelism on
SwiftShader; solo runs always passed, no product bug). B1 walk (§9) still to
run by hand.

## HANDOFF — continuing in a new session

State at handoff (2026-08-18): everything through WP 2.5 is committed on
master (`ws1.1`…`ws2.5`). No branch, no uncommitted work.

Read first: this file, `~/.claude/plans/act-as-senior-software-glowing-seahorse.md`
(the execution plan: per-WP designs, decided semantics D1–D5, verified anchors),
and CLAUDE.md's workspace-shell section.

Next tasks, in order:

1. **Verify WP 2.5's browser gates** — `npm run build`, serve dist on :4173
   (`nohup npx vite preview --port 4173 &` — the server dies between shells),
   `node test/interact.mjs` (expect 106/106, ERRORS: none), `npx playwright
   test --workers=3` (expect all green; layout.spec's topbar-height check can
   fail machine-locally under Apple Color Emoji — that one failure is known).
   Fix anything red before Phase 3; amend the ws2.5 commit message claim if
   numbers differ.
2. **Run the B1 acceptance walk by hand** (WS-SPEC §9, eight steps) and record
   the result here — it closes Phase 2.
3. **WP 3.1 live-apply** (plan §Phase 3, invariant I5 target): design
   `store.updateCustomPart(id, mutate)` inline first (follow two neighbouring
   store mutations' notify/commit idiom); studio edits write through it,
   materialize-on-open for new/preset defs, DELETE the dirty guard +
   `originalJson` + Revert + the `studio.close()` abort path in
   `switchWorkspace`, revisit the keyboard modal gate (plan decision D2 — the
   suppression can go once draft semantics die), and implement
   discard-if-pristine on leave (REQUIRED: a materialized preset shadow that
   still deep-equals its source preset is silently removed, one mutation +
   commit). Tests: unit for materialize/discard, e2e live-update + undo.
4. **WP 3.2 scope header** — pure instance-count helper in `src/model/` +
   `Fork for this item only` via `store.forkPartForItem` (store.ts ~L1094).
5. **WP 3.3 Simple/Advanced split** — studio form column sub-tabs, session
   module flag; hidden for board/freeform parts.
6. **WP 3.4 front-layout presets** — `src/model/faceLayouts.ts`, 8 canned zone
   trees built with zones.ts constructors, normalize + caps unit test,
   Simple-tab tile row with replace-confirm on customized trees.
7. **Phase 4 materials** — WP 4.1 `materialInfo.ts` + palette-coverage test,
   WP 4.2 swatch names/captions/group headers, WP 4.3 Variables→Materials
   panel copy (read what "Apply to all fronts" really does before labelling).

Known small follow-ups (not blocking): `openInWorkshop` skips
`setTool('select')`/drawer close (WP 1.6 note above); a declined same-studio
re-open confirm leaves `workshopTarget` naming the other part; the zone canvas'
footer caption clips at narrow pane widths; right-drag pans behind an open
context menu (flagged in ws2.1, left as-is deliberately).

Session conventions that carried the work so far: one WP = one commit on
master; every WP delegated with a full brief (GOAL/CONTEXT with file:line
anchors/DESIGN/CONSTRAINTS/VERIFY/REPORT) and reviewed via `git diff` + a
re-run gate before committing; subagent briefs must mention the graphify
PreToolUse hook (project tooling, not an attack) and that suites seed
`ONBOARDED_KEY` at page init so a cleared profile means first-run coach marks.

## Phase 3 — workshop maturation

- [ ] WP 3.1 live-apply (`store.updateCustomPart`, guard deletion, discard-if-pristine)
- [ ] WP 3.2 scope header (def vs instances, fork-for-this-item)
- [ ] WP 3.3 Simple / Advanced split
- [ ] WP 3.4 front-layout presets (`faceLayouts.ts`)

## Phase 4 — materials

- [ ] WP 4.1 material metadata (`materialInfo.ts`) + coverage test
- [ ] WP 4.2 swatch-row names, captions, group headers
- [ ] WP 4.3 Materials panel (label + bind/apply copy)

---

# M12 — Editor core (next)

See ROADMAP.md. In short: `ToolManager` + `InputRouter` land together with
`MeasureTool`, then Calibrate → DrawRoom → AddRoom → Place → **Select last**.
Nothing starts until the M11 gates are green on CI.
