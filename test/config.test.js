// -----------------------------------------------------------------------------
// The configuration, read strictly: station ids, interval, language.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, readMinutes, readStations } from '../src/config.js';

test('station ids: separators, case, duplicates', () => {
  assert.deepEqual(readStations('46026, psbm1;44025  45132,46026'), {
    stations: ['46026', 'PSBM1', '44025', '45132'],
    errors: [],
  });
  assert.deepEqual(readStations(' 46026 '), { stations: ['46026'], errors: [] });
});

test('a part that is not an id is left out and named; the others are kept', () => {
  for (const bad of ['4602', '460266', '46-26', 'é6026', '46026\u0000', '../46', '4602.']) {
    assert.deepEqual(
      readStations(`44025, ${bad}`),
      { stations: ['44025'], errors: ['stations_invalid'] },
      bad,
    );
  }
  assert.deepEqual(readStations('x, y'), { stations: [], errors: ['stations_invalid'] });
});

test('blank, not a text, too long, more than 10', () => {
  for (const blank of [undefined, null, '', '  ', ' ,; ']) {
    assert.deepEqual(readStations(blank).stations, [], String(blank));
    assert.deepEqual(readStations(blank).errors, ['required'], String(blank));
  }
  assert.deepEqual(readStations(46026), { stations: [], errors: ['stations_invalid'] });
  assert.deepEqual(readStations('46026,'.repeat(100)).errors, ['stations_invalid']);
  const eleven = Array.from({ length: 11 }, (_, i) => `AAA${String(i).padStart(2, '0')}`).join(',');
  const read = readStations(eleven);
  assert.equal(read.stations.length, 10);
  assert.equal(read.stations[9], 'AAA09');
  assert.deepEqual(read.errors, ['stations_too_many']);
});

test('the interval: whole minutes from 10 to 180, 30 by default', () => {
  assert.equal(readMinutes(''), null);
  assert.equal(readMinutes(15), 15);
  assert.equal(readMinutes(' 45 '), 45);
  for (const bad of [15.5, '15.5', '1e2', '-20', 'abc', true, {}, NaN, Infinity]) {
    assert.ok(Number.isNaN(readMinutes(bad)), String(bad));
  }
  for (const [value, expected, error] of [
    [undefined, 30, false],
    [10, 10, false],
    [180, 180, false],
    [9, 30, true],
    [181, 30, true],
    ['x', 30, true],
  ]) {
    const config = normalizeConfig({ stations: '46026', refresh_minutes: value });
    assert.equal(config.refreshMinutes, expected, String(value));
    assert.equal(
      config.errors.some((e) => e.field === 'refresh_minutes'),
      error,
      String(value),
    );
  }
});

test('language: en or fr, en by default; anything else is not a config', () => {
  assert.equal(normalizeConfig({ language: 'fr' }).language, 'fr');
  assert.equal(normalizeConfig({ language: 'de' }).language, 'en');
  for (const raw of [null, undefined, [], 'x']) {
    assert.deepEqual(normalizeConfig(raw), {
      language: 'en',
      refreshMinutes: 30,
      stations: [],
      errors: [{ field: 'stations', code: 'required' }],
    });
  }
});
