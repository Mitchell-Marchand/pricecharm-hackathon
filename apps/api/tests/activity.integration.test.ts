import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/auth.js';
import { closeDatabase, mutate, rows } from '../src/db.js';
import { formatInsights, insightsReport } from '../src/insights.js';
import { draftIpBudgetKey } from '../src/usage.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const origin = 'http://localhost:3100';
after(() => closeDatabase());

const event = (name: string, path: string, props: object = {}) => ({ name, path, props });

test(
  'the browser trail before and after a setup joins up, with what people typed left out',
  {
    skip: !enabled,
  },
  async () => {
    const app = createApp();
    const browser = request.agent(app);
    const session = randomUUID();
    const send = (events: object[]) =>
      browser.post('/api/v1/events').set('Origin', origin).send({ session, events });

    // Before there's a setup: a visitor reading the home page.
    const anonymous = await send([
      event('session_started', '/', { device: 'phone', referrer: 'google.com' }),
      event('screen_viewed', '/'),
      event('clicked', '/', { label: 'Get started', element: 'a', href: '/start' }),
    ]);
    assert.equal(anonymous.status, 200, JSON.stringify(anonymous.body));
    assert.equal(anonymous.body.data.subject, null);

    await browser
      .post('/api/v1/onboarding/start')
      .set('Origin', origin)
      .set('X-PC-Session', session)
      .expect(201);
    // Give back the setup this used: every test here shares one address, which may start ten a day.
    const day = new Date().toISOString().slice(0, 10);
    await mutate(
      'UPDATE auth_rate_limits SET attempts=attempts-1 WHERE bucket_key=? AND attempts>0',
      [hashToken(draftIpBudgetKey('127.0.0.1', day))],
    );
    await browser
      .patch('/api/v1/onboarding/business')
      .set('Origin', origin)
      .set('X-PC-Session', session)
      .send({ tradeId: 'pressure-washing', services: ['Driveways', 'House wash'] })
      .expect(200);
    const [business] = await rows(
      'SELECT metrics_subject FROM businesses WHERE id=(SELECT id FROM businesses WHERE status=? ORDER BY created_at DESC LIMIT 1)',
      ['draft'],
    );
    const subject = String(business.metrics_subject);

    const later = await send([
      event('field_used', '/start/business', {
        field: 'Business name',
        chars: 18,
        focused_ms: 4200,
      }),
      event('error_shown', '/start/business', { text: 'Pick your trade to continue.' }),
      event('clicked', '/start/business', { label: 'Email me at jo@example.com or 555-123-4567' }),
      event('screen_left', '/start/business', { screen: '/start/business', active_ms: 61_000 }),
    ]);
    assert.equal(later.body.data.subject, subject, 'The browser learns its setup’s tag');

    const trail = await rows(
      'SELECT name,subject,source,path,props FROM product_events WHERE session=? ORDER BY created_at,name',
      [session],
    );
    const names = trail.map((row) => row.name);
    for (const name of [
      'session_started',
      'clicked',
      'setup_started',
      'business_updated',
      'field_used',
    ])
      assert.ok(names.includes(name), name);
    const props = (row: { props: unknown }) =>
      typeof row.props === 'string'
        ? JSON.parse(row.props)
        : (row.props as Record<string, unknown>);
    const updated = trail.find((row) => row.name === 'business_updated')!;
    assert.equal(props(updated).trade, 'pressure-washing');
    assert.equal(props(updated).services, 2);
    assert.equal(updated.subject, subject, 'Server events carry the setup and the tab');
    assert.equal(trail.find((row) => row.name === 'session_started')!.subject, null);
    assert.ok(
      trail.some(
        (row) => row.name === 'clicked' && props(row).label === 'Email me at [email] or [number]',
      ),
      'Email addresses and phone numbers are scrubbed',
    );

    for (const bad of [
      { session, events: [] },
      { session, events: [event('Bad Name', '/')] },
      { session, events: [event('clicked', 'https://elsewhere.example/')] },
      { session, events: Array.from({ length: 26 }, () => event('clicked', '/')) },
      { session: 'not-a-session', events: [event('clicked', '/')] },
    ])
      assert.equal(
        (await browser.post('/api/v1/events').set('Origin', origin).send(bad)).status,
        400,
        JSON.stringify(bad).slice(0, 80),
      );
    assert.equal(
      (
        await request(app)
          .post('/api/v1/events')
          .send({ session, events: [event('clicked', '/')] })
      ).status,
      403,
      'Only the site itself can send them',
    );

    const report = await insightsReport(1, new Date(Date.now() + 1000));
    const mine = report.setups.trades.find((trade) => trade.trade === 'pressure-washing');
    assert.ok(mine && mine.started >= 1);
    assert.ok(report.setups.lastScreens.length >= 1);
    assert.ok(
      report.struggles.errorsShown.some((item) => item.label === 'Pick your trade to continue.'),
    );
    assert.ok(report.setups.medianActiveMinutes !== null);
    const text = formatInsights(report);
    assert.match(text, /By trade/);
    assert.match(text, /Left before making an account/);
  },
);
