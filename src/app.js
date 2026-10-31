// -----------------------------------------------------------------------------
// The integration: reads the realtime file of each NDBC station at the chosen
// interval, publishes the newest value of each variable once (never an
// observation older than 2 h, never the same one twice), and tells in the
// status exactly where each station stands.
//
// Pace and courtesy toward the source:
//   - one request at a time, 3 s at least between the starts of two;
//   - only the head of each file (`Range`, 16 KiB), `If-None-Match` when the
//     file was read in this process (304: nothing downloaded);
//   - the read period is measured from the start of a round, never shorter
//     than the interval: neither a restart (the time of the last attempt is in
//     /data, written before the round), nor a reconnection, a saved but
//     unchanged configuration, Discovery or the test button reads sooner; the
//     stations added to the configuration are read alone, at most once a minute;
//   - a 429 pauses every read (bounded, doubled, kept in /data); a 5xx or
//     another unexpected answer on one file backs that station off alone (2 min
//     doubled), and pauses every read only when every station of a round
//     failed so; a station without realtime file (404) is tried again after an
//     hour, doubled up to a day, each back-off on its own timer.
//
// Clocks: the decisions (gap, pause, period, age of a value) use the
// monotonic clock, read once per decision; the wall clock serves only /data
// (restart) and the times shown. The age of an observation is judged against
// the `Date` header of the answer, never against the local clock.
// -----------------------------------------------------------------------------

import {
  CHANGE_GAP,
  CONFIG_RETRY_FIRST,
  CONFIG_RETRY_MAX,
  DATE_SANITY,
  KEPT_STATIONS_MAX,
  MAX_AGE,
  MINUTE,
  MISSING_FIRST,
  MISSING_MAX,
  PAUSE_429_FIRST,
  PAUSE_5XX_FIRST,
  PAUSE_MAX,
  PAUSE_MIN,
  REFRESH_MIN,
  REQUEST_GAP,
  RETRY_FIRST,
  SECOND,
  VARIABLES,
} from './constants.js';
import { STATION_ID, normalizeConfig } from './config.js';
import { buildDevices, stationIds } from './devices.js';
import { M, configErrors, failure, formatTime } from './i18n.js';
import { latestValues } from './model.js';
import { getStationHead, parseRealtime, stationUrl } from './ndbc.js';
import { createFileStore } from './store.js';

/** No wait on /data lasts longer (load or save): a frozen /data never holds a read. */
const STORE_BOUND = 2 * SECOND;
const STATUS_MAX = 1500;
const LANGS = ['en', 'fr'];
/** States published per minute at most (the core accepts 300). */
const STATES_PER_MINUTE = 250;
/** A timer may fire a little early: armed again for what is left plus this. */
const EARLY = 5;

const isTime = (value) => Number.isFinite(value) && value > 0;
const KEYS = VARIABLES.map((v) => v.key);
/** The answers that pause every read: 429, 5xx, other unexpected statuses. */
const PAUSING = ['rate', 'server', 'http'];
/** The answers that back one station off: no file, server error, other status. */
const BACKED_OFF = ['missing', 'server', 'http'];
/** The failures read again before the next round (a passing cause). */
const RETRIED = ['network', 'timeout', 'rate', 'paused'];
const NO_PAUSE = () => ({
  until: null,
  kind: null,
  status: null,
  level429: 0,
  level5xx: 0,
  levelHttp: 0,
});

