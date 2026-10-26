import { api, json } from './api';
import type { GuestPreview, Service } from './types';

const draftKey = 'quotient:guest-preview:draft';
const approvalKey = 'quotient:guest-preview:approval';

export type GuestDraft = {
  content: string;
  requestId: string;
  editing: boolean;
  needsCheck?: boolean;
  attemptContent?: string;
  attemptExpiresAt?: string;
};
export type GuestApproval = { previewId: string; version: number };

export function readGuestDraft(): GuestDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
    if (typeof value?.content !== 'string' || typeof value.requestId !== 'string') return null;
    return {
      content: value.content.slice(0, 5000),
      requestId: value.requestId,
      editing: !!value.editing,
      needsCheck: !!value.needsCheck,
      attemptContent:
        typeof value.attemptContent === 'string' ? value.attemptContent.slice(0, 5000) : undefined,
      attemptExpiresAt:
        typeof value.attemptExpiresAt === 'string' ? value.attemptExpiresAt : undefined,
    };
  } catch {
    return null;
  }
}

export function saveGuestDraft(value: GuestDraft) {
  try {
    sessionStorage.setItem(draftKey, JSON.stringify(value));
  } catch {
    // The HttpOnly guest cookie can still restore the server's last submitted note.
  }
}

export function approveGuestPreview(preview: GuestPreview) {
  const approval = { previewId: preview.id, version: preview.version };
  try {
    sessionStorage.setItem(approvalKey, JSON.stringify(approval));
  } catch {
    // The caller can keep the explicit approval in memory for the current page.
  }
  return approval;
}

export function readGuestApproval(): GuestApproval | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(approvalKey) || 'null');
    return typeof value?.previewId === 'string' && Number.isInteger(value.version) ? value : null;
  } catch {
    return null;
  }
}

export function clearGuestApproval() {
  try {
    sessionStorage.removeItem(approvalKey);
  } catch {
    // Browser storage is optional.
  }
}

export function guestAuthUrl(path: '/signup' | '/login', approval: GuestApproval) {
  return `${path}?from=preview&previewId=${encodeURIComponent(approval.previewId)}&version=${approval.version}`;
}

export function readGuestUrlApproval(): GuestApproval | null {
  const params = new URLSearchParams(window.location.search);
  const previewId = params.get('previewId');
  const version = Number(params.get('version'));
  return previewId &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(previewId) &&
    Number.isInteger(version) &&
    version > 0
    ? { previewId, version }
    : null;
}

export function finishGuestClaim(
  serviceId: string,
  approvedPreview?: Pick<GuestPreview, 'content' | 'receipt'>,
) {
  const approvedContent = approvedPreview?.content;
  try {
    sessionStorage.removeItem('quotient:first-job');
    const draft = readGuestDraft();
    if (
      draft &&
      (approvedContent === undefined ||
        draft.content.trim() !== approvedContent.trim() ||
        draft.needsCheck)
    )
      saveGuestDraft({ ...draft, editing: true });
    else sessionStorage.removeItem(draftKey);
    sessionStorage.removeItem(approvalKey);
  } catch {
    // The saved service is durable even if browser storage is unavailable.
  }
  return `/dashboard?service=${encodeURIComponent(serviceId)}&step=teach`;
}

export function claimGuestPreview(approval: GuestApproval) {
  return api<{ service: Service; alreadyClaimed: boolean }>(
    `/guest-preview/${encodeURIComponent(approval.previewId)}/claim`,
    { method: 'POST', ...json({ expectedVersion: approval.version, approveIntake: true }) },
  );
}
