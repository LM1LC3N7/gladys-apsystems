# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15). It
reads **APsystems EZ1** micro-inverters (balcony solar) on the LAN through
their local API (HTTP, port 8050, "Local mode" enabled in the AP EasyPower
app) and exposes each one as a Gladys device (production power total and per
DC input, energy of the day, lifetime index, power limit, on/off, alarms),
with scene triggers, scene actions and a dashboard widget. Local only.
Unofficial: not affiliated with APsystems. Sibling of `gladys-hoymiles`
(same solar vocabulary: feature keys, triggers, widget).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit.

## Architecture

```
index.js            SDK wiring only (handlers registered before connect())
src/app.js          ApsystemsApp: identification, discovery, reading loop,
                    the night, commands, scene actions, widget, test button
src/ez1.js          the local API client: every endpoint, one queue per inverter
src/model.js        EZ1 JSON -> inputs, limit, on/off, alarms; the day energy
                    and lifetime index counters (pure)
src/devices.js      the inverter device, feature keys, external ids, feature
                    ids (UUID v5), states (pure)
src/triggers.js     readings -> scene events (pure)
src/widget.js       the "solar" widget (pure)
src/config.js       config_schema normalized, the `hosts` grammar
src/constants.js    port, pacing, thresholds, manifest keys
src/i18n.js         runtime texts (en/fr)
src/http.js         the only HTTP access (GET on the LAN, timeout, Ez1Error)
src/gateways.js     the ECU gateways: pace (kept across restarts of the app),
                    ECU and micro-inverter devices, states, status, scenes
src/ecu.js          the only TCP access (port 8899): one connection per
                    query, one at a time for all ECUs, pauses (EcuQueue)
src/ecu-protocol.js ECU frames -> objects, bounded and checked (pure)
test/fixtures/      EZ1 answers shaped after the manual and user reports
test/helpers/       fake EZ1 inverters (fetch, firmware variants, sleep),
                    fake timers; Gladys is the SDK's fake
```

## What is known of the EZ1 local API

- **Source**: APsystems "EZ1 Local API User Manual" v1.1 (2023-11-07, a copy
  is attached to an ioBroker forum post), the `apsystems-ez1` Python library
  2.7.0 (Sonnenladen, used by Home Assistant) and Home Assistant's
  `apsystems` integration and its issues. No inverter was available.
- Every answer: `{ data, message: "SUCCESS" | "FAILED", deviceId }`, plain
  GETs. Numbers come as numbers (`getOutputData`) or strings (the rest).
- `getOutputData`: `p1/p2` W, `e1/e2` kWh "since start-up" (the EZ1 starts
  every morning: today's energy, but it restarts from 0 if the inverter
  restarts during the day), `te1/te2` kWh lifetime. Some firmware adds keys
  (`originalData`): ignored; any `p<n>` is an input.
- `getOnOff` / `setOnOff?status=`: **"0" = on, "1" = off**. When off, the
  local API keeps answering.
- `getAlarm`: `og` off grid, `oe` output fault, `isce1/isce2` DC short
  circuit, "0" normal / "1" alarm.
- Firmware variants (user reports): the 2.x `_b` firmware (`EZ1 2.0.1_b`)
  answers `getMaxPower` with `power` instead of `maxPower` and has no
  `getOnOff` (404 text/html); `1.1.2_b` reportedly lost `setMaxPower` and
  `setOnOff`. The EZ1-D (`EZ1D1.0.0`, 80-1800 W) uses `getDefaultMaxPower` /
  `setDefaultMaxPower`, and `setDefaultMaxPower` sometimes answers FAILED.
- `setMaxPower` outside the bounds answers FAILED. Whether the limit is kept
  in flash memory is not documented (one user saw it back at 800 W after an
  inverter reboot).
- The night: the EZ1 is powered by its panels; without sun its Wi-Fi goes
  away (timeouts, unreachable host). Not an error.
- Firmware 1.9.0 users reported a lifetime counter that went down: hence
  `indexStep`.

## What is known of the ECU local protocol

- **Source**: HAEdwin/homeassistant-apsystems_ecu_reader 2.15.0
  (`ecu_api.py`, `ecu_helpers.py`, `const.py`) and its source
  ksheumaker/homeassistant-apsystems_ecur, both Apache-2.0 (credited in
  `THIRD_PARTY_NOTICES.md`). No ECU was available: every offset is the
  reference's, kept in `src/ecu-protocol.js` only.
- TCP 8899, one query per connection: `APS1100160001END\n` (the ECU), then
  `APS1100280002<ECU id>END\n` (the inverters). Answer frame: `APS11`, 4
  ASCII digits = length - 1, the command, the payload, `END` + one byte.
- The ECU hangs when asked too often: 300 s at least, one connection at a
  time, pauses, longer waits after failures (see `ECU` in
  `src/constants.js`). Never add a query without weighing that.
- Read-only in v1 (see TODO.md "Decisions").

## Rules

- **Unofficial.** Every user-facing surface says "unofficial connector, not
  affiliated with APsystems". Never use the APsystems logo.
