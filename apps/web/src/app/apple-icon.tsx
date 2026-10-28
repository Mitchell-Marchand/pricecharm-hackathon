import { ImageResponse } from 'next/og';
import { OG, OgMark } from '@/lib/og-image';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** The home-screen icon on iPhones and iPads, which don't use the SVG favicon. */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        background: OG.ink,
      }}
    >
      <OgMark size={132} />
    </div>,
    size,
  );
}
