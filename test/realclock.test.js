// -----------------------------------------------------------------------------
// The app on the REAL moving clock (performance.now, Date.now, setTimeout)
// sped up 20 times, against a real local HTTP server playing NDBC with the
// captures: the rounds really start at the interval (measured on the method
// that decides), the requests of two stations are 3 s apart, the second read
// is a 304, the timers stay bounded. The app is stopped in `finally`.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NdbcApp } from '../src/app.js';
import { REQUEST_GAP } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { MINUTE, createdDevices } from './helpers/setup.js';
import { startServer } from './helpers/server.js';

const SPEED = 20;
const REFRESH = 10;

test('real clock x20: one round per interval, requests 3 s apart, 304 next, bounded timers', async () => {
  const clock = realClock({ speed: SPEED });
  const server = await startServer(clock);
  const config = { stations: '46026, 45132', refresh_minutes: REFRESH };
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
  const spy = spyOn(app, 'round', clock);
  try {
    await app.start(config);
    const gaps = await measurePeriod(spy, { count: 2, period: REFRESH * MINUTE });
    assert.equal(gaps.length, 1);
    // The two requests of the second round (3 s apart), then the app stops.
    const deadline = performance.now() + (4 * REQUEST_GAP) / SPEED + 2000;
    while (server.requests.length < 4 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    await app.stop();
    clock.close();
    spy.restore();
    await server.close();
  }
  const { requests } = server;
  assert.ok(requests.length >= 4, `${requests.length} requests`);
  assert.equal(sent.length, requests.length);
  for (let i = 1; i < sent.length; i += 1) {
    const gap = sent[i] - sent[i - 1];
    assert.ok(gap >= 0.9 * REQUEST_GAP, `gap ${Math.round(gap)} ms`);
  }
  assert.match(requests[0].headers['user-agent'], /^gladys-ndbc\//);
  assert.equal(requests[0].headers.range, 'bytes=0-16383');
  assert.equal(requests[0].headers['if-none-match'], undefined);
  assert.equal(requests[2].headers['if-none-match'], '"46026-1"');
  assert.ok(clock.timersSet < 60, `${clock.timersSet} timers`);
  assert.ok(gladys.fake.states.length > 0);
});
