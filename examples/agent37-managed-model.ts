/**
 * Use Agent37's managed LLM router (available inside Agent37 instances) as a
 * Mastra model, with computer-use screenshots working.
 *
 * The router speaks OpenAI chat completions, where a tool result can only be
 * text. Sent as-is, every screenshot a computer tool returns would be
 * serialized into the prompt as base64 text (hundreds of thousands of
 * tokens). This adapter rewrites each request: it moves tool-result images
 * into a user message right after the tool results, as real image inputs, and
 * keeps only the newest few so long sessions stay small.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

interface ChatMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

interface ToolPart {
  type: string;
  text?: string;
  data?: string | { type: string; data?: string };
  mediaType?: string;
}

/** The base64 data of an image part, in the shapes AI SDK versions serialize tool output with. */
function imageData(part: ToolPart): string | undefined {
  const isImage = part.type === 'image-data' || part.type === 'media' || (part.type === 'file' && part.mediaType?.startsWith('image/'));
  if (!isImage) return undefined;
  return typeof part.data === 'string' ? part.data : part.data?.data;
}

type ChatModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>;

/** An OpenAI-compatible chat model on the Agent37 LLM router. Call only inside an Agent37 instance. */
export function agent37ManagedModel(modelId = 'default', options: { keepScreenshots?: number } = {}): ChatModel {
  const baseURL = process.env.AGENT37_LLM_PROXY_URL;
  const apiKey = process.env.AGENT37_MANAGED_TOKEN;
  if (!baseURL || !apiKey) throw new Error('AGENT37_LLM_PROXY_URL and AGENT37_MANAGED_TOKEN are only set inside Agent37 instances');
  const keep = options.keepScreenshots ?? 3;
  const provider = createOpenAICompatible({
    name: 'agent37',
    baseURL,
    apiKey,
    fetch: async (input, init) => {
      if (typeof init?.body === 'string' && String(input).endsWith('/chat/completions')) {
        const body = JSON.parse(init.body) as { messages: ChatMessage[] };
        body.messages = liftToolImages(body.messages, keep);
        init = { ...init, body: JSON.stringify(body) };
      }
      return fetch(input, init);
    },
  });
  return provider.chatModel(modelId);
}

function parseToolParts(content: unknown): ToolPart[] | undefined {
  if (typeof content !== 'string' || !content.startsWith('[')) return undefined;
  try {
    const parts = JSON.parse(content);
    return Array.isArray(parts) && parts.some(p => p && imageData(p)) ? parts : undefined;
  } catch {
    return undefined;
  }
}

/** Move images out of tool messages into a following user message, keeping the newest `keep` images. */
export function liftToolImages(messages: ChatMessage[], keep: number): ChatMessage[] {
  const totalImages = messages.reduce(
    (count, m) => count + (m.role === 'tool' ? (parseToolParts(m.content)?.filter(p => imageData(p)).length ?? 0) : 0),
    0,
  );
  let seen = 0;
  const out: ChatMessage[] = [];
  let pending: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  const flush = () => {
    if (pending.length === 0) return;
    out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshots returned by the tool calls above:' }, ...pending] });
    pending = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flush();
    const parts = message.role === 'tool' ? parseToolParts(message.content) : undefined;
    if (!parts) {
      out.push(message);
      continue;
    }
    const texts: string[] = [];
    for (const part of parts) {
      const data = imageData(part);
      if (!data) {
        if (part.text) texts.push(part.text);
        continue;
      }
      seen += 1;
      if (seen <= totalImages - keep) {
        texts.push('[older screenshot omitted]');
        continue;
      }
      texts.push('[screenshot attached in the next message]');
      pending.push({ type: 'image_url', image_url: { url: `data:${part.mediaType ?? 'image/png'};base64,${data}` } });
    }
    out.push({ ...message, content: texts.join('\n') });
  }
  flush();
  return out;
}
