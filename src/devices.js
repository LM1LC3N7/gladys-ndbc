// -----------------------------------------------------------------------------
// One Gladys device per station, read-only. Its id is the NDBC station id
// (`station:46026`), fixed forever: another station is another place, so
// another device. Every station gets the same features, whatever it
// measures: a variable the station does not report simply never gets a value
// (a C-MAN shore station has no waves, many buoys no visibility).
//
// No `poll_frequency`: the app reads NDBC at its own pace.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE } from './constants.js';
import { featureName, stationName } from './i18n.js';

export const stationIds = (gladys, id) => gladys.externalIds(DEVICE_TYPE, id);

/**
 * The feature of each variable. Units only from the core list of each
 * category (DEVICE_FEATURE_UNITS_BY_CATEGORY): the angle sensor has none, its
 * name says "degrees". Temperatures of the water and of the dew point are
 * `probe` (kept out of the room average of the core).
 */
export const FEATURE_DEFS = Object.freeze({
  'wind-direction': { category: C.ANGLE_SENSOR, type: T.SENSOR.INTEGER, min: 0, max: 360 },
  'wind-speed': {
    category: C.SPEED_SENSOR,
    type: T.SPEED_SENSOR.DECIMAL,
    unit: U.METER_PER_SECOND,
    min: 0,
    max: 98,
  },
  'wind-gust': {
    category: C.SPEED_SENSOR,
    type: T.SPEED_SENSOR.DECIMAL,
    unit: U.METER_PER_SECOND,
    min: 0,
    max: 98,
  },
  'wave-height': {
    category: C.DISTANCE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.M,
    min: 0,
    max: 40,
  },
  'dominant-wave-period': {
    category: C.DURATION,
    type: T.DURATION.DECIMAL,
    unit: U.SECONDS,
    min: 0,
    max: 60,
  },
  'average-wave-period': {
    category: C.DURATION,
    type: T.DURATION.DECIMAL,
    unit: U.SECONDS,
    min: 0,
    max: 60,
  },
  'wave-direction': { category: C.ANGLE_SENSOR, type: T.SENSOR.INTEGER, min: 0, max: 360 },
  pressure: {
    category: C.PRESSURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.HECTO_PASCAL,
    min: 800,
    max: 1100,
  },
  'air-temperature': {
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -70,
    max: 60,
  },
  'water-temperature': {
    category: C.TEMPERATURE_SENSOR,
    type: T.TEMPERATURE_SENSOR.PROBE,
    unit: U.CELSIUS,
    min: -5,
    max: 45,
  },
  'dew-point': {
    category: C.TEMPERATURE_SENSOR,
    type: T.TEMPERATURE_SENSOR.PROBE,
    unit: U.CELSIUS,
    min: -80,
    max: 50,
  },
  visibility: { category: C.DISTANCE_SENSOR, type: T.SENSOR.DECIMAL, unit: U.KM, min: 0, max: 182 },
  'pressure-tendency': {
    category: C.PRESSURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.HECTO_PASCAL,
    min: -50,
    max: 50,
  },
  tide: { category: C.DISTANCE_SENSOR, type: T.SENSOR.DECIMAL, unit: U.M, min: -10, max: 10 },
});

export function buildDevice(gladys, id, language) {
  const ids = stationIds(gladys, id);
  return {
    name: stationName(language, id),
    external_id: ids.device,
    params: [{ name: 'station', value: id }],
    features: Object.entries(FEATURE_DEFS).map(([key, def]) => ({
      name: featureName(language, key),
      external_id: ids.feature(key),
      ...def,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    })),
  };
}

export function buildDevices(gladys, config) {
  return config.stations.map((id) => buildDevice(gladys, id, config.language));
}
