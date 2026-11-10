/** Minimal structural HTTP types for injected GitHub transports. */
export interface GitHubFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface GitHubFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type GitHubFetch = (url: string, init: GitHubFetchInit) => Promise<GitHubFetchResponse>;
