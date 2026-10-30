// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted NDBC and a virtual clock
// (gladys-testkit `testClock`: each clock read moves 1 µs, timers fire only
// through `advance`). NDBC answers through a `world(url, api, call)`
// function: a text (200, or 206 for a range), a Response, 'timeout' (never
// answers), 'network' (refused), or a promise of one of them (a slow answer).
// The default world serves the real captures of test/fixtures by station id.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NdbcApp } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevices } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { settle, testClock } from '../kit/clock.mjs';

export const SELECTOR = 'ndbc';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Real heads of four station files, captured on 2026-10-30 around 06:08 UTC (trimmed to 30 lines). */
export const FIXTURES = Object.fromEntries(
  ['46026', '45132', 'PSBM1', '44025'].map((id) => [
    id,
    readFileSync(new URL(`../fixtures/${id}.txt`, import.meta.url), 'latin1'),
  ]),
);
/** The time of the capture. */
export const CAPTURED_AT = Date.parse('2026-10-30T06:08:00Z');

export const ONE = { stations: '46026' };
export const TWO = { stations: '46026, 45132' };

export const F = (id, key) => `ext:${SELECTOR}:station:${id}:${key}`;

export const HEADER =
  '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE\n' +
  '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft\n';

/** A data line of a realtime file at `ms` (UTC), from 14 values ('MM' by default). */
export function line(ms, values = {}) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  const cols = [
    'WDIR',
    'WSPD',
    'GST',
    'WVHT',
    'DPD',
    'APD',
    'MWD',
    'PRES',
    'ATMP',
    'WTMP',
    'DEWP',
    'VIS',
    'PTDY',
    'TIDE',
  ];
  return [
    d.getUTCFullYear(),
    two(d.getUTCMonth() + 1),
    two(d.getUTCDate()),
    two(d.getUTCHours()),
    two(d.getUTCMinutes()),
    ...cols.map((c) => (values[c] === undefined ? 'MM' : String(values[c]))),
  ].join(' ');
}

/** A whole realtime file from lines (newest first). */
export const file = (...lines) => `${HEADER}${lines.join('\n')}\n`;

export function text(body, { status = 200, date, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=ISO-8859-1',
      ...(date === null ? {} : { date: new Date(date).toUTCString() }),
      ...headers,
    },
  });
}

/** The answer of the server to a range request of `body` (206, or 200 when shorter). */
export function ranged(body, init, { date, etag } = {}) {
  const range = /bytes=0-(\d+)/.exec(init?.headers?.Range ?? '');
  const bytes = Buffer.from(body, 'latin1');
  const headers = etag ? { etag } : {};
  if (!range) return text(bytes, { date, headers });
  const end = Math.min(Number(range[1]), bytes.length - 1);
  return text(bytes.subarray(0, end + 1), {
    status: 206,
    date,
    headers: { ...headers, 'content-range': `bytes 0-${end}/${bytes.length}` },
  });
}

export function status(code, date, headers = {}) {
  return new Response('<html><body>error</body></html>', {
    status: code,
    headers: { 'content-type': 'text/html', date: new Date(date).toUTCString(), ...headers },
  });
}

const abortable = (signal, kind) =>
  new Promise((_, reject) => {
    if (kind === 'network') reject(new TypeError('fetch failed'));
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

export const stationOf = (url) => /\/([A-Z0-9]{5})\.txt$/.exec(url)?.[1] ?? null;

/** A scripted NDBC: every request is recorded with the virtual time. */
export function createApi(world = defaultWorld) {
  const api = { world, calls: [], open: 0, peak: 0, clock: null };
  api.fetch = async (url, init) => {
    const call = {
      url: String(url),
      init,
      at: api.clock.elapsed,
      wall: api.clock.wall(),
      id: stationOf(String(url)),
    };
    api.calls.push(call);
    api.open += 1;
    api.peak = Math.max(api.peak, api.open);
    try {
      const answer = await api.world(call.url, api, call);
      if (answer === 'timeout' || answer === 'network')
        return await abortable(init?.signal, answer);
      if (answer instanceof Response) return answer;
      return ranged(answer, init, { date: api.clock.wall() });
    } finally {
      api.open -= 1;
    }
  };
  return api;
}

/** The captures, by station id; any other id is a 404. */
export function defaultWorld(url, api, call) {
  const body = FIXTURES[call.id];
  if (!body) return status(404, api.clock.wall());
  return body;
}

/** The devices of a configuration as created by the user in Gladys. */
export function createdDevices(config) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevices(gladys, normalizeConfig(config));
}

export async function setup({
  config = ONE,
  devices,
  store = createMemoryStore(),
  api = createApi(),
  created = true,
  start = CAPTURED_AT,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: devices ?? (created ? createdDevices(config) : []),
  });
  await gladys.connect();
  const clock = testClock({ start });
  clock.wall = () => clock.now() + wall.offset;
  api.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new NdbcApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.wall(),
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: api.fetch,
  });
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  // The start is not awaited: a frozen /data resolves only through the clock.
  const begin = async (cfg = config) => {
    app.start(cfg);
    for (let i = 0; i < 5; i += 1) await wait(0);
  };
  /** Lets the timers armed meanwhile at the same time fire too. */
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await wait(0);
  };
  return { app, gladys, fake: gladys.fake, clock, store, api, wait, begin, flush, lines, wall };
}

/** The values published for a feature, in order. */
export const published = (fake, id) =>
  fake.states.filter((s) => s.device_feature_external_id === id).map((s) => s.state);

/** The status message (English) last sent. */
export const statusEn = (fake) => fake.connectionStatus?.message?.en ?? '';
