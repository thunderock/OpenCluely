const fs = require('fs');
const path = require('path');
const skillNormalizer = require('./src/core/skill-normalizer');

// Skills shipped as loadable .md prompts: General (default) + Coding.
const SHIPPED_SKILLS = ['general', 'programming'];

class PromptLoader {
  constructor() {
    this.prompts = new Map();
    this.promptsLoaded = false;
    this.skillPromptSent = new Set();
    // Skills that take a programming-language injection (see skill-normalizer).
    this.skillsRequiringProgrammingLanguage = [...skillNormalizer.SKILLS_REQUIRING_PROGRAMMING_LANGUAGE];
  }

  /**
   * Load all skill prompts from the prompts directory
   */
  loadPrompts() {
    if (this.promptsLoaded) {
      return;
    }

    // In packaged builds asar-unpacked files are still reachable through
    // their original path thanks to Electron's fs patching.
    const promptsDir = path.join(__dirname, 'prompts');
    
    try {
      const files = fs.readdirSync(promptsDir);
      
      for (const file of files) {
        if (file.endsWith('.md')) {
          const skillName = path.basename(file, '.md');
          if (!SHIPPED_SKILLS.includes(skillName)) continue; // ship only General + Coding
          const filePath = path.join(promptsDir, file);
          const promptContent = fs.readFileSync(filePath, 'utf8');
          
          this.prompts.set(skillName, promptContent);
        }
      }
      
      this.promptsLoaded = true;
      
    } catch (error) {
      console.error('Error loading skill prompts:', error);
      throw new Error(`Failed to load skill prompts: ${error.message}`);
    }
  }

  /**
   * Get the system prompt for a specific skill with optional programming language injection
   * @param {string} skillName - The name of the skill
   * @param {string|null} programmingLanguage - Optional programming language to inject
   * @returns {string|null} The system prompt content or null if not found
   */
  getSkillPrompt(skillName, programmingLanguage = null) {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    const normalizedSkillName = this.normalizeSkillName(skillName);
    let promptContent = this.prompts.get(normalizedSkillName);
    
    if (!promptContent) {
      return null;
    }

    // Inject programming language if provided and skill requires it
    if (programmingLanguage && this.skillsRequiringProgrammingLanguage.includes(normalizedSkillName)) {
      promptContent = this.injectProgrammingLanguage(promptContent, programmingLanguage, normalizedSkillName);
    }

    return promptContent;
  }

  /**
   * Inject programming language context into skill prompts
   * @param {string} promptContent - Original prompt content
   * @param {string} programmingLanguage - Programming language to inject
   * @param {string} skillName - Normalized skill name
   * @returns {string} Modified prompt with programming language context
   */
  injectProgrammingLanguage(promptContent, programmingLanguage, skillName) {
    return skillNormalizer.injectProgrammingLanguage(promptContent, programmingLanguage, skillName);
  }

  /**
   * Check if stored memory is empty (first time interaction)
   * @param {Array} storedMemory - Current stored memory from your system
   * @returns {boolean} True if memory is empty
   */
  isFirstTimeInteraction(storedMemory) {
    return !storedMemory || storedMemory.length === 0;
  }

  /**
   * Check if skill prompt should be sent as model memory
   * @param {string} skillName - The name of the skill
   * @param {Array} storedMemory - Current stored memory
   * @returns {boolean} True if skill prompt should be sent as model memory
   */
  shouldSendAsModelMemory(skillName, storedMemory) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    
    // If stored memory is empty, this is the first time - send as model memory
    if (this.isFirstTimeInteraction(storedMemory)) {
      return true;
    }

    // Check if we've already sent this skill's prompt as model memory
    const hasSkillInMemory = storedMemory.some(event => 
      event.skillUsed === normalizedSkillName && event.promptSentAsMemory === true
    );

    if (!hasSkillInMemory) {
      return true;
    }

