// Pure skill-name normalization extracted from prompt-loader.js. No fs, no
// state — the fs-backed loadPrompts / getSkillPrompt stay in PromptLoader,
// which delegates this pure transform here so it can be unit-tested without
// the prompts directory.

// Normalize a raw skill name to its canonical file-name form.
function normalizeSkillName(skillName) {
  if (!skillName) return 'general';

  // Convert to lowercase and handle common variations
  const normalized = skillName.toLowerCase().trim();

  // Map common variations to standard names
  const skillMap = {
    'dsa': 'programming',
    'data-structures': 'programming',
    'algorithms': 'programming',
    'data-structures-algorithms': 'programming',
    'behavioral': 'behavioral',
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

module.exports = { normalizeSkillName };
