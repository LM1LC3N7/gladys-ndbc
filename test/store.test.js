// -----------------------------------------------------------------------------
// The /data file: atomic writes, one after the other; a file that cannot be
// read (garbled, too big, a FIFO, a directory, a link) is "unreadable",
// never "absent", and is never overwritten by the app.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/store.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'ndbc-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('absent, then saved and read back; saves in a row keep the last', async (t) => {
  const file = join(await dir(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), { status: 'absent', data: {} });
  await Promise.all([store.save({ n: 1 }), store.save({ n: 2 }), store.save({ n: 3 })]);
  assert.deepEqual(await store.load(), { status: 'ok', data: { n: 3 } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 3 });
});

test('garbled, not an object, too big, a directory, a link, a FIFO: unreadable', async (t) => {
  const base = await dir(t);
  const cases = {
    garbled: async (f) => writeFile(f, '{"n":'),
    array: async (f) => writeFile(f, '[1]'),
    big: async (f) => writeFile(f, `{"x":"${'a'.repeat(1024 * 1024)}"}`),
    directory: async (f) => mkdir(f),
    link: async (f) => {
      await writeFile(`${f}.real`, '{"n":1}');
      await symlink(`${f}.real`, f);
    },
    fifo: async (f) => execFileSync('mkfifo', [f]),
  };
  for (const [name, make] of Object.entries(cases)) {
    const file = join(base, `${name}.json`);
    await make(file);
    assert.equal((await createFileStore(file).load()).status, 'unreadable', name);
  }
});

test('a FIFO or a link left at the temporary path never blocks nor redirects a save', async (t) => {
  const base = await dir(t);
  const file = join(base, 'state.json');
  execFileSync('mkfifo', [`${file}.tmp`]);
  await createFileStore(file).save({ n: 1 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 1 });
  const elsewhere = join(base, 'elsewhere.json');
  await writeFile(elsewhere, 'keep');
  await symlink(elsewhere, `${file}.tmp`);
  await createFileStore(file).save({ n: 2 });
  assert.equal(await readFile(elsewhere, 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 2 });
});

test('a failed save is reported, and the next one still runs', async (t) => {
  const base = await dir(t);
  const file = join(base, 'state.json');
  await mkdir(`${file}.tmp`);
  await mkdir(join(`${file}.tmp`, 'inside'));
  const store = createFileStore(file);
  await assert.rejects(store.save({ n: 1 }));
  await rm(`${file}.tmp`, { recursive: true });
  await store.save({ n: 2 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 2 });
});
