import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ManualConsoleReader } from "./reader.js";
import { opaqueIdPattern as idPattern, replyBytes, requestIdPattern, type ManualConsoleCommands } from "./commands.js";
import { object, redact } from "../workflow-driver/io.js";
import { ConsoleProblem } from "./problem.js";

const protocol = "vibez.manual-console";
const prefix = "/manual-console/v1";
const loopback = "127.0.0.1";
const utf8 = new TextEncoder();
const minute = 60_000;
const codePattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const pageSize = 25;

const invalid = () => new ConsoleProblem(400, "invalid-request", "Check the request path, query, or JSON envelope.");
const unauthorized = () => new ConsoleProblem(401, "unauthorized", "Pair with the local host again.");
const notFound = () => new ConsoleProblem(404, "not-found", "The requested resource is unavailable.");
const invalidCursor = () => new ConsoleProblem(400, "invalid-cursor", "Restart the run listing without a cursor.");

function single(request: IncomingMessage, header: string): string | undefined {
  const values = request.headersDistinct[header];
  if (values && values.length !== 1) throw invalid();
  return values?.[0];
}
function equalCredential(expected: string, presented: string | undefined): boolean {
  return presented?.length === 43 && codePattern.test(presented) &&
    timingSafeEqual(utf8.encode(expected), utf8.encode(presented));
}
const secret = () => randomBytes(32).toString("base64url");
const envelope = (kind: string, data: unknown) => ({ version: 1, kind, data });
function json(response: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  if (utf8.encode(body).byteLength > 64 * 1024 * 1024)
    throw new ConsoleProblem(500, "internal-error", "The response exceeds the host limit.");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(body);
}

function allowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.protocol === "http:" &&
      [loopback, "[::1]", "localhost"].includes(parsed.hostname);
  } catch { return false; }
}

async function readEnvelope(request: IncomingMessage, kind: string, limit = 64 * 1024) {
  const tooLarge = () => new ConsoleProblem(413, "payload-too-large", "The request exceeds the host byte limit.");
  const length = single(request, "content-length");
  if (length !== undefined && Number(length) > limit) throw tooLarge();
  if (single(request, "content-encoding") !== undefined ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(single(request, "content-type") ?? "")) throw invalid();
  const chunks: Uint8Array[] = [];
  let used = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    used += chunk.byteLength;
    if (used > limit) throw tooLarge();
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(used);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (object(value) && Object.keys(value).length === 3 && value.version === 1 && value.kind === kind &&
        object(value.data)) return value.data;
  } catch { throw invalid(); }
  throw invalid();
}

const commandPaths = ["start", "resume", "replies"];
const commandCapabilities = ["start", "resume", "submit-reply", "request-lookup", "receipt-read"];
function commandPreflight(path: string, projectId: string) {
  const [empty, namespace, major, projects, project, runs, session, action, ...tail] = path.split("/");
  return empty === "" && namespace === "manual-console" && major === "v1" && projects === "p" &&
    project === projectId && runs === "runs" && session && idPattern.test(session) && !!action &&
    commandPaths.includes(action) && tail.length === 0;
}

type RunSummary = ReturnType<ManualConsoleReader["list"]>[number];
interface Operator {
  token: string;
  expires: number;
  requests: number[];
  cursors: Map<string, Page>;
}
interface Page {
  rows: RunSummary[];
  position: number;
  limit: number;
  expires: number;
  next?: string;
}
function runPage(operator: Operator, reader: ManualConsoleReader, query: URLSearchParams) {
  if ([...query.keys()].some(key => key !== "limit" && key !== "cursor") ||
      query.getAll("limit").length > 1 || query.getAll("cursor").length > 1) throw invalid();
  const length = query.get("limit");
  if (length !== null && !/^(?:[1-9]|1[0-9]|2[0-5])$/.test(length)) throw invalid();
  const token = query.get("cursor");
  const now = Date.now();
  for (const [key, page] of operator.cursors) if (page.expires <= now) operator.cursors.delete(key);
  let page: Page;
  if (token !== null) {
    const saved = operator.cursors.get(token);
    if (!saved || (length !== null && Number(length) !== saved.limit)) throw invalidCursor();
    reader.checkScope();
    page = saved;
  } else {
    page = { rows: reader.list(), position: 0, limit: length === null ? pageSize : Number(length), expires: now + 5 * minute };
  }
  const runs = page.rows.slice(page.position, page.position + page.limit);
  const position = page.position + runs.length;
  if (position < page.rows.length && (!page.next || !operator.cursors.has(page.next))) {
    if (operator.cursors.size >= 64) operator.cursors.delete(operator.cursors.keys().next().value!);
    page.next = secret();
    operator.cursors.set(page.next, { rows: page.rows, position, limit: page.limit, expires: page.expires });
  }
  return { projectId: reader.projectId, observedAt: runs[0]?.observedAt ?? new Date(now).toISOString(),
    runs, nextCursor: page.next ?? null };
}

