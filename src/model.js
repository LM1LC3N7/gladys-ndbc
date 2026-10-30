// -----------------------------------------------------------------------------
// What a station file says at the time of the server: per variable, its
// newest value and the time of that observation. A value is never carried
// from one variable to another, never invented: a variable missing (`MM`) in
// every recent line has no value, and the age of each value is told against
// the `Date` of the answer, never against the local clock.
// -----------------------------------------------------------------------------

import { FUTURE_SLACK, VARIABLES } from './constants.js';

/**
 * `{ newestAt, values: { key: { value, at } } }` from the rows of a file:
 * `newestAt` the time of the newest line (even when all its values are
 * missing), each value from the newest line that has one. Lines dated after
 * the server time (beyond FUTURE_SLACK) are not believed; two lines with the
 * same time: the first (newest in the file) wins.
 */
export function latestValues(rows, serverDate) {
  let newestAt = null;
  const values = {};
  const seen = new Set();
  const believed = rows
    .filter((row) => row.at <= serverDate + FUTURE_SLACK)
    .filter((row) => (seen.has(row.at) ? false : seen.add(row.at)))
    .sort((a, b) => b.at - a.at);
  for (const row of believed) {
    if (newestAt === null) newestAt = row.at;
    for (const { key } of VARIABLES) {
      if (values[key] === undefined && row.values[key] !== undefined) {
        values[key] = { value: row.values[key], at: row.at };
      }
    }
  }
  return { newestAt, values };
}
