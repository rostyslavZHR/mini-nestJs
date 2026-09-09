# mini-nest

Minimal recursive DI container on top of `reflect-metadata`. No NestJS/InversifyJS/tsyringe/typedi — resolution is done manually via `design:paramtypes`.

## How it works

With `emitDecoratorMetadata` on, TypeScript writes down each decorated class's constructor parameter types as runtime metadata (`design:paramtypes`) — it's just an array of the classes referenced in the constructor signature, attached to the class itself via `reflect-metadata`. `@Injectable()` doesn't do much on its own beyond marking a class as buildable and recording its scope; the actual work happens in `Container.resolve()`, which reads that array back out and recursively calls itself on each entry before constructing the class with `new`.

Without `emitDecoratorMetadata`, that array is never written, so `design:paramtypes` comes back `undefined` and there's nothing to resolve against — the container has no way to know what a constructor needs.

## Usage

```ts
@Injectable()
class Repo {}

@Injectable()
class Service {
  constructor(private repo: Repo) {}
}

const container = new Container();
container.resolve(Service); // Repo gets built and injected automatically
```

For dependencies that aren't concrete classes (interfaces, config values — anything that erases to `Object` at runtime), use a token:

```ts
const CONFIG = Symbol.for('CONFIG');

@Injectable()
class Service {
  constructor(@Inject(CONFIG) private config: { port: number }) {}
}

container.register(CONFIG, { port: 3000 });
container.resolve(Service);
```

## Scopes

- `singleton` (default) — one instance per container
- `transient` — new instance every `resolve()`

```ts
@Injectable({ scope: 'transient' })
class Logger {}
```

## Circular dependencies

`resolve()` tracks the current resolution path and throws with the full chain instead of blowing the call stack:

```
Circular dependency detected: A -> B -> A
```

## HTTP layer

`@Controller(prefix)` marks a class as a route holder; `@Get(path)`/`@Post(path)` mark a method as a route handler. The full route is the prefix and the method path joined together — `@Controller('users')` plus `@Get(':id')` answers `GET /users/42`.

A controller needs both `@Injectable()` and `@Controller()` — they're not redundant, they answer two different questions. `@Injectable()` is what lets `Container.resolve()` build the class at all (constructor injection, singleton/transient scope); `@Controller()` is purely routing metadata, read by `router()`. Drop `@Injectable()` and the dispatcher can't construct the controller; drop `@Controller()` and its methods have nowhere to attach a prefix.

```ts
@Injectable()
@Controller('users')
class UsersController {
  constructor(private usersService: UsersService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.find(id);
  }

  @Get()
  findAll(@Query('limit') limit: string) {
    return this.usersService.findAll(limit);
  }

  @Post()
  create(@Body(CreateUserSchema) body: CreateUserDto) {
    return this.usersService.create(body);
  }
}

startDispatcher([UsersController], 3000);
```

Route matching prefers the most specific match, not the first declared one: a literal
segment (`@Get('me')`) always wins over a `:param` segment (`@Get(':id')`) at the same
position, so declaration order between them doesn't matter.

`createDispatcher`/`startDispatcher` also accept an optional `Container` so providers
can be registered before the server starts handling requests:

```ts
const container = new Container();
container.register(CONFIG, { port: 3000 });
startDispatcher([UsersController], 3000, container);
```

### How a parameter decorator knows where to substitute its value

`@Body()`, `@Param(name)`, and `@Query(name)` don't extract anything themselves — a parameter decorator runs once, at class-declaration time, long before any request exists. All it can do is leave a note. The compiler hands every parameter decorator `(target, propertyKey, parameterIndex)`, and `parameterIndex` is the only thing that survives to identify *which* argument this is — parameter names are erased along with everything else at compile time. So each decorator records `{ type: 'body' | 'param' | 'query', name? }` at that index, in one map keyed by index, scoped to that specific method (`target` + `propertyKey`) so two different handlers never collide.

At request time, the dispatcher reads that map back out. For each position in the handler's parameter list, it checks the map: a `'param'` entry pulls from the path segments matched by the route pattern, `'query'` from the URL's query string, `'body'` from the parsed request body. It builds a plain array in argument order and calls the handler with `.apply()` — the handler never touches `req` directly. `@Body()`'s validation schema, specifically, can't be found the way the container finds constructor dependencies: a Zod schema isn't a class, so it never shows up on `design:paramtypes`. It has to be passed explicitly — `@Body(CreateUserSchema)` — and that's what gets stored at the same index alongside the `'body'` entry.

### Validation

**This replaces HW#7's `class-validator`/`class-transformer` validation rather than sitting alongside it.** The old criterion was `body instanceof CreateUserDto`, which a Zod-parsed plain object can never satisfy — there's no DTO class left to be an instance of. That test in `dispatcher.test.ts` was rewritten to check what Zod actually guarantees instead: the parsed body matches the schema shape exactly, with any field the schema doesn't declare stripped out. Keeping both validation mechanisms side by side so neither test class ever went red was the other option; it was rejected because HW#8 says "rewrite," and shipping two validation systems in one codebase reads as indecision rather than a decision.

A `@Body(schema)` parameter gets validated before the handler ever runs. `schema.parse(parsedBody)` either returns the validated (and, for an object schema, unknown-key-stripped) data, or throws a `ZodError` that the pipe turns into `HttpError(400, { errors: error.issues })`. An untyped `@Body()` — no schema argument — skips validation entirely, same as before: silently, by design, not a bug.

```ts
export const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
});

export type CreateUserDto = z.infer<typeof CreateUserSchema>;
```

