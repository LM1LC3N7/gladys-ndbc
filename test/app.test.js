// -----------------------------------------------------------------------------
// The app on a virtual clock against a scripted NDBC: what is published, when
// it is read, what the status says.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitStatus } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import {
  CAPTURED_AT,
  F,
  FIXTURES,
  HOUR,
  MINUTE,
  ONE,
  SECOND,
  TWO,
  createApi,
  createdDevices,
  defaultWorld,
  file,
  line,
  published,
  ranged,
  setup,
  status,
  statusEn,
  text,
} from './helpers/setup.js';

test('the first read publishes the newest value of each variable of the real file, once', async () => {
  const s = await setup();
  await s.begin();
  assert.equal(s.api.calls.length, 1);
  assert.match(s.api.calls[0].url, /\/data\/realtime2\/46026\.txt$/);
  // From the 05:50 line: wind, waves; from the 05:40 line: pressure, water.
  assert.deepEqual(published(s.fake, F('46026', 'wind-direction')), [290]);
  assert.deepEqual(published(s.fake, F('46026', 'wind-speed')), [3]);
  assert.deepEqual(published(s.fake, F('46026', 'wave-height')), [1.4]);
  assert.deepEqual(published(s.fake, F('46026', 'dominant-wave-period')), [14]);
  assert.deepEqual(published(s.fake, F('46026', 'pressure')), [1011.2]);
  assert.deepEqual(published(s.fake, F('46026', 'water-temperature')), [18.1]);
  // Missing (MM) in every line read: never published, never 0.
  for (const key of ['air-temperature', 'dew-point', 'visibility', 'tide']) {
    assert.deepEqual(published(s.fake, F('46026', key)), [], key);
  }
  assert.equal(s.fake.connectionStatus.connected, true);
  assert.match(
    statusEn(s.fake),
    /46026: \d+ value\(s\) under 2 h old, newest observation Oct 30, 05:50 UTC\./,
  );
  // The next round: the same file answers 304 (If-None-Match), nothing again.
  s.api.world = (url, api, call) =>
    call.init.headers['If-None-Match']
      ? new Response(null, {
          status: 304,
          headers: { date: new Date(api.clock.wall()).toUTCString() },
        })
      : defaultWorld(url, api, call);
  const count = s.fake.states.length;
  await s.wait(30 * MINUTE);
  assert.equal(s.api.calls.length, 2);
  assert.equal(
    s.api.calls[1].init.headers['If-None-Match'],
    undefined,
    'the default world sends no ETag',
  );
  assert.equal(s.fake.states.length, count, 'the same observations are never published again');
});

test('If-None-Match is sent with the ETag of the last read in this process; a 304 keeps the values', async () => {
  const s = await setup({
    api: createApi((url, api, call) => {
      if (call.init.headers['If-None-Match'] === '"v1"') {
        return new Response(null, {
          status: 304,
          headers: { date: new Date(api.clock.wall()).toUTCString() },
        });
      }
      return ranged(defaultWorld(url, api, call), call.init, {
        date: api.clock.wall(),
        etag: '"v1"',
      });
    }),
  });
  await s.begin();
  await s.wait(30 * MINUTE);
  assert.equal(s.api.calls[0].init.headers['If-None-Match'], undefined);
  assert.equal(s.api.calls[1].init.headers['If-None-Match'], '"v1"');
  assert.match(statusEn(s.fake), /46026: \d+ value\(s\) under 2 h old/);
  // The newest values (05:50) turn 2 h old 102 min after the read: the status says so at once.
  await s.wait(71 * MINUTE);
  assert.match(statusEn(s.fake), /46026: \d+ value\(s\) under 2 h old/);
  await s.wait(2 * MINUTE);
  assert.equal(s.fake.connectionStatus.connected, false);
  assert.match(
    statusEn(s.fake),
    /46026: silent: no value under 2 h old, newest observation Oct 30, 05:50 UTC; nothing published\./,
  );
});

test('a request names the integration, asks for the head only and plain bytes', async () => {
  const s = await setup();
  await s.begin();
  const { headers, redirect, method } = s.api.calls[0].init;
  assert.match(
    headers['User-Agent'],
    /^gladys-ndbc\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-ndbc\)$/,
  );
  assert.equal(headers.Range, 'bytes=0-16383');
  assert.equal(headers['Accept-Encoding'], 'identity');
  assert.equal(headers.Accept, 'text/plain');
  assert.equal(redirect, 'error');
  assert.equal(method, 'GET');
});

test('an observation just under 2 h old is published; just over is not', async () => {
  for (const [age, expected] of [
    [2 * HOUR - 100, [12.5]],
    [2 * HOUR + 100, []],
  ]) {
    const obs = CAPTURED_AT - 10 * MINUTE;
    // The server time: the observation plus `age` (the local clock does not count).
    const s = await setup({
      api: createApi((url, api, call) =>
        ranged(file(line(obs, { ATMP: 12.5 })), call.init, { date: obs + age }),
      ),
    });
    await s.begin();
    assert.deepEqual(published(s.fake, F('46026', 'air-temperature')), expected, `age ${age}`);
  }
});

test('the age is judged on the server Date, never the local clock', async () => {
  const obs = CAPTURED_AT - 30 * MINUTE;
  // The local clock is 3 h ahead: the observation is still 30 min old for the server.
  const s = await setup({
    wall: { offset: 3 * HOUR },
    api: createApi((url, api, call) =>
      ranged(file(line(obs, { WTMP: 9.5 })), call.init, { date: CAPTURED_AT }),
    ),
  });
  await s.begin();
  assert.deepEqual(published(s.fake, F('46026', 'water-temperature')), [9.5]);
});

