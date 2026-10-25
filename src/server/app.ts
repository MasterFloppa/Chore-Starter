import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { approveInputSchema, editInputSchema, prepareInputSchema } from '../shared/schema.js';
import { AppError } from './errors.js';
import type { TaskService } from './service.js';

async function json<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  if (!c.req.header('Content-Type')?.startsWith('application/json')) throw new AppError('Send JSON for this request.');
  return schema.parse(await c.req.json());
}

const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export function createApp(service: TaskService, port: number, development = false): Hono {
  const app = new Hono();
  const csrfToken = randomBytes(32).toString('base64url');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  if (development) {
    allowedOrigins.add('http://127.0.0.1:5174');
    allowedOrigins.add('http://localhost:5174');
  }

  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const host = c.req.header('Host') ?? new URL(c.req.url).host;
    const origin = c.req.header('Origin');
    if (!allowedHosts.has(host)) return c.json({ error: 'This app only accepts its local address.' }, 403);
    if (origin && !allowedOrigins.has(origin)) return c.json({ error: 'Requests from another website are not allowed.' }, 403);
    if (c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    await next();
  });

  app.use('/api/*', bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json({ error: 'That request is too large.' }, 413),
  }));

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const token = Buffer.from(c.req.header('x-chore-starter-token') ?? '');
      const expected = Buffer.from(csrfToken);
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
        return c.json({ error: 'This session expired or the server restarted. Reload the page before continuing.' }, 403);
      }
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({
      error: err.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '),
    }, 400);
    if (err instanceof SyntaxError) return c.json({ error: 'That request was not valid JSON.' }, 400);
    console.error('[api]', err);
    return c.json({ error: 'The app could not finish this request. Check the server terminal for details; no external action was performed.' }, 500);
  });

  app.get('/api/status', async (c) => {
    const health = await service.model.health();
    const selected = service.store.read().model;
    return c.json({
      csrfToken,
      model: selected,
      modelReady: health.models.includes(selected),
      models: health.models,
      ollamaError: health.error,
      busy: service.isBusy(),
    });
  });

  app.put('/api/settings', async (c) => {
    const input = await json(c, z.object({ model: z.string().trim().min(1).max(100) }).strict());
    const health = await service.model.health();
    if (health.error) throw new AppError(health.error, 503);
    if (!health.models.includes(input.model)) throw new AppError('Choose a model that is installed in Ollama.');
    service.store.update((state) => { state.model = input.model; });
    return c.json({ model: input.model });
  });

  app.get('/api/tasks', (c) => c.json(service.store.read().tasks.map((task) => ({
    id: task.id,
    title: task.title,
    kind: task.kind,
    updatedAt: task.updatedAt,
  }))));

  app.post('/api/tasks', async (c) => {
    const input = await json(c, prepareInputSchema);
    const task = await service.prepare(input, c.req.raw.signal);
    return c.json({ task, events: [] }, 201);
  });

  app.get('/api/tasks/:id', (c) => c.json({
    task: service.getTask(c.req.param('id')),
    events: service.store.read().events.filter((e) => e.taskId === c.req.param('id')).slice(0, 20),
  }));

  app.patch('/api/tasks/:id', async (c) => c.json({
    task: service.edit(c.req.param('id'), await json(c, editInputSchema)),
  }));

  app.post('/api/tasks/:id/preview', async (c) => {
    const input = await json(c, approveInputSchema);
    return c.json(service.preview(c.req.param('id'), input.revision, input.action));
  });

  app.post('/api/tasks/:id/cancel', async (c) => {
    const input = await json(c, tokenSchema);
    service.cancel(c.req.param('id'), input.token);
    return c.json({ cancelled: true });
  });

  app.post('/api/tasks/:id/confirm', async (c) => {
    const input = await json(c, tokenSchema);
    return c.json(service.confirm(c.req.param('id'), input.token));
  });

  app.notFound((c) => c.json({ error: 'That page or endpoint was not found.' }, 404));
  return app;
}
