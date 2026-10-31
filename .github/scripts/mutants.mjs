// -----------------------------------------------------------------------------
// Mutation check of the guards (reviews r1 to r3 of lot 19, then r4): each
// mutant breaks one guard of src/ in a throwaway copy of the repository, and
// the tests must fail on it. One mutant at a time; from the repository root,
// under a memory cap (a runaway mutant must not fill the RAM):
//
//   memcap node .github/scripts/mutants.mjs [part of a mutant name]
//
// Prints KILLED, SURVIVED, EQUIVALENT (survives, with the reason it cannot
// be told apart) or ERROR per mutant. Exit code 1 when a mutant not listed as
// equivalent survives, or when a pattern is no longer found exactly once
// (update it with the code). The copies (no .git, node_modules linked) live
// in one mkdtemp directory, removed at the end; the repository itself is
// never touched. A surviving guard is killed by a test, never by removing
// the guard.
// -----------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const A = 'src/app.js';
const N = 'src/ndbc.js';
const C = 'src/constants.js';
const M = 'src/model.js';
const CF = 'src/config.js';
const S = 'src/store.js';
const TESTS = readdirSync(join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => `test/${name}`);
/** The fast tests (virtual clock); `{ all: true }` adds the real-clock ones. */
const UNIT = TESTS.filter((name) => !name.includes('realclock'));

