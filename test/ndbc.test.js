// -----------------------------------------------------------------------------
// The NDBC client and the strict reading of a realtime file: the real
// captures, then every way a file or an answer can go wrong.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD_BYTES, VARIABLES } from '../src/constants.js';
import { latestValues } from '../src/model.js';
import {
  convert,
  getStationHead,
  parseRealtime,
  readHttpDate,
  readAge,
  readRetryAfter,
  stationUrl,
} from '../src/ndbc.js';
import { CAPTURED_AT, FIXTURES, HEADER, MINUTE, file, line, text } from './helpers/setup.js';

const at = (iso) => Date.parse(iso);

test('the real captures are read, column by column, MM as missing', () => {
  const p = parseRealtime(FIXTURES['46026'], false);
  assert.equal(p.ok, true);
  assert.equal(p.unreadable, 0);
  assert.deepEqual(p.units, []);
  assert.equal(p.rows[0].at, at('2026-10-30T05:50:00Z'));
  assert.deepEqual(p.rows[0].values, {
    'wind-direction': 290,
    'wind-speed': 3,
    'wind-gust': 4,
    'wave-height': 1.4,
    'dominant-wave-period': 14,
    'average-wave-period': 7.3,
    'wave-direction': 264,
  });
  const l = latestValues(p.rows, CAPTURED_AT);
  assert.deepEqual(l.values.pressure, { value: 1011.2, at: at('2026-10-30T05:40:00Z') });
  assert.equal(l.values['air-temperature'], undefined);
  // A C-MAN station: no waves; a Canadian buoy: hourly, PTDY signed.
  const psbm1 = latestValues(parseRealtime(FIXTURES.PSBM1, false).rows, CAPTURED_AT);
  assert.equal(psbm1.values['wave-height'], undefined);
  assert.equal(psbm1.values['air-temperature'].value, 12.7);
  const p45132 = latestValues(parseRealtime(FIXTURES['45132'], true).rows, CAPTURED_AT);
  assert.equal(p45132.values['pressure-tendency'].value, 1.4);
  assert.equal(p45132.values['dominant-wave-period'].value, 3);
  // A wave buoy without wind.
  const p44025 = latestValues(parseRealtime(FIXTURES['44025'], false).rows, CAPTURED_AT);
  assert.equal(p44025.values['wind-speed'], undefined);
  assert.equal(p44025.values['wave-height'].value, 0.9);
});

test('a cut text drops its last (partial) line; a whole one keeps it', () => {
  const body = file(
    line(at('2026-10-30T05:00Z'), { WTMP: 9 }),
    line(at('2026-10-30T04:00Z'), { WTMP: 8 }),
  );
  const cut = body.slice(0, -10);
  assert.equal(parseRealtime(cut, false).rows.length, 1);
  assert.equal(parseRealtime(cut, false).unreadable, 0);
  // Cut inside the last value of a line (TIDE 12.5 cut to 12): never read as 12.
  const tide = file(
    line(at('2026-10-30T05:00Z'), { TIDE: 9.5 }),
    line(at('2026-10-30T04:00Z'), { TIDE: 12.5 }),
  );
  const inside = parseRealtime(tide.slice(0, -3), false);
  assert.equal(inside.rows.length, 1);
  assert.equal(inside.unreadable, 0);
  assert.equal(parseRealtime(body, true).rows.length, 2);
  // Cut exactly at a line end: the empty tail is dropped, nothing else.
  assert.equal(parseRealtime(body, false).rows.length, 2);
});

