// LocalProvider (PROV-03 text-stream / PROV-04 multimodal-direct / SC4).
//
// The sole LLM engine (PROV-07 removed the cloud path): answers text
// (streaming) and screenshots
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
const { ensureNativeGlobalURL, nodeFetch } = require('../../core/local-transport');
const logger = require('../../core/logger').createServiceLogger('LOCAL');

class LocalProvider extends LLMProvider {
  constructor() {
    super();
    const local = config.get('llm.local') || {};
    this.host = local.host || 'http://127.0.0.1:11434';
    this.model = local.model || null;
    this.keepAlive = local.keepAlive != null ? local.keepAlive : -1;
    this.think = local.think === true; // qwen3 reasoning OFF by default → concise replies (GEN-01)

    this.client = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;

    // Real singletons by default (the Phase-1 DI shape).
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
    this.think = local.think === true; // re-read so a settings change takes effect on relaunch

    // The Azure STT browser-DOM polyfill (speech.service.js, required at main.js
    // startup) poisons global.URL with a fake that has no `searchParams` — which
    // the openai SDK's internal buildURL relies on (Object.fromEntries(
    // url.searchParams)). Restore the native global URL before constructing the
    // client (idempotent no-op when unpolluted; see local-transport.js).
    ensureNativeGlobalURL();

    try {
      // - dangerouslyAllowBrowser: the same polyfill sets window+document+navigator,
      //   which trips the SDK's browser guard in the Electron MAIN process; we are
      //   not actually in a browser, so the guard is a false positive here.
      // - fetch: nodeFetch forces a Node-http transport so requests reach the
      //   loopback daemon; the ambient Electron main fetch (Chromium-net) false-
      //   negatives loopback.
      // - apiKey is required-but-ignored by Ollama's /v1 endpoint (RESEARCH Flag 5).
      this.client = new OpenAI({
        baseURL: `${this.host}/v1`,
        apiKey: 'ollama',
        dangerouslyAllowBrowser: true,
        fetch: nodeFetch,
      });
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
    let sys = [neutral.systemPrompt, neutral.mdContext].filter(Boolean).join('\n\n');
    // qwen3(-vl) is a reasoning model that emits a verbose <think> chain-of-thought
    // by default — wrong for a concise reply-suggester (GEN-01). The `/no_think`
    // soft-switch disables it (Ollama's /v1 has no `think` param; the qwen3 chat
    // template honors /no_think in the messages). Gated by config.llm.local.think.
    if (!this.think) sys = sys ? `${sys}\n\n/no_think` : '/no_think';
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
   * language tag. Pure, provider-agnostic string normalization. Used by
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

  // ───────────────────────────────────────────────────────────────────────
  // main.js call-site surface. The facade re-exports the selected provider, so
  // main.js calls these directly. Each returns byte-compatible
  // { response, metadata } so every llmService.* consumer keeps working
  // unchanged. Each builds the neutral struct via RequestBuilder, then streams
  // through generateStream, timing processingTime and counting requests.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Screenshot → direct multimodal answer (PROV-04, NO OCR). Streams tokens via
   * onDelta. On any failure, degrades to the canned fallback so the overlay
   * never goes blank.
   */
  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, _sessionMemory = [], programmingLanguage = null, onDelta = null) {
    const startTime = Date.now();
    this.requestCount++;
    try {
      const neutral = this.requestBuilder.buildImageRequest(imageBuffer, mimeType, activeSkill, programmingLanguage);
      const response = await this.generateStream(neutral, { programmingLanguage }, onDelta);
      logger.logPerformance('Local image streaming', startTime, { activeSkill, requestId: this.requestCount });
      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.warn('Local image streaming failed, using fallback', { error: error.message, requestId: this.requestCount });
      return this.generateIntelligentFallbackResponse('[image]', activeSkill);
    }
  }

  /** Text prompt → streamed answer (PROV-03). Degrades to the canned fallback. */
  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    const startTime = Date.now();
    this.requestCount++;
    try {
      const neutral = this.requestBuilder.buildTextRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const response = await this.generateStream(neutral, { programmingLanguage }, onDelta);
      logger.logPerformance('Local text streaming', startTime, { activeSkill, requestId: this.requestCount });
      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.warn('Local text streaming failed, using fallback', { error: error.message, requestId: this.requestCount });
      return this.generateIntelligentFallbackResponse(text, activeSkill);
    }
  }

  /** Transcribed speech → streamed intelligent response. Degrades to fallback. */
  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    const startTime = Date.now();
    this.requestCount++;
    try {
      const neutral = this.requestBuilder.buildTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);
      const response = await this.generateStream(neutral, { programmingLanguage }, onDelta);
      logger.logPerformance('Local transcription streaming', startTime, { activeSkill, requestId: this.requestCount });
      return {
        response,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.warn('Local transcription streaming failed, using fallback', { error: error.message, requestId: this.requestCount });
      return this.generateIntelligentFallbackResponse(text, activeSkill);
    }
  }

  /**
   * Canned, model-availability-oriented fallback so the overlay never goes
   * blank when Local is down. Reused by the Local-down recovery UX (03-06).
   */
  generateIntelligentFallbackResponse(text, activeSkill) {
    logger.info('Generating local-model-unavailable fallback response', { activeSkill });

    const textLower = (text || '').toLowerCase();
    const questionIndicators = ['how', 'what', 'why', 'when', 'where', 'can you', 'could you', 'should i', '?'];
    const seemsLikeQuestion = questionIndicators.some(indicator => textLower.includes(indicator));

    const response = seemsLikeQuestion
      ? "Local model unavailable right now, so I can't answer that yet — restart Ollama or re-download the model from Settings, then ask again."
      : 'Local model unavailable right now — restart Ollama or re-download the model from Settings.';

    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: 0,
        requestId: this.requestCount,
        usedFallback: true,
        isTranscriptionResponse: true
      }
    };
  }

  /** Runtime stats for the status IPC. */
  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      provider: 'local',
      model: this.model,
      host: this.host
    };
  }

  /**
   * Local has no API key (apiKey:'ollama' is required-but-ignored). No-op that
   * re-reads host/model and reconstructs the client, kept for compatibility with
   * the shared provider IPC path.
   */
  updateApiKey(_newApiKey) {
    logger.info('Local provider has no API key; re-reading host/model from config');
    this.initializeClient();
  }

  /**
   * LOCAL health probe. Probes the Ollama server (/api/version) and the
   * model list (/v1/models),
   * returning a { timestamp, tests: [...] } shape compatible with the
   * diagnostics consumer. Never throws.
   */
  async checkNetworkConnectivity() {
    const probes = [
      { name: 'Ollama server (/api/version)', url: `${this.host}/api/version` },
      { name: 'Model list (/v1/models)', url: `${this.host}/v1/models` }
    ];

    const tests = [];
    for (const probe of probes) {
      try {
        const res = await this._fetchWithTimeout(probe.url, 3000);
        tests.push({ name: probe.name, url: probe.url, success: !!res.ok, error: res.ok ? null : `HTTP ${res.status}` });
      } catch (error) {
        tests.push({ name: probe.name, url: probe.url, success: false, error: error.message });
      }
    }

    const connectivity = { timestamp: new Date().toISOString(), tests };
    logger.info('Local connectivity check completed', connectivity);
    return connectivity;
  }

  /** GET with an abort timeout; backs the local health probe. Uses nodeFetch
   * (Node http) rather than the ambient fetch so the loopback probe is not
   * false-negatived by the Electron main Chromium-net stack. */
  async _fetchWithTimeout(url, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await nodeFetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { LocalProvider };
