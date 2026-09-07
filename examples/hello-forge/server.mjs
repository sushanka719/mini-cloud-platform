/**
 * The sample app itself: an http server that answers the health check and
 * shows what the build stamped. Phase 7 runs this inside a container.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.PORT ?? 3000);
const info = JSON.parse(await readFile(new URL('./build-info.json', import.meta.url), 'utf8'));

createServer((request, response) => {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify({ ok: true, path: request.url, ...info }, null, 2)}\n`);
}).listen(port, () => {
  console.log(`hello-forge listening on ${port}`);
});