test('headers: date columns first, names and units aligned, else not read', () => {
  const row = line(at('2026-10-30T05:00Z'), { WTMP: 9 });
  assert.equal(parseRealtime(file(row), true).ok, true);
  for (const broken of [
    file(row).replace('#YY  MM DD hh mm', '#YY  DD MM hh mm'),
    file(row).replace('#yr  mo dy hr mn degT', '#yr  mo dy hr mn'),
    file(row).replace(/^#.*\n#.*\n/, ''),
    file(row).replace(/^#/, ''),
    `${HEADER.split('\n')[0]}\n${row}\n`,
    '',
  ]) {
    assert.deepEqual(
      parseRealtime(broken, true),
      { ok: false, kind: 'format' },
      broken.slice(0, 50),
    );
  }
  assert.deepEqual(parseRealtime(null, true), { ok: false, kind: 'format' });
});

test('columns are found by name: reordered or missing columns are fine', () => {
  const body = '#YY  MM DD hh mm WTMP WSPD\n#yr  mo dy hr mn degC m/s\n2026 10 30 05 00 9.5 MM\n';
  const p = parseRealtime(body, true);
  assert.deepEqual(p.rows[0].values, { 'water-temperature': 9.5 });
});

test('a column in another unit is left out and named', () => {
  const body = file(line(at('2026-10-30T05:00Z'), { WTMP: 9, PRES: 1000 })).replace(
    ' hPa  degC',
    ' inHg  degC',
  );
  const p = parseRealtime(body, true);
  assert.deepEqual(p.units, ['pressure']);
  assert.deepEqual(p.rows[0].values, { 'water-temperature': 9 });
});

test('values: strict decimals inside their range; fill values and others missing', () => {
  const t = at('2026-10-30T05:00Z');
  const read = (values) => parseRealtime(file(line(t, values)), true);
  assert.deepEqual(
    read({ WDIR: 999, WSPD: 99.0, WVHT: 99.0, PRES: 9999.0, ATMP: 999.0, VIS: 99.0, TIDE: 99.0 })
      .rows[0].values,
    {},
  );
  assert.deepEqual(
    read({ WDIR: 0, WSPD: 0.0, ATMP: -12.5, PTDY: '-1.2', TIDE: '+0.0' }).rows[0].values,
    {
      'wind-direction': 0,
      'wind-speed': 0,
      'air-temperature': -12.5,
      'pressure-tendency': -1.2,
      tide: 0,
    },
  );
  // A direction is a whole number of degrees; 360 is north.
  assert.deepEqual(read({ WDIR: 180.5, MWD: 360 }).rows[0].values, { 'wave-direction': 360 });
  // Bounds are inclusive.
  assert.deepEqual(read({ PRES: 800, WTMP: 45, WVHT: 40.01 }).rows[0].values, {
    pressure: 800,
    'water-temperature': 45,
  });
  // Not a plain decimal: the line is garbled (1e3, hex, empty).
  for (const bad of ['1e3', '0x10', '1,5', '--1', '.5', '5.', 'NaN', 'MMM', '1.2345']) {
    const p = parseRealtime(
      file(line(t, { WTMP: bad }), line(t - 3600000, { WTMP: 9 }), line(t - 7200000, { WTMP: 8 })),
      true,
    );
    assert.equal(p.unreadable, 1, bad);
    assert.equal(p.rows.length, 2, bad);
  }
});

test('dates: strict, a day that does not exist is a garbled line', () => {
  const good = line(at('2026-10-30T05:00Z'), { WTMP: 9 });
  for (const bad of [
    '2026 02 30 05 00',
    '2026 13 01 05 00',
    '2026 10 30 24 00',
    '2026 10 30 05 60',
    '26 10 30 05 00',
    '2026 1 30 05 00',
  ]) {
    const row = `${bad} ${good.split(' ').slice(5).join(' ')}`;
    const p = parseRealtime(file(row, good, good), true);
    assert.equal(p.unreadable, 1, bad);
  }
  assert.equal(parseRealtime(file(good), true).rows[0].at, at('2026-10-30T05:00Z'));
});

test('more than half of the lines unreadable: the file is refused; half is fine', () => {
  const good = line(at('2026-10-30T05:00Z'), { WTMP: 9 });
  assert.deepEqual(parseRealtime(file(good, 'garbage line', 'x'), true), {
    ok: false,
    kind: 'unreadable_rows',
  });
  const half = parseRealtime(file(good, 'garbage line'), true);
  assert.equal(half.ok, true);
  assert.equal(half.unreadable, 1);
  // A comment line among the data counts as unreadable; empty lines do not count.
  assert.equal(parseRealtime(file(good, '', '#x', good, good), true).unreadable, 1);
  assert.equal(parseRealtime(file(), true).rows.length, 0);
});

test('a too long line or extra columns are garbled', () => {
  const good = line(at('2026-10-30T05:00Z'), { WTMP: 9 });
  const p = parseRealtime(file(`${good} 1`, good, good), true);
  assert.equal(p.unreadable, 1);
});

test('only the first 400 lines are read', () => {
  const lines = Array.from({ length: 450 }, (_, i) =>
    line(at('2026-10-30T05:00Z') - i * MINUTE, { WTMP: 9 }),
  );
  assert.equal(parseRealtime(file(...lines), true).rows.length, 400);
});

test('exact conversions: 1 nmi = 1.852 km, 1 ft = 0.3048 m', () => {
  const vis = VARIABLES.find((v) => v.column === 'VIS');
  const tide = VARIABLES.find((v) => v.column === 'TIDE');
  assert.equal(convert(vis, 1), 1.85);
  assert.equal(convert(vis, 10), 18.52);
  assert.equal(convert(vis, 0.5), 0.93);
  assert.equal(convert(tide, 1), 0.305);
  assert.equal(convert(tide, -2.3), -0.701);
  assert.equal(convert(tide, 10), 3.048);
  assert.equal(convert(VARIABLES[0], 270), 270);
});

test('latest values: per variable, future lines not believed, same time once', () => {
  const t = at('2026-10-30T05:00Z');
  const rows = [
    { at: t + 6 * MINUTE, values: { 'water-temperature': 99 } },
    { at: t + 4 * MINUTE, values: { pressure: 1001 } },
    { at: t, values: { 'water-temperature': 9 } },
    { at: t, values: { 'water-temperature': 7, 'air-temperature': 5 } },
    { at: t - 60 * MINUTE, values: { 'air-temperature': 4, 'water-temperature': 8 } },
  ];
  const l = latestValues(rows, t - MINUTE);
  assert.equal(l.newestAt, t + 4 * MINUTE);
  assert.deepEqual(l.values, {
    pressure: { value: 1001, at: t + 4 * MINUTE },
    'water-temperature': { value: 9, at: t },
    'air-temperature': { value: 4, at: t - 60 * MINUTE },
  });
  // Sorted by time whatever the order of the file.
  const reversed = latestValues([...rows].reverse(), t + 10 * MINUTE);
  assert.equal(reversed.values['water-temperature'].value, 99);
  assert.deepEqual(latestValues([], t), { newestAt: null, values: {} });
});

// --- The HTTP client ---------------------------------------------------------

const fakeTimers = () => {
  const timers = { pending: new Set() };
  timers.setTimeout = (fn, ms) => {
    const h = { fn, ms };
    timers.pending.add(h);
    return h;
  };
  timers.clearTimeout = (h) => timers.pending.delete(h);
  timers.fire = () => {
    for (const h of [...timers.pending]) {
      timers.pending.delete(h);
      h.fn();
    }
  };
  return timers;
};

const head = (answer, options = {}) => {
  const timers = fakeTimers();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === 'function' ? answer(init) : answer;
  };
  return getStationHead('https://x/data/realtime2/46026.txt', {
    fetchImpl,
    timers,
    ...options,
  }).then((result) => ({ result, calls, timers }));
};

const DATE = 'Fri, 30 Oct 2026 06:08:00 GMT';

test('the URL of a station', () => {
  assert.equal(stationUrl('46026'), 'https://www.ndbc.noaa.gov/data/realtime2/46026.txt');
  assert.equal(stationUrl('PSBM1', 'http://127.0.0.1:1'), 'http://127.0.0.1:1/PSBM1.txt');
});

test('206: whole when the range covers the file, else a part; 200 read to its end', async () => {
  const body = FIXTURES['45132'];
  const n = Buffer.byteLength(body, 'latin1');
  let r = await head(
    text(body, {
      status: 206,
      date: CAPTURED_AT,
      headers: { 'content-range': `bytes 0-${n - 1}/${n}` },
    }),
  );
  assert.equal(r.result.complete, true);
  assert.equal(r.result.text, body);
  r = await head(
    text(body, {
      status: 206,
      date: CAPTURED_AT,
      headers: { 'content-range': `bytes 0-${n - 1}/${n + 5}` },
    }),
  );
  assert.equal(r.result.complete, false);
  r = await head(
    text(body, {
      status: 206,
      date: CAPTURED_AT,
      headers: { 'content-range': `bytes 0-${n - 1}/*` },
    }),
  );
  assert.equal(r.result.complete, false);
  r = await head(text(body, { date: CAPTURED_AT }));
  assert.equal(r.result.complete, true);
  assert.equal(r.result.serverDate, CAPTURED_AT);
  assert.equal(r.calls[0].init.headers.Range, `bytes=0-${HEAD_BYTES - 1}`);
});

test('a part that does not start at 0, or without Content-Range, is refused', async () => {
  for (const range of ['bytes 10-100/500', '', 'bytes 0-10', 'items 0-10/20']) {
    const r = await head(
      text('x', {
        status: 206,
        date: CAPTURED_AT,
        headers: range ? { 'content-range': range } : {},
      }),
    );
    assert.equal(r.result.kind, 'format', range);
  }
});

test('a server ignoring the range: only the head is read, the rest never', async () => {
  let pulled = 0;
  const big = new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > 1000) controller.close();
      else controller.enqueue(new Uint8Array(4096).fill(65));
    },
  });
  const r = await head(
    new Response(big, { headers: { 'content-type': 'text/plain', date: DATE } }),
  );
  assert.equal(r.result.ok, true);
  assert.equal(r.result.complete, false);
  assert.equal(r.result.text.length, HEAD_BYTES);
  assert.ok(pulled < 10, `${pulled} chunks pulled`);
});

