import { cx } from '@/lib/util';

// The button look lives here, outside the client components, so server pages can use it too.
export type Variant = 'primary' | 'quote' | 'secondary' | 'ghost' | 'link';
export type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-on-ink hover:opacity-90 disabled:opacity-35',
  quote:
    'bg-canary text-on-canary shadow-[inset_0_-2px_0_rgb(16_22_51/0.18)] hover:brightness-[1.03] disabled:opacity-40',
  secondary:
    'border border-line-strong bg-surface text-ink hover:border-ink/40 disabled:opacity-40',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40',
  link: 'px-0! text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent',
};
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-[15px] gap-2',
  lg: 'h-13 px-6 text-base gap-2.5',
};

/** The button look, for links that should read as buttons. */
export function buttonClass(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  return cx(
    'inline-flex shrink-0 items-center justify-center rounded-sm font-semibold whitespace-nowrap transition-[opacity,background-color,border-color,filter] duration-150 disabled:cursor-not-allowed [&_svg]:size-[1.1em]',
    VARIANTS[variant],
    variant !== 'link' && SIZES[size],
    className,
  );
}