// [name, file, from (found exactly once), to, { all, equivalent }]
const MUTANTS = [
  [
    'content-type unchecked',
    N,
    "if (!/^text\\/plain\\b/i.test(type.trim()))\n      return { ok: false, kind: 'format', status, serverDate };",
    '',
  ],
  ['range header removed', N, '    Range: `bytes=0-${HEAD_BYTES - 1}`,\n', '', { all: true }],
  ['if-none-match removed', N, "if (etag) headers['If-None-Match'] = etag;", '', { all: true }],
  ['accept-encoding identity removed', N, "    'Accept-Encoding': 'identity',\n", ''],
  [
    'UA browser-like',
    C,
    '`gladys-ndbc/${pkg.version} (+https://github.com/LM1LC3N7/gladys-ndbc)`',
    "'Mozilla/5.0'",
  ],
  ['redirect follow', N, "redirect: 'error'", "redirect: 'follow'"],
  [
    '304 without etag accepted',
    N,
    "return etag\n        ? { ok: true, notModified: true, serverDate }\n        : { ok: false, kind: 'format', status, serverDate };",
    'return { ok: true, notModified: true, serverDate };',
  ],
  ['content-range start not checked', N, 'bytes 0-(\\d{1,12})', 'bytes (\\d+)-(\\d{1,12})'],
  ['partial last line kept', N, 'if (!complete) lines.pop();', ''],
  ['unit check removed', N, 'if (units[index] !== variable.unit) {', 'if (false) {'],
  ['MM -> not skipped', N, "if (cell === 'MM') continue;", ''],
  ['range check removed', N, 'if (value < variable.min || value > variable.max) continue;', ''],
  ['integer check removed', N, 'if (variable.integer && !Number.isInteger(value)) continue;', ''],
  [
    'half-unreadable guard removed',
    N,
    'if (unreadable > 0 && unreadable * 2 > rows.length + unreadable) {',
    'if (false) {',
  ],
  ['strict number removed', N, 'if (!NUMBER.test(cell)) return null;', ''],
  ['vis factor', C, 'factor: 1.852', 'factor: 1.85'],
  ['tide factor', C, 'factor: 0.3048', 'factor: 0.3'],
  [
    'wspd min',
    C,
    "{ column: 'WSPD', unit: 'm/s', key: 'wind-speed', min: 0, max: 98 }",
    "{ column: 'WSPD', unit: 'm/s', key: 'wind-speed', min: 0, max: 99 }",
  ],
  ['pres fill 9999 allowed', C, 'min: 800, max: 1100', 'min: 800, max: 9999'],
  ['wtmp fill 999 allowed', C, 'min: -5, max: 45', 'min: -5, max: 999'],
  [
    'wdir 999 allowed',
    C,
    "key: 'wind-direction', min: 0, max: 360",
    "key: 'wind-direction', min: 0, max: 999",
  ],
  [
    'server date: null accepted as now',
    A,
    'if (at === null || at === undefined) return null;',
    'if (at === null || at === undefined) return this.now();',
  ],
  ['date sanity removed', A, 'if (Math.abs(at - this.now()) > DATE_SANITY) {', 'if (false) {'],
  [
    'age vs local clock',
    A,
    'return result.serverDate - at + (mono - result.readMono);',
    'return this.now() - at;',
  ],
  [
    'age ignores time since read',
    A,
    'return result.serverDate - at + (mono - result.readMono);',
    'return result.serverDate - at;',
  ],
  [
    '2h age guard (publish) removed',
    A,
    'if (this.ageOf(result, value.at, mono) > MAX_AGE) continue;',
    '',
  ],
  [
    '2h age guard (freshness) removed',
    A,
    'if (age > MAX_AGE) continue;\n      fresh += 1;',
    'fresh += 1;',
  ],
  [
    'dedup same observation <= -> <',
    A,
    'if (stamp !== undefined && value.at <= stamp) continue;',
    'if (stamp !== undefined && value.at < stamp) continue;',
  ],
  ['dedup removed', A, 'if (stamp !== undefined && value.at <= stamp) continue;', ''],
  [
    'stamp rollback on refusal removed',
    A,
    'if (previous[item.key] === undefined) delete entry.stamps[item.key];\n          else entry.stamps[item.key] = previous[item.key];',
    '',
  ],
  ['future line filter removed', M, '.filter((row) => row.at <= serverDate + FUTURE_SLACK)', ''],
  [
    'dup time filter removed',
    M,
    '.filter((row) => (seen.has(row.at) ? false : seen.add(row.at)))',
    '',
  ],
  [
    'future stamp accepted at load',
    A,
    'if (isTime(at) && at <= wall + DATE_SANITY) stamps[key] = at;',
    'if (isTime(at)) stamps[key] = at;',
  ],
  ['request gap 3s -> 1s', C, 'REQUEST_GAP = 3 * SECOND', 'REQUEST_GAP = 1 * SECOND'],
  [
    'one-at-a-time inflight wait removed',
    A,
    'if (this.inflight) {\n        await this.inflight;\n        continue;\n      }',
    '',
  ],
  [
    'pause held check in request removed',
    A,
    "if (this.pausedFor() > 0) return { ok: false, kind: 'paused' };",
    '',
  ],
  ['429 pause 5 -> 1 min', C, 'PAUSE_429_FIRST = 5 * MINUTE', 'PAUSE_429_FIRST = 1 * MINUTE'],
  ['5xx pause 2 -> 1 min', C, 'PAUSE_5XX_FIRST = 2 * MINUTE', 'PAUSE_5XX_FIRST = 1 * MINUTE'],
  ['pause cap 6h -> 60h', C, 'PAUSE_MAX = 6 * HOUR', 'PAUSE_MAX = 60 * HOUR'],
  [
    '429 doubling removed',
    A,
    'duration = PAUSE_429_FIRST * 2 ** (pause.level429 - 1);',
    'duration = PAUSE_429_FIRST;',
  ],
  [
    '5xx doubling removed',
    A,
    'duration = PAUSE_5XX_FIRST * 2 ** (pause.level5xx - 1);',
    'duration = PAUSE_5XX_FIRST;',
  ],
  [
    'http doubling removed',
    A,
    'duration = PAUSE_5XX_FIRST * 2 ** (pause.levelHttp - 1);',
    'duration = PAUSE_5XX_FIRST;',
  ],
  [
    'retry-after ignored',
    A,
    'if (Number.isFinite(result.retryAfter) && result.retryAfter > duration)\n      duration = result.retryAfter;',
    '',
  ],
  // Two copies of the reset (round and keepLate): one mutant each.
  [
    'round: success keeps persisted pause levels',
    A,
    '        if (this.persisted.pause) this.persisted.pause = NO_PAUSE();\n        this.results.set(id, result);\n        await this.publishStation(id, gen);\n        if (gen',
    '        this.results.set(id, result);\n        await this.publishStation(id, gen);\n        if (gen',
  ],
  [
    'round: success keeps pauseUntilMono',
    A,
    '        this.pauseUntilMono = null;\n        if (this.persisted.pause) this.persisted.pause = NO_PAUSE();\n        this.results.set(id, result);\n        await this.publishStation(id, gen);\n        if (gen',
    '        if (this.persisted.pause) this.persisted.pause = NO_PAUSE();\n        this.results.set(id, result);\n        await this.publishStation(id, gen);\n        if (gen',
    {
      equivalent:
        'one request at a time: a success never arrives during a pause, so pauseUntilMono is already null or past',
    },
  ],
  [
    'pause not persisted from /data',
    A,
    'if (pause && isTime(pause.until) && pause.until > wall && pause.until - wall <= PAUSE_MAX) {',
    'if (false) {',
  ],
  ['404 first 1h -> 1min', C, 'MISSING_FIRST = HOUR', 'MISSING_FIRST = MINUTE'],
  [
    'early timer re-arm removed',
    A,
    'if (left > 0) {\n      this.scheduleCycle(left + EARLY, gen);\n      return;\n    }',
    '',
  ],
  [
    'status connected always',
    A,
    'return { connected: anyFresh, message, staleAt };',
    'return { connected: true, message, staleAt };',
  ],
  [
    'status stale timer removed',
    A,
    'if (staleAt !== null) {\n      const delay',
    'if (false) {\n      const delay',
  ],
  ['connected on stale last ok', A, 'if (data.fresh) anyFresh = true;', 'anyFresh = true;'],
  [
    'STORE_BOUND 2s -> 20 min',
    A,
    'const STORE_BOUND = 2 * SECOND;',
    'const STORE_BOUND = 20 * 60 * SECOND;',
  ],
  [
    'attempt time not written before request',
    A,
    'this.persisted.lastAttemptAt = this.now();\n    const saved = await this.persist();',
    'this.persisted.lastAttemptAt = this.now();\n    const saved = true;',
  ],
  [
    'restart: last attempt ignored',
    A,
    '} else if (isTime(last)) {\n      wait = Math.max(0, last + gap - wall);\n    }',
    '}',
  ],
  ['dataTells guard removed', A, '} else if (!this.dataTells) {', '} else if (false) {'],
  [
    'future lastAttempt believed',
    A,
    'else if (isTime(last) && last > this.now()) {',
    'else if (false) {',
  ],
  [
    'states/min budget removed',
    A,
    'const allowed = Math.max(0, Math.min(count, STATES_PER_MINUTE - this.sent.length));',
    'const allowed = count;',
  ],
  [
    'getConfig retry removed (return)',
    A,
    'await this.sleep(delay);\n        if (conn !== this.connGen) return;\n        delay = Math.min(delay * 2, CONFIG_RETRY_MAX);\n        continue;',
    'return;',
  ],
  ['config retry cap', C, 'CONFIG_RETRY_MAX = 5 * MINUTE', 'CONFIG_RETRY_MAX = 5 * 1000'],
  ['refresh min 10 -> 1', C, 'REFRESH_MIN = 10', 'REFRESH_MIN = 1'],
  ['refresh max 180 -> 99999', C, 'REFRESH_MAX = 180', 'REFRESH_MAX = 99999'],
  ['stations max 10 -> 100', C, 'STATIONS_MAX = 10', 'STATIONS_MAX = 100'],
  ['head bytes 16k -> 1M', C, 'HEAD_BYTES = 16 * 1024', 'HEAD_BYTES = 1024 * 1024'],
  ['MAX_LINES removed', N, 'const MAX_LINES = 400;', 'const MAX_LINES = 400000;'],
  [
    'store: non-file allowed',
    S,
    'if (!stats.isFile() || stats.size > MAX_STATE_BYTES)',
    'if (false)',
  ],
  ['store: rm tmp removed', S, 'await rm(tmp, { force: true, recursive: false });', ''],
  ['retry round removed (arm)', A, 'this.retry = { ids: failed, dueMono: due, level: next };', ''],
  [
    'retry during pause not clamped',
    A,
    'this.pausedFor(mono) > 0 ? this.pauseUntilMono : mono + RETRY_FIRST * 2 ** (next - 1);',
    'mono + RETRY_FIRST * 2 ** (next - 1);',
    { equivalent: 'the next read waits for the end of the pause anyway (leftBefore)' },
  ],

  [
    '404 doubling removed',
    A,
    'duration = Math.min(MISSING_MAX, MISSING_FIRST * 2 ** (back.level - 1));',
    'duration = MISSING_FIRST;',
  ],
  [
    'backed-off station not skipped in a full round',
    A,
    'if (back && back.untilMono > this.monotonic()) continue;',
    '',
  ],
  [
    'unchanged config reads at once (gap = CHANGE_GAP)',
    A,
    'const gap = config.refreshMinutes * MINUTE;',
    'const gap = CHANGE_GAP;',
  ],
  [
    'station id regex loosened',
    CF,
    'export const STATION_ID = /^[A-Z0-9]{4,5}$/;',
    'export const STATION_ID = /^.*$/;',
  ],
  ['station id 3 chars allowed', CF, '{4,5}$/;', '{3,5}$/;'],
  ['station id 6 chars allowed', CF, '{4,5}$/;', '{4,6}$/;'],
  ['status truncation removed', A, "return [...text].slice(0, max).join('');", 'return text;'],
  ['status: no short form', A, 'if ([...text].length > max) text = join([...head, ...short]);', ''],
  [
    'status: station lines first',
    A,
    'let text = join([...head, ...long]);',
    'let text = join([...long, ...head]);',
  ],
  // r2: per-station back-off
  [
    '429 no longer pauses',
    A,
    "if (!result.ok && result.kind === 'rate') this.startPause(result);\n      return result;",
    'return result;',
  ],
  [
    '5xx/http pause every read again (r1 behaviour)',
    A,
    "if (!result.ok && result.kind === 'rate') this.startPause(result);\n      return result;",
    "if (!result.ok && ['rate', 'server', 'http'].includes(result.kind)) this.startPause(result);\n      return result;",
  ],
  [
    'all-failed round does not pause',
    A,
    'if (!only && read > 0 && refused) this.startPause(refused);',
    '',
  ],
  [
    'global pause although a station was ok (sticky false removed)',
    A,
    'if (refused !== false) refused = result;',
    'refused = result;',
  ],
  [
    'global pause although a station was 404/network',
    A,
    "} else if (result.kind !== 'paused') refused = false;",
    '}',
  ],
  [
    'read>0 -> read>=0',
    A,
    'if (!only && read > 0 && refused)',
    'if (!only && read >= 0 && refused)',
    { equivalent: '`refused` is only set after a read went' },
  ],
  [
    'paused/stopped counted as read',
    A,
    "if (result.kind !== 'paused' && result.kind !== 'stopped') read += 1;",
    'read += 1;',
    { equivalent: '`refused` is only set after a read went' },
  ],
  [
    'backoff 5xx doubling removed',
    A,
    'duration = PAUSE_5XX_FIRST * 2 ** (back.level - 1);',
    'duration = PAUSE_5XX_FIRST;',
  ],
  [
    'backoff 5xx first 2 -> 1 min (uses PAUSE_MIN)',
    A,
    'duration = PAUSE_5XX_FIRST * 2 ** (back.level - 1);',
    'duration = PAUSE_MIN * 2 ** (back.level - 1);',
  ],
  [
    'backoff Retry-After ignored',
    A,
    'if (Number.isFinite(result.retryAfter) && result.retryAfter > duration) {\n        duration = result.retryAfter;\n      }\n      duration = Math.min(PAUSE_MAX, duration);',
    'duration = Math.min(PAUSE_MAX, duration);',
  ],
  [
    'backoff cap 6 h removed',
    A,
    '      duration = Math.min(PAUSE_MAX, duration);\n    }\n    back.status',
    '    }\n    back.status',
  ],
  [
    'backoff level kept across kinds',
    A,
    'level: before?.kind === result.kind ? before.level : 0',
    'level: before?.level ?? 0',
  ],
  [
    'backoff own timer removed (leftBefore)',
    A,
    'if (id !== this.inflightId) next = Math.min(next, back.untilMono - mono);',
    '',
  ],
  [
    'backoff ended not read (dueStations)',
    A,
    'for (const [id, back] of this.backoff) if (back.untilMono <= mono) ids.add(id);',
    '',
  ],
  [
    'backoff kept after another failure kind',
    A,
    "else if (result.kind !== 'paused') this.backoff.delete(id);",
    '',
  ],
  [
    'backoff kept after a success',
    A,
    'this.backoff.delete(id);\n        refused = false;',
    'refused = false;',
  ],
  [
    'BACKED_OFF without 5xx/http',
    A,
    "const BACKED_OFF = ['missing', 'server', 'http'];",
    "const BACKED_OFF = ['missing'];",
  ],
  [
    'BACKED_OFF without 404',
    A,
    "const BACKED_OFF = ['missing', 'server', 'http'];",
    "const BACKED_OFF = ['server', 'http'];",
  ],
  [
    '5xx also retried (RETRIED + server)',
    A,
    "const RETRIED = ['network', 'timeout', 'rate', 'paused'];",
    "const RETRIED = ['network', 'timeout', 'rate', 'paused', 'server'];",
  ],
  [
    'network not retried',
    A,
    "const RETRIED = ['network', 'timeout', 'rate', 'paused'];",
    "const RETRIED = ['timeout', 'rate', 'paused'];",
  ],
  ['added: no CHANGE_GAP', A, 'Math.max(mono, this.lastAddedMono + CHANGE_GAP)', 'mono'],
  [
    'added: whole list read',
    A,
    'config.stations.filter((id) => !this.lastStations.includes(id))',
    '[...config.stations]',
  ],
  [
    'added: lastAddedMono not set',
    A,
    'this.added = null;\n      this.lastAddedMono = mono;',
    'this.added = null;',
  ],
  [
    'added: not cleared by a full round',
    A,
    'this.nextDueMono = start + config.refreshMinutes * MINUTE;\n      this.added = null;',
    'this.nextDueMono = start + config.refreshMinutes * MINUTE;',
  ],
  [
    'retry kept after a full round',
    A,
    'if (!only || (this.retry && this.retry.dueMono <= start)) this.retry = null;',
    'if (only && this.retry && this.retry.dueMono <= start) this.retry = null;',
  ],
  ['retry merge removed', A, 'for (const id of failed) this.retry.ids.add(id);\n      return;', ''],
  // r2: Age, positive periods, -0
  ['Age ignored', N, "date === null ? null : date + readAge(response.headers.get('age'))", 'date'],
  [
    'Age uncapped',
    N,
    'Math.min(Number(value.trim()), 86400) * 1000',
    'Number(value.trim()) * 1000',
  ],
  [
    'Age junk accepted (NaN)',
    N,
    "if (typeof value !== 'string' || !/^\\d{1,10}$/.test(value.trim())) return 0;",
    "if (typeof value !== 'string') return 0;",
  ],
  [
    'Retry-After date vs Date+Age',
    N,
    "readRetryAfter(response.headers.get('retry-after'), date)",
    "readRetryAfter(response.headers.get('retry-after'), serverDate)",
  ],
  ['positive periods: 0 allowed', N, 'if (variable.positive && value <= 0) continue;', ''],
  [
    '-0 kept (no +0)',
    N,
    'if (!variable.factor) return value + 0;',
    'if (!variable.factor) return value;',
  ],
  [
    'positive flag DPD dropped',
    C,
    "key: 'dominant-wave-period', min: 0, max: 60, positive: true",
    "key: 'dominant-wave-period', min: 0, max: 60",
  ],
  [
    'positive flag APD dropped',
    C,
    "key: 'average-wave-period', min: 0, max: 60, positive: true",
    "key: 'average-wave-period', min: 0, max: 60",
  ],
  // r3: keepLate and the interrupted-round path
  [
    'keepLate: kept after a stop',
    A,
    'if (this.stopped || !this.config?.stations.includes(id)) return false;',
    'if (!this.config?.stations.includes(id)) return false;',
  ],
  [
    'keepLate: kept for a removed station',
    A,
    'if (this.stopped || !this.config?.stations.includes(id)) return false;',
    'if (this.stopped) return false;',
  ],
  [
    'keepLate: backoff not cleared on success',
    A,
    'if (result.ok) {\n      this.backoff.delete(id);\n      this.pauseUntilMono = null;',
    'if (result.ok) {\n      this.pauseUntilMono = null;',
  ],
  [
    'keepLate: pauseUntilMono not reset on success',
    A,
    'if (result.ok) {\n      this.backoff.delete(id);\n      this.pauseUntilMono = null;',
    'if (result.ok) {\n      this.backoff.delete(id);',
    {
      equivalent:
        'one request at a time: a success never arrives during a pause, so pauseUntilMono is already null or past',
    },
  ],
  [
    'keepLate: persisted pause not reset on success',
    A,
    'this.persisted.pause = NO_PAUSE();\n      this.results.set(id, result);\n      await this.publishStation(id, gen);\n      return true;',
    'this.results.set(id, result);\n      await this.publishStation(id, gen);\n      return true;',
  ],
  [
    'keepLate: result not stored',
    A,
    'this.results.set(id, result);\n      await this.publishStation(id, gen);\n      return true;',
    'await this.publishStation(id, gen);\n      return true;',
  ],
  [
    'keepLate: values not published',
    A,
    'this.results.set(id, result);\n      await this.publishStation(id, gen);\n      return true;',
    'this.results.set(id, result);\n      return true;',
  ],
  ['keepLate: 429 not persisted', A, "if (result.kind === 'rate') await this.persist();", ''],
  [
    'keepLate: no back-off started',
    A,
    'if (BACKED_OFF.includes(result.kind)) this.startBackoff(id, result);\n    else if',
    'if (false) this.startBackoff(id, result);\n    else if',
  ],
  [
    'keepLate: no retry armed',
    A,
    'else if (RETRIED.includes(result.kind)) this.armRetry(new Set([id]), 0, this.monotonic());',
    '',
  ],
  [
    'keepLate: failure not recorded',
    A,
    'this.recordFailure(id, result);\n    return true;',
    'return true;',
  ],
  [
    'keepLate: failure answer not kept (returns false)',
    A,
    'this.recordFailure(id, result);\n    return true;',
    'this.recordFailure(id, result);\n    return false;',
  ],
  [
    'keepLate: success answer not kept (returns false)',
    A,
    'await this.publishStation(id, gen);\n      return true;',
    'await this.publishStation(id, gen);\n      return false;',
  ],
  [
    'round: unsent request counted as kept',
    A,
    "const sent = result.kind !== 'paused' && result.kind !== 'stopped';",
    'const sent = true;',
  ],
  [
    'round: unread from the wrong index (kept)',
    A,
    'this.leaveUnread(ids.slice(kept ? index + 1 : index));',
    'this.leaveUnread(ids.slice(index + 1));',
  ],
  [
    'round: unread from the wrong index (not kept)',
    A,
    'this.leaveUnread(ids.slice(kept ? index + 1 : index));',
    'this.leaveUnread(ids.slice(index));',
  ],
  [
    'round: interrupted by a save at the start: stations not left unread',
    A,
    'if (gen !== this.gen) {\n      this.leaveUnread(ids);\n      return;\n    }',
    'if (gen !== this.gen) return;',
  ],
  [
    'round: interrupted after publish: rest not left unread',
    A,
    'if (gen !== this.gen) {\n          this.leaveUnread(ids.slice(index + 1));\n          return;\n        }',
    'if (gen !== this.gen) return;',
  ],
  [
    'round: a retry round reads every station',
    A,
    'const ids = config.stations.filter((id) => !only || only.has(id));',
    'const ids = [...config.stations];',
  ],
  ['leaveUnread: stations not recorded', A, 'for (const id of ids) this.unread.add(id);', ''],
  [
    'leaveUnread: timer not re-armed',
    A,
    'if (this.cycleTimer && this.config) {\n      this.scheduleCycle(this.leftBefore(this.monotonic()), this.gen);\n    }',
    '',
  ],
  [
    'leftBefore: unread not due at once',
    A,
    'if (this.unread.size > 0) next = Math.min(next, 0);',
    '',
  ],
  [
    'dueStations: unread not read',
    A,
    'for (const id of this.unread) ids.add(id);\n    this.unread.clear();',
    'this.unread.clear();',
  ],
  [
    'dueStations: unread kept (read every time)',
    A,
    'for (const id of this.unread) ids.add(id);\n    this.unread.clear();',
    'for (const id of this.unread) ids.add(id);',
  ],
  [
    'full round: unread not cleared',
    A,
    'this.added = null;\n      this.unread.clear();',
    'this.added = null;',
    {
      equivalent:
        'each station whose request goes leaves the unread list; one backed off would only start one more round that skips it',
    },
  ],
  [
    'applyConfig: unread of removed stations kept',
    A,
    'for (const id of [...this.unread]) if (!config.stations.includes(id)) this.unread.delete(id);',
    '',
    {
      equivalent:
        'a removed id is filtered out of the round (config.stations): at most one empty round',
    },
  ],
  ['stop: stopped flag not set', A, 'this.gen += 1;\n    this.stopped = true;', 'this.gen += 1;'],
  [
    'applyConfig: stopped flag not cleared',
    A,
    'this.gen += 1;\n    this.stopped = false;',
    'this.gen += 1;',
  ],
  // Equivalents known since r1 (guards kept, said in TODO.md)
  [
    'checkData: frozen /data checked by a save',
    A,
    "if (this.storeStatus !== 'ok' && this.storeStatus !== 'absent') this.dataTells = false;",
    "if (this.storeStatus === 'unreadable') this.dataTells = false;",
    { equivalent: 'persist() refuses a frozen /data: dataTells is false either way' },
  ],
  [
    'store: temporary file without wx',
    S,
    "{ encoding: 'utf8', flag: 'wx' }",
    "{ encoding: 'utf8' }",
    {
      equivalent:
        'the temporary file was removed just before; wx only matters for a race in between',
    },
  ],
  [
    'round: pause check of the loop removed',
    A,
    "if (this.pausedFor() > 0) {\n        this.recordFailure(id, { kind: 'paused' });\n        failed.add(id);\n        continue;\n      }",
    '',
    { equivalent: 'request() answers paused, handled the same way' },
  ],
  [
    'applyConfig: generation not checked after load',
    A,
    'await this.load();\n    if (gen !== this.gen) return;',
    'await this.load();',
    { equivalent: 'the check after publishDevices returns before anything else is done' },
  ],
  // r4: the status after a kept answer (M1), the station in flight (M2)
  ['M1: status not told after a kept answer', A, 'if (kept) await this.updateStatus(current);', ''],
  [
    'M1: status told for the generation running after a stop',
    A,
    'if (kept) await this.updateStatus(current);',
    'if (kept) await this.updateStatus(this.gen);',
  ],
  ['M2: station in flight due again (dueStations)', A, 'ids.delete(this.inflightId);', ''],
  [
    'M2: back-off of the station in flight counted (leftBefore)',
    A,
    'if (id !== this.inflightId) next = Math.min(next, back.untilMono - mono);',
    'next = Math.min(next, back.untilMono - mono);',
  ],
  ['M2: station in flight never set', A, 'this.inflightId = id;', ''],
  [
    'M2: station in flight never cleared',
    A,
    'this.inflight = null;\n      this.inflightId = null;',
    'this.inflight = null;',
  ],
  [
    'M2: readStation does not name the station',
    A,
    'last?.etag ?? null, gen, id);',
    'last?.etag ?? null, gen);',
  ],
  [
    'M2: station sent still left unread',
    A,
    'this.inflightId = id;\n    this.unread.delete(id);',
    'this.inflightId = id;',
  ],
  [
    'keepLate: back-off kept after another failure',
    A,
    'if (!BACKED_OFF.includes(result.kind)) this.backoff.delete(id);',
    '',
  ],
  [
    'keepLate: status gen captured after keepLate',
    A,
    'const current = this.gen;\n        const kept = sent && (await this.keepLate(id, result));',
    'const kept = sent && (await this.keepLate(id, result));\n        const current = this.gen;',
  ],
];

