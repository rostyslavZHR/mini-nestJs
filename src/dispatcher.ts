import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { Container } from "./container";
import { Constructor, ParamMetadata } from "./types";
import { PARAM_METADATA_KEY } from "./tokens";
import { router, Route } from "./router";
import { getBodyDtoClass, validateDto } from "./pipes/validation.pipe";

interface MatchedRoute {
  route: Route;
  params: Record<string, string>;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${statusCode}`);
  }
}

// Among routes matching by segment count, the one with the most literal
// (non ":") segments wins — a static route like /users/me must be preferred
// over a parametric /users/:id regardless of declaration order.
const matchRoute = (routes: Route[], method: string, pathname: string): MatchedRoute | null => {
  const pathSegments = pathname.split("/").filter(Boolean);

  let best: MatchedRoute | null = null;
  let bestStaticSegments = -1;

  for (const route of routes) {
    if (route.method !== method) continue;

    const routeSegments = route.path.split("/").filter(Boolean);
    if (routeSegments.length !== pathSegments.length) continue;

    const params: Record<string, string> = {};
    let staticSegments = 0;
    const isMatch = routeSegments.every((segment, index) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = pathSegments[index] as string;
        return true;
      }
      staticSegments++;
      return segment === pathSegments[index];
    });

    if (isMatch && staticSegments > bestStaticSegments) {
      best = { route, params };
      bestStaticSegments = staticSegments;
    }
  }

  return best;
};

const sendJson = (res: ServerResponse, statusCode: number, body: unknown): void => {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const getParamMap = (route: Route): Map<number, ParamMetadata> =>
  Reflect.getOwnMetadata(PARAM_METADATA_KEY, route.controller.prototype, route.property) ??
  new Map();

const needsBody = (paramMap: Map<number, ParamMetadata>): boolean =>
  Array.from(paramMap.values()).some((meta) => meta.type === "body");

// node:http gives the raw stream and nothing else — collect on 'data', parse on 'end'.
const readRequestBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const resolveHandler = (
  container: Container,
  route: Route,
): { instance: Record<string, (...args: unknown[]) => unknown>; handler: (...args: unknown[]) => unknown } => {
  const instance = container.resolve(route.controller) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const handler = instance[route.property];

  if (!handler) {
    throw new HttpError(500, { error: `${route.property} is not a function` });
  }

  return { instance, handler };
};

const resolveBody = async (
  req: IncomingMessage,
  route: Route,
  paramMap: Map<number, ParamMetadata>,
): Promise<unknown> => {
  if (!needsBody(paramMap)) return undefined;

  let parsed: unknown;
  try {
    const raw = await readRequestBody(req);
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new HttpError(400, { error: "Malformed JSON body" });
  }

  const dtoClass = getBodyDtoClass(route.controller, route.property, paramMap);
  if (!dtoClass) return parsed;

  const { instance: validated, errors } = await validateDto(dtoClass, parsed);
  if (errors.length > 0) {
    throw new HttpError(400, { errors });
  }

  return validated;
};

const buildArguments = (
  paramMap: Map<number, ParamMetadata>,
  matchedParams: Record<string, string>,
  url: URL,
  body: unknown,
  handler: (...args: unknown[]) => unknown,
): unknown[] =>
  // handler.length, not the highest map key — an undecorated parameter leaves a gap.
  Array.from({ length: handler.length }, (_unused, index) => {
    const meta = paramMap.get(index);
    if (!meta) return undefined;

    switch (meta.type) {
      case "param":
        return matchedParams[meta.name];
      case "query":
        // null (missing) normalized to undefined, matching an omitted argument.
        return url.searchParams.get(meta.name) ?? undefined;
      case "body":
        return body;
    }
  });

const handleRequest = async (
  routes: Route[],
  container: Container,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = matchRoute(routes, req.method ?? "GET", url.pathname);
    if (!matched) {
      throw new HttpError(404, { error: "Not Found" });
    }

    const { route, params } = matched;
    const paramMap = getParamMap(route);

    const { instance, handler } = resolveHandler(container, route);
    const body = await resolveBody(req, route, paramMap);
    const args = buildArguments(paramMap, params, url, body, handler);

    const result = await handler.apply(instance, args);
    const statusCode = route.method === "POST" ? 201 : 200;
    sendJson(res, statusCode, result);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, error.body);
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: "Internal Server Error" });
  }
};

export const createDispatcher = (
  controllers: Constructor[],
  container: Container = new Container(),
): Server => {
  const routes = router(controllers);

  return createServer((req, res) => handleRequest(routes, container, req, res));
};

export const startDispatcher = (
  controllers: Constructor[],
  port: number,
  container?: Container,
): Server => {
  const server = createDispatcher(controllers, container);
  server.listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
  return server;
};