test('the text is Latin-1, a non-text answer is refused', async () => {
  const r = await head(
    new Response(Buffer.from([0x23, 0xe9]), {
      headers: { 'content-type': 'text/plain; charset=ISO-8859-1', date: DATE },
    }),
  );
  assert.equal(r.result.text, '#é');
  for (const type of ['text/html', 'application/json', '']) {
    const bad = await head(new Response('x', { headers: { 'content-type': type, date: DATE } }));
    assert.equal(bad.result.kind, 'format', type);
  }
});

test('statuses: 304 (only to our ETag), 404/410, 429, 5xx, others', async () => {
  const answer = (status, headers = {}) =>
    new Response(status === 304 ? null : 'x', { status, headers: { date: DATE, ...headers } });
  let r = await head(answer(304), { etag: '"a"' });
  assert.deepEqual(r.result, {
    ok: true,
    notModified: true,
    serverDate: at('2026-10-30T06:08:00Z'),
  });
  assert.equal(r.calls[0].init.headers['If-None-Match'], '"a"');
  r = await head(answer(304));
  assert.equal(r.result.kind, 'format');
  assert.equal(r.calls[0].init.headers['If-None-Match'], undefined);
  for (const [status, kind] of [
    [404, 'missing'],
    [410, 'missing'],
    [429, 'rate'],
    [500, 'server'],
    [503, 'server'],
    [403, 'http'],
    [416, 'http'],
    [301, 'http'],
  ]) {
    r = await head(answer(status));
    assert.equal(r.result.kind, kind, String(status));
    assert.equal(r.result.status, status);
  }
  r = await head(answer(429, { 'retry-after': '120' }));
  assert.equal(r.result.retryAfter, 120000);
  r = await head(answer(503, { 'retry-after': 'Fri, 30 Oct 2026 06:10:00 GMT' }));
  assert.equal(r.result.retryAfter, 120000);
});

