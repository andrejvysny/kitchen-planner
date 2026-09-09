import { polygonBounds } from '../../model/geometry';
import {
  newBoardPart,
  newCabinetPart,
  newFreeformPart,
  normalizeBoardOutline,
  normalizeFreeform,
} from '../../model/parts';
import { instancesOf } from '../../model/partUsage';
import type { Store } from '../../model/store';
import { confirmDialog } from '../dialogService';
import type { CustomPartDef } from '../../model/types';
import { uid } from '../../model/types';
import { newWardrobePart } from '../../model/wardrobe';
import { clearWorkshopTarget, openInWorkshop, workshopTarget } from '../workspaceState';
import { BoardPanel } from './boardPanel';
import { renderCabinetPanel } from './cabinetPanel';
import { FreeformPanel } from './freeformPanel';
import { PolygonCanvas } from './polygonCanvas';
import { StudioPreview } from './preview';
import { setStudioTab, studioTab, type StudioTab } from './studioTab';
import { renderTypePicker } from './typePicker';
import { WardrobeCanvas } from './wardrobeCanvas';
import { renderWardrobePanel } from './wardrobePanel';
import { ZoneCanvas } from './zoneCanvas';

const TYPE_LABELS: Record<CustomPartDef['type'], string> = {
  cabinet: 'Cabinet',
  wardrobe: 'Built-in wardrobe',
  board: 'Worktop / board',
  freeform: 'Free boards',
};

const CREATABLE: CustomPartDef['type'][] = ['cabinet', 'wardrobe', 'board', 'freeform'];

const FACTORIES: Record<CustomPartDef['type'], () => CustomPartDef> = {
  cabinet: newCabinetPart,
  wardrobe: newWardrobePart,
  board: newBoardPart,
  freeform: newFreeformPart,
};

/**
 * Part Studio: the part editor — a form rail, a zone/polygon canvas and a live
 * 3D preview. New parts start at a type picker; the type is fixed at creation.
 * Parts appear in the "My parts" catalog section.
 *
 * It is HOSTED, not modal (WS-SPEC WP 1.6): `open()` takes the element to
 * build into — <WorkshopPane/> hands it the Workshop pane's host div — and
 * there is no backdrop, no ✕ and no closed state of its own. Leaving is the
 * workspace's job (the pane's Back button, the topbar tabs), which is why
 * `handleEscape` no longer closes.
 *
 * It is also LIVE-APPLY (WS-SPEC WP 3.1), and that is the rule everything else
 * here follows from: **`this.part` IS the object in `design.customParts`**, not
 * a draft of it. The panels mutate it directly, `changed()` runs the model
 * normalizers and hands it to `store.updateCustomPart`, and the 2D plan and the
 * 3D scene redraw off the ordinary structural notify. So there is no Save, no
 * Revert, no dirty flag and no leave-confirm — Ctrl+Z is the undo, and it works
 * with the studio open because a committed edit is an ordinary undo step.
 *
 * Three consequences worth stating, because they are not obvious:
 *
 *  - **Opening MATERIALIZES.** A preset is deep-frozen and lives outside the
 *    design, so `store.materializePart` shadows it design-locally first (D4) and
 *    the studio edits the shadow. `close()` throws that shadow away again if it
 *    was never actually changed, so browsing the built-ins leaves no litter.
 *  - **An INVALID part is not written.** A self-crossing outline would be
 *    rebuilt from its bounding box by `sanitizePart` — the user's polygon would
 *    vanish under their cursor — so `changed()` holds the write back until
 *    `validate()` is happy again. That is the live-apply spelling of the old
 *    disabled Save button, and the reason `.studio-validation` is still here.
 *  - **Undo REPLACES the design's objects.** After `store.undo()` our `part` is
 *    an orphan, so the studio watches the 'history' channel and re-opens on
 *    whatever its id resolves to now (the resident part, the preset it shadowed,
 *    or the picker). Our OWN commits are told apart by object identity: after
 *    one of those, `customPartById(id)` is still the very object we hold.
 *
 * `overlay` is the wrapper element inside that host — kept as the name for
 * `isOpen()`'s sake; "open" means "built into a host", not "covering the app".
 */
