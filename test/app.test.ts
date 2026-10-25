import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { fixture } from './helpers.js';

let f: ReturnType<typeof fixture>;
let app: ReturnType<typeof createApp>;
let token: string;
const base = 'http://127.0.0.1:8788';

beforeEach(async () => {
  f = fixture();
  app = createApp(f.service, 8788);
  const response = await app.request(`${base}/api/status`);
  token = (await response.json()).csrfToken;
});
afterEach(() => { f.dispose(); });

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chore-starter-token': token, ...headers },
    body: JSON.stringify(body),
  });
}

describe('API boundaries', () => {
  it('returns model health and no-store status', async () => {
    const response = await app.request(`${base}/api/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ modelReady: true, models: ['gemma3:4b'] });
  });

  it('rejects mutations without the browser session token', async () => {
    const response = await post('/api/tasks', { request: 'Write a message for me.' }, { 'x-chore-starter-token': '' });
    expect(response.status).toBe(403);
    expect(f.store.read().tasks).toEqual([]);
  });

  it('rejects malformed multibyte tokens without crashing', async () => {
    const response = await post('/api/tasks', { request: 'Write a message for me.' }, { 'x-chore-starter-token': 'é'.repeat(43) });
    expect(response.status).toBe(403);
  });

  it('rejects a different website even with a session token', async () => {
    const response = await post('/api/tasks', { request: 'Write a message for me.' }, { Origin: 'https://untrusted.example' });
    expect(response.status).toBe(403);
  });

  it('rejects a non-local Host header', async () => {
    const response = await app.request(`${base}/api/status`, { headers: { Host: 'untrusted.example' } });
    expect(response.status).toBe(403);
  });

  it('allows opening the UI from another site without exposing the API', async () => {
    const linkedApp = createApp(f.service, 8788);
    linkedApp.get('/', (c) => c.text('Local app shell'));
    const navigation = await linkedApp.request(`${base}/`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toBe('Local app shell');
    const apiRead = await linkedApp.request(`${base}/api/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(apiRead.status).toBe(403);
  });

  it('requires meaningful input and rejects model tool parameters', async () => {
    expect((await post('/api/tasks', { request: 'short' })).status).toBe(400);
    expect((await post('/api/tasks', { request: 'Prepare a reply.', tools: ['shell'] })).status).toBe(400);
    expect(f.store.read().tasks).toEqual([]);
  });

  it('limits request bodies', async () => {
    const response = await post('/api/tasks', { request: 'a'.repeat(33 * 1024) });
    expect(response.status).toBe(413);
  });

  it('persists preparation, revisioned edits, and a confirmed local handoff', async () => {
    const response = await post('/api/tasks', { request: 'Prepare a refund email.', format: 'email' });
    expect(response.status).toBe(201);
    const { task } = await response.json();
    const list = await (await app.request(`${base}/api/tasks`)).json();
    expect(list).toMatchObject([{ id: task.id, title: task.title }]);
    const preview = await (await post(`/api/tasks/${task.id}/preview`, { revision: task.revision, action: 'copy' })).json();
    expect(f.store.read().events).toEqual([]);
    const result = await post(`/api/tasks/${task.id}/confirm`, { token: preview.token });
    expect(result.status).toBe(200);
    expect((await result.json()).content).toContain(task.body);
    expect((await post(`/api/tasks/${task.id}/confirm`, { token: preview.token })).status).toBe(409);
  });

  it('rejects invented actions rather than executing them', async () => {
    const { task } = await (await post('/api/tasks', { request: 'Prepare a refund email.' })).json();
    expect((await post(`/api/tasks/${task.id}/preview`, { revision: 1, action: 'send' })).status).toBe(400);
    expect((await post(`/api/tasks/${task.id}/preview`, { revision: 1, action: 'shell' })).status).toBe(400);
    expect(f.store.read().events).toEqual([]);
  });

  it('does not accept a made-up confirmation token', async () => {
    const { task } = await (await post('/api/tasks', { request: 'Prepare a refund email.' })).json();
    expect((await post(`/api/tasks/${task.id}/confirm`, { token: 'x'.repeat(43) })).status).toBe(409);
  });
});
