import type { ReactNode } from 'react';

/** The size link previews use: iMessage, Slack, Facebook, LinkedIn and X all crop to it. */
export const OG_SIZE = { width: 1200, height: 630 };

export const OG = {
  bg: '#f1f3f7',
  paper: '#ffffff',
  ink: '#101633',
  ink2: '#39415f',
  muted: '#5e6684',
  line: '#dce1ea',
  rule: '#d9e1f2',
  canary: '#ffd43b',
  go: '#11804d',
};

type Font = { name: string; data: ArrayBuffer; weight: 500 | 600 | 800; style: 'normal' };

const FONTS = [
  // Archivo at the width the site's headings use (semi-expanded is 112.5%).
  { name: 'Archivo', query: 'Archivo:wdth,wght@112.5,800', weight: 800 },
  { name: 'Public Sans', query: 'Public+Sans:wght@500', weight: 500 },
  { name: 'Plex Mono', query: 'IBM+Plex+Mono:wght@600', weight: 600 },
] as const;

async function googleFont({ name, query, weight }: (typeof FONTS)[number]): Promise<Font> {
  // Without a browser user agent, Google answers with TrueType, which the image renderer reads.
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${query}`, {
    signal: AbortSignal.timeout(5000),
  }).then((response) => response.text());
  const url = css.match(/src: url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\) format\('truetype'\)/);
  if (!url) throw new Error(`No TrueType file for ${name}.`);
  const data = await fetch(url[1], { signal: AbortSignal.timeout(5000) }).then((response) =>
    response.arrayBuffer(),
  );
  return { name, data, weight, style: 'normal' };
}

let loading: Promise<Font[]> | undefined;
/** The site's fonts, fetched once per server. If Google can't be reached, the built-in font. */
export function ogFonts(): Promise<Font[]> {
  loading ??= Promise.all(FONTS.map(googleFont)).catch(() => {
    loading = undefined;
    return [];
  });
  return loading;
}

/** The tag-on-a-ring mark, as on the site header. */
export function OgMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28">
      <g transform="rotate(-45 14 14) translate(0 -2.35)">
        <circle cx="14" cy="9.6" r="4" fill="none" stroke={OG.canary} strokeWidth="2.2" />
        <path
          d="M14 10 20.5 15.5V27H7.5V15.5Z"
          fill={OG.canary}
          stroke={OG.canary}
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

export function OgWordmark({ size }: { size: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.3 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size * 1.5,
          height: size * 1.5,
          borderRadius: size * 0.33,
          background: OG.ink,
        }}
      >
        <OgMark size={size * 1.1} />
      </div>
      <div
        style={{
          fontFamily: 'Archivo',
          fontSize: size,
          fontWeight: 800,
          letterSpacing: '-0.03em',
          color: OG.ink,
        }}
      >
        pricecharm
      </div>
    </div>
  );
}

/** One line on the quote slip: what's included on the left, the amount on the right. */
export function OgSlipLine({ label, amount }: { label: ReactNode; amount?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        height: 50,
        paddingBottom: 10,
        borderBottom: `2px solid ${OG.rule}`,
        fontSize: 24,
        color: OG.ink2,
      }}
    >
      <div style={{ display: 'flex' }}>{label}</div>
      {amount ? <div style={{ fontFamily: 'Plex Mono', color: OG.ink }}>{amount}</div> : null}
    </div>
  );
}
