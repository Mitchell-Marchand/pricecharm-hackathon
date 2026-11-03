import { z } from 'zod';
import { configuredOrigins } from '../config.js';
import { ApiError } from '../http.js';

/**
 * QuickBooks Online: signing an owner in to their company, and reading its invoices. Nothing here
 * touches the database. Keys come from PriceCharm's app on developer.intuit.com; without them the
 * connection is simply not offered.
 */

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';

export function quickbooksConfigured(): boolean {
  return Boolean(process.env.QUICKBOOKS_CLIENT_ID?.trim() && process.env.QUICKBOOKS_CLIENT_SECRET);
}

/** Development keys only reach sandbox companies, so that's the default until it's set. */
function apiBase() {
  return process.env.QUICKBOOKS_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/** Must match a redirect URI on the Intuit app exactly. */
export function redirectUri(): string {
  return (
    process.env.QUICKBOOKS_REDIRECT_URI?.trim() ||
    `${configuredOrigins()[0]}/api/v1/onboarding/quickbooks/callback`
  );
}

export function authorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', process.env.QUICKBOOKS_CLIENT_ID!.trim());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

const basicAuth = () =>
  `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID!.trim()}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number(),
});
export type Tokens = { accessToken: string; refreshToken: string; expiresAt: Date };

/** QuickBooks said no to these keys or tokens: connecting again is the only fix. */
export class QuickBooksAuthError extends ApiError {
  constructor() {
    super(409, 'QUICKBOOKS_DISCONNECTED', 'QuickBooks needs you to connect again.');
  }
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 400 || response.status === 401) throw new QuickBooksAuthError();
  if (!response.ok) throw new Error(`QuickBooks token request failed with ${response.status}.`);
  const tokens = tokenSchema.parse(await response.json());
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
  };
}

export const exchangeCode = (code: string) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });

export const refreshTokens = (refreshToken: string) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

/** Tells QuickBooks we're done. A token it no longer knows is fine. */
export async function revokeToken(refreshToken: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
}

async function companyGet(realmId: string, accessToken: string, path: string, query = {}) {
  const url = new URL(`${apiBase()}/v3/company/${encodeURIComponent(realmId)}/${path}`);
  for (const [key, value] of Object.entries({ ...query, minorversion: MINOR_VERSION }))
    url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) throw new QuickBooksAuthError();
  if (!response.ok) throw new Error(`QuickBooks ${path} failed with ${response.status}.`);
  return (await response.json()) as Record<string, unknown>;
}

export async function companyName(realmId: string, accessToken: string): Promise<string> {
  const body = await companyGet(realmId, accessToken, `companyinfo/${encodeURIComponent(realmId)}`);
  const info = body.CompanyInfo as { CompanyName?: unknown } | undefined;
  return typeof info?.CompanyName === 'string' ? info.CompanyName.slice(0, 160) : '';
}

const ref = z.object({ value: z.string(), name: z.string().optional() }).partial();
type Line = {
  Description?: string;
  Amount?: number;
  DetailType?: string;
  SalesItemLineDetail?: {
    ItemRef?: z.infer<typeof ref>;
    Qty?: number;
    UnitPrice?: number;
    ServiceDate?: string;
  };
  GroupLineDetail?: { GroupItemRef?: z.infer<typeof ref>; Quantity?: number; Line?: Line[] };
  DiscountLineDetail?: { PercentBased?: boolean; DiscountPercent?: number };
};
const lineSchema: z.ZodType<Line> = z.lazy(() =>
  z
    .object({
      Description: z.string(),
      Amount: z.number(),
      DetailType: z.string(),
      SalesItemLineDetail: z
        .object({ ItemRef: ref, Qty: z.number(), UnitPrice: z.number(), ServiceDate: z.string() })
        .partial(),
      GroupLineDetail: z
        .object({ GroupItemRef: ref, Quantity: z.number(), Line: z.array(lineSchema) })
        .partial(),
      DiscountLineDetail: z
        .object({ PercentBased: z.boolean(), DiscountPercent: z.number() })
        .partial(),
    })
    .partial(),
);
const invoiceSchema = z.object({
  Id: z.string(),
  DocNumber: z.string().optional(),
  TxnDate: z.string().optional(),
  TotalAmt: z.number().default(0),
  CurrencyRef: ref.optional(),
  Line: z.array(lineSchema).default([]),
  TxnTaxDetail: z.object({ TotalTax: z.number() }).partial().optional(),
  CustomerMemo: z.object({ value: z.string() }).partial().optional(),
  PrivateNote: z.string().optional(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

/** Newest first, a page at a time. QuickBooks counts positions from 1. */
export async function invoicePage(
  realmId: string,
  accessToken: string,
  start: number,
  size: number,
): Promise<Invoice[]> {
  const body = await companyGet(realmId, accessToken, 'query', {
    query: `SELECT * FROM Invoice ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS ${size}`,
  });
  const found = (body.QueryResponse as { Invoice?: unknown[] } | undefined)?.Invoice ?? [];
  return found.flatMap((item) => {
    const parsed = invoiceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** What kind of thing each item is: Service, Inventory, NonInventory, Group or Category. */
export async function itemTypes(
  realmId: string,
  accessToken: string,
  ids: string[],
): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  const safe = [...new Set(ids)].filter((id) => /^\d+$/.test(id));
  for (let index = 0; index < safe.length; index += 500) {
    const chunk = safe.slice(index, index + 500);
    const body = await companyGet(realmId, accessToken, 'query', {
      query: `SELECT * FROM Item WHERE Id IN (${chunk.map((id) => `'${id}'`).join(',')}) MAXRESULTS 1000`,
    });
    const items = (body.QueryResponse as { Item?: { Id?: unknown; Type?: unknown }[] } | undefined)
      ?.Item;
    for (const item of items ?? [])
      if (typeof item.Id === 'string' && typeof item.Type === 'string')
        types.set(item.Id, item.Type);
  }
  return types;
}

export function itemIds(invoice: Invoice): string[] {
  const walk = (lines: Line[]): string[] =>
    lines.flatMap((line) => [
      ...(line.SalesItemLineDetail?.ItemRef?.value ? [line.SalesItemLineDetail.ItemRef.value] : []),
      ...walk(line.GroupLineDetail?.Line ?? []),
    ]);
  return walk(invoice.Line);
}

/** The total the customer was charged, before tax. */
export const beforeTax = (invoice: Invoice) =>
  Math.round((invoice.TotalAmt - (invoice.TxnTaxDetail?.TotalTax ?? 0)) * 100) / 100;

const amount = (value: number | undefined) => (value ?? 0).toFixed(2);

/**
 * The invoice written out for the reader: what was done and what it cost. The customer's name,
 * addresses and contact details are left out on purpose.
 */
export function invoiceText(invoice: Invoice, types: Map<string, string>): string {
  const kind = (line: Line) => {
    const type = types.get(line.SalesItemLineDetail?.ItemRef?.value ?? '');
    return type === 'Service'
      ? ' (a service)'
      : type === 'Inventory' || type === 'NonInventory'
        ? ' (a product or material)'
        : '';
  };
  const describe = (line: Line, indent: string): string[] => {
    if (line.DetailType === 'SalesItemLineDetail') {
      const detail = line.SalesItemLineDetail ?? {};
      const name = detail.ItemRef?.name?.trim() || 'Item';
      const text = line.Description?.trim() ? `: ${line.Description.trim()}` : '';
      const when =
        detail.ServiceDate && detail.ServiceDate !== invoice.TxnDate
          ? `, done ${detail.ServiceDate}`
          : '';
      const count =
        detail.Qty !== undefined && detail.UnitPrice !== undefined
          ? `${detail.Qty} × ${amount(detail.UnitPrice)} = `
          : '';
      return [`${indent}- ${name}${kind(line)}${text}${when}. ${count}${amount(line.Amount)}`];
    }
    if (line.DetailType === 'GroupLineDetail') {
      const detail = line.GroupLineDetail ?? {};
      return [
        `${indent}- ${detail.GroupItemRef?.name?.trim() || 'Bundle'}${detail.Quantity ? `, ${detail.Quantity} of them` : ''}${line.Description?.trim() ? `: ${line.Description.trim()}` : ''}. ${amount(line.Amount)}`,
        ...(detail.Line ?? []).flatMap((part) => describe(part, `${indent}  `)),
      ];
    }
    if (line.DetailType === 'DescriptionOnly' && line.Description?.trim())
      return [`${indent}- ${line.Description.trim()}`];
    return [];
  };
  const discounts = invoice.Line.filter((line) => line.DetailType === 'DiscountLineDetail').map(
    (line) =>
      line.DiscountLineDetail?.PercentBased && line.DiscountLineDetail.DiscountPercent
        ? `Discount: ${line.DiscountLineDetail.DiscountPercent}% = ${amount(line.Amount)}`
        : `Discount: ${amount(line.Amount)}`,
  );
  const tax = invoice.TxnTaxDetail?.TotalTax ?? 0;
  return [
    `Invoice${invoice.DocNumber ? ` ${invoice.DocNumber}` : ''}${invoice.TxnDate ? `, dated ${invoice.TxnDate}` : ''}${invoice.CurrencyRef?.value ? `, in ${invoice.CurrencyRef.value}` : ''}.`,
    'Lines:',
    ...invoice.Line.flatMap((line) => describe(line, '')),
    ...discounts,
    ...(tax ? [`Tax: ${amount(tax)}`] : []),
    `Total before tax: ${amount(beforeTax(invoice))}`,
    ...(invoice.CustomerMemo?.value?.trim()
      ? [`Message to the customer: ${invoice.CustomerMemo.value.trim()}`]
      : []),
    ...(invoice.PrivateNote?.trim() ? [`The owner's own note: ${invoice.PrivateNote.trim()}`] : []),
  ]
    .join('\n')
    .slice(0, 6000);
}

/** What the owner sees on the list for it, like "QuickBooks invoice 1042, Jun 3, 2026". */
export function invoiceLabel(invoice: Invoice): string {
  const date = invoice.TxnDate ? new Date(`${invoice.TxnDate}T12:00:00Z`) : null;
  const when =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : '';
  return `QuickBooks invoice${invoice.DocNumber ? ` ${invoice.DocNumber}` : ''}${when ? `, ${when}` : ''}`.slice(
    0,
    180,
  );
}
