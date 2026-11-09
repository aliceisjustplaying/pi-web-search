import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream, getProviderKind } from '../src/api.ts';
import { resolveDeepSeekApiRoot } from '../src/providers/deepseek.ts';
import { urlContext } from '../src/url_context.ts';
import { webSearch } from '../src/web_search.ts';
import { getWebSearchModel } from '../src/utils.ts';
import { createMockCtx, withWebSearchConfig } from './helpers.mjs';

const model = {
  id: 'deepseek-v4-flash', provider: 'deepseek', api: 'openai-completions',
  baseUrl: 'https://api.deepseek.com', maxTokens: 8192, headers: {},
};
const body = { contents: [{ parts: [{ text: 'Search DeepSeek docs' }] }] };

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function searchPayload() {
  return {
    results: [
      {
        rerank_score: 2.4,
        title: 'DeepSeek docs',
        url: 'https://api-docs.deepseek.com/',
        snippet: 'DeepSeek supports search.',
        // Search summaries are plain page text, verified against the live API:
        // they carry real newlines and genuine backslashes (regexes, Windows
        // paths, unlike the LaTeX-escaped Markdown the fetch endpoint returns).
        summary: '# DeepSeek V4 is out.\n\nRegex \\d+ and path C:\\Users\\name.',
        content: '',
        site_name: 'DeepSeek',
        site_icon: 'https://cdn.deepseek.com/site-icons/deepseek.com',
        date: '2026-06-01T00:00:00+00:00',
        authority: 3,
      },
      {
        rerank_score: 1.2,
        title: 'Second hit',
        url: 'https://example.com/second',
        snippet: 'Another page.',
        summary: '',
        content: '',
        site_name: null,
        site_icon: null,
        date: null,
        authority: -1,
      },
    ],
  };
}

test('DeepSeek detection is provider-specific and supports both API dialects', () => {
  assert.equal(getProviderKind(model), 'deepseek');
  assert.equal(getProviderKind({ ...model, api: 'anthropic-messages' }), 'deepseek');
  assert.equal(getProviderKind({ ...model, provider: 'other' }), 'unsupported');
});

test('resolveDeepSeekApiRoot strips the model-API suffix and keeps the proxy origin', () => {
  const cases = [
    ['https://api.deepseek.com', 'https://api.deepseek.com'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com'],
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com'],
    ['https://api.deepseek.com/anthropic', 'https://api.deepseek.com'],
    ['https://api.deepseek.com/anthropic/v1', 'https://api.deepseek.com'],
    ['https://proxy.test/deepseek', 'https://proxy.test/deepseek'],
    ['https://proxy.test/deepseek/v1', 'https://proxy.test/deepseek'],
    ['https://proxy.test/deepseek/anthropic/v1/', 'https://proxy.test/deepseek'],
  ];
  for (const [baseUrl, expected] of cases) {
    assert.equal(resolveDeepSeekApiRoot({ ...model, baseUrl }), expected, baseUrl);
  }
});

test('resolveDeepSeekApiRoot prefers the registry-provided base URL override', () => {
  assert.equal(
    resolveDeepSeekApiRoot(model, { ok: true, baseUrl: 'https://proxy.test/deepseek/anthropic/v1' }),
    'https://proxy.test/deepseek',
  );
});

test('DeepSeek search calls the tools/search endpoint and formats results', async (t) => {
  const controller = new AbortController();
  const updates = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body), { query: 'Search DeepSeek docs', count: 10, need_content: false });
    return jsonResponse(searchPayload());
  });

  const result = await callApiStream(createMockCtx('test-key'), model, body,
    (update) => updates.push(update), controller.signal);

  assert.equal(result.providerKind, 'deepseek');
  assert.equal(result.nativeSearchUsed, true);
  assert.deepEqual(result.searchQueries, ['Search DeepSeek docs']);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].url, 'https://api-docs.deepseek.com/');
  assert.equal(result.searchResults[0].pageAge, '2026-06-01T00:00:00+00:00');
  // The rerank score stays on the raw payload instead of overloading `status`,
  // which every other provider reserves for failure states.
  assert.equal(result.searchResults[0].status, undefined);
  assert.equal(result.searchResults[0].raw.rerank_score, 2.4);
  assert.deepEqual(result.nativeSearchEvents, undefined, 'no stream events exist on the REST path');
  assert.match(result.text, /Search results for "Search DeepSeek docs" via DeepSeek/);
  assert.match(result.text, /## 1\. DeepSeek docs/);
  assert.match(result.text, /^# DeepSeek V4 is out\.$/m, 'summary heading preserved');
  // A real summary is plain page text: its backslashes survive verbatim, and a
  // blank line must separate the metadata line from a heading inside it.
  assert.ok(result.text.includes('Regex \\d+ and path C:\\Users\\name.'), 'summary text is passed through verbatim');
  assert.match(result.text, /\+00:00\n\n# DeepSeek V4 is out\./, 'blank line before a heading in the summary');
  assert.ok(updates.some((update) => update.details.searching));
});

test('DeepSeek search reports an empty result set without failing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ results: [] }));
  const result = await callApiStream(createMockCtx('test-key'), model, body);
  assert.match(result.text, /No results found/);
  assert.deepEqual(result.sources, []);
  assert.equal(result.nativeSearchUsed, true);
});

