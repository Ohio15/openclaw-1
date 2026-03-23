/**
 * OutputFormatter - Unified output formatting for all pipeline responses
 *
 * SOLE RESPONSIBILITY: Format and clean all LLM outputs before client delivery
 * - Strip analytical preambles
 * - Clean code blocks
 * - Sanitize internal markers
 * - Consistent response structure
 *
 * Ported from AICodeAssistant OutputFormatter.js
 */

export interface FormattedResponse {
  success: boolean;
  content: string;
  model?: string;
  provider?: string;
  confidence?: number;
  trace?: string;
  metadata: {
    formatted: boolean;
    isRefusal?: boolean;
    isError?: boolean;
    outputFormat?: string;
    taskType?: string;
    requirementValidation?: RequirementValidation;
  };
  error?: string;
}

export interface RequirementValidation {
  valid: boolean;
  covered: string[];
  missing: string[];
  score: number;
  warning?: string | null;
}

export interface CodeBlock {
  language: string;
  code: string;
  fullMatch: string;
}

export interface PipelineResponse {
  content?: string;
  text?: string;
  success?: boolean;
  model?: string;
  provider?: string;
  confidence?: number;
  trace?: string;
}

export interface FormatOptions {
  taskType?: string;
  outputFormat?: 'auto' | 'code' | 'markdown' | 'text';
  extractedRequirements?: string[];
}

export interface ErrorFormatOptions {
  taskType?: string;
  includeDetails?: boolean;
}

