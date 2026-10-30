// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, REFRESH_DEFAULT, REFRESH_MAX, REFRESH_MIN, VARIABLES } from '../src/constants.js';
import { LANGUAGES, normalizeConfig } from '../src/config.js';
import { FEATURE_DEFS, buildDevices } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');
const SEMVER = /^\d+\.\d+\.\d+$/;

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; one version in the four places, never pinned', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, SEMVER);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-ndbc:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(pkg.name, 'gladys-ndbc');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.match(
    pkg.dependencies['@gladysassistant/integration-sdk'],
    /^\^\d+\.\d+\.\d+$/,
    'never pinned',
  );
  assert.deepEqual(manifest.categories, ['environment']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.gladys_version, '>=5.1.0', 'the probe temperature type needs 5.1.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-ndbc\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) assert.equal(typeof field.placeholder, 'object', field.key);
  }
});

test('the configuration matches the code; no key prefixed gladys_; no secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', 'stations', 'language', 'refresh_minutes']);
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/i);
  assert.equal(fields.stations.required, true);
  assert.equal(fields.stations.type, 'string');
  // The example is ids, not the key; and it is read by the code as such.
  assert.deepEqual(normalizeConfig({ stations: fields.stations.placeholder.en }).errors, []);
  assert.equal(fields.refresh_minutes.default, REFRESH_DEFAULT);
  assert.equal(fields.refresh_minutes.min, REFRESH_MIN);
  assert.equal(fields.refresh_minutes.max, REFRESH_MAX);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.ok(!manifest.config_schema.some((f) => ['secret', 'password'].includes(f.type)));
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  const defaults = normalizeConfig({ stations: '46026' });
  assert.equal(defaults.refreshMinutes, fields.refresh_minutes.default);
  assert.equal(defaults.language, fields.language.default);
});

test('the action and the handlers agree; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(index.includes('app.connected()'));
  assert.ok(index.includes('onDeviceCreated('));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const file of ['src/ndbc.js', 'src/app.js']) {
    const code = read(file).replace(/\/\/.*$/gm, '');
    for (const word of ["'POST'", "'PUT'", "'DELETE'", 'Mozilla']) {
      assert.ok(!code.includes(word), `${file}: never ${word}`);
    }
  }
});

test('every variable has a feature; units only from the core list of their category', () => {
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core (server/utils/constants.js), for the categories used.
  const allowed = {
    'angle-sensor': [],
    'speed-sensor': ['meter-per-second', 'kilometer-per-hour'],
    'distance-sensor': ['mm', 'cm', 'm', 'km', 'inch', 'feet', 'mile'],
    duration: ['microseconds', 'milliseconds', 'seconds', 'minutes', 'hours', 'days'],
    'pressure-sensor': ['pascal', 'hPa', 'kPa', 'bar', 'psi', 'milli-bar'],
    'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  };
  assert.deepEqual(
    Object.keys(FEATURE_DEFS),
    VARIABLES.map((v) => v.key),
  );
  for (const variable of VARIABLES) {
    const def = FEATURE_DEFS[variable.key];
    assert.ok(def.category in allowed, def.category);
    if (def.unit === undefined) assert.deepEqual(allowed[def.category], [], variable.key);
    else assert.ok(allowed[def.category].includes(def.unit), `${variable.key}: ${def.unit}`);
    // The range of the feature holds every converted value of the variable.
    const factor = variable.factor ?? 1;
    assert.ok(def.min <= variable.min * factor && def.max >= variable.max * factor, variable.key);
  }
});

test('the published devices follow the core rules on supported_options (none here)', () => {
  const gladys = createFakeGladys({ selector: 'ndbc' });
  for (const device of buildDevices(gladys, normalizeConfig({ stations: '46026, PSBM1' }))) {
    for (const feature of device.features) {
      const options = feature.supported_options ?? [];
      // The rules of the core (normalizeSupportedOptions): label a plain
      // non-empty string without outer spaces, value integer or string,
      // unique, no other key. A single error rejects the whole Discovery.
      const values = new Set();
      for (const option of options) {
        assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0 && option.label === option.label.trim());
        assert.ok(Number.isInteger(option.value) || typeof option.value === 'string');
        assert.ok(!values.has(String(option.value)));
        values.add(String(option.value));
      }
      assert.equal(options.length, 0);
      assert.equal(feature.read_only, true);
    }
  }
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /public domain/i);
  assert.match(notices, /ndbc-api/);
  assert.match(notices, /MIT License/);
});

test('the docs say what the data is not', () => {
  for (const file of ['docs/en.md', 'README.md']) {
    assert.match(read(file), /not\s+an\s+official\s+source/i, file);
    assert.match(read(file), /not\s+for\s+navigation/i, file);
  }
  assert.match(read('docs/fr.md'), /pas\s+une\s+source\s+officielle/i);
  assert.match(read('docs/fr.md'), /pas\s+pour\s+la\s+navigation/i);
});
