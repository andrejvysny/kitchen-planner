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

# M12 — Editor core (next)

See ROADMAP.md. In short: `ToolManager` + `InputRouter` land together with
`MeasureTool`, then Calibrate → DrawRoom → AddRoom → Place → **Select last**.
Nothing starts until the M11 gates are green on CI.
