import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { cookies } from './auth.js';
import { mutate, rows, transaction } from './db.js';
import { reportError } from './error-reporting.js';
import { ApiError, ok, rateLimit } from './http.js';
import { openSecret, sealSecret } from './integrations/email.js';
import {
  authorizeUrl,
  beforeTax,
  companyName,
  exchangeCode,
  invoiceLabel,
  invoicePage,
  invoiceText,
  itemIds,
  itemTypes,
  quickbooksConfigured,
  QuickBooksAuthError,
  refreshTokens,
  revokeToken,
  type Invoice,
  type Tokens,
} from './integrations/quickbooks.js';
import { kickJobImports, listJobImports, MAX_WAITING } from './job-imports.js';
import { recordRequestEvent } from './metrics.js';
import { currencyOf } from './money.js';
import { requireWorkspace, workspace, workspaceFromRequest } from './workspace.js';

/**
 * An owner's QuickBooks company, connected from the past-jobs step. Its newest invoices come onto
 * the same list as uploaded files, a list's worth at a time, and are read and checked the same way.
 * Nothing is saved as a past job until the owner saves it.
 */
export const quickbooksRouter = Router();

const STATE_COOKIE = 'quickbooks_state';
const STATE_PATH = '/api/v1/onboarding/quickbooks';
/** Invoices looked through for new ones on each pull, newest first. */
const PAGE = 100;
const MAX_SCANNED = 1000;

function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: STATE_PATH,
  };
}

/** A page on this site to come back to. Anything else falls back to the training page. */
function safeReturn(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= 300 &&
    /^\/(start|app)(\/|\?|$)/.test(value) &&
    !value.includes('\\')
    ? value
    : '/app/train';
}

function backTo(res: Response, returnTo: string, outcome: string) {
  const url = new URL(returnTo, 'http://pricecharm.invalid');
  url.searchParams.set('quickbooks', outcome);
  res.redirect(303, `${url.pathname}${url.search}`);
}

