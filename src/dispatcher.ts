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

// Class-level (@UseGuards on the controller) and method-level (@UseGuards on
// the handler) guards both apply — merge rather than let one shadow the other.
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

// Same merge as getGuards: class-level and method-level @UseInterceptors both apply.
const getInterceptors = (route: Route): Constructor<Interceptor>[] => [
  ...(Reflect.getOwnMetadata(INTERCEPTOR_METADATA_KEY, route.controller) ?? []),
  ...(Reflect.getOwnMetadata(INTERCEPTOR_METADATA_KEY, route.controller.prototype, route.property) ?? []),
];

// Wraps runHandler in each interceptor's intercept(context, next), outermost
// interceptor first — reduceRight builds that nesting because the first
// interceptor in the list needs to be the outermost closure, and reduceRight
// folds right-to-left, wrapping runHandler first and the first interceptor last.
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
  // --- middleware ---
  // Echo a client-supplied request id, or generate one, and set it on the
  // response header — this part happens before the ALS store even exists.
  // logStage("middleware") fires here too, so the label marks "the
  // middleware work happened", not "the ALS store just started" — the store
  // itself starts one line down, still before the try, so a filter catching
  // a later throw can still read the id back out (the store wraps the
  // try/catch, not the other way round).
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

      // Decision: guards and interceptors attach via decorators writing Reflect
      // metadata (@UseGuards / @UseInterceptors on the controller or the
      // handler), the same pattern as @Controller/@Get/@Body — not a plain
      // array passed into createDispatcher. Consistent with parts 1-2, and
      // keeps them scoped per-controller/per-handler instead of global-only.
      const context: ExecutionContext = { req, controller: route.controller, property: route.property, params };

      // --- guard ---
      // First false/throw -> reject with 403; nothing from here down
      // (interceptors, pipes, handler) runs.
      await runGuards(getGuards(route), container, context);

      // --- interceptor, wrapping pipe + handler ---
      // runHandler is the innermost `next`; each interceptor's intercept(context,
      // next) — before-code, `await next()`, after-code — shares one closure,
      // so nothing hangs on the request between separate "before"/"after" hooks.
      //
      // --- pipe (per argument) ---
      // resolveBody + buildArguments today only validate the @Body() argument;
      // a pipe stage belongs per ParamMetadata entry here: each param
      // (body/param/query) runs through its pipe(s) before it lands in `args`.
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
      // --- exception filter ---
      // Catches anything thrown above: 404 from matchRoute, 403 from a guard,
      // a validation error from a pipe, or a throw from an interceptor/handler.
      // Still inside the ALS run started above, so it can read requestId back
      // out of the store to stamp it on the response body.
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
