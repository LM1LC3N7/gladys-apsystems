# gladys-apsystems

[Gladys Assistant](https://gladysassistant.com) external integration for
**APsystems EZ1 micro-inverters** (balcony solar) through their local API:
live production per panel, daily and lifetime energy, power limit, on/off,
alarms, scene triggers, scene actions and a dashboard widget. **Unofficial,
not affiliated with APsystems.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (ApsystemsApp)
                 ├─ src/ez1.js        the local API client, one queue per inverter
                 ├─ src/http.js       the only network access (GET on the LAN, timeout)
                 ├─ src/model.js      EZ1 JSON -> inputs, limit, alarms; day and index counters (pure)
                 ├─ src/devices.js    the inverter device, feature keys, states (pure)
                 ├─ src/triggers.js   readings -> scene events (pure)
                 └─ src/widget.js     the "solar" widget (pure)
```

- **Identification**: each address typed in the configuration is asked
  `getDeviceInfo` (serial, firmware, power bounds), then what its firmware
  offers (`getMaxPower` or the EZ1-D `getDefaultMaxPower`, `getOnOff`, the
  number of DC inputs). Discovery lists the inverters that answered.
- **Reading**: only the inverters the user created, `getOutputData` every
  `poll_interval` seconds (30 by default, 10 at least), `getAlarm` and
  `getOnOff` every 5 minutes, `getDeviceInfo` and the limit every hour; the
  requests to one inverter never overlap.
- **The night**: three readings without an answer and the inverter is
  asleep: powers at 0, counters kept, one try every 5 minutes, no red
  status. Only an inverter that vanished while producing is reported.
- **Energy monitoring**: the lifetime energy is an `energy-production-sensor`
  / `index` feature, with a `thirty-minutes-production` feature linked to it
  (`energy_parent_id`, both ids a UUID v5 of the feature external id) that
  the Gladys core fills from the index deltas.
- **Triggers** come from consecutive readings, with hysteresis: the first
  reading fires nothing. Their `inverter` field is the device (the same
  vocabulary as `gladys-hoymiles`: `inverter`, `name`, `serial`).
- **Scene actions**: `set_power_limit` and `get_production` (one inverter or
  all of them, from the last readings).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npx github:GladysAssistant/integration-store .  # store admission checks
```

The fixtures in `test/fixtures/` are shaped after the APsystems "EZ1 Local
API User Manual" (v1.1) and the answers users posted for the other firmware
(no inverter was available): see [TODO.md](TODO.md).

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
