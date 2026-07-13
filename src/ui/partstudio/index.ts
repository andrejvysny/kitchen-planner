import { polygonBounds } from '../../model/geometry';
import {
  newBoardPart,
  newCabinetPart,
  newFreeformPart,
  normalizeBoardOutline,
  normalizeFreeform,
} from '../../model/parts';
import type { Store } from '../../model/store';
import type { CustomPartDef } from '../../model/types';
import { uid } from '../../model/types';
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
 * Part Studio: a modal editor where users create and edit their own parts
 * with a live 3D preview. New parts start at a type picker; the type is
 * fixed at creation. Saved parts appear in the "My parts" catalog section.
 */
export class PartStudio {
  private store: Store;
  private onClose: () => void;
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

  open(existing?: CustomPartDef): void {
    if (!this.close()) return;
    this.isNew = !existing;
    this.part = existing ? (JSON.parse(JSON.stringify(existing)) as CustomPartDef) : null;
    this.originalJson = JSON.stringify(this.part);

    const overlay = document.createElement('div');
    overlay.className = 'studio-overlay';
    overlay.innerHTML = `
      <div class="studio">
        <div class="studio-head">
          <input class="studio-name" type="text" maxlength="32" />
          <span class="studio-type-badge"></span>
          <button class="studio-x" title="Close">✕</button>
        </div>
        <div class="studio-body"></div>
        <div class="studio-foot">
          <button class="btn danger studio-delete">Delete part</button>
          <button class="btn studio-duplicate" title="Save an independent copy of this part">⧉ Duplicate</button>
          <span class="studio-validation"></span>
          <span style="flex:1"></span>
          <button class="btn studio-cancel">Cancel</button>
          <button class="btn primary studio-save"></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    (overlay.querySelector('.studio-x') as HTMLElement).addEventListener('click', () => this.close());
    (overlay.querySelector('.studio-cancel') as HTMLElement).addEventListener('click', () => this.close());
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.close();
    });
    this.keyHandler = (e) => this.onKeyDown(e);
    document.addEventListener('keydown', this.keyHandler);

    if (this.part) this.renderEditor();
    else this.renderPicker();
  }

  /** Escape inside the studio: clear in-studio selection first, then close. */
  handleEscape(): void {
    if (this.freeform?.handleEscape() || this.board?.handleEscape() || this.zoneCanvas?.handleEscape()) {
      this.refreshPreview();
      return;
    }
    this.close();
  }

  /** Close the studio. Unsaved edits ask for confirmation unless `force`. Returns false if kept open. */
  close(force = false): boolean {
    if (this.overlay && this.part && !force && JSON.stringify(this.part) !== this.originalJson) {
      if (!confirm('Discard your changes to this part?')) return false;
    }
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    this.preview?.dispose();
    this.preview = null;
    this.freeform = null;
    this.board = null;
    this.polyCanvas = null;
    this.zoneCanvas = null;
    this.part = null;
    this.overlay?.remove();
    this.overlay = null;
    this.onClose();
    return true;
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
    (this.overlay!.querySelector('.studio-type-badge') as HTMLElement).textContent = 'New part';
    renderTypePicker(body, CREATABLE, (type) => {
      this.part =
        type === 'cabinet' ? newCabinetPart() : type === 'board' ? newBoardPart() : newFreeformPart();
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

    (overlay.querySelector('.studio-type-badge') as HTMLElement).textContent = TYPE_LABELS[part.type];

    const save = overlay.querySelector('.studio-save') as HTMLButtonElement;
    save.style.display = '';
    save.textContent = this.isNew ? 'Add to my parts' : 'Save changes';
    save.addEventListener('click', () => this.save());

    const del = overlay.querySelector('.studio-delete') as HTMLButtonElement;
    const dup = overlay.querySelector('.studio-duplicate') as HTMLButtonElement;
    if (this.isNew || !this.store.customPartById(part.id)) {
      del.style.display = 'none';
      dup.style.display = 'none';
    } else {
      del.style.display = '';
      dup.style.display = '';
    }
    del.addEventListener('click', () => this.deletePart());
    dup.addEventListener('click', () => this.duplicatePart());

    this.preview = new StudioPreview(body.querySelector('.studio-preview') as HTMLElement);
    this.renderRail();
    this.refreshPreview();
  }

  private renderRail(): void {
    const part = this.part!;
    const rail = this.overlay!.querySelector('.studio-form') as HTMLElement;
    rail.innerHTML = '';
    this.freeform = null;
    this.board = null;
    this.polyCanvas = null;
    this.zoneCanvas = null;
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
      if (this.freeform?.handleDelete() || this.board?.handleDelete() || this.zoneCanvas?.handleDelete()) {
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

  private save(): void {
    if (!this.part) return;
    if (this.part.type === 'freeform') normalizeFreeform(this.part);
    if (this.part.type === 'board') normalizeBoardOutline(this.part);
    this.store.upsertCustomPart(JSON.parse(JSON.stringify(this.part)));
    this.store.commit();
    this.close(true);
  }

  private deletePart(): void {
    if (!this.part) return;
    const used = this.store.design.items.filter((i) => i.defId === this.part!.id).length;
    const msg = used
      ? `Delete this part and its ${used} placed ${used === 1 ? 'copy' : 'copies'}?`
      : 'Delete this part?';
    if (!confirm(msg)) return;
    this.store.deleteCustomPart(this.part.id);
    this.store.commit();
    this.close(true);
  }

  /** Continue editing an independent copy — covers "same part, different config". */
  private duplicatePart(): void {
    if (!this.part) return;
    this.part.id = uid('part');
    this.part.name = `${this.part.name} copy`.slice(0, 32);
    this.isNew = true;
    this.originalJson = '';
    (this.overlay!.querySelector('.studio-name') as HTMLInputElement).value = this.part.name;
    (this.overlay!.querySelector('.studio-save') as HTMLElement).textContent = 'Add to my parts';
    (this.overlay!.querySelector('.studio-delete') as HTMLElement).style.display = 'none';
    (this.overlay!.querySelector('.studio-duplicate') as HTMLElement).style.display = 'none';
  }
}
