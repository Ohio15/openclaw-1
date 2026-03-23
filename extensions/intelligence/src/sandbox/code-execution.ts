/**
 * Code Execution Sandbox
 *
 * Safe environment for testing generated code.
 * Validates code by actually running it in isolation.
 *
 * Ported from AICodeAssistant CodeExecutionSandbox.js
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  error?: string;
  violations?: CodeViolation[];
  logs?: string[];
  errors?: string[];
  stack?: string;
}

export interface CodeViolation {
  pattern: string;
  match: string | undefined;
}

export interface CodeAnalysis {
  safe: boolean;
  violations: CodeViolation[];
  usesNetwork: boolean;
  usesFileSystem: boolean;
  usesProcess: boolean;
}

export interface TestBlockResult {
  tested: number;
  passed?: number;
  failed?: number;
  results?: TestBlockItem[];
  allPassed?: boolean;
  message?: string;
}

export interface TestBlockItem {
  block: number;
  success?: boolean;
  skipped?: boolean;
  reason?: string;
  duration?: number;
  error?: string;
  logs?: string[];
}

export interface ValidationWithTestsResult {
  valid: boolean;
  testsPassed: boolean;
  logs?: string[];
  errors?: string[];
  error?: string;
  duration?: number;
}

export interface SandboxConfig {
  timeout: number;
  maxMemory: number;
  networkAccess: boolean;
  maxOutputSize: number;
  tempDir: string;
}

/**
 * Default sandbox configuration
 */
const DEFAULT_CONFIG: SandboxConfig = {
  timeout: 5000, // 5 seconds
  maxMemory: 128, // 128 MB
  networkAccess: false,
  maxOutputSize: 100000, // 100KB
  tempDir: path.join(os.tmpdir(), 'code-sandbox'),
};

/**
 * Dangerous patterns to block
 */
