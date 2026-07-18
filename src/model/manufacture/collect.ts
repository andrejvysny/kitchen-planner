import { catalogDef, hasCatalogDef } from '../catalog';
import type { CustomPartDef, Design, Item } from '../types';
import type { Panel, PartDims } from '../panels';
import type { ApplianceEntry } from './types';
import { bridgeItem } from './catalogBridge';

/**
 * Design → manufacturable-item collector. Walks `design.items` and resolves each
 * to a `CustomPartDef` + instance dimensions the cut-list stage can decompose:
 *  - custom-part items resolve against `design.customParts` and use the part
 *    directly (its zone tree already lives on the def);
 *  - built-in catalog items are bridged to an ephemeral part (catalogBridge.ts);
 *  - board-like catalog kinds and appliances carry a direct panel list or an
 *    appliance entry instead of a part.
 *
 * Pure model code — no Three.js, no Store.
 */

export interface CollectedItem {
  item: Item;
  label: string;
  /** synthesized or user part; null for the direct-panel board kinds */
  part: CustomPartDef | null;
  dims: PartDims;
  /** emit a separate worktop cut row (bridged counter kinds) */
  worktop: boolean;
  /** direct panel list when there is no part (open shelves, backsplash, wood plane) */
  panels?: Panel[];
}

export interface Collected {
  items: CollectedItem[];
  appliances: ApplianceEntry[];
  /** labels of items that produced nothing (lights, furniture, markers, dead defIds) */
  skipped: string[];
}

const dimsOf = (item: Item): PartDims => ({ w: item.w, d: item.d, h: item.h, elevation: item.elevation });

export function collectDesign(design: Design): Collected {
  const items: CollectedItem[] = [];
  const appliances: ApplianceEntry[] = [];
  const skipped: string[] = [];
  const customById = new Map<string, CustomPartDef>(design.customParts.map((p) => [p.id, p]));

  for (const item of design.items) {
    const custom = customById.get(item.defId);
    if (custom) {
      items.push({
        item,
        label: custom.name,
        part: custom,
        dims: dimsOf(item),
        // custom-cabinet worktops are emitted as carcass panels, not a separate row
        worktop: false,
      });
      continue;
    }

    if (!hasCatalogDef(item.defId)) {
      skipped.push(`${item.defId} (unknown def)`);
      continue;
    }

    const def = catalogDef(item.defId);
    const bridged = bridgeItem(design, item);
    if (!bridged) {
      skipped.push(def.label);
      continue;
    }
    if (bridged.appliance) appliances.push(...bridged.appliance);
    if (bridged.part || bridged.panels) {
      items.push({
        item,
        label: def.label,
        part: bridged.part,
        dims: bridged.dims,
        worktop: bridged.worktop,
        panels: bridged.panels,
      });
    }
  }

  return { items, appliances, skipped };
}