test('without a believable server Date nothing is published, and the status says why', async () => {
  for (const date of [null, 0]) {
    const s = await setup({
      api: createApi(() =>
        date === null
          ? text(file(line(CAPTURED_AT, { WTMP: 9.5 })), { date: null })
          : text(file(line(CAPTURED_AT, { WTMP: 9.5 })), { date }),
      ),
    });
    await s.begin();
    assert.equal(s.fake.states.length, 0);
    assert.match(statusEn(s.fake), /46026: the server time cannot be read; no data yet\./);
    assert.equal(s.fake.connectionStatus.connected, false);
  }
});

test('every value missing (MM): nothing published, never 0; the status says MM', async () => {
  const s = await setup({
    api: createApi((url, api, call) =>
      ranged(file(line(CAPTURED_AT - 10 * MINUTE), line(CAPTURED_AT - 20 * MINUTE)), call.init, {
        date: api.clock.wall(),
      }),
    ),
  });
  await s.begin();
  assert.equal(s.fake.states.length, 0);
  assert.match(
    statusEn(s.fake),
    /46026: every value missing \(MM\) in the lines read, newest Oct 30, 05:58 UTC; nothing published\./,
  );
  assert.equal(s.fake.connectionStatus.connected, false);
});

test('a file without observation, a garbled file, a changed header: nothing published', async () => {
  const cases = [
    [file(), /the file holds no observation; nothing published/],
    [
      `${file(line(CAPTURED_AT, { WTMP: 9 }))}`.replace('#YY', '#YEAR'),
      /the file cannot be read \(format changed\?\); no data yet/,
    ],
    [
      file(
        line(CAPTURED_AT, { WTMP: 9 }),
        'x y z',
        '2026 10 30 05 00 garbage',
        line(CAPTURED_AT - HOUR).replace(/MM$/, 'oops'),
      ),
      /most lines of the file cannot be read \(format changed\?\); no data yet/,
    ],
    ['<html>maintenance</html>\n', /the file cannot be read/],
  ];
  for (const [body, pattern] of cases) {
    const s = await setup({
      api: createApi((url, api, call) => ranged(body, call.init, { date: api.clock.wall() })),
    });
    await s.begin();
    assert.equal(s.fake.states.length, 0, body.slice(0, 40));
    assert.match(statusEn(s.fake), pattern);
  }
});

test('a column in another unit is never used (a knot is not a m/s)', async () => {
  const body = file(line(CAPTURED_AT, { WSPD: 10, WTMP: 9 })).replace('m/s  m/s', 'kts  m/s');
  const s = await setup({
    api: createApi((url, api, call) => ranged(body, call.init, { date: api.clock.wall() })),
  });
  await s.begin();
  assert.deepEqual(published(s.fake, F('46026', 'wind-speed')), []);
  assert.deepEqual(published(s.fake, F('46026', 'water-temperature')), [9]);
  assert.match(statusEn(s.fake), /1 column\(s\) in an unexpected unit, not used/);
});

test('visibility (nmi) and tide (ft) are converted exactly', async () => {
  const body = file(line(CAPTURED_AT, { VIS: 10.0, TIDE: -1.5 }));
  const s = await setup({
    api: createApi((url, api, call) => ranged(body, call.init, { date: api.clock.wall() })),
  });
  await s.begin();
  assert.deepEqual(published(s.fake, F('46026', 'visibility')), [18.52]);
  assert.deepEqual(published(s.fake, F('46026', 'tide')), [-0.457]);
});

test('a new observation is published, an older or equal one never', async () => {
  let lines = [line(CAPTURED_AT - 10 * MINUTE, { WTMP: 9 })];
  const s = await setup({
    api: createApi((url, api, call) =>
      ranged(file(...lines), call.init, { date: api.clock.wall() }),
    ),
  });
  await s.begin();
  // The file goes back in time (an older copy of a cache): nothing.
  lines = [line(CAPTURED_AT - 20 * MINUTE, { WTMP: 8 })];
  await s.wait(30 * MINUTE);
  lines = [
    line(CAPTURED_AT + 25 * MINUTE, { WTMP: 10 }),
    line(CAPTURED_AT - 10 * MINUTE, { WTMP: 9 }),
  ];
  await s.wait(30 * MINUTE);
  assert.deepEqual(published(s.fake, F('46026', 'water-temperature')), [9, 10]);
});

test('a device created after the read gets the values still under 2 h old, never older', async () => {
  const s = await setup({ created: false });
  await s.begin();
  assert.equal(s.fake.states.length, 0, 'no device, nothing published');
  const [device] = createdDevices(ONE);
  await s.fake.deviceCreated(device);
  await s.wait(0);
  assert.deepEqual(published(s.fake, F('46026', 'water-temperature')), [18.1]);
  // A second creation (the user deletes and creates again): not twice.
  const count = s.fake.states.length;
  await s.fake.deviceCreated(device);
  await s.wait(0);
  assert.equal(s.fake.states.length, count);
});

test('a device created more than 2 h after the read gets nothing from memory', async () => {
  const s = await setup({ created: false, config: { ...ONE, refresh_minutes: 180 } });
  await s.begin();
  await s.wait(2 * HOUR);
  const [device] = createdDevices(ONE);
  await s.fake.deviceCreated(device);
  await s.wait(0);
  assert.equal(s.fake.states.length, 0);
});

test('Gladys refusing the values: published at the next read if still fresh', async () => {
  const s = await setup();
  const original = s.gladys.publishStates.bind(s.gladys);
  let fail = true;
  s.gladys.publishStates = async (states) => {
    if (fail) throw new Error('down');
    return original(states);
  };
  await s.begin();
  assert.equal(s.fake.states.length, 0);
  fail = false;
  await s.wait(30 * MINUTE);
  assert.deepEqual(published(s.fake, F('46026', 'water-temperature')), [18.1]);
});

test('/data keeps what was published: a restart never publishes it again', async () => {
  const store = createMemoryStore();
  const first = await setup({ store });
  await first.begin();
  await first.app.stop();
  assert.ok(store.data.stations['46026'].stamps['water-temperature'] > 0);
  const second = await setup({ store, start: CAPTURED_AT + 31 * MINUTE });
  await second.begin();
  assert.equal(second.api.calls.length, 1);
  assert.equal(second.fake.states.length, 0);
});