test('explicit DeepSeek model works with another conversation model and fetches URLs', async (t) => {
  const current = { ...model, id: 'local', provider: 'local' };
  const ctx = createMockCtx('key', current, undefined, undefined, { models: [current, model] });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (String(url).endsWith('/v1/tools/fetch')) {
      return jsonResponse({ title: 'Fetched page', content: '## Heading\n\nBody text.' });
    }
    return jsonResponse(searchPayload());
  });

  await withWebSearchConfig({ provider: 'deepseek', model: model.id }, async () => {
    assert.equal(await getWebSearchModel(ctx), model);
    const result = await webSearch('test', { query: 'Search docs', urls: ['https://deepseek.com'] }, new AbortController().signal, undefined, ctx);
    assert.equal(result.details.providerKind, 'deepseek');
    assert.match(result.content[0].text, /https:\/\/api-docs\.deepseek\.com/);
    // Fetched content is returned exactly as the API sent it, like every other
    // provider; no escaping is applied or reversed.
    assert.match(result.content[0].text, /## Fetched: Fetched page\nhttps:\/\/deepseek\.com\n\n## Heading\n\nBody text\./);
  });

  assert.deepEqual(requests.map((r) => r.url), [
    'https://api.deepseek.com/v1/tools/search',
    'https://api.deepseek.com/v1/tools/fetch',
  ]);
  // The URL list travels as a fetch request, not inside the query.
  assert.equal(requests[0].body.query, 'Search docs');
  assert.deepEqual(requests[1].body, { url: 'https://deepseek.com' });
});

test('DeepSeek env credentials and registry endpoint overrides are respected', async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'env-key';
  t.after(() => { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://proxy.test/deepseek/v1/tools/search');
    assert.equal(init.headers.Authorization, 'Bearer env-key');
    return jsonResponse(searchPayload());
  });
  await callApiStream(createMockCtx(undefined, model, undefined, 'https://proxy.test/deepseek/v1'), model, body);
});

test('DeepSeek preserves explicit auth headers', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer header-key');
    return jsonResponse(searchPayload());
  });
  await callApiStream(createMockCtx(undefined, model, { Authorization: 'Bearer header-key' }), model, body);
});

test('DeepSeek rejects missing credentials before fetching', async (t) => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous; });
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('must not fetch'));
  await assert.rejects(callApiStream(createMockCtx(undefined), model, body), /No DeepSeek API key/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('DeepSeek explains documented HTTP failures', async (t) => {
  const error = (status, message) => new Response(
    JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: 'invalid_request_error' } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
  const checks = [
    [error(401, 'invalid key'), /No DeepSeek API key/],
    [error(402, 'insufficient balance'), /insufficient account balance/],
    [error(429, 'rate limited'), /rate limit exceeded \(5 QPS per account\)/],
    [error(400, "'count' must be between 1 and 50"), /'count' must be between 1 and 50/],
    [error(500, 'internal error'), /DeepSeek search error \(500\): internal error/],
  ];
  t.mock.method(globalThis, 'fetch', async () => checks.shift()[0]);
  for (const [, pattern] of checks.slice()) {
    await assert.rejects(callApiStream(createMockCtx(), model, body), pattern);
  }
});

test('DeepSeek fetch reports per-URL failures without dropping the search results', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/v1/tools/fetch')) {
      return new Response(JSON.stringify({ error: { message: 'no content' } }), { status: 404 });
    }
    return jsonResponse(searchPayload());
  });

  const result = await webSearch(
    'tool-1',
    { query: 'Search docs', urls: ['https://example.com/missing'] },
    new AbortController().signal,
    undefined,
    createMockCtx('test-key', model),
  );

  assert.match(result.content[0].text, /api-docs\.deepseek\.com/);
  assert.match(result.content[0].text, /Fetch failed: https:\/\/example\.com\/missing/);
  assert.equal(result.details.retrieved, undefined);
  assert.equal(result.details.failed.length, 1);
});

test('url_context fetches each URL through the DeepSeek fetch endpoint', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return jsonResponse({ title: `Page ${requests.length}`, content: 'Body.' });
  });

  const result = await urlContext(
    'tool-2',
    { query: 'Summarize', urls: ['https://example.com/a', 'https://example.com/b'] },
    new AbortController().signal,
    undefined,
    createMockCtx('test-key', model),
  );

  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.url === 'https://api.deepseek.com/v1/tools/fetch'));
  assert.equal(result.details.providerKind, 'deepseek');
  assert.equal(result.details.sources.length, 2);
  assert.deepEqual(result.details.retrieved, ['https://example.com/a', 'https://example.com/b']);
  assert.match(result.content[0].text, /## Page 1/);
});

test('url_context reports per-URL fetch failures', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    n += 1;
    if (n === 1) return jsonResponse({ title: 'Page 1', content: 'Body.' });
    return new Response('not found', { status: 404 });
  });

  const result = await urlContext(
    'tool-3',
    { query: 'Summarize', urls: ['https://example.com/a', 'https://example.com/b'] },
    new AbortController().signal,
    undefined,
    createMockCtx('test-key', model),
  );

  assert.equal(result.details.retrieved.length, 1);
  assert.equal(result.details.failed.length, 1);
});

test('DeepSeek request cancellation reaches fetch', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    controller.abort();
    assert.equal(init.signal.aborted, true);
    init.signal.throwIfAborted();
  });
  await assert.rejects(callApiStream(createMockCtx(), model, body, undefined, controller.signal), { name: 'AbortError' });
});
