declare module "node:url" {
  export function fileURLToPath(url: URL): string;
}

declare module "node:fs" {
  export function accessSync(path: string, mode?: number): void;
  export function realpathSync(path: string): string;
  export function statfsSync(path: string): { readonly type: number };
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
}

declare module "node:fs" {
  export function readdirSync(path: string, options: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}

declare module "node:child_process" {
  export function execFileSync(file: string, args: readonly string[], options: {
    cwd: string;
    env: Record<string, string | undefined>;
    encoding: "utf8";
    stdio: readonly ("pipe" | "ignore" | "inherit")[];
    timeout: number;
    maxBuffer?: number;
  }): string;
}