test('one request at a time, 3 s apart; stations read in order', async () => {
  const s = await setup({
    config: { stations: '46026 45132;PSBM1,44025' },
    api: createApi(async (url, api, call) => {
      (await api.clock.timers) && null;
      return defaultWorld(url, api, call);
    }),
  });
  await s.begin();
  await s.wait(10 * SECOND);
  assert.deepEqual(
    s.api.calls.map((c) => c.id),
    ['46026', '45132', 'PSBM1', '44025'],
  );
  assert.equal(s.api.peak, 1);
  for (let i = 1; i < s.api.calls.length; i += 1) {
    assert.ok(s.api.calls[i].at - s.api.calls[i - 1].at >= 3 * SECOND - 1);
  }
});

test('a station without realtime file (404) is tried again after 1 h, 2 h..., on its own timer', async () => {
  const s = await setup({ config: { stations: '46026, ZZZZ1', refresh_minutes: 30 } });
  await s.begin();
  await s.wait(5 * SECOND);
  assert.match(
    statusEn(s.fake),
    /ZZZZ1: no realtime file for this station \(404\), next try Oct 30, 07:08 UTC; no data yet\./,
  );
  assert.equal(s.fake.connectionStatus.connected, true);
  const at = () => s.api.calls.filter((c) => c.id === 'ZZZZ1').map((c) => c.at);
  await s.wait(60 * MINUTE - 10 * SECOND);
  assert.equal(at().length, 1, 'not again before 1 h');
  await s.wait(10 * SECOND);
  assert.equal(at().length, 2, 'at 1 h, not at the next round (90 min)');
  assert.ok(at()[1] - at()[0] >= HOUR && at()[1] - at()[0] < HOUR + 4 * SECOND);
  await s.wait(2 * HOUR - 10 * SECOND);
  assert.equal(at().length, 2);
  await s.wait(15 * SECOND);
  assert.equal(at().length, 3, 'then 2 h');
  // The other station keeps its interval.
  const others = s.api.calls.filter((c) => c.id === '46026').map((c) => Math.round(c.at / MINUTE));
  assert.deepEqual(others, [0, 30, 60, 90, 120, 150, 180]);
});

test('a 429 pauses every read (Retry-After kept, bounded to 6 h), in /data', async () => {
  for (const [retry, expected] of [
    [null, 5 * MINUTE],
    ['600', 10 * MINUTE],
    ['99999999999', 6 * HOUR],
  ]) {
    let n = 0;
    const s = await setup({
      config: { ...TWO, refresh_minutes: 10 },
      api: createApi((url, api, call) => {
        n += 1;
        if (n === 1) return status(429, api.clock.wall(), retry ? { 'retry-after': retry } : {});
        return defaultWorld(url, api, call);
      }),
    });
    await s.begin();
    await s.wait(10 * SECOND);
    assert.equal(s.api.calls.length, 1, 'the second station waits for the pause');
    assert.ok(Math.abs(s.store.data.pause.until - (CAPTURED_AT + expected)) < SECOND);
    assert.match(statusEn(s.fake), /NDBC asked to slow down \(429\): reads paused until/);
    await s.wait(expected - 20 * SECOND);
    assert.equal(s.api.calls.length, 1, `nothing before the end of the pause (${retry})`);
    await s.wait(30 * SECOND);
    assert.equal(s.api.calls.length, 3, `read right after the pause (${retry})`);
  }
});

test('one station in 5xx or 403 backs off alone; the others are read at their pace (s04 I)', async () => {
  const s = await setup({
    config: { stations: '46026, 44025, 45132', refresh_minutes: 10 },
    api: createApi((url, api, call) =>
      call.id === '44025' ? status(503, api.clock.wall()) : defaultWorld(url, api, call),
    ),
  });
  await s.begin();
  await s.wait(35 * MINUTE);
  const at = (id) => s.api.calls.filter((c) => c.id === id).map((c) => Math.round(c.at / SECOND));
  // The healthy stations: every 10 min, never held.
  assert.deepEqual(at('46026'), [0, 600, 1200, 1800]);
  assert.deepEqual(at('45132'), [6, 603, 1203, 1803]);
  // The failing one: 2 min, 4, 8, 16 (doubled), on its own timer.
  assert.deepEqual(at('44025'), [3, 123, 363, 843, 1806]);
  assert.doesNotMatch(statusEn(s.fake), /reads paused/);
  assert.match(statusEn(s.fake), /44025: NDBC server error \(503\), next try/);
  assert.equal(s.store.data.pause?.until ?? null, null);
});

test('every station of a round in 5xx: every read pauses 2 min, doubled; a success resets', async () => {
  let down = true;
  const s = await setup({
    config: { ...TWO, refresh_minutes: 10 },
    api: createApi((url, api, call) =>
      down ? status(503, api.clock.wall()) : defaultWorld(url, api, call),
    ),
  });
  await s.begin();
  await s.wait(10 * SECOND);
  assert.match(statusEn(s.fake), /NDBC server error \(503\): reads paused until Oct 30, 06:10 UTC/);
  assert.equal(s.store.data.pause.level5xx, 1);
  assert.equal(s.fake.connectionStatus.connected, false);
  // Then each station on its own back-off: 2 min, 4, 8 (a full round skips them).
  await s.wait(10 * MINUTE);
  const at = s.api.calls.filter((c) => c.id === '46026').map((c) => Math.round(c.at / SECOND));
  assert.deepEqual(at, [0, 123, 363]);
  down = false;
  await s.wait(5 * MINUTE);
  assert.equal(s.store.data.pause.level5xx, 0);
  assert.equal(s.store.data.pause.until, null);
  assert.equal(s.fake.connectionStatus.connected, true);
});

