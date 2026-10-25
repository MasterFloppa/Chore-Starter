import './env.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { OllamaClient } from './ollama.js';
import { TaskService } from './service.js';
import { Store } from './store.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be a number between 1024 and 65535.');
const development = process.env.CHORE_STARTER_DEV === '1';
const store = new Store(
  resolve(root, process.env.CHORE_STARTER_DATA ?? 'data/state.json'),
  process.env.CHORE_STARTER_MODEL ?? 'gemma3:4b',
);
const service = new TaskService(store, new OllamaClient(process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'));
const app = createApp(service, port, development);
const dist = join(root, 'dist', 'web');

if (!development && existsSync(join(dist, 'index.html'))) {
  app.use('/*', serveStatic({ root: relative(process.cwd(), dist) }));
}

console.log('Starting Chore Starter...');
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`Chore Starter is ready: http://127.0.0.1:${development ? 5174 : port}`);
  console.log('Local AI only. No emails are sent and no outside actions run automatically.');
});
server.on('error', (err) => {
  console.error('Could not start Chore Starter:', err.message);
  process.exitCode = 1;
});
