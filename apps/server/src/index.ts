import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.ts';
import { openDb } from './db/client.ts';
import { WEB_DIST } from './paths.ts';

const port = Number(process.env.API_PORT ?? 5174);
const app = buildApp(openDb(), { logger: true });

// Serve the built web app (used by the desktop launcher; dev uses Vite on :5173 instead).
if (fs.existsSync(`${WEB_DIST}/index.html`)) {
  app.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
  // Client-side routes (/applications/12 etc.) all load index.html.
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/')
      ? reply.status(404).send({ error: 'Not found' })
      : reply.type('text/html').sendFile('index.html'),
  );
}

// Launcher mode: exit once no window has pinged for a while, so nothing lingers in the background.
const idleMinutes = Number(process.env.JM_IDLE_EXIT_MINUTES ?? 0);
if (idleMinutes > 0) {
  let last = Date.now();
  app.addHook('onRequest', async () => {
    last = Date.now();
  });
  setInterval(() => {
    if (Date.now() - last > idleMinutes * 60_000) {
      app.log.info(`No activity for ${idleMinutes} min, shutting down`);
      app.close().finally(() => process.exit(0));
    }
  }, 30_000).unref();
}

// Bind to loopback only — this app holds personal data and has no auth.
app.listen({ host: '127.0.0.1', port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
