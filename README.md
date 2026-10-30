# gladys-ndbc

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the **NOAA National Data Buoy
Center** (NDBC): the observations of buoys and coastal stations (waves, wind, water and air temperature,
pressure, visibility, tide) read from the public [realtime files](https://www.ndbc.noaa.gov/data/realtime2/).
No account, no API key; US government data in the public domain (source: NOAA National Data Buoy Center).

> This integration is not an official source, and not for navigation. Check the NDBC and the official marine
> forecasts before going out on the water.

- Up to 10 stations, one Gladys device each, 14 features (wind direction, speed and gust, wave height,
  periods and direction, pressure and tendency, air and water temperature, dew point, visibility, tide).
- Each value published once, only when its observation is under 2 hours old (against the NDBC server time);
  `MM` (missing) is never published as 0.
- One request at a time, 3 s apart, every 10 to 180 minutes; only the head of each file (`Range`),
  `If-None-Match`; pauses after a 429 or a 5xx, kept across restarts.
- Tested against the live NDBC files on 2026-10-30; not yet tested by a user.

User documentation: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm test               # node --test (virtual clock, scripted NDBC; two tests on the real clock x20)
npm run lint
npm run format:check
node scripts/cover.mjs cover.png
```

Tests never reach the Internet: the heads of four real files captured on 2026-10-30 are in `test/fixtures/`,
and the real-clock tests serve them from a local HTTP server.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
