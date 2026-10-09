import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, FetchFunction, Model } from "@earendil-works/pi-ai";
import { getAuth, getProviderSessionHeaders } from "./auth.ts";
import { getProviderKind } from "./config.ts";
import { readSseEvents } from "./sse.ts";
import {
    applyTextCitations,
    deriveSources,
    mergeSearchResultMetadata,
    normalizeCitedSources,
    pushNativeSearchEvent,
    pushUniqueSearchResult,
    sanitizeSearchResults,
    titleFromUrl,
} from "./results.ts";
import type { NativeSearchCallDetail, SearchResultDetail, StreamResult } from "./types.ts";

const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

function resolveAnthropicMessagesUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
}

type CapturedProviderResponse = {
    response: Response;
    completion: Promise<AssistantMessage>;
};

/**
 * Send an OAuth web search through the effective registered provider (for
 * example pi-black) so wrapper transforms such as billing blocks, identity
 * headers and body signing apply. Only the tools list is replaced.
 */
async function callAnthropicOAuthProvider(
    ctx: ExtensionContext,
    model: Model<Api>,
    prompt: string,
    apiKey: string,
    headers: Record<string, string>,
    maxTokens: number,
    searchTool: Record<string, unknown>,
    signal?: AbortSignal
): Promise<CapturedProviderResponse | undefined> {
    const provider = (ctx.modelRegistry as any).getProvider?.(model.provider);
    if (!provider?.streamSimple) return undefined;

    let resolveResponse!: (response: Response) => void;
    let rejectResponse!: (error: unknown) => void;
    const capturedResponse = new Promise<Response>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
    });
    let captured = false;
    const captureFetch: FetchFunction = async (input, init) => {
        try {
            const response = await globalThis.fetch(input, init);
            if (!captured) {
                captured = true;
                resolveResponse(response.clone());
            }
            return response;
        } catch (error) {
            if (!captured) {
                captured = true;
                rejectResponse(error);
            }
            throw error;
        }
    };

    const context: Context = {
        systemPrompt: "",
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        tools: [],
    };
    // pi-ai treats an explicit anthropic-beta header as the complete beta list,
    // which would drop betas it needs for its own request shape (for example
    // mid-conversation-output-config for managed-effort models). Let the
    // provider compute betas itself; it already adds the OAuth ones.
    const providerHeaders = Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.toLowerCase() !== "anthropic-beta")
    );
    const stream = provider.streamSimple(model, context, {
        apiKey,
        headers: providerHeaders,
        maxTokens,
        maxRetries: 0,
        sessionId: ctx.sessionManager?.getSessionId?.(),
        signal,
        fetch: captureFetch,
        onPayload(payload: unknown) {
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                throw new Error("Anthropic provider produced an invalid request payload");
            }
            return { ...payload, tools: [searchTool] };
        },
    });
    const completion: Promise<AssistantMessage> = stream.result();
    void completion.catch(() => {});
    const response = await Promise.race([
        capturedResponse,
        completion.then((message) => {
            throw new Error(message.errorMessage || "Anthropic provider completed without an HTTP response");
        }),
    ]);
    return { response, completion };
}

// DeepSeek exposes server-side search only on its Anthropic-compatible route.
// Preserve a configured proxy origin/path instead of sending its credentials elsewhere.
export function resolveDeepSeekBaseUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    if (/\/anthropic(?:\/v1)?$/.test(base)) return base;
    return `${base.replace(/\/v1$/, "")}/anthropic`;
}