An invalid body returns `400` with every violation, not just the first — as Zod issues, not `class-validator` constraints:

```json
{ "errors": [{ "code": "invalid_format", "path": ["email"], "message": "Invalid email address" }] }
```

A valid body reaches the handler as the data `schema.parse` produced — a plain object matching the schema, not a class instance, and with any field outside the schema silently dropped.

## Request lifecycle

```
middleware              ← ALS starts here, X-Request-Id echoed/generated
  try {
    guard                — canActivate(); first false/throw → 403, nothing below runs
    interceptor(before)
      pipe               — @Body(schema) validated, per argument
      handler
    interceptor(after)
  } catch {
    filter               — maps whatever was thrown to a status code + body
  }
```

The nesting is the point, not just the ordering. `middleware` wraps the `try`/`catch`, not the other way round, so the `filter` in the `catch` can still read the request id back out of the ALS store even when the throw happened before the store's contents would otherwise have gone out of scope. And `guard`/`interceptor`/`pipe`/`handler` all live inside one `try`, not four separate ones, so a single `catch` — and a single `exceptionFilter` — handles a rejection from any of them: a `403` from a guard, a `ZodError` from a pipe, a plain throw from an interceptor or the handler itself.

`@UseGuards(...)` and `@UseInterceptors(...)` attach to a controller class or an individual route method — the same `Reflect` metadata pattern as `@Controller`/`@Get`/`@Body`, not a plain array passed into `createDispatcher`. Class-level and method-level entries are merged, controller first: a guard on the controller runs before a guard on the method, and a controller-level interceptor wraps a method-level one (outermost-first), matching real Nest's global → controller → method ordering. `AuthGuard` is the example guard: `canActivate` returns `false` when the request has no `Authorization` header, which the dispatcher turns into a `403` before the handler ever runs.

An interceptor is `intercept(context, next)`, not two separate before/after hooks — before-code, `await next()`, after-code all share one closure, so nothing has to be stashed on the request between two calls the way you'd need to with Fastify-style pre/post hooks. `LoggingInterceptor` is the example: it takes a timestamp before `next()`, takes another after, and logs `${method} ${url} — ${elapsed} ms`.

### Why the request id lives in `AsyncLocalStorage`, not a module-level variable

A plain `let currentRequestId` would work for exactly one request at a time. Node is single-threaded, but it isn't synchronous end-to-end — `await`s inside guards, pipes, and handlers all yield to the event loop, and a second request's code can (and, under load, will) run in those gaps. A module-level variable is one cell shared by every request in the process, so the second request overwrites it before the first request's continuation reads it back — silent cross-request leakage, not a crash, which makes it the kind of bug that only shows up in production under concurrency, never in a quick manual test.

`AsyncLocalStorage` sidesteps this by binding the value to the async *execution context* rather than to a shared cell: everything scheduled from inside `als.run(store, fn)` — every `await`, every callback, every promise chain spawned from `fn` — can call `als.getStore()` and get back that specific call's store, regardless of how many other requests' async work is interleaved with it on the same event loop. No function in between has to accept and forward a `requestId` parameter for this to work; `RequestLogService` reads it with a bare `getRequestId()` call despite being invoked several layers below `dispatcher.ts`. The ten-parallel-requests test in `dispatcher.test.ts` is the concrete version of this: ten requests in flight at once, each awaiting a random delay so they genuinely interleave, and each one's response still carries only the id it was given.

## Scripts

```bash
npm ci
npm run build
npm test
```

Or in Docker:

```bash
docker compose run --rm api npm test
```

If you've built the image before and changed a dependency since, add `--build` — otherwise `docker compose run` reuses whatever it last built.

## Layout

- `src/container.ts` — `Container` class
- `src/decorators/injectable.ts` — `@Injectable()`
- `src/decorators/inject.ts` — `@Inject(token)`
- `src/decorators/controller.ts` — `@Controller(prefix)`
- `src/decorators/methods.ts` — `@Get(path)`, `@Post(path)`
- `src/decorators/params.ts` — `@Body(schema?)`, `@Param(name)`, `@Query(name)`
- `src/decorators/use-guards.ts` — `@UseGuards(...guards)`
- `src/decorators/use-interceptors.ts` — `@UseInterceptors(...interceptors)`
- `src/guards/auth.guard.ts` — rejects a request with no `Authorization` header
- `src/router.ts` — collects the full route table from every controller's metadata
- `src/dispatcher.ts` — the HTTP layer: middleware, guards, interceptors, pipes, handler dispatch, all on `node:http`
- `src/pipes/zod-validation.pipe.ts` — finds the schema attached to `@Body()` and runs it against the parsed body
- `src/dto/create-user.schema.ts` — example schema
- `src/filters/exception.filter.ts` — maps a thrown error to a status code and response body
- `src/errors/not-found.error.ts`, `src/errors/http.error.ts` — domain errors the filter knows how to map
- `src/interceptors/logging.interceptor.ts` — logs method, path, and elapsed time around the handler
- `src/context/request-context.ts` — the `AsyncLocalStorage` request context and its `requestId` getter
- `src/services/request-log.service.ts` — example of a deep service reading `requestId` off the store
- `src/tokens.ts` — metadata key symbols
- `src/types.ts` — `DecoratorScope`, `Constructor<T>`, `Token`, `ParamMetadata`, `ExecutionContext`, `CanActivate`, `Interceptor`, `LifecycleStage`
- `test/container.test.ts`, `test/dispatcher.test.ts`, `test/lifecycle-order.test.ts` — tests
