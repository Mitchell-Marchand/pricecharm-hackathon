import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mutate, rows, transaction, type Sql } from './db.js';
import { ApiError } from './http.js';
import { json, type Row } from './models.js';
import type { Message, Scenario } from './domain.js';
import { practicePhotoSceneSchema, type PracticePhotoScene } from './ai/index.js';
import { generatePracticePhoto } from './ai/practice-images.js';
import { withAiUsage } from './usage.js';
import { putPhoto, getPhoto, deletePhoto } from './storage.js';

const scenesSchema = z.array(practicePhotoSceneSchema).min(1).max(3);
const idsSchema = z.array(z.string().uuid()).max(6);
export function practicePhotoIntent(
  content: string,
  messages: Pick<Message, 'role' | 'content'>[],
): boolean {
  if (/\b(?:no|without)\s+(?:photos?|pictures?|images?)\b/i.test(content)) return false;
  if (
    /\b(?:don't|do not|never|no need to)\s+(?:send|show|attach|generate|create)\b[^.!?]*\b(?:photos?|pictures?|images?)\b/i.test(
      content,
    )
  )
    return false;
  if (/\b(?:photos?|pictures?|images?|snapshots?)\b/i.test(content)) return true;
  const prior = messages
    .slice(-8)
    .some((message) => /\b(?:photos?|pictures?|images?|snapshots?)\b/i.test(message.content));
  return (
    prior &&
    /\b(?:all|every|each|both|those|them|remaining|other|yes|please|rooms?|views?)\b/i.test(content)
  );
}
/** Exact named rooms in the fixed synthetic fact sheet keep an omitted model plan usable. */
export function groundedPracticeScenes(
  scenario: Scenario,
  content: string,
  proposed: PracticePhotoScene[] = [],
): PracticePhotoScene[] {
  const source = [
    scenario.title,
    scenario.description,
    ...Object.entries(scenario.details).flat(),
  ].join('\n');
  const roomPattern =
    /\b(?:living room|dining room|kitchen|(?:master |primary |guest |first |second |third )?bedroom|(?:guest |primary |main )?bathroom|hallway|home office|study|nursery|garage|laundry room)\b/gi;
  const rooms = [
    ...new Map(
      [...source.matchAll(roomPattern)].map((match) => [match[0].toLowerCase(), match[0]]),
    ).values(),
  ];
  const all = /\b(?:all|every|each|remaining|other)\b[^.!?]*\b(?:rooms?|areas?|views?)\b/i.test(
    content,
  );
  const requested = rooms.filter((room) => content.toLowerCase().includes(room.toLowerCase()));
  const targets = all ? rooms : requested;
  const closeup = /\b(?:close[- ]?up|closer (?:look|view)|detail(?:ed)? view)\b/i.test(content);
  const otherAngle =
    /\b(?:(?:different|another|alternate|side) (?:angle|view)|from (?:another|the other|a different) (?:angle|side))\b/i.test(
      content,
    );
  if (closeup || otherAngle) {
    const view = closeup ? 'close-up' : 'alternate angle';
    const plans = proposed
      .map((scene) => practicePhotoSceneSchema.parse(scene))
      .filter(
        (scene) =>
          !targets.length ||
          targets.some((room) =>
            `${scene.subject || ''} ${scene.title} ${scene.description}`
              .toLowerCase()
              .includes(room.toLowerCase()),
          ),
      );
    const views = plans.length
      ? plans
      : targets.slice(0, 3).map((room) => ({
          subject: room,
          title: `${room[0].toUpperCase() + room.slice(1)} ${view}`,
          description: `A ${view} of the ${room} in the fixed fictional practice scenario.`,
        }));
    if (views.length)
      return views.slice(0, 3).map((scene) => ({
        ...scene,
        subject: /\b(?:close[- ]?up|angle|detail)\b/i.test(scene.subject || '')
          ? scene.subject
          : `${scene.subject || scene.title}: ${view}`.slice(0, 100),
        description:
          `${scene.description.slice(0, 550)} Only depict the fixed scenario's stated visible conditions; this view does not confirm unknown or hidden damage or exact measurements. Fixed scenario: ${source.slice(0, 450)}`.slice(
            0,
            1200,
          ),
      }));
  }
  if (targets.length)
    return targets.slice(0, 3).map((room) => ({
      subject: room.toLowerCase(),
      title: room[0].toUpperCase() + room.slice(1),
      description: `A fictional customer snapshot of the ${room}. Use only the fixed practice scenario facts; exact measurements and hidden conditions are not established by the image. Scenario: ${source.slice(0, 900)}`,
    }));
  return proposed.length
    ? proposed.slice(0, 3)
    : [
        {
          subject: 'representative project',
          title: 'Representative project view',
          description: scenario.description.slice(0, 1200),
        },
      ];
}
export function safePracticeReply(reply: string, discardedPhotoRequest = false): string {
  const photo = /\b(?:photos?|pictures?|images?|snapshots?)\b/i;
  if (
    discardedPhotoRequest ||
    (photo.test(reply) &&
      /\b(?:send|sending|sent|attach|attached|upload|uploaded|share|sharing|shortly|soon|later|moment|tomorrow)\b/i.test(
        reply,
      ))
  )
    return 'I can describe the project details. What else would you need to know?';
  return reply;
}
export function practiceSceneKey(scene: PracticePhotoScene): string {
  return (
    (scene.subject || scene.title)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\b(?:photo|picture|image|snapshot|overview|view)s?\b/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .slice(0, 100) || 'project'
  );
}
function requestState(row: Row): 'pending' | 'ready' | 'failed' {
  if (row.status === 'ready' || row.status === 'failed') return row.status;
  if (
    !row.job_id ||
    row.job_status === 'failed' ||
    Date.now() - new Date(row.generation_started_at || row.updated_at).getTime() >
      (row.generation_started_at ? 10 : 2) * 60_000
  )
    return 'failed';
  return 'pending';
}
export async function enrichTrainingPhotos(
  businessId: string,
  messages: Message[],
  connection?: Sql,
): Promise<Message[]> {
  if (!messages.length) return messages;
  const requests = await rows(
    `SELECT r.*,j.status AS job_status FROM training_photo_requests r LEFT JOIN jobs j ON j.id=r.job_id AND j.business_id=r.business_id WHERE r.business_id=? AND r.message_id IN (${messages.map(() => '?').join(',')})`,
    [businessId, ...messages.map((message) => message.id)],
    connection,
  );
  if (!requests.length) return messages;
  const assetIds = [
    ...new Set(requests.flatMap((request) => idsSchema.parse(json(request.asset_ids_json, [])))),
  ];
  const assets = assetIds.length
    ? await rows(
        `SELECT * FROM attachments WHERE business_id=? AND id IN (${assetIds.map(() => '?').join(',')})`,
        [businessId, ...assetIds],
        connection,
      )
    : [];
  const byMessage = new Map(
    requests.map((request) => {
      const status = requestState(request),
        ids = idsSchema.parse(json(request.asset_ids_json, []));
      const photos: NonNullable<Message['photos']> = {
        requestId: request.id,
        status,
        retryable: status === 'failed' && Number(request.attempts) < 3,
        ...(status === 'failed'
          ? {
              error:
                Number(request.attempts) >= 3
                  ? 'The practice photos could not be created after three attempts. Continue with the project details.'
                  : 'The practice photos could not be created. You can try again or continue with the project details.',
            }
          : {}),
        attachments: ids.flatMap((id) => {
          const asset = assets.find(
            (item) => item.id === id && item.conversation_id === request.training_session_id,
          );
          if (!asset) return [];
          const scene = practicePhotoSceneSchema.parse(json(asset.training_scene_json, {}));
          return [
            {
              id: asset.id,
              url: `/api/v1/training/${request.training_session_id}/photos/${asset.id}`,
              alt: `${scene.title} — generated practice photo`,
              label: scene.title,
              kind: 'sample_photo' as const,
              width: Number(asset.width),
              height: Number(asset.height),
            },
          ];
        }),
      };
      return [request.message_id, photos] as const;
    }),
  );
  return messages.map((message) =>
    byMessage.has(message.id) ? { ...message, photos: byMessage.get(message.id)! } : message,
  );
}
export async function pendingTrainingPhotos(
  businessId: string,
  sessionId: string,
  connection?: Sql,
): Promise<boolean> {
  const requests = await rows(
    "SELECT r.*,j.status AS job_status FROM training_photo_requests r LEFT JOIN jobs j ON j.id=r.job_id AND j.business_id=r.business_id WHERE r.business_id=? AND r.training_session_id=? AND r.status='pending'",
    [businessId, sessionId],
    connection,
  );
  return requests.some((item) => requestState(item) === 'pending');
}
export async function trainingPhotoContext(businessId: string, sessionId: string) {
  const assets = await rows(
    'SELECT training_scene_json,storage_key FROM attachments WHERE business_id=? AND conversation_id=? AND training_message_id IS NOT NULL ORDER BY created_at DESC,id LIMIT 6',
    [businessId, sessionId],
  );
  const scenes = assets.map((asset) =>
    practicePhotoSceneSchema.parse(json(asset.training_scene_json, {})),
  );
  const images = await Promise.all(
    assets.slice(0, 3).map(async (asset) => ({
      mimeType: 'image/jpeg',
      dataBase64: (await getPhoto(asset.storage_key)).toString('base64'),
    })),
  );
  return { scenes, images };
}
/** Caller holds the business/session lock. One durable job represents one explicitly requested attempt. */
export async function queueTrainingPhotos(
  businessId: string,
  sessionId: string,
  messageId: string,
  plan: PracticePhotoScene[],
  connection: Sql,
): Promise<void> {
  if (await pendingTrainingPhotos(businessId, sessionId, connection))
    throw new ApiError(409, 'PHOTOS_PENDING', 'A practice photo request is already in progress.');
  const scenes = scenesSchema.parse(plan);
  const existing = await rows(
    'SELECT id,training_scene_json FROM attachments WHERE business_id=? AND conversation_id=? AND training_message_id IS NOT NULL',
    [businessId, sessionId],
    connection,
  );
  const reusable = new Map(
    existing.map((asset) => [
      practiceSceneKey(practicePhotoSceneSchema.parse(json(asset.training_scene_json, {}))),
      String(asset.id),
    ]),
  );
  const reused: string[] = [],
    fresh: PracticePhotoScene[] = [],
    keys = new Set<string>();
  for (const scene of scenes) {
    const key = practiceSceneKey(scene);
    if (keys.has(key)) continue;
    keys.add(key);
    const prior = reusable.get(key);
    if (prior) reused.push(prior);
    else fresh.push(scene);
  }
  const [planned] = await rows(
    'SELECT COALESCE(SUM(JSON_LENGTH(scenes_json)),0) AS count FROM training_photo_requests WHERE business_id=? AND training_session_id=?',
    [businessId, sessionId],
    connection,
  );
  if (Number(planned.count) + existing.length + fresh.length > 6)
    throw new ApiError(
      422,
      'PRACTICE_PHOTO_LIMIT',
      'This practice conversation supports up to six different sample views. Reuse the existing photos or start another practice request.',
    );
  const id = randomUUID(),
    jobId = fresh.length ? randomUUID() : null;
  await mutate(
    'INSERT INTO training_photo_requests(id,business_id,training_session_id,message_id,status,scenes_json,asset_ids_json,job_id) VALUES (?,?,?,?,?,?,?,?)',
    [
      id,
      businessId,
      sessionId,
      messageId,
      fresh.length ? 'pending' : 'ready',
      JSON.stringify(fresh),
      JSON.stringify(reused),
      jobId,
    ],
    connection,
  );
  if (jobId)
    await mutate(
      "INSERT INTO jobs(id,business_id,type,payload_json,dedupe_key,max_attempts) VALUES (?,?,'training_photos',?,?,1)",
      [jobId, businessId, JSON.stringify({ requestId: id }), `training-photos:${id}:1`],
      connection,
    );
}
export async function retryTrainingPhotos(
  businessId: string,
  sessionId: string,
  requestId: string,
): Promise<void> {
  await transaction(async (connection) => {
    await rows('SELECT id FROM businesses WHERE id=? FOR UPDATE', [businessId], connection);
    const [session] = await rows(
      'SELECT status FROM training_sessions WHERE business_id=? AND id=? FOR UPDATE',
      [businessId, sessionId],
      connection,
    );
    if (!session) throw new ApiError(404, 'TRAINING_NOT_FOUND', 'Training conversation not found.');
    if (session.status !== 'active')
      throw new ApiError(409, 'TRAINING_COMPLETED', 'This practice conversation is complete.');
    const [request] = await rows(
      'SELECT r.*,j.status AS job_status FROM training_photo_requests r LEFT JOIN jobs j ON j.id=r.job_id AND j.business_id=r.business_id WHERE r.business_id=? AND r.training_session_id=? AND r.id=? FOR UPDATE',
      [businessId, sessionId, requestId],
      connection,
    );
    if (!request)
      throw new ApiError(404, 'PHOTO_REQUEST_NOT_FOUND', 'Practice photo request not found.');
    if (requestState(request) !== 'failed') return;
    if (Number(request.attempts) >= 3)
      throw new ApiError(
        422,
        'PHOTO_RETRY_LIMIT',
        'This photo request reached its three-attempt limit. Continue with the project details.',
      );
    if (request.job_id)
      await mutate(
        "UPDATE jobs SET status='failed',locked_at=NULL,locked_by=NULL WHERE id=? AND business_id=? AND status IN ('pending','processing')",
        [request.job_id, businessId],
        connection,
      );
    const jobId = randomUUID(),
      attempt = Number(request.attempts) + 1;
    await mutate(
      "UPDATE training_photo_requests SET status='pending',job_id=?,attempts=?,generation_started_at=NULL,failure_code=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND business_id=?",
      [jobId, attempt, requestId, businessId],
      connection,
    );
    await mutate(
      "INSERT INTO jobs(id,business_id,type,payload_json,dedupe_key,max_attempts) VALUES (?,?,'training_photos',?,?,1)",
      [jobId, businessId, JSON.stringify({ requestId }), `training-photos:${requestId}:${attempt}`],
      connection,
    );
  });
}
export async function processTrainingPhotos(
  businessId: string,
  requestId: string,
  expectedJobId?: string,
): Promise<void> {
  const request = await transaction(async (connection) => {
    const [business] = await rows(
      'SELECT deletion_requested_at FROM businesses WHERE id=? FOR UPDATE',
      [businessId],
      connection,
    );
    if (!business || business.deletion_requested_at) return undefined;
    const [item] = await rows(
      'SELECT * FROM training_photo_requests WHERE business_id=? AND id=? FOR UPDATE',
      [businessId, requestId],
      connection,
    );
    if (!item || item.status !== 'pending' || (expectedJobId && item.job_id !== expectedJobId))
      return undefined;
    if (item.generation_started_at) {
      await mutate(
        "UPDATE training_photo_requests SET status='failed',failure_code='GENERATION_INTERRUPTED' WHERE business_id=? AND id=?",
        [businessId, requestId],
        connection,
      );
      return undefined;
    }
    const [total] = await rows(
      'SELECT COALESCE(SUM(byte_size),0) AS bytes FROM attachments WHERE business_id=?',
      [businessId],
      connection,
    );
    if (Number(total.bytes) + 1024 * 1024 > 100 * 1024 * 1024) {
      await mutate(
        "UPDATE training_photo_requests SET status='failed',failure_code='STORAGE_LIMIT' WHERE business_id=? AND id=?",
        [businessId, requestId],
        connection,
      );
      return undefined;
    }
    await mutate(
      'UPDATE training_photo_requests SET generation_started_at=UTC_TIMESTAMP(3) WHERE business_id=? AND id=?',
      [businessId, requestId],
      connection,
    );
    return item;
  });
  if (!request) return;
  const scenes = scenesSchema.parse(json(request.scenes_json, []));
  try {
    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index];
      const [capacity] = await rows(
        'SELECT COALESCE(SUM(byte_size),0) AS bytes FROM attachments WHERE business_id=?',
        [businessId],
      );
      if (Number(capacity.bytes) + 1024 * 1024 > 100 * 1024 * 1024)
        throw new ApiError(413, 'STORAGE_LIMIT', 'This workspace reached its photo allowance.');
      const photo = await withAiUsage(businessId, request.training_session_id, () =>
        generatePracticePhoto(businessId, scene),
      );
      const id = randomUUID(),
        key = `${id}.jpg`;
      let committed = false;
      await putPhoto(key, photo.bytes);
      try {
        committed = await transaction(async (connection) => {
          const [business] = await rows(
            'SELECT deletion_requested_at FROM businesses WHERE id=? FOR UPDATE',
            [businessId],
            connection,
          );
          if (!business || business.deletion_requested_at) return false;
          const [locked] = await rows(
            'SELECT * FROM training_photo_requests WHERE business_id=? AND id=? FOR UPDATE',
            [businessId, requestId],
            connection,
          );
          if (!locked || locked.status !== 'pending' || locked.job_id !== request.job_id)
            return false;
          const [session] = await rows(
            'SELECT saved_example_id FROM training_sessions WHERE business_id=? AND id=?',
            [businessId, request.training_session_id],
            connection,
          );
          if (!session) return false;
          const [total] = await rows(
            'SELECT COALESCE(SUM(byte_size),0) AS bytes FROM attachments WHERE business_id=?',
            [businessId],
            connection,
          );
          if (Number(total.bytes) + photo.bytes.length > 100 * 1024 * 1024)
            throw new ApiError(413, 'STORAGE_LIMIT', 'This workspace reached its photo allowance.');
          await mutate(
            'INSERT INTO attachments(id,business_id,conversation_id,example_id,filename,mime_type,storage_key,width,height,byte_size,training_message_id,training_scene_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [
              id,
              businessId,
              request.training_session_id,
              session.saved_example_id || null,
              `${scene.title.slice(0, 100)}.jpg`,
              'image/jpeg',
              key,
              photo.width,
              photo.height,
              photo.bytes.length,
              request.message_id,
              JSON.stringify(scene),
            ],
            connection,
          );
          await mutate(
            'UPDATE training_photo_requests SET status=?,scenes_json=?,asset_ids_json=?,failure_code=NULL WHERE business_id=? AND id=? AND job_id=?',
            [
              index === scenes.length - 1 ? 'ready' : 'pending',
              JSON.stringify(scenes.slice(index + 1)),
              JSON.stringify([...idsSchema.parse(json(locked.asset_ids_json, [])), id]),
              businessId,
              requestId,
              request.job_id,
            ],
            connection,
          );
          return true;
        });
      } finally {
        if (!committed) await deletePhoto(key).catch(() => {});
      }
      if (!committed) return;
    }
  } catch (error) {
    await mutate(
      "UPDATE training_photo_requests SET status='failed',failure_code=? WHERE business_id=? AND id=? AND job_id=? AND status='pending'",
      [
        (error as { code?: string }).code === 'AI_BUSINESS_BUDGET'
          ? 'AI_BUDGET'
          : (error as { code?: string }).code === 'STORAGE_LIMIT'
            ? 'STORAGE_LIMIT'
            : 'IMAGE_GENERATION_FAILED',
        businessId,
        requestId,
        request.job_id,
      ],
    );
  }
}
