export const OPENAI_CODEX_TOKEN = [
  'eyJhbGciOiJub25lIn0',
  'eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF90ZXN0In0sIm5vdGUiOiLguJrguLHguI3guIrguLU_MTAifQ',
  'signature',
].join('.');

export function sse(events) {
  return events.map((event) => {
    const name = event.event ? `event: ${event.event}\n` : '';
    return `${name}data: ${JSON.stringify(event.data)}\n\n`;
  }).join('');
}

export function makeResponse(events) {
  return new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function makeCopilotResponsesModel() {
  return {
    id: 'gpt-5.6-sol',
    provider: 'github-copilot',
    api: 'openai-responses',
    baseUrl: 'https://api.individual.githubcopilot.com',
    reasoning: true,
    headers: {},
  };
}

export function makeMinimalOpenAIResponse() {
  return makeResponse([
    { data: { type: 'response.done', response: { output: [] } } },
  ]);
}