test('the ETag is kept only when well formed', async () => {
  for (const [etag, expected] of [
    ['"9492c-65f085ffa953f"', '"9492c-65f085ffa953f"'],
    ['W/"x"', 'W/"x"'],
    ['nope', null],
    ['"a\r\nX: y"', null],
    [`"${'a'.repeat(300)}"`, null],
  ]) {
    const headers = { 'content-type': 'text/plain', date: DATE };
    const response = new Response('x', { headers });
    Object.defineProperty(response, 'headers', {
      value: new Map([...Object.entries(headers), ['etag', etag]]),
    });
    response.headers.get = Map.prototype.get.bind(response.headers);
    const r = await head(response);
    assert.equal(r.result.etag, expected, etag);
  }
});

test('network failure, timeout (the whole request, body included), never a throw', async () => {
  let r = await head(() => Promise.reject(new TypeError('fetch failed')));
  assert.deepEqual(r.result, { ok: false, kind: 'network', serverDate: null });
  // A body that never ends: the timer aborts it.
  const timers = fakeTimers();
  const stuck = new ReadableStream({ pull: () => new Promise(() => {}) });
  const pending = getStationHead('https://x/a.txt', {
    timers,
    fetchImpl: async (url, init) => {
      const response = new Response(stuck, {
        headers: { 'content-type': 'text/plain', date: DATE },
      });
      init.signal.addEventListener('abort', () => stuck.cancel().catch(() => {}));
      return response;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  timers.fire();
  r = { result: await pending };
  assert.equal(r.result.ok, false);
  assert.ok(['timeout', 'network'].includes(r.result.kind));
  // No answer at all: the abort rejects the fetch.
  const timers2 = fakeTimers();
  const pending2 = getStationHead('https://x/a.txt', {
    timers: timers2,
    fetchImpl: (url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))),
      ),
  });
  timers2.fire();
  assert.deepEqual(await pending2, { ok: false, kind: 'timeout', serverDate: null });
});

