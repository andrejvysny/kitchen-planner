# src/editor — the editor core

Framework-free by contract: no React, no three.js, no DOM in anything except
the two adapters that exist to touch it (`keyboard/KeyboardController.ts`
today, `input/InputRouter.ts` when it lands). `eslint.config.js` enforces the
no-React / no-`src/app` half of that.

Dependencies point INTO this directory. `src/plan2d/plan2d.ts` imports
`editorState.ts`; nothing here imports Plan2D, the Part Studio or the React
shell. Where the command layer genuinely needs to reach a view — cancelling the
live tool — it declares a **structural port** (`PlanToolPort`, `ModalPort` in
`commands/types.ts`) that the concrete class already satisfies, and `src/app`
does the wiring.

## What is here now

| Path | What it is |
| --- | --- |
| `editorState.ts` | tool truth: `tool`, `armedDefId`, `checksOn`. Ephemeral — never serialized, never undone. |
| `commands/` | named editor behaviours + the registry that runs them. |
| `keyboard/` | the key map as data (`bindings.ts`, pure) and its DOM adapter. |
| `input/types.ts` | the DOM-free `PointerInput`/`KeyInput` a tool receives (types only). |
| `input/normalize.ts` | `PointerEvent`/`KeyboardEvent` → those types. Pure functions, not a class. |
| `tools/Tool.ts` | the `Tool` / `ToolContext` / `ToolResult` contract (types only). |
| `tools/ToolManager.ts` | tool id → `activate`/`deactivate`, and input routing. |
| `tools/MeasureTool.ts` | the first extracted gesture (M12-A). |
| `tools/measureState.ts` | its `Measure` overlay state, re-exported by `plan2d/renderPlan.ts`. |

Four rules the first extraction settled, each one a thing the next tool should
copy rather than re-decide:

- **the HOST keeps the listeners.** Plan2D already attaches them behind an
  `AbortController` and owns the canvas transform, so `input/normalize.ts` is
  functions, not an `InputRouter` class with a second teardown path to leak.
- **`'passthrough'` is the default, everywhere.** An id with no registered tool
  means "no tool of mine is live" and the host's existing code runs untouched.
  That is what makes the migration incremental instead of all-or-nothing.
- **one subscriber to `EditorState`.** Plan2D's `syncFromEditor()` drives
  `ToolManager.setTool`; the manager does not subscribe, or the order of "clean
  up the tool being left" against "the view's mirrors are updated" would depend
  on registration order.
- **per-tool needs are CONSTRUCTOR arguments, not `ToolContext` fields.**
  `ToolContext` is the shape every tool shares; widening it once per tool ends
  with it being the app. `MeasureTool` takes `snapContext` and `hitRadius` that
  way — the first is plan geometry, the second reads `matchMedia`.

## The tool migration order (M12)

Plan2D still owns every gesture: the viewport, hit-testing, the nine-variant
drag union, snapping orchestration, placement, room drawing, measuring,
calibration and the underlay. Tools come out of it one at a time, easiest
first, so the contracts above get exercised before they meet anything hard:

```
Measure  →  Calibrate  →  DrawRoom  →  Place  →  Select
```

- **Measure** first because it is already the closest to the target shape: two
  clicks, its own reset, and it is the one place that already derives its
  tolerance in screen space (`hitRadius(11) / zoom`).
- **Calibrate** is measure's twin with a different commit.
- **DrawRoom** adds accumulated gesture state (the ring) and a two-stage
  cancel — the first real test of `cancel(): ToolResult`.
- **Place** adds catalog arming, snapping and the opening/item split.
- **Select LAST**, and not for schedule reasons: it carries stacked-item
  cycling, corners, walls, openings, the rotate handle, underlay hit-testing,
  splitting and the pan fallthrough. Moving it first would freeze the
  abstraction around the hardest case before the easy ones had a say.

Each step is behaviour-preserving; `test/interact.mjs` and `e2e/tools.spec.ts`
are the gates. A tool's own behaviour is unit-tested from plain `PointerInput`
objects (`test/unit/editor/measureTool.test.ts`) — if a gesture needs a browser
to test, the DOM-free boundary has leaked.
