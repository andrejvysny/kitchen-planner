/**
 * Which sub-tab the Part Studio's form column is showing (WS-SPEC WP 3.3).
 *
 * SESSION state, deliberately: not a `prefs`-style stored preference and not
 * design data. A tab is where you are in a task, not what you own — it has to
 * survive switching from one part to the next inside one sitting (the studio
 * is torn down and rebuilt on every `open`, so a field on `PartStudio` would
 * not), and it has to be back at `simple` for the next person who loads the
 * app, which is exactly what a module `let` gives for free.
 *
 * Cabinet parts only. Boards and freeform parts have no advanced half to hide,
 * so they render their whole rail and never show the strip — see
 * `PartStudio.renderTabs`.
 */

export type StudioTab = 'simple' | 'advanced';

let tab: StudioTab = 'simple';

export function studioTab(): StudioTab {
  return tab;
}

export function setStudioTab(next: StudioTab): void {
  tab = next;
}
