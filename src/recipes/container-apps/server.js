import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequestHandler, resolveServerSettings } from './runtime.js';

try {
  const config = JSON.parse(await readFile(new URL('./runtime-config.json', import.meta.url), 'utf8'));
  const { port, publicUrl } = resolveServerSettings(process.env);
  const server = createServer({
    requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 24576,
  }, createRequestHandler(config, publicUrl));
  server.timeout = 20000;
  server.on('timeout', socket => socket.destroy());
  server.on('error', () => {
    process.stderr.write('{"event":"server-error"}\n'); process.exitCode = 1; server.close();
  });
  server.listen(port, '0.0.0.0', () => process.stderr.write('{"event":"server-started"}\n'));
  const shutdown = () => {
    server.close();
    const deadline = setTimeout(() => server.closeAllConnections(), 15000);
    deadline.unref();
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
} catch {
  process.stderr.write('{"event":"startup-failed","guidance":"Check runtime-config.json, PUBLIC_MCP_URL and PORT. Authentication is never disabled."}\n');
  process.exitCode = 1;
}