export class PartStudio {
  private store: Store;
  private onClose: () => void;
  private onPlaceRequest?: (defId: string) => void;
  private host: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private part: CustomPartDef | null = null;
  private preview: StudioPreview | null = null;
  private freeform: FreeformPanel | null = null;
  private board: BoardPanel | null = null;
  private polyCanvas: PolygonCanvas | null = null;
  private zoneCanvas: ZoneCanvas | null = null;
  private wardrobeCanvas: WardrobeCanvas | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private offHistory: (() => void) | null = null;

  constructor(store: Store, onClose: () => void, onPlaceRequest?: (defId: string) => void) {
    this.store = store;
    this.onClose = onClose;
    this.onPlaceRequest = onPlaceRequest;
  }

  isOpen(): boolean {
    return !!this.overlay;
  }

  /**
   * Build the studio into `host` — the Workshop pane's host div. `existing` is
   * MATERIALIZED (see the class comment): a preset or a part from another
   * design's library becomes a design-local shadow under the same id, and what
   * the studio edits from then on is that resident object. Omitting it starts
   * at the type picker.
   *
   * `host` is optional in the signature only so the throw can name the rule:
   * there is no un-hosted studio any more.
   */
  open(existing?: CustomPartDef, host?: HTMLElement): void {
    if (!host) throw new Error('PartStudio.open needs a host (WS-SPEC WP1.6)');
    this.close();
    this.host = host;
    this.part = existing ? this.store.materializePart(existing) : null;

    const overlay = document.createElement('div');
    overlay.className = 'studio-hosted';
    overlay.innerHTML = `
      <div class="studio">
        <div class="studio-head">
          <input class="studio-name" type="text" maxlength="32" />
          <span class="studio-type-badge"></span>
        </div>
        <div class="studio-scope">
          <span class="studio-scope-text"></span>
          <button class="btn studio-place" id="studio-place-btn" title="Arms this part in the plan — then click in the room to drop it">Place in room</button>
          <button class="btn studio-fork" title="Copies this part for just this cabinet — the other copies keep the original">Fork for this item only</button>
        </div>
        <div class="studio-tabs" role="tablist">
          <button class="btn studio-tab" data-tab="simple" role="tab" title="Size, layout, body and colours">Simple</button>
          <button class="btn studio-tab" data-tab="advanced" role="tab" title="Everything: layout details, interiors and how it meets the room">Advanced</button>
        </div>
        <div class="studio-body"></div>
        <div class="studio-foot">
          <button class="btn danger studio-delete">Delete part</button>
          <button class="btn studio-duplicate" title="Continue on an independent copy of this part">⧉ Duplicate</button>
          <span class="studio-validation"></span>
          <span style="flex:1"></span>
          <span class="studio-live-note">Changes apply as you edit — ⌘Z / Ctrl+Z undoes</span>
        </div>
      </div>`;
    host.appendChild(overlay);
    this.overlay = overlay;

    this.keyHandler = (e) => this.onKeyDown(e);
    document.addEventListener('keydown', this.keyHandler);
    // an undo/redo/import swaps every object in design.customParts; the part we
    // hold becomes an orphan and the editor has to be rebuilt on the new one
    this.offHistory = this.store.on('history', this.onHistory);

    if (this.part) this.renderEditor();
    else this.renderPicker();
  }

  /**
   * Escape inside the studio: clear the in-studio selection. There is no
   * further fallback — a workspace pane has no closed state, so Escape at the
   * top level does nothing rather than dumping the user out of the Workshop.
   */
  handleEscape(): void {
    if (
      this.freeform?.handleEscape() ||
      this.board?.handleEscape() ||
      this.zoneCanvas?.handleEscape() ||
      this.wardrobeCanvas?.handleEscape()
    ) {
      this.refreshPreview();
    }
  }