const BLOCKED_PATTERNS: RegExp[] = [
  // File system access
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]path['"]\s*\)/,
  /from\s+['"]fs['"]/,
  /from\s+['"]child_process['"]/,

  // Network access
  /require\s*\(\s*['"]http['"]\s*\)/,
  /require\s*\(\s*['"]https['"]\s*\)/,
  /require\s*\(\s*['"]net['"]\s*\)/,
  /fetch\s*\(/,
  /XMLHttpRequest/,

  // Process/system access
  /process\.exit/,
  /process\.env/,
  /process\.kill/,
  /require\s*\(\s*['"]os['"]\s*\)/,
  /require\s*\(\s*['"]cluster['"]\s*\)/,
  /require\s*\(\s*['"]worker_threads['"]\s*\)/,

  // Dangerous globals
  /eval\s*\(/,
  /Function\s*\(/,
  /\bexec\s*\(/,
  /\bspawn\s*\(/,

  // Environment manipulation
  /global\./,
  /globalThis\./,
  /__dirname/,
  /__filename/,
];

/**
 * Safe modules that can be used
 */
const SAFE_MODULES: string[] = [
  'crypto',
  'util',
  'events',
  'stream',
  'buffer',
];

export class CodeExecutionSandbox {
  private config: SandboxConfig;
  private enableLogging: boolean;
  private initialized: boolean;

  constructor(options: Partial<SandboxConfig> & { enableLogging?: boolean } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.enableLogging = options.enableLogging !== false;
    this.initialized = false;
  }

  private log(message: string, data: Record<string, any> = {}): void {
    if (this.enableLogging) {
      console.log(
        `[Sandbox] ${message}`,
        Object.keys(data).length > 0 ? data : ''
      );
    }
  }

  /**
   * Initialize sandbox environment
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.config.tempDir, { recursive: true });
      this.initialized = true;
      this.log('Sandbox initialized', { dir: this.config.tempDir });
    } catch (e: any) {
      this.log('Failed to initialize sandbox', { error: e.message });
      throw e;
    }
  }

  /**
   * Check code for dangerous patterns
   */
  analyzeCode(code: string): CodeAnalysis {
    const violations: CodeViolation[] = [];

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(code)) {
        violations.push({
          pattern: pattern.toString(),
          match: code.match(pattern)?.[0],
        });
      }
    }

    return {
      safe: violations.length === 0,
      violations,
      usesNetwork: /fetch|http|https|net/.test(code),
      usesFileSystem: /fs|readFile|writeFile/.test(code),
      usesProcess: /process\.|child_process/.test(code),
    };
  }

  /**
   * Create a sandboxed wrapper for the code
   */
  wrapCode(code: string, language: string = 'javascript'): string {
    let processedCode = code;
    if (language === 'typescript') {
      // For TypeScript, we strip types for execution
      processedCode = this.stripTypeScript(processedCode);
    }

    // Create sandboxed wrapper
    return `
'use strict';

// Sandbox restrictions
const originalRequire = require;
const safeModules = ${JSON.stringify(SAFE_MODULES)};

global.require = function(mod) {
  if (!safeModules.includes(mod)) {
    throw new Error('Module not allowed in sandbox: ' + mod);
  }
  return originalRequire(mod);
};

// Block dangerous globals
const blockedGlobals = ['eval', 'Function'];
blockedGlobals.forEach(g => {
  Object.defineProperty(global, g, {
    get() { throw new Error(g + ' is blocked in sandbox'); }
  });
});

// Capture console output
const output = { logs: [], errors: [] };
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  output.logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
console.error = (...args) => {
  output.errors.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

// User code
try {
  ${processedCode}

  // Output results
  process.stdout.write(JSON.stringify({
    success: true,
    logs: output.logs,
    errors: output.errors
  }));
} catch (e) {
  process.stdout.write(JSON.stringify({
    success: false,
    error: e.message,
    stack: e.stack,
    logs: output.logs,
    errors: output.errors
  }));
}
`;
  }

  /**
   * Strip TypeScript types for execution
   */
  stripTypeScript(code: string): string {
    // Basic TypeScript stripping (for simple code)
    return (
      code
        // Remove type annotations
        .replace(
          /:\s*(string|number|boolean|any|void|null|undefined|object|\w+(\[\])?)\s*([,\)\]=;])/g,
          '$3'
        )
        // Remove interface declarations
        .replace(/interface\s+\w+\s*\{[^}]*\}/g, '')
        // Remove type declarations
        .replace(/type\s+\w+\s*=\s*[^;]+;/g, '')
        // Remove generic type parameters
        .replace(/<\w+(\s*,\s*\w+)*>/g, '')
        // Remove as assertions
        .replace(/\s+as\s+\w+/g, '')
        // Remove export type
        .replace(/export\s+type\s+[^;]+;/g, '')
    );
  }

  /**
   * Execute code in sandbox
   */
  async execute(
    code: string,
    options: { language?: string; timeout?: number; maxMemory?: number } = {}
  ): Promise<ExecutionResult> {
    await this.initialize();

    const analysis = this.analyzeCode(code);
    if (!analysis.safe) {
      return {
        success: false,
        error: 'Code contains blocked patterns',
        violations: analysis.violations,
        stdout: '',
        stderr: '',
        exitCode: 1,
        duration: 0,
      };
    }

    const sessionId = randomUUID();
    const tempFile = path.join(this.config.tempDir, `${sessionId}.js`);

    try {
      // Write wrapped code to temp file
      const wrappedCode = this.wrapCode(
        code,
        options.language || 'javascript'
      );
      await fs.writeFile(tempFile, wrappedCode, 'utf-8');

      // Execute with resource limits
      const result = await this.runNode(tempFile, {
        timeout: options.timeout || this.config.timeout,
        maxMemory: options.maxMemory || this.config.maxMemory,
      });

      return result;
    } finally {
      // Cleanup
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Run Node.js with the given file
   */
  private runNode(
    filePath: string,
    options: { timeout: number; maxMemory: number }
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let killed = false;

      const nodeArgs = [
        `--max-old-space-size=${options.maxMemory}`,
        '--no-warnings',
        filePath,
      ];

      const proc = spawn('node', nodeArgs, {
        timeout: options.timeout,
        env: {
          NODE_ENV: 'sandbox',
          PATH: process.env.PATH,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Set timeout
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, options.timeout);

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > this.config.maxOutputSize) {
          killed = true;
          proc.kill('SIGKILL');
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > this.config.maxOutputSize) {
          killed = true;
          proc.kill('SIGKILL');
        }
      });

      proc.on('close', (exitCode: number | null) => {
        clearTimeout(timer);
        const duration = Date.now() - startTime;

        if (killed) {
          resolve({
            success: false,
            error:
              stdout.length > this.config.maxOutputSize
                ? 'Output exceeded maximum size'
                : 'Execution timeout',
            stdout: stdout.slice(0, 1000),
            stderr: stderr.slice(0, 1000),
            exitCode: exitCode || 1,
            duration,
          });
          return;
        }

        // Try to parse structured output
        try {
          const result = JSON.parse(stdout);
          resolve({
            success: result.success,
            logs: result.logs,
            errors: result.errors,
            error: result.error,
            stack: result.stack,
            stdout,
            stderr,
            exitCode: exitCode || 0,
            duration,
          });
        } catch {
          resolve({
            success: exitCode === 0,
            stdout,
            stderr,
            exitCode: exitCode || 0,
            duration,
          });
        }
      });

      proc.on('error', (error: Error) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: error.message,
          stdout,
          stderr,
          exitCode: 1,
          duration: Date.now() - startTime,
        });
      });
    });
  }

  /**
   * Validate code by executing tests
   */
  async validateWithTests(
    code: string,
    testCode: string
  ): Promise<ValidationWithTestsResult> {
    const combinedCode = `
// Implementation
${code}

// Tests
${testCode}
`;

    const result = await this.execute(combinedCode);

    return {
      valid: result.success,
      testsPassed: result.success,
      logs: result.logs,
      errors: result.errors,
      error: result.error,
      duration: result.duration,
    };
  }

  /**
   * Extract and test code blocks from a response
   */
  async testCodeBlocks(response: string): Promise<TestBlockResult> {
    // Extract code blocks
    const codeBlockRegex =
      /```(?:javascript|typescript|js|ts)?\n([\s\S]*?)```/g;
    const blocks: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(response)) !== null) {
      blocks.push(match[1].trim());
    }

    if (blocks.length === 0) {
      return { tested: 0, message: 'No code blocks found' };
    }

    const results: TestBlockItem[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const code = blocks[i];

      // Skip if it's just type definitions or imports
      if (
        /^(import|export\s+type|interface|type\s+\w+\s*=)/.test(code.trim())
      ) {
        results.push({
          block: i + 1,
          skipped: true,
          reason: 'Type definitions only',
        });
        continue;
      }

      const result = await this.execute(code, { language: 'typescript' });
      results.push({
        block: i + 1,
        success: result.success,
        duration: result.duration,
        error: result.error,
        logs: result.logs,
      });
    }

    const passed = results.filter((r) => r.success || r.skipped).length;

    return {
      tested: blocks.length,
      passed,
      failed: blocks.length - passed,
      results,
      allPassed: passed === blocks.length,
    };
  }

  /**
   * Cleanup old sandbox files
   */
  async cleanup(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.tempDir);
      const now = Date.now();
      const maxAge = 60 * 60 * 1000; // 1 hour

      for (const file of files) {
        const filePath = path.join(this.config.tempDir, file);
        const stats = await fs.stat(filePath);

        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
        }
      }

      this.log('Cleanup complete');
    } catch (e: any) {
      this.log('Cleanup failed', { error: e.message });
    }
  }
}

// Singleton
let sandboxInstance: CodeExecutionSandbox | null = null;

export function getSandbox(
  options: Partial<SandboxConfig> & { enableLogging?: boolean } = {}
): CodeExecutionSandbox {
  if (!sandboxInstance) {
    sandboxInstance = new CodeExecutionSandbox(options);
  }
  return sandboxInstance;
}