// Patterns to strip from output
const STRIP_PATTERNS: RegExp[] = [
  // Analytical preambles
  /^(Here's|Here is|I'll|I will|Let me|Allow me|Sure,|Certainly,|Of course,)[^\n]*\n+/i,
  /^(I understand|I see|Got it|Understood)[^\n]*\n+/i,

  // Meta-commentary
  /^(Based on|According to|Looking at|Analyzing)[^\n]*:\n+/i,
  /^(The following|Below is|Here's the)[^\n]*:\n+/i,

  // Thinking markers
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /\[thinking\][\s\S]*?\[\/thinking\]/gi,

  // Internal markers
  /\[INTERNAL\][\s\S]*?\[\/INTERNAL\]/gi,
  /<!-- [\s\S]*? -->/g,

  // Excessive newlines
  /\n{4,}/g,
];

// Patterns indicating refusal
const REFUSAL_PATTERNS: RegExp[] = [
  /I cannot|I can't|I'm unable|I am unable/i,
  /I apologize but|I'm sorry but/i,
  /I don't have the ability/i,
  /beyond my capabilities/i,
  /I must decline/i,
];

export class OutputFormatter {
  private stripPreamble: boolean;
  private sanitizeMarkers: boolean;
  private normalizeWhitespace: boolean;

  constructor(options: { stripPreamble?: boolean; sanitizeMarkers?: boolean; normalizeWhitespace?: boolean } = {}) {
    this.stripPreamble = options.stripPreamble ?? true;
    this.sanitizeMarkers = options.sanitizeMarkers ?? true;
    this.normalizeWhitespace = options.normalizeWhitespace ?? true;
  }

  /**
   * Format a pipeline response for client delivery
   */
  format(response: PipelineResponse | string, options: FormatOptions = {}): FormattedResponse {
    const { taskType = 'general', outputFormat = 'auto' } = options;

    let content: string;
    if (typeof response === 'string') {
      content = response;
    } else {
      content = response.content || response.text || String(response);
    }

    // Check for refusal
    const isRefusal = this.detectRefusal(content);

    // Clean content
    if (this.stripPreamble && !isRefusal) {
      content = this.stripAnalyticalContent(content, taskType);
    }

    if (this.sanitizeMarkers) {
      content = this.sanitizeInternalMarkers(content);
    }

    if (this.normalizeWhitespace) {
      content = this.normalizeContent(content);
    }

    // Format based on output type
    if (outputFormat === 'code' || this.isCodeResponse(content, taskType)) {
      content = this.formatCodeOutput(content);
    }

    const responseObj = typeof response === 'string' ? {} as PipelineResponse : response;

    return {
      success: responseObj.success ?? !isRefusal,
      content,
      model: responseObj.model,
      provider: responseObj.provider || 'ollama',
      confidence: responseObj.confidence,
      trace: responseObj.trace,
      metadata: {
        formatted: true,
        isRefusal,
        outputFormat:
          outputFormat === 'auto' ? this.detectOutputFormat(content) : outputFormat,
      },
    };
  }

  /**
   * Strip analytical preambles and meta-commentary
   */
  stripAnalyticalContent(content: string, taskType: string): string {
    let cleaned = content;

    // Apply strip patterns
    for (const pattern of STRIP_PATTERNS) {
      cleaned = cleaned.replace(pattern, (match: string) => {
        // Keep newlines count reasonable
        if (match.includes('\n\n\n\n')) {
          return '\n\n';
        }
        return '';
      });
    }

    // For code tasks, prioritize code blocks
    if (['code_generation', 'debugging', 'refactoring'].includes(taskType)) {
      const codeBlocks = this.extractCodeBlocks(cleaned);
      if (codeBlocks.length > 0) {
        // Check if there's excessive text before first code block
        const firstBlockIndex = cleaned.indexOf('```');
        if (firstBlockIndex > 300) {
          // Trim preamble, keep a brief intro if present
          const preamble = cleaned.substring(0, firstBlockIndex);
          const briefIntro = preamble.split('\n').slice(-2).join('\n').trim();
          if (briefIntro.length < 200) {
            cleaned = briefIntro + '\n\n' + cleaned.substring(firstBlockIndex);
          } else {
            cleaned = cleaned.substring(firstBlockIndex);
          }
        }
      }
    }

    return cleaned.trim();
  }

  /**
   * Sanitize internal markers and debug info
   */
  sanitizeInternalMarkers(content: string): string {
    let cleaned = content;

    // Remove thinking tags
    cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    cleaned = cleaned.replace(/\[thinking\][\s\S]*?\[\/thinking\]/gi, '');

    // Remove internal markers
    cleaned = cleaned.replace(/\[INTERNAL\][\s\S]*?\[\/INTERNAL\]/gi, '');

    // Remove HTML comments
    cleaned = cleaned.replace(/<!-- [\s\S]*? -->/g, '');

    // Remove trace IDs
    cleaned = cleaned.replace(/\[trace:[^\]]+\]/gi, '');
    cleaned = cleaned.replace(/traceId:\s*\w+/gi, '');

    return cleaned;
  }

  /**
   * Normalize whitespace and formatting
   */
  normalizeContent(content: string): string {
    let normalized = content;

    // Normalize line endings
    normalized = normalized.replace(/\r\n/g, '\n');

    // Remove excessive blank lines (more than 2)
    normalized = normalized.replace(/\n{4,}/g, '\n\n\n');

    // Trim leading/trailing whitespace
    normalized = normalized.trim();

    // Ensure single newline at end
    if (normalized && !normalized.endsWith('\n')) {
      normalized += '\n';
    }

    return normalized;
  }

  /**
   * Format code-heavy output
   */
  formatCodeOutput(content: string): string {
    let formatted = content;

    // Ensure code blocks are properly formatted
    formatted = formatted.replace(
      /```(\w*)\n([\s\S]*?)```/g,
      (_match: string, lang: string, code: string) => {
        // Trim code content
        const trimmedCode = code.trim();
        // Default to javascript if no language specified
        const language = lang || 'javascript';
        return '```' + language + '\n' + trimmedCode + '\n```';
      }
    );

    return formatted;
  }

  /**
   * Extract code blocks from content
   */
  extractCodeBlocks(content: string): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      blocks.push({
        language: match[1] || 'text',
        code: match[2].trim(),
        fullMatch: match[0],
      });
    }

    return blocks;
  }

  /**
   * Detect if response is a refusal
   */
  detectRefusal(content: string): boolean {
    return REFUSAL_PATTERNS.some((pattern) => pattern.test(content));
  }

  /**
   * Check if response is code-heavy
   */
  isCodeResponse(content: string, taskType: string): boolean {
    if (
      ['code_generation', 'debugging', 'refactoring', 'optimization'].includes(
        taskType
      )
    ) {
      return true;
    }

    // Check for code blocks
    const codeBlockCount = (content.match(/```/g) || []).length / 2;
    return codeBlockCount >= 1;
  }

  /**
   * Detect output format from content
   */
  detectOutputFormat(content: string): string {
    const codeBlocks = this.extractCodeBlocks(content);

    if (codeBlocks.length >= 1) {
      return 'code';
    }

    if (/^#+\s/m.test(content) || /\*\*[^*]+\*\*/g.test(content)) {
      return 'markdown';
    }

    return 'text';
  }

  /**
   * Validate that extracted requirements are covered in generated code
   */
  validateRequirementsCovered(
    content: string,
    requirements: string[] = []
  ): RequirementValidation {
    if (!requirements || requirements.length === 0) {
      return { valid: true, covered: [], missing: [], score: 1.0 };
    }

    const covered: string[] = [];
    const missing: string[] = [];
    const contentLower = content.toLowerCase();

    for (const req of requirements) {
      const reqLower = req.toLowerCase();

      if (reqLower.startsWith('method:')) {
        const methodName = reqLower.replace('method:', '').trim();
        const methodPatterns = [
          new RegExp(`\\b${methodName}\\s*\\(`),
          new RegExp(`\\b${methodName}\\s*=`),
        ];
        const found = methodPatterns.some((p) => p.test(contentLower));
        if (found) covered.push(req);
        else missing.push(req);
      } else {
        const keywords = reqLower.split(/\s+/).filter((w) => w.length > 3);
        const foundCount = keywords.filter((kw) =>
          contentLower.includes(kw)
        ).length;
        if (foundCount >= Math.ceil(keywords.length * 0.5)) covered.push(req);
        else missing.push(req);
      }
    }

    const score =
      requirements.length > 0 ? covered.length / requirements.length : 1.0;

    return {
      valid: missing.length === 0,
      covered,
      missing,
      score,
      warning:
        missing.length > 0
          ? `Missing requirements: ${missing.join(', ')}`
          : null,
    };
  }

  /**
   * Format with requirement validation
   */
  formatWithValidation(
    response: PipelineResponse | string,
    options: FormatOptions = {}
  ): FormattedResponse {
    const formatted = this.format(response, options);

    if (options.extractedRequirements && options.extractedRequirements.length > 0) {
      const validation = this.validateRequirementsCovered(
        formatted.content,
        options.extractedRequirements
      );
      formatted.metadata.requirementValidation = validation;

      if (!validation.valid) {
        console.log('[OutputFormatter] Missing requirements in output', {
          missing: validation.missing,
          score: validation.score,
        });
      }
    }

    return formatted;
  }

  /**
   * Format error response
   */
  formatError(
    error: Error,
    options: ErrorFormatOptions = {}
  ): FormattedResponse {
    const { taskType = 'general', includeDetails = false } = options;

    let message = 'An error occurred processing your request.';

    if (includeDetails) {
      message += `\n\nError: ${error.message}`;
    }

    return {
      success: false,
      content: message,
      error: error.message,
      metadata: {
        formatted: true,
        isError: true,
        taskType,
      },
    };
  }

  /**
   * Static format method for convenience
   */
  static format(
    response: PipelineResponse | string,
    options: FormatOptions = {}
  ): FormattedResponse {
    const formatter = new OutputFormatter();
    return formatter.format(response, options);
  }
}

// Singleton instance
let instance: OutputFormatter | null = null;

export function getOutputFormatter(
  options: { stripPreamble?: boolean; sanitizeMarkers?: boolean; normalizeWhitespace?: boolean } = {}
): OutputFormatter {
  if (!instance) {
    instance = new OutputFormatter(options);
  }
  return instance;
}
