import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword, hashToken, newToken } from '../src/auth.js';

test('scrypt passwords use distinct salts and reject incorrect or malformed hashes', async () => {
  const first = await hashPassword('long enough password'),
    second = await hashPassword('long enough password');
  assert.notEqual(first, second);
  assert.equal(first.includes('long enough password'), false);
  assert.equal(await verifyPassword('long enough password', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(await verifyPassword('wrong password', 'invalid'), false);
});
test('session tokens are strong and stored only as deterministic hashes', () => {
  const token = newToken();
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(token, newToken());
  assert.equal(hashToken(token).length, 64);
  assert.equal(hashToken(token), hashToken(token));
});
test('unauthenticated private requests fail before database access', async () => {
  const response = await request(createApp()).get('/api/v1/dashboard');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'AUTH_REQUIRED');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-powered-by'], undefined);
});
test('cross-site auth mutations are rejected before database access', async () => {
  const response = await request(createApp())
    .post('/api/v1/auth/login')
    .set('Origin', 'https://attacker.example')
    .send({ email: 'owner@example.com', password: 'password' });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'ORIGIN_REJECTED');
  const missingOrigin = await request(createApp()).post('/api/v1/auth/register').send({});
  assert.equal(missingOrigin.status, 403);
});
test('malformed JSON has a safe validation response', async () => {
  const response = await request(createApp())
    .post('/api/v1/auth/login')
    .set('Origin', 'http://localhost:3100')
    .set('Content-Type', 'application/json')
    .send('{bad');
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});