function sameState(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function saveConnection(
  businessId: string,
  realmId: string,
  name: string,
  tokens: Tokens,
): Promise<void> {
  await mutate(
    `INSERT INTO accounting_connections (id,business_id,kind,realm_id,company_name,refresh_token_ciphertext,access_token_ciphertext,access_expires_at) VALUES (?,?,'quickbooks',?,?,?,?,?)
     ON DUPLICATE KEY UPDATE realm_id=VALUES(realm_id),company_name=VALUES(company_name),refresh_token_ciphertext=VALUES(refresh_token_ciphertext),access_token_ciphertext=VALUES(access_token_ciphertext),access_expires_at=VALUES(access_expires_at)`,
    [
      randomUUID(),
      businessId,
      realmId,
      name,
      sealSecret(tokens.refreshToken),
      sealSecret(tokens.accessToken),
      tokens.expiresAt,
    ],
  );
}

/**
 * A working access token. The row is locked while it's renewed, since QuickBooks hands out a new
 * refresh token each time and two pulls mustn't both spend the old one. If QuickBooks has let the
 * connection go, it's removed here so the owner is asked to connect again.
 */
async function access(businessId: string): Promise<{ realmId: string; accessToken: string }> {
  try {
    return await transaction(async (connection) => {
      const [row] = await rows(
        "SELECT * FROM accounting_connections WHERE business_id=? AND kind='quickbooks' FOR UPDATE",
        [businessId],
        connection,
      );
      if (!row) throw new ApiError(404, 'QUICKBOOKS_NOT_CONNECTED', 'Connect QuickBooks first.');
      const realmId = String(row.realm_id);
      if (
        row.access_token_ciphertext &&
        row.access_expires_at &&
        new Date(row.access_expires_at).getTime() > Date.now() + 60_000
      )
        return { realmId, accessToken: openSecret(String(row.access_token_ciphertext)) };
      const tokens = await refreshTokens(openSecret(String(row.refresh_token_ciphertext)));
      await mutate(
        'UPDATE accounting_connections SET refresh_token_ciphertext=?,access_token_ciphertext=?,access_expires_at=? WHERE id=?',
        [sealSecret(tokens.refreshToken), sealSecret(tokens.accessToken), tokens.expiresAt, row.id],
        connection,
      );
      return { realmId, accessToken: tokens.accessToken };
    });
  } catch (error) {
    if (error instanceof QuickBooksAuthError)
      await mutate("DELETE FROM accounting_connections WHERE business_id=? AND kind='quickbooks'", [
        businessId,
      ]);
    throw error;
  }
}

/**
 * Puts the newest invoices not yet brought in onto the import list, as many as it has room for,
 * and starts reading them. Returns how many were added.
 */
export async function pullQuickBooksInvoices(businessId: string): Promise<number> {
  const room = async (connection?: Parameters<typeof rows>[2]) => {
    const [waiting] = await rows(
      'SELECT COUNT(*) AS count FROM job_imports WHERE business_id=?',
      [businessId],
      connection,
    );
    return MAX_WAITING - Number(waiting.count);
  };
  if ((await room()) <= 0) return 0;
  const { realmId, accessToken } = await access(businessId);
  const [business] = await rows('SELECT currency FROM businesses WHERE id=?', [businessId]);
  const currency = currencyOf(business?.currency);
  const wanted = await room();
  const picked: Invoice[] = [];
  for (let start = 1; start <= MAX_SCANNED && picked.length < wanted; start += PAGE) {
    const page = await invoicePage(realmId, accessToken, start, PAGE);
    // Voided and zero invoices have nothing to learn from, and other currencies would mislead it.
    const usable = page.filter(
      (invoice) =>
        beforeTax(invoice) > 0 &&
        (!invoice.CurrencyRef?.value || invoice.CurrencyRef.value === currency),
    );
    const seen = usable.length
      ? new Set(
          (
            await rows(
              `SELECT external_id FROM imported_invoices WHERE business_id=? AND source='quickbooks' AND external_id IN (${usable.map(() => '?').join(',')})`,
              [businessId, ...usable.map((invoice) => `${realmId}:${invoice.Id}`)],
            )
          ).map((row) => String(row.external_id)),
        )
      : new Set<string>();
    picked.push(
      ...usable
        .filter((invoice) => !seen.has(`${realmId}:${invoice.Id}`))
        .slice(0, wanted - picked.length),
    );
    if (page.length < PAGE) break;
  }
  if (!picked.length) return 0;
  const types = await itemTypes(realmId, accessToken, picked.flatMap(itemIds));
  const added = await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    let count = 0;
    for (const invoice of picked.slice(0, Math.max(0, await room(connection)))) {
      const fresh = await mutate(
        "INSERT IGNORE INTO imported_invoices (business_id,source,external_id) VALUES (?,'quickbooks',?)",
        [businessId, `${realmId}:${invoice.Id}`],
        connection,
      );
      if (!fresh.affectedRows) continue;
      // A millisecond apart, so the newest invoice stays at the top of the list.
      await mutate(
        "INSERT INTO job_imports (id,business_id,filename,kind,source_text,created_at) VALUES (?,?,?,'quickbooks',?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MICROSECOND))",
        [
          randomUUID(),
          businessId,
          invoiceLabel(invoice),
          invoiceText(invoice, types),
          count * 1000,
        ],
        connection,
      );
      count++;
    }
    return count;
  });
  if (added) await kickJobImports(businessId);
  return added;
}

quickbooksRouter.get('/onboarding/quickbooks', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const [row] = await rows(
    "SELECT company_name FROM accounting_connections WHERE business_id=? AND kind='quickbooks'",
    [businessId],
  );
  res.json(
    ok({
      available: quickbooksConfigured(),
      connection: row ? { companyName: String(row.company_name) } : null,
    }),
  );
});

