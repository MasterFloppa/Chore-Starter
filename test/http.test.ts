import { serve } from '@hono/node-server';
import { Server as HttpServer } from 'node:http';
import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { fixture, prepared } from './helpers.js';

it('does not save a task after the browser disconnects during preparation', async () => {
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  let finish!: (value: typeof prepared) => void;
  const modelResult = new Promise<typeof prepared>((resolve) => { finish = resolve; });
  const f = fixture({
    health: async () => ({ models: ['gemma3:4b'], error: null }),
    prepare: () => { started(); return modelResult; },
  });
  let app: ReturnType<typeof createApp>;
  let listening!: (port: number) => void;
  const ready = new Promise<number>((resolve) => { listening = resolve; });
  const server = serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, bindings) => app.fetch(request, bindings),
  }, (info) => {
    app = createApp(f.service, info.port);
    listening(info.port);
  });
  try {
    const port = await ready;
    const base = `http://127.0.0.1:${port}`;
    const status = await (await fetch(`${base}/api/status`)).json();
    const controller = new AbortController();
    const request = fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chore-starter-token': status.csrfToken },
      body: JSON.stringify({ request: 'Help me prepare a polite refund request.', format: 'email' }),
      signal: controller.signal,
    });
    await modelStarted;
    controller.abort();
    await expect(request).rejects.toThrow();
    // Let the disconnect reach the server before an abort-ignoring model finishes.
    await new Promise((resolve) => setTimeout(resolve, 30));
    finish(structuredClone(prepared));
    for (let i = 0; i < 20 && f.service.isBusy(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(f.service.isBusy()).toBe(false);
    expect(f.store.read().tasks).toEqual([]);
  } finally {
    finish(structuredClone(prepared));
    const closed = new Promise<void>((resolve, reject) => server.close((err?: Error) => err ? reject(err) : resolve()));
    if (server instanceof HttpServer) server.closeAllConnections();
    await closed;
    f.dispose();
  }
});
