// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button results, widget).
// -----------------------------------------------------------------------------

const plural = (n, one, many) => (n === 1 ? one : many);
const round3 = (value) => Number(value.toFixed(3));

/** The state of an inverter, as a label: see `statusOf` in src/app.js. */
export const STATUS = {
  producing: { en: 'Producing', fr: 'En production' },
  idle: { en: 'Not producing', fr: 'Pas de production' },
  off: { en: 'Switched off', fr: 'Éteint' },
  asleep: { en: 'Sleeping (night)', fr: 'En veille (nuit)' },
  unreachable: { en: 'Not answering', fr: 'Ne répond pas' },
  waiting: { en: 'Waiting for a reading', fr: 'En attente d’une lecture' },
};

export const T = {
  noHost: {
    en: 'No inverter yet: type the IP address of each EZ1 (local mode on, port 8050), or of your ECU gateway (port 8899), in the configuration.',
    fr: 'Aucun onduleur : saisissez l’adresse IP de chaque EZ1 (mode local activé, port 8050), ou de votre passerelle ECU (port 8899), dans la configuration.',
  },
  invalidEcuHosts: (positions) => ({
    en: `${positions.length === 1 ? 'Entry' : 'Entries'} ${positions.join(', ')} of the ECU address list ${positions.length === 1 ? 'is' : 'are'} not valid: ignored.`,
    fr: `${positions.length === 1 ? 'L’entrée' : 'Les entrées'} ${positions.join(', ')} de la liste d’adresses ECU ${positions.length === 1 ? 'n’est pas valide : ignorée' : 'ne sont pas valides : ignorées'}.`,
  }),
  held: (name, held) =>
    held.direction === 'up'
      ? {
          en: `${name}: the lifetime energy jumped from ${held.from} to ${held.first} kWh, held back. If it is real, press "Accept the lifetime energy": this difference (${round3(held.first - held.from)} kWh) will be counted as production.`,
          fr: `${name} : l’énergie totale a sauté de ${held.from} à ${held.first} kWh, valeur retenue. Si elle est réelle, cliquez sur « Accepter l’énergie totale » : cette différence (${round3(held.first - held.from)} kWh) sera comptée comme production.`,
        }
      : {
          en: `${name}: the lifetime energy fell from ${held.from} to ${held.first} kWh, held back. If the counter was really reset, press "Accept the lifetime energy" (a fall counts nothing).`,
          fr: `${name} : l’énergie totale est tombée de ${held.from} à ${held.first} kWh, valeur retenue. Si le compteur a vraiment été remis à zéro, cliquez sur « Accepter l’énergie totale » (une baisse ne compte rien).`,
        },
  accepted: (n) => ({
    en: `${n} lifetime energy ${plural(n, 'value', 'values')} held back will be taken at the next reading.`,
    fr: `${n} valeur${plural(n, '', 's')} d’énergie totale retenue${plural(n, '', 's')} ${plural(n, 'sera prise', 'seront prises')} à la prochaine lecture.`,
  }),
  nothingHeld: {
    en: 'No lifetime energy value is held back: nothing to accept.',
    fr: 'Aucune valeur d’énergie totale n’est retenue : rien à accepter.',
  },
  ecu: {
    waiting: {
      en: 'ECU gateway: waiting for its first answer.',
      fr: 'Passerelle ECU : en attente de sa première réponse.',
    },
    notCreated: (found) => ({
      en: `${found} ECU ${plural(found, 'gateway answers', 'gateways answer')}: open Discovery and add ${plural(found, 'it', 'them')} and ${plural(found, 'its', 'their')} inverters.`,
      fr: `${found} passerelle${plural(found, ' ECU répond', 's ECU répondent')} : ouvrez Découverte et ajoutez-${plural(found, 'la', 'les')} avec ${plural(found, 'ses', 'leurs')} onduleurs.`,
    }),
    // No live figure: the status only changes on a transition.
    ok: ({ total, producing, asleep }) => ({
      en: `${total} ECU ${plural(total, 'gateway', 'gateways')}: ${producing} producing${asleep > 0 ? `, ${asleep} with every inverter asleep (night, normal)` : ''}.`,
      fr: `${total} passerelle${plural(total, '', 's')} ECU : ${producing} en production${asleep > 0 ? `, ${asleep} avec tous ses onduleurs en veille (nuit, normal)` : ''}.`,
    }),
    unreachable: (names) => ({
      en: `ECU not answering: ${names.join(', ')}. Check its address, that it is on the network (Wi-Fi or cable) and accepts local access on port 8899; an ECU that hangs comes back after unplugging it for a minute.`,
      fr: `ECU qui ne répond pas : ${names.join(', ')}. Vérifiez son adresse, qu’il est sur le réseau (Wi-Fi ou câble) et accepte l’accès local sur le port 8899 ; un ECU bloqué repart après l’avoir débranché une minute.`,
    }),
  },
  invalidHosts: (positions) =>
    positions.length === 1
      ? {
          en: `Entry ${positions[0]} of the address list is not an IP address or a host name: it is ignored.`,
          fr: `L’entrée ${positions[0]} de la liste d’adresses n’est ni une adresse IP ni un nom d’hôte : elle est ignorée.`,
        }
      : {
          en: `Entries ${positions.join(', ')} of the address list are not IP addresses or host names: they are ignored.`,
          fr: `Les entrées ${positions.join(', ')} de la liste d’adresses ne sont ni des adresses IP ni des noms d’hôte : elles sont ignorées.`,
        },
  notCreated: (found) => ({
    en: `${found} ${plural(found, 'inverter answers', 'inverters answer')}: open Discovery and add ${plural(found, 'it', 'them')}.`,
    fr: `${found} onduleur${plural(found, ' répond', 's répondent')} : ouvrez Découverte et ajoutez-le${plural(found, '', 's')}.`,
  }),
  nobodyAnswers: {
    en: 'No inverter answers yet: normal at night (the EZ1 sleeps without sun). Discovery will list them once they wake up.',
    fr: 'Aucun onduleur ne répond encore : normal la nuit (l’EZ1 dort sans soleil). Découverte les listera à leur réveil.',
  },
  // No live figure here: the status only changes on a transition, so it is
  // not sent to Gladys at every reading.
  ok: ({ total, producing, asleep }) => ({
    en: `${total} ${plural(total, 'inverter', 'inverters')}: ${producing} producing${asleep > 0 ? `, ${asleep} asleep (night, normal)` : ''}.`,
    fr: `${total} onduleur${plural(total, '', 's')} : ${producing} en production${asleep > 0 ? `, ${asleep} en veille (nuit, normal)` : ''}.`,
  }),
  unreachable: (names) => ({
    en: `Not answering while the sun is up: ${names.join(', ')}. Check the inverter's Wi-Fi, its address and that local mode is still on.`,
    fr: `Ne répond pas alors qu’il fait jour : ${names.join(', ')}. Vérifiez le Wi-Fi de l’onduleur, son adresse et que le mode local est toujours activé.`,
  }),
  test: {
    answers: (key, info, output) => ({
      en: `${key}: ${info.model} ${info.serial} (firmware ${info.devVer ?? '?'}), ${output.power} W now, ${output.lifetime ?? '?'} kWh lifetime.`,
      fr: `${key} : ${info.model} ${info.serial} (firmware ${info.devVer ?? '?'}), ${output.power} W en ce moment, ${output.lifetime ?? '?'} kWh au total.`,
    }),
    silent: (key, message) => ({
      en: `${key}: no answer (${message}). Normal at night; by day check the address and that local mode is on (AP EasyPower app, "Continuous").`,
      fr: `${key} : pas de réponse (${message}). Normal la nuit ; de jour, vérifiez l’adresse et que le mode local est activé (application AP EasyPower, « Continu »).`,
    }),
    failed: (key, message) => ({
      en: `${key}: ${message}.`,
      fr: `${key} : ${message}.`,
    }),
    ecuAnswers: (key, ecu) => ({
      en: `${key}: ${ecu.model} ${ecu.id} (firmware ${ecu.firmware ?? '?'}), ${ecu.online ?? '?'} of ${ecu.inverters ?? '?'} inverters online, ${ecu.power ?? 0} W now.`,
      fr: `${key} : ${ecu.model} ${ecu.id} (firmware ${ecu.firmware ?? '?'}), ${ecu.online ?? '?'} onduleur(s) en ligne sur ${ecu.inverters ?? '?'}, ${ecu.power ?? 0} W en ce moment.`,
    }),
    ecuFailed: (key, message) => ({
      en: `${key}: the ECU does not answer (${message}). Check its address and that it is on the network; the ECU is never read more often than its interval (5 minutes by default).`,
      fr: `${key} : l’ECU ne répond pas (${message}). Vérifiez son adresse et qu’il est sur le réseau ; l’ECU n’est jamais lu plus souvent que son intervalle (5 minutes par défaut).`,
    }),
  },
  widget: {
    title: { en: 'Solar production', fr: 'Production solaire' },
    none: {
      en: 'No inverter yet: add one from Discovery',
      fr: 'Aucun onduleur : ajoutez-en un depuis Découverte',
    },
    notLoaded: { en: 'Waiting for the first reading…', fr: 'En attente de la première lecture…' },
    power: { en: 'Power', fr: 'Puissance' },
    today: { en: 'Today', fr: 'Aujourd’hui' },
    lifetime: { en: 'Lifetime', fr: 'Total' },
    input: (n) => ({ en: `Panel ${n}`, fr: `Panneau ${n}` }),
    limit: { en: 'Power limit', fr: 'Limite de puissance' },
    state: { en: 'State', fr: 'État' },
    online: { en: 'Inverters online', fr: 'Onduleurs en ligne' },
    temperature: { en: 'Temperature', fr: 'Température' },
    alarm: { en: 'Alarm', fr: 'Alarme' },
    alarms: {
      off_grid: { en: 'Off grid', fr: 'Hors réseau' },
      output_fault: { en: 'Output fault', fr: 'Défaut de sortie' },
      dc: (n) => ({ en: `DC ${n} short circuit`, fr: `Court-circuit DC ${n}` }),
    },
    caption: {
      en: 'Unofficial connector, not affiliated with APsystems',
      fr: 'Connecteur non officiel, sans lien avec APsystems',
    },
  },
};
