import "reflect-metadata";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Container } from "../src/container";
import { Injectable } from "../src/decorators/injectable";
import { Inject } from "../src/decorators/inject";

const CONFIG = Symbol.for("CONFIG");

test("resolves a graph recursively: A -> B -> C", () => {
  @Injectable()
  class C {
    readonly name = "C";
  }

  @Injectable()
  class B {
    constructor(public c: C) {}
  }

  @Injectable()
  class A {
    constructor(public b: B) {}
  }

  const container = new Container();
  const a = container.resolve(A);

  assert.ok(a instanceof A);
  assert.ok(a.b instanceof B);
  assert.ok(a.b.c instanceof C);
  assert.equal(a.b.c.name, "C");
});

test("singleton scope returns the same instance", () => {
  @Injectable()
  class Service {}

  const container = new Container();
  assert.equal(container.resolve(Service), container.resolve(Service));
});

test("transient scope returns a new instance each time", () => {
  @Injectable({ scope: "transient" })
  class Service {}

  const container = new Container();
  assert.notEqual(container.resolve(Service), container.resolve(Service));
});

test("@Inject(token) resolves a registered provider instead of the type", () => {
  interface Config {
    port: number;
  }

  @Injectable()
  class Server {
    constructor(@Inject(CONFIG) public config: Config) {}
  }

  const container = new Container();
  container.register(CONFIG, { port: 3000 });

  const server = container.resolve(Server);
  assert.equal(server.config.port, 3000);
});

test("circular dependency throws a chain error, not a RangeError", () => {
  // wired manually — A and B typing each other directly hits a TDZ error
  // on class declaration, so the metadata is set once both classes exist
  @Injectable()
  class A {}

  @Injectable()
  class B {}

  Reflect.defineMetadata("design:paramtypes", [B], A);
  Reflect.defineMetadata("design:paramtypes", [A], B);

  const container = new Container();
  assert.throws(
    () => container.resolve(A),
    (error: unknown) => {
      if (!(error instanceof Error) || error instanceof RangeError) {
        return false;
      }
      assert.match(error.message, /A -> B -> A/);
      return true;
    },
  );
});

test("resolving a class without @Injectable() throws", () => {
  class Plain {}

  const container = new Container();
  assert.throws(() => container.resolve(Plain), /Plain is not marked with @Injectable/);
});
