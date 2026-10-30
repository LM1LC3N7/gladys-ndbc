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
- **Pace**: 3 s between requests (ndbc-api uses 2 s); interval 10-180 min (30); a changed station list reads
  within a minute (CHANGE_GAP); pauses 429 5 min, 5xx and other statuses 2 min, doubled, ≤ 6 h, in `/data`;
  404/410: per station, 1 h doubled up to 24 h, in memory only; network, timeout, 429, 5xx and pause failures
  read again before the next round (pause end, else 2 min doubled), format failures not.
- **/data**: read and written asynchronously, each wait bounded to 2 s (a frozen /data is "unreadable" and never
  holds a read); a file that is not a plain file (FIFO, link, directory), over 1 MB or not JSON is unreadable and
  never overwritten; the temporary file is removed before each write (`wx`). A /data that cannot tell the last
  attempt: the first read waits 10 min (the minimum interval) after the start.
- **Status**: no relative age in the text (it would change every minute); a timer recomposes it when a value
  shown as under 2 h old turns older. "Connected" only when the last read of at least one station is a success
  with a value under 2 h old.
- **States per minute**: 250 at most (sliding minute); the rest waits for the next read.
- **No widget, no scene trigger, no scene action** in 0.1.0.
- **Equivalent mutants** (guards kept, no test can tell them apart): the "frozen" case of `checkData` (`persist()`
  already refuses a frozen /data, so `dataTells` is false either way) and the `wx` flag of the temporary file
  (the file was removed just before; `wx` only matters for a race in between). 87 other guard mutants are killed
  by the tests (runner kept outside the repository).
- **Checked live on 2026-10-30**: the client and the parser against the real files of 46026, 45132, PSBM1,
  44025, 51201 and a missing id (404), then the 304; the whole app against them (fake Gladys); then installed in
  the sandbox Gladys (`gi install`, RUNNING) with 46026 and 45132: status, Discovery (14 features each), test
  button, and a device created through the API got its values at once. The sandbox integration was stopped
  afterwards so it does not keep reading the NDBC.
