# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- APsystems ECU gateways (ECU-B, ECU-R, ECU-C), asked for on the forum
  (https://community.gladysassistant.com/t/11201/2): a new "ECU gateway
  addresses" field reads each ECU on its local TCP port 8899 (protocol
  ported from HAEdwin's APsystems ECU Reader 2.15.0 and ksheumaker's
  original, Apache-2.0, see `THIRD_PARTY_NOTICES.md`). One device per ECU
  (production power, energy of the day, lifetime energy as a production
  index with its 30-minute production, inverters online, reachable) and one
  per micro-inverter behind it (online, power total and per panel, AC
  voltage, grid frequency, temperature), read-only. The ECU is read every
  5 minutes at most (new "ECU refresh interval" field, 300 s minimum), one
  connection at a time, with a pause between queries and longer waits after
  a failure; at night, inverters offline is "sleeping", never an error. The
  "solar production started/stopped" triggers, the widget and the "read the
  solar production" action cover the ECUs. Never tested with a real ECU.
  Nothing changes for EZ1 users.

### Fixed

- The connection status is sent again at every (re)connection to Gladys,
  which keeps it in memory.
- A device republished in Discovery keeps every feature of the created one.
- The Docker image ships `LICENSE` and `THIRD_PARTY_NOTICES.md`.

- Docs: the outputs of the scene actions come from the variable list
  (`{{<step>.<action>.<key>}}`), not `{{<key>}}`.

## [0.1.1] - 2026-10-14

### Added

- One device per APsystems EZ1 micro-inverter, typed by IP address and
  identified through its local API (port 8050): production power (total and
  per DC input), energy of the day, lifetime energy as a production meter
  index with its 30-minute production for the Gladys energy monitoring
  (declared by the integration, filled by Gladys), power limit (settable
  within the inverter's bounds), on/off (when the firmware offers it),
  reachable, and one binary per alarm (off grid, output fault, DC short
  circuit per input).
- The night: an inverter that stops answering in the evening is shown
  asleep, its powers at 0 W, its counters kept, tried every 5 minutes; the
  connection status turns red only for an inverter that vanished while
  producing or stayed silent for a day.
- Firmware variants: the 2.x `_b` firmware (limit read as `power`, no
  on/off) and the EZ1-D limit endpoints (`getDefaultMaxPower`).
- Scene triggers "solar production started", "solar production stopped"
  (with the energy of the day) and "solar inverter alarm", with the inverter
  as an optional device field and its name and serial number as variables
  (the same vocabulary as the Hoymiles integration).
- Scene actions "set the solar power limit" and "read the solar production"
  (power, energy of the day and lifetime, of one inverter or all of them).
- Dashboard widget "Solar production": one inverter (live tiles, panels,
  limit, state, alarms) or the totals of all of them.
- "Test the inverters" button.

[Unreleased]: https://github.com/LM1LC3N7/gladys-apsystems/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-apsystems/releases/tag/v0.1.1
