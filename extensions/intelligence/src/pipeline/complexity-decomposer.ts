/**
 * Complexity Decomposer
 *
 * Breaks complex requests into manageable sub-tasks while
 * ensuring each sub-task produces complete, working code.
 *
 * Ported from AICodeAssistant ComplexityDecomposer.js
 */

export interface SubTask {
  id: string;
  title: string;
  prompt: string;
  dependencies: string[];
  category: string;
  priority: number;
  estimatedComplexity: number;
}

export interface DecompositionResult {
  needsDecomposition: boolean;
  complexity: number;
  tasks: SubTask[];
  integrationPrompt: string | null;
  analysis?: ComplexityAnalysis;
}

export interface ComplexityAnalysis {
  complexity: number;
  featureCount: number;
  wordCount: number;
  indicators: DetectedIndicator[];
  needsDecomposition: boolean;
}

export interface DetectedIndicator {
  indicator: string;
  matches: string[];
  weight: number;
}

interface ComplexityIndicatorConfig {
  pattern: RegExp;
  weight: number;
}

interface TaskTemplate {
  title: string;
  promptTemplate: string;
  category: string;
  priority: number;
}

export interface EffortEstimate {
  totalEstimatedTokens: number;
  taskCount: number;
  breakdown: { task: string; estimatedTokens: number }[];
}

/**
 * Complexity indicators with weights
 */
const COMPLEXITY_INDICATORS: Record<string, ComplexityIndicatorConfig> = {
  // Technical scope
  multipleEndpoints: { pattern: /\b(multiple|several|various)\s*(endpoints?|routes?|apis?)/i, weight: 0.15 },
  realtime: { pattern: /\b(real-?time|websocket|socket\.?io|live\s*update)/i, weight: 0.2 },
  authentication: { pattern: /\b(auth|jwt|oauth|session|login|permission)/i, weight: 0.15 },
  database: { pattern: /\b(database|postgres|mongodb|prisma|sql|orm)/i, weight: 0.1 },
  testing: { pattern: /\b(unit\s*test|test\s*case|jest|vitest|spec)/i, weight: 0.1 },

  // Algorithm complexity
  algorithms: { pattern: /\b(algorithm|crdt|ot|operational\s*transform|conflict\s*resolution)/i, weight: 0.25 },
  optimization: { pattern: /\b(optimi[sz]|performance|caching|rate\s*limit)/i, weight: 0.1 },

  // Scale indicators
  production: { pattern: /\b(production|prod-?ready|scalab|enterprise)/i, weight: 0.15 },
  comprehensive: { pattern: /\b(comprehensive|complete|full|entire)/i, weight: 0.1 },

  // Feature count
  multipleFeatures: { pattern: /\d+\.\s*\*\*|^\s*-\s*\w/gm, weight: 0.05 },
};

/**
 * Domain-specific task templates
 */
const TASK_TEMPLATES: Record<string, TaskTemplate> = {
  dataModel: {
    title: 'Data Models & Schema',
    promptTemplate: `Implement COMPLETE database schema and TypeScript types for: {context}

Requirements:
- Use Prisma schema syntax
- Include all relationships with proper foreign keys
- Add indexes for query optimization
- Create corresponding TypeScript interfaces
- Include validation with Zod schemas

Provide COMPLETE, production-ready code. No placeholders.`,
    category: 'schema',
    priority: 1,
  },

  authentication: {
    title: 'Authentication System',
    promptTemplate: `Implement COMPLETE authentication system for: {context}

Requirements:
- JWT token generation and validation
- Password hashing with bcrypt/argon2
- Middleware for route protection
- Role-based access control (RBAC)
- Token refresh mechanism
- Complete error handling

Provide COMPLETE, production-ready code. No placeholders.`,
    category: 'auth',
    priority: 2,
  },

  coreLogic: {
    title: 'Core Business Logic',
    promptTemplate: `Implement COMPLETE core business logic for: {context}

Given the data models:
{dataModelContext}

Requirements:
- Implement ALL specified algorithms
- Handle all edge cases
- Include comprehensive error handling
- Add logging for debugging
- Optimize for performance

Provide COMPLETE, production-ready code. No placeholders.`,
    category: 'logic',
    priority: 3,
  },

  realtime: {
    title: 'Real-Time Communication',
    promptTemplate: `Implement COMPLETE real-time communication layer for: {context}

Requirements:
- WebSocket server setup
- Connection management (join, leave, reconnect)
- Message routing and broadcasting
- Presence system (who's online, cursor positions)
- Graceful disconnection handling
- State synchronization on reconnect

Provide COMPLETE, production-ready code. No placeholders.`,
    category: 'realtime',
    priority: 3,
  },

  api: {
    title: 'REST API Endpoints',
    promptTemplate: `Implement COMPLETE REST API for: {context}

Given the existing modules:
{existingModulesContext}

Requirements:
- All CRUD operations
- Input validation with Zod
- Error responses with proper status codes
- Rate limiting middleware
- Request logging
- OpenAPI/Swagger documentation comments

Provide COMPLETE, production-ready code. No placeholders.`,
    category: 'api',
    priority: 4,
  },

  testing: {
    title: 'Test Suite',
    promptTemplate: `Implement COMPLETE test suite for: {context}

Components to test:
{componentsContext}

Requirements:
- Unit tests for all core functions
- Integration tests for API endpoints
- Mock external dependencies
- Test edge cases and error conditions
- Achieve >80% code coverage
- Use Jest/Vitest syntax

Provide COMPLETE, runnable tests. No placeholder assertions.`,
    category: 'testing',
    priority: 5,
  },
};

