declare module "node:crypto" {
  interface IptHash {
    update(data: Uint8Array): IptHash;
  }
}
