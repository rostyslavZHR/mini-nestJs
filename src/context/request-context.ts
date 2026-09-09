import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  requestContextStorage.run(context, fn);

// Falls back instead of returning undefined, so callers never have to check.
export const getRequestId = (): string =>
  requestContextStorage.getStore()?.requestId ?? "no-request-context";
