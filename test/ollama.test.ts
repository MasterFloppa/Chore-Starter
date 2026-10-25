import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaClient } from '../src/server/ollama.js';
import { prepared } from './helpers.js';

afterEach(() => { vi.unstubAllGlobals(); });

const client = () => new OllamaClient('http://127.0.0.1:11434');
const input = { request: 'Please draft a replacement request.', format: 'email' as const };
const answer = (content: string) => new Response(JSON.stringify({ message: { content } }), {
  headers: { 'Content-Type': 'application/json' },
});

describe('local AI contract', () => {
  it('accepts a schema-valid draft and does not give the model tools', async () => {
    const fake = vi.fn().mockResolvedValue(answer(JSON.stringify(prepared)));
    vi.stubGlobal('fetch', fake);
    expect(await client().prepare(input, 'gemma3:4b')).toEqual(prepared);
    const body = JSON.parse(fake.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.format.properties.body.maxLength).toBe(6000);
    expect(body.options.num_predict).toBe(1000);
    expect(body.messages[0].content).toContain('never performs them');
  });

  it('retries invalid JSON once and then fails explicitly', async () => {
    const fake = vi.fn().mockImplementation(async () => answer('{"incomplete":'));
    vi.stubGlobal('fetch', fake);
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toThrow('could not prepare a valid draft');
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('does not invent a draft when Ollama is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toThrow('connect to Ollama');
    expect(await client().health()).toMatchObject({ models: [], error: expect.stringContaining('not reachable') });
  });

  it('reports a missing model clearly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(client().prepare(input, 'missing-model')).rejects.toThrow('not installed');
  });

  it('rejects the wrong output format', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => answer(JSON.stringify({ ...prepared, kind: 'plan' }))));
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toThrow('valid draft');
  });

  it('requires a subject for email drafts, including when the format is automatic', async () => {
    const fake = vi.fn().mockImplementation(async () => answer(JSON.stringify({ ...prepared, subject: '' })));
    vi.stubGlobal('fetch', fake);
    await expect(client().prepare({ ...input, format: 'auto' }, 'gemma3:4b')).rejects.toThrow('valid draft');
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('reports an invalid HTTP response rather than treating it as a client input error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>not JSON</html>')));
    await expect(client().prepare(input, 'gemma3:4b')).rejects.toMatchObject({ status: 422, message: expect.stringContaining('unreadable reply') });
  });

  it('rejects non-local model endpoints', () => {
    expect(() => new OllamaClient('https://hosted-ai.example')).toThrow('loopback');
    expect(() => new OllamaClient('file:///secrets')).toThrow('HTTP');
  });
});
