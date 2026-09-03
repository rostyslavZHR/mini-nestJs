import "reflect-metadata";
import { Constructor, Token } from "./types";
import { InjectableMetadata } from "./decorators/injectable";
import { INJECT_TOKENS_KEY, INJECTABLE_KEY } from "./tokens";

export class Container {
  private readonly singletons = new Map<Constructor, unknown>();
  private readonly providers = new Map<Token, unknown>();

  register(token: Token, value: unknown): void {
    this.providers.set(token, value);
  }

  resolve<T>(target: Constructor<T>): T {
    return this.resolveWithPath(target, []);
  }

  private resolveWithPath<T>(target: Constructor<T>, path: Constructor[]): T {
    const metadata: InjectableMetadata | undefined = Reflect.getMetadata(
      INJECTABLE_KEY,
      target,
    );

    if (!metadata) {
      throw new Error(`${target.name} is not marked with @Injectable()`);
    }

    if (metadata.scope === "singleton" && this.singletons.has(target)) {
      return this.singletons.get(target) as T;
    }

    if (path.includes(target)) {
      const chain = [...path, target].map((ctor) => ctor.name).join(" -> ");
      throw new Error(`Circular dependency detected: ${chain}`);
    }

    const nextPath = [...path, target];

    const paramTypes: Constructor[] =
      Reflect.getMetadata("design:paramtypes", target) ?? [];
    const injectTokens: Map<number, Token> =
      Reflect.getMetadata(INJECT_TOKENS_KEY, target) ?? new Map();

    const dependencies = paramTypes.map((paramType, index) => {
      const token = injectTokens.get(index);
      if (token !== undefined) {
        return this.resolveToken(token);
      }
      return this.resolveWithPath(paramType, nextPath);
    });

    const instance = new target(...dependencies);

    if (metadata.scope === "singleton") {
      this.singletons.set(target, instance);
    }

    return instance;
  }

  private resolveToken(token: Token): unknown {
    if (!this.providers.has(token)) {
      throw new Error(`No provider registered for token ${String(token)}`);
    }
    return this.providers.get(token);
  }
}
