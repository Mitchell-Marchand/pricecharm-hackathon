/** Longest walk-around a customer can send, and its biggest file. */
export const MAX_VIDEO_SECONDS = 90;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export type VideoStill = { blob: Blob; ms: number };

/**
 * A few stills from a video the customer picked, taken in the browser, with how long it runs.
 * What was counted gets drawn on these for the owner. A browser that can't play the file still
 * sends the video, just without stills.
 */
export async function readVideo(
  file: File,
  count = 5,
): Promise<{ durationMs: number | null; stills: VideoStill[]; poster: string }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('unplayable'));
      window.setTimeout(() => reject(new Error('slow')), 8000);
    });
  } catch {
    URL.revokeObjectURL(url);
    return { durationMs: null, stills: [], poster: '' };
  }
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  const stills: VideoStill[] = [];
  let poster = '';
  for (let index = 0; index < count && context && duration; index++) {
    // Evenly through the video, skipping the very start and end, where phones are still moving.
    const at = duration * ((index + 0.5) / count);
    try {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        window.setTimeout(() => reject(new Error('slow')), 4000);
        video.currentTime = at;
      });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.82),
      );
      if (blob) stills.push({ blob, ms: Math.round(at * 1000) });
      if (!poster) poster = canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      // A still that won't come out is skipped; the video still goes.
    }
  }
  URL.revokeObjectURL(url);
  return { durationMs: duration ? Math.round(duration * 1000) : null, stills, poster };
}
