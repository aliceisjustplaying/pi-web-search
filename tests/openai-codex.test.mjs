import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream } from '../src/api.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';
import { OPENAI_CODEX_TOKEN, sse, makeResponse } from './fixtures.mjs';

test('OpenAI Codex stream uses Codex Responses transport with native web search', async (t) => {
  const tokenPayload = OPENAI_CODEX_TOKEN.split('.')[1];
  assert.match(tokenPayload, /[-_]/);
  assert.notEqual(tokenPayload.length % 4, 0);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(init.headers.authorization, `Bearer ${OPENAI_CODEX_TOKEN}`);
    assert.equal(init.headers['chatgpt-account-id'], 'acct_test');
    assert.equal(init.headers.originator, 'codex_cli_rs');
    assert.equal(Object.keys(init.headers).some((key) => key.toLowerCase() === 'openai-beta'), false);

    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gpt-5.5');
    assert.deepEqual(body.input, [{
      role: 'user',
      content: [{ type: 'input_text', text: 'Search with Codex' }],
    }]);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.stream, true);
    assert.equal(body.store, false);

    return makeResponse([
      { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_codex' } },
      { data: { type: 'response.output_text.delta', delta: 'Codex search answer' } },
      { data: { type: 'response.web_search_call.completed', item_id: 'ws_codex' } },
      { data: { type: 'response.done', response: { output: [
        { type: 'web_search_call', id: 'ws_codex', status: 'completed', action: { type: 'search', query: 'Codex web search' } },
      ] } } },
    ]);
  });

  const result = await callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
    id: 'gpt-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

  assert.equal(result.providerKind, 'openai');
  assert.equal(result.nativeSearchUsed, true);
  assert.equal(result.text, 'Codex search answer');
  assert.deepEqual(result.searchQueries, ['Codex web search']);
  assert.equal(result.nativeSearchCalls.length, 1);
  assert.equal(result.nativeSearchCalls[0].status, 'completed');
  assert.deepEqual(result.nativeSearchCalls[0].queries, ['Codex web search']);
});

test('OpenAI Codex stream stops after terminal event without waiting for EOF', async (t) => {
  let cancelled = false;
  let timeout;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([
        { data: { type: 'response.output_text.delta', delta: 'Terminal Codex answer' } },
        { data: { type: 'response.done', response: { output: [
          { type: 'web_search_call', id: 'ws_terminal', status: 'completed', action: { type: 'search', query: 'terminal query' } },
        ] } } },
      ])));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }));

  try {
    const result = await Promise.race([
      callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
        id: 'gpt-5.5',
        provider: 'openai-codex',
        api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api',
        reasoning: true,
        headers: {},
      }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Codex stream did not stop')), 250);
      }),
    ]);

    assert.equal(result.text, 'Terminal Codex answer');
    assert.deepEqual(result.searchQueries, ['terminal query']);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timeout);
  }
});

test('OpenAI Codex stream rejects error events with server message', async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([
        { data: { type: 'error', error: { message: 'Codex SSE error message' } } },
      ])));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }));

  await assert.rejects(
    callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
    /Codex SSE error message/,
  );
  assert.equal(cancelled, true);
});

test('OpenAI Codex stream rejects response.failed with server message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    { data: { type: 'response.failed', response: { error: { message: 'Codex response failed message' } } } },
    { data: { type: 'response.done', response: { output: [] } } },
  ]));

  await assert.rejects(
    callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
    /Codex response failed message/,
  );
});

test('OpenAI Codex stream preserves custom headers over defaults', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer explicit-auth');
    assert.equal(init.headers['chatgpt-account-id'], 'explicit-account');
    assert.equal(init.headers.originator, 'custom-originator');
    assert.equal(init.headers['openai-beta'], 'custom-beta');
    assert.equal(init.headers.accept, 'application/x-test-stream');
    assert.equal(Object.keys(init.headers).filter((key) => key.toLowerCase() === 'originator').length, 1);
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'Custom headers preserved' } },
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  });

  const result = await callApiStream(mockCtx(OPENAI_CODEX_TOKEN, undefined, {
    authorization: 'Bearer explicit-auth',
    'ChatGPT-Account-ID': 'explicit-account',
    'openai-beta': 'custom-beta',
    accept: 'application/x-test-stream',
  }), {
    id: 'gpt-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    headers: { Originator: 'custom-originator' },
  }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

  assert.equal(result.text, 'Custom headers preserved');
});

test('OpenAI Codex stream accepts headers-only authentication', async (t) => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    fetched = true;
    assert.equal(init.headers.authorization, 'Bearer headers-only-token');
    assert.equal(init.headers['chatgpt-account-id'], 'headers-only-account');
    return makeResponse([
      { data: { type: 'response.output_text.delta', delta: 'Headers-only auth accepted' } },
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  });

  const result = await callApiStream(mockCtx(undefined, undefined, {
    authorization: 'Bearer headers-only-token',
    'ChatGPT-Account-ID': 'headers-only-account',
  }), {
    id: 'gpt-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

  assert.equal(fetched, true);
  assert.equal(result.text, 'Headers-only auth accepted');
});

test('OpenAI Codex stream normalizes mixed-case Authorization with auth headers winning', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const authorizationKeys = Object.keys(init.headers).filter((key) => key.toLowerCase() === 'authorization');
    assert.deepEqual(authorizationKeys, ['authorization']);
    assert.equal(init.headers.authorization, 'Bearer auth-oauth-token');
    assert.doesNotMatch(init.headers.authorization, /model-stale-token/);
    return makeResponse([
      { data: { type: 'response.done', response: { output: [] } } },
    ]);
  });

  await callApiStream(mockCtx(undefined, undefined, {
    authorization: 'Bearer auth-oauth-token',
    'ChatGPT-Account-ID': 'collision-account',
  }), {
    id: 'gpt-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    headers: { Authorization: 'Bearer model-stale-token' },
  }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });
});

test('OpenAI Codex stream rejects missing authentication', async (t) => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched = true;
    return makeResponse([]);
  });

  await assert.rejects(
    callApiStream(mockCtx(undefined), {
      id: 'gpt-5.5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      headers: {},
    }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] }),
    /No OAuth credential configured for openai-codex model/,
  );
  assert.equal(fetched, false);
});

test('OpenAI Codex stream preserves partial results from incomplete responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    { data: { type: 'response.web_search_call.in_progress', item_id: 'ws_codex_partial' } },
    { data: { type: 'response.output_text.delta', delta: 'Partial Codex answer' } },
    { data: { type: 'response.incomplete', response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        { type: 'web_search_call', id: 'ws_codex_partial', status: 'completed', action: { type: 'search', query: 'partial Codex query' } },
      ],
    } } },
  ]));

  const result = await callApiStream(mockCtx(OPENAI_CODEX_TOKEN), {
    id: 'gpt-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    headers: {},
  }, { contents: [{ parts: [{ text: 'Search with Codex' }] }] });

  assert.equal(result.text, 'Partial Codex answer');
  assert.equal(result.nativeSearchCalls.length, 1);
  assert.equal(result.nativeSearchCalls[0].status, 'completed');
  assert.deepEqual(result.nativeSearchCalls[0].queries, ['partial Codex query']);
  assert.deepEqual(result.searchQueries, ['partial Codex query']);
});
