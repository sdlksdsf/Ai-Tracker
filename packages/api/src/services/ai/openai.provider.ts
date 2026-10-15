import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { UpstreamServiceError } from '../../lib/errors.js';
import { computeCost, estimateTokens } from './cost.js';
import { extractJson, fetchJson } from './http.js';
import { normalizeGeminiVision } from './gemini.provider.js';
import type {
  AiCallResult,
  AiProviderName,
  ReasoningProvider,
  ReasoningRequest,
  VisionProvider,
  VisionRequest,
  VisionResult,
} from './types.js';

/**
 * OpenAI provider — the vision fallback (Step 4 of the scanning pipeline) and
 * the reasoning fallback when Anthropic is rate-limited or unavailable.
 *
 * Handles the differences between the GPT-4o family and the GPT-5/o-series:
 *   • reasoning models reject a non-default `temperature`
 *   • reasoning models use `max_completion_tokens` instead of `max_tokens`
 * On a 400 that mentions either parameter we automatically retry in the
 * compatible shape, so a model upgrade never breaks the pipeline.
 */

interface ChatMessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; role?: string };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAiProvider implements VisionProvider, ReasoningProvider {
  readonly name: AiProviderName = 'openai';

  constructor(
    private readonly options: {
      visionModel?: string;
      reasoningModel?: string;
      apiKey?: string;
      baseUrl?: string;
    } = {},
  ) {}

  private get apiKey(): string | undefined {
    return this.options.apiKey ?? env.OPENAI_API_KEY;
  }

  private get baseUrl(): string {
    return (this.options.baseUrl ?? env.AI_VISION_OPENAI_BASE_URL).replace(/\/$/, '');
  }

  get model(): string {
    return this.options.visionModel ?? env.AI_VISION_FALLBACK_MODEL;
  }

  get reasoningModel(): string {
    return this.options.reasoningModel ?? env.AI_REASONING_FALLBACK_MODEL;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Reasoning-style models (GPT-5.x, o-series) do not accept `temperature`. */
  private static isReasoningModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4');
  }

  // -------------------------------------------------------------------------
  // Vision
  // -------------------------------------------------------------------------

