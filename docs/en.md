# APsystems EZ1

**Unofficial connector, not affiliated with APsystems.** It reads your
APsystems EZ1 micro-inverters (balcony solar: EZ1-M, and the other EZ1
models that offer the local API) on your local network, through the local
API the inverter opens itself: no cloud, no account, nothing leaves your
home. APsystems is a trademark of Altenergy Power System Inc.

## What you get

| Surface                 | Content                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One device per inverter | **production power** (W, total and per panel), **energy today** (kWh), **lifetime energy** (kWh, a production meter index for the Gladys energy monitoring, with its 30-minute production), **power limit** (W, settable), **on/off**, **reachable**, **alarms** |
| Scene triggers          | **solar production started** (the morning), **solar production stopped** (the evening), **solar inverter alarm** (off grid, output fault, DC short circuit on a panel)                                                                                           |
| Scene actions           | **set the solar power limit** of an inverter, **read the solar production** (power, energy of the day and lifetime, of one inverter or all of them)                                                                                                              |
| Dashboard widget        | **Solar production**: power now, energy of the day and lifetime, per panel, the limit and the state of one inverter, or the totals of all of them                                                                                                                |

## Setup

1. **Enable the local API** on each inverter, once: in the **AP EasyPower**
   app, connect to the inverter (Bluetooth, "Direct connection"), open
   **Settings → Local mode**, enable it and choose **Continuous**. The app
   shows the inverter's IP address.
2. In your router, give each inverter a **fixed address** (DHCP
   reservation): the integration finds the inverters by address.
3. In Gladys, type the addresses in **Inverter addresses**, separated by
   commas: `192.168.1.50, 192.168.1.51`. The port is 8050; add `:port`
   only if yours differs.
4. Save, then click **Test the inverters**: each address answers with its
   model, serial number, firmware and current power. **Do it by day**: an
   EZ1 sleeps at night.
5. Open **Discovery** and add the inverters. Put the **Solar production**
   widget on a dashboard: pick an inverter, or leave it empty for the
   totals of all of them.

Each inverter is read every 30 seconds (option **Refresh interval**, 10 s
minimum: the EZ1 answers slowly); its alarms and on/off every 5 minutes, its
information and power limit every hour.

## The night

An EZ1 is powered by its panels: without sun it switches off, Wi-Fi
included. That is normal and **not an error**: after three readings without
an answer, the inverter is shown **sleeping (night)**, its power reads 0 W,
its energy counters keep their value, and it is only tried every 5 minutes
until it wakes up. The connection status stays green.

The status turns red only when an inverter disappears **while producing**
(at least 50 W at its last answer), or stays silent for a whole day: then
check its Wi-Fi, its address, and that local mode is still on.

**Energy today** is the inverter's own counter since it woke up this
morning; it keeps the evening's value through the night and restarts at
sunrise. A restart of the inverter during the day (a very dark cloud) is
added up, not lost.

## Energy monitoring

The **lifetime energy** feature is a production index: Gladys turns it into
a 30-minute production (the "Lifetime energy (30-minute production)"
feature, which Gladys fills itself) for its energy screens. The index never
jumps down then up: a single low reading (a glitch at wake-up) is ignored,
so it is never counted twice as production.

## Power limit and on/off

- **Power limit**: caps the output, within the bounds the inverter reports
  (30 to 800 W on an EZ1-M). The integration never writes it on its own,
  and does not rewrite a value the inverter already has. Whether the
  inverter keeps it in its memory is not documented by APsystems: a scene
  that changes it every few seconds is not a good idea, once every few
  minutes is plenty.
- **On/off**: stops or restarts the production; the local API keeps
  answering while the inverter is off. Some firmware (the ones ending in
  `_b`, for battery systems) have no on/off: the feature is then not
  offered.

## Scenes

- **Solar production started**: an inverter produced 10 W or more for a
  minute. Variables: the power and the energy of the day so far.
- **Solar production stopped**: under 5 W for 15 minutes, or asleep.
  Variable: `{{triggerEvent.data.energy_today}}`, the energy of the day (a
  good moment for a "today's production" message).
- **Solar inverter alarm**: an alarm went up: **off grid** (check the AC
  connection), **output fault** (the AC connection too), **DC short
  circuit** (check the panel connector of that input,
  `{{triggerEvent.data.input}}`). The first reading after start-up or after
  the night does not fire: the inverter checks the grid each morning.

In each trigger, pick an inverter or leave it empty for any of them. The
variables always hold the inverter's name, `{{triggerEvent.data.name}}`,
and its serial number, `{{triggerEvent.data.serial}}`.

- The action **set the solar power limit** takes an inverter and a value in
  W, and gives `{{limit}}`, the limit applied.
- The action **read the solar production** takes an inverter, or none for
  all of them, and gives `{{power}}` (W), `{{energy_today}}` and
  `{{energy_total}}` (kWh), `{{producing}}`, `{{sleeping}}` and
  `{{inverters}}` (how many were counted), for a message or a condition. It
  uses the last readings; only an inverter not read yet since the start is
  read first.

## Troubleshooting

- **No answer by day**: check the address (a fixed one), that local mode is
  on and set to "Continuous", and that Gladys can reach the inverter's
  network (the integration runs in a container on the Gladys host).
- **"…does not answer: it sleeps without sun"** on a command: the inverter
  is asleep; try again once it produces.
- **No on/off feature**: the firmware has none (see above).
- **The lifetime energy went down**: some firmware reset this counter; a
  single low reading is ignored, a lasting one is published.
- Logs: the integration's log level is set with the `LOG_LEVEL` variable.

## Privacy

Everything stays on your local network: the integration only talks to the
addresses you typed, over HTTP on port 8050.
