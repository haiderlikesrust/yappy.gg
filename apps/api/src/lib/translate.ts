import { env } from '../env.js';

/**
 * Message translation, behind an explicit per-message request.
 *
 * Privacy line, same as yapper's: no message is ever read by a model
 * ambiently. This function only runs when a member of the conversation
 * presses "translate" on a message they can already read — a deliberate,
 * per-message act by someone the message was already visible to.
 */

const TIMEOUT_MS = 15_000;

/** Longest message we will pay to translate. Matches nothing in LIMITS on
 *  purpose — this is a cost bound, not a validation rule. */
export const TRANSLATE_MAX_CHARS = 4_000;

export interface TranslationResult {
  /** The translated text. */
  translation: string;
  /** What the model believes the source language was, as an English name. */
  detected: string;
}

export function translationAvailable(): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

export async function translateText(
  text: string,
  /** BCP-47-ish target ("en", "ur", "pt-BR") or an English language name. */
  to: string,
): Promise<TranslationResult | null> {
  if (!env.OPENAI_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content: [
              `Translate the user's message into the language "${to}".`,
              'Preserve tone, slang, emoji, @mentions, URLs, and anything inside backticks or code fences verbatim.',
              'If the message is already in the target language, return it unchanged.',
              'Output only the structured result — no commentary.',
            ].join(' '),
          },
          { role: 'user', content: text },
        ],
        max_completion_tokens: 2_000,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'translation',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                translation: { type: 'string' },
                detected: { type: 'string' },
              },
              required: ['translation', 'detected'],
            },
          },
        },
        ...(env.OPENAI_MODEL.startsWith('gpt-5') ? { reasoning_effort: 'minimal' } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return null;

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const rawContent = payload.choices?.[0]?.message?.content;
  if (!rawContent) return null;
  try {
    const parsed = JSON.parse(rawContent) as TranslationResult;
    if (typeof parsed.translation !== 'string' || !parsed.translation) return null;
    return { translation: parsed.translation, detected: String(parsed.detected ?? 'unknown') };
  } catch {
    return null;
  }
}
