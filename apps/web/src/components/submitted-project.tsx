import type { ReactNode } from 'react';
import type { Quote } from '@/lib/types';
import styles from './submitted-project.module.css';

function label(key: string) {
  if (key === 'location') return 'City or area';
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function value(text: string) {
  if (!text.trim()) return 'Not provided';
  if (text === 'unknown') return 'Unknown';
  if (text === 'true') return 'Yes';
  if (text === 'false') return 'No';
  return text;
}

export default function SubmittedProject({
  quote,
  noteLabel,
  fallback,
}: {
  quote: Pick<Quote, 'submittedIntake' | 'quantity' | 'description'>;
  noteLabel: 'Customer note' | 'Your note';
  fallback: ReactNode;
}) {
  const snapshot = quote.submittedIntake;
  const facts =
    snapshot?.inputs && typeof snapshot.inputs === 'object'
      ? Object.entries(snapshot.inputs)
          .filter(([key, text]) => key.trim() && typeof text === 'string')
          .map(([key, text]) => ({ key, label: label(key), value: value(text) }))
      : [];
  const quantity =
    snapshot?.quantityUnknown === true
      ? 'Unknown'
      : snapshot?.quantityUnknown === false &&
          Number.isFinite(quote.quantity) &&
          quote.quantity >= 0.001 &&
          quote.quantity <= 10_000_000
        ? quote.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })
        : undefined;
  if (!facts.length && quantity === undefined) return fallback;
  return (
    <section className={styles.details} aria-label="Submitted project details">
      <h4>Project details</h4>
      <dl>
        {facts.map((fact) => (
          <div key={fact.key}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
        {quantity !== undefined && (
          <div>
            <dt>Quantity</dt>
            <dd>{quantity}</dd>
          </div>
        )}
      </dl>
      <div className={styles.note}>
        <h5>{noteLabel}</h5>
        <p>{quote.description}</p>
      </div>
    </section>
  );
}
