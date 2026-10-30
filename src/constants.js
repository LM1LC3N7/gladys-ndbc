// -----------------------------------------------------------------------------
// The fixed values of the integration: the NDBC realtime files, their pace,
// the bounds of what is read, the measured variables and the keys shared with
// the manifest.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The realtime files of the National Data Buoy Center (NOAA), public domain, no key. */
export const DATA_BASE = 'https://www.ndbc.noaa.gov/data/realtime2';

/** An honest User-Agent naming the integration, never a browser's. */
export const USER_AGENT = `gladys-ndbc/${pkg.version} (+https://github.com/LM1LC3N7/gladys-ndbc)`;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/**
 * One request at a time, 3 s at least between the starts of two (the
 * reference library, ndbc-api, waits 2 s between its requests).
 */
export const REQUEST_GAP = 3 * SECOND;
/** One request never lasts longer (connection, answer and body). */
export const REQUEST_TIMEOUT = 30 * SECOND;
/**
 * Only the head of a station file is read (newest observation first): a
 * `Range` of 16 KiB (about 180 lines, 15 h at 10-minute steps). A server that
 * ignores the range is cut there too: never more is read.
 */
export const HEAD_BYTES = 16 * 1024;

/** The read interval, in minutes (config `refresh_minutes`). */
export const REFRESH_DEFAULT = 30;
export const REFRESH_MIN = 10;
export const REFRESH_MAX = 180;
/** A saved configuration that changes the stations reads them at most once a minute. */
export const CHANGE_GAP = MINUTE;

/** Pauses after a 429 (rate limit) and a 5xx, doubled each time, bounded. */
export const PAUSE_429_FIRST = 5 * MINUTE;
export const PAUSE_5XX_FIRST = 2 * MINUTE;
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** A station whose read failed for a passing cause is read again after this, doubled. */
export const RETRY_FIRST = 2 * MINUTE;
/** A station without realtime file (404, 410) is tried again after this, doubled up to a day. */
export const MISSING_FIRST = HOUR;
export const MISSING_MAX = 24 * HOUR;

/** `getConfig()` failing on a connection: retried forever, spaced out. */
export const CONFIG_RETRY_FIRST = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/**
 * An observation older than this (against the `Date` of the answer) is never
 * published, and a station whose newest value is older is said silent.
 */
export const MAX_AGE = 2 * HOUR;
/** An observation dated further than this past the server time is not believed. */
export const FUTURE_SLACK = 5 * MINUTE;
/** A server `Date` further than this from the local clock is not believed. */
export const DATE_SANITY = 24 * HOUR;

/** Stations followed (one Gladys device each). */
export const STATIONS_MAX = 10;
/** Stations remembered in /data (dedup of the observations already published). */
export const KEPT_STATIONS_MAX = 50;

export const DEVICE_TYPE = 'station';

/**
 * The variables of a realtime2 `.txt` file (NDBC "Standard Meteorological
 * Data"), with the unit its second header line must show, the feature it
 * feeds, its conversion and its plausible range (outside: not a measure).
 * `positive`: 0 is "not available" (a wave period of 0 s with a wave height, as
 * some partner buoys send), never a measure. The ranges leave out the "9" fill values of the NDBC formats (99, 999,
 * 9999, read as missing by ndbc-api). Exact conversions: 1 nmi = 1.852 km, 1 ft = 0.3048 m.
 */
export const VARIABLES = Object.freeze([
  { column: 'WDIR', unit: 'degT', key: 'wind-direction', min: 0, max: 360, integer: true },
  { column: 'WSPD', unit: 'm/s', key: 'wind-speed', min: 0, max: 98 },
  { column: 'GST', unit: 'm/s', key: 'wind-gust', min: 0, max: 98 },
  { column: 'WVHT', unit: 'm', key: 'wave-height', min: 0, max: 40 },
  { column: 'DPD', unit: 'sec', key: 'dominant-wave-period', min: 0, max: 60, positive: true },
  { column: 'APD', unit: 'sec', key: 'average-wave-period', min: 0, max: 60, positive: true },
  { column: 'MWD', unit: 'degT', key: 'wave-direction', min: 0, max: 360, integer: true },
  { column: 'PRES', unit: 'hPa', key: 'pressure', min: 800, max: 1100 },
  { column: 'ATMP', unit: 'degC', key: 'air-temperature', min: -70, max: 60 },
  { column: 'WTMP', unit: 'degC', key: 'water-temperature', min: -5, max: 45 },
  { column: 'DEWP', unit: 'degC', key: 'dew-point', min: -80, max: 50 },
  { column: 'VIS', unit: 'nmi', key: 'visibility', min: 0, max: 98, factor: 1.852, decimals: 2 },
  { column: 'PTDY', unit: 'hPa', key: 'pressure-tendency', min: -50, max: 50 },
  { column: 'TIDE', unit: 'ft', key: 'tide', min: -30, max: 30, factor: 0.3048, decimals: 3 },
]);
/** The date columns that open every line, in this order. */
export const DATE_COLUMNS = Object.freeze(['YY', 'MM', 'DD', 'hh', 'mm']);

export const ACTIONS = Object.freeze({ TEST: 'test' });

export const STATE_FILE = '/data/ndbc-state.json';
