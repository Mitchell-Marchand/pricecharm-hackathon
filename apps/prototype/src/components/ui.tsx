import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Check } from 'lucide-react';
import { cx } from '../lib/util';

type Variant = 'primary' | 'quote' | 'secondary' | 'ghost' | 'link';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-on-ink hover:opacity-90 disabled:opacity-35',
  quote:
    'bg-canary text-on-canary shadow-[inset_0_-2px_0_rgb(16_22_51/0.18)] hover:brightness-[1.03] disabled:opacity-40',
  secondary: 'border border-line-strong bg-surface text-ink hover:border-ink/40 disabled:opacity-40',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40',
  link: 'px-0! text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent',
};
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-[15px] gap-2',
  lg: 'h-13 px-6 text-base gap-2.5',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(function Button({ variant = 'primary', size = 'md', className, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-sm font-semibold whitespace-nowrap transition-[opacity,background-color,border-color,filter] duration-150 disabled:cursor-not-allowed [&_svg]:size-[1.1em]',
        VARIANTS[variant],
        variant !== 'link' && SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor: string;
  optional?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-ink">
        {label}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      {children}
      {hint && !error && <p className="text-sm text-muted">{hint}</p>}
      {error && <p className="text-sm text-stop">{error}</p>}
    </div>
  );
}

const control =
  'w-full min-w-0 rounded-sm border border-line-strong bg-surface text-ink transition-[border-color,box-shadow] duration-150 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none';

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cx(control, 'h-12 px-3.5 text-base', className)} {...props} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cx(control, 'min-h-24 resize-y px-3.5 py-3 text-base', className)} {...props} />;
});

export function MoneyInput({
  value,
  onChange,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={cx('relative min-w-0', className)}>
      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 font-mono text-muted">$</span>
      <input
        inputMode="decimal"
        autoComplete="off"
        className={cx(control, 'tabular h-12 pr-3.5 pl-7 font-mono text-base')}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^\d.,]/g, ''))}
        {...props}
      />
    </div>
  );
}

export function Chip({
  selected,
  onClick,
  children,
  className,
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        'inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-[15px] font-medium transition-colors duration-150',
        selected
          ? 'border-accent bg-accent-soft text-ink'
          : 'border-line-strong bg-surface text-ink-2 hover:border-ink/40 hover:text-ink',
        className,
      )}
    >
      {selected && <Check className="size-4 text-accent" aria-hidden />}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm border border-line-strong bg-surface-2 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-9 rounded-[6px] px-3.5 text-sm font-semibold transition-colors',
            value === option.value ? 'bg-surface text-ink shadow-1' : 'text-muted hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const TONES = {
  canary: 'bg-canary text-on-canary',
  pink: 'bg-[var(--paper-pink)] text-[var(--paper-ink)]',
  blue: 'bg-accent text-on-accent',
  ink: 'bg-ink text-on-ink',
} as const;

export function Avatar({
  initials,
  tone = 'ink',
  size = 'md',
}: {
  initials: string;
  tone?: keyof typeof TONES;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold',
        TONES[tone],
        size === 'sm' && 'size-7 text-[11px]',
        size === 'md' && 'size-9 text-xs',
        size === 'lg' && 'size-11 text-sm',
      )}
    >
      {initials}
    </span>
  );
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'go' | 'canary' }) {
  return (
    <span
      className={cx(
        't-label inline-flex h-6 items-center rounded-xs px-2 text-[10.5px]!',
        tone === 'neutral' && 'bg-surface-2 text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'go' && 'bg-go-soft text-go',
        tone === 'canary' && 'bg-canary-soft text-ink',
      )}
    >
      {children}
    </span>
  );
}

export function useFieldId(prefix: string) {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}
