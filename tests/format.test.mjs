import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAdditionalSearchResults,
  extractUrlContextStatus,
  formatUrlContextResult,
  formatWebSearchResult,
  resolveCitedText,
} from '../src/format.ts';

test('extractUrlContextStatus reads camelCase and snake_case metadata', () => {
  const result = {
    text: '',
    urlContextMetadata: {
      url_metadata: [
        { retrieved_url: 'https://a.test/', url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS' },
        { retrievedUrl: 'https://b.test/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_ERROR' },
      ],
    },
  };

  assert.deepEqual(extractUrlContextStatus(result), {
    retrieved: ['https://a.test/'],
    failed: [{ url: 'https://b.test/', status: 'URL_RETRIEVAL_STATUS_ERROR' }],
  });
});

test('collectAdditionalSearchResults drops source URLs and optionally dedupes', () => {
  const sources = [{ title: 'A', url: 'https://a.test/' }];
  const result = {
    text: '',
    searchResults: [
      { title: 'A', url: 'https://a.test/' },
      { title: 'B', url: 'https://b.test/' },
      { title: 'B', url: 'https://b.test/' },
      { title: 'C', url: 'https://c.test/' },
      { title: 'no url' },
    ],
  };

  assert.deepEqual(
    collectAdditionalSearchResults(result, sources).map((item) => item.url),
    ['https://b.test/', 'https://b.test/', 'https://c.test/'],
  );
  assert.deepEqual(
    collectAdditionalSearchResults(result, sources, { dedupe: true }).map((item) => item.url),
    ['https://b.test/', 'https://c.test/'],
  );
});

test('resolveCitedText prefers provider sources and applies Gemini grounding citations', () => {
  const grounded = resolveCitedText({
    text: 'Hello',
    groundingMetadata: {
      groundingChunks: [{ web: { title: 'T', uri: 'https://t.test/' } }],
      groundingSupports: [{ segment: { text: 'Hello', endIndex: 5 }, groundingChunkIndices: [0] }],
    },
  });
  assert.match(grounded.text, /Hello\[1\]/);
  assert.deepEqual(grounded.sources, [{ title: 'T', url: 'https://t.test/' }]);

  const providerSources = resolveCitedText({
    text: 'Answer',
    sources: [{ title: 'P', url: 'https://p.test/' }],
  });
  assert.deepEqual(providerSources.sources, [{ title: 'P', url: 'https://p.test/' }]);
});

test('formatWebSearchResult renders sources and deduped additional results', () => {
  const output = formatWebSearchResult({
    text: 'Answer[[1]](https://a.test/)',
    sources: [{ title: 'A', url: 'https://a.test/' }],
    providerKind: 'openai',
    nativeSearchUsed: true,
    searchQueries: ['q'],
    searchResults: [
      { title: 'A', url: 'https://a.test/' },
      { title: 'B', url: 'https://b.test/' },
      { title: 'B', url: 'https://b.test/' },
      { title: 'C', url: 'https://c.test/' },
    ],
  }, { modelId: 'gpt-test' });

  const text = output.content[0].text;
  assert.match(text, /## Sources\n1\. \[A\]\(https:\/\/a\.test\/\)/);
  assert.match(text, /## Additional Search Results/);
  assert.match(text, /1\. B - https:\/\/b\.test\//);
  assert.match(text, /2\. C - https:\/\/c\.test\//);
  assert.doesNotMatch(text, /more results in tool details/);
  assert.equal(output.details.retrieved, undefined);
  assert.equal(output.details.grounded, true);
  assert.deepEqual(output.details.searchQueries, ['q']);
});

test('formatUrlContextResult warns when no verified metadata is present', () => {
  const output = formatUrlContextResult({
    text: 'Plain summary',
    providerKind: 'google',
    searchResults: [],
  }, { modelId: 'gemini-test' });

  assert.match(output.content[0].text, /No verified URL context metadata/);
  assert.deepEqual(output.details.sources, []);
  assert.equal(output.details.grounded, false);
});

test('formatUrlContextResult caps additional results and reports the remainder', () => {
  const searchResults = Array.from({ length: 10 }, (_, index) => ({
    title: `R${index + 1}`,
    url: `https://r${index + 1}.test/`,
    source: 'google.groundingChunks',
    type: 'web',
    status: 'completed',
    query: `q${index + 1}`,
  }));

  const output = formatUrlContextResult({
    text: 'Summary',
    sources: [{ title: 'S', url: 'https://s.test/' }],
    providerKind: 'google',
    searchResults,
    urlContextMetadata: {
      urlMetadata: [{ url: 'https://s.test/', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' }],
    },
  }, { modelId: 'gemini-test' });

  const text = output.content[0].text;
  assert.doesNotMatch(text, /No verified URL context metadata/);
  assert.match(text, /query=q1/);
  assert.match(text, /\.\.\. and 2 more results in tool details\./);
  assert.deepEqual(output.details.retrieved, ['https://s.test/']);
});
