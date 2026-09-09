import { Injectable } from "../decorators/injectable";
import { ExecutionContext, Interceptor, NextFn } from "../types";

@Injectable()
export class LoggingInterceptor implements Interceptor {
  async intercept(context: ExecutionContext, next: NextFn): Promise<unknown> {
    const start = Date.now();
    const result = await next();
    const elapsed = Date.now() - start;

    console.log(`${context.req.method} ${context.req.url} — ${elapsed.toFixed(1)} ms`);

    return result;
  }
}
