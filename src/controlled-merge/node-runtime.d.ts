declare module "node:fs" {
  export function utimesSync(path: string, atime: Date, mtime: Date): void;
}

declare function fetch(url: string, init?: import("../github-http.js").GitHubFetchInit): Promise<import("../github-http.js").GitHubFetchResponse>;

interface IptIntervalHandle {
  unref?(): void;
}

declare function setInterval(callback: () => void, ms: number): IptIntervalHandle;
declare function clearInterval(handle: IptIntervalHandle | undefined): void;