    return false;
  }

  /**
   * Alternative method: Get separate components for manual API construction
   * @param {string} skillName - The active skill
   * @param {string} userMessage - The user's message/query
   * @param {Array} storedMemory - Current stored memory
   * @param {string|null} programmingLanguage - Optional programming language
   * @returns {Object} Separated components for manual request building
   */
  getRequestComponents(skillName, userMessage, storedMemory, programmingLanguage = null) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    const shouldUseModelMemory = this.shouldSendAsModelMemory(skillName, storedMemory);
    const skillPrompt = this.getSkillPrompt(normalizedSkillName, programmingLanguage);

    return {
      skillName: normalizedSkillName,
      userMessage,
      skillPrompt,
      shouldUseModelMemory,
      isFirstTime: this.isFirstTimeInteraction(storedMemory),
      modelMemory: shouldUseModelMemory && skillPrompt ? skillPrompt : null,
      messageContent: userMessage,
      programmingLanguage,
      requiresProgrammingLanguage: this.skillsRequiringProgrammingLanguage.includes(normalizedSkillName)
    };
  }

  /**
   * Update stored memory after successful API call
   * @param {Array} storedMemory - Current stored memory array
   * @param {string} skillName - The skill that was used
   * @param {boolean} wasModelMemoryUsed - Whether model memory was used
   * @param {string} userMessage - The user message
   * @param {string} aiResponse - The AI response
   * @param {string|null} programmingLanguage - Programming language used
   * @returns {Array} Updated stored memory
   */
  updateStoredMemory(storedMemory, skillName, wasModelMemoryUsed, userMessage, aiResponse, programmingLanguage = null) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    const updatedMemory = [...(storedMemory || [])];
    
    const memoryEntry = {
      timestamp: new Date().toISOString(),
      skillUsed: normalizedSkillName,
      promptSentAsMemory: wasModelMemoryUsed,
      userMessage,
      aiResponse: aiResponse ? aiResponse.substring(0, 200) + '...' : null, // Truncated for storage
      action: wasModelMemoryUsed ? 'MODEL_MEMORY_SENT' : 'REGULAR_MESSAGE',
      programmingLanguage: programmingLanguage || null
    };
    
    updatedMemory.push(memoryEntry);
        
    return updatedMemory;
  }

  /**
   * Check if a skill requires programming language context
   * @param {string} skillName - The skill name to check
   * @returns {boolean} True if skill requires programming language
   */
  requiresProgrammingLanguage(skillName) {
    const normalizedSkillName = this.normalizeSkillName(skillName);
    return this.skillsRequiringProgrammingLanguage.includes(normalizedSkillName);
  }

  /**
   * Get list of skills that require programming language context
   * @returns {Array<string>} Array of skill names that require programming language
   */
  getSkillsRequiringProgrammingLanguage() {
    return [...this.skillsRequiringProgrammingLanguage];
  }

  /**
   * Normalize skill names to match file names
   * @param {string} skillName - Raw skill name
   * @returns {string} Normalized skill name
   */
  normalizeSkillName(skillName) {
    return skillNormalizer.normalizeSkillName(skillName);
  }

  /**
   * Get list of available skills
   * @returns {Array<string>} Array of available skill names
   */
  getAvailableSkills() {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }
    return [...SHIPPED_SKILLS];
  }

  /**
   * Reset the prompt sent tracking and clear stored memory
   */
  resetSession() {
    this.skillPromptSent.clear();
  }

  /**
   * Get current session statistics
   * @returns {Object} Statistics about current session
   */
  getSessionStats() {
    if (!this.promptsLoaded) {
      this.loadPrompts();
    }

    const stats = {
      totalPrompts: this.prompts.size,
      skillsUsedInSession: this.skillPromptSent.size,
      availableSkills: this.getAvailableSkills(),
      skillsUsed: Array.from(this.skillPromptSent),
      skillsRequiringProgrammingLanguage: this.skillsRequiringProgrammingLanguage
    };

    return stats;
  }
}

// Export singleton instance
const promptLoader = new PromptLoader();

module.exports = {
  PromptLoader,
  promptLoader
};