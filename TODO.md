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
      the index guards date the Gladys value with it (else 24 hours back, a
      day of margin for the first reading after a restart). Check on a real
      Gladys.
- [ ] The type 05 (QT2): read as a 4-channel, 3-phase inverter like the
      reference does; to be confirmed by a QT2 owner.
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
  3 failed readings. A connection that could not be opened is tried once
  more; a query that reached the ECU is never sent twice. The pace of each
  address lives in its own bounded table (50 addresses), kept across a
  reconnection to Gladys (`start()`) and saved in `/data/state.json` at
  once after each ECU reading (`nextAt` capped when read back), so neither
  a flapping link nor a restart bursts queries. An address no longer
  configured nor used by a created ECU is dropped from the addresses (also
  right after an ECU moved to a new address), but its pace is kept (bounded
  table): typed again, it keeps its wait. The status ignores an address
  neither configured nor used. Micro-inverter states go out in batches of
  100 with at least 20 s between two batches (Gladys takes 300 states a
  minute). The test button reads an ECU only when it is
  due (`now >= nextAt`), every address in parallel. The ECUs are refreshed
  apart from the EZ1 loop (the EZ1 tick never waits for an ECU).
- **Not sent**: the signal-strength query (0030) of the reference, one more
  connection for a value not exposed; the ECU-C meter data (HTTP). Ideas
  below.
- **Unknown inverter type**: the reference skips 9 bytes and goes on; here
  the list stops at that inverter (it keeps only `online`), since the next
  offsets would be guesses that invent devices.
- **Index guard** (`src/guard.js`, shared by the EZ1 and the ECU, the
  rules of gladys-p1-monitor 44795c4): never 0 nor a missing value, first
  reading included; a rise passes when plausible since the last value
  published, over two intervals at least: EZ1 1.5 x its max power + 0.2 kWh,
  ECU 2 kW x max(inverters, inverters listed, 1) + 0.5 kWh, 80 inverters
  when the ECU says nothing. A fall or a bigger jump is held (never by
  repetition nor time), shown in the status (green) and the test button
  with both values, and taken only by the `accept_index` button (it
  accepts every hold at once). The acceptance is bounded, as in
  gladys-p1-monitor de1e5d6: a value v is taken only if first - slack <= v
  <= first + maxKw x (at - firstAt) + slack, `first` the value shown and
  `firstAt` when it was read; any other value starts a new hold and drops
  the acceptance (the status shows the new one). The acceptance is not
  saved: after a restart the user presses again. A save of the
  configuration accepts nothing. A value equal to the reference dates it
  (`last.at = at`). The EZ1's first reading after the night uses the short
  window (two intervals), never the hours of the night. /data keeps
  { last value, date, held }: a hold is written at once, a new last value
  at most every 15 minutes; when read back, a hold whose `from` is not the
  last value, or whose values are on the wrong side, is dropped, and its
  `firstAt` becomes the time of the load. The Gladys value is dated with
  `last_value_changed` (else 24 hours back). While a value is held, the
  margin counts from the last held reading (`held.at`, two intervals at
  least), never from `last.at`: a reading below the hold that does not fit
  becomes the hold itself, its kWh shown (fix after the youless/p1-monitor
  review).
- **Stale micro-inverters**: a created micro-inverter missing from the last
  valid inverter frame of its ECU, or seen more than 2 intervals ago, is
  published offline at 0 W and shown asleep (waiting if never seen).
- **Best effort**: the firmware and the time zone of the ECU frame are read
  at best (a frame cut there keeps its figures); an inverter frame too short
  for its header is an empty list; an inverter type that is not two letters
  or digits is unknown.
- **Triggers and widget**: the ECU fires `production_started` /
  `production_stopped` on its total power (same hysteresis; with a reading
  every 5 minutes, "started" comes at the second reading). The
  micro-inverters fire nothing (the ECU already does) and are not summed in
  the widget totals nor in `get_production` (no double count), unless
  their ECU is not a created device; picked alone, they show their power
  and panels (an unknown type, without a power feature, shows no power
  tile). States go to Gladys in batches of 100 at most.
- **External ids**: `ecu:<ECU id>` and `ecu_inverter:<inverter id>`, the
  inverter's own id so it survives an ECU replacement. The EZ1 keys and
  external ids are untouched.
- **The EZ1 index uses the same guard** (it replaced `indexStep`, which
  published a lower value, 0 included, after 3 readings): no key, external
  id or feature changes. `outputOf` gives no lifetime (null) when a
  `te<n>` is missing or not a number, and no day energy for an `e<n>`.

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
