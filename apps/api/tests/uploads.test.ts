import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { uploadSlot } from '../src/uploads.js';

/** A request from one business or chat, and a response that can finish later. */
function upload(source: { businessId?: string; chatId?: string }) {
  const req = {
    workspace: source.businessId ? { businessId: source.businessId } : undefined,
    params: source.chatId ? { chatId: source.chatId } : {},
    ip: '203.0.113.9',
    socket: {},
  } as unknown as Request;
  const res = Object.assign(new EventEmitter(), { setHeader: () => {} }) as unknown as Response;
  let error: unknown = null;
  uploadSlot(req, res, (failure?: unknown) => {
    error = failure ?? null;
  });
  return {
    busy: (error as { code?: string } | null)?.code === 'UPLOAD_BUSY',
    done: () => res.emit('finish'),
  };
}

test('each business gets its own uploads at once, so one owner never blocks another', () => {
  const first = [upload({ businessId: 'a' }), upload({ businessId: 'a' })];
  assert.deepEqual(
    first.map((item) => item.busy),
    [false, false],
  );
  assert.equal(upload({ businessId: 'a' }).busy, true, 'A third from the same business waits');
  const other = upload({ businessId: 'b' });
  assert.equal(other.busy, false, 'Another business still gets in');
  const chat = upload({ chatId: 'chat-1' });
  assert.equal(chat.busy, false, 'So does a customer in a chat');
  first[0].done();
  const again = upload({ businessId: 'a' });
  assert.equal(again.busy, false, 'One finishing makes room');
  for (const item of [first[1], other, chat, again]) item.done();
});

test('the whole server takes a few more before anyone waits', () => {
  const open = ['a', 'b', 'c'].flatMap((businessId) => [
    upload({ businessId }),
    upload({ businessId }),
  ]);
  assert.ok(open.every((item) => !item.busy));
  assert.equal(upload({ businessId: 'd' }).busy, true, 'Past six at once, uploads wait');
  for (const item of open) item.done();
  const later = upload({ businessId: 'd' });
  assert.equal(later.busy, false);
  later.done();
});
