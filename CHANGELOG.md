# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Lifetime energy guard: while a value was held back, a reading below it
  was checked against a margin counted from the last value published, which
  after a long silence could let it through and count many kWh at once. The
  margin now counts from the last held reading (two intervals at least),
  and such a reading becomes the value held, its kWh shown: nothing is
  counted without the user.
- Lifetime energy guard: a reading that did not match an accepted value
  dropped the hold along with the acceptance, so it was checked against the
  margin of an old reference and could count fictitious kWh (an ECU silent
  for days). Only the acceptance is dropped now; the hold and its short
  margin stay, and the reading becomes the value held.
- Lifetime energy guard: during a hold, the first EZ1 reading after the
  night was given every hour since the hold instead of the short dawn
  window, so a jump at dawn could be counted. The dawn window now applies,
  hold or not.

## [0.1.2] - 2026-10-18

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
  The EZ1 keys, external ids and features do not change.
- An "Accept the lifetime energy" button (`accept_index`): a lifetime energy
  value held back (see Changed) is taken only through it, in its direction.
- The index guards and the pace of the ECUs are kept in `/data/state.json`
  (atomic writes): a restart neither forgets a value held back nor queries
  an ECU before its time.

### Changed

- Accepting a lifetime energy value held back is bounded: only a reading
  close to the value shown (plus what the inverters could have produced
  since) is taken, any other reading is held again; the button accepts
  every value held at once and must be pressed again after a restart. A
  reading equal to the last value dates it, and the first EZ1 reading after
  the night gets the short margin, so a glitch at dawn is held.
- `/data/state.json`: a new last value is written at most every 15
  minutes (holds and the ECU pace at once); an incoherent hold read back is
  dropped.

- Store name: "APsystems EZ1 & ECU" (was "APsystems EZ1"), and the
  catalog description.
- The lifetime energy index (EZ1 and ECU) is guarded like the other energy
  integrations: never 0 nor a missing counter (first reading included); a
  rise the inverter could not have produced, or a fall, is held back, shown
  in the connection status (still green) and the test button with both
  values, and taken only with the "Accept the lifetime energy" button, never
  by repetition nor by time. Before, an EZ1 counter that read lower 3 times
  in a row (0 included) was published. An index already at 0 or too low in
  Gladys will see the next value counted once as production.

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-apsystems/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-apsystems/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-apsystems/releases/tag/v0.1.1
