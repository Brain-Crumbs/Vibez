export class ConsoleProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}
