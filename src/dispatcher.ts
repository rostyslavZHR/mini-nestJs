import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Container } from "./container";
import { CanActivate, Constructor, ExecutionContext, Interceptor, NextFn, ParamMetadata } from "./types";
import { GUARD_METADATA_KEY, INTERCEPTOR_METADATA_KEY, PARAM_METADATA_KEY } from "./tokens";
import { router, Route } from "./router";
import { validateBody } from "./pipes/zod-validation.pipe";
import { runWithRequestContext } from "./context/request-context";
import { logStage } from "./lifecycle-log";
import { exceptionFilter } from "./filters/exception.filter";
import { HttpError } from "./errors/http.error";
import { sendJson } from "./send-json";

interface MatchedRoute {
  route: Route;
  params: Record<string, string>;
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

const getParamMap = (route: Route): Map<number, ParamMetadata> =>
  Reflect.getOwnMetadata(PARAM_METADATA_KEY, route.controller.prototype, route.property) ??
  new Map();

// Controller-level and method-level @UseGuards both apply — merge, don't shadow.
const getGuards = (route: Route): Constructor<CanActivate>[] => [
  ...(Reflect.getOwnMetadata(GUARD_METADATA_KEY, route.controller) ?? []),
  ...(Reflect.getOwnMetadata(GUARD_METADATA_KEY, route.controller.prototype, route.property) ?? []),
];

const runGuards = async (
  guards: Constructor<CanActivate>[],
  container: Container,
  context: ExecutionContext,
): Promise<void> => {
  logStage("guard");
  for (const GuardClass of guards) {
    const guard = container.resolve(GuardClass);
    const allowed = await guard.canActivate(context);
    if (!allowed) {
      throw new HttpError(403, { error: "Forbidden" });
    }
  }
};

const getInterceptors = (route: Route): Constructor<Interceptor>[] => [
  ...(Reflect.getOwnMetadata(INTERCEPTOR_METADATA_KEY, route.controller) ?? []),
  ...(Reflect.getOwnMetadata(INTERCEPTOR_METADATA_KEY, route.controller.prototype, route.property) ?? []),
];

// reduceRight wraps runHandler first, so the first interceptor in the list
// ends up outermost.
const runWithInterceptors = async (
  interceptors: Constructor<Interceptor>[],
  container: Container,
  context: ExecutionContext,
  runHandler: NextFn,
): Promise<unknown> => {
  const chain = interceptors
    .map((InterceptorClass) => container.resolve(InterceptorClass))
    .reduceRight<NextFn>(
      (next, interceptor) => () => Promise.resolve(interceptor.intercept(context, next)),
      runHandler,
    );

  logStage("interceptor:before");
  const result = await chain();
  logStage("interceptor:after");
  return result;
};

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

  return validateBody(paramMap, parsed);
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
  // ALS wraps the try/catch, not the other way round, so the filter can
  // still read requestId back out after a throw.
  const requestId = (req.headers["x-request-id"] as string | undefined) || randomUUID();
  res.setHeader("X-Request-Id", requestId);
  logStage("middleware");

  await runWithRequestContext({ requestId }, async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const matched = matchRoute(routes, req.method ?? "GET", url.pathname);
      if (!matched) {
        throw new HttpError(404, { error: "Not Found" });
      }

      const { route, params } = matched;
      const paramMap = getParamMap(route);
      const { instance, handler } = resolveHandler(container, route);

      const context: ExecutionContext = { req, controller: route.controller, property: route.property, params };

      await runGuards(getGuards(route), container, context);

      const runHandler = async (): Promise<unknown> => {
        logStage("pipe");
        const body = await resolveBody(req, paramMap);
        const args = buildArguments(paramMap, params, url, body, handler);

        logStage("handler");
        return handler.apply(instance, args);
      };

      const result = await runWithInterceptors(getInterceptors(route), container, context, runHandler);

      const statusCode = route.method === "POST" ? 201 : 200;
      sendJson(res, statusCode, result);
    } catch (error) {
      // Still inside the ALS run, so the filter can read requestId back out.
      exceptionFilter(error, res);
    }
  });
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