- **Keys are forever**: the manifest keys and the alarm ids
  (`src/constants.js`), the feature keys (`FEATURE` in `src/devices.js`:
  `power`, `power_<n>`, `energy_today`, `energy_total`,
  `energy_total_production`, `limit`, `switch`, `reachable`, `alarm_<id>`),
  the external id shape `inverter:<deviceId>` and the feature ids derived
  from them (`uuidOf`) are stored in user scenes and dashboards, and shared
  with `gladys-hoymiles`. Never rename them. Same for the ECU: the config
  keys `ecu_hosts` / `ecu_poll_interval`, the external ids `ecu:<ECU id>`
  and `ecu_inverter:<inverter id>`, the keys of `ECU_FEATURE`.
- **The scene vocabulary is gladys-hoymiles'**: the device select is named
  `inverter` everywhere (the trigger fields, the `set_power_limit` and
  `get_production` fields, the widget setting) and the events carry the
  device external id in it (the core matches fields by equality); the
  variables are `name` (the device name), `serial` (the EZ1 deviceId),
  `power`, `energy_today`, and for an alarm `alarm` (an alarm id) and
  `input` (the DC input of a short circuit). `get_production` answers
  `power`, `energy_today`, `energy_total`, `producing`, `sleeping`,
  `inverters`, like hoymiles'.
- **The categories** (decided, see TODO.md): `power` and `power_<n>` are
  `energy-production-sensor` / `power` (W); `energy_today` is
  `energy-production-sensor` / `daily-production` (kWh); `energy_total` is
  `energy-production-sensor` / `index` (kWh), the source of the core's
  production pipeline; `energy_total_production` is
  `energy-production-sensor` / `thirty-minutes-production` (kWh); `limit` is
  `switch` / `dimmer` with the inverter's min/max in W (the Gladys UI renders
  a slider for it, nothing else fits a writable number of watts); `switch` is
  `switch` / `binary`; `reachable` and the alarms are `unknown` / `binary` (as
  the Livebox "internet" feature).
- **The energy index** (as in `gladys-hoymiles`): the core turns the deltas
  of `energy_total` into 30-minute production only into a
  `thirty-minutes-production` feature whose `energy_parent_id` is the index
  feature, and derives that feature itself for consumption indexes only
  (`addEnergyFeatures`, Gladys 5.1/5.2). So the device declares both, with
  ids computed as UUID v5 of the feature external ids: stable across
  discoveries. The integration never publishes a state on the 30-minute
  feature.
- **Local only**: the client only talks to the addresses typed in the
  configuration (or stored in a created device's `host` param), plain HTTP
  on the LAN, no redirect followed.
- **Be polite with the inverter** (it answers slowly over its own Wi-Fi):
  one request at a time per inverter (`Ez1Client.serial`); `getOutputData`
  every `poll_interval` (30 s by default, never below 10); `getAlarm` and
  `getOnOff` every 5 minutes; `getDeviceInfo` and the limit every hour; an
  unidentified address every 5 minutes; a sleeping inverter every 5
  minutes. Producing, one inverter costs about 150 requests an hour.
- **The night is not an error**: 3 silent readings (`MISSES_BEFORE_ASLEEP`)
  and the inverter is asleep: powers 0, counters kept (not published),
  `reachable` 0, no red status, no event but the evening's
  `production_stopped`. Red only for an inverter that vanished while
  producing at least `AWAKE_POWER` (50 W), answered something that is not
  its own EZ1 (another `deviceId`, an HTML page), or stayed silent for
  `LONG_SILENCE` (a day).
- **One event per transition** (`src/triggers.js`): the first reading fires
  nothing; production started/stopped with hysteresis (10 W for a minute,
  under 5 W for 15 minutes); an alarm fires when a flag goes from 0 to 1
  between two alarm readings of the same waking period (the first reading
  after waking up only arms: the EZ1 checks the grid each morning).
- **No event from an action** (`get_production` reads only an inverter never
  tried since the start, and fires nothing), and **never write the limit on
  our own**:
  only a user command or a scene writes it, and not when the inverter
  already has that value (read first). No configured "default limit".
- **The lifetime index never jumps down then up** (`indexStep`): a lower
  value is published after 3 readings in a row, so a glitch is never counted
  as production by the core.
- **Built blind**: every endpoint name lives in `src/ez1.js`, every field
  name in `src/model.js`, so a user report fixes one place. `TODO.md` lists
  what a tester must confirm.
- **Read-only rootfs**: write nothing on disk; the day counters live in
  memory.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Manifest texts** are `{ en, fr }` objects; the catalog description holds
  10 to 100 characters per language; `test/manifest.test.js` ties the
  manifest to the code (keys, defaults, bounds, trigger fields and variables
  against the events the code fires).
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` kept in
  sync. Comments explain why, in English.
- **Tests never touch the network** (`installInverters` replaces `fetch`, `installEcus` the ECU transport);
  the widget contents pass the SDK's `validateWidgetContent`.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is
  not a bug in the code.
- The Docker image cannot be built in the Claude Code cloud container (no
  network for `apk` inside `docker build`): the CI builds it.

## Checking an answer against a real inverter

By day, on the same LAN as the inverter (local mode on, "Continuous"):

```bash
IP=192.168.1.50
for e in getDeviceInfo getOutputData getMaxPower getAlarm getOnOff; do
  curl -s "http://$IP:8050/$e"; echo
done
```

Anonymize an answer (`deviceId`, `ssid`, `ipAddr`) before it becomes a
fixture.