  /**
   * Tear the studio out of its host. Nothing to confirm and nothing to save —
   * every edit is already in the design — but this IS the one choke point for
   * discard-if-pristine, which is why every route that stops editing a part
   * comes through here: leaving the Workshop (the pane's cleanup), opening a
   * different part (`open` closes first), deleting, duplicating.
   */
  close(): void {
    // FIRST, before anything that can commit: the discard below may emit
    // 'history', and onHistory would re-enter this method and re-open the
    // studio on the preset we are in the middle of throwing away.
    this.offHistory?.();
    this.offHistory = null;
    const id = this.part?.id;
    if (id && this.store.discardPristineShadow(id)) {
      // usually a no-op: materializing never committed, so the design is back
      // to what the last commit already said
      this.store.commit();
    }
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    this.preview?.dispose();
    this.preview = null;
    this.disposeCanvases();
    this.freeform = null;
    this.board = null;
    this.part = null;
    this.overlay?.remove();
    this.overlay = null;
    this.host = null;
    this.onClose();
  }

  /** Drop the canvas editors so their ResizeObservers stop watching dead nodes. */
  private disposeCanvases(): void {
    this.polyCanvas?.dispose();
    this.polyCanvas = null;
    this.zoneCanvas?.dispose();
    this.zoneCanvas = null;
    this.wardrobeCanvas?.dispose();
    this.wardrobeCanvas = null;
  }

  /* ---------------- states ---------------- */

