# TODO

## Before announcing

- [ ] Test with a real EZ1-M (firmware 1.x) and a real Gladys 5.1+, over a
      whole day: identification, Discovery, the readings, the evening
      (asleep, `production_stopped`), the morning (`production_started`), the
      power limit, on/off, the widget. The module was built without an
      inverter.
- [ ] Create an inverter device and check in the Gladys energy screens that
      the "Lifetime energy (30-minute production)" feature is linked to the
      index (`energy_parent_id`) and gets a production every 30 minutes.
- [ ] Test an inverter on the 2.x `_b` firmware (no on/off, limit read as
      `power`) and, if anyone has one, an EZ1-D.
- [ ] Reserve "APsystems EZ1" in the forum thread t/10385, then add the
      `gladys-assistant-integration` topic to publish in the store.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).

## To confirm (built blind)

- [ ] `e1`/`e2` restart from 0 every morning (the manual says "since
      start-up"), and the integration's day counter matches the AP EasyPower
      app's "today" over a day with a mid-day restart.
- [ ] How an EZ1 goes to sleep: timeouts or refused connections, how long
      after the power reaches 0, and whether it answers with 0 W for a while
      at dusk and dawn (the `AWAKE_POWER` threshold of 50 W assumes the
      power fades before the Wi-Fi goes).
- [ ] The alarm flags at wake-up: is `og` (off grid) up while the inverter
      checks the grid each morning? The first alarm reading after waking up
      only arms for that reason; confirm it is enough.
- [ ] Whether `setMaxPower` writes to flash memory (the value surviving a
      night, or back at the maximum after a reboot as one user saw). The
      integration already never writes it on its own and skips identical
      values.
- [ ] The EZ1-D: `getDefaultMaxPower` / `setDefaultMaxPower` (one user
      report), its number of DC inputs (`p3`/`p4`?) and its alarm keys
      (`isce3`/`isce4`?). The parsing already takes any `p<n>` / `isce<n>`.
- [ ] The `1.1.2_b` firmware reportedly lost `setMaxPower` and `setOnOff`:
      what does it answer (404, FAILED)? A failed write is reported to the
      user; the limit feature is still offered when `getMaxPower` answers.
- [ ] `energy_today` is `energy-production-sensor` / `daily-production`,
      updated live through the day: check that the energy monitoring does not
      read that type as one dated value per day (it would then need
      `keep_history: false` or another type). Coordinate with
      `gladys-hoymiles`.
- [ ] The `limit` feature as `switch` / `dimmer` in W renders a usable slider
      between the inverter's bounds, and no core automation treats it as a
      light dimmer.

## ECU gateways (built blind, never tested with a real ECU)

- [ ] Test with a real ECU-B (the forum user of t/11201: DS3-L behind an
      ECU-B), then an ECU-R and an ECU-C: identification, Discovery, a day
      and a night, the index, the pace (no hang over a week).
- [ ] The frame offsets are the reference's (HAEdwin 2.15.0): confirm the
      DS3-L type code ("01" or "04") and its model prefix, and that
      `today_energy` resets at the ECU's midnight.
- [ ] Gladys hands the devices with `last_value_changed` on each feature:
      the ECU index guard dates its reference with it after a restart (else
      with the start time, which holds a large rise until a configuration
      save). Check on a real Gladys.
- [ ] The DS3 voltage: the reference reads two voltages and shows the first
      (one AC voltage); confirm it is the grid voltage.

## Decisions

- **ECU read-only in v1**: no on/off per inverter, no power limit, no zero
  export, no ECU reboot (the reference has them for the ECU-R-Pro and the
  ECU-C only, through the ECU's HTTP pages). The "set the solar power
  limit" action refuses an ECU device. To add once a tester confirms the
  readings.
- **ECU pace**: `ecu_poll_interval` 300 s by default and at least (the
  reference recommends 300 s; the ECU hangs when asked too often), one TCP
  connection at a time for every ECU (the reference's global lock), one
  connection per query (the ECU-R-Pro needs it), a 5 s pause between two
  queries (ksheumaker waited 5 s per query), 2 connection attempts per
  query, 10 s per query. After a failure: wait the interval, then twice as
  long each time, up to 30 minutes (or the interval if longer); red after
  3 failed readings. The pacing state survives a reconnection to Gladys
  (`start()`), so a flapping link never bursts queries. The test button
  reuses a reading younger than the interval.
- **Not sent**: the signal-strength query (0030) of the reference, one more
  connection for a value not exposed; the ECU-C meter data (HTTP). Ideas
  below.
- **Unknown inverter type**: the reference skips 9 bytes and goes on; here
  the list stops at that inverter (it keeps only `online`), since the next
  offsets would be guesses that invent devices.
- **ECU index guard** (`ecuIndexStep`): never 0; a fall published after 3
  readings in a row never decreasing; a rise larger than 2 kW per inverter
  the ECU knows over the time since the last published value (+0.5 kWh) is
  held, never confirmed by repetition nor time, accepted only by a save of
  the configuration (`app.configUpdated`). In memory only (read-only
  rootfs): after a restart the reference is the value Gladys holds.
- **Triggers and widget**: the ECU fires `production_started` /
  `production_stopped` on its total power (same hysteresis; with a reading
  every 5 minutes, "started" comes at the second reading). The
  micro-inverters fire nothing (the ECU already does) and are not summed in
  the widget totals nor in `get_production` (no double count); picked
  alone, they show their power and panels.
- **External ids**: `ecu:<ECU id>` and `ecu_inverter:<inverter id>`, the
  inverter's own id so it survives an ECU replacement. The EZ1 keys and
  external ids are untouched.
- **The EZ1 index rule (`indexStep`) is not changed** so that EZ1 users see
  no change: it still publishes a lower value (0 included) after 3
  readings, and a jump back up. To align with the ECU guard in a later
  version (to review).

## Ideas

- ECU: the Zigbee signal strength (query 0030), the ECU-C meter (CT)
  data, then on/off and the per-inverter limit for the ECU-R-Pro / ECU-C.
- ECU: production started/stopped per micro-inverter, if users want it.

- Per-input energy of the day and lifetime (`e<n>`, `te<n>`) as features.
- A house-wide "solar" device summing several inverters.
- Read the sunrise/sunset of the house (`location: true`) to tell the night
  from an outage without the power threshold.
- Once the flash question is answered: a rate-limited "follow the house
  consumption" limit for zero-export setups.