test('a station refused by another status backs off 2 min, doubled; a new kind starts again', async () => {
  const codes = [403, 403, 403, 500];
  const s = await setup({
    config: { ...TWO, refresh_minutes: 60 },
    api: createApi((url, api, call) => {
      if (call.id !== '45132') return defaultWorld(url, api, call);
      const code = codes.shift();
      return code ? status(code, api.clock.wall()) : defaultWorld(url, api, call);
    }),
  });
  await s.begin();
  await s.wait(40 * MINUTE);
  const at = s.api.calls.filter((c) => c.id === '45132').map((c) => Math.round(c.at / SECOND));
  assert.deepEqual(at, [3, 123, 363, 843, 963]);
  assert.match(statusEn(s.fake), /45132: \d+ value\(s\) under 2 h old/);
});

test('a 429 again doubles the pause: 5 min, 10, 20', async () => {
  const s = await setup({
    config: { ...ONE, refresh_minutes: 180 },
    api: createApi((url, api) => status(429, api.clock.wall())),
  });
  await s.begin();
  await s.wait(40 * MINUTE);
  const gaps = s.api.calls.slice(1).map((c, i) => Math.round((c.at - s.api.calls[i].at) / SECOND));
  assert.deepEqual(gaps, [300, 600, 1200]);
  assert.equal(s.store.data.pause.level429, 4);
});

test('the time of the attempt is in /data before the first request of a round', async () => {
  const store = createMemoryStore();
  const order = [];
  const s = await setup({ store, config: { ...ONE, refresh_minutes: 10 } });
  const save = store.save.bind(store);
  store.save = async (data) => {
    order.push(['save', data.lastAttemptAt ?? null, s.api.calls.length]);
    return save(data);
  };
  await s.begin();
  await s.wait(10 * MINUTE + SECOND);
  const firstCall = s.api.calls[0].wall;
  const before = order.filter(([, , calls]) => calls === 0);
  assert.ok(before.some(([, at]) => at !== null && Math.abs(at - firstCall) < SECOND));
  const secondCall = s.api.calls[1].wall;
  const between = order.filter(([, , calls]) => calls === 1);
  assert.ok(between.some(([, at]) => Math.abs(at - secondCall) < SECOND));
});

test('a 429 arriving after a configuration save or a reconnection still pauses', async () => {
  for (const event of ['config', 'reconnect']) {
    let release;
    const s = await setup({
      config: { ...ONE, refresh_minutes: 10 },
      api: createApi((url, api) =>
        api.calls.length === 1
          ? new Promise((resolve) => {
              release = () => resolve(status(429, api.clock.wall()));
            })
          : defaultWorld(url, api, api.calls.at(-1)),
      ),
    });
    await s.begin();
    if (event === 'config') await s.app.start({ ...ONE, refresh_minutes: 20 });
    else {
      await s.app.disconnected();
      s.app.connected();
    }
    await s.wait(SECOND);
    release();
    await s.wait(SECOND);
    assert.ok(s.store.data.pause?.until > s.clock.wall() + 4 * MINUTE, event);
    await s.wait(4 * MINUTE);
    assert.equal(s.api.calls.length, 1, `${event}: nothing during the pause`);
  }
});

test('a timer firing a little early at the end of a pause never skips the round', async () => {
  let n = 0;
  const s = await setup({
    config: { ...ONE, refresh_minutes: 60 },
    api: createApi((url, api, call) =>
      ++n === 1 ? status(429, api.clock.wall()) : defaultWorld(url, api, call),
    ),
  });
  // Every timer of the app fires 2 ms early.
  const set = s.clock.timers.setTimeout;
  s.clock.timers.setTimeout = (fn, ms, ...args) => set(fn, Math.max(0, ms - 2), ...args);
  await s.begin();
  await s.wait(5 * MINUTE + SECOND);
  assert.equal(s.api.calls.length, 2, 'read at the end of the 5 min pause, not 60 min later');
});

test('rounds start every interval, never sooner; a saved but unchanged configuration does not read', async () => {
  const s = await setup({ config: { ...ONE, refresh_minutes: 15 } });
  await s.begin();
  await s.wait(10 * MINUTE);
  await s.app.start({ ...ONE, refresh_minutes: 15 });
  await s.app.scan();
  await s.app.testConnection();
  await s.wait(4 * MINUTE);
  assert.equal(s.api.calls.length, 1);
  await s.wait(MINUTE + SECOND);
  assert.equal(s.api.calls.length, 2);
  const gaps = s.api.calls.slice(1).map((c, i) => c.at - s.api.calls[i].at);
  assert.ok(
    gaps.every((g) => g >= 15 * MINUTE && g < 15 * MINUTE + SECOND),
    gaps.join(),
  );
});

test('stations added to the configuration are read alone, at most once a minute (M7)', async () => {
  const s = await setup({ config: { ...ONE, refresh_minutes: 60 } });
  await s.begin();
  await s.wait(20 * SECOND);
  await s.app.start({ ...TWO, refresh_minutes: 60 });
  await s.flush();
  assert.deepEqual(
    s.api.calls.map((c) => c.id),
    ['46026', '45132'],
  );
  // Another station added 10 s later waits for the minute; a removal reads nothing.
  await s.wait(10 * SECOND);
  await s.app.start({ stations: '46026, 45132, PSBM1', refresh_minutes: 60 });
  await s.wait(30 * SECOND);
  assert.equal(s.api.calls.length, 2);
  await s.wait(25 * SECOND);
  assert.deepEqual(
    s.api.calls.map((c) => c.id),
    ['46026', '45132', 'PSBM1'],
  );
  await s.app.start({ stations: '46026, PSBM1', refresh_minutes: 60 });
  await s.app.start({ stations: 'PSBM1, 46026', refresh_minutes: 60 });
  await s.wait(30 * MINUTE);
  assert.equal(s.api.calls.length, 3);
  // The full round keeps its interval.
  await s.wait(30 * MINUTE);
  assert.equal(s.api.calls.length, 5);
});

