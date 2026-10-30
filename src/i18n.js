// -----------------------------------------------------------------------------
// Every text the integration writes, in English and French: the device and
// feature names (in the language of the configuration), the status and the
// test button (both languages, Gladys picks). Times are shown in UTC, the
// time of the NDBC files: a station can be on any coast.
// -----------------------------------------------------------------------------

const FEATURES = {
  en: {
    'wind-direction': 'Wind direction (degrees)',
    'wind-speed': 'Wind speed',
    'wind-gust': 'Wind gust',
    'wave-height': 'Significant wave height',
    'dominant-wave-period': 'Dominant wave period',
    'average-wave-period': 'Average wave period',
    'wave-direction': 'Wave direction (degrees)',
    pressure: 'Sea level pressure',
    'air-temperature': 'Air temperature',
    'water-temperature': 'Water temperature',
    'dew-point': 'Dew point',
    visibility: 'Visibility',
    'pressure-tendency': 'Pressure tendency (3 h)',
    tide: 'Water level (tide)',
  },
  fr: {
    'wind-direction': 'Direction du vent (degrés)',
    'wind-speed': 'Vitesse du vent',
    'wind-gust': 'Rafale',
    'wave-height': 'Hauteur significative des vagues',
    'dominant-wave-period': 'Période dominante des vagues',
    'average-wave-period': 'Période moyenne des vagues',
    'wave-direction': 'Direction des vagues (degrés)',
    pressure: 'Pression au niveau de la mer',
    'air-temperature': "Température de l'air",
    'water-temperature': "Température de l'eau",
    'dew-point': 'Point de rosée',
    visibility: 'Visibilité',
    'pressure-tendency': 'Tendance de la pression (3 h)',
    tide: "Niveau d'eau (marée)",
  },
};

export function featureName(language, key) {
  return (FEATURES[language] ?? FEATURES.en)[key];
}

export function stationName(language, id) {
  return language === 'fr' ? `Bouée NDBC ${id}` : `NDBC buoy ${id}`;
}

/** A time in UTC: "Oct 30, 05:30 UTC" / "30 oct., 05 h 30 UTC". */
export function formatTime(ms, language) {
  if (!Number.isFinite(ms)) return '?';
  const date = new Date(ms);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  if (language === 'fr') {
    const months = [
      'janv.',
      'févr.',
      'mars',
      'avr.',
      'mai',
      'juin',
      'juil.',
      'août',
      'sept.',
      'oct.',
      'nov.',
      'déc.',
    ];
    return `${day} ${months[month]}, ${hh} h ${mm} UTC`;
  }
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[month]} ${day}, ${hh}:${mm} UTC`;
}

/** An age in minutes or hours: "35 min", "4 h". */
export function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

const ERRORS = {
  required: { en: 'is required', fr: 'est obligatoire' },
  stations_invalid: {
    en: 'holds an entry that is not a station id (5 letters or digits, as 46026): left out',
    fr: "contient une entrée qui n'est pas un identifiant de station (5 lettres ou chiffres, comme 46026) : ignorée",
  },
  stations_too_many: {
    en: 'holds more than 10 stations: the first 10 are read',
    fr: 'contient plus de 10 stations : les 10 premières sont lues',
  },
  refresh: {
    en: 'must be a whole number of minutes from 10 to 180 (30 used)',
    fr: 'doit être un nombre entier de minutes de 10 à 180 (30 utilisé)',
  },
};
const FIELDS = {
  stations: { en: 'Stations', fr: 'Stations' },
  refresh_minutes: { en: 'Read interval', fr: 'Intervalle de lecture' },
};

/** The refused fields, named (never their value): `{ en, fr }`. */
export function configErrors(errors) {
  const out = { en: [], fr: [] };
  for (const error of errors) {
    for (const lang of ['en', 'fr']) {
      out[lang].push(`${FIELDS[error.field][lang]} ${ERRORS[error.code][lang]}`);
    }
  }
  return { en: out.en.join('; '), fr: out.fr.join(' ; ') };
}

const FAILURES = {
  network: { en: 'NDBC unreachable', fr: 'NDBC injoignable' },
  timeout: { en: 'NDBC did not answer in time', fr: "NDBC n'a pas répondu à temps" },
  rate: { en: 'NDBC asked to slow down (429)', fr: 'NDBC demande de ralentir (429)' },
  server: { en: 'NDBC server error', fr: 'erreur du serveur NDBC' },
  http: { en: 'unexpected NDBC answer', fr: 'réponse inattendue de NDBC' },
  missing: {
    en: 'no realtime file for this station',
    fr: 'pas de fichier temps réel pour cette station',
  },
  format: {
    en: 'the file cannot be read (format changed?)',
    fr: 'fichier illisible (format changé ?)',
  },
  unreadable_rows: {
    en: 'most lines of the file cannot be read (format changed?)',
    fr: 'la plupart des lignes du fichier sont illisibles (format changé ?)',
  },
  no_date: { en: 'the server time cannot be read', fr: "l'heure du serveur est illisible" },
};

/** The cause of a failure, with the HTTP status when there is one. */
export function failure(kind, status, language) {
  const text = (FAILURES[kind] ?? FAILURES.http)[language === 'fr' ? 'fr' : 'en'];
  return Number.isInteger(status) && ['server', 'http', 'missing'].includes(kind)
    ? `${text} (${status})`
    : text;
}

export const M = {
  starting: { en: 'Starting.', fr: 'Démarrage.' },
  noStation: { en: 'No station to read.', fr: 'Aucune station à lire.' },
  configRetry: ({ seconds }) => ({
    en: `Gladys did not give the configuration; new try in ${seconds} s.`,
    fr: `Gladys n'a pas donné la configuration ; nouvel essai dans ${seconds} s.`,
  }),
};
