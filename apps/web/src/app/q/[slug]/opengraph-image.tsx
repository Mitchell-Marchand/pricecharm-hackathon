import { ImageResponse } from 'next/og';
import { OG, OG_SIZE, OgSlipLine, OgWordmark, ogFonts } from '@/lib/og-image';
import { publicBusiness } from '@/lib/server-api';

export const alt = 'Get a quote';
export const size = OG_SIZE;
export const contentType = 'image/png';
// Rendered here rather than cached by Next, so unknown links can't fill its cache. Real ones are
// kept below for an hour.
export const dynamic = 'force-dynamic';

const rendered = new Map<string, { png: ArrayBuffer; until: number }>();
const KEEP_MS = 60 * 60_000;
const MAX_KEPT = 300;

/** The preview when an owner texts or posts their quote link: their business name, big. */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const business = await publicBusiness(slug);
  if (business === null) return new Response(null, { status: 404 });
  const name = (business?.name ?? '').trim().slice(0, 60);
  const key = `${slug}\n${name}`;
  const kept = rendered.get(key);
  if (kept && kept.until > Date.now()) return png(kept.png);

  const image = new ImageResponse(
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
        <div style={{ fontSize: 34, color: OG.ink2 }}>
          {name ? 'Get a quote from' : 'Get a quote'}
        </div>
        {name ? (
          <div
            style={{
              marginTop: 14,
              fontFamily: 'Archivo',
              fontSize: name.length > 26 ? 64 : 82,
              fontWeight: 800,
              lineHeight: 1,
              letterSpacing: '-0.025em',
            }}
          >
            {name}
          </div>
        ) : null}
        <div style={{ marginTop: 30, fontSize: 30, lineHeight: 1.3, color: OG.ink2 }}>
          Tell them about the job and add a photo. Your price comes back in about 2 minutes.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 'auto' }}>
          <div style={{ fontSize: 24, color: OG.muted }}>Quotes by</div>
          <OgWordmark size={26} />
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignSelf: 'center',
          width: 360,
          padding: '30px 34px 34px',
          background: OG.paper,
          border: `2px solid ${OG.line}`,
          borderRadius: 14,
          boxShadow: '0 22px 44px -16px rgba(16, 22, 51, 0.24)',
          transform: 'rotate(2deg)',
        }}
      >
        <div style={{ fontFamily: 'Plex Mono', fontSize: 18, color: OG.muted }}>YOUR QUOTE</div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
          <OgSlipLine label="The job" />
          <OgSlipLine label="A photo or two" />
          <OgSlipLine label="Your price" />
        </div>
        <div
          style={{
            display: 'flex',
            alignSelf: 'flex-start',
            marginTop: 24,
            padding: '8px 14px',
            borderRadius: 8,
            background: OG.canary,
            fontSize: 22,
          }}
        >
          About 2 minutes
        </div>
      </div>
    </div>,
    { ...size, fonts: await ogFonts() },
  );
  const bytes = await image.arrayBuffer();
  // The API can briefly fail to answer; keep only images that carry the business's name.
  if (name) {
    if (rendered.size >= MAX_KEPT) rendered.delete(rendered.keys().next().value!);
    rendered.set(key, { png: bytes, until: Date.now() + KEEP_MS });
  }
  return png(bytes);
}

function png(bytes: ArrayBuffer) {
  return new Response(bytes, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
  });
}
