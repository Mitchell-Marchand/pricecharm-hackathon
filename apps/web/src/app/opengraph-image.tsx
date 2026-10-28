import { ImageResponse } from 'next/og';
import { OG, OG_SIZE, OgSlipLine, OgWordmark, ogFonts } from '@/lib/og-image';

export const alt = 'PriceCharm: a quote for a back patio and walkway, $275, accepted';
export const size = OG_SIZE;
export const contentType = 'image/png';

/** The preview when someone shares pricecharm.com: the headline beside an accepted quote. */
export default async function Image() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        padding: '64px 72px',
        gap: 56,
        background: OG.bg,
        fontFamily: 'Public Sans',
        color: OG.ink,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <OgWordmark size={34} />
        <div
          style={{
            marginTop: 60,
            fontFamily: 'Archivo',
            fontSize: 72,
            fontWeight: 800,
            lineHeight: 0.98,
            letterSpacing: '-0.025em',
          }}
        >
          Train an AI to quote like you.
        </div>
        <div style={{ marginTop: 28, fontSize: 30, lineHeight: 1.3, color: OG.ink2 }}>
          Show it a few jobs you’ve done. It quotes your customers with your prices.
        </div>
        <div style={{ marginTop: 'auto', fontFamily: 'Plex Mono', fontSize: 22, color: OG.muted }}>
          pricecharm.com
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignSelf: 'center',
          width: 420,
          padding: '30px 34px 34px',
          background: OG.paper,
          border: `2px solid ${OG.line}`,
          borderRadius: 14,
          boxShadow: '0 22px 44px -16px rgba(16, 22, 51, 0.24)',
          transform: 'rotate(2deg)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={{ fontFamily: 'Plex Mono', fontSize: 18, color: OG.muted }}>QUOTE</div>
          <div style={{ fontFamily: 'Plex Mono', fontSize: 18, color: OG.muted }}>No. 0412</div>
        </div>
        <div style={{ marginTop: 10, fontFamily: 'Archivo', fontSize: 32, fontWeight: 800 }}>
          Back patio and walkway
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
          <OgSlipLine label="Pressure wash, 600 sq ft" amount="$240" />
          <OgSlipLine label="Rinse beds and siding" amount="$35" />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 22,
          }}
        >
          <div
            style={{
              display: 'flex',
              padding: '6px 14px',
              border: `3px solid ${OG.go}`,
              borderRadius: 8,
              color: OG.go,
              fontFamily: 'Plex Mono',
              fontSize: 22,
              transform: 'rotate(-6deg)',
            }}
          >
            ACCEPTED
          </div>
          <div style={{ fontFamily: 'Plex Mono', fontSize: 40 }}>$275</div>
        </div>
      </div>
    </div>,
    { ...size, fonts: await ogFonts() },
  );
}
