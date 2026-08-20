import { polygonBounds } from '../../model/geometry';
import {
  newBoardPart,
  newCabinetPart,
  newFreeformPart,
  normalizeBoardOutline,
  normalizeFreeform,
} from '../../model/parts';
import { presetPart } from '../../model/presets';
import type { Store } from '../../model/store';
import { confirmDialog } from '../dialogService';
import type { CustomPartDef } from '../../model/types';
import { uid } from '../../model/types';
import { clearWorkshopTarget } from '../workspaceState';
import { BoardPanel } from './boardPanel';
import { renderCabinetPanel } from './cabinetPanel';
import { FreeformPanel } from './freeformPanel';
import { PolygonCanvas } from './polygonCanvas';
import { StudioPreview } from './preview';
import { renderTypePicker } from './typePicker';
import { ZoneCanvas } from './zoneCanvas';

const TYPE_LABELS: Record<CustomPartDef['type'], string> = {
  cabinet: 'Cabinet',
  board: 'Worktop / board',
  freeform: 'Free boards',
};

const CREATABLE: CustomPartDef['type'][] = ['cabinet', 'board', 'freeform'];

/**
 * Part Studio: the part editor — a form rail, a zone/polygon canvas and a live
 * 3D preview. New parts start at a type picker; the type is fixed at creation.
 * Saved parts appear in the "My parts" catalog section.
 *
 * It is HOSTED, not modal (WS-SPEC WP 1.6): `open()` takes the element to
 * build into — <WorkshopPane/> hands it the Workshop pane's host div — and
 * there is no backdrop, no ✕ and no closed state of its own. Leaving is the
 * workspace's job (the pane's Back button, the topbar tabs), which is why
 * `switchWorkspace` owns the dirty gate and why `handleEscape` no longer
 * closes. What the footer keeps is what belongs to the PART: save (which now
 * stays open on the part it just wrote), revert, duplicate and delete.
 *
 * `overlay` is the wrapper element inside that host — kept as the name for
 * `isOpen()`'s sake; "open" means "built into a host", not "covering the app".
 */
export class PartStudio {
  private store: Store;
  private onClose: () => void;
  private host: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private part: CustomPartDef | null = null;
  private isNew = true;
  private originalJson = '';
  private preview: StudioPreview | null = null;
  private freeform: FreeformPanel | null = null;
  private board: BoardPanel | null = null;
  private polyCanvas: PolygonCanvas | null = null;
  private zoneCanvas: ZoneCanvas | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(store: Store, onClose: () => void) {
    this.store = store;
    this.onClose = onClose;
  }

  isOpen(): boolean {
    return !!this.overlay;
  }

