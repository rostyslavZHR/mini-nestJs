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

const matchRoute = (routes: Route[], method: string, pathname: string): MatchedRoute | null => {
  const pathSegments = pathname.split("/").filter(Boolean);

  for (const route of routes) {
    if (route.method !== method) continue;

    const routeSegments = route.path.split("/").filter(Boolean);
    if (routeSegments.length !== pathSegments.length) continue;

    const params: Record<string, string> = {};
    const isMatch = routeSegments.every((segment, index) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = pathSegments[index] as string;
        return true;
      }
      return segment === pathSegments[index];
    });

    if (isMatch) return { route, params };
  }

  return null;
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
  const url = new URL(req.url ?? "/", "http://localhost");
  const matched = matchRoute(routes, req.method ?? "GET", url.pathname);

  if (!matched) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }

  const { route, params } = matched;
  const instance = container.resolve(route.controller) as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const handler = instance[route.property];

  if (!handler) {
    sendJson(res, 500, { error: `${route.property} is not a function` });
    return;
  }

  const paramMap = getParamMap(route);

  let body: unknown;
  if (needsBody(paramMap)) {
    let parsed: unknown;
    try {
      const raw = await readRequestBody(req);
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      sendJson(res, 400, { error: "Malformed JSON body" });
      return;
    }

    const dtoClass = getBodyDtoClass(route.controller, route.property, paramMap);
    if (dtoClass) {
      const { instance: validated, errors } = await validateDto(dtoClass, parsed);
      if (errors.length > 0) {
        sendJson(res, 400, { errors });
        return;
      }
      body = validated;
    } else {
      body = parsed;
    }
  }

  const args = buildArguments(paramMap, params, url, body, handler);

  try {
    const result = await handler.apply(instance, args);
    const statusCode = route.method === "POST" ? 201 : 200;
    sendJson(res, statusCode, result);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Internal Server Error" });
  }
};

export const createDispatcher = (controllers: Constructor[]): Server => {
  const container = new Container();
  const routes = router(controllers);

  return createServer((req, res) => handleRequest(routes, container, req, res));
};

export const startDispatcher = (controllers: Constructor[], port: number): Server => {
  const server = createDispatcher(controllers);
  server.listen(port, () => {
    console.log(`listening on http://localhost:${port}`);
  });
  return server;
};
