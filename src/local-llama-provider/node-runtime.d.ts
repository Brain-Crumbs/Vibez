declare module "node:child_process" {
  interface LocalProcessStream {
    on(event: "data", callback: (data: Uint8Array) => void): void;
    on(event: "error", callback: (error: Error) => void): void;
  }
  interface LocalInferenceProcess {
    readonly pid?: number;
    readonly stdout: LocalProcessStream;
    readonly stdio: readonly (LocalProcessStream | null)[];
    once(event: "error", callback: (error: Error) => void): void;
    once(event: "close", callback: (code: number | null, signal: string | null) => void): void;
    kill(signal: "SIGKILL"): boolean;
  }
  export function spawn(command: string, args: readonly string[], options: {
    cwd: string; env: Readonly<Record<string, string>>; stdio: readonly ["ignore", "pipe", "ignore", "pipe"];
  }): LocalInferenceProcess;
}
declare module "node:fs" {
  export function statSync(path: string): { readonly mtimeMs: number; readonly mode: number };
  export function mkdtempSync(prefix: string): string;
  export function createReadStream(path: string): AsyncIterable<Uint8Array>;
}
