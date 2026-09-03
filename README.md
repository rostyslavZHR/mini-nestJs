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
- `src/tokens.ts` — metadata key symbols (`INJECTABLE_KEY`, `INJECT_TOKENS_KEY`)
- `src/types.ts` — `DecoratorScope`, `Constructor<T>`, `Token`
- `test/container.test.ts` — tests
