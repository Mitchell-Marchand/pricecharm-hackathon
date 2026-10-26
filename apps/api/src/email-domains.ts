import { disposableEmailBlocklistSet } from 'disposable-email-domains-js';

const disposable = disposableEmailBlocklistSet();

/** True for a throwaway inbox service, including any subdomain of one. */
export function isDisposableEmail(email: string): boolean {
  const labels = email
    .slice(email.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase()
    .split('.');
  for (let index = 0; index < labels.length - 1; index++)
    if (disposable.has(labels.slice(index).join('.'))) return true;
  return false;
}
