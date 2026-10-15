import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { UpstreamServiceError } from '../../lib/errors.js';
import { computeCost, estimateTokens } from './cost.js';
import { extractJson, fetchJson } from './http.js';
import type { AiCallResult, AiProviderName, ReasoningProvider, ReasoningRequest } from './types.js';

/**
 * Anthropic Claude provider — the primary reasoning engine for recipe and
 * meal-plan generation (Section 5.B / 5.C).
 *
 * Claude is chosen for this role because it follows long, constraint-heavy
 * instructions (allergies, macro targets, budgets) more reliably than any other
 * model we benchmarked, and it emits clean JSON without a schema parameter.
 *
 * API: `POST https://api.anthropic.com/v1/messages`
 * Headers: `x-api-key`, `anthropic-version`.
 */

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements ReasoningProvider {
  readonly name: AiProviderName = 'anthropic';

  constructor(
    private readonly options: {
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      version?: string;
    } = {},
  ) {}

  private get apiKey(): string | undefined {
    return this.options.apiKey ?? env.ANTHROPIC_API_KEY;
  }

  private get baseUrl(): string {
    return (this.options.baseUrl ?? env.AI_ANTHROPIC_BASE_URL).replace(/\/$/, '');
  }

  get model(): string {
    return this.options.model ?? env.AI_REASONING_PRIMARY_MODEL;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generateJson<T>(request: ReasoningRequest): Promise<AiCallResult<T>> {
    if (!this.isConfigured) throw new UpstreamServiceError('ANTHROPIC_API_KEY is not set');

    const model = this.options.model ?? env.AI_REASONING_PRIMARY_MODEL;
    const url = `${this.baseUrl}/v1/messages`;
    const started = Date.now();

    // Claude does not take a JSON-schema parameter on the Messages API, so we
    // rely on the prompt contract plus a tool-style "prefill" of the assistant
    // turn with `{` which reliably steers it into emitting raw JSON.
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      system: request.system,
      messages: [
        { role: 'user', content: request.prompt },
        // Prefill: forces the model to continue a JSON document.
        { role: 'assistant', content: '{' },
      ],
    };

    let response: AnthropicResponse;
    let result;
    /** True while the request carries an assistant `{` prefill. */
    let prefilled = true;

    try {
      result = await fetchJson<AnthropicResponse>(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey as string,
          'anthropic-version': this.options.version ?? env.AI_ANTHROPIC_VERSION,
        },
        body,
        timeoutMs: env.AI_TIMEOUT_MS,
        retries: 2,
        signal: request.signal,
        label: `anthropic:${model}:${request.label ?? 'json'}`,
        allowErrorStatus: true,
      });
      response = result.data;
    } catch (err) {
      throw new UpstreamServiceError(`Anthropic call failed: ${(err as Error).message}`);
    }

    if (result.status >= 400) {
      const message = response.error?.message ?? `HTTP ${result.status}`;

      // Some deployments reject the assistant prefill — retry without it.
      if (/assistant|prefill|messages/i.test(message)) {
        logger.warn({ model, message }, 'Anthropic rejected the assistant prefill — retrying without it');
        prefilled = false;
        const retryBody = { ...body, messages: [{ role: 'user', content: request.prompt }] };
        const retry = await fetchJson<AnthropicResponse>(url, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey as string,
            'anthropic-version': this.options.version ?? env.AI_ANTHROPIC_VERSION,
          },
          body: retryBody,
          timeoutMs: env.AI_TIMEOUT_MS,
          retries: 1,
          signal: request.signal,
          label: `anthropic:${model}:noprefill`,
        });
        response = retry.data;
      } else {
        throw new UpstreamServiceError(`Anthropic call failed: ${message}`, {
          status: result.status,
          code: response.error?.type,
        });
      }
    }

    const latencyMs = Date.now() - started;
    const rawText = (response.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');

    if (!rawText.trim()) {
      throw new UpstreamServiceError('Anthropic returned an empty response', { stopReason: response.stop_reason });
    }

    // The assistant prefill consumed the leading `{`; restore it before parsing.
    const text = prefilled ? `{${rawText}` : rawText;

    const data = extractJson<T>(text);

    const promptTokens = response.usage?.input_tokens ?? estimateTokens(request.prompt);
    const completionTokens = response.usage?.output_tokens ?? estimateTokens(rawText);

    return {
      data,
      provider: this.name,
      model: response.model ?? model,
      latencyMs,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUsd: computeCost({ model: response.model ?? model, promptTokens, completionTokens }),
      },
    };
  }
}
