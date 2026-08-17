import { useState, type ReactElement } from 'react';
import { Store } from '../../model/store';

/**
 * One-shot banner offering the raw (unparseable) autosave text as a download.
 *
 * The DECISION to show it is taken at bootstrap module load, before anything
 * else can touch storage — `Store.loadAutosaved()` only stashes a recovery
 * payload when saved text EXISTED but failed to parse or sanitize, so a
 * brand-new install has neither and this never mounts. What lives here is only
 * the rendering and the two buttons, which is why it moved out of the bootstrap
 * (which now creates no DOM at all).
 *
 * The asymmetry between the buttons is deliberate and was in the imperative
 * version too: downloading the backup does NOT clear it, only Dismiss does.
 * Someone who downloads and then reloads should still find the backup there.
 */
export function RecoveryBanner(): ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const download = (): void => {
    const payload = Store.recoveryPayload();
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'interior-design-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const dismiss = (): void => {
    Store.clearRecovery();
    setDismissed(true);
  };

  return (
    <div className="recovery-banner">
      <span>Couldn&apos;t load your saved design — a backup was kept.</span>
      <button type="button" onClick={download}>
        Download backup
      </button>
      <button type="button" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
