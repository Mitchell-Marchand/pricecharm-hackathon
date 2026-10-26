import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** A real, scannable QR code drawn as one SVG path. */
export function QRCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    const count = code.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (code.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { size: count + 8, path: d };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="block h-auto w-full max-w-full" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="var(--paper)" />
      <path d={path} fill="var(--paper-ink)" />
    </svg>
  );
}
