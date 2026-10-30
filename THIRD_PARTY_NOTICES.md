# Third-party notices

## NDBC data (NOAA, United States government)

The integration reads, at run time, the realtime files of the National Data Buoy Center
(https://www.ndbc.noaa.gov/data/realtime2/), a service of the National Oceanic and Atmospheric
Administration. Information produced by the US federal government is in the public domain in the United
States (17 U.S.C. 105); NOAA asks to be credited as the source. Some stations belong to partners (for example
Environment and Climate Change Canada for some Great Lakes buoys) and are relayed by the NDBC.

The test fixtures `test/fixtures/*.txt` are the first lines of four real files (46026, 44025, PSBM1, 45132)
captured on 2026-10-30; they hold no personal data.

Source of the data: NOAA National Data Buoy Center. The integration is not endorsed by NOAA.

## ndbc-api (reference, MIT)

The reading of the realtime files (columns found by the names of the first header line, `MM` and the "9"
fill values 99, 999 and 9999 read as missing) follows the parsers of ndbc-api 0.26.07.25.2
(https://github.com/CDJellen/ndbc-api, `ndbc_api/api/parsers/http/_base.py` and `stdmet.py`), rewritten in
JavaScript. Its license:

> MIT License
>
> Copyright (c) 2024 Christopher Jellen
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without
> limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
> Software, and to permit persons to whom the Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial
> portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
> LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
> EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
> AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
> OR OTHER DEALINGS IN THE SOFTWARE.

## gladys-testkit

`test/kit/clock.mjs` is copied from gladys-testkit (Apache-2.0, same author as this repository).

## npm dependencies

The only runtime dependency is `@gladysassistant/integration-sdk` (Apache-2.0); its license ships in
`node_modules/@gladysassistant/integration-sdk/LICENSE` of the image.
