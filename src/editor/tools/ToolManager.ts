import type { ToolId } from '../editorState';
import type { KeyInput, PointerInput } from '../input/types';
import type { Tool, ToolContext, ToolResult } from './Tool';

/**
 * Turns a change of `EditorState.tool` into `deactivate`/`activate`, and routes
 * normalized input at the tool that is live.
 *
 * Two rules it inherits from `CommandRegistry`, both deliberate:
 *
 * - **an unregistered id is not an error.** Most tools still live inside
 *   Plan2D, so `setTool('drawRoom')` must simply mean "no tool of mine is
 *   live" — the host keeps handling it. A throw would make the migration
 *   all-or-nothing.
 * - **`'passthrough'` is the default.** With nothing active, every input
 *   passes through untouched, which is what lets the host's existing code stay
 *   exactly as it was until each gesture actually moves.
 *
 * It does NOT subscribe to the editor. Plan2D is already the single subscriber
 * to tool changes (`syncFromEditor`), and a second one would make the order of
 * "clean up the old tool" against "the view's mirrors are updated" depend on
 * registration order.
 */
export class ToolManager {
  private readonly tools = new Map<string, Tool>();
  private current: Tool | null = null;

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  /** The tool that is live, or null when the current id has no tool of ours. */
  get active(): Tool | null {
    return this.current;
  }

  /**
   * Look a registered tool up by id for the host's own reads — the measurement
   * overlay, the snap glyph. Typed by the caller, which knows what it
   * registered; a miss is null rather than a throw, matching `execute`.
   */
  get<T extends Tool>(id: string): T | null {
    return (this.tools.get(id) as T | undefined) ?? null;
  }

  /**
   * Enter `id`, leaving whatever was live. Idempotent: re-entering the tool
   * already active does nothing, so a host that calls this from a reconcile
   * pass cannot restart a gesture in progress.
   */
  setTool(id: ToolId, ctx: ToolContext): void {
    const next = this.tools.get(id) ?? null;
    if (next === this.current) return;
    this.current?.deactivate(ctx);
    this.current = next;
    this.current?.activate(ctx);
  }

  pointerDown(input: PointerInput, ctx: ToolContext): ToolResult {
    return this.current?.pointerDown(input, ctx) ?? 'passthrough';
  }

  pointerMove(input: PointerInput, ctx: ToolContext): ToolResult {
    return this.current?.pointerMove(input, ctx) ?? 'passthrough';
  }

  pointerUp(input: PointerInput, ctx: ToolContext): ToolResult {
    return this.current?.pointerUp(input, ctx) ?? 'passthrough';
  }

  keyDown(input: KeyInput, ctx: ToolContext): ToolResult {
    return this.current?.keyDown?.(input, ctx) ?? 'passthrough';
  }

  /**
   * Escape while the tool stays active. `'handled'` means a gesture in
   * progress was dropped and the tool keeps the floor; `'passthrough'` means
   * there was nothing to cancel, and the host should fall back to leaving the
   * tool.
   */
  cancel(ctx: ToolContext): ToolResult {
    return this.current?.cancel(ctx) ?? 'passthrough';
  }
}
