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

## Ideas

- Per-input energy of the day and lifetime (`e<n>`, `te<n>`) as features.
- A house-wide "solar" device summing several inverters.
- Read the sunrise/sunset of the house (`location: true`) to tell the night
  from an outage without the power threshold.
- Once the flash question is answered: a rate-limited "follow the house
  consumption" limit for zero-export setups.
