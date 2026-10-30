// -----------------------------------------------------------------------------
// The NDBC realtime files: one bounded GET of the head of a station file
// (`realtime2/<ID>.txt`, newest observation first), with an honest
// User-Agent, `Range` (only the head is needed), `If-None-Match` (the file
// unchanged since the last read answers 304), a bounded time and a bounded
// body; then a strict reading of the text into dated rows. Nothing here
// retries, waits or keeps state: the app paces the requests and decides.
//
// Format (https://www.ndbc.noaa.gov/faq/measdes.shtml, checked on the live
// files on 2026-10-30): two header lines, the column names then their units
// (`#YY  MM DD hh mm WDIR WSPD ...` / `#yr  mo dy hr mn degT m/s ...`), then
// one line per observation, newest first, times in UTC, values separated by
// spaces, `MM` for a missing value. The columns are found by their name and
// a column is used only if its unit is the expected one.
// -----------------------------------------------------------------------------

import {
  DATA_BASE,
  DATE_COLUMNS,
  HEAD_BYTES,
  REQUEST_TIMEOUT,
  USER_AGENT,
  VARIABLES,
} from './constants.js';

/** The URL of the realtime file of a station (ids are upper case on the server). */
export function stationUrl(id, base = DATA_BASE) {
  return `${base}/${id}.txt`;
}

/**
 * One GET of the head of a station file. Resolves
 * `{ ok: true, notModified: true, serverDate }` (304),
 * `{ ok: true, text, complete, etag, serverDate }`, or
 * `{ ok: false, kind, status?, retryAfter?, serverDate }`, `kind` among
 * `network`, `timeout`, `rate` (429), `server` (5xx), `missing` (404, 410),
 * `http` (other status), `format`. Never throws.
 */
export async function getStationHead(
  url,
  { etag = null, fetchImpl = fetch, timers = globalThis } = {},
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  const headers = {
    Accept: 'text/plain',
    'User-Agent': USER_AGENT,
    // Plain bytes: a range of a compressed body could not be decoded.
    'Accept-Encoding': 'identity',
    Range: `bytes=0-${HEAD_BYTES - 1}`,
  };
  if (etag) headers['If-None-Match'] = etag;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    timers.clearTimeout(timer);
    return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate: null };
  }
  const date = readHttpDate(response.headers.get('date'));
  // A copy served by the CDN carries the Date of the origin and its `Age`:
  // the time of the answer is Date + Age (seen live: Age up to 576 s).
  const serverDate = date === null ? null : date + readAge(response.headers.get('age'));
  try {
    const status = response.status;
    if (status === 304) {
      // Only an answer to our own If-None-Match means "unchanged".
      return etag
        ? { ok: true, notModified: true, serverDate }
        : { ok: false, kind: 'format', status, serverDate };
    }
    if (status === 429 || status >= 500) {
      return {
        ok: false,
        kind: status === 429 ? 'rate' : 'server',
        status,
        retryAfter: readRetryAfter(response.headers.get('retry-after'), date),
        serverDate,
      };
    }
    if (status === 404 || status === 410) return { ok: false, kind: 'missing', status, serverDate };
    if (status !== 200 && status !== 206) return { ok: false, kind: 'http', status, serverDate };
    const type = response.headers.get('content-type') ?? '';
    if (!/^text\/plain\b/i.test(type.trim()))
      return { ok: false, kind: 'format', status, serverDate };
    let total = null;
    if (status === 206) {
      const range = /^bytes 0-(\d{1,12})\/(\d{1,12}|\*)$/.exec(
        (response.headers.get('content-range') ?? '').trim(),
      );
      // A part that does not start at the beginning is not the head.
      if (!range) return { ok: false, kind: 'format', status, serverDate };
      const end = Number(range[1]);
      total = range[2] === '*' ? null : Number(range[2]);
      // The part holds the whole file only when it ends at its last byte.
      total = total !== null && end + 1 === total ? 'whole' : 'part';
    }
    const body = await readHead(response, controller.signal);
    const complete = status === 206 ? total === 'whole' && body.ended : body.ended;
    return {
      ok: true,
      text: body.buffer.toString('latin1'),
      complete,
      etag: readEtag(response.headers.get('etag')),
      serverDate,
    };
  } catch {
    return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate };
  } finally {
    timers.clearTimeout(timer);
    // A body left unread is released, never kept open.
    response.body?.cancel?.().catch?.(() => {});
  }
}

/**
 * The first HEAD_BYTES bytes of the body; `ended` when the body ended within
 * them. The rest is never read. Each read also ends with the abort of the
 * request (a body that stalls never outlives its timeout).
 */