test('configurations saved in a row apply one after the other, the last one winning', async () => {
  const s = await setup({ config: { ...ONE, refresh_minutes: 60 } });
  const original = s.gladys.publishDiscoveredDevices.bind(s.gladys);
  let slow = true;
  s.gladys.publishDiscoveredDevices = async (devices) => {
    if (slow) {
      slow = false;
      await new Promise((resolve) => s.clock.timers.setTimeout(resolve, 5 * SECOND));
    }
    return original(devices);
  };
  const first = s.app.start({ stations: '45132' });
  s.app.start({ stations: 'PSBM1' });
  s.app.start({ stations: '44025, 46026', language: 'fr' });
  await s.wait(0);
  await s.wait(6 * SECOND);
  await first;
  await s.app.idle();
  assert.deepEqual(s.app.config.stations, ['44025', '46026']);
  assert.deepEqual(
    s.fake.discoveredDevices.map((d) => d.name),
    ['Bouée NDBC 44025', 'Bouée NDBC 46026'],
  );
  await s.wait(10 * SECOND);
  assert.deepEqual(
    s.api.calls.map((c) => c.id),
    ['44025', '46026'],
  );
});

test('getConfig() failing on a connection is retried, spaced out, with the status, then starts', async () => {
  const s = await setup();
  let fails = 2;
  const original = s.gladys.getConfig.bind(s.gladys);
  s.gladys.getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('busy');
    }
    return original();
  };
  s.app.connected();
  await s.wait(0);
  assert.match(statusEn(s.fake), /Gladys did not give the configuration; new try in 5 s\./);
  await s.wait(5 * SECOND);
  assert.match(statusEn(s.fake), /new try in 10 s\./);
  assert.equal(s.api.calls.length, 0);
  await s.wait(10 * SECOND);
  await s.flush();
  assert.equal(s.api.calls.length, 1);
  assert.equal(s.fake.connectionStatus.connected, true);
});

test('a restart never reads sooner than the interval; /data that cannot tell waits 10 min', async () => {
  // /data says the last attempt was 5 min ago: the read comes 25 min later.
  const told = await setup({
    store: createMemoryStore({ lastAttemptAt: CAPTURED_AT - 5 * MINUTE }),
  });
  await told.begin();
  await told.wait(25 * MINUTE - SECOND);
  assert.equal(told.api.calls.length, 0);
  await told.wait(2 * SECOND);
  assert.equal(told.api.calls.length, 1);
  for (const store of [
    createMemoryStore(undefined, { status: 'unreadable' }),
    createMemoryStore({ lastAttemptAt: CAPTURED_AT + 5 * HOUR }),
    Object.assign(createMemoryStore({ lastAttemptAt: CAPTURED_AT - HOUR }), { failSave: true }),
    Object.assign(createMemoryStore({ lastAttemptAt: CAPTURED_AT - HOUR }), {
      holdLoad: new Promise(() => {}),
    }),
    Object.assign(createMemoryStore({ lastAttemptAt: CAPTURED_AT - HOUR }), {
      hold: new Promise(() => {}),
    }),
  ]) {
    const s = await setup({ store });
    await s.begin();
    await s.wait(3 * SECOND);
    assert.match(statusEn(s.fake), /the first read waits 10 min after the start/);
    await s.wait(10 * MINUTE - 4 * SECOND);
    assert.equal(s.api.calls.length, 0);
    await s.wait(6 * SECOND);
    assert.equal(s.api.calls.length, 1, 'read at 10 min, never blocked by /data');
  }
});

test('a frozen /data never holds a read: the next ones keep their pace', async () => {
  const store = createMemoryStore();
  const s = await setup({ store, config: { ...ONE, refresh_minutes: 10 } });
  await s.begin();
  store.hold = new Promise(() => {});
  await s.wait(10 * MINUTE + 3 * SECOND);
  await s.wait(10 * MINUTE + 3 * SECOND);
  assert.equal(s.api.calls.length, 3);
  assert.match(statusEn(s.fake), /could not be written in \/data/);
  // A stop does not wait for it either.
  let stopped = false;
  s.app.stop().then(() => (stopped = true));
  await s.wait(2 * SECOND + 1);
  assert.equal(stopped, true);
});

test('/data unreadable: left untouched, said in the status', async () => {
  const store = createMemoryStore(undefined, { status: 'unreadable' });
  const s = await setup({ store });
  await s.begin();
  await s.wait(11 * MINUTE);
  assert.equal(store.saves, 0);
  assert.match(statusEn(s.fake), /The state file of \/data cannot be read: left untouched/);
});

test('a stop during a request: nothing published after it, no round after it', async () => {
  let release;
  const s = await setup({
    api: createApi(
      (url, api, call) =>
        new Promise((resolve) => {
          release = () => resolve(defaultWorld(url, api, call));
        }),
    ),
  });
  await s.begin();
  await s.app.stop();
  release();
  await s.wait(2 * HOUR);
  assert.equal(s.fake.states.length, 0);
  assert.equal(s.api.calls.length, 1);
});

test('the test button shows the last read and never reads', async () => {
  const s = await setup();
  await s.begin();
  const message = await s.app.testConnection();
  assert.match(message.en, /46026: \d+ value\(s\) under 2 h old/);
  assert.match(message.fr, /46026 : \d+ valeur\(s\) de moins de 2 h/);
  assert.equal(s.api.calls.length, 1);
});

test('a failed read keeps the last data in the status, said as old, nothing published since', async () => {
  let down = false;
  const s = await setup({
    config: { ...ONE, refresh_minutes: 30 },
    api: createApi((url, api, call) => (down ? 'network' : defaultWorld(url, api, call))),
  });
  await s.begin();
  down = true;
  await s.wait(30 * MINUTE);
  assert.match(
    statusEn(s.fake),
    /46026: NDBC unreachable; last read Oct 30, 06:08 UTC: \d+ value\(s\) under 2 h old, newest observation Oct 30, 05:50 UTC; nothing published since\./,
  );
  assert.equal(
    s.fake.connectionStatus.connected,
    false,
    'every station in failure is not connected',
  );
  await s.wait(90 * MINUTE);
  assert.match(statusEn(s.fake), /last read Oct 30, 06:08 UTC: silent: no value under 2 h old/);
});

