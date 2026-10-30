// -----------------------------------------------------------------------------
// The configuration filled in by the user, read strictly: an empty field is
// absent (never 0), a number is a plain integer, a station id is four or five
// letters or digits (NDBC ids: `46026`, `PSBM1`, `KATP`), upper-cased as on the server. A
// refused field is named, never echoed back.
// -----------------------------------------------------------------------------

import { REFRESH_DEFAULT, REFRESH_MAX, REFRESH_MIN, STATIONS_MAX } from './constants.js';

export const LANGUAGES = ['en', 'fr'];

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * An NDBC station id: 4 or 5 ASCII letters or digits (5 for buoys and C-MAN
 * stations, 4 for the Gulf of Mexico platforms: KATP, KGBK...; seen in
 * `latest_obs.txt` on 2026-10-30, 852 ids of 5 and 14 of 4). It goes into a URL:
 * nothing wider.
 */
export const STATION_ID = /^[A-Z0-9]{4,5}$/;

/**
 * The station ids: comma, semicolon or space separated, unique. A part that
 * is not an id is left out (and named as an error); past STATIONS_MAX, the
 * first ones are kept.
 */
export function readStations(value) {
  if (isBlank(value)) return { stations: [], errors: ['required'] };
  if (typeof value !== 'string' || value.length > 500)
    return { stations: [], errors: ['stations_invalid'] };
  const stations = [];
  const errors = [];
  for (const part of value.split(/[\s,;]+/)) {
    if (part === '') continue;
    const id = part.toUpperCase();
    if (!STATION_ID.test(id)) {
      if (!errors.includes('stations_invalid')) errors.push('stations_invalid');
      continue;
    }
    if (!stations.includes(id)) stations.push(id);
  }
  if (stations.length > STATIONS_MAX) {
    errors.push('stations_too_many');
    stations.length = STATIONS_MAX;
  }
  if (stations.length === 0 && errors.length === 0) errors.push('required');
  return { stations, errors };
}

/** The read interval: a plain integer number of minutes, else NaN; blank is null. */
export function readMinutes(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  return /^\d{1,4}$/.test(text) ? Number(text) : NaN;
}

/**
 * The configuration the app runs with. `stations` holds the valid ids only;
 * `errors` names each refused field (never its value).
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const language = LANGUAGES.includes(source.language) ? source.language : 'en';
  let refreshMinutes = readMinutes(source.refresh_minutes);
  if (refreshMinutes === null) refreshMinutes = REFRESH_DEFAULT;
  if (
    Number.isNaN(refreshMinutes) ||
    refreshMinutes < REFRESH_MIN ||
    refreshMinutes > REFRESH_MAX
  ) {
    errors.push({ field: 'refresh_minutes', code: 'refresh' });
    refreshMinutes = REFRESH_DEFAULT;
  }
  const read = readStations(source.stations);
  for (const code of read.errors) errors.push({ field: 'stations', code });
  const { stations } = read;
  return { language, refreshMinutes, stations, errors };
}
