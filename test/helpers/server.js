// -----------------------------------------------------------------------------
// A real local HTTP server playing NDBC: serves the captures by station id,
// honours `Range` (206) and `If-None-Match` (304), or what `answer(req)`
// returns ({ status, headers, body }), and records every request with the
// monotonic time of the given clock.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { FIXTURES } from './setup.js';

export async function startServer(clock, answer = () => null) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ at: clock.monotonic(), url: req.url, headers: req.headers });
    const custom = answer(req, requests.length);
    if (custom) {
      res.writeHead(custom.status, { date: new Date().toUTCString(), ...custom.headers });
      res.end(custom.body ?? '');
      return;
    }
    const id = /^\/([A-Z0-9]{5})\.txt$/.exec(req.url)?.[1];
    const body = id && FIXTURES[id] ? Buffer.from(FIXTURES[id], 'latin1') : null;
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/html', date: new Date().toUTCString() });
      res.end('not found');
      return;
    }
    const etag = `"${id}-1"`;
    const headers = {
      'content-type': 'text/plain; charset=ISO-8859-1',
      date: new Date().toUTCString(),
      etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const range = /^bytes=0-(\d+)$/.exec(req.headers.range ?? '');
    if (range) {
      const end = Math.min(Number(range[1]), body.length - 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes 0-${end}/${body.length}` });
      res.end(body.subarray(0, end + 1));
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
