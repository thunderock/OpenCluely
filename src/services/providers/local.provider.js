// LocalProvider (PROV-03 text-stream / PROV-04 multimodal-direct / SC4).
//
// Sibling of GeminiProvider: answers text (streaming) and screenshots
// (multimodal-direct, NO OCR) from the local `qwen3-vl:8b` model over the
// OpenAI-compatible endpoint `http://127.0.0.1:11434/v1` using the `openai`
// SDK. This is the core answer engine ("if all else fails, this works").
//
// `serialize(neutral)` is the ONLY place the OpenAI wire shape is built (SC4) —
// no prompt/skill/history assembly lives here; that stays in RequestBuilder.
// The neutral struct's `'model'` history role is renamed to OpenAI `'assistant'`
// and images become base64 data-URL `image_url` parts (RESEARCH Flag 2).
//
// Error philosophy: degrade gracefully, never crash. The constructor is
// network-free (constructing the openai client does not touch Ollama), so it
// never throws even when the daemon is down.

const OpenAI = require('openai');
const config = require('../../core/config');
const { LLMProvider } = require('./llm-provider');
const { RequestBuilder } = require('../../core/request-builder');
const logger = require('../../core/logger').createServiceLogger('LOCAL');

class LocalProvider extends LLMProvider {
  constructor() {
    super();
    const local = config.get('llm.local') || {};
    this.host = local.host || 'http://127.0.0.1:11434';
    this.model = local.model || null;
    this.keepAlive = local.keepAlive != null ? local.keepAlive : -1;

    this.client = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;

    // Real singletons by default (mirrors GeminiProvider / the Phase-1 DI shape).
    this.requestBuilder = new RequestBuilder();

    this.initializeClient();
  }

