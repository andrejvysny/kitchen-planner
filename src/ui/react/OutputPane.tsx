import { useEffect, useState, type ReactElement } from 'react';
import { workspace } from '../workspaceState';
import { EXPORT_DOCS, exportGlb, exportRenderPackage } from './exportActions';
import { useChannel } from './hooks/useStore';
import { useAppServices } from './services';

/**
 * The Output workspace's canvas pane: six export cards over #canvases (WS-SPEC
 * WP 1.8), the pane-shaped sibling to <WorkshopPane/> (src/ui/react/WorkshopPane.tsx
 * — copy its shape, see the comment there). Unlike the Workshop this pane holds
 * no per-instance target: every card runs one of src/ui/react/exportActions.ts's
 * handlers against the CURRENT design, the same functions the topbar's Export ▾
 * menu already calls, so the two surfaces can never drift apart.
 *
 * No Back button in the head: the workspace tabs are the only navigation WS-SPEC
 * gives this pane, exactly as they are for Plan/Furnish/Workshop.
 */
export function OutputPane(): ReactElement | null {
  useChannel('workspace');
  const { store, view3d } = useAppServices();
  const [glbBusy, setGlbBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const active = workspace() === 'output';

  useEffect(() => {
    if (!active) return;
    // the 3D pane is covered while Output is up; exportSnapshotPng/exportGlb
    // still work because View3D.snapshotPNG/exportGLB flush the rebuild queue
    // themselves before reading the scene
    view3d.setActive(false);
    return () => {
      // the topbar's 2D/3D toggle owns `.hidden` on #pane3d — read it, never
      // duplicate it, or an Output visit would resurrect a hidden 3D pane
      if (!document.getElementById('pane3d')?.classList.contains('hidden')) view3d.setActive(true);
    };
  }, [active, view3d]);

  if (!active) return null;

  const onGlb = async (): Promise<void> => {
    setGlbBusy(true);
    try {
      await exportGlb(view3d);
    } finally {
      setGlbBusy(false);
    }
  };

  const onRender = async (): Promise<void> => {
    setRenderBusy(true);
    try {
      await exportRenderPackage(store, view3d);
    } finally {
      setRenderBusy(false);
    }
  };

  return (
    <div id="pane-output" className="workspace-pane">
      <div className="workspace-pane-head">
        <span className="workspace-pane-caption">Documents &amp; exports</span>
      </div>
      <div className="out-cards">
        {EXPORT_DOCS.map((doc) => {
          // glb/render alone are async and own a busy/disabled state — every
          // other doc's `run` is fire-and-forget, called straight off the ctx
          if (doc.id === 'glb') {
            return (
              <OutCard
                key={doc.id}
                id="out-card-glb"
                title={doc.label}
                desc={doc.caption}
                action={glbBusy ? 'Exporting…' : doc.button}
                disabled={glbBusy}
                onRun={() => void onGlb()}
              />
            );
          }
          if (doc.id === 'render') {
            return (
              <OutCard
                key={doc.id}
                id="out-card-render"
                title={doc.label}
                desc={doc.caption}
                action={renderBusy ? 'Exporting…' : doc.button}
                disabled={renderBusy}
                onRun={() => void onRender()}
              />
            );
          }
          return (
            <OutCard
              key={doc.id}
              id={`out-card-${doc.id}`}
              title={doc.label}
              desc={doc.caption}
              action={doc.button}
              onRun={() => doc.run({ store, view3d })}
            />
          );
        })}
      </div>
      <div className="out-foot">All exports come from the same design — nothing to sync.</div>
    </div>
  );
}

function OutCard({
  id,
  title,
  desc,
  action,
  disabled,
  onRun,
}: {
  id: string;
  title: string;
  desc: string;
  action: string;
  disabled?: boolean;
  onRun: () => void;
}): ReactElement {
  return (
    <div className="out-card" id={id}>
      <div className="out-card-title">{title}</div>
      <div className="out-card-desc">{desc}</div>
      <button className="btn primary" disabled={disabled} onClick={onRun}>
        {action}
      </button>
    </div>
  );
}
