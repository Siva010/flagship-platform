import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}

const entry = process.argv[1];
const isEntrypoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isEntrypoint) {
  const port = Number(process.env['PORT'] ?? 4000);
  const app = buildServer();
  app.listen({ port, host: '0.0.0.0' }).catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
}