/** Sends the owner to QuickBooks to pick their company, then back to the page they were on. */
quickbooksRouter.post(
  '/onboarding/quickbooks/connect',
  rateLimit(20, 15 * 60_000),
  requireWorkspace,
  async (req, res) => {
    if (!quickbooksConfigured())
      throw new ApiError(404, 'QUICKBOOKS_OFF', 'QuickBooks isn’t available yet.');
    const { returnTo } = z.object({ returnTo: z.string().max(300).optional() }).parse(req.body);
    const state = randomBytes(24).toString('base64url');
    res.cookie(STATE_COOKIE, `${state}|${encodeURIComponent(safeReturn(returnTo))}`, {
      ...stateCookieOptions(),
      maxAge: 15 * 60_000,
    });
    res.json(ok({ url: authorizeUrl(state) }));
  },
);

quickbooksRouter.get(
  '/onboarding/quickbooks/callback',
  rateLimit(20, 15 * 60_000),
  async (req: Request, res: Response) => {
    const [state, encoded] = (cookies(req)[STATE_COOKIE] ?? '').split('|');
    res.clearCookie(STATE_COOKIE, stateCookieOptions());
    const returnTo = safeReturn(encoded ? decodeURIComponent(encoded) : '');
    const query = z
      .object({
        state: z.string().max(200).optional(),
        code: z.string().max(2000).optional(),
        realmId: z
          .string()
          .regex(/^\d{1,40}$/)
          .optional(),
        error: z.string().max(200).optional(),
      })
      .safeParse(req.query);
    if (!state || !query.success || !query.data.state || !sameState(state, query.data.state))
      return backTo(res, returnTo, 'failed');
    if (query.data.error) return backTo(res, returnTo, 'cancelled');
    const current = await workspaceFromRequest(req);
    if (!current) return backTo(res, returnTo, 'expired');
    if (!query.data.code || !query.data.realmId) return backTo(res, returnTo, 'failed');
    try {
      const tokens = await exchangeCode(query.data.code);
      const name = await companyName(query.data.realmId, tokens.accessToken).catch(() => '');
      await saveConnection(current.businessId, query.data.realmId, name, tokens);
    } catch (error) {
      reportError(error, { event: 'quickbooks_connect' });
      return backTo(res, returnTo, 'failed');
    }
    let added = 0;
    try {
      added = await pullQuickBooksInvoices(current.businessId);
    } catch (error) {
      // Connected all the same: the owner can bring invoices in from the page.
      reportError(error, { event: 'quickbooks_pull' });
    }
    await recordRequestEvent(req, current.businessId, 'quickbooks_connected', { added });
    backTo(res, returnTo, 'connected');
  },
);

/** Brings in the next invoices, as many as the list has room for. */
quickbooksRouter.post(
  '/onboarding/quickbooks/pull',
  rateLimit(30, 15 * 60_000),
  requireWorkspace,
  async (req, res) => {
    const { businessId } = workspace(req);
    const added = await pullQuickBooksInvoices(businessId);
    await recordRequestEvent(req, businessId, 'quickbooks_pulled', { added });
    const imports = await listJobImports(businessId);
    res.json(ok({ added, full: imports.length >= MAX_WAITING, imports }));
  },
);

/** Disconnects. Invoices already on the list stay there to check. */
quickbooksRouter.delete('/onboarding/quickbooks', requireWorkspace, async (req, res) => {
  const { businessId } = workspace(req);
  const [row] = await rows(
    "SELECT id,refresh_token_ciphertext FROM accounting_connections WHERE business_id=? AND kind='quickbooks'",
    [businessId],
  );
  if (row) {
    await mutate('DELETE FROM accounting_connections WHERE id=?', [row.id]);
    await revokeToken(openSecret(String(row.refresh_token_ciphertext))).catch((error) =>
      reportError(error, { event: 'quickbooks_revoke' }),
    );
    await recordRequestEvent(req, businessId, 'quickbooks_disconnected');
  }
  res.json(ok({ ok: true }));
});
