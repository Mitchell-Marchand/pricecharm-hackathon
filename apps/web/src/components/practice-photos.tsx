'use client';

import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { TrainingMessagePhotos, TrainingPhotoAttachment } from '@/lib/types';
import { Modal } from './ui';
import styles from './practice-photos.module.css';

type Props = {
  photos: TrainingMessagePhotos;
  onRetry: () => void;
  retrying: boolean;
  retryDisabled?: boolean;
  retryUnavailableReason?: string;
  retryError?: string;
  refreshError?: string;
  needsSignIn?: boolean;
  onRefresh: () => void;
};

export default function PracticePhotos({
  photos,
  onRetry,
  retrying,
  retryDisabled,
  retryUnavailableReason,
  retryError,
  refreshError,
  needsSignIn,
  onRefresh,
}: Props) {
  const [selected, setSelected] = useState<TrainingPhotoAttachment>();
  return (
    <section
      className={styles.photos}
      aria-label="Generated practice photos"
      aria-busy={photos.status === 'pending'}
    >
      {photos.status === 'pending' ? (
        <div className={styles.progress}>
          <p role="status" aria-live="polite">
            {!refreshError && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            {refreshError || 'Creating practice photos…'}
          </p>
          {refreshError && needsSignIn ? (
            <a href="/login" className={styles.quietAction}>
              Sign in again
            </a>
          ) : refreshError ? (
            <button type="button" onClick={onRefresh} className={styles.quietAction}>
              Check photo progress
            </button>
          ) : null}
        </div>
      ) : photos.status === 'failed' ? (
        <div className={styles.failure}>
          <p role="alert">
            {retryError || photos.error || 'We couldn’t create these practice photos.'}
          </p>
          {photos.retryable !== false && (
            <button
              type="button"
              className={styles.quietAction}
              disabled={retrying || retryDisabled}
              onClick={onRetry}
              aria-label="Try photos again"
            >
              {retrying ? 'Requesting photos…' : 'Try photos again'}
            </button>
          )}
          {retryUnavailableReason && <p>{retryUnavailableReason}</p>}
        </div>
      ) : null}
      {photos.attachments.length > 0 && (
        <>
          <p className={styles.caption}>AI-generated practice photos</p>
          <div className={styles.gallery}>
            {photos.attachments.map((photo) => (
              <figure key={photo.id} className={styles.tile}>
                <PhotoImage photo={photo} onOpen={() => setSelected(photo)} />
                <figcaption>{photo.label}</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
      {selected && (
        <Modal
          title={selected.label}
          subtitle="AI-generated for this practice job."
          onClose={() => setSelected(undefined)}
        >
          <div className={styles.viewer}>
            <PhotoImage key={selected.id} photo={selected} />
            <p>{selected.alt}</p>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function PracticePhotoRequest({
  onRequest,
  loading,
  disabled,
}: {
  onRequest: () => void;
  loading: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.quietAction} ${styles.request}`}
      onClick={onRequest}
      disabled={loading || disabled}
      aria-label="Show sample photos"
    >
      {loading ? 'Requesting photos…' : 'Show sample photos'}
    </button>
  );
}

function PhotoImage({ photo, onOpen }: { photo: TrainingPhotoAttachment; onOpen?: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const image = useRef<HTMLImageElement>(null);
  const source = attempt
    ? `${photo.url}${photo.url.includes('?') ? '&' : '?'}photoRetry=${attempt}`
    : photo.url;
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth > 0) setStatus('ready');
  }, [source]);
  const frame = (
    <span className={`${styles.imageFrame} ${onOpen ? '' : styles.fullImage}`}>
      <img
        ref={image}
        src={source}
        alt={photo.alt}
        width={photo.width}
        height={photo.height}
        className={status === 'ready' ? styles.loaded : styles.unloaded}
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('failed')}
        decoding="async"
      />
      {status === 'loading' && (
        <span className={styles.imageStatus} role="status">
          Loading photo…
        </span>
      )}
      {status === 'failed' && <span className={styles.imageStatus}>Photo unavailable</span>}
    </span>
  );
  return (
    <div className={styles.image}>
      {onOpen ? (
        <button
          type="button"
          className={styles.preview}
          onClick={onOpen}
          disabled={status !== 'ready'}
          aria-label={`Open sample photo: ${photo.label}`}
        >
          {frame}
        </button>
      ) : (
        frame
      )}
      {status === 'failed' && (
        <div className={styles.imageError}>
          <p role="alert">This photo didn’t load.</p>
          <button
            type="button"
            className={styles.quietAction}
            onClick={() => {
              setStatus('loading');
              setAttempt((value) => value + 1);
            }}
          >
            Retry image
          </button>
        </div>
      )}
    </div>
  );
}
