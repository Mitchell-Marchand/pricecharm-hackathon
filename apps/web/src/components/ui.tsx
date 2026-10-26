'use client';

import Link from 'next/link';
import { useEffect, useRef, useId } from 'react';
import { ArrowUpRight, LoaderCircle, X, Sparkles, Check, AlertCircle } from 'lucide-react';
import type {
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
} from 'react';

export function Logo({ compact = false, href = '/' }: { compact?: boolean; href?: string }) {
  return (
    <Link className="logo" href={href} aria-label="Quotefolk home">
      <span>{compact ? 'q' : 'quotefolk'}</span>
    </Link>
  );
}
export function Button({
  children,
  loading,
  variant = 'primary',
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button
      className={`button button-${variant} ${className}`}
      disabled={loading || disabled}
      {...props}
    >
      {loading && <LoaderCircle className="spin" size={16} />}
      {children}
    </button>
  );
}
export function ButtonLink({
  children,
  href,
  secondary = false,
  className = '',
}: {
  children: ReactNode;
  href: string;
  secondary?: boolean;
  className?: string;
}) {
  return (
    <Link
      className={`button button-${secondary ? 'secondary' : 'primary'} ${className}`}
      href={href}
    >
      {children}
    </Link>
  );
}
export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const instanceId = useId();
  const id = props.id || props.name || `field-${instanceId}`;
  return (
    <label className="field" htmlFor={id}>
      <span>
        {label}
        {props.required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </span>
      <input id={id} {...props} />
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function TextArea({
  label,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const instanceId = useId();
  const id = props.id || props.name || `field-${instanceId}`;
  return (
    <label className="field" htmlFor={id}>
      <span>
        {label}
        {props.required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </span>
      <textarea id={id} rows={3} {...props} />
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Select({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const instanceId = useId();
  const id = props.id || props.name || `field-${instanceId}`;
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} {...props}>
        {children}
      </select>
    </label>
  );
}
export function Notice({
  children,
  kind = 'info',
}: {
  children: ReactNode;
  kind?: 'info' | 'error' | 'success';
}) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'success' ? <Check size={17} /> : <AlertCircle size={17} />}
      <span>{children}</span>
    </div>
  );
}
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon?: typeof Sparkles;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {Icon && (
        <span className="empty-icon">
          <Icon size={27} strokeWidth={1.5} />
        </span>
      )}
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="heading-action">{action}</div>}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable(),
        first = elements[0],
        last = elements[elements.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.current?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      previousFocus?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        tabIndex={-1}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className="text-link" href={href}>
      {children}
      <ArrowUpRight size={16} />
    </Link>
  );
}