  async analyse(request: VisionRequest): Promise<AiCallResult<VisionResult>> {
    if (!this.isConfigured) throw new UpstreamServiceError('OPENAI_API_KEY is not set');

    const model = this.model;
    const systemPrompt = request.hint
      ? `You are PlateMatch AI, a food identification expert. ${request.hint}`
      : 'You are PlateMatch AI, a food identification expert.';

    const content: ChatMessageContent[] = [
      {
        type: 'text',
        text:
          'Identify every food item in this refrigerator/pantry photograph.\n' +
          'Return JSON exactly like: {"detected_items":[{"name","category","estimated_quantity","estimated_unit","freshness","confidence","expiry_label_read","suggested_shelf_life_days"}],"overall_fridge_status","suggestions"}\n' +
          'Categories: vegetable, fruit, dairy, meat, seafood, grain, spice, condiment, beverage, snack, frozen, canned, bakery, legume, nut_seed, oil_fat, sweetener, other.\n' +
          'Freshness: fresh | ripening | overripe | spoiled.\n' +
          'Confidence is 0..1; omit anything below 0.65. Ignore non-food items. Group identical items with a count.',
      },
      {
        type: 'image_url',
        image_url: { url: `data:${request.mimeType};base64,${request.image.toString('base64')}`, detail: 'high' },
      },
    ];

    const started = Date.now();
    const body = this.buildBody(model, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content },
      ],
      maxTokens: 4096,
      temperature: 0.2,
      responseFormat: { type: 'json_object' },
    });

    const result = await this.postChat(body, model, request.signal, 'vision');
    const latencyMs = Date.now() - started;

    const text = result.choices?.[0]?.message?.content ?? '';
    if (!text) throw new UpstreamServiceError('OpenAI returned an empty completion');

    const parsed = extractJson<Record<string, unknown>>(text);
    // Reuse the Gemini normaliser — both providers are asked for the same shape.
    const visionResult = normalizeGeminiVision(parsed as never, model);

    const promptTokens = result.usage?.prompt_tokens ?? estimateTokens(text);
    const completionTokens = result.usage?.completion_tokens ?? estimateTokens(text);

    return {
      data: visionResult,
      provider: this.name,
      model,
      latencyMs,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: result.usage?.total_tokens ?? promptTokens + completionTokens,
        costUsd: computeCost({ model, promptTokens, completionTokens }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Reasoning
  // -------------------------------------------------------------------------

  async generateJson<T>(request: ReasoningRequest): Promise<AiCallResult<T>> {
    if (!this.isConfigured) throw new UpstreamServiceError('OPENAI_API_KEY is not set');

    const model = this.options.reasoningModel ?? this.reasoningModel;
    const started = Date.now();

    const body = this.buildBody(model, {
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      responseFormat: { type: 'json_object' },
    });

    const result = await this.postChat(body, model, request.signal, request.label ?? 'json');
    const latencyMs = Date.now() - started;

    const text = result.choices?.[0]?.message?.content ?? '';
    if (!text) throw new UpstreamServiceError('OpenAI returned an empty completion');

    const data = extractJson<T>(text);
    const promptTokens = result.usage?.prompt_tokens ?? estimateTokens(request.prompt);
    const completionTokens = result.usage?.completion_tokens ?? estimateTokens(text);

    return {
      data,
      provider: this.name,
      model,
      latencyMs,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: result.usage?.total_tokens ?? promptTokens + completionTokens,
        costUsd: computeCost({ model, promptTokens, completionTokens }),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildBody(
    model: string,
    opts: {
      messages: Array<Record<string, unknown>>;
      maxTokens: number;
      temperature: number;
      responseFormat?: Record<string, unknown>;
    },
  ): Record<string, unknown> {
    const reasoning = OpenAiProvider.isReasoningModel(model);
    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      response_format: opts.responseFormat ?? { type: 'json_object' },
    };

    // Reasoning models: `max_completion_tokens`, default temperature only.
    if (reasoning) {
      body.max_completion_tokens = opts.maxTokens;
      body.reasoning_effort = opts.temperature >= 0.7 ? 'medium' : 'low';
    } else {
      body.max_tokens = opts.maxTokens;
      body.temperature = opts.temperature;
    }

    return body;
  }

  private async postChat(
    body: Record<string, unknown>,
    model: string,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    const attempt = async (payload: Record<string, unknown>, tag: string) =>
      fetchJson<ChatCompletionResponse>(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey as string}` },
        body: payload,
        timeoutMs: env.AI_TIMEOUT_MS,
        retries: 1,
        signal,
        label: `openai:${model}:${tag}`,
        allowErrorStatus: true,
      });

    const first = await attempt(body, label);
    if (first.status < 400) return first.data;

    const message = first.data.error?.message ?? `HTTP ${first.status}`;

    // GPT-5/o-series compatibility shims.
    if (/temperature/i.test(message) && body.temperature !== undefined) {
      logger.warn({ model, message }, 'OpenAI rejected temperature — retrying without it');
      const { temperature: _temperature, ...rest } = body;
      const retry = await attempt(rest, `${label}:notemp`);
      if (retry.status < 400) return retry.data;
      throw new UpstreamServiceError(`OpenAI call failed: ${retry.data.error?.message ?? `HTTP ${retry.status}`}`, {
        status: retry.status,
      });
    }

    if (/max_tokens/i.test(message)) {
      logger.warn({ model, message }, 'OpenAI rejected max_tokens — retrying with max_completion_tokens');
      const { max_tokens: maxTokens, ...rest } = body;
      const retry = await attempt({ ...rest, max_completion_tokens: maxTokens }, `${label}:mct`);
      if (retry.status < 400) return retry.data;
      throw new UpstreamServiceError(`OpenAI call failed: ${retry.data.error?.message ?? `HTTP ${retry.status}`}`, {
        status: retry.status,
      });
    }

    if (/response_format|json_object/i.test(message)) {
      logger.warn({ model, message }, 'OpenAI rejected response_format — retrying in plain mode');
      const { response_format: _rf, ...rest } = body;
      const retry = await attempt(rest, `${label}:nojson`);
      if (retry.status < 400) return retry.data;
      throw new UpstreamServiceError(`OpenAI call failed: ${retry.data.error?.message ?? `HTTP ${retry.status}`}`, {
        status: retry.status,
      });
    }

    throw new UpstreamServiceError(`OpenAI call failed: ${message}`, { status: first.status, code: first.data.error?.code });
  }
}
