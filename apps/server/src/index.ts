import { buildApp } from './app.js';
import { config } from './config.js';
import { pruneExpiredSessions } from './lib/sessions.js';

const app = await buildApp();
await app.listen({ port: config.port, host: '127.0.0.1' });

setInterval(() => {
  pruneExpiredSessions().catch((err) => app.log.error(err, 'session prune failed'));
}, 3_600_000).unref();
