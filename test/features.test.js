// -----------------------------------------------------------------------------
// Every feature the integration can publish satisfies the Gladys model
// (numeric min and max, booleans, category, type, unit): the real Gladys
// answers HTTP 422 otherwise, the SDK's fake Gladys does not check it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildEcuDevice, buildEcuInverterDevice, buildInverterDevice } from '../src/devices.js';
import { assertCoreDevice } from './helpers/coreFeature.js';

const gladys = createFakeGladys({ selector: 'apsystems' });

test('every feature of every EZ1 variant has a numeric min and max and the core fields', () => {
  let devices = 0;
  for (const inputs of [undefined, 1, 2, 4]) {
    for (const limitSupported of [undefined, true, false]) {
      for (const switchSupported of [false, true]) {
        for (const bounds of [{}, { minPower: 30, maxPower: 800 }, { minPower: 0, maxPower: 0 }]) {
          const device = buildInverterDevice(gladys, {
            serial: 'E07000012345',
            hostKey: '192.168.1.20',
            inputs,
            limitSupported,
            switchSupported,
            ...bounds,
          });
          assert.ok(
            assertCoreDevice(
              device,
              `ez1 ${JSON.stringify({ inputs, limitSupported, switchSupported, ...bounds })}`,
            ) > 0,
          );
          devices += 1;
        }
      }
    }
  }
  assert.equal(devices, 4 * 3 * 2 * 3);
});

test('every feature of the ECU and of each micro-inverter type has a numeric min and max', () => {
  assert.ok(
    assertCoreDevice(
      buildEcuDevice(gladys, { id: '216000012345', hostKey: '192.168.1.30', inverters: 4 }),
      'ecu',
    ) > 0,
  );
  for (const channels of [undefined, 0, 1, 2, 4]) {
    for (const phases of [undefined, 1, 3]) {
      const device = buildEcuInverterDevice(gladys, { uid: '703000012345', channels, phases });
      assert.ok(assertCoreDevice(device, `ecu inverter ${channels}/${phases}`) > 0);
    }
  }
});
