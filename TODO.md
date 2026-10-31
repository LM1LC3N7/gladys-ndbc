# TODO

## Before announcing

- [ ] Install it on a real Gladys 5.1+ and create a station: the values in the dashboard, their history.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store (after the first release: the store
      validator needs the GHCR image).
- [ ] Store metadata kept out of the manifest (no `keywords` / `countries` fields): countries US, CA; keywords
      NOAA, NDBC, buoy, bouée, waves, vagues, marine weather, météo marine, Great Lakes, Grands Lacs.

## To confirm over time on the live files

- [ ] A file whose second header line changes a unit (never seen; the column is then left out and named).
- [ ] The latency of the files: seen 10 to 70 minutes on 2026-10-30 (46026: 18 min; 45132, hourly: 68 min).
      Stations that publish later than 2 h would always be "silent".
- [ ] A seasonal buoy taken out (Great Lakes, winter): its file stops, then 404.

## Decisions

- **Version 0.1.0** set by hand in package.json, package-lock.json, the manifest and its `docker_image`
  (`ghcr.io/lm1lc3n7/gladys-ndbc:0.1.0`).
- **SDK `^0.16.0`**, the latest published (checked on the npm registry on 2026-10-30): no change needed for a
  read-only device integration.
- **Source**: the realtime "standard meteorological" files `realtime2/<ID>.txt` only (public domain, no key);
  the reading follows ndbc-api 0.26.07.25.2 (MIT, notice in THIRD_PARTY_NOTICES.md), rewritten in JavaScript:
  columns by name, `MM` and the 99/999/9999 fill values as missing. Checked live on 2026-10-30: HTTP/2 behind
  CloudFront, `Range` answered 206 with `Content-Range`, `ETag` + `If-None-Match` answered 304, ids upper case
  (`psbm1.txt` is a 404), `Last-Modified`, `Cache-Control: max-age=600`.
- **Only the head of a file** (`Range: bytes=0-16383`, `Accept-Encoding: identity`): enough for 15 h of
  10-minute lines; a server ignoring the range is cut at 16 KiB, the partial last line dropped.
- **One device per station, id = the NDBC station id** (another station is another place). Every device has the
  same 14 features; a variable never measured never gets a value. No station name from `activestations.xml`
  (a second source to keep fresh): the device is named "NDBC buoy <id>", the user renames it.
- **Units**: only those of the core list for the category (`DEVICE_FEATURE_UNITS_BY_CATEGORY`): angles have no
  unit (the name says "degrees"); visibility from nmi to km (×1.852 exact), tide from ft to m (×0.3048 exact);
  water temperature and dew point are `temperature-sensor`/`probe` (kept out of the room average, Gladys 5.1.0).
- **2 h freshness**, judged against the `Date` header of the answer (a server date more than 24 h off the local
  clock is not believed: nothing published); lines dated more than 5 min after the server time are ignored.
- **Each observation published once**: per feature, the time of the last published observation in `/data`
  (marked before `publishStates`, given back if Gladys refuses it); stamps more than a day in the future are not
  believed at load; 50 stations kept at most.
- **A device created after a read** gets the values of that read still under 2 h old (from memory).
- **Pace**: 3 s between requests (ndbc-api uses 2 s); interval 10-180 min (30). Review r1: stations added to the
  list are read alone at once, at most once a minute (CHANGE_GAP), the others keep their turn; a 429 pauses
  every read (5 min doubled, ≤ 6 h, in `/data`); a 5xx or another status on one station backs that station off
  alone (2 min doubled ≤ 6 h, Retry-After honoured, in memory), the others read at their pace; a full round where
  every station read answered 5xx/other also pauses every read (2 min doubled, in `/data`); 404/410: 1 h doubled
  up to 24 h, in memory. Every back-off has its own timer (never rounded to a round). Network, timeout, 429 and
  pause failures are read again before the next round (pause end, else 2 min doubled), format failures not.
- **Station ids**: 4 or 5 letters or digits (review r1: `latest_obs.txt` of 2026-10-30 lists 852 ids of 5 and 14
  of 4, the Gulf of Mexico platforms KATP, KGBK...; `realtime2/KATP.txt` answers in the same format).
