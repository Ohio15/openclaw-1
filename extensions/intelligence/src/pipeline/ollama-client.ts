/**
 * Ollama HTTP Client — Minimal client for Ollama's /api/generate endpoint
 *
 * Uses Node's built-in fetch (no external HTTP libraries).
 * Follows the same HTTP client patterns as knowledge-retrieval.ts.
 *
 * @module ollama-client
 */

// ============================================================================
// Types
// ============================================================================

export interface OllamaGenerateOptions {
  /** Request timeout in milliseconds (default 15000) */
  timeoutMs?: number;
  /** Temperature for generation (default 0.1 — low for deterministic judge verdicts) */
  temperature?: number;
  /** Max tokens to generate (default 150 — verdicts are short) */
  numPredict?: number;
}

export interface OllamaGenerateResult {
  /** Whether the call succeeded */
  ok: true;
  /** The generated text */
  response: string;
  /** Wall-clock time for the request in milliseconds */
  durationMs: number;
}

export interface OllamaGenerateError {
  ok: false;
  /** Error category for callers to handle gracefully */
  errorType: "timeout" | "connection_refused" | "invalid_response" | "unknown";
  /** Human-readable error message */
  message: string;
  /** Wall-clock time before the error in milliseconds */
  durationMs: number;
}

export type OllamaResult = OllamaGenerateResult | OllamaGenerateError;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_NUM_PREDICT = 150;

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate a completion from an Ollama instance.
 *
 * @param baseUrl - Ollama base URL (e.g., "http://192.168.1.20:11434")
 * @param model - Model name (e.g., "deepseek-r1-distill-qwen-7b:latest")
 * @param prompt - The prompt to send
 * @param options - Optional generation parameters
 * @returns Result object (check `.ok` for success/failure)
 */
export async function generateCompletion(
  baseUrl: string,
  model: string,
  prompt: string,
  options?: OllamaGenerateOptions,
): Promise<OllamaResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
  const numPredict = options?.numPredict ?? DEFAULT_NUM_PREDICT;
  const start = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/generate`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature,
          num_predict: numPredict,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        errorType: "invalid_response",
        message: `Ollama returned HTTP ${res.status}: ${body.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }

    const data = await res.json() as { response?: string };

    if (typeof data.response !== "string") {
      return {
        ok: false,
        errorType: "invalid_response",
        message: "Ollama response missing 'response' field",
        durationMs: Date.now() - start,
      };
    }

    return {
      ok: true,
      response: data.response,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const durationMs = Date.now() - start;

    // Abort signal fired → timeout
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        ok: false,
        errorType: "timeout",
        message: `Ollama request timed out after ${timeoutMs}ms`,
        durationMs,
      };
    }

    // Connection refused / network error
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("EHOSTUNREACH") ||
      msg.includes("fetch failed")
    ) {
      return {
        ok: false,
        errorType: "connection_refused",
        message: `Cannot connect to Ollama at ${baseUrl}: ${msg}`,
        durationMs,
      };
    }

    return {
      ok: false,
      errorType: "unknown",
      message: `Ollama request failed: ${msg}`,
      durationMs,
    };
  }
}