export async function serveManualConsole(reader: ManualConsoleReader, origin: string, port: number, signal: AbortSignal,
  announce: (message: string) => void, commands?: ManualConsoleCommands): Promise<void> {
  if (!allowedOrigin(origin)) throw new Error("Supply one canonical HTTP loopback browser origin.");
  if (signal.aborted) return;
  reader.checkScope();
  let pairing: { code: string; expires: number } | undefined;
  let operator: Operator | undefined;
  let failures: number[] = [];
  let host = "";

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Vary", "Origin");
    const browser = single(request, "origin");
    if (request.socket.remoteAddress !== loopback || single(request, "host") !== host ||
        (browser !== undefined && browser !== origin))
      throw new ConsoleProblem(403, "forbidden", "Use the configured loopback endpoint and browser origin.");
    if (browser !== undefined) response.setHeader("Access-Control-Allow-Origin", origin);

    const raw = request.url ?? "";
    if (utf8.encode(raw).byteLength > 4096)
      throw new ConsoleProblem(413, "payload-too-large", "The request path exceeds the host limit.");
    const separator = raw.indexOf("?");
    const path = separator === -1 ? raw : raw.slice(0, separator);
    const query = separator === -1 ? "" : raw.slice(separator + 1);
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || (path !== "/manual-console" && !path.startsWith("/manual-console/"))) throw notFound();
    const method = request.method;
    if (method === "OPTIONS") {
      const requestedMethod = single(request, "access-control-request-method");
      const headers = (single(request, "access-control-request-headers") ?? "").toLowerCase().split(",").map(h => h.trim()).filter(Boolean);
      if (browser === undefined || (requestedMethod !== "GET" && !(requestedMethod === "POST" && (path === prefix + "/operator-session" || (commands && commandPreflight(path, reader.projectId))))) ||
          headers.some(h => h !== "authorization" && h !== "content-type")) throw invalid();
      response.setHeader("Access-Control-Allow-Methods", requestedMethod);
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.statusCode = 204;
      response.end();
      return;
    }
    if (method === "GET" && (single(request, "transfer-encoding") !== undefined ||
        (single(request, "content-length") ?? "0") !== "0")) throw invalid();
    if (path === "/manual-console" && method === "GET" && separator === -1)
      return json(response, 200, { protocol, versions: [1] });
    const version = /^\/manual-console\/v([0-9]+)(?:\/|$)/.exec(path)?.[1];
    if (version !== undefined && version !== "1")
      return json(response, 400, { protocol, code: "unsupported-version", versions: [1] });
    if (!path.startsWith(prefix + "/")) throw notFound();
    const route = path.slice(prefix.length);
    const now = Date.now();
    if (route === "/operator-session" && method === "POST" && separator === -1) {
      failures = failures.filter(failure => now - failure < minute);
      if (failures.length >= 5)
        throw new ConsoleProblem(429, "rate-limited", "Wait before trying to pair again.", minute - (now - failures[0]!));
      let code: string;
      try {
        const body = await readEnvelope(request, "pairingRequest");
        if (Object.keys(body).length !== 1 || typeof body.code !== "string" || !codePattern.test(body.code)) throw invalid();
        code = body.code;
      }
      catch (error) {
        if (failures.length < 5) failures.push(Date.now());
        throw error;
      }
      const settledAt = Date.now();
      if (failures.length >= 5)
        throw new ConsoleProblem(429, "rate-limited", "Wait before trying to pair again.", Math.max(1, minute - (settledAt - failures[0]!)));
      if (!pairing || settledAt >= pairing.expires || !equalCredential(pairing.code, code)) {
        failures.push(settledAt);
        throw unauthorized();
      }
      reader.checkScope();
      pairing = undefined;
      operator = { token: secret(), expires: settledAt + 8 * 60 * minute, requests: [], cursors: new Map() };
      return json(response, 200, envelope("operatorSession", { token: operator.token, expiresAt: new Date(operator.expires).toISOString() }));
    }

    const authorization = single(request, "authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!operator || now >= operator.expires || !equalCredential(operator.token, bearer)) throw unauthorized();
    operator.requests = operator.requests.filter(time => now - time < 1000);
    if (operator.requests.length >= 10)
      throw new ConsoleProblem(429, "rate-limited", "Wait before polling again.", 1000 - (now - operator.requests[0]!));
    operator.requests.push(now);

    if (route === "/capabilities" && method === "GET" && separator === -1) {
      reader.checkScope();
      return json(response, 200, envelope("capabilities", { projectId: reader.projectId, checkoutLabel: reader.checkoutLabel,
        capabilities: ["run-list", "run-read", "packet-read", ...(commands ? commandCapabilities : [])], pollAfterMs: 1000 }));
    }
    const [, p, project, collection, session, resource, item, extra, ...tail] = route.split("/");
    if (p !== "p" || project !== reader.projectId || collection !== "runs" || tail.length) throw notFound();
    if (session === undefined && method === "GET")
      return json(response, 200, envelope("runList", runPage(operator, reader, new URLSearchParams(query))));
    if (!session || !idPattern.test(session)) throw notFound();
    const historyPage = resource === "history" && method === "GET" && item === undefined;
    if (separator !== -1 && !historyPage) throw notFound();
    if (resource === undefined && method === "GET") return json(response, 200, envelope("run", commands ? await commands.run(session) : reader.run(session)));
    if (resource === "packets" && method === "GET" && item && idPattern.test(item) && extra === undefined)
      return json(response, 200, envelope("correspondence", reader.packet(session, item)));
    if (commands && method === "POST" && item === undefined && resource && commandPaths.includes(resource)) {
      if (signal.aborted) throw new ConsoleProblem(503, "temporarily-unavailable", "The local host is draining.", 1000);
      const reply = resource === "replies";
      const body = await readEnvelope(request, reply ? "replyRequest" : "commandRequest", reply ? 32 * 1024 * 1024 : undefined);
      if (Date.now() >= operator.expires) throw unauthorized();
      const target = body.target;
      const requestId = body.requestId;
      if (Object.keys(body).length !== (reply ? 4 : 2) || !object(target) || Object.keys(target).length !== 3 ||
          target.projectId !== project || target.sessionId !== session ||
          typeof target.attemptId !== "string" || !idPattern.test(target.attemptId) ||
          typeof requestId !== "string" || !requestIdPattern.test(requestId)) throw invalid();
      const scope = { projectId: project, sessionId: session, attemptId: target.attemptId };
      let view;
      if (reply) {
        if (typeof body.expectedPacketId !== "string" || !idPattern.test(body.expectedPacketId) || typeof body.replyText !== "string") throw invalid();
        if (utf8.encode(body.replyText).byteLength > replyBytes)
          throw new ConsoleProblem(413, "payload-too-large", "The decoded reply exceeds 4 MiB.");
        if (body.replyText.includes(operator.token) || body.replyText.includes(authorization ?? operator.token) ||
            redact(body.replyText) !== body.replyText || /[\uD800-\uDFFF]/u.test(body.replyText)) throw invalid();
        if (signal.aborted) throw new ConsoleProblem(503, "temporarily-unavailable", "The local host is draining.", 1000);
        view = await commands.submit("submit-reply", scope, requestId, { text: body.replyText, expectedPacketId: body.expectedPacketId });
      } else {
        if (signal.aborted) throw new ConsoleProblem(503, "temporarily-unavailable", "The local host is draining.", 1000);
        view = await commands.submit(resource === "start" ? "start" : "resume", scope, requestId);
      }
      return json(response, view.operation.state === "pending" ? 202 : 200, envelope("operationView", view));
    }
    if (commands && method === "GET" && item && extra === undefined) {
      if (resource === "requests" && requestIdPattern.test(item))
        return json(response, 200, envelope("operationView", await commands.lookup(session, item)));
      if (resource === "receipts" && idPattern.test(item))
        return json(response, 200, envelope("receipt", commands.receipt(session, item)));
    }
    if ((method === "POST" && item === undefined && commandPaths.includes(resource ?? "")) ||
        (method === "GET" && (historyPage ||
          (item && idPattern.test(item) && ((resource === "requests" && extra === undefined) ||
            (resource === "receipts" && (extra === undefined || extra === "original"))))))) {
      reader.run(session);
      throw new ConsoleProblem(422, "unsupported-action", "This host supports run and current packet reads.");
    }
    throw notFound();
  }

  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 10_000, headersTimeout: 5000 }, (request, response) => {
    void handle(request, response).catch(error => {
      response.setHeader("Connection", "close");
      const problem = error instanceof ConsoleProblem ? error :
        new ConsoleProblem(500, "internal-error", "The local host could not complete the operation.");
      json(response, problem.status, envelope("problem", {
        code: problem.code, message: problem.message, retryAfterMs: problem.retryAfterMs,
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const stop = () => server.close(() => resolve());
    const failed = (error: Error) => {
      signal.removeEventListener("abort", stop);
      reject(error);
    };
    server.once("error", failed);
    server.listen(port, loopback, () => {
      const address = server.address();
      if (!address || typeof address === "string") { stop(); return; }
      host = loopback + ":" + address.port;
      if (signal.aborted) { stop(); return; }
      pairing = { code: secret(), expires: Date.now() + 5 * minute };
      signal.addEventListener("abort", stop, { once: true });
      announce("Manual console endpoint: http://" + host + "\nPairing code: " + pairing.code);
    });
  });
}
