import { polygonBounds } from '../model/geometry';
import type { Store } from '../model/store';
import {
  initialUnderlay,
  UNDERLAY_JPEG_Q,
  UNDERLAY_MAX_PX,
  underlayScaleFrom,
} from '../model/underlay';
import { setHint } from './shellState';

/**
 * The tracing photo's two blocking side-effects — decoding a picked file and
 * asking the user what a calibration span really measures — lifted out of
 * src/ui/ui.ts so the Reference-photo section can be a plain component.
 *
 * Not pure (a canvas decodes the image, `prompt()` asks the question, the
 * outcome goes to the Store and the status hint), but the Store arrives as an
 * argument rather than through the app bootstrap: nothing here needs the
 * singleton, and keeping the edge explicit means a test can drive these with a
 * stub. Neither function re-renders anything — every path ends in
 * `store.commit()`, and the panel follows the 'history' channel like the rest
 * of the React shell.
 */

/**
 * Decode, cap the long edge and re-encode as JPEG. Photos go into a
 * localStorage key, so the raw megapixels of a phone shot are both useless
 * for tracing and a quota hazard.
 */
export async function downscaleImage(f: File): Promise<{ src: string; w: number; h: number }> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error('read'));
    r.readAsDataURL(f);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('decode'));
    i.src = dataUrl;
  });
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  if (!long) throw new Error('empty');
  const k = Math.min(1, UNDERLAY_MAX_PX / long);
  const cnv = document.createElement('canvas');
  cnv.width = Math.max(1, Math.round(img.naturalWidth * k));
  cnv.height = Math.max(1, Math.round(img.naturalHeight * k));
  cnv.getContext('2d')!.drawImage(img, 0, 0, cnv.width, cnv.height);
  return { src: cnv.toDataURL('image/jpeg', UNDERLAY_JPEG_Q), w: cnv.width, h: cnv.height };
}

/** Import a picked file and drop it centred on the active room. */
export async function importUnderlay(store: Store, f: File): Promise<void> {
  let img: { src: string; w: number; h: number };
  try {
    img = await downscaleImage(f);
  } catch {
    setHint('Could not read that image — try a JPEG or PNG');
    return;
  }
  const b = polygonBounds(store.activeRoom().corners);
  const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  if (!store.setUnderlay(img.src, initialUnderlay(img.w, img.h, center))) {
    setHint('Could not store the reference photo — browser storage is full or blocked');
    return;
  }
  store.commit();
  setHint('Reference photo placed — drag it into position, then Calibrate scale');
}

/** The two calibration clicks spanned `dWorld` m — ask what that really is. */
export function applyCalibration(store: Store, dWorld: number): void {
  const u = store.design.underlay;
  if (!u) return;
  const answer = prompt('How long is that distance in reality? (cm)');
  const cm = Number(answer);
  if (answer === null || !Number.isFinite(cm) || cm <= 0) {
    setHint('Scale calibration cancelled');
    return;
  }
  const scale = underlayScaleFrom(dWorld, u.scale, cm / 100);
  store.updateUnderlay({ scale });
  store.commit();
  setHint(
    `Reference scaled: that span is ${Math.round(cm)} cm · 1 photo pixel = ${(scale * 100).toFixed(2)} cm`
  );
}
