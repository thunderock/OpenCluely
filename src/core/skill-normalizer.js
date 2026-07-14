// Pure skill-name normalization + programming-language injection extracted
// from prompt-loader.js. No fs, no state — the fs-backed loadPrompts /
// getSkillPrompt stay in PromptLoader, which delegates these pure transforms
// here so they can be unit-tested without the prompts directory.

// Single source of truth for the skills that take a programming-language
// injection (currently just DSA).
const SKILLS_REQUIRING_PROGRAMMING_LANGUAGE = ['dsa'];

// Normalize a raw skill name to its canonical file-name form.
function normalizeSkillName(skillName) {
  if (!skillName) return 'general';

  // Convert to lowercase and handle common variations
  const normalized = skillName.toLowerCase().trim();

  // Map common variations to standard names
  const skillMap = {
    'dsa': 'dsa',
    'data-structures': 'dsa',
    'algorithms': 'dsa',
    'data-structures-algorithms': 'dsa',
    'behavioral': 'behavioral',
    'behavioral-interview': 'behavioral',
    'behavior': 'behavioral',
    'sales': 'sales',
    'selling': 'sales',
    'business-development': 'sales',
    'presentation': 'presentation',
    'presentations': 'presentation',
    'public-speaking': 'presentation',
    'data-science': 'data-science',
    'datascience': 'data-science',
    'machine-learning': 'data-science',
    'ml': 'data-science',
    'programming': 'programming',
    'coding': 'programming',
    'software-development': 'programming',
    'development': 'programming',
    'devops': 'devops',
    'dev-ops': 'devops',
    'infrastructure': 'devops',
    'system-design': 'system-design',
    'systems-design': 'system-design',
    'architecture': 'system-design',
    'distributed-systems': 'system-design',
    'negotiation': 'negotiation',
    'negotiating': 'negotiation',
    'conflict-resolution': 'negotiation'
  };

  return skillMap[normalized] || normalized;
}

// Append a programming-language context block to a prompt. The template
// strings are prompt content — preserved byte-for-byte from prompt-loader.js.
function injectProgrammingLanguage(promptContent, programmingLanguage, skillName) {
  const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript' };
  const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
  const norm = (programmingLanguage || '').toLowerCase();
  const languageTitle = languageMap[norm] || (programmingLanguage.charAt(0).toUpperCase() + programmingLanguage.slice(1));
  const fenceTag = fenceTagMap[norm] || norm || 'text';
  const languageUpper = (languageMap[norm] || languageTitle).toUpperCase();

  let languageInjection = '';

  switch (skillName) {
    case 'dsa':
      languageInjection = `\n\n## IMPLEMENTATION LANGUAGE: ${languageUpper}
STRICT REQUIREMENTS:
- Respond ONLY in ${languageTitle}. Do not include any snippets or alternatives in other languages.
- All code blocks must use triple backticks with the exact language tag: \`\`\`${fenceTag}\`\`\`.
- Aim for the best possible time and space complexity; prefer optimal algorithms and data structures.
- Provide: brief approach, then final ${languageTitle} implementation, followed by time/space complexity.
- If the user's input is a problem statement (and does not include code), produce a complete, runnable ${languageTitle} solution without asking for clarification.
- Avoid unnecessary verbosity; focus on correctness, clarity, and efficiency.`;
      break;
    default:
      languageInjection = `\n\n## PROGRAMMING LANGUAGE: ${languageUpper}\nAll code and examples must be in ${languageTitle}. Use code fences with tag: \`\`\`${fenceTag}\`\`\`.`;
  }

  return promptContent + languageInjection;
}

module.exports = { normalizeSkillName, injectProgrammingLanguage, SKILLS_REQUIRING_PROGRAMMING_LANGUAGE };
