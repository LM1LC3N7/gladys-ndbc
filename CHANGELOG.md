# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the NOAA NDBC buoys and coastal stations in Gladys, read from
  the public realtime files (up to 10 stations, one device each, 14 features:
  wind, waves, pressure, air and water temperature, dew point, visibility,
  tide). A value is published once, only when its observation is under 2 hours
  old against the NDBC server time; missing values (`MM`) are never published.
- One request at a time, 3 s apart, every 10 to 180 minutes; only the head of
  each file (`Range`), `If-None-Match`; a 429 pauses every read (kept in
  `/data`), a 5xx or another status backs off its station alone; a
  station without realtime file is tried again after 1 h, doubled up to 24 h;
  stations added to the configuration are read alone; a round interrupted by
  a saved configuration or a reconnection keeps the answer of the request
  that went (shown at once in the status, counted as the read of that
  station) and reads the stations it had not read right after.
- Station ids of 4 or 5 characters (the Gulf of Mexico platforms: KATP...).
- The age of an observation counts the `Age` of a cached answer; a wave
  period of 0 s is missing.
- Status per station (values under 2 h old, silent, every value missing, read
  failure), updated when a value turns 2 h old; "Show the last read" button.
