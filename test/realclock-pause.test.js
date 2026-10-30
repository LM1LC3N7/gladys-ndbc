// -----------------------------------------------------------------------------
// The real clock x20 through a pause: a 429 pauses 5 min, the station is read
// again right at the end of the pause (never a skipped round, never sooner),
// while the interval is 60 min. The app is stopped in `finally`.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NdbcApp } from '../src/app.js';
import { PAUSE_429_FIRST } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { realClock } from './kit/clock.mjs';
import { createdDevices } from './helpers/setup.js';
import { startServer } from './helpers/server.js';

const SPEED = 20;

test('real clock x20: a 429 pauses 5 min, then the read comes at the end of the pause', async () => {
  const clock = realClock({ speed: SPEED });
  const server = await startServer(clock, (req, n) =>
    n === 1 ? { status: 429, headers: { 'content-type': 'text/html' }, body: 'slow down' } : null,
  );
  const config = { stations: '46026', refresh_minutes: 60 };
  const gladys = createFakeGladys({ selector: 'ndbc', config, devices: createdDevices(config) });
  await gladys.connect();
  const quiet = () => {};
  const sent = [];
  const app = new NdbcApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    dataBase: server.base,
    // The moment the app sends each request (the server may see it later under load).
    fetchImpl: (url, init) => {
      sent.push(clock.monotonic());
      return fetch(url, init);
    },
  });
  try {
    await app.start(config);
    const deadline = performance.now() + (PAUSE_429_FIRST * 1.5) / SPEED;
    while (gladys.fake.states.length === 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    await app.stop();
    clock.close();
    await server.close();
  }
  assert.equal(server.requests.length, 2);
  assert.equal(sent.length, 2);
  const gap = sent[1] - sent[0];
  assert.ok(gap >= PAUSE_429_FIRST, `gap ${Math.round(gap)} ms`);
  assert.ok(gap < PAUSE_429_FIRST * 1.2, `gap ${Math.round(gap)} ms`);
  assert.ok(gladys.fake.states.length > 0);
});
