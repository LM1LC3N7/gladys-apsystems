// -----------------------------------------------------------------------------
// The "solar" dashboard widget. Pure.
//
// With an inverter picked in the settings: its live tiles (power, today,
// lifetime, bound to the device features), then its panels, its limit, its
// state and its alarms. Without: the totals of every inverter and one row
// each.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { STATUS, T } from './i18n.js';
import { FEATURE, ids } from './devices.js';

const COLORS = {
  producing: WIDGET_COLORS.SUCCESS,
  idle: WIDGET_COLORS.NEUTRAL,
  off: WIDGET_COLORS.WARNING,
  asleep: WIDGET_COLORS.INFO,
  unreachable: WIDGET_COLORS.DANGER,
  waiting: WIDGET_COLORS.NEUTRAL,
};

const pick = (text, language) => (typeof text === 'string' ? text : (text[language] ?? text.en));
const kwh = (value) => (value === null || value === undefined ? null : Number(value.toFixed(2)));
const caption = { type: 'text', text: T.widget.caption, variant: 'caption' };

function alarmLabel(id) {
  const dc = /^dc_(\d+)$/.exec(id);
  return dc ? T.widget.alarms.dc(Number(dc[1])) : (T.widget.alarms[id] ?? { en: id, fr: id });
}

/**
 * One device: `inverter` is { kind, name, deviceId, status, power, inputs,
 * energyToday, energyTotal, limit, alarms } and, for an ECU (`kind`
 * 'ecu'), online and inverters; for a micro-inverter behind an ECU
 * ('micro'), temperature and no energy tiles (the ECU counts the energy).
 */
function singleWidget(inverter, language) {
  const feature = (key) => ids.feature(inverter.deviceId, key);
  const components = [
    { type: 'text', text: inverter.name.slice(0, 40), variant: 'heading' },
    { type: 'value', label: T.widget.power, device_feature: feature(FEATURE.POWER), icon: 'sun' },
  ];
  if (inverter.kind !== 'micro') {
    components.push(
      {
        type: 'value',
        label: T.widget.today,
        device_feature: feature(FEATURE.ENERGY_TODAY),
        icon: 'bar-chart-2',
      },
      {
        type: 'value',
        label: T.widget.lifetime,
        device_feature: feature(FEATURE.ENERGY_TOTAL),
        icon: 'battery-charging',
      },
    );
  }
  const awake = ['producing', 'idle', 'off'].includes(inverter.status);
  const items = [
    {
      label: pick(T.widget.state, language),
      value: pick(STATUS[inverter.status] ?? STATUS.waiting, language),
      icon: 'activity',
      color: COLORS[inverter.status] ?? WIDGET_COLORS.NEUTRAL,
    },
  ];
  if (inverter.kind === 'ecu' && inverter.online !== null && inverter.online !== undefined) {
    items.push({
      label: pick(T.widget.online, language),
      value: `${inverter.online} / ${inverter.inverters ?? '?'}`,
      icon: 'cpu',
      color: inverter.online > 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (inverter.temperature !== null && inverter.temperature !== undefined) {
    items.push({
      label: pick(T.widget.temperature, language),
      value: `${inverter.temperature} °C`,
      icon: 'thermometer',
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  for (const [index, watts] of (inverter.inputs ?? []).entries()) {
    items.push({
      label: pick(T.widget.input(index + 1), language),
      value: `${awake ? watts : 0} W`,
      icon: 'sun',
      color: awake && watts > 0 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (inverter.limit !== null && inverter.limit !== undefined) {
    items.push({
      label: pick(T.widget.limit, language),
      value: `${inverter.limit} W`,
      icon: 'sliders',
      color: WIDGET_COLORS.PRIMARY,
    });
  }
  for (const [id, active] of Object.entries(inverter.alarms ?? {})) {
    if (active) {
      items.push({
        label: pick(T.widget.alarm, language),
        value: pick(alarmLabel(id), language),
        icon: 'alert-triangle',
        color: WIDGET_COLORS.DANGER,
      });
    }
  }
  components.push({ type: 'status', items: items.slice(0, 10) }, caption);
  return { ttl_seconds: 60, components };
}

/** Every inverter: the totals and one row each. */
function totalWidget(inverters, language) {
  const sum = (field) =>
    inverters.reduce((total, inverter) => total + (Number(inverter[field]) || 0), 0);
  const awakePower = inverters.reduce(
    (total, i) => total + (['producing', 'idle', 'off'].includes(i.status) ? i.power || 0 : 0),
    0,
  );
  const components = [
    { type: 'text', text: T.widget.title, variant: 'heading' },
    {
      type: 'value',
      label: T.widget.power,
      value: Math.round(awakePower),
      unit: 'W',
      icon: 'sun',
    },
    {
      type: 'value',
      label: T.widget.today,
      value: kwh(sum('energyToday')),
      unit: 'kWh',
      icon: 'bar-chart-2',
    },
    {
      type: 'value',
      label: T.widget.lifetime,
      value: kwh(sum('energyTotal')),
      unit: 'kWh',
      icon: 'battery-charging',
    },
  ];
  const items = inverters.slice(0, 10).map((inverter) => {
    const awake = ['producing', 'idle', 'off'].includes(inverter.status);
    const alarm = Object.entries(inverter.alarms ?? {}).find(([, active]) => active);
    let value = pick(STATUS[inverter.status] ?? STATUS.waiting, language);
    if (awake) {
      value = `${Math.round(inverter.power ?? 0)} W · ${kwh(inverter.energyToday ?? 0)} kWh`;
    }
    return {
      label: inverter.name.slice(0, 40),
      value: (alarm ? `${value} · ${pick(alarmLabel(alarm[0]), language)}` : value).slice(0, 40),
      icon: 'sun',
      color: alarm ? WIDGET_COLORS.DANGER : (COLORS[inverter.status] ?? WIDGET_COLORS.NEUTRAL),
    };
  });
  components.push({ type: 'status', items }, caption);
  return { ttl_seconds: 60, components };
}

/**
 * The widget content. `inverters` are the created inverters (see
 * singleWidget), `deviceId` the one picked in the settings, if any.
 */
export function solarWidget({ inverters, deviceId, language = 'en' }) {
  if (inverters.length === 0) {
    return {
      ttl_seconds: 300,
      components: [{ type: 'text', text: T.widget.none, variant: 'body' }, caption],
    };
  }
  if (deviceId) {
    const inverter = inverters.find((i) => i.deviceId === deviceId);
    if (inverter) {
      return singleWidget(inverter, language);
    }
  }
  // The micro-inverters behind an ECU are already in its totals.
  const rows = inverters.filter((i) => i.kind !== 'micro');
  return rows.length > 0
    ? totalWidget(rows, language)
    : {
        ttl_seconds: 300,
        components: [{ type: 'text', text: T.widget.none, variant: 'body' }, caption],
      };
}