- **Server time = Date + Age** (review r1: CloudFront answers carry the Date of the origin and an `Age` up to
  576 s, 304 included); `Age` whole seconds, at most a day. A Retry-After date stays relative to Date.
- **Interrupted round** (review r2): a configuration saved or a reconnection in the middle of a round keeps the
  answer of the request that went (unless stopped) and leaves the stations not read yet due at once for the next
  start; a full round clears them. A copy without `Age` stays undetectable (said in the docs). Review r3: the
  status is composed again right after a kept answer (late values, 429, back-off), once the next round is armed;
  the station whose request is still out is never due again before its answer (`dueStations` and `leftBefore`
  skip it, so neither a second request nor an empty round in a loop), a station whose request goes is no longer
  "unread" (a full round that started before the late answer does not read it twice), and a kept answer that
  fails otherwise than 404/5xx/other status ends the back-off of its station, as in a round. Tested with answers
  still in flight when the configuration is saved (`test/app.test.js`, scenarios s14/s15 of the review).
- **Wave periods** (DPD, APD) of 0 s are "not available" (partner buoys send `DPD 0` with a wave height).
- **History**: values are published without `created_at` (a recent value must reach the scenes): Gladys dates
  them at publication, up to about an hour after the observation for hourly stations; said in the docs.
- **/data**: read and written asynchronously, each wait bounded to 2 s (a frozen /data is "unreadable" and never
  holds a read); a file that is not a plain file (FIFO, link, directory), over 1 MB or not JSON is unreadable and
  never overwritten; the temporary file is removed before each write (`wx`). A /data that cannot tell the last
  attempt: the first read waits 10 min (the minimum interval) after the start.
- **Status**: no relative age in the text (it would change every minute); a timer recomposes it when a value
  shown as under 2 h old turns older. The global lines (pause, next read, configuration, /data) come first and
  stay whole; the station lines are shortened when the long ones would pass 1500 characters. "Connected" only when the last read of at least one station is a success
  with a value under 2 h old.
- **States per minute**: 250 at most (sliding minute); the rest waits for the next read.
- **No widget, no scene trigger, no scene action** in 0.1.0.
- **Equivalent mutants** (guards kept, no test can tell them apart): the "frozen" case of `checkData` (`persist()`
  already refuses a frozen /data, so `dataTells` is false either way); the `wx` flag of the temporary file (the
  file was removed just before; `wx` only matters for a race in between); the pause check of the round loop
  (the same check in `request` answers `paused`, handled the same way); the generation check right after
  `load()` (the one after `publishDevices` returns before anything else is done); the coalescing of `start`
  (an older start that still runs stops at its next generation check); the clamp of a retry to the end of a pause
  (the next read waits for the end of the pause anyway); `read > 0` vs `read >= 0` and counting paused or stopped
  reads (`refused` is only set after a read went); `pauseUntilMono` reset by a success, in a round and in
  `keepLate` (one request at a time: a success never arrives during a pause, the pause is already over); a
  removed station left in the unread list by `applyConfig` (the round only reads configured stations: at most one
  empty round); the unread list cleared at the start of a full round (each station read leaves it; one backed off
  would only start one more round that skips it).
- **Mutation check**: `memcap node .github/scripts/mutants.mjs [name]` breaks each guard of `src/` in a throwaway
  copy (one at a time) and runs the tests: 153 mutants on 2026-10-31: 142 killed, 11 equivalent (above,
  each marked in the list with its reason). A pattern no longer found is an error: update it with the code.
- **Checked live on 2026-10-30**: the client and the parser against the real files of 46026, 45132, PSBM1,
  44025, 51201 and a missing id (404), then the 304; the whole app against them (fake Gladys); then installed in
  the sandbox Gladys (`gi install`, RUNNING) with 46026 and 45132: status, Discovery (14 features each), test
  button, and a device created through the API got its values at once. The sandbox integration was stopped
  afterwards so it does not keep reading the NDBC.
