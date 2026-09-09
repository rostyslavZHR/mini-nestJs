import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  requestContextStorage.run(context, fn);

// Falls back rather than returning undefined — a service deep in the call
// stack shouldn't have to know (or check) whether it's running inside a
// request at all just to log an id.
export const getRequestId = (): string =>
  requestContextStorage.getStore()?.requestId ?? "no-request-context";
