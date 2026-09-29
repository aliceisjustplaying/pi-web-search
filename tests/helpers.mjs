import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Baseline isolation: tests must never read the developer's real
// ~/.pi/agent/web-search.json. Every config-touching helper restores this path
// instead of clearing the variable, so tests cannot fall back to the real
// agent directory just because an earlier test ran with a temp path.
const baselineDir = await mkdtemp(join(tmpdir(), 'pi-web-search-baseline-'));
process.env.PI_WEB_SEARCH_CONFIG = join(baselineDir, 'web-search.json');
process.on('exit', () => {
  rmSync(baselineDir, { recursive: true, force: true });
});

/**
 * A ctx whose model registry covers the surface the extension actually calls:
 * getApiKeyAndHeaders, getAvailable, and find. `options.models` backs find and
 * getAvailable; `options.find` overrides find for bespoke lookups.
 */
export function createMockCtx(apiKey, model, headers, baseUrl, options = {}) {
  const resolvedApiKey = arguments.length === 0 ? 'test-key' : apiKey;
  const models = options.models ?? (model ? [model] : []);
  const ctx = {
    model,
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: resolvedApiKey, headers, baseUrl };
      },
      getAvailable() {
        return models;
      },
      find(provider, modelId) {
        return models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
      },
    },
  };
  if (options.find) ctx.modelRegistry.find = options.find;
  if (options.sessionId !== undefined) {
    ctx.sessionManager = { getSessionId: () => options.sessionId };
  }
  return ctx;
}

/** Run `fn` with PI_WEB_SEARCH_CONFIG pointing at a temp file holding `config`, or no file when config is null. */
export async function withWebSearchConfig(config, fn) {
  const previous = process.env.PI_WEB_SEARCH_CONFIG;
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-search-config-'));
  const configPath = join(dir, 'web-search.json');
  process.env.PI_WEB_SEARCH_CONFIG = configPath;
  try {
    if (config !== null && config !== undefined) {
      await writeFile(configPath, JSON.stringify(config));
    }
    return await fn(configPath);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with a temp PI_CODING_AGENT_DIR and no PI_WEB_SEARCH_CONFIG, for default-path tests. */
export async function withAgentDir(files, fn) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousConfigPath = process.env.PI_WEB_SEARCH_CONFIG;
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-web-search-agent-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_WEB_SEARCH_CONFIG;
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(agentDir, name), typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    return await fn(agentDir);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousConfigPath === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
    else process.env.PI_WEB_SEARCH_CONFIG = previousConfigPath;
    await rm(agentDir, { recursive: true, force: true });
  }
}