  /**
   * Build the studio into `host` — the Workshop pane's host div. `existing` is
   * deep-cloned (so a deep-frozen preset def is a legal argument); omitting it
   * starts at the type picker.
   *
   * `host` is optional in the signature only so the throw can name the rule:
   * there is no un-hosted studio any more.
   */
  open(existing?: CustomPartDef, host?: HTMLElement): void {
    if (!host) throw new Error('PartStudio.open needs a host (WS-SPEC WP1.6)');
    if (!this.close()) return;
    this.host = host;
    this.isNew = !existing;
    this.part = existing ? (JSON.parse(JSON.stringify(existing)) as CustomPartDef) : null;
    this.originalJson = JSON.stringify(this.part);

    const overlay = document.createElement('div');
    overlay.className = 'studio-hosted';
    overlay.innerHTML = `
      <div class="studio">
        <div class="studio-head">
          <input class="studio-name" type="text" maxlength="32" />
          <span class="studio-type-badge"></span>
        </div>
        <div class="studio-body"></div>
        <div class="studio-foot">
          <button class="btn danger studio-delete">Delete part</button>
          <button class="btn studio-duplicate" title="Save an independent copy of this part">⧉ Duplicate</button>
          <span class="studio-validation"></span>
          <span style="flex:1"></span>
          <button class="btn studio-cancel" title="Discard changes and reload the saved part">Revert</button>
          <button class="btn primary studio-save"></button>
        </div>
      </div>`;
    host.appendChild(overlay);
    this.overlay = overlay;

    (overlay.querySelector('.studio-cancel') as HTMLElement).addEventListener(
      'click',
      () => void this.revert()
    );
    this.keyHandler = (e) => this.onKeyDown(e);
    document.addEventListener('keydown', this.keyHandler);

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
      this.zoneCanvas?.handleEscape()
    ) {
      this.refreshPreview();
    }
  }

  /** Tear the studio out of its host. Unsaved edits ask for confirmation unless `force`. Returns false if kept open. */
  close(force = false): boolean {
    if (this.overlay && this.part && !force && JSON.stringify(this.part) !== this.originalJson) {
      // DELIBERATELY NATIVE, unlike the studio's other two confirms: this one
      // runs inside services.switchWorkspace, whose refusal contract is
      // SYNCHRONOUS (a false return aborts the switch on the spot). The in-app
      // dialog resolves a promise, which cannot answer a boolean this call
      // frame. WP 3.1 removes this guard outright.
      if (!confirm('Discard your changes to this part?')) return false;
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
    return true;
  }

  /** Drop the canvas editors so their ResizeObservers stop watching dead nodes. */
  private disposeCanvases(): void {
    this.polyCanvas?.dispose();
    this.polyCanvas = null;
    this.zoneCanvas?.dispose();
    this.zoneCanvas = null;
  }

  /* ---------------- states ---------------- */

  private renderPicker(): void {
    const body = this.overlay!.querySelector('.studio-body') as HTMLElement;
    body.innerHTML = '';
    body.classList.add('picking');
    (this.overlay!.querySelector('.studio-name') as HTMLInputElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-delete') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-duplicate') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-save') as HTMLElement).style.display = 'none';
    // nothing to revert TO before a type is picked
    (this.overlay!.querySelector('.studio-cancel') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-type-badge') as HTMLElement).textContent = 'New part';
    renderTypePicker(body, CREATABLE, (type) => {
      this.part =
        type === 'cabinet'
          ? newCabinetPart()
          : type === 'board'
            ? newBoardPart()
            : newFreeformPart();
      this.originalJson = JSON.stringify(this.part);
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
    name.addEventListener('input', () => (part.name = name.value || 'Part'));

    (overlay.querySelector('.studio-type-badge') as HTMLElement).textContent =
      TYPE_LABELS[part.type];

    const save = overlay.querySelector('.studio-save') as HTMLButtonElement;
    save.style.display = '';
    save.addEventListener('click', () => this.save());
    (overlay.querySelector('.studio-cancel') as HTMLElement).style.display = '';

    const del = overlay.querySelector('.studio-delete') as HTMLButtonElement;
    const dup = overlay.querySelector('.studio-duplicate') as HTMLButtonElement;
    del.addEventListener('click', () => void this.deletePart());
    dup.addEventListener('click', () => this.duplicatePart());
    this.syncFooter();

    this.preview = new StudioPreview(body.querySelector('.studio-preview') as HTMLElement);
    if (part.type === 'cabinet') {
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
    this.refreshPreview();
  }

  /**
   * The three footer nodes that depend on "is this part in the library yet":
   * the save label, Delete and Duplicate. Patched in place rather than
   * re-rendered, because save() calls it while the user is still editing —
   * rebuilding the editor there would eat their focus and scroll position.
   */
  private syncFooter(): void {
    const overlay = this.overlay;
    const part = this.part;
    if (!overlay || !part) return;
    (overlay.querySelector('.studio-save') as HTMLElement).textContent = this.isNew
      ? 'Add to my parts'
      : 'Save changes';
    const saved = !this.isNew && !!this.store.customPartById(part.id);
    (overlay.querySelector('.studio-delete') as HTMLElement).style.display = saved ? '' : 'none';
    (overlay.querySelector('.studio-duplicate') as HTMLElement).style.display = saved ? '' : 'none';
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
      this.zoneCanvas = new ZoneCanvas(mid, part, () => this.refreshPreview());
      renderCabinetPanel(rail, part, () => {
        this.zoneCanvas?.draw();
        this.refreshPreview();
      });
    } else if (part.type === 'freeform') {
      this.freeform = new FreeformPanel(rail, part, () => this.refreshPreview());
      this.preview!.onPick = (id) => this.freeform?.select(id);
    } else {
      const mid = this.overlay!.querySelector('.studio-canvas') as HTMLElement;
      this.polyCanvas = new PolygonCanvas(mid, part, () => this.refreshPreview());
      this.board = new BoardPanel(rail, part, this.polyCanvas, () => this.refreshPreview());
    }
  }

  private refreshPreview(): void {
    if (!this.part || !this.preview) return;
    if (this.part.type === 'freeform') normalizeFreeform(this.part);
    if (this.part.type === 'board') {
      // keep w/d in sync with the outline so the preview camera frames it
      const b = polygonBounds(this.part.outline);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      for (const p of this.part.outline) {
        p.x -= cx;
        p.y -= cy;
      }
      for (const h of this.part.holes) {
        h.x -= cx;
        h.y -= cy;
      }
      this.part.w = Math.max(0.05, b.maxX - b.minX);
      this.part.d = Math.max(0.05, b.maxY - b.minY);
    }
    this.preview.refresh(this.part, this.freeform?.selectedId);
    this.board?.refresh();
    const err = this.freeform?.validate() ?? this.board?.validate() ?? null;
    const save = this.overlay!.querySelector('.studio-save') as HTMLButtonElement;
    const msg = this.overlay!.querySelector('.studio-validation') as HTMLElement;
    save.disabled = !!err;
    msg.textContent = err ?? '';
  }

  /* ---------------- actions ---------------- */

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (
        this.freeform?.handleDelete() ||
        this.board?.handleDelete() ||
        this.zoneCanvas?.handleDelete()
      ) {
        e.preventDefault();
        this.refreshPreview();
      }
      return;
    }
    if (this.freeform?.handleKey(e)) {
      e.preventDefault();
      this.refreshPreview();
    }
  }

  /**
   * Write the part to the library and STAY on it: the Workshop is a place, not
   * a dialog, so saving is a checkpoint rather than an exit. What changes is
   * the part's status — it is no longer new, it is no longer dirty, and it can
   * now be deleted or duplicated — so only the footer is patched.
   */
  private save(): void {
    if (!this.part) return;
    if (this.part.type === 'freeform') normalizeFreeform(this.part);
    if (this.part.type === 'board') normalizeBoardOutline(this.part);
    this.store.upsertCustomPart(JSON.parse(JSON.stringify(this.part)));
    this.store.commit();
    this.isNew = false;
    this.originalJson = JSON.stringify(this.part);
    this.syncFooter();
  }

  /**
   * Throw the current edits away and reload: the saved part if there is one,
   * the built-in preset this id shadows if not, and the type picker for a part
   * that was never saved at all.
   */
  private async revert(): Promise<void> {
    const host = this.host;
    const part = this.part;
    if (!host || !part) return;
    if (JSON.stringify(part) !== this.originalJson) {
      const ok = await confirmDialog({
        title: 'Discard your changes?',
        body: 'This part goes back to how it was last saved.',
        confirmLabel: 'Discard',
        danger: true,
      });
      // the studio can have moved on while the dialog was up
      if (!ok || this.part !== part || this.host !== host) return;
    }
    const id = part.id;
    const saved = this.store.customPartById(id) ?? presetPart(id);
    this.close(true);
    this.open(saved, host);
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
    this.store.commit();
    // the target names a part that no longer exists; drop it and land on the
    // picker, which is the Workshop's empty state
    clearWorkshopTarget();
    this.close(true);
    this.open(undefined, host);
  }

  /** Continue editing an independent copy — covers "same part, different config". */
  private duplicatePart(): void {
    if (!this.part) return;
    this.part.id = uid('part');
    this.part.name = `${this.part.name} copy`.slice(0, 32);
    this.isNew = true;
    this.originalJson = '';
    (this.overlay!.querySelector('.studio-name') as HTMLInputElement).value = this.part.name;
    this.syncFooter();
  }
}