async function readHead(response, signal) {
  if (!response.body) return { buffer: Buffer.alloc(0), ended: true };
  const reader = response.body.getReader();
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(new Error('aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return { buffer: Buffer.concat(chunks), ended: true };
      const chunk = Buffer.from(value);
      if (size + chunk.byteLength > HEAD_BYTES) {
        chunks.push(chunk.subarray(0, HEAD_BYTES - size));
        return { buffer: Buffer.concat(chunks), ended: false };
      }
      size += chunk.byteLength;
      chunks.push(chunk);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** A strong or weak entity tag, as sent back in If-None-Match; else null. */
function readEtag(value) {
  if (typeof value !== 'string') return null;
  const tag = value.trim();
  return /^(W\/)?"[\x21\x23-\x7e]{1,200}"$/.test(tag) ? tag : null;
}

/** An HTTP date (`Fri, 30 Oct 2026 05:58:50 GMT`) in ms, or `null`. */
export function readHttpDate(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^[A-Z][a-z]{2}, (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const month = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(match[2]) / 3;
  return utc(+match[3], month + 1, +match[1], +match[4], +match[5], +match[6]);
}

/** The `Age` of a cached answer in ms: whole seconds, at most a day; else 0. */
export function readAge(value) {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value.trim())) return 0;
  return Math.min(Number(value.trim()), 86400) * 1000;
}

/** Retry-After in ms (seconds or an HTTP date), bounded by the caller; else null. */
export function readRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // Any count of digits: a huge value is a long pause (capped by the app), never ignored.
  if (/^\d{1,30}$/.test(text)) return Math.min(Number(text), 1e9) * 1000;
  const at = readHttpDate(text);
  if (at === null || serverDate === null) return null;
  return Math.max(0, at - serverDate);
}

/** A strict UTC date from its fields, or `null` when one is out of range (30 February, 24:00). */
function utc(year, month, day, hour, minute, second = 0) {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  // setUTCFullYear: a year below 100 stays itself (Date.UTC would add 1900).
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCDate() !== day) return null;
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

const NUMBER = /^[-+]?\d{1,5}(\.\d{1,3})?$/;
const MAX_LINES = 400;

/**
 * The rows of a realtime file. `complete` false: the text was cut, its last
 * (partial) line is dropped. Resolves
 * `{ ok: true, rows: [{ at, values: { key: number } }], unreadable, units }`
 * (`units`: the variables whose column shows another unit than expected,
 * never used) or `{ ok: false, kind: 'format' | 'unreadable_rows' }`.
 * A value is a strict decimal inside the plausible range of its variable;
 * `MM`, a fill value (99, 999, 9999) or anything out of range is missing.
 */
export function parseRealtime(text, complete) {
  if (typeof text !== 'string') return { ok: false, kind: 'format' };
  const lines = text.split('\n');
  if (!complete) lines.pop();
  const [nameLine, unitLine] = lines;
  if (!nameLine?.startsWith('#') || !unitLine?.startsWith('#'))
    return { ok: false, kind: 'format' };
  const names = nameLine.slice(1).trim().split(/\s+/);
  const units = unitLine.slice(1).trim().split(/\s+/);
  if (names.length !== units.length || DATE_COLUMNS.some((column, i) => names[i] !== column)) {
    return { ok: false, kind: 'format' };
  }
  const columns = [];
  const otherUnits = [];
  for (const variable of VARIABLES) {
    const index = names.indexOf(variable.column);
    if (index < DATE_COLUMNS.length) continue;
    if (units[index] !== variable.unit) {
      otherUnits.push(variable.key);
      continue;
    }
    columns.push({ variable, index });
  }
  const rows = [];
  let unreadable = 0;
  for (const raw of lines.slice(2, 2 + MAX_LINES)) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    // A comment line among the data never passes the date check: unreadable.
    const row = readRow(line.trim().split(/\s+/), names.length, columns);
    if (row) rows.push(row);
    else unreadable += 1;
  }
  // More than half of the lines cannot be read: the format changed, nothing is used.
  if (unreadable > 0 && unreadable * 2 > rows.length + unreadable) {
    return { ok: false, kind: 'unreadable_rows' };
  }
  return { ok: true, rows, unreadable, units: otherUnits };
}

function readRow(cells, width, columns) {
  if (cells.length !== width) return null;
  const [y, mo, d, h, mi] = cells;
  if (!/^\d{4}$/.test(y) || ![mo, d, h, mi].every((c) => /^\d{2}$/.test(c))) return null;
  const at = utc(+y, +mo, +d, +h, +mi);
  if (at === null) return null;
  const values = {};
  for (const { variable, index } of columns) {
    const cell = cells[index];
    if (cell === 'MM') continue;
    // Anything else than MM or a plain decimal: the line is garbled.
    if (!NUMBER.test(cell)) return null;
    const value = Number(cell);
    if (variable.integer && !Number.isInteger(value)) continue;
    if (variable.positive && value <= 0) continue;
    if (value < variable.min || value > variable.max) continue;
    values[variable.key] = convert(variable, value);
  }
  return { at, values };
}

/**
 * The value in the unit published (exact factors, rounded to the precision of
 * the source); -0 (as `-0.0` in a file) is published as 0.
 */
export function convert(variable, value) {
  if (!variable.factor) return value + 0;
  const scale = 10 ** variable.decimals;
  return Math.round(value * variable.factor * scale) / scale + 0;
}
