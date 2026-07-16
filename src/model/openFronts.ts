/**
 * Ephemeral open/closed preview state for doors and drawers. NEVER part of
 * the Design: it is a view toggle (like the selection), so undo snapshots,
 * autosave and exported files stay untouched. Keys are `${itemId}/${unit}`
 * where `unit` is the motion unit id from the panel list (stable per part).
 */
export class OpenFronts {
  private open = new Set<string>();
  private all = false;
  /** wired by the Store to its 'pose' event */
  onChange?: () => void;

  get allOpen(): boolean {
    return this.all;
  }

  isOpen(itemId: string, unit: string): boolean {
    return this.all || this.open.has(`${itemId}/${unit}`);
  }

  /**
   * Toggle one front. While "all open" is active the master flag drops and
   * the set re-seeds from the visible state minus this unit, so the click
   * closes exactly the door the user touched.
   */
  toggle(itemId: string, unit: string, allUnits?: () => Iterable<{ itemId: string; unit: string }>): void {
    const key = `${itemId}/${unit}`;
    if (this.all) {
      this.all = false;
      this.open.clear();
      if (allUnits) {
        for (const u of allUnits()) {
          const k = `${u.itemId}/${u.unit}`;
          if (k !== key) this.open.add(k);
        }
      }
    } else if (this.open.has(key)) {
      this.open.delete(key);
    } else {
      this.open.add(key);
    }
    this.onChange?.();
  }

  setAll(open: boolean): void {
    this.all = open;
    this.open.clear();
    this.onChange?.();
  }

  clear(): void {
    this.all = false;
    this.open.clear();
    this.onChange?.();
  }
}
