import { useEffect, useRef, useState } from 'react';
import type { MessageKey, TranslateOptions } from '../i18n';
import { useT } from '../i18n/useT';

/**
 * Camera QR scanner (design §4.2). Only the *inviter* ever needs this — the
 * joiner merely renders a code — which is the right way round: the person with
 * the older phone is the one being added.
 *
 * Two decoders. `BarcodeDetector` is native, fast and free of bundle cost, but
 * only Chromium ships it; everywhere else falls back to jsQR, loaded lazily so
 * nobody downloads a decoder they never open.
 */

type Detected = { rawValue: string };
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Detected[]>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

const nativeDetector = (): BarcodeDetectorLike | null => {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ['qr_code'] });
  } catch {
    return null; // present but without qr_code support
  }
};

async function jsqrDetector(): Promise<(canvas: HTMLCanvasElement) => string | null> {
  const { default: jsQR } = await import('jsqr');
  return (canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const { width, height } = canvas;
    const found = jsQR(ctx.getImageData(0, 0, width, height).data, width, height);
    return found?.data ?? null;
  };
}

export function QrScanner({ onScan, onCancel }: { onScan: (text: string) => void; onCancel: () => void }) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  // The message is held as a key and put into words at render, so the effect
  // below never has to depend on the language — changing it mid-scan would
  // otherwise tear down the camera and start it again.
  const [error, setError] = useState<{ key: MessageKey; values?: TranslateOptions } | null>(null);
  // A ref, not state: the scan loop must see the latest callback without being
  // torn down and restarting the camera on every render.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError({ key: 'scan.noCamera' });
        return;
      }
      try {
        // The back camera by preference; `ideal` rather than `exact` so a
        // laptop with only a webcam still works.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
        });
      } catch (err) {
        setError(
          (err as Error).name === 'NotAllowedError'
            ? { key: 'scan.refused' }
            : { key: 'scan.failed', values: { reason: (err as Error).message } },
        );
        return;
      }
      const video = videoRef.current;
      if (!video || stopped) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      const native = nativeDetector();
      const fallback = native ? null : await jsqrDetector();
      const canvas = document.createElement('canvas');

      const tick = async (): Promise<void> => {
        if (stopped) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            let text: string | null = null;
            if (native) {
              text = (await native.detect(video))[0]?.rawValue ?? null;
            } else if (fallback) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              canvas.getContext('2d')!.drawImage(video, 0, 0);
              text = fallback(canvas);
            }
            if (text) {
              stopped = true;
              onScanRef.current(text);
              return;
            }
          } catch {
            /* a frame that failed to decode is the normal case, not an error */
          }
        }
        frame = requestAnimationFrame(() => void tick());
      };
      void tick();
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop()); // release the camera light
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p className="rounded bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {t(error.key, error.values)}
        </p>
      ) : (
        <div className="relative overflow-hidden rounded bg-black">
          <video ref={videoRef} playsInline muted className="h-56 w-full object-cover" />
          <div className="pointer-events-none absolute inset-6 rounded border-2 border-white/70" />
        </div>
      )}
      <button
        onClick={onCancel}
        className="self-start rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 dark:border-slate-600 dark:text-slate-300"
      >
        {t('scan.cancel')}
      </button>
    </div>
  );
}
