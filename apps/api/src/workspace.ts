import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { cookies, hashToken, newToken, ownerFromRequest } from './auth.js';
import { mutate, rows, type Sql } from './db.js';
import { ApiError } from './http.js';
import { recordMilestone } from './metrics.js';

/**
 * Setup happens before there's an account. Until signup, the business is a draft: a normal
 * businesses row with status 'draft' and no user, reached through an HttpOnly cookie. Every
 * business-scoped check works the same for a draft, and signup turns it into the real business.
 */
const DRAFT_COOKIE = 'quotient_draft';
export const DRAFT_DAYS = 14;
const DRAFT_MS = DRAFT_DAYS * 24 * 60 * 60_000;

export interface Workspace {
  businessId: string;
  /** Null for a draft. */
  userId: string | null;
  draft: boolean;
}
declare global {
  namespace Express {
    interface Request {
      workspace?: Workspace;
    }
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/api/v1',
  };
}
export function setDraftCookie(res: Response, token: string) {
  res.cookie(DRAFT_COOKIE, token, { ...cookieOptions(), maxAge: DRAFT_MS });
}
export function clearDraftCookie(res: Response) {
  res.clearCookie(DRAFT_COOKIE, cookieOptions());
}

/** The draft this browser is setting up, if it hasn't expired. */
export async function draftFromRequest(req: Request, connection?: Sql, lock = false) {
  const token = cookies(req)[DRAFT_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [draft] = await rows(
    `SELECT * FROM businesses WHERE draft_token_hash=? AND status='draft' AND draft_expires_at>UTC_TIMESTAMP(3) AND deletion_requested_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [hashToken(token)],
    connection,
  );
  return draft ?? null;
}

/** A signed-in owner's business, or else this browser's draft. */
export async function workspaceFromRequest(req: Request): Promise<Workspace | null> {
  const owner = await ownerFromRequest(req);
  if (owner) {
    req.auth = owner;
    return { businessId: owner.businessId, userId: owner.userId, draft: false };
  }
  const draft = await draftFromRequest(req);
  return draft ? { businessId: String(draft.id), userId: null, draft: true } : null;
}

export const requireWorkspace: RequestHandler = async (req, _res, next) => {
  const found = await workspaceFromRequest(req);
  if (!found)
    throw new ApiError(401, 'SETUP_REQUIRED', 'Your setup has expired. Start again to continue.');
  req.workspace = found;
  next();
};

export function workspace(req: Request): Workspace {
  if (!req.workspace)
    throw new ApiError(401, 'SETUP_REQUIRED', 'Your setup has expired. Start again to continue.');
  return req.workspace;
}

/** Creates a draft business for this browser and sets its cookie. */
export async function createDraft(res: Response, connection: Sql): Promise<string> {
  const id = randomUUID(),
    token = newToken();
  await mutate(
    "INSERT INTO businesses (id,name,slug,description,status,draft_token_hash,draft_expires_at,metrics_subject) VALUES (?,?,?,?,'draft',?,?,UUID())",
    [id, '', `draft-${id}`, '', hashToken(token), new Date(Date.now() + DRAFT_MS)],
    connection,
  );
  await recordMilestone(connection, id, 'setup_started');
  setDraftCookie(res, token);
  return id;
}

/** Points this browser at a draft with a fresh cookie, retiring the old one. */
export async function rotateDraftCookie(res: Response, businessId: string, connection: Sql) {
  const token = newToken();
  await mutate(
    "UPDATE businesses SET draft_token_hash=?,draft_expires_at=? WHERE id=? AND status='draft'",
    [hashToken(token), new Date(Date.now() + DRAFT_MS), businessId],
    connection,
  );
  setDraftCookie(res, token);
}

/** Expired drafts go through the same deletion as a closed account, photos included. */
export async function scheduleExpiredDraftDeletion(connection: Sql): Promise<void> {
  const expired = await rows(
    "SELECT id FROM businesses WHERE status='draft' AND draft_expires_at<UTC_TIMESTAMP(3) AND deletion_requested_at IS NULL LIMIT 50 FOR UPDATE",
    [],
    connection,
  );
  for (const draft of expired) {
    const deletionId = randomUUID(),
      businessId = String(draft.id);
    await mutate(
      'INSERT INTO account_deletion_audits(id,business_id,status) VALUES (?,?,?)',
      [deletionId, businessId, 'scheduled'],
      connection,
    );
    await mutate(
      'UPDATE businesses SET deletion_requested_at=UTC_TIMESTAMP(3),draft_token_hash=NULL,draft_resume_hash=NULL WHERE id=?',
      [businessId],
      connection,
    );
    await mutate(
      `INSERT IGNORE INTO jobs(id,business_id,type,payload_json,dedupe_key) VALUES (?,?,'account_delete',?,?)`,
      [
        randomUUID(),
        businessId,
        JSON.stringify({ businessId, deletionId }),
        `delete-account:${businessId}`,
      ],
      connection,
    );
  }
}