export async function callAnthropicStream(
    ctx: ExtensionContext,
    model: Model<Api>,
    prompt: string,
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal
): Promise<StreamResult> {
    const kind = getProviderKind(model) === "deepseek" ? "deepseek" : "anthropic";
    const isDeepSeek = kind === "deepseek";
    const providerName = isDeepSeek ? "DeepSeek" : "Anthropic";
    const auth = await getAuth(ctx, model);
    if (!auth.ok) {
        throw new Error(auth.error || "Failed to get API key and headers");
    }

    const isOAuth = !isDeepSeek && !!auth.apiKey && auth.apiKey.includes("sk-ant-oat");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "anthropic-version": "2023-06-01",
        ...(getProviderSessionHeaders(model, ctx) || {}),
        ...(model.headers || {}),
        ...(auth.headers || {}),
    };

    if (auth.apiKey) {
        if (isOAuth) {
            if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${auth.apiKey}`;
            headers["anthropic-beta"] = headers["anthropic-beta"]
                ? `${headers["anthropic-beta"]},claude-code-20250219,oauth-2025-04-20`
                : "claude-code-20250219,oauth-2025-04-20";
            // Anthropic rejects OAuth requests from anything older than 2.1.251.
            headers["user-agent"] = headers["user-agent"] || "claude-cli/2.1.251";
            headers["x-app"] = headers["x-app"] || "cli";
        } else if (!headers["x-api-key"] && !headers["X-Api-Key"]) {
            headers["x-api-key"] = auth.apiKey;
        }
    }

    if (isDeepSeek && !Object.entries(headers).some(([name, value]) =>
        value && ["authorization", "x-api-key"].includes(name.toLowerCase()))) {
        throw new Error("No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.");
    }

    const maxTokens = Math.min(Math.max(1024, Math.floor(model.maxTokens / 3) || 4096), 8192);
    const searchTool = {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: 10,
        // Keep direct search compatible with models without programmatic tool calling.
        allowed_callers: ["direct"],
    };

    // Prefer the effective provider for OAuth so wrappers like pi-black own the
    // Claude Code request shape. Fall back to a direct request otherwise.
    const providerRequest = isOAuth && auth.apiKey
        ? await callAnthropicOAuthProvider(ctx, model, prompt, auth.apiKey, headers, maxTokens, searchTool, signal)
        : undefined;
    const providerCompletion = providerRequest?.completion;

    const requestBody = {
        model: model.id,
        max_tokens: maxTokens,
        // Anthropic rejects oauth-2025-04-20 requests that omit the Claude Code
        // system prompt, reporting it as an opaque 429 rate_limit_error.
        ...(isOAuth ? { system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }] } : {}),
        messages: [{ role: "user", content: prompt }],
        tools: [searchTool],
        stream: true,
    };

    const response = providerRequest?.response ?? await fetch(resolveAnthropicMessagesUrl(isDeepSeek ? resolveDeepSeekBaseUrl(auth.baseUrl || model.baseUrl) : model.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal
    });

    if (!response.ok) {
        if (providerCompletion) await providerCompletion;
        throw new Error(`${providerName} API error (${response.status}): ${await response.text()}`);
    }

    let accumulatedText = "";
    const citations: Array<{ citedText?: string; title: string; url: string }> = [];
    const nativeSearchEvents: string[] = [];
    const nativeSearchCalls: NativeSearchCallDetail[] = [];
    const searchResults: SearchResultDetail[] = [];

    const collectSource = (source: any, toolUseId?: string) => {
        if (!source?.url) return;
        const title = source.title || titleFromUrl(source.url);
        citations.push({ title, url: source.url });
        pushUniqueSearchResult(searchResults, {
            title,
            url: source.url,
            pageAge: source.page_age ?? source.pageAge,
            source: `${kind}.web_search_tool_result`,
            type: source.type || "web_search_result",
            raw: { toolUseId, ...source },
        });
    };

    await readSseEvents(response, signal, ({ data: event }) => {
        if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "text" && block.text) {
                accumulatedText += block.text;
                onUpdate?.({ content: [{ type: "text", text: accumulatedText }], details: { streaming: true } });
            } else if (block?.type === "server_tool_use" && block.name === "web_search") {
                pushNativeSearchEvent(nativeSearchEvents, `${kind}.content_block_start.server_tool_use.web_search`);
                nativeSearchCalls.push({
                    id: block.id,
                    provider: kind,
                    status: "in_progress",
                    actionType: block.name,
                    queries: typeof block.input?.query === "string" ? [block.input.query] : undefined,
                    raw: block,
                });
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText || `Searching the web with ${providerName}...` }],
                    details: { streaming: true, searching: true }
                });
            } else if (block?.type === "web_search_tool_result") {
                pushNativeSearchEvent(nativeSearchEvents, `${kind}.content_block_start.web_search_tool_result`);
                const call = nativeSearchCalls.find((item) => item.id === block.tool_use_id);
                if (call) call.status = "completed";
                else nativeSearchCalls.push({ id: block.tool_use_id, provider: kind, status: "completed", actionType: "web_search", raw: block });
                if (Array.isArray(block.content)) {
                    for (const result of block.content) collectSource(result, block.tool_use_id);
                } else if (block.content?.type === "web_search_tool_result_error") {
                    if (isDeepSeek) throw new Error(`DeepSeek web search failed: ${block.content.error_code || "unknown error"}`);
                    pushUniqueSearchResult(searchResults, {
                        status: block.content.error_code,
                        source: `${kind}.web_search_tool_result_error`,
                        type: block.content.type,
                        raw: block,
                    });
                }
            }
        } else if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
                accumulatedText += delta.text || "";
                onUpdate?.({
                    content: [{ type: "text", text: accumulatedText }],
                    details: { streaming: true }
                });
            } else if (delta?.type === "citations_delta") {
                const citation = delta.citation;
                if (citation?.type === "web_search_result_location" && citation.url) {
                    const detail = {
                        citedText: citation.cited_text,
                        title: citation.title || titleFromUrl(citation.url),
                        url: citation.url,
                        source: `${kind}.citations_delta`,
                        type: citation.type,
                        raw: citation,
                    };
                    citations.push({ citedText: detail.citedText, title: detail.title, url: detail.url });
                    pushUniqueSearchResult(searchResults, detail);
                }
            }
        } else if (event.type === "error") {
            throw new Error(event.error?.message || JSON.stringify(event.error || event));
        }
    });

    if (providerCompletion) {
        const providerMessage = await providerCompletion;
        if (providerMessage.stopReason === "error" || providerMessage.stopReason === "aborted") {
            throw new Error(providerMessage.errorMessage || "Anthropic provider request failed");
        }
    }

    const cited = applyTextCitations(accumulatedText || "No answer available.", citations);
    const citationDetails = citations.map((citation) => ({
        title: citation.title || titleFromUrl(citation.url),
        url: citation.url,
        citedText: citation.citedText,
        source: `${kind}.citation`,
        type: "citation",
        raw: citation,
    }));
    mergeSearchResultMetadata(searchResults, citationDetails);
    const sanitizedSearchResults = sanitizeSearchResults(searchResults);
    const sanitizedCitations = sanitizeSearchResults(citationDetails);
    mergeSearchResultMetadata(sanitizedSearchResults, sanitizedCitations);
    const derivedSources = deriveSources(sanitizedSearchResults, sanitizedCitations);

    return {
        text: cited.text,
        sources: cited.sources.length ? normalizeCitedSources(cited.sources) : derivedSources,
        providerKind: kind,
        nativeSearchUsed: nativeSearchEvents.length > 0 || nativeSearchCalls.length > 0 || sanitizedSearchResults.length > 0,
        nativeSearchEvents,
        nativeSearchCalls,
        searchQueries: nativeSearchCalls.flatMap((call) => call.queries || []),
        searchResults: sanitizedSearchResults,
        citations: sanitizedCitations,
    };
}