test('no station: status, no read; a refused field is named, not echoed', async () => {
  const s = await setup({ config: { stations: 'bad!!, 46026x' } });
  await s.begin();
  await s.wait(HOUR);
  assert.equal(s.api.calls.length, 0);
  assert.equal(
    statusEn(s.fake),
    'No station to read. Stations holds an entry that is not a station id (4 or 5 letters or digits, as 46026 or KATP): left out',
  );
});

test('states published per minute stay under the core limit (sliding minute)', async () => {
  const ids = [
    'AAAA1',
    'AAAA2',
    'AAAA3',
    'AAAA4',
    'AAAA5',
    'AAAA6',
    'AAAA7',
    'AAAA8',
    'AAAA9',
    'AAAA0',
  ];
  const all = {
    WDIR: 10,
    WSPD: 1,
    GST: 2,
    WVHT: 1,
    DPD: 5,
    APD: 4,
    MWD: 20,
    PRES: 1000,
    ATMP: 10,
    WTMP: 9,
    DEWP: 5,
    VIS: 5,
    PTDY: 1,
    TIDE: 1,
  };
  const config = { stations: ids.join(','), refresh_minutes: 10 };
  const s = await setup({
    config,
    api: createApi((url, api, call) =>
      ranged(file(line(api.clock.wall() - MINUTE, all)), call.init, { date: api.clock.wall() }),
    ),
  });
  const times = [];
  const original = s.gladys.publishStates.bind(s.gladys);
  s.gladys.publishStates = async (states) => {
    for (const _ of states) times.push(s.clock.elapsed);
    return original(states);
  };
  await s.begin();
  await s.wait(30 * SECOND);
  assert.equal(times.length, 140, '10 stations x 14 values');
  // Other states in the same minute (a burst of device creations).
  assert.equal(s.app.budget(200, s.clock.monotonic()), 110);
  assert.equal(s.app.budget(1, s.clock.monotonic()), 0);
  // The next round comes while the minute is full.
  await s.wait(10 * MINUTE - 31 * SECOND);
  s.app.sent = s.app.sent.concat(Array(250).fill(s.clock.monotonic()));
  await s.wait(40 * SECOND);
  assert.match(s.lines.join('\n'), /AAAA1: 14 value\(s\) held back \(states per minute\)/);
  // Held back values go out at a later read, while still fresh.
  await s.wait(10 * MINUTE);
  for (const t of times) {
    const inMinute = times.filter((u) => u >= t && u < t + MINUTE).length;
    assert.ok(inMinute <= 250, `${inMinute} states in the minute from ${t}`);
  }
  assert.ok(times.length >= 140 + 126, `${times.length}`);
});

test('a read failed for a passing cause is retried at 2 min, then 4 min; the stations read are not', async () => {
  let down = new Set(['45132']);
  const s = await setup({
    config: { ...TWO, refresh_minutes: 30 },
    api: createApi((url, api, call) =>
      down.has(call.id) ? 'network' : defaultWorld(url, api, call),
    ),
  });
  await s.begin();
  await s.wait(5 * SECOND);
  assert.deepEqual(
    s.api.calls.map((c) => c.id),
    ['46026', '45132'],
  );
  await s.wait(2 * MINUTE);
  assert.deepEqual(
    s.api.calls.map((c) => c.id),
    ['46026', '45132', '45132'],
  );
  await s.wait(3 * MINUTE + 50 * SECOND);
  assert.equal(s.api.calls.length, 3, 'the second retry waits 4 min');
  down = new Set();
  await s.wait(20 * SECOND);
  assert.equal(s.api.calls.length, 4);
  assert.deepEqual(published(s.fake, F('45132', 'water-temperature')), [15.9]);
  // Then back to the interval: the round at 30 min.
  await s.wait(20 * MINUTE);
  assert.equal(s.api.calls.length, 4);
  await s.wait(5 * MINUTE);
  assert.deepEqual(
    s.api.calls.slice(4).map((c) => c.id),
    ['46026', '45132'],
  );
});

test('a format failure is not retried before the next round', async () => {
  const s = await setup({
    config: { ...ONE, refresh_minutes: 30 },
    api: createApi((url, api, call) => ranged('garbage\n', call.init, { date: api.clock.wall() })),
  });
  await s.begin();
  await s.wait(29 * MINUTE);
  assert.equal(s.api.calls.length, 1);
});

test('a retry still due keeps its turn after an unchanged configuration save', async () => {
  let down = true;
  const s = await setup({
    config: { ...ONE, refresh_minutes: 60 },
    api: createApi((url, api, call) => (down ? 'timeout' : defaultWorld(url, api, call))),
  });
  await s.begin();
  await s.wait(31 * SECOND);
  assert.equal(s.api.calls.length, 1);
  down = false;
  await s.app.start({ ...ONE, refresh_minutes: 60 });
  await s.wait(2 * MINUTE);
  assert.equal(s.api.calls.length, 2);
  assert.match(statusEn(s.fake), /46026: \d+ value\(s\) under 2 h old/);
});

test('/data: a pause still running is kept at restart; one longer than 6 h is not believed', async () => {
  const kept = await setup({
    store: createMemoryStore({
      pause: { until: CAPTURED_AT + 20 * MINUTE, kind: 'rate', level429: 1 },
    }),
  });
  await kept.begin();
  await kept.wait(20 * MINUTE - SECOND);
  assert.equal(kept.api.calls.length, 0);
  assert.match(
    statusEn(kept.fake),
    /NDBC asked to slow down \(429\): reads paused until Oct 30, 06:28 UTC/,
  );
  await kept.wait(2 * SECOND);
  assert.equal(kept.api.calls.length, 1);
  const absurd = await setup({
    store: createMemoryStore({ pause: { until: CAPTURED_AT + 7 * HOUR, kind: 'rate' } }),
  });
  await absurd.begin();
  assert.equal(absurd.api.calls.length, 1);
});

