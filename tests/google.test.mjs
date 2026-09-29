import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream } from '../src/api.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';
import { makeResponse } from './fixtures.mjs';

test('Google stream falls back to env API key when resolved auth has no credential', async (t) => {
  const previousGeminiApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'env-gemini-key';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['x-goog-api-key'], 'env-gemini-key');
    return makeResponse([
      { data: { candidates: [{ content: { parts: [{ text: 'Fallback auth accepted' }] } }] } },
    ]);
  });

  try {
    const result = await callApiStream(mockCtx(undefined), {
      id: 'gemini-test',
      provider: 'google',
      api: 'google-generative-ai',
      baseUrl: 'https://example.test/gemini/v1beta',
      headers: {},
    }, {
      contents: [{ role: 'user', parts: [{ text: 'Search with fallback auth' }] }],
      tools: [{ google_search: {} }],
    });

    assert.equal(result.text, 'Fallback auth accepted');
  } finally {
    if (previousGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiApiKey;
  }
});

test('Google stream exposes grounding queries, chunks, support citations, and resolves redirect URLs', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'HEAD') {
      assert.equal(url, 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc');
      return new Response('', {
        status: 302,
        headers: { location: 'https://platform.openai.com/docs/guides/tools-web-search' },
      });
    }
    assert.equal(JSON.parse(init.body).tools[0].google_search instanceof Object, true);
    return makeResponse([
      { data: { candidates: [{ content: { parts: [{ text: 'Gemini grounded answer' }] } }] } },
      { data: { candidates: [{ groundingMetadata: {
        webSearchQueries: ['OpenAI docs'],
        groundingChunks: [{ web: { title: 'OpenAI docs', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' } }],
        groundingSupports: [{ segment: { text: 'Gemini grounded answer', endIndex: 22 }, groundingChunkIndices: [0] }],
      } }] } },
    ]);
  });

  const result = await callApiStream(mockCtx(), {
    id: 'gemini-test',
    provider: 'proxy-provider',
    api: 'google-generative-ai',
    baseUrl: 'https://example.test/gemini/v1beta',
    headers: {},
  }, {
    contents: [{ role: 'user', parts: [{ text: 'Search OpenAI docs' }] }],
    tools: [{ google_search: {} }],
  });

  assert.equal(result.providerKind, 'google');
  assert.equal(result.nativeSearchUsed, true);
  assert.deepEqual(result.searchQueries, ['OpenAI docs']);
  assert.equal(result.searchResults[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
  assert.equal(result.citations[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
  assert.equal(result.citations[0].citedText, 'Gemini grounded answer');
  assert.equal(result.sources[0].url, 'https://platform.openai.com/docs/guides/tools-web-search');
});
