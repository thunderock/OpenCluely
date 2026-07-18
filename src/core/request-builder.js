// RequestBuilder (PROV-02 / SC4).
//
// Pure, dependency-injected assembly of the app's known inputs (skill, text /
// image, conversation history, md-context) into ONE input-neutral request
// struct. No provider wire shape (no contents / parts / systemInstruction /
// generationConfig) is produced here — each provider serializes the neutral
// struct in its own step (Plan 02-02). Prompt / skill / system / history
// assembly is carved VERBATIM out of src/services/llm.service.js so answers do
// not drift while the seam is introduced.
//
// Mirrors the Phase-1 DI-for-testability shape (service-supervisor.js): export
// the class, inject collaborators, default to the real singletons.

class RequestBuilder {
  constructor({ sessionManager, promptLoader } = {}) {
    this.sessionManager = sessionManager || require('../managers/session.manager');
    this.promptLoader = promptLoader || require('../../prompt-loader').promptLoader;
  }

  // ── Prompt helpers moved VERBATIM from llm.service.js (byte-identical) ──

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  formatImageInstruction(activeSkill) {
    return `Analyze this image for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.`;
  }

  getIntelligentTranscriptionPrompt(activeSkill) {
    let prompt = `# Intelligent Transcription Response System

You are a concise, private copilot in ${activeSkill.toUpperCase()} mode. You hear the live conversation and see the user's screen and notes; suggest what to say or do next.
Reply with the actual words to say or the direct answer — not meta-commentary — and never mention that you are an AI or that you are assisting.
Respond to the point: do not repeat the question or add information the moment does not need.`;

    prompt += `

## Response Rules:

### Default: keep it short
- Reply with 1–3 sentences or a tight list — the ready-to-use suggestion, nothing more.
- Lead with the answer or the exact words to say; skip preamble.

### Expand only when the question clearly needs depth
- For a coding problem or a request that explicitly needs a detailed explanation, give a comprehensive, structured answer with steps, examples, and code.
- Do not truncate a genuinely complex answer just to stay short.

### If the transcription is casual conversation, small talk, or needs no substantive reply
- Say nothing of substance — a brief acknowledgment at most (e.g., "Got it.").
- Do not invent a question or pad the response.

## Response Format:
- Match the depth of the response to what the question actually needs.
- Use bullet points only when they make a multi-part answer clearer.
- Stay in ${activeSkill.toUpperCase()} mode.

If the user's input is a coding problem statement and contains no code, produce a complete, runnable solution — default to Python unless the question, on-screen code, or spoken context clearly indicates another language — without asking for more details, with the final implementation in a properly tagged code block.

Remember: default to a short, ready-to-use suggestion; expand only when the question genuinely needs depth.`;

    return prompt;
  }

  // ── Neutral request builders (assembly only; no provider wire shape) ──

  // Text path (assembly only; provider serializes to its own wire shape).
  // History cap: 15 recent events.
  buildTextRequest(text, activeSkill, sessionMemory = [], mdContext = '') {
    const sessionManager = this.sessionManager;

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill);

      const history = conversationHistory
        .filter(event => {
          return event.role !== 'system' &&
                 event.content &&
                 typeof event.content === 'string' &&
                 event.content.trim().length > 0;
        })
        .map(event => {
          const content = event.content.trim();
          return {
            role: event.role === 'model' ? 'model' : 'user',
            content
          };
        });

      const userText = this.formatUserMessage(text, activeSkill);
      if (!userText || userText.trim().length === 0) {
        throw new Error('Failed to format user message or message is empty');
      }

      return {
        kind: 'text',
        skill: activeSkill,
        systemPrompt: skillContext.skillPrompt || null,
        userText,
        images: [],
        history,
        mdContext
      };
    }

    // Fallback branch (no conversation-history session manager).
    const requestComponents = this.promptLoader.getRequestComponents(
      activeSkill,
      text,
      sessionMemory
    );

    const systemPrompt = requestComponents.shouldUseModelMemory && requestComponents.skillPrompt
      ? requestComponents.skillPrompt
      : null;

    return {
      kind: 'text',
      skill: activeSkill,
      systemPrompt,
      userText: this.formatUserMessage(text, activeSkill),
      images: [],
      history: [],
      mdContext
    };
  }

  // Replicates the inline image assembly in processImageWithSkill. No history.
  buildImageRequest(imageBufferOrBase64, mimeType, activeSkill, mdContext = '') {
    const skillPrompt = this.promptLoader.getSkillPrompt(activeSkill) || '';
    const base64 = Buffer.isBuffer(imageBufferOrBase64)
      ? imageBufferOrBase64.toString('base64')
      : imageBufferOrBase64;

    return {
      kind: 'image',
      skill: activeSkill,
      systemPrompt: skillPrompt && skillPrompt.trim().length > 0 ? skillPrompt : null,
      userText: this.formatImageInstruction(activeSkill),
      images: [{ data: base64, mimeType }],
      history: [],
      mdContext
    };
  }

  // Replicates buildIntelligentTranscriptionRequest[WithHistory].
  // History cap: 10 recent events, then last 8.
  buildTranscriptionRequest(text, activeSkill, _sessionMemory = [], mdContext = '') {
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    const systemPrompt = this.getIntelligentTranscriptionPrompt(activeSkill);
    const sessionManager = this.sessionManager;

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(10);

      const history = conversationHistory
        .filter(event => {
          return event.role !== 'system' &&
                 event.content &&
                 typeof event.content === 'string' &&
                 event.content.trim().length > 0;
        })
        .slice(-8)
        .map(event => {
          const content = event.content.trim();
          if (!content) {
            return null;
          }
          return {
            role: event.role === 'model' ? 'model' : 'user',
            content
          };
        })
        .filter(entry => entry !== null);

      return {
        kind: 'transcription',
        skill: activeSkill,
        systemPrompt,
        userText: cleanText,
        images: [],
        history,
        mdContext
      };
    }

    // Fallback branch (no conversation-history session manager).
    return {
      kind: 'transcription',
      skill: activeSkill,
      systemPrompt,
      userText: cleanText,
      images: [],
      history: [],
      mdContext
    };
  }
}

module.exports = { RequestBuilder };