/**
 * Analyze request complexity
 */
export function analyzeComplexity(request: string): ComplexityAnalysis {
  let totalWeight = 0;
  let maxWeight = 0;
  const detectedIndicators: DetectedIndicator[] = [];

  for (const [name, { pattern, weight }] of Object.entries(COMPLEXITY_INDICATORS)) {
    const matches = request.match(pattern);
    if (matches) {
      // For counting patterns, weight by count
      const count = name === 'multipleFeatures' ? Math.min(matches.length, 10) : 1;
      const effectiveWeight = weight * count;

      totalWeight += effectiveWeight;
      maxWeight += weight * (name === 'multipleFeatures' ? 10 : 1);

      detectedIndicators.push({
        indicator: name,
        matches: matches.slice(0, 3),
        weight: effectiveWeight,
      });
    } else {
      maxWeight += weight;
    }
  }

  // Count bullet points and numbered items as feature count
  const featureCount =
    (request.match(/^\s*[-*]\s+\w/gm) || []).length +
    (request.match(/^\s*\d+\.\s+/gm) || []).length;

  // Estimate word count for request size
  const wordCount = request.split(/\s+/).length;

  const complexity = Math.min(1, totalWeight / (maxWeight * 0.5));

  return {
    complexity,
    featureCount,
    wordCount,
    indicators: detectedIndicators,
    needsDecomposition: complexity > 0.4 || featureCount > 3,
  };
}

/**
 * Determine which task templates apply to a request
 */
function detectRequiredTasks(request: string): string[] {
  const required: string[] = [];
  const lower = request.toLowerCase();

  // Always need data models for complex requests
  if (/database|schema|model|prisma|entity/i.test(lower)) {
    required.push('dataModel');
  }

  // Authentication
  if (/auth|jwt|login|permission|role|access control/i.test(lower)) {
    required.push('authentication');
  }

  // Real-time
  if (/websocket|real-?time|socket|live|collaborative/i.test(lower)) {
    required.push('realtime');
  }

  // Core logic (almost always needed)
  if (/implement|algorithm|crdt|ot|logic|handler/i.test(lower)) {
    required.push('coreLogic');
  }

  // API endpoints
  if (/api|endpoint|rest|crud|route/i.test(lower)) {
    required.push('api');
  }

  // Testing
  if (/test|unit test|integration|coverage/i.test(lower)) {
    required.push('testing');
  }

  // Default to at least data model + core logic + api
  if (required.length === 0) {
    required.push('dataModel', 'coreLogic', 'api');
  }

  return required;
}

/**
 * Decompose a complex request into sub-tasks
 */