  // (Re)construct the openai client from config.llm.local.*. Network-free: the
  // client is a thin transport wrapper, so this never pings Ollama and never
  // throws when the daemon is down. Re-reads host/model/keepAlive so a settings
  // change picked up on relaunch takes effect.
  initializeClient() {
    const local = config.get('llm.local') || {};
    this.host = local.host || this.host;
    this.model = local.model || this.model;
    this.keepAlive = local.keepAlive != null ? local.keepAlive : this.keepAlive;

    try {
      // apiKey is required-but-ignored by Ollama's /v1 endpoint (RESEARCH Flag 5).
      this.client = new OpenAI({ baseURL: `${this.host}/v1`, apiKey: 'ollama' });
      this.isInitialized = true;
      logger.info('Local LLM client initialized', { host: this.host, model: this.model });
    } catch (error) {
      this.isInitialized = false;
      logger.error('Failed to initialize local LLM client', { error: error.message });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LLMProvider interface + neutral→wire serialize (the single wire-shape site)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Map the RequestBuilder neutral struct to OpenAI's `{ model, messages }`
   * wire shape. This is the SINGLE place the OpenAI shape is built (SC4):
   * - systemPrompt + mdContext join into one leading `system` message (mdContext
   *   is empty until Phase 5 but wired now as a position-stable prefix);
   * - history's neutral `'model'` role → OpenAI `'assistant'`;
   * - images become base64 data-URL `image_url` parts on the final user turn
   *   (nested `{ url: 'data:<mime>;base64,<b64>' }` object — RESEARCH Flag 2).
   * No prompt/skill/history assembly here.
   */
  serialize(neutral) {
    const messages = [];
    const sys = [neutral.systemPrompt, neutral.mdContext].filter(Boolean).join('\n\n');
    if (sys) messages.push({ role: 'system', content: sys });
    for (const h of neutral.history || []) {
      messages.push({ role: h.role === 'model' ? 'assistant' : 'user', content: h.content });
    }
    if (neutral.images && neutral.images.length) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: neutral.userText },
          ...neutral.images.map(i => ({
            type: 'image_url',
            image_url: { url: `data:${i.mimeType};base64,${i.data}` }
          }))
        ]
      });
    } else {
      messages.push({ role: 'user', content: neutral.userText });
    }
    return { model: this.model, messages };
  }

  /** Provider is configured and ready to serve (client constructed). Liveness of
   * the Ollama daemon is a separate testConnection/health concern. */
  isAvailable() {
    return !!this.isInitialized;
  }

  /**
   * Non-streaming transport core: serialize the neutral struct, run one
   * OpenAI chat completion, return the answer text (language-normalized when
   * options.programmingLanguage is set). `keep_alive` is passed in the body as
   * defense-in-depth so the model stays resident regardless of adopt/own (the
   * authoritative resident mechanism is LocalModelManager's warm-up, 03-04).
   * On error: log + rethrow (callers handle fallback); never crash the process.
   */
  async generate(neutral, options = {}) {
    if (!this.client) throw new Error('Local LLM client not initialized');
    const { model, messages } = this.serialize(neutral);
    try {
      const res = await this.client.chat.completions.create({
        model,
        messages,
        stream: false,
        keep_alive: this.keepAlive
      });
      const text = res?.choices?.[0]?.message?.content || '';
      const lang = options.programmingLanguage || null;
      return lang ? this.enforceProgrammingLanguage(text, lang) : text;
    } catch (error) {
      logger.error('Local generate failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Streaming sibling of generate(): serialize + a streamed OpenAI chat
   * completion, emitting incremental text via onDelta. Returns the full text
   * (language-enforced when set). On error: log + rethrow; never crash.
   */
  async generateStream(neutral, options = {}, onDelta) {
    if (!this.client) throw new Error('Local LLM client not initialized');
    const { model, messages } = this.serialize(neutral);
    let full = '';
    try {
      const stream = await this.client.chat.completions.create({
        model,
        messages,
        stream: true,
        keep_alive: this.keepAlive
      });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
      }
    } catch (error) {
      logger.error('Local generateStream failed', { error: error.message });
      throw error;
    }
    const lang = options.programmingLanguage || null;
    return lang ? this.enforceProgrammingLanguage(full, lang) : full;
  }

  /**
   * Trivial liveness ping: a 1-token chat completion proves the daemon is up
   * AND the model responds. Never throws — returns { success, ... } either way.
   */
  async testConnection() {
    if (!this.isInitialized || !this.client) {
      return { success: false, error: 'Local client not initialized', model: this.model, host: this.host };
    }
    try {
      const startTime = Date.now();
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
        keep_alive: this.keepAlive
      });
      const latency = Date.now() - startTime;
      const text = res?.choices?.[0]?.message?.content || '';
      logger.info('Local connection test succeeded', { model: this.model, latency });
      return { success: true, response: text, latency, model: this.model, host: this.host };
    } catch (error) {
      logger.warn('Local connection test failed', { error: error.message, model: this.model });
      return { success: false, error: error.message, model: this.model, host: this.host };
    }
  }

  /**
   * Normalize all triple-backtick code fences to the selected programming
   * language tag. Pure, provider-agnostic string normalization — copied
   * verbatim from GeminiProvider (gemini.provider.js:651). Used by
   * generate/generateStream when a language is set.
   */
  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const norm = String(programmingLanguage).toLowerCase();
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const fenceTag = fenceTagMap[norm] || norm || 'text';

      // Replace all triple-backtick fences' language token with the selected tag
      const replacedBackticks = text.replace(/```([^\n]*)\n/g, (match, info) => {
        const current = (info || '').trim();
        // If already the desired fenceTag as the first token, keep as is
        if (current.split(/\s+/)[0].toLowerCase() === fenceTag) return match;
        return '```' + fenceTag + '\n';
      });

      // Optionally normalize tildes fences to backticks with correct tag
      const normalizedTildes = replacedBackticks.replace(/~~~([^\n]*)\n/g, () => '```' + fenceTag + '\n');

      return normalizedTildes;
    } catch (_) {
      return text;
    }
  }
}

module.exports = { LocalProvider };
