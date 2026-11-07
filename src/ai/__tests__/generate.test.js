import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const generateContent = vi.fn();
vi.mock('firebase/app', () => ({ getApp: vi.fn() }));
vi.mock('firebase/ai', () => ({
  getAI: vi.fn(),
  getGenerativeModel: vi.fn(() => ({ generateContent })),
  GoogleAIBackend: vi.fn(),
}));

const {
  AI_BUSY_MESSAGE,
  AI_FAILED_MESSAGE,
  AI_LIMIT_MESSAGE,
  generateWithRetry,
  isTransientAIError,
} = await import('../generate.js');

const busyError = Object.assign(
  new Error(
    'AI: Error fetching from https://example/models/x:generateContent: [500 ] This model is currently experiencing high demand. (AI/fetch-error)',
  ),
  { code: 'fetch-error', customErrorData: { status: 500 } },
);

beforeEach(() => {
  vi.useFakeTimers();
  generateContent.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isTransientAIError', () => {
  it('recognizes overload and temporary unavailability', () => {
    expect(isTransientAIError(busyError)).toBe(true);
    expect(isTransientAIError({ customErrorData: { status: 503 } })).toBe(true);
    expect(isTransientAIError(new Error('[429 ] Resource exhausted'))).toBe(true);
    expect(isTransientAIError({ customErrorData: { status: 400 } })).toBe(false);
    expect(isTransientAIError(new Error('API key not valid'))).toBe(false);
  });
});

describe('generateWithRetry', () => {
  it('retries while Gemini is overloaded and returns the first success', async () => {
    generateContent.mockRejectedValueOnce(busyError).mockResolvedValueOnce('ok');

    const pending = generateWithRetry({ model: 'm' }, 'hola');
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe('ok');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('gives up with a friendly message without leaking the URL', async () => {
    generateContent.mockRejectedValue(busyError);

    const pending = generateWithRetry({ model: 'm' }, 'hola');
    const outcome = expect(pending).rejects.toMatchObject({
      message: AI_BUSY_MESSAGE,
      code: 'ai-unavailable',
    });
    await vi.runAllTimersAsync();
    await outcome;
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('stops retrying when the project quota is exhausted', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('[429 ] Resource exhausted'), {
        code: 'fetch-error',
        customErrorData: {
          status: 429,
          errorDetails: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
          ],
        },
      }),
    );

    await expect(generateWithRetry({ model: 'm' }, 'hola')).rejects.toMatchObject({
      message: AI_LIMIT_MESSAGE,
      code: 'ai-unavailable',
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('does not retry permanent errors', async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error('bad request'), { customErrorData: { status: 400 } }),
    );

    await expect(generateWithRetry({ model: 'm' }, 'hola')).rejects.toMatchObject({
      message: AI_FAILED_MESSAGE,
      code: 'ai-failed',
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
