// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIONS, ALARMS, SCENE_ACTIONS, SCENE_TRIGGERS, WIDGETS } from '../src/constants.js';
import { BOUNDS, DEFAULTS } from '../src/config.js';
import { alarmEvent, productionEvent } from '../src/triggers.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const index = read('index.js');
const app = read('src/app.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.location, undefined, 'the inverters are typed, no house needed');
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-apsystems:${manifest.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-apsystems/main/cover.png',
  );
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial connector/);
  assert.match(manifest.description.fr, /Connecteur non officiel/);
  assert.match(manifest.config_schema[0].description.en, /not affiliated with APsystems/);
});

test('every text is bilingual, every link https', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
  for (const link of manifest.config_schema.flatMap((f) => f.links ?? [])) {
    assert.match(link.url, /^https:\/\//);
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.equal(fields.hosts.default, undefined, 'no address by default');
  assert.equal(DEFAULTS.hosts, '');
  assert.equal(fields.poll_interval.default, DEFAULTS.poll_interval);
  assert.equal(fields.poll_interval.min, BOUNDS.poll_interval.min);
  assert.equal(fields.poll_interval.max, BOUNDS.poll_interval.max);
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  assert.deepEqual(manifest.widgets.map((w) => w.key).sort(), Object.values(WIDGETS).sort());
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(index.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  // The device select is named `inverter` everywhere (shared with gladys-hoymiles).
  assert.equal(manifest.widgets[0].settings[0].key, 'inverter');
  assert.ok(app.includes('settings.inverter'));
  const action = (key) => manifest.scene_actions.find((a) => a.key === key);
  const limit = action(SCENE_ACTIONS.SET_POWER_LIMIT);
  assert.deepEqual(
    limit.fields.map((f) => [f.key, f.required]),
    [
      ['inverter', true],
      ['value', true],
    ],
  );
  assert.deepEqual(
    limit.outputs.map((o) => o.key),
    ['limit'],
  );
  const production = action(SCENE_ACTIONS.PRODUCTION);
  assert.deepEqual(
    production.fields.map((f) => [f.key, f.source, f.required]),
    [['inverter', 'devices', false]],
  );
  assert.deepEqual(
    production.outputs.map((o) => o.key),
    ['power', 'energy_today', 'energy_total', 'producing', 'sleeping', 'inverters'],
  );
});

test('every trigger field and variable is a key of the events the code fires', () => {
  const who = {
    deviceId: 'ext:apsystems:inverter:E07000000001',
    name: 'EZ1',
    serial: 'E07000000001',
  };
  const events = [
    productionEvent('started', { ...who, power: 12 }),
    productionEvent('stopped', { ...who, energyToday: 3.2 }),
    alarmEvent('off_grid', who),
    alarmEvent('dc_1', who),
  ];
  for (const trigger of manifest.scene_triggers) {
    const fired = events.filter((e) => e.key === trigger.key);
    assert.ok(fired.length > 0, trigger.key);
    for (const event of fired) {
      for (const key of [...trigger.fields, ...trigger.variables].map((f) => f.key)) {
        assert.ok(key in event.data, `${trigger.key}: ${key} missing from the event`);
      }
      assert.equal(event.data.inverter, who.deviceId, 'the inverter field is the device select');
      assert.equal(event.data.name, who.name);
      assert.equal(event.data.serial, who.serial);
    }
    // The same vocabulary as gladys-hoymiles: a device select `inverter`, then
    // `name` and `serial` among the variables.
    assert.deepEqual(
      trigger.fields.filter((f) => f.source === 'devices').map((f) => f.key),
      ['inverter'],
    );
    assert.ok(trigger.variables.some((v) => v.key === 'name'));
    assert.ok(trigger.variables.some((v) => v.key === 'serial'));
  }
  const alarm = manifest.scene_triggers.find((t) => t.key === SCENE_TRIGGERS.ALARM);
  assert.deepEqual(
    alarm.fields.find((f) => f.key === 'alarm').options.map((o) => o.value),
    Object.values(ALARMS),
  );
  assert.deepEqual(
    [...new Set(events.filter((e) => e.key === SCENE_TRIGGERS.ALARM).map((e) => e.data.alarm))],
    [ALARMS.OFF_GRID, ALARMS.DC_SHORT_CIRCUIT],
  );
});