  private renderPicker(): void {
    const body = this.overlay!.querySelector('.studio-body') as HTMLElement;
    body.innerHTML = '';
    body.classList.add('picking');
    (this.overlay!.querySelector('.studio-name') as HTMLInputElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-delete') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-duplicate') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-live-note') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-scope') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-tabs') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-type-badge') as HTMLElement).textContent = 'New part';
    renderTypePicker(body, CREATABLE, (type) => {
      const fresh = FACTORIES[type]();
      // Picking a type IS the creation now, so unlike materializing a preset
      // shadow this one commits: the user asked for a new part and it must
      // survive a reload (autosave runs on commit) and be undoable as one step.
      this.store.upsertCustomPart(fresh);
      this.store.commit();
      this.part = this.store.customPartById(fresh.id) ?? fresh;
      this.renderEditor();
    });
  }

  private renderEditor(): void {
    const overlay = this.overlay!;
    const part = this.part!;
    const body = overlay.querySelector('.studio-body') as HTMLElement;
    body.classList.remove('picking');
    body.innerHTML = `
      <div class="studio-form"></div>
      ${part.type !== 'freeform' ? '<div class="studio-canvas"></div>' : ''}
      <div class="studio-preview"></div>`;

    const name = overlay.querySelector('.studio-name') as HTMLInputElement;
    name.style.display = '';
    name.value = part.name;
    // 'input' keeps the live preview honest without an undo step per keystroke;
    // 'change' (blur / Enter) is the commit — the same split every React field
    // in the inspector makes (CLAUDE.md, fields/useNativeChange)
    name.addEventListener('input', () => {
      part.name = name.value || 'Part';
      this.changed(true);
    });
    name.addEventListener('change', () => {
      part.name = name.value || 'Part';
      this.changed();
    });

    (overlay.querySelector('.studio-type-badge') as HTMLElement).textContent =
      TYPE_LABELS[part.type];
    (overlay.querySelector('.studio-live-note') as HTMLElement).style.display = '';
    (overlay.querySelector('.studio-scope') as HTMLElement).style.display = '';

    const del = overlay.querySelector('.studio-delete') as HTMLButtonElement;
    const dup = overlay.querySelector('.studio-duplicate') as HTMLButtonElement;
    const fork = overlay.querySelector('.studio-fork') as HTMLButtonElement;
    const place = overlay.querySelector('#studio-place-btn') as HTMLButtonElement;
    // every custom part is placeable by definition, so this hides only when
    // nothing wired a route to the plan (a headless studio in a unit test)
    place.style.display = this.onPlaceRequest ? '' : 'none';
    place.addEventListener('click', () => this.onPlaceRequest?.(part.id));
    del.style.display = '';
    dup.style.display = '';
    del.addEventListener('click', () => void this.deletePart());
    dup.addEventListener('click', () => this.duplicatePart());
    fork.addEventListener('click', () => this.forkForItem());
    this.refreshScope();
    this.renderTabs();

    this.preview = new StudioPreview(body.querySelector('.studio-preview') as HTMLElement);
    if (part.type === 'cabinet' || part.type === 'wardrobe') {
      // studio-local open toggle so interiors can be inspected while editing
      const holder = body.querySelector('.studio-preview') as HTMLElement;
      const toggle = document.createElement('label');
      toggle.className = 'studio-open-toggle';
      toggle.innerHTML = `<input type="checkbox"> Doors open`;
      const cb = toggle.querySelector('input') as HTMLInputElement;
      cb.addEventListener('change', () => {
        this.preview!.frontsOpen = cb.checked;
        this.refreshPreview();
      });
      holder.appendChild(toggle);
    }
    this.renderRail();
    // the def may predate a normalizer (an old save, a hand-edited file); square
    // it up before the first preview, but without writing — opening is not an
    // edit and must not start an undo step
    this.normalizePart(part);
    this.refreshPreview();
  }

  /**
   * The Simple / Advanced strip (WS-SPEC WP 3.3). CABINETS AND WARDROBES ONLY:
   * a board is a polygon and a freeform part is a list of boards — neither has
   * a novice half and an expert half to split, so they get no strip and their
   * whole rail.
   *
   * The choice itself lives in the session module (`studioTab`), not on this
   * object, because `open` tears the studio down and builds a new one every
   * time the Workshop retargets: a field here would put the user back on Simple
   * every time they stepped to the next part.
   */
  private renderTabs(): void {
    const overlay = this.overlay!;
    const strip = overlay.querySelector('.studio-tabs') as HTMLElement;
    const type = this.part?.type;
    const tabbed = type === 'cabinet' || type === 'wardrobe';
    strip.style.display = tabbed ? '' : 'none';
    if (!tabbed) return;
    for (const b of strip.querySelectorAll<HTMLButtonElement>('.studio-tab')) {
      const tab = b.dataset.tab as StudioTab;
      b.classList.toggle('active', tab === studioTab());
      b.setAttribute('aria-selected', String(tab === studioTab()));
      // assigned, not added: this runs again on every switch
      b.onclick = () => {
        if (studioTab() === tab) return;
        setStudioTab(tab);
        this.renderTabs();
        this.renderRail();
        this.refreshPreview();
      };
    }
  }

  private renderRail(): void {
    const part = this.part!;
    const rail = this.overlay!.querySelector('.studio-form') as HTMLElement;
    rail.innerHTML = '';
    this.freeform = null;
    this.board = null;
    this.disposeCanvases();
    if (this.preview) this.preview.onPick = null;

    if (part.type === 'cabinet') {
      const mid = this.overlay!.querySelector('.studio-canvas') as HTMLElement;
      // a tab switch re-enters this method against a live editor, so the host
      // is cleared here rather than by `renderEditor`'s one-shot innerHTML
      mid.innerHTML = '';
      const tab = studioTab();
      // The zone tree IS the advanced half: the Simple tab is dimensions,
      // body and colours, and it must not carry the column that teaches
      // splits, dividers and interior drill-in.
      mid.hidden = tab !== 'advanced';
      if (tab === 'advanced') {
        this.zoneCanvas = new ZoneCanvas(mid, part, (transient) => this.changed(transient));
      }
      renderCabinetPanel(
        rail,
        part,
        (transient) => {
          this.zoneCanvas?.draw();
          this.changed(transient);
        },
        tab
      );
    } else if (part.type === 'freeform') {
      this.freeform = new FreeformPanel(rail, part, (transient) => this.changed(transient));
      this.preview!.onPick = (id) => this.freeform?.select(id);
    } else if (part.type === 'wardrobe') {
      const mid = this.overlay!.querySelector('.studio-canvas') as HTMLElement;
      // a tab switch re-enters this method against a live editor
      mid.innerHTML = '';
      // The column canvas is on BOTH tabs, unlike the cabinet's zone canvas:
      // a wardrobe has no canned front-layout tiles to stand in for it, and a
      // run of columns with no columns on screen is not a Simple wardrobe, it
      // is an unusable one.
      mid.hidden = false;
      this.wardrobeCanvas = new WardrobeCanvas(mid, part, (transient) => this.changed(transient));
      renderWardrobePanel(
        rail,
        part,
        (transient) => {
          this.wardrobeCanvas?.draw();
          this.changed(transient);
        },
        studioTab()
      );
    } else {
      const mid = this.overlay!.querySelector('.studio-canvas') as HTMLElement;
      this.polyCanvas = new PolygonCanvas(mid, part, (transient) => this.changed(transient));
      this.board = new BoardPanel(rail, part, this.polyCanvas, (transient) =>
        this.changed(transient)
      );
    }
  }

  /* ---------------- live apply ---------------- */

  /**
   * The ONE thing every panel calls after touching the part: normalize, write
   * through to the store, redraw.
   *
   * `transient` is the mid-gesture tick — a slider being dragged, a divider
   * being pulled across the zone canvas. It still notifies (so the 3D scene
   * tracks the drag) but takes no undo step; the gesture's final call commits,
   * exactly like every plan-side drag in the app.
   */
  private changed(transient = false): void {
    const part = this.part;
    if (!part) return;
    // An invalid intermediate is NOT written: sanitizePart would rebuild a
    // self-crossing outline from its bounding box and the polygon the user is
    // still dragging would disappear. The message stays up until it is legal
    // again, and the next valid change writes everything at once.
    if (!this.validationError()) {
      this.store.updateCustomPart(part.id, (p) => this.normalizePart(p), transient);
      if (!transient) this.store.commit();
    }
    this.refreshPreview();
  }

  /**
   * The model-level normalizers for this part type. Idempotent, so it is safe
   * as `updateCustomPart`'s mutate and safe again on open. Boards recentre
   * their CUTOUTS along with the outline, which `normalizeBoardOutline` alone
   * does not do — it only owns the winding and the w/d refresh.
   */
  private normalizePart(part: CustomPartDef): void {
    if (part.type === 'freeform') {
      normalizeFreeform(part);
      return;
    }
    if (part.type !== 'board') return;
    const b = polygonBounds(part.outline);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    for (const p of part.outline) {
      p.x -= cx;
      p.y -= cy;
    }
    for (const h of part.holes) {
      h.x -= cx;
      h.y -= cy;
    }
    normalizeBoardOutline(part);
  }

  /** What the part is currently wrong about, or null. Gates the write-through. */
  private validationError(): string | null {
    return this.freeform?.validate() ?? this.board?.validate() ?? null;
  }

  private refreshPreview(): void {
    if (!this.part || !this.preview) return;
    this.preview.refresh(this.part, this.freeform?.selectedId);
    this.board?.refresh();
    const err = this.validationError();
    (this.overlay!.querySelector('.studio-validation') as HTMLElement).textContent = err ?? '';
    this.overlay!.classList.toggle('studio-invalid', !!err);
  }

  /**
   * What editing this part will hit (WS-SPEC WP 3.2): live-apply means every
   * placed copy follows the edit at once, so say how many that is up front.
   * `Fork for this item only` is offered only when there is a "this item" to
   * begin with (`workshopTarget().itemId`), it still resolves to the part on
   * screen — a stale target from before an undo must not fork the wrong def —
   * and there is more than one copy to split off from.
   *
   * No separate call site needed beyond `renderEditor`: an edit through
   * `changed()` never changes how many items share a def, and anything that
   * DOES (fork, duplicate, delete, undo) already re-opens the editor via
   * `onHistory` or its own `open()` call, which calls this again.
   */
  private refreshScope(): void {
    const part = this.part;
    const overlay = this.overlay;
    if (!part || !overlay) return;
    const n = instancesOf(this.store.design, part.id);
    (overlay.querySelector('.studio-scope-text') as HTMLElement).textContent =
      n === 0
        ? 'Not placed yet'
        : n === 1
          ? 'Edits apply to the 1 placed copy'
          : `Edits apply to all ${n} placed copies`;

    const itemId = workshopTarget()?.itemId;
    const item = itemId ? this.store.itemById(itemId) : undefined;
    const canFork = !!item && item.defId === part.id && n >= 2;
    (overlay.querySelector('.studio-fork') as HTMLElement).style.display = canFork ? '' : 'none';
  }

  /**
   * An undo, a redo or a file load rebuilt `design.customParts` from JSON, so
   * the object this studio is editing is now an orphan. Re-open on whatever the
   * id resolves to NOW — the resident part, the preset it was shadowing (which
   * `open` re-materializes), or the picker if it resolves to neither.
   *
   * Our OWN commits reach this handler too, and object identity is what tells
   * them apart: after `updateCustomPart` the resident IS the part we hold, so
   * there is nothing to rebuild and the user keeps their focus and caret.
   */
  private readonly onHistory = (): void => {
    const part = this.part;
    const host = this.host;
    if (!part || !host) return;
    if (this.store.customPartById(part.id) === part) return;
    const next = this.store.partOf(part.id);
    this.close();
    this.open(next, host);
  };

  /* ---------------- actions ---------------- */

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (
        this.freeform?.handleDelete() ||
        this.board?.handleDelete() ||
        this.zoneCanvas?.handleDelete() ||
        this.wardrobeCanvas?.handleDelete()
      ) {
        e.preventDefault();
        this.changed();
      }
      return;
    }
    if (this.freeform?.handleKey(e)) {
      e.preventDefault();
      this.changed();
    }
  }

  private async deletePart(): Promise<void> {
    const part = this.part;
    if (!part) return;
    const used = this.store.design.items.filter((i) => i.defId === part.id).length;
    const ok = await confirmDialog({
      title: 'Delete part?',
      body: used
        ? `${used} placed ${used === 1 ? 'copy goes' : 'copies go'} with it.`
        : 'This part is not placed anywhere.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok || this.part !== part || !this.host) return;
    const host = this.host;
    this.store.deleteCustomPart(part.id);
    // the target names a part that no longer exists; drop it and land on the
    // picker, which is the Workshop's empty state
    clearWorkshopTarget();
    // close BEFORE the commit: closing drops the 'history' subscription, and
    // onHistory would otherwise see the part gone and helpfully re-open the
    // studio on the preset it was shadowing — the one thing Delete must not do
    this.close();
    this.store.commit();
    this.open(undefined, host);
  }

  /**
   * Continue editing an independent copy — covers "same part, different
   * config". The copy is written to the library straight away (there is no
   * other way to persist one now) and the Workshop retargets onto it, which is
   * what re-opens the editor and moves the sidebar's highlight.
   */
  private duplicatePart(): void {
    const part = this.part;
    if (!part) return;
    const copy = JSON.parse(JSON.stringify(part)) as CustomPartDef;
    copy.id = uid('part');
    copy.name = `${part.name} copy`.slice(0, 32);
    this.store.upsertCustomPart(copy);
    this.store.commit();
    openInWorkshop(copy.id);
  }

  /**
   * "Fork for this item only" (WS-SPEC WP 3.2): the scope line's counterpart
   * to `duplicatePart` — instead of an independent copy nothing yet uses, this
   * clones the def and repoints ONLY the item that opened the studio, so the
   * other placed copies keep resolving to the original. `forkPartForItem`
   * commits nothing itself; the Workshop retargets onto the fork exactly like
   * a duplicate does, which is what re-opens the editor on it.
   */
  private forkForItem(): void {
    const itemId = workshopTarget()?.itemId;
    if (!itemId) return;
    const copy = this.store.forkPartForItem(itemId);
    if (!copy) return;
    this.store.commit();
    openInWorkshop(copy.id, itemId);
  }
}