test('/data: odd entries are dropped, stamps in the future are not believed', async () => {
  const store = createMemoryStore({
    stations: {
      46026: {
        stamps: {
          'water-temperature': CAPTURED_AT + 3 * 24 * HOUR,
          pressure: CAPTURED_AT,
          bogus: 1,
        },
      },
      'bad id': { stamps: {} },
      __proto__x: null,
    },
  });
  const s = await setup({ store });
  await s.begin();
  // The future stamp is gone: the value is published; pressure (stamped later) is not.
  assert.deepEqual(published(s.fake, F('46026', 'water-temperature')), [18.1]);
  assert.deepEqual(published(s.fake, F('46026', 'pressure')), []);
  assert.deepEqual(Object.keys(store.data.stations), ['46026']);
  assert.equal(store.data.stations['46026'].stamps.bogus, undefined);
});

test('/data keeps 50 stations at most, the configured ones first', async () => {
  const stations = {};
  for (let i = 0; i < 60; i += 1) {
    stations[`B${String(i).padStart(4, '0')}`] = { stamps: {}, seenAt: CAPTURED_AT - i * MINUTE };
  }
  const store = createMemoryStore({ stations });
  const s = await setup({ store, config: { stations: '46026' } });
  await s.begin();
  const kept = Object.keys(store.data.stations);
  assert.equal(kept.length, 50);
  assert.ok(kept.includes('46026'));
  assert.ok(kept.includes('B0000'));
  assert.ok(!kept.includes('B0049'));
});

test('a device of another station or integration created: nothing published', async () => {
  const s = await setup({ created: false });
  await s.begin();
  await s.app.deviceCreated({ external_id: 'ext:ndbc:station:44025' });
  await s.app.deviceCreated({ external_id: 'ext:other:station:46026' });
  await s.app.deviceCreated(null);
  assert.equal(s.fake.states.length, 0);
});

test('a station removed from the configuration is forgotten in the status', async () => {
  const s = await setup({ config: TWO });
  await s.begin();
  await s.wait(5 * SECOND);
  assert.match(statusEn(s.fake), /45132:/);
  await s.app.start(ONE);
  await s.flush();
  assert.doesNotMatch(statusEn(s.fake), /45132/);
  assert.equal(s.app.results.has('45132'), false);
});

test('Discovery publishes one device per station with every feature, never reads', async () => {
  const s = await setup({ config: { stations: '46026, PSBM1', language: 'fr' } });
  await s.app.scan();
  assert.equal(s.api.calls.length, 0);
  const [d] = s.fake.discoveredDevices;
  assert.equal(d.name, 'Bouée NDBC 46026');
  assert.equal(d.external_id, 'ext:ndbc:station:46026');
  assert.equal(d.features.length, 14);
  assert.ok(d.features.every((f) => f.read_only && !f.has_feedback && f.keep_history));
  assert.equal(
    d.features.find((f) => f.external_id.endsWith(':water-temperature')).name,
    "Température de l'eau",
  );
});

test('timers firing a little early never start a round before the interval', async () => {
  const s = await setup({ config: { ...ONE, refresh_minutes: 15 } });
  const set = s.clock.timers.setTimeout;
  s.clock.timers.setTimeout = (fn, ms, ...args) => set(fn, Math.max(0, ms - 2), ...args);
  await s.begin();
  await s.wait(46 * MINUTE);
  assert.equal(s.api.calls.length, 4);
  for (let i = 1; i < s.api.calls.length; i += 1) {
    const gap = s.api.calls[i].at - s.api.calls[i - 1].at;
    assert.ok(gap >= 15 * MINUTE, `gap ${gap}`);
  }
  // No empty round either (each one writes /data twice): the timer is armed again.
  assert.equal(s.store.saves, 1 + 2 * 4);
});

test('a pause that starts while a request waits its turn holds it; the station is read at its end', async () => {
  let release;
  const s = await setup({
    config: { ...ONE, refresh_minutes: 60 },
    api: createApi((url, api, call) =>
      api.calls.length === 1
        ? new Promise((resolve) => {
            release = () => resolve(status(429, api.clock.wall()));
          })
        : defaultWorld(url, api, call),
    ),
  });
  await s.begin();
  // A station added: read at once, while the request of the first round hangs.
  s.app.start(TWO);
  await s.flush();
  await s.wait(10 * SECOND);
  assert.equal(s.api.calls.length, 1, 'the added station waits for the request in flight');
  // The 429 of the first round arrives while the new read waits for it.
  release();
  await s.flush();
  await s.wait(10 * SECOND);
  assert.equal(s.api.calls.length, 1, 'nothing sent during the pause');
  assert.match(statusEn(s.fake), /45132: not read \(pause\)/);
  await s.wait(5 * MINUTE);
  assert.deepEqual(
    s.api.calls.map((c) => c.id),
    ['46026', '46026', '45132'],
  );
});

test('the retry spacing starts again after each round', async () => {
  const s = await setup({
    config: { ...ONE, refresh_minutes: 10 },
    api: createApi(() => 'network'),
  });
  await s.begin();
  await s.wait(25 * MINUTE);
  // Round at 0, retries at 2 and 6 (the next, at 14, would come after the round of 10);
  // round at 10, retries at 12 and 16; round at 20, retry at 22.
  const minutes = s.api.calls.map((c) => Math.round(c.at / MINUTE));
  assert.deepEqual(minutes, [0, 2, 6, 10, 12, 16, 20, 22]);
});

