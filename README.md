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
  create(@Body() body: CreateUserDto) {
    return this.usersService.create(body);
  }
}

startDispatcher([UsersController], 3000);
```

### How a parameter decorator knows where to substitute its value

`@Body()`, `@Param(name)`, and `@Query(name)` don't extract anything themselves — a parameter decorator runs once, at class-declaration time, long before any request exists. All it can do is leave a note. The compiler hands every parameter decorator `(target, propertyKey, parameterIndex)`, and `parameterIndex` is the only thing that survives to identify *which* argument this is — parameter names are erased along with everything else at compile time. So each decorator records `{ type: 'body' | 'param' | 'query', name? }` at that index, in one map keyed by index, scoped to that specific method (`target` + `propertyKey`) so two different handlers never collide.

At request time, the dispatcher reads that map back out. For each position in the handler's parameter list, it checks the map: a `'param'` entry pulls from the path segments matched by the route pattern, `'query'` from the URL's query string, `'body'` from the parsed request body. It builds a plain array in argument order and calls the handler with `.apply()` — the handler never touches `req` directly. `@Body()`'s DTO class, specifically, is found via `design:paramtypes` at that same index — the same reflection mechanism the container uses for constructor injection, since a parameter typed with a real class still survives to runtime even though an interface wouldn't.

### Validation

A `@Body()` parameter typed with a real DTO class (not an interface) gets validated before the handler ever runs. The dispatcher reads the DTO class off `design:paramtypes`, runs `plainToInstance(DtoClass, parsedBody)`, then `validate(instance)`. Both steps matter: `class-validator` checks decorator metadata attached to the *instance*, keyed by its constructor — handing it the raw parsed JSON object without transforming it first means it's never actually an instance of the DTO class, so nothing meaningful gets checked. An interface-typed (or untyped) `@Body()` parameter has no real class to find on `design:paramtypes`, so `getBodyDtoClass` deliberately returns nothing and validation is skipped entirely — silently, by design, not a bug.

```ts
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  email!: string;
}
```

An invalid body returns `400` with every violation, not just the first:

```json
{ "errors": [{ "field": "email", "constraints": { "isEmail": "email must be an email" } }] }
```

A valid body reaches the handler as a real `CreateUserDto` instance, not a plain object.

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

## Layout

- `src/container.ts` — `Container` class
- `src/decorators/injectable.ts` — `@Injectable()`
- `src/decorators/inject.ts` — `@Inject(token)`
- `src/decorators/controller.ts` — `@Controller(prefix)`
- `src/decorators/methods.ts` — `@Get(path)`, `@Post(path)`
- `src/decorators/params.ts` — `@Body()`, `@Param(name)`, `@Query(name)`
- `src/router.ts` — collects the full route table from every controller's metadata
- `src/dispatcher.ts` — the HTTP layer: matching, argument assembly, dispatch, all on `node:http`
- `src/pipes/validation.pipe.ts` — DTO lookup + `class-validator` validation
- `src/dto/create-user.dto.ts` — example DTO
- `src/tokens.ts` — metadata key symbols
- `src/types.ts` — `DecoratorScope`, `Constructor<T>`, `Token`, `ParamMetadata`
- `test/container.test.ts`, `test/dispatcher.test.ts` — tests
