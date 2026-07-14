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

  formatImageInstruction(activeSkill, programmingLanguage) {
    const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
    return `Analyze this image for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.${langNote}`;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    let prompt = `# Intelligent Transcription Response System

Assume you are asked a question in ${activeSkill.toUpperCase()} mode. Your job is to intelligently respond to question/message with appropriate brevity.
Assume you are in an interview and you need to perform best in ${activeSkill.toUpperCase()} mode.
Always respond to the point, do not repeat the question or unnecessary information which is not related to ${activeSkill}.`;

    // Add programming language context if provided
    if (programmingLanguage) {
      const lang = String(programmingLanguage).toLowerCase();
      const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript' };
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const languageTitle = languageMap[lang] || (lang.charAt(0).toUpperCase() + lang.slice(1));
      const fenceTag = fenceTagMap[lang] || lang || 'text';
      prompt += `\n\nCODING CONTEXT: Respond ONLY in ${languageTitle}. All code blocks must use triple backticks with language tag \`\`\`${fenceTag}\`\`\`. Do not include other languages unless explicitly asked.`;
    }

    prompt += `

## Response Rules:

### If the transcription is casual conversation, greetings, or NOT related to ${activeSkill}:
- Respond with: "Yeah, I'm listening. Ask your question relevant to ${activeSkill}."
- Or similar brief acknowledgments like: "I'm here, what's your ${activeSkill} question?"

### If the transcription IS relevant to ${activeSkill} or is a follow-up question:
- Provide a comprehensive, detailed response
- Use bullet points, examples, and explanations
- Focus on actionable insights and complete answers
- Do not truncate or shorten your response

### Examples of casual/irrelevant messages:
- "Hello", "Hi there", "How are you?"
- "What's the weather like?"
- "I'm just testing this"
- Random conversations not related to ${activeSkill}

### Examples of relevant messages:
- Actual questions about ${activeSkill} concepts
- Follow-up questions to previous responses
- Requests for clarification on ${activeSkill} topics
- Problem-solving requests related to ${activeSkill}

## Response Format:
- Keep responses detailed
- Use bullet points for structured answers
- Be encouraging and helpful
- Stay focused on ${activeSkill}

If the user's input is a coding or DSA problem statement and contains no code, produce a complete, runnable solution in the selected programming language without asking for more details. Always include the final implementation in a properly tagged code block.

Remember: Be intelligent about filtering - only provide detailed responses when the user actually needs help with ${activeSkill}.`;

    return prompt;
  }

  // ── Neutral request builders (assembly only; no provider wire shape) ──

  // Replicates buildGeminiRequest / buildGeminiRequestWithHistory (text path).
  // History cap: 15 recent events.
  buildTextRequest(text, activeSkill, sessionMemory = [], programmingLanguage = null, mdContext = '') {
    const sessionManager = this.sessionManager;

    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);

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
      sessionMemory,
      programmingLanguage
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
  buildImageRequest(imageBufferOrBase64, mimeType, activeSkill, programmingLanguage = null, mdContext = '') {
    const skillPrompt = this.promptLoader.getSkillPrompt(activeSkill, programmingLanguage) || '';
    const base64 = Buffer.isBuffer(imageBufferOrBase64)
      ? imageBufferOrBase64.toString('base64')
      : imageBufferOrBase64;

    return {
      kind: 'image',
      skill: activeSkill,
      systemPrompt: skillPrompt && skillPrompt.trim().length > 0 ? skillPrompt : null,
      userText: this.formatImageInstruction(activeSkill, programmingLanguage),
      images: [{ data: base64, mimeType }],
      history: [],
      mdContext
    };
  }

  // Replicates buildIntelligentTranscriptionRequest[WithHistory].
  // History cap: 10 recent events, then last 8.
  buildTranscriptionRequest(text, activeSkill, _sessionMemory = [], programmingLanguage = null, mdContext = '') {
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    const systemPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
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
