import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/server/ollama.js';
import { prepared } from './helpers.js';

afterEach(() => { vi.unstubAllGlobals(); });

const client = () => new OllamaClient('http://127.0.0.1:11434');
const input = { request: 'Please draft a replacement request.', format: 'email' as const };
const answer = (content: string) => new Response(JSON.stringify({ message: { content } }), {
  headers: { 'Content-Type': 'application/json' },
});

function stubChat(chat: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => url.endsWith('/api/tags')
    ? Promise.resolve(new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] })))
    : chat(url, init));
}

describe('local AI contract', () => {
  it('accepts a schema-valid draft and does not give the model tools', async () => {
    const fake = vi.fn().mockResolvedValue(answer(JSON.stringify(prepared)));
    stubChat(fake);
    expect(await client().prepare(input, 'gemma3:4b')).toEqual(prepared);
    const body = JSON.parse(fake.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.format.properties.body.maxLength).toBe(6000);
    expect(body.options.num_predict).toBe(1000);
    expect(body.messages[0].content).toContain('never performs them');
    expect(fake.mock.calls[0][1].redirect).toBe('error');
  });

  it('retries invalid JSON once and then fails explicitly', async () => {
    const fake = vi.fn().mockImplementation(async () => answer('{"incomplete":'));
    stubChat(fake);
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toThrow('could not prepare a valid draft');
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('does not invent a draft when Ollama is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toThrow('not reachable');
    expect(await client().health()).toMatchObject({ models: [], error: expect.stringContaining('not reachable') });
  });

  it('reports a missing model clearly', async () => {
    const fake = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    stubChat(fake);
    await expect(client().prepare(input, 'missing-model')).rejects.toThrow('not installed');
    expect(fake).not.toHaveBeenCalled();
  });

  it('rejects the wrong output format', async () => {
    stubChat(vi.fn().mockImplementation(async () => answer(JSON.stringify({ ...prepared, kind: 'plan' }))));
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toThrow('valid draft');
  });

  it('requires a subject for email drafts, including when the format is automatic', async () => {
    const fake = vi.fn().mockImplementation(async () => answer(JSON.stringify({ ...prepared, subject: '' })));
    stubChat(fake);
    await expect(client().prepare({ ...input, format: 'auto' }, 'gemma3:4b')).rejects.toThrow('valid draft');
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('reports an invalid HTTP response rather than treating it as a client input error', async () => {
    stubChat(vi.fn().mockResolvedValue(new Response('<html>not JSON</html>')));
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toMatchObject({ status: 422, message: expect.stringContaining('unreadable reply') });
  });

  it('rejects non-local model endpoints', () => {
    expect(() => new OllamaClient('https://hosted-ai.example')).toThrow('loopback');
    expect(() => new OllamaClient('file:///secrets')).toThrow('HTTP');
  });

  it('only lists local models, not cloud models advertised by the local Ollama server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'gemma3:4b' },
        { name: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com', remote_model: 'gpt-oss:120b' },
        { name: 'renamed-remote:latest', remote_host: 'https://ollama.com' },
      ],
    }))));
    expect((await client().health()).models).toEqual(['gemma3:4b']);
  });

  it('refuses to send a task to a cloud-backed model, even if that model was saved in settings', async () => {
    const fake = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      models: [
        { name: 'gemma3:4b' },
        { name: 'renamed-remote:latest', remote_host: 'https://ollama.com' },
      ],
    })));
    vi.stubGlobal('fetch', fake);
    await expect(client().prepare(input, 'renamed-remote:latest')).rejects.toThrow('not installed locally');
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0][0]).toMatch(/\/api\/tags$/);
  });

  it('does not start model or metadata requests when already cancelled', async () => {
    const fake = vi.fn();
    vi.stubGlobal('fetch', fake);
    const controller = new AbortController();
    controller.abort();
    await expect(client().prepare(input, 'gemma3:4b', controller.signal)).rejects.toThrow('cancelled');
    expect(fake).not.toHaveBeenCalled();
  });
});