export function decompose(
  request: string,
  options: { forceDecompose?: boolean } = {}
): DecompositionResult {
  const analysis = analyzeComplexity(request);

  if (!analysis.needsDecomposition && !options.forceDecompose) {
    return {
      needsDecomposition: false,
      complexity: analysis.complexity,
      tasks: [
        {
          id: 'single',
          title: 'Complete Implementation',
          prompt: request,
          dependencies: [],
          category: 'full',
          priority: 1,
          estimatedComplexity: analysis.complexity,
        },
      ],
      integrationPrompt: null,
    };
  }

  const requiredTasks = detectRequiredTasks(request);
  const tasks: SubTask[] = [];

  // Build context string from original request
  const contextSummary = request.slice(0, 1000);

  for (const taskKey of requiredTasks) {
    const template = TASK_TEMPLATES[taskKey];
    if (!template) continue;

    // Build the prompt from template
    let prompt = template.promptTemplate.replace('{context}', contextSummary);

    // Add dependency context placeholders (filled during execution)
    prompt = prompt.replace('{dataModelContext}', '[[DATA_MODEL_OUTPUT]]');
    prompt = prompt.replace('{existingModulesContext}', '[[PREVIOUS_OUTPUTS]]');
    prompt = prompt.replace('{componentsContext}', '[[COMPONENTS_TO_TEST]]');

    // Calculate dependencies
    const dependencies: string[] = [];
    if (taskKey === 'coreLogic' && requiredTasks.includes('dataModel')) {
      dependencies.push('dataModel');
    }
    if (taskKey === 'api') {
      if (requiredTasks.includes('dataModel')) dependencies.push('dataModel');
      if (requiredTasks.includes('authentication')) dependencies.push('authentication');
      if (requiredTasks.includes('coreLogic')) dependencies.push('coreLogic');
    }
    if (taskKey === 'testing') {
      dependencies.push(...requiredTasks.filter((t) => t !== 'testing'));
    }

    tasks.push({
      id: taskKey,
      title: template.title,
      prompt,
      dependencies,
      category: template.category,
      priority: template.priority,
      estimatedComplexity: 0.3 + dependencies.length * 0.1,
    });
  }

  // Sort by priority
  tasks.sort((a, b) => a.priority - b.priority);

  // Generate integration prompt
  const integrationPrompt = `Integrate all the following components into a cohesive application:

${tasks.map((t) => `## ${t.title}\n[[${t.id.toUpperCase()}_OUTPUT]]`).join('\n\n')}

Requirements:
- Ensure all imports are correct
- Add any missing glue code
- Create main entry point (index.ts or app.ts)
- Export all public interfaces
- Verify no circular dependencies

Provide the complete integrated application structure.`;

  return {
    needsDecomposition: true,
    complexity: analysis.complexity,
    tasks,
    integrationPrompt,
    analysis,
  };
}

/**
 * Get execution order respecting dependencies
 */
export function getExecutionOrder(tasks: SubTask[]): SubTask[] {
  const executed = new Set<string>();
  const ordered: SubTask[] = [];

  while (ordered.length < tasks.length) {
    for (const task of tasks) {
      if (executed.has(task.id)) continue;

      const depsResolved = task.dependencies.every((d) => executed.has(d));
      if (depsResolved) {
        ordered.push(task);
        executed.add(task.id);
      }
    }

    // Safety check for circular dependencies
    if (ordered.length === executed.size && ordered.length < tasks.length) {
      // Add remaining tasks anyway
      for (const task of tasks) {
        if (!executed.has(task.id)) {
          ordered.push(task);
          executed.add(task.id);
        }
      }
      break;
    }
  }

  return ordered;
}

/**
 * Fill context placeholders in a prompt with actual outputs
 */
export function fillContextPlaceholders(
  prompt: string,
  outputs: Record<string, string>
): string {
  let filled = prompt;

  // Replace specific placeholders
  filled = filled.replace(
    '[[DATA_MODEL_OUTPUT]]',
    outputs.dataModel || 'No data model provided'
  );
  filled = filled.replace(
    '[[COMPONENTS_TO_TEST]]',
    Object.entries(outputs)
      .filter(([k]) => k !== 'testing')
      .map(([k, v]) => `### ${k}\n${v.slice(0, 1000)}...`)
      .join('\n\n')
  );

  // Replace generic previous outputs placeholder
  const previousOutputs = Object.entries(outputs)
    .map(([k, v]) => `### ${k}\n\`\`\`typescript\n${v.slice(0, 2000)}\n\`\`\``)
    .join('\n\n');
  filled = filled.replace(
    '[[PREVIOUS_OUTPUTS]]',
    previousOutputs || 'No previous outputs'
  );

  return filled;
}

/**
 * Estimate total time for decomposed tasks
 */
export function estimateEffort(tasks: SubTask[]): EffortEstimate {
  // Rough estimates based on complexity
  const complexityToTokens = (c: number): number => Math.round(2000 + c * 8000);

  let totalTokens = 0;
  const breakdown: { task: string; estimatedTokens: number }[] = [];

  for (const task of tasks) {
    const tokens = complexityToTokens(task.estimatedComplexity);
    totalTokens += tokens;
    breakdown.push({
      task: task.title,
      estimatedTokens: tokens,
    });
  }

  return {
    totalEstimatedTokens: totalTokens,
    taskCount: tasks.length,
    breakdown,
  };
}

export interface ComplexityDecomposerInstance {
  analyze: typeof analyzeComplexity;
  decompose: typeof decompose;
  getExecutionOrder: typeof getExecutionOrder;
  fillContext: typeof fillContextPlaceholders;
  estimateEffort: typeof estimateEffort;
}

// Singleton
let decomposerInstance: ComplexityDecomposerInstance | null = null;

export function getComplexityDecomposer(): ComplexityDecomposerInstance {
  if (!decomposerInstance) {
    decomposerInstance = {
      analyze: analyzeComplexity,
      decompose,
      getExecutionOrder,
      fillContext: fillContextPlaceholders,
      estimateEffort,
    };
  }
  return decomposerInstance;
}
