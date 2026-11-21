declare module "node:http" {
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    headersDistinct: Record<string, string[] | undefined>;
    iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<Uint8Array>;
    socket: { remoteAddress?: string };
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }
  export interface Server {
    address(): { port: number } | string | null;
    listen(port: number, host: string, callback: () => void): void;
    once(event: "error", listener: (error: Error) => void): void;
    removeListener(event: "error", listener: (error: Error) => void): void;
    close(callback: () => void): void;
    closeIdleConnections(): void;
  }
  export function createServer(
    options: { maxHeaderSize: number; requestTimeout: number; headersTimeout: number },
    listener: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
}

declare module "node:crypto" {
  export function randomBytes(length: number): Uint8Array & { toString(encoding: "base64url"): string };
  export function timingSafeEqual(first: Uint8Array, second: Uint8Array): boolean;
  export function createHash(algorithm: string): {
    update(bytes: Uint8Array): { digest(encoding: "hex"): string };
  };
}

declare module "node:fs" {
  export const constants: { O_NOFOLLOW: number; O_NONBLOCK: number; O_RDONLY: number };
  export function openSync(path: string, flags: number): number;
  export function fstatSync(fd: number): { size: number; nlink: number; ino: number; dev: number; mtimeMs: number; isFile(): boolean };
  export function readSync(fd: number, bytes: Uint8Array, offset: number, length: number, position: number | null): number;
}

declare module "node:worker_threads" {
  export const isMainThread: boolean;
  export const workerData: any;
  export class Worker {
    constructor(filename: URL, options: { workerData: unknown; env: Record<string, string> });
    on(event: "error", listener: (error: Error) => void): void;
    terminate(): Promise<number>;
  }
}