test('defence in depth: a 304 without the file in memory, a publication of an older start', async () => {
  const s = await setup();
  s.app.config = { stations: ['46026'], refreshMinutes: 30, language: 'en', errors: [] };
  s.app.request = async () => ({ ok: true, notModified: true, serverDate: CAPTURED_AT });
  assert.deepEqual(await s.app.readStation('46026', s.app.gen), {
    ok: false,
    kind: 'format',
    status: 304,
  });
  // A publication asked by a start that is no longer the current one sends nothing.
  const read = await (async () => {
    s.app.request = async () => ({
      ok: true,
      text: FIXTURES['46026'],
      complete: false,
      etag: null,
      serverDate: CAPTURED_AT,
    });
    return s.app.readStation('46026', s.app.gen);
  })();
  assert.equal(read.ok, true);
  s.app.results.set('46026', read);
  await s.app.publishStation('46026', s.app.gen - 1);
  assert.equal(s.fake.states.length, 0);
  await s.app.publishStation('46026', s.app.gen);
  assert.ok(s.fake.states.length > 0);
});

test('a platform with a 4-character id (KATP: whole degrees, visibility) is read and published', async () => {
  const body = file(
    line(CAPTURED_AT - 15 * MINUTE, { WDIR: 80, WSPD: 8.2, ATMP: 26, DEWP: 21 }),
    line(CAPTURED_AT - 35 * MINUTE, { WDIR: 80, WSPD: 8.8, ATMP: 26, DEWP: 21, VIS: '7.0' }),
  );
  const s = await setup({
    config: { stations: 'katp' },
    api: createApi((url, api, call) => ranged(body, call.init, { date: api.clock.wall() })),
  });
  await s.begin();
  assert.match(s.api.calls[0].url, /\/KATP\.txt$/);
  assert.deepEqual(published(s.fake, F('KATP', 'air-temperature')), [26]);
  assert.deepEqual(published(s.fake, F('KATP', 'visibility')), [12.96]);
  assert.match(statusEn(s.fake), /KATP: 5 value\(s\) under 2 h old/);
});

test('a CDN copy: an observation 125 min old with a Date 10 min behind (Age 600) is not published', async () => {
  const obs = CAPTURED_AT - 125 * MINUTE;
  const s = await setup({
    api: createApi((url, api, call) =>
      ranged(file(line(obs, { WTMP: 9.5 })), call.init, {
        date: CAPTURED_AT - 10 * MINUTE,
        etag: undefined,
      }),
    ),
  });
  // The helper cannot add Age: wrap the answer.
  const world = s.api.world;
  s.api.world = async (...args) => {
    const r = await world(...args);
    const headers = new Headers(r.headers);
    headers.set('age', '600');
    return new Response(await r.arrayBuffer(), { status: r.status, headers });
  };
  await s.begin();
  assert.equal(s.fake.states.length, 0);
  assert.match(statusEn(s.fake), /46026: silent/);
});

test('the status keeps the global lines whole; the station lines are shortened first', () => {
  assert.equal(fitStatus(['A.'], ['b long.'], ['b.'], 20), 'A. b long.');
  assert.equal(fitStatus(['A.'], ['b long long.'], ['b.'], 10), 'A. b.');
  assert.equal(fitStatus(['A long head.'], ['b.'], ['b.'], 6), 'A long');
  assert.equal(fitStatus(['é'.repeat(5)], [], [], 3), 'ééé');
});

test('10 stations failing and /data unreadable: next read and the /data warning stay in the status', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `BBBB${i}`);
  const store = createMemoryStore(undefined, { status: 'unreadable' });
  const s = await setup({
    store,
    config: { stations: ids.join(','), refresh_minutes: 10 },
    api: createApi(() => 'network'),
  });
  await s.begin();
  await s.wait(11 * MINUTE);
  for (const lang of ['en', 'fr']) {
    const text = s.fake.connectionStatus.message[lang];
    assert.ok([...text].length <= 1500, `${lang}: ${text.length}`);
    assert.match(text, lang === 'en' ? /Next read/ : /Prochaine lecture/);
    assert.match(text, /\/data/);
    assert.match(text, /BBBB9/);
  }
});

test('the global pause doubles: 5xx 2 min then 4, another status 2 min then 4 (own levels)', async () => {
  const s = await setup();
  s.app.config = { stations: ['46026'], refreshMinutes: 30, language: 'en', errors: [] };
  const length = (kind) => {
    const mono = s.clock.monotonic();
    s.app.pauseUntilMono = null;
    s.app.startPause({ kind, status: kind === 'server' ? 503 : 403 });
    return Math.round((s.app.pauseUntilMono - mono) / SECOND);
  };
  assert.deepEqual(
    [length('server'), length('server'), length('http'), length('http'), length('server')],
    [120, 240, 120, 240, 480],
  );
});

test('a station back-off honours Retry-After, bounded to 6 h', async () => {
  for (const [retry, expected] of [
    ['600', 600],
    ['99999999', 6 * 3600],
  ]) {
    let n = 0;
    const s = await setup({
      config: { ...TWO, refresh_minutes: 180 },
      api: createApi((url, api, call) =>
        call.id === '45132' && ++n === 1
          ? status(503, api.clock.wall(), { 'retry-after': retry })
          : defaultWorld(url, api, call),
      ),
    });
    await s.begin();
    await s.wait(7 * HOUR);
    const at = s.api.calls.filter((c) => c.id === '45132').map((c) => Math.round(c.at / SECOND));
    assert.equal(at[1] - at[0], expected, retry);
  }
});

test('a station whose back-off ended and that then fails otherwise is not read in a loop', async () => {
  let n = 0;
  const s = await setup({
    config: { ...TWO, refresh_minutes: 60 },
    api: createApi((url, api, call) => {
      if (call.id !== '45132') return defaultWorld(url, api, call);
      n += 1;
      return n === 1 ? status(503, api.clock.wall()) : 'network';
    }),
  });
  await s.begin();
  await s.wait(20 * MINUTE);
  // 503 at 0, back-off read at 2 min (network), retries at 4 and 8 min; no read every 3 s.
  const at = s.api.calls.filter((c) => c.id === '45132').map((c) => Math.round(c.at / MINUTE));
  assert.deepEqual(at, [0, 2, 4, 8, 16]);
});
