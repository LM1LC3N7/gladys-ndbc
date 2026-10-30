// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// time of the last read attempt (a restart never reads sooner than the
// interval), the pause NDBC asked for, and per station the time of the
// observation last published for each variable (a restart never publishes
// the same observation again). A small JSON file written through a temporary
// file and a rename, one save after the other.
//
// A file that exists but cannot be read is not an empty one: it is never
// overwritten (the app runs from memory and says so in its status). Reads and
// writes are asynchronous: the app bounds its wait for them (a frozen /data
// never holds a read of NDBC).
// -----------------------------------------------------------------------------

import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { STATE_FILE } from './constants.js';

const MAX_STATE_BYTES = 1024 * 1024;

export function createFileStore(file = STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    // A leftover (or planted) temporary entry is removed first: writing into a
    // FIFO or through a link would never end or land elsewhere.
    await rm(tmp, { force: true, recursive: false });
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, file);
  };
  return {
    /** Resolves `{ status: 'ok' | 'absent' | 'unreadable', data }`. */
    async load() {
      let stats;
      try {
        stats = await lstat(file);
      } catch (err) {
        return err?.code === 'ENOENT'
          ? { status: 'absent', data: {} }
          : { status: 'unreadable', data: {} };
      }
      // Only a plain file is read (a FIFO would never end, a link points elsewhere).
      if (!stats.isFile() || stats.size > MAX_STATE_BYTES)
        return { status: 'unreadable', data: {} };
      try {
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return { status: 'unreadable', data: {} };
        }
        return { status: 'ok', data };
      } catch {
        return { status: 'unreadable', data: {} };
      }
    },
    save(data) {
      const snapshot = JSON.parse(JSON.stringify(data));
      const job = queue.then(
        () => write(snapshot),
        () => write(snapshot),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `status` forces what `load` says, `holdLoad` freezes it. */
export function createMemoryStore(initial, { status } = {}) {
  let data = initial === undefined ? undefined : structuredClone(initial);
  return {
    saves: 0,
    async load() {
      if (this.holdLoad) await this.holdLoad;
      if (status) return { status, data: {} };
      return data === undefined
        ? { status: 'absent', data: {} }
        : { status: 'ok', data: structuredClone(data) };
    },
    async save(next) {
      this.saves += 1;
      if (this.failSave) throw new Error('disk full');
      if (this.hold) await this.hold;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
}