const only = process.argv[2];
const chosen = only ? MUTANTS.filter(([name]) => name.includes(only)) : MUTANTS;
const work = mkdtempSync(join(tmpdir(), 'ndbc-mutants-'));
const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
const counts = { KILLED: 0, SURVIVED: 0, EQUIVALENT: 0, ERROR: 0 };
const unexpected = [];

function run([, file, from, to, options = {}]) {
  const dir = mkdtempSync(join(work, 'm-'));
  try {
    cpSync(ROOT, dir, {
      recursive: true,
      filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
    });
    if (existsSync(join(ROOT, 'node_modules')))
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    const target = join(dir, file);
    const text = readFileSync(target, 'utf8');
    const found = text.split(from).length - 1;
    if (found !== 1) return { verdict: 'ERROR', detail: `${found} matches in ${file}` };
    writeFileSync(target, text.replace(from, to));
    const tests = options.all ? TESTS : UNIT;
    const child = spawnSync(process.execPath, ['--test', '--test-timeout=60000', ...tests], {
      cwd: dir,
      env,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (child.status !== 0) return { verdict: 'KILLED' };
    if (options.equivalent) return { verdict: 'EQUIVALENT', detail: options.equivalent };
    return { verdict: 'SURVIVED' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  for (const mutant of chosen) {
    const { verdict, detail } = run(mutant);
    counts[verdict] += 1;
    if (verdict === 'SURVIVED' || verdict === 'ERROR') unexpected.push(mutant[0]);
    console.log(`${verdict.padEnd(10)} ${mutant[0]}${detail ? `  (${detail})` : ''}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(
  `\n${chosen.length} mutants: ${counts.KILLED} killed, ${counts.EQUIVALENT} equivalent, ` +
    `${counts.SURVIVED} survived, ${counts.ERROR} errors`,
);
process.exitCode = unexpected.length > 0 ? 1 : 0;
