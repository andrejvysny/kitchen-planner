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
| `input/types.ts` | **types only** — the DOM-free `PointerInput`/`KeyInput` a tool will receive. |
| `tools/Tool.ts` | **types only** — the `Tool` / `ToolContext` / `ToolResult` contract. |

`input/types.ts` and `tools/Tool.ts` carry no runtime. There is deliberately no
`ToolManager` yet: a manager with nothing registered is dead code, so it lands
with the first tool that exercises it.

## The tool migration order (M12)

Plan2D still owns every gesture: the viewport, hit-testing, the nine-variant
drag union, snapping orchestration, placement, room drawing, measuring,
calibration and the underlay. Tools come out of it one at a time, easiest
first, so the contracts above get exercised before they meet anything hard:

```
Measure  →  Calibrate  →  DrawRoom  →  AddRoom  →  Place  →  Select
```

- **Measure** first because it is already the closest to the target shape: two
  clicks, its own reset, and it is the one place that already derives its
  tolerance in screen space (`hitRadius(11) / zoom`).
- **Calibrate** is measure's twin with a different commit.
- **DrawRoom** adds accumulated gesture state (the ring) and a two-stage
  cancel — the first real test of `cancel(): ToolResult`.
- **AddRoom** adds a ghost and wall attachment.
- **Place** adds catalog arming, snapping and the opening/item split.
- **Select LAST**, and not for schedule reasons: it carries stacked-item
  cycling, corners, walls, openings, the rotate handle, underlay hit-testing,
  splitting and the pan fallthrough. Moving it first would freeze the
  abstraction around the hardest case before the easy ones had a say.

Each step is behaviour-preserving; `test/interact.mjs` and `e2e/tools.spec.ts`
are the gates.
