declare module "node:crypto" {
  interface IptHash {
    update(data: Uint8Array): IptHash;
  }
}

declare module "node:fs" {
  export function rmdirSync(path: string): void;
}