test('HTTP dates and Retry-After are read strictly', () => {
  assert.equal(readHttpDate(DATE), at('2026-10-30T06:08:00Z'));
  for (const bad of [
    null,
    '',
    'Fri, 31 Feb 2026 06:08:00 GMT',
    'Fri, 30 Oct 2026 06:08:00 UTC',
    '2026-10-30T06:08:00Z',
    'Fri, 30 Oct 2026 25:08:00 GMT',
    'Fri, 30 Oct 2026 06:60:00 GMT',
    'Fri, 30 Oct 2026 06:08:60 GMT',
    'Fri, 00 Oct 2026 06:08:00 GMT',
  ]) {
    assert.equal(readHttpDate(bad), null, String(bad));
  }
  assert.equal(readRetryAfter('60', null), 60000);
  // A huge value is a long pause (capped by the app), never ignored.
  assert.equal(readRetryAfter('99999999999999', null), 1e12);
  assert.equal(readRetryAfter('-5', null), null);
  assert.equal(readRetryAfter('1.5', null), null);
  assert.equal(readRetryAfter('Fri, 30 Oct 2026 06:00:00 GMT', at('2026-10-30T06:08:00Z')), 0);
  assert.equal(readRetryAfter('Fri, 30 Oct 2026 06:10:00 GMT', null), null);
  assert.equal(readRetryAfter(undefined, null), null);
});

test('a year below 100 stays itself (never read as 19xx)', () => {
  const good = line(at('2026-10-30T05:00Z'), { WTMP: 9 });
  const row = `0099 10 30 05 00 ${good.split(' ').slice(5).join(' ')}`;
  const p = parseRealtime(file(row), true);
  const expected = new Date(0);
  expected.setUTCFullYear(99, 9, 30);
  expected.setUTCHours(5, 0, 0, 0);
  assert.equal(p.rows[0].at, expected.getTime());
  assert.ok(p.rows[0].at < Date.UTC(1900, 0, 1));
});

test('a cached copy: the time of the answer is Date + Age (bounded to a day)', async () => {
  const headers = (extra) => ({ 'content-type': 'text/plain', date: DATE, ...extra });
  let r = await head(new Response('x', { headers: headers({ age: '576' }) }));
  assert.equal(r.result.serverDate, at('2026-10-30T06:08:00Z') + 576000);
  r = await head(new Response(null, { status: 304, headers: { date: DATE, age: '60' } }), {
    etag: '"a"',
  });
  assert.equal(r.result.serverDate, at('2026-10-30T06:09:00Z'));
  // A Retry-After date stays relative to the Date of the answer.
  r = await head(
    new Response('x', {
      status: 429,
      headers: { date: DATE, age: '60', 'retry-after': 'Fri, 30 Oct 2026 06:10:00 GMT' },
    }),
  );
  assert.equal(r.result.retryAfter, 120000);
  assert.equal(readAge('0'), 0);
  assert.equal(readAge(' 30 '), 30000);
  assert.equal(readAge('999999'), 86400000);
  for (const bad of [null, '', '-5', '1.5', 'abc', '12345678901'])
    assert.equal(readAge(bad), 0, String(bad));
});

test('a wave period of 0 s is "not available", never a measure', () => {
  const t = at('2026-10-30T05:00Z');
  const p = parseRealtime(file(line(t, { WVHT: 0.5, DPD: 0, APD: '0.0' })), true);
  assert.deepEqual(p.rows[0].values, { 'wave-height': 0.5 });
  const q = parseRealtime(file(line(t, { DPD: 0.1, APD: 3 })), true);
  assert.deepEqual(q.rows[0].values, { 'dominant-wave-period': 0.1, 'average-wave-period': 3 });
});

test('-0.0 in a file is published as 0, never -0', () => {
  const p = parseRealtime(
    file(line(at('2026-10-30T05:00Z'), { PTDY: '-0.0', TIDE: '-0.001' })),
    true,
  );
  assert.ok(Object.is(p.rows[0].values['pressure-tendency'], 0));
  assert.ok(Object.is(p.rows[0].values.tide, 0));
});