export class NdbcApp {
  constructor({
    gladys,
    logger = console,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    dataBase,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.dataBase = dataBase;

    /** Bumped by every start and stop: an older round goes quiet. */
    this.gen = 0;
    /** Bumped by every connection and disconnection (config retry loop). */
    this.connGen = 0;
    this.config = null;
    this.cycleTimer = null;
    this.statusTimer = null;
    this.sleeps = new Set();
    this.pendingStart = undefined;
    this.stopped = false;
    this.starting = null;

    this.lastRequestMono = -Infinity;
    this.inflight = null;
    /** The station whose request is out: never due again before its answer decides. */
    this.inflightId = null;
    this.pauseUntilMono = null;
    this.nextDueMono = null;
    /** Stations read again before the next round: `{ ids, dueMono, level }`. */
    this.retry = null;
    /** Per station: the last read (success, or failure with the last success). */
    this.results = new Map();
    /** Per station: its own back-off (404, 5xx, other status) `{ untilMono, level, kind }`. */
    this.backoff = new Map();
    /** Stations added to the configuration, read alone: `{ ids, dueMono }`. */
    this.added = null;
    this.lastAddedMono = -Infinity;
    /** Stations an interrupted round did not read: read at once by the next start. */
    this.unread = new Set();
    this.lastStatus = null;
    this.lastStations = null;
    /** Monotonic times of the states published in the last minute. */
    this.sent = [];

    this.loaded = false;
    this.storeStatus = 'absent';
    this.persisted = { stations: {} };

    /** The start of the process, and the last round started in it. */
    this.startMono = this.monotonic();
    this.lastAttemptMono = null;
    /** Whether /data tells the last attempt (null: not known yet). */
    this.dataTells = null;
    this.saveFailed = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * A connection to Gladys: read the configuration, then start. A failing
   * `getConfig()` is retried forever, spaced out (5 s doubled up to 5 min),
   * with the status saying so.
   */
  async connected() {
    const conn = ++this.connGen;
    // A new connection: Gladys gets the status again, even unchanged.
    this.lastStatus = null;
    let delay = CONFIG_RETRY_FIRST;
    for (;;) {
      let raw;
      try {
        raw = await this.gladys.getConfig();
      } catch (err) {
        if (conn !== this.connGen) return;
        this.logger.warn(
          `Configuration not read (${err?.name ?? 'Error'}); retry in ${delay / SECOND} s`,
        );
        await this.setStatus(
          false,
          M.configRetry({ seconds: Math.round(delay / SECOND) }),
          this.gen,
        );
        await this.sleep(delay);
        if (conn !== this.connGen) return;
        delay = Math.min(delay * 2, CONFIG_RETRY_MAX);
        continue;
      }
      if (conn !== this.connGen) return;
      await this.start(raw);
      return;
    }
  }

  async disconnected() {
    this.connGen += 1;
    await this.stop();
  }

  /**
   * Apply a configuration. Configurations saved in a row apply one after the
   * other, the last one winning: a start asked while one runs is kept and
   * applied next (only the latest of them).
   */
  start(raw) {
    this.pendingStart = { raw };
    if (!this.starting) {
      this.starting = (async () => {
        try {
          while (this.pendingStart) {
            const { raw: next } = this.pendingStart;
            this.pendingStart = undefined;
            await this.applyConfig(next);
          }
        } finally {
          this.starting = null;
        }
      })();
    }
    return this.starting;
  }

  async stop() {
    this.gen += 1;
    this.stopped = true;
    this.cancelTimers();
    await this.persist();
  }

  /** Waits for the start in progress and the request in flight (tests). */
  async idle() {
    while (this.starting || this.inflight) {
      await this.starting;
      await this.inflight;
    }
  }

  cancelTimers() {
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = null;
    if (this.statusTimer) this.timers.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    for (const sleep of this.sleeps) {
      this.timers.clearTimeout(sleep.timer);
      sleep.resolve();
    }
    this.sleeps.clear();
  }

  /** A wait on the injected timers, released at once by a stop. */
  sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve };
      entry.timer = this.timers.setTimeout(
        () => {
          this.sleeps.delete(entry);
          resolve();
        },
        Math.max(0, ms),
      );
      this.sleeps.add(entry);
    });
  }

  /** A promise, or `fallback` when it takes longer than STORE_BOUND (never waits more). */
  async bounded(promise, fallback) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(fallback), STORE_BOUND);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  async applyConfig(raw) {
    this.gen += 1;
    this.stopped = false;
    const gen = this.gen;
    this.cancelTimers();
    const config = normalizeConfig(raw);
    this.config = config;
    await this.load();
    if (gen !== this.gen) return;
    for (const error of config.errors) {
      this.logger.warn(`Configuration: field ${error.field} refused (${error.code})`);
    }
    await this.publishDevices(gen);
    if (gen !== this.gen) return;
    // Forget the stations that are gone.
    for (const id of [...this.results.keys()])
      if (!config.stations.includes(id)) this.results.delete(id);
    for (const id of [...this.backoff.keys()])
      if (!config.stations.includes(id)) this.backoff.delete(id);
    if (config.stations.length === 0) {
      const errors = configErrors(config.errors);
      this.nextDueMono = null;
      await this.setStatus(
        false,
        {
          en: `${M.noStation.en} ${errors.en}`.trim(),
          fr: `${M.noStation.fr} ${errors.fr}`.trim(),
        },
        gen,
      );
      return;
    }
    if (this.dataTells === null) await this.checkData();
    if (gen !== this.gen) return;
    // The stations added since the last configuration of this process.
    const added = this.lastStations
      ? config.stations.filter((id) => !this.lastStations.includes(id))
      : [];
    this.lastStations = [...config.stations];

    // When is the first round due? One clock read for the decision.
    const wall = this.now();
    const mono = this.monotonic();
    const gap = config.refreshMinutes * MINUTE;
    let wait = 0;
    const last = this.persisted.lastAttemptAt;
    if (this.lastAttemptMono !== null) {
      // A round already ran in this process: its monotonic time decides.
      wait = Math.max(0, this.lastAttemptMono + gap - mono);
    } else if (!this.dataTells) {
      // /data cannot tell the last attempt (unreadable, frozen, not writable,
      // a date in the future): a restart never reads at once.
      wait = Math.max(0, this.startMono + REFRESH_MIN * MINUTE - mono);
    } else if (isTime(last)) {
      wait = Math.max(0, last + gap - wall);
    }
    const pause = this.persisted.pause;
    if (pause && isTime(pause.until) && pause.until > wall && pause.until - wall <= PAUSE_MAX) {
      const left = pause.until - wall;
      if (this.pauseUntilMono === null || this.pauseUntilMono < mono + left) {
        this.pauseUntilMono = mono + left;
      }
    }
    if (this.pauseUntilMono !== null && this.pauseUntilMono > mono) {
      wait = Math.max(wait, this.pauseUntilMono - mono);
    }
    this.nextDueMono = mono + wait;
    // A retry still due keeps its turn (its stations, when still configured).
    if (this.retry) {
      const ids = new Set([...this.retry.ids].filter((id) => config.stations.includes(id)));
      this.retry = ids.size > 0 ? { ...this.retry, ids } : null;
    }
    for (const id of [...this.unread]) if (!config.stations.includes(id)) this.unread.delete(id);
    // Added stations are read alone, at most once a minute; the others keep their turn.
    const pending = new Set([...(this.added?.ids ?? []), ...added]);
    const kept = [...pending].filter((id) => config.stations.includes(id));
    this.added =
      kept.length > 0
        ? { ids: new Set(kept), dueMono: Math.max(mono, this.lastAddedMono + CHANGE_GAP) }
        : null;
    this.scheduleCycle(this.leftBefore(mono), gen);
    await this.updateStatus(gen);
  }

  /**
   * Whether /data tells when NDBC was last read: readable, with no date in
   * the future, and writable (checked by writing it back before any read).
   */
  async checkData() {
    const last = this.persisted.lastAttemptAt;
    if (this.storeStatus !== 'ok' && this.storeStatus !== 'absent') this.dataTells = false;
    else if (isTime(last) && last > this.now()) {
      this.logger.warn('The last attempt in /data is in the future: not believed');
      this.dataTells = false;
    } else {
      // Readable is not enough: a /data that cannot be written (read-only,
      // frozen) would keep an old attempt time and let every restart read.
      this.dataTells = await this.persist();
      if (!this.dataTells) this.saveFailed = true;
    }
  }

  scheduleCycle(delay, gen) {
    if (gen !== this.gen) return;
    if (this.cycleTimer) this.timers.clearTimeout(this.cycleTimer);
    this.cycleTimer = this.timers.setTimeout(
      () => {
        this.cycleTimer = null;
        this.runCycle(gen).catch((err) => {
          // Never left without a next round: armed again at the interval.
          this.logger.error(`Read failed (${err?.name ?? 'Error'})`);
          if (gen !== this.gen) return;
          const interval = (this.config?.refreshMinutes ?? REFRESH_MIN) * MINUTE;
          this.nextDueMono = this.monotonic() + interval;
          this.scheduleCycle(interval, gen);
        });
      },
      Math.max(0, delay),
    );
  }

  /** Reads /data once, never waiting more than STORE_BOUND (frozen = unreadable). */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let result;
    try {
      result = await this.bounded(this.store.load(), { status: 'frozen', data: {} });
    } catch {
      result = { status: 'unreadable', data: {} };
    }
    this.storeStatus = ['ok', 'absent', 'frozen'].includes(result?.status)
      ? result.status
      : 'unreadable';
    if (this.storeStatus === 'unreadable') {
      this.logger.warn(
        'The state file of /data is unreadable: left untouched, running from memory',
      );
    } else if (this.storeStatus === 'frozen') {
      this.logger.warn(
        'The state file of /data does not answer: left untouched, running from memory',
      );
    }
    const data = result?.data ?? {};
    const persisted = { stations: {} };
    const wall = this.now();
    if (isTime(data.lastAttemptAt)) persisted.lastAttemptAt = data.lastAttemptAt;
    if (data.pause && typeof data.pause === 'object') {
      const level = (n) => (Number.isInteger(n) && n >= 0 && n <= 30 ? n : 0);
      persisted.pause = {
        until: isTime(data.pause.until) ? data.pause.until : null,
        kind: PAUSING.includes(data.pause.kind) ? data.pause.kind : 'rate',
        status:
          Number.isInteger(data.pause.status) &&
          data.pause.status >= 100 &&
          data.pause.status <= 599
            ? data.pause.status
            : null,
        level429: level(data.pause.level429),
        level5xx: level(data.pause.level5xx),
        levelHttp: level(data.pause.levelHttp),
      };
    }
    if (data.stations && typeof data.stations === 'object' && !Array.isArray(data.stations)) {
      for (const [id, entry] of Object.entries(data.stations).slice(0, KEPT_STATIONS_MAX)) {
        if (!STATION_ID.test(id) || !entry || typeof entry !== 'object') continue;
        const stamps = {};
        for (const key of KEYS) {
          const at = entry.stamps?.[key];
          // A stamp in the future would hold the variable back: not believed.
          if (isTime(at) && at <= wall + DATE_SANITY) stamps[key] = at;
        }
        persisted.stations[id] = { stamps, seenAt: isTime(entry.seenAt) ? entry.seenAt : wall };
      }
    }
    this.persisted = persisted;
  }

  /** Saves /data without ever waiting more than STORE_BOUND for it. */
  async persist() {
    if (!this.loaded || (this.storeStatus !== 'ok' && this.storeStatus !== 'absent')) return false;
    this.trimStations();
    try {
      const outcome = await this.bounded(
        Promise.resolve(this.store.save(this.persisted)).then(() => 'saved'),
        'late',
      );
      if (outcome === 'late') this.logger.warn('Saving /data is slow: going on without waiting');
      return outcome === 'saved';
    } catch (err) {
      this.logger.warn(`Saving /data failed (${err?.code ?? err?.name ?? 'Error'})`);
      return false;
    }
  }

  /** The stations remembered in /data: the configured ones, then the most recent others. */
  trimStations() {
    const configured = new Set(this.config?.stations ?? []);
    const entries = Object.entries(this.persisted.stations);
    if (entries.length <= KEPT_STATIONS_MAX) return;
    entries.sort(
      (a, b) =>
        Number(configured.has(b[0])) - Number(configured.has(a[0])) || b[1].seenAt - a[1].seenAt,
    );
    this.persisted.stations = Object.fromEntries(entries.slice(0, KEPT_STATIONS_MAX));
  }

  // --- Discovery, actions, devices -------------------------------------------

  async publishDevices(gen = this.gen) {
    const config = this.config ?? normalizeConfig(this.gladys.config);
    try {
      if (gen !== this.gen) return;
      await this.gladys.publishDiscoveredDevices(buildDevices(this.gladys, config));
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery: the stations of the configuration, never a read. */
  scan() {
    return this.publishDevices();
  }

  /**
   * The test button: what the last read of each station gave and when the
   * next one comes. It never reads (the interval and the gap hold for it too).
   */
  testConnection() {
    return this.composeStatus().message;
  }

  /**
   * A device just created by the user: the values of its station still under
   * 2 h old (from the last read, in memory) are published now, never older.
   */
  async deviceCreated(device) {
    const gen = this.gen;
    const id = this.config?.stations.find(
      (s) => stationIds(this.gladys, s).device === device?.external_id,
    );
    if (id) await this.publishStation(id, gen);
  }

  // --- The read round --------------------------------------------------------

  /**
   * The time left before the next read: the full round, a retry, the added
   * stations or the end of a station back-off, whichever comes first; the
   * pause included.
   */
  leftBefore(mono) {
    let next = (this.nextDueMono ?? mono) - mono;
    if (this.retry) next = Math.min(next, this.retry.dueMono - mono);
    if (this.added) next = Math.min(next, this.added.dueMono - mono);
    if (this.unread.size > 0) next = Math.min(next, 0);
    for (const [id, back] of this.backoff) {
      // The back-off read still out (a round interrupted meanwhile) is not due
      // again: its answer, kept late, ends or restarts the back-off.
      if (id !== this.inflightId) next = Math.min(next, back.untilMono - mono);
    }
    return Math.max(this.pausedFor(mono), next);
  }

  /** The stations due before the full round: retry, added, back-off ended. */
  dueStations(mono) {
    const ids = new Set();
    if (this.retry && this.retry.dueMono <= mono) for (const id of this.retry.ids) ids.add(id);
    if (this.added && this.added.dueMono <= mono) {
      for (const id of this.added.ids) ids.add(id);
      this.added = null;
      this.lastAddedMono = mono;
    }
    for (const [id, back] of this.backoff) if (back.untilMono <= mono) ids.add(id);
    for (const id of this.unread) ids.add(id);
    this.unread.clear();
    // The station whose request is still out is never asked twice: the round
    // that sent it keeps its answer for the configuration now running.
    ids.delete(this.inflightId);
    return ids;
  }

  async runCycle(gen) {
    if (gen !== this.gen) return;
    // A timer may fire a little before the end of a pause, of a retry or of
    // the interval: armed again for what is left, the round is never skipped.
    const mono0 = this.monotonic();
    const left = this.leftBefore(mono0);
    if (left > 0) {
      this.scheduleCycle(left + EARLY, gen);
      return;
    }
    const full = (this.nextDueMono ?? mono0) <= mono0;
    await this.round(gen, full ? null : this.dueStations(mono0));
  }

  /**
   * One round: every station not backed off (or only the stations due: a
   * retry, the added ones, a back-off ended), one request at a time.
   */
  async round(gen, only = null) {
    const config = this.config;
    const start = this.monotonic();
    if (!only) {
      this.lastAttemptMono = start;
      this.nextDueMono = start + config.refreshMinutes * MINUTE;
      this.added = null;
      this.unread.clear();
    }
    const retryLevel = this.retry?.level ?? 0;
    // A retry is spent by a full round or once its stations are read.
    if (!only || (this.retry && this.retry.dueMono <= start)) this.retry = null;
    // The time of the attempt is in /data before the first request.
    this.persisted.lastAttemptAt = this.now();
    const saved = await this.persist();
    this.saveFailed = !saved && (this.storeStatus === 'ok' || this.storeStatus === 'absent');
    const ids = config.stations.filter((id) => !only || only.has(id));
    if (gen !== this.gen) {
      this.leaveUnread(ids);
      return;
    }
    const failed = new Set();
    let read = 0;
    let refused = null;
    for (const [index, id] of ids.entries()) {
      const back = this.backoff.get(id);
      if (back && back.untilMono > this.monotonic()) continue;
      if (this.pausedFor() > 0) {
        this.recordFailure(id, { kind: 'paused' });
        failed.add(id);
        continue;
      }
      const result = await this.readStation(id, gen);
      if (result.kind !== 'paused' && result.kind !== 'stopped') read += 1;
      if (gen !== this.gen) {
        // Interrupted (configuration saved, reconnection): the answer of a
        // request that went is kept for the configuration now running; the
        // stations not read yet stay due and are read soon, not at the
        // next interval.
        const sent = result.kind !== 'paused' && result.kind !== 'stopped';
        const current = this.gen;
        const kept = sent && (await this.keepLate(id, result));
        this.leaveUnread(ids.slice(kept ? index + 1 : index));
        // The status tells the kept answer at once (values, 429, back-off),
        // once the next round is armed: a slow Gladys never holds it back.
        if (kept) await this.updateStatus(current);
        return;
      }
      if (result.ok) {
        this.backoff.delete(id);
        refused = false;
        // Success resets the pauses.
        this.pauseUntilMono = null;
        if (this.persisted.pause) this.persisted.pause = NO_PAUSE();
        this.results.set(id, result);
        await this.publishStation(id, gen);
        if (gen !== this.gen) {
          this.leaveUnread(ids.slice(index + 1));
          return;
        }
      } else {
        if (BACKED_OFF.includes(result.kind)) this.startBackoff(id, result);
        // Another cause ends the back-off: the retry or the next round reads it,
        // a station never stays due without a request going.
        else if (result.kind !== 'paused') this.backoff.delete(id);
        if (['server', 'http'].includes(result.kind)) {
          if (refused !== false) refused = result;
        } else if (result.kind !== 'paused') refused = false;
        if (RETRIED.includes(result.kind)) failed.add(id);
        this.logger.warn(
          `Station ${id}: read failed (${result.kind}${result.status ? ` ${result.status}` : ''})`,
        );
        this.recordFailure(id, result);
      }
    }
    // Every station of a full round refused by a 5xx or another status: the
    // server is down, every read pauses (one station alone backs off alone).
    if (!only && read > 0 && refused) this.startPause(refused);
    // The next round is armed before /data and the status: neither a slow
    // save nor a slow Gladys holds it back.
    const mono = this.monotonic();
    this.armRetry(failed, retryLevel, mono);
    this.scheduleCycle(this.leftBefore(mono), gen);
    const savedAfter = await this.persist();
    if (this.storeStatus === 'ok' || this.storeStatus === 'absent') {
      this.saveFailed = this.saveFailed || !savedAfter;
    }
    if (gen !== this.gen) return;
    await this.updateStatus(gen);
  }

  /** Stations an interrupted round did not read: due at once for the configuration running. */
  leaveUnread(ids) {
    for (const id of ids) this.unread.add(id);
    if (this.cycleTimer && this.config) {
      this.scheduleCycle(this.leftBefore(this.monotonic()), this.gen);
    }
  }

  /**
   * The answer of a request that went before the round was interrupted, kept
   * for the configuration now running when it still has the station: data
   * stored and published, a back-off or a retry as in a round.
   */
  async keepLate(id, result) {
    // Stopped (disconnection, shutdown): nothing is kept, the station stays unread.
    if (this.stopped || !this.config?.stations.includes(id)) return false;
    const gen = this.gen;
    if (result.ok) {
      this.backoff.delete(id);
      this.pauseUntilMono = null;
      if (this.persisted.pause) this.persisted.pause = NO_PAUSE();
      this.results.set(id, result);
      await this.publishStation(id, gen);
      return true;
    }
    if (result.kind === 'rate') await this.persist();
    if (BACKED_OFF.includes(result.kind)) this.startBackoff(id, result);
    else if (RETRIED.includes(result.kind)) this.armRetry(new Set([id]), 0, this.monotonic());
    // Another cause ends the back-off, as in a round: the retry or the next
    // round reads the station, never at once.
    if (!BACKED_OFF.includes(result.kind)) this.backoff.delete(id);
    this.recordFailure(id, result);
    return true;
  }

  /**
   * The stations whose read failed for a passing cause (network, timeout,
   * 429, pause) are read again before the next round: 2 min after,
   * doubled at each failed retry, never during a pause; dropped when the
   * next round comes first.
   */
  armRetry(failed, level, mono) {
    if (failed.size === 0) return;
    // A retry still waiting (this was a back-off read) takes these stations too.
    if (this.retry) {
      for (const id of failed) this.retry.ids.add(id);
      return;
    }
    const next = Math.min(level + 1, 10);
    // During a pause (itself doubled), at its end; else 2 min doubled.
    const due =
      this.pausedFor(mono) > 0 ? this.pauseUntilMono : mono + RETRY_FIRST * 2 ** (next - 1);
    if (due >= this.nextDueMono) return;
    this.retry = { ids: failed, dueMono: due, level: next };
  }

  /** The pause left, in ms (0 when none). */
  pausedFor(mono = this.monotonic()) {
    if (this.pauseUntilMono === null) return 0;
    return Math.max(0, this.pauseUntilMono - mono);
  }

  /**
   * One request, when its turn comes: after the one in flight, REQUEST_GAP
   * after the start of the previous one. `null` when stopped meanwhile.
   * `id` is the station asked, known as in flight until the answer.
   */
  async request(url, etag, gen, id = null) {
    for (;;) {
      if (gen !== this.gen) return null;
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      const wait = this.lastRequestMono + REQUEST_GAP - this.monotonic();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      break;
    }
    // A pause started meanwhile (a late 429 of an older round) holds this one.
    if (this.pausedFor() > 0) return { ok: false, kind: 'paused' };
    this.lastRequestMono = this.monotonic();
    // The station asked is in flight, and read: no longer left unread (a
    // full round that started before an interrupted answer never reads it twice).
    this.inflightId = id;
    this.unread.delete(id);
    const job = getStationHead(url, {
      etag,
      fetchImpl: this.fetchImpl,
      timers: this.timers,
    }).then((result) => {
      // A 429 pauses every read before the next request may go, even when
      // the configuration changed or Gladys reconnected while this one was out.
      if (!result.ok && result.kind === 'rate') this.startPause(result);
      return result;
    });
    this.inflight = job.then(
      () => {},
      () => {},
    );
    try {
      return await job;
    } finally {
      this.inflight = null;
      this.inflightId = null;
    }
  }

  /**
   * The head of a station file, read: `{ ok: true, id, rows, latest,
   * serverDate, readAt, readMono, etag, unreadable, units }` or a failure.
   */
  async readStation(id, gen) {
    const before = this.results.get(id);
    const last = before?.ok ? before : before?.lastOk;
    // If-None-Match only for a file whose rows are in memory.
    const answer = await this.request(stationUrl(id, this.dataBase), last?.etag ?? null, gen, id);
    if (answer === null) return { ok: false, kind: 'stopped' };
    if (!answer.ok) return answer;
    const serverDate = this.believableDate(answer.serverDate);
    if (serverDate === null) return { ok: false, kind: 'no_date' };
    let parsed;
    let etag;
    if (answer.notModified) {
      if (!last) return { ok: false, kind: 'format', status: 304 };
      parsed = { rows: last.rows, unreadable: last.unreadable, units: last.units };
      etag = last.etag;
    } else {
      parsed = parseRealtime(answer.text, answer.complete);
      if (!parsed.ok) return { ok: false, kind: parsed.kind };
      etag = answer.etag;
      if (parsed.unreadable > 0)
        this.logger.info(`Station ${id}: ${parsed.unreadable} line(s) unreadable, left out`);
    }
    return {
      ok: true,
      id,
      rows: parsed.rows,
      unreadable: parsed.unreadable,
      units: parsed.units,
      latest: latestValues(parsed.rows, serverDate),
      serverDate,
      readAt: this.now(),
      readMono: this.monotonic(),
      etag,
    };
  }

  /** A server date more than a day away from the local clock is not believed. */
  believableDate(at) {
    if (at === null || at === undefined) return null;
    if (Math.abs(at - this.now()) > DATE_SANITY) {
      this.logger.warn('The Date of the NDBC answer is more than a day off: not used');
      return null;
    }
    return at;
  }

  /** The age now of an observation of a read (server age at the read + time since). */
  ageOf(result, at, mono) {
    return result.serverDate - at + (mono - result.readMono);
  }

  /**
   * Publishes the values of a station that are under 2 h old and newer than
   * the last published (kept in /data). The time of each is marked before
   * the call (a concurrent publication never sends it again) and given back
   * if Gladys refuses it.
   */
  async publishStation(id, gen) {
    const result = this.results.get(id);
    if (!result?.ok) return;
    const ids = stationIds(this.gladys, id);
    if (!this.gladys.devices?.some((device) => device.external_id === ids.device)) return;
    const mono = this.monotonic();
    const entry = (this.persisted.stations[id] ??= { stamps: {}, seenAt: this.now() });
    entry.seenAt = this.now();
    const fresh = [];
    for (const key of KEYS) {
      const value = result.latest.values[key];
      if (!value) continue;
      if (this.ageOf(result, value.at, mono) > MAX_AGE) continue;
      const stamp = entry.stamps[key];
      if (stamp !== undefined && value.at <= stamp) continue;
      fresh.push({ key, ...value });
    }
    const allowed = this.budget(fresh.length, mono);
    const batch = fresh.slice(0, allowed);
    if (batch.length < fresh.length) {
      this.logger.warn(
        `Station ${id}: ${fresh.length - batch.length} value(s) held back (states per minute)`,
      );
    }
    if (batch.length === 0 || gen !== this.gen) return;
    const previous = {};
    for (const item of batch) {
      previous[item.key] = entry.stamps[item.key];
      entry.stamps[item.key] = item.at;
    }
    try {
      await this.gladys.publishStates(
        batch.map((item) => ({
          device_feature_external_id: ids.feature(item.key),
          state: item.value,
        })),
      );
    } catch (err) {
      this.logger.warn(`Station ${id}: values not published (${err?.name ?? 'Error'})`);
      for (const item of batch) {
        if (entry.stamps[item.key] === item.at) {
          if (previous[item.key] === undefined) delete entry.stamps[item.key];
          else entry.stamps[item.key] = previous[item.key];
        }
      }
    }
  }

  /** How many of `count` states fit in the per-minute budget (reserved at once). */
  budget(count, mono) {
    this.sent = this.sent.filter((at) => mono - at < MINUTE);
    const allowed = Math.max(0, Math.min(count, STATES_PER_MINUTE - this.sent.length));
    for (let i = 0; i < allowed; i += 1) this.sent.push(mono);
    return allowed;
  }

  recordFailure(id, result) {
    const before = this.results.get(id);
    this.results.set(id, {
      ok: false,
      failure: { kind: result.kind, status: result.status },
      // The last success, for the status (its values, never republished).
      lastOk: before?.ok ? before : (before?.lastOk ?? null),
    });
  }

  /**
   * One station backs off alone: no realtime file (404, 410) 1 h doubled up
   * to a day; a 5xx or another status 2 min doubled up to 6 h, Retry-After
   * honoured within that bound. On its own timer, never rounded to a round.
   */
  startBackoff(id, result) {
    const before = this.backoff.get(id);
    const back = { level: before?.kind === result.kind ? before.level : 0, kind: result.kind };
    back.level = Math.min(back.level + 1, 30);
    let duration;
    if (result.kind === 'missing') {
      duration = Math.min(MISSING_MAX, MISSING_FIRST * 2 ** (back.level - 1));
    } else {
      duration = PAUSE_5XX_FIRST * 2 ** (back.level - 1);
      if (Number.isFinite(result.retryAfter) && result.retryAfter > duration) {
        duration = result.retryAfter;
      }
      duration = Math.min(PAUSE_MAX, duration);
    }
    back.status = Number.isInteger(result.status) ? result.status : null;
    back.untilMono = this.monotonic() + duration;
    this.backoff.set(id, back);
  }

  startPause(result) {
    const pause = this.persisted.pause ?? NO_PAUSE();
    let duration;
    if (result.kind === 'rate') {
      pause.level429 = Math.min(pause.level429 + 1, 30);
      duration = PAUSE_429_FIRST * 2 ** (pause.level429 - 1);
    } else if (result.kind === 'server') {
      pause.level5xx = Math.min(pause.level5xx + 1, 30);
      duration = PAUSE_5XX_FIRST * 2 ** (pause.level5xx - 1);
    } else {
      // 400, 403, 416...: spaced out like a server error.
      pause.levelHttp = Math.min(pause.levelHttp + 1, 30);
      duration = PAUSE_5XX_FIRST * 2 ** (pause.levelHttp - 1);
    }
    pause.kind = result.kind;
    pause.status = Number.isInteger(result.status) ? result.status : null;
    if (Number.isFinite(result.retryAfter) && result.retryAfter > duration)
      duration = result.retryAfter;
    duration = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, duration));
    const mono = this.monotonic();
    this.pauseUntilMono = Math.max(this.pauseUntilMono ?? 0, mono + duration);
    pause.until = this.now() + (this.pauseUntilMono - mono);
    this.persisted.pause = pause;
  }

  // --- Status ----------------------------------------------------------------

  /**
   * What a read says now: `{ fresh, newestAt, staleAt }`, `fresh` the count of
   * values under 2 h old, `staleAt` the monotonic time the first of them
   * turns 2 h old (null when none).
   */
  freshness(result, mono) {
    let fresh = 0;
    let staleAt = null;
    for (const value of Object.values(result.latest.values)) {
      const age = this.ageOf(result, value.at, mono);
      if (age > MAX_AGE) continue;
      fresh += 1;
      const at = mono + (MAX_AGE - age);
      if (staleAt === null || at < staleAt) staleAt = at;
    }
    return { fresh, staleAt, count: Object.keys(result.latest.values).length };
  }

  /** What the read of a station says now, in both languages. */
  describe(read, mono) {
    const f = this.freshness(read, mono);
    const newest = (lang) => formatTime(read.latest.newestAt, lang);
    let text;
    if (read.latest.newestAt === null) {
      text = {
        en: 'the file holds no observation',
        fr: 'le fichier ne contient aucune observation',
      };
    } else if (f.count === 0) {
      text = {
        en: `every value missing (MM) in the lines read, newest ${newest('en')}`,
        fr: `toutes les valeurs manquent (MM) dans les lignes lues, la plus récente ${newest('fr')}`,
      };
    } else if (f.fresh === 0) {
      text = {
        en: `silent: no value under 2 h old, newest observation ${newest('en')}`,
        fr: `muette : aucune valeur de moins de 2 h, observation la plus récente ${newest('fr')}`,
      };
    } else {
      text = {
        en: `${f.fresh} value(s) under 2 h old, newest observation ${newest('en')}`,
        fr: `${f.fresh} valeur(s) de moins de 2 h, observation la plus récente ${newest('fr')}`,
      };
    }
    if (read.units.length > 0) {
      text.en += `; ${read.units.length} column(s) in an unexpected unit, not used`;
      text.fr += ` ; ${read.units.length} colonne(s) dans une unité inattendue, non utilisée(s)`;
    }
    const short =
      read.latest.newestAt === null
        ? { en: 'no observation', fr: 'aucune observation' }
        : f.count === 0
          ? { en: 'all MM', fr: 'tout MM' }
          : f.fresh === 0
            ? { en: 'silent', fr: 'muette' }
            : { en: `${f.fresh} value(s) < 2 h`, fr: `${f.fresh} valeur(s) < 2 h` };
    return { ...text, short, fresh: f.fresh > 0, staleAt: f.staleAt };
  }

  composeStatus() {
    const config = this.config;
    // The global lines first (pause, next read, configuration, /data): they
    // stay whole; the station lines are shortened when all would not fit.
    const head = { en: [], fr: [] };
    const long = { en: [], fr: [] };
    const short = { en: [], fr: [] };
    const push = (en, fr) => {
      head.en.push(en);
      head.fr.push(fr);
    };
    const station = (en, fr, shortEn, shortFr) => {
      long.en.push(en);
      long.fr.push(fr);
      short.en.push(shortEn);
      short.fr.push(shortFr);
    };
    if (!config) return { connected: false, message: M.starting, staleAt: null };
    const mono = this.monotonic();
    const wall = this.now();
    const toWall = (m) => wall + (m - mono);
    let anyFresh = false;
    let staleAt = null;
    const paused = this.pausedFor(mono);
    if (paused > 0) {
      const kind = this.persisted.pause?.kind ?? 'rate';
      const status = this.persisted.pause?.status ?? null;
      push(
        `${failure(kind, status, 'en')}: reads paused until ${formatTime(wall + paused, 'en')}.`,
        `${failure(kind, status, 'fr')} : lectures en pause jusqu'à ${formatTime(wall + paused, 'fr')}.`,
      );
    }
    for (const id of config.stations) {
      const result = this.results.get(id);
      if (!result) {
        station(
          `${id}: no read yet.`,
          `${id} : pas encore lue.`,
          `${id}: no read yet.`,
          `${id} : pas encore lue.`,
        );
        continue;
      }
      const ok = result.ok ? result : result.lastOk;
      const data = ok ? this.describe(ok, mono) : null;
      if (data?.staleAt != null && (staleAt === null || data.staleAt < staleAt))
        staleAt = data.staleAt;
      if (result.ok) {
        if (data.fresh) anyFresh = true;
        station(
          `${id}: ${data.en}${data.fresh ? '' : '; nothing published'}.`,
          `${id} : ${data.fr}${data.fresh ? '' : ' ; rien publié'}.`,
          `${id}: ${data.short.en}.`,
          `${id} : ${data.short.fr}.`,
        );
        continue;
      }
      const kind = result.failure.kind;
      const why =
        kind === 'paused'
          ? { en: 'not read (pause)', fr: 'non lue (pause)' }
          : {
              en: failure(kind, result.failure.status, 'en'),
              fr: failure(kind, result.failure.status, 'fr'),
            };
      const back = this.backoff.get(id);
      if (BACKED_OFF.includes(kind) && back) {
        why.en += `, next try ${formatTime(toWall(back.untilMono), 'en')}`;
        why.fr += `, prochain essai ${formatTime(toWall(back.untilMono), 'fr')}`;
      }
      const since = ok
        ? {
            en: `; last read ${formatTime(ok.readAt, 'en')}: ${data.en}; nothing published since`,
            fr: ` ; dernière lecture ${formatTime(ok.readAt, 'fr')} : ${data.fr} ; rien publié depuis`,
          }
        : { en: '; no data yet', fr: ' ; pas encore de données' };
      const reason = {
        en: kind === 'paused' ? 'pause' : failure(kind, result.failure.status, 'en'),
        fr: kind === 'paused' ? 'pause' : failure(kind, result.failure.status, 'fr'),
      };
      station(
        `${id}: ${why.en}${since.en}.`,
        `${id} : ${why.fr}${since.fr}.`,
        `${id}: ${reason.en}.`,
        `${id} : ${reason.fr}.`,
      );
    }
    if (this.nextDueMono !== null) {
      const next = toWall(mono + this.leftBefore(mono));
      push(`Next read ${formatTime(next, 'en')}.`, `Prochaine lecture ${formatTime(next, 'fr')}.`);
    }
    if (config.errors.length > 0) {
      const errors = configErrors(config.errors);
      push(`Configuration: ${errors.en}.`, `Configuration : ${errors.fr}.`);
    }
    if (this.dataTells === false && this.lastAttemptMono === null) {
      push(
        '/data does not tell when NDBC was last read: the first read waits 10 min after the start.',
        '/data ne dit pas quand NDBC a été lu : la première lecture attend 10 min après le démarrage.',
      );
    }
    if (this.saveFailed) {
      push(
        'The time of the last read could not be written in /data: a restart may read sooner than the interval.',
        "L'heure de la dernière lecture n'a pas pu être écrite dans /data : un redémarrage peut lire plus tôt que l'intervalle.",
      );
    }
    if (this.storeStatus === 'unreadable' || this.storeStatus === 'frozen') {
      push(
        'The state file of /data cannot be read: left untouched, the integration runs from memory (a restart may publish the newest observations again).',
        "Le fichier d'état de /data ne peut pas être lu : laissé tel quel, l'intégration tourne en mémoire (un redémarrage peut republier les observations les plus récentes).",
      );
    }
    const message = {};
    for (const lang of LANGS) message[lang] = fitStatus(head[lang], long[lang], short[lang]);
    return { connected: anyFresh, message, staleAt };
  }

  /**
   * Sends the status, and arms a timer for the moment a value shown as under
   * 2 h old turns older: the status never keeps calling it fresh.
   */
  async updateStatus(gen) {
    if (gen !== this.gen) return;
    const { connected, message, staleAt } = this.composeStatus();
    if (this.statusTimer) this.timers.clearTimeout(this.statusTimer);
    this.statusTimer = null;
    if (staleAt !== null) {
      const delay = Math.max(0, staleAt - this.monotonic()) + EARLY;
      this.statusTimer = this.timers.setTimeout(() => {
        this.statusTimer = null;
        this.updateStatus(gen).catch(() => {});
      }, delay);
    }
    await this.setStatus(connected, message, gen);
  }

  async setStatus(connected, message, gen) {
    if (gen !== this.gen) return;
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not published (${err?.name ?? 'Error'})`);
    }
  }
}

/**
 * The status text, at most `max` characters: the global lines whole, then
 * the long station lines, or the short ones when the long would not fit.
 */
export function fitStatus(head, long, short, max = STATUS_MAX) {
  const join = (parts) => parts.join(' ');
  let text = join([...head, ...long]);
  if ([...text].length > max) text = join([...head, ...short]);
  return [...text].slice(0, max).join('');
}
