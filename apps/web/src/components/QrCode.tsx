import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { useT } from '../i18n/useT';

/**
 * A QR code as inline SVG. SVG rather than canvas because this gets held up to
 * someone else's camera: it stays sharp at whatever size the phone decides to
 * render it, and it survives the browser's own zoom.
 *
 * Error correction 'M' — 'L' saves a version or two but this is being read off
 * a screen that may be scratched, dim or behind a case.
 */
export function QrCode({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, 'M'); // 0 = smallest version that fits
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    // One path for the whole code: thousands of <rect>s is what makes naive QR
    // components slow to render on the phones that need this most.
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { path: d, size: count };
  }, [text]);

  const quiet = 4; // the spec's quiet zone; without it many scanners fail
  return (
    <svg
      viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
      className={className}
      role="img"
      aria-label={t('join.codeLabel')}
      shapeRendering="crispEdges"
    >
      {/* Always light-on-dark-free: a themed QR is a QR that sometimes fails. */}
      <rect x={-quiet} y={-quiet} width={size + quiet * 2} height={size + quiet * 2} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
