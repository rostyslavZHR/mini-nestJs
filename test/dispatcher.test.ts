import "reflect-metadata";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import { Controller } from "../src/decorators/controller";
import { Get, Post } from "../src/decorators/methods";
import { Injectable } from "../src/decorators/injectable";
import { Body, Param, Query } from "../src/decorators/params";
import { UseGuards } from "../src/decorators/use-guards";
import { AuthGuard } from "../src/guards/auth.guard";
import { UseInterceptors } from "../src/decorators/use-interceptors";
import { LoggingInterceptor } from "../src/interceptors/logging.interceptor";
import { RequestLogService } from "../src/services/request-log.service";
import { NotFoundError } from "../src/errors/not-found.error";
import { CreateUserDto, CreateUserSchema } from "../src/dto/create-user.schema";
import type { CanActivate, Interceptor } from "../src/types";
import { createDispatcher } from "../src/dispatcher";

const startServer = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected the server to bind to a network port");
      }
      resolve(address.port);
    });
  });

const stopServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

interface Response {
  status: number;
  body: any;
}

const request = async (port: number, method: string, path: string, payload?: unknown): Promise<Response> => {
  const init: RequestInit = { method };
  if (payload !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(payload);
  }

  const response = await fetch(`http://localhost:${port}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};

test("route matching joins the controller prefix with the method path and finds the right handler", async () => {
  @Injectable()
  @Controller("/api/users")
  class UsersController {
    @Get("")
    findAll() {
      return { handler: "findAll" };
    }

    @Get(":id")
    findOne(@Param("id") id: string) {
      return { handler: "findOne", id };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { status, body } = await request(port, "GET", "/api/users/42");
    assert.equal(status, 200);
    // Asserting the handler name, not just a 200, proves matching picked
    // findOne over findAll rather than just finding *a* route under the prefix.
    assert.equal(body.handler, "findOne");
  } finally {
    await stopServer(server);
  }
});

test("@Param substitutes the matched path segment into the handler argument", async () => {
  @Injectable()
  @Controller("/users")
  class UsersController {
    @Get(":id")
    findOne(@Param("id") id: string) {
      return { id };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { body } = await request(port, "GET", "/users/42");
    assert.equal(body.id, "42");
  } finally {
    await stopServer(server);
  }
});

test("@Query substitutes the query string value into the handler argument", async () => {
  @Injectable()
  @Controller("/users")
  class UsersController {
    @Get("")
    findAll(@Query("limit") limit: string) {
      return { limit };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { body } = await request(port, "GET", "/users?limit=5");
    assert.equal(body.limit, "5");
  } finally {
    await stopServer(server);
  }
});

test("an invalid body returns 400 with details naming the field", async () => {
  @Injectable()
  @Controller("/users")
  class UsersController {
    @Post("")
    create(@Body(CreateUserSchema) body: CreateUserDto) {
      return { name: body.name };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { status, body } = await request(port, "POST", "/users", { email: "not-an-email" });
    assert.equal(status, 400);
    // Zod issues carry a `path` array naming the offending field, not a `field` string.
    const emailIssue = body.errors.find((issue: { path: string[] }) => issue.path.includes("email"));
    assert.ok(emailIssue, "expected a validation issue naming the 'email' field");
  } finally {
    await stopServer(server);
  }
});

test("a valid body reaches the handler as data parsed by the Zod schema, with unknown fields stripped", async () => {
  let receivedBody: unknown;

  @Injectable()
  @Controller("/users")
  class UsersController {
    @Post("")
    create(@Body(CreateUserSchema) body: CreateUserDto) {
      receivedBody = body;
      return { name: body.name };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { status } = await request(port, "POST", "/users", {
      name: "Margaret",
      email: "margaret@example.com",
      isAdmin: true, // not in the schema — should get stripped
    });
    assert.equal(status, 201);
    assert.deepEqual(receivedBody, { name: "Margaret", email: "margaret@example.com" });
  } finally {
    await stopServer(server);
  }
});

test("the controller is resolved through the container — its injected service is the same singleton across requests", async () => {
  @Injectable()
  class UsersService {
    readonly id = Math.random();
  }

  let capturedServiceId: number | undefined;

  @Injectable()
  @Controller("/users")
  class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Get("")
    findAll() {
      capturedServiceId = this.usersService.id;
      return { serviceId: this.usersService.id };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const first = await request(port, "GET", "/users");
    const firstServiceId = capturedServiceId;

    const second = await request(port, "GET", "/users");
    const secondServiceId = capturedServiceId;

    // Two separate requests, same running dispatcher: if the container
    // rebuilt UsersController (and its dependency) from scratch per request
    // instead of resolving through one Container, these would differ.
    assert.equal(first.body.serviceId, second.body.serviceId);
    assert.equal(firstServiceId, secondServiceId);
  } finally {
    await stopServer(server);
  }
});

test("a handler throwing a plain Error is caught and returns a clean 500 with no leaked details", async () => {
  @Injectable()
  @Controller("/boom")
  class BoomController {
    @Get("")
    explode() {
      throw new Error("boom");
    }
  }

  const server = createDispatcher([BoomController]);
  const port = await startServer(server);

  try {
    const { status, body } = await request(port, "GET", "/boom");
    const serialized = JSON.stringify(body);

    assert.equal(status, 500);
    assert.ok(!serialized.includes("boom"), "response body must not leak the error message");
    assert.ok(!serialized.includes("at "), "response body must not leak a stack trace");
  } finally {
    await stopServer(server);
  }
});

test("a handler throwing NotFoundError returns 404 with a message naming what wasn't found", async () => {
  @Injectable()
  @Controller("/users")
  class UsersController {
    @Get(":id")
    findOne(@Param("id") id: string) {
      throw new NotFoundError(`User ${id}`);
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { status, body } = await request(port, "GET", "/users/42");
    assert.equal(status, 404);
    assert.equal(body.error, "User 42 not found");
  } finally {
    await stopServer(server);
  }
});

test("a controller-level guard and a method-level guard on the same route both run", async () => {
  let controllerGuardCalled = false;
  let methodGuardCalled = false;

  @Injectable()
  class ControllerGuard implements CanActivate {
    canActivate() {
      controllerGuardCalled = true;
      return true;
    }
  }

  @Injectable()
  class MethodGuard implements CanActivate {
    canActivate() {
      methodGuardCalled = true;
      return true;
    }
  }

  @Injectable()
  @Controller("/secure")
  @UseGuards(ControllerGuard)
  class SecureController {
    @Get("")
    @UseGuards(MethodGuard)
    findAll() {
      return { ok: true };
    }
  }

  const server = createDispatcher([SecureController]);
  const port = await startServer(server);

  try {
    const { status } = await request(port, "GET", "/secure");
    assert.equal(status, 200);
    assert.equal(controllerGuardCalled, true, "the controller-level guard should still run");
    assert.equal(methodGuardCalled, true, "the method-level guard should run");
  } finally {
    await stopServer(server);
  }
});

test("a controller-level guard rejects even when the route declares no guard of its own", async () => {
  @Injectable()
  class DenyGuard implements CanActivate {
    canActivate() {
      return false;
    }
  }

  @Injectable()
  @Controller("/secure")
  @UseGuards(DenyGuard)
  class SecureController {
    @Get("")
    findAll() {
      return { ok: true };
    }
  }

  const server = createDispatcher([SecureController]);
  const port = await startServer(server);

  try {
    const { status } = await request(port, "GET", "/secure");
    assert.equal(status, 403);
  } finally {
    await stopServer(server);
  }
});

test("a guard that returns false stops the handler from running at all", async () => {
  let handlerCallCount = 0;

  @Injectable()
  class DenyGuard implements CanActivate {
    canActivate() {
      return false;
    }
  }

  @Injectable()
  @Controller("/secure")
  @UseGuards(DenyGuard)
  class SecureController {
    @Get("")
    findAll() {
      handlerCallCount++;
      return { ok: true };
    }
  }

  const server = createDispatcher([SecureController]);
  const port = await startServer(server);

  try {
    const { status } = await request(port, "GET", "/secure");
    assert.equal(status, 403);
    assert.equal(handlerCallCount, 0, "the handler must not run when a guard rejects");
  } finally {
    await stopServer(server);
  }
});

test("AuthGuard rejects a request with no Authorization header, and admits one that has it", async () => {
  let handlerCallCount = 0;

  @Injectable()
  @Controller("/secure")
  @UseGuards(AuthGuard)
  class SecureController {
    @Get("")
    findAll() {
      handlerCallCount++;
      return { ok: true };
    }
  }

  const server = createDispatcher([SecureController]);
  const port = await startServer(server);

  try {
    const denied = await fetch(`http://localhost:${port}/secure`);
    assert.equal(denied.status, 403);
    assert.equal(handlerCallCount, 0);

    const allowed = await fetch(`http://localhost:${port}/secure`, {
      headers: { authorization: "Bearer token" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(handlerCallCount, 1);
  } finally {
    await stopServer(server);
  }
});

test("a controller-level interceptor wraps a method-level interceptor, which wraps the handler", async () => {
  const order: string[] = [];

  @Injectable()
  class OuterInterceptor implements Interceptor {
    async intercept(_context: unknown, next: () => Promise<unknown>) {
      order.push("outer:before");
      const result = await next();
      order.push("outer:after");
      return result;
    }
  }

  @Injectable()
  class InnerInterceptor implements Interceptor {
    async intercept(_context: unknown, next: () => Promise<unknown>) {
      order.push("inner:before");
      const result = await next();
      order.push("inner:after");
      return { ...(result as object), wrapped: true };
    }
  }

  @Injectable()
  @Controller("/wrapped")
  @UseInterceptors(OuterInterceptor)
  class WrappedController {
    @Get("")
    @UseInterceptors(InnerInterceptor)
    findAll() {
      order.push("handler");
      return { ok: true };
    }
  }

  const server = createDispatcher([WrappedController]);
  const port = await startServer(server);

  try {
    const { status, body } = await request(port, "GET", "/wrapped");
    assert.equal(status, 200);
    assert.deepEqual(order, ["outer:before", "inner:before", "handler", "inner:after", "outer:after"]);
    assert.deepEqual(body, { ok: true, wrapped: true });
  } finally {
    await stopServer(server);
  }
});

test("LoggingInterceptor logs method, path, and an elapsed time in the 'N ms' format", async () => {
  @Injectable()
  @Controller("/users")
  @UseInterceptors(LoggingInterceptor)
  class UsersController {
    @Get(":id")
    findOne(@Param("id") id: string) {
      return { id };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };

  try {
    await request(port, "GET", "/users/42");
  } finally {
    console.log = originalLog;
    await stopServer(server);
  }

  // Match by content rather than logs.length === 1, in case a stray log slips in.
  const matching = logs.filter((line) => /^GET \/users\/42 — [0-9]+(\.[0-9]+)? ?ms$/.test(line));
  assert.equal(matching.length, 1, `expected exactly one matching log line, got: ${JSON.stringify(logs)}`);
});

test("an unmatched route returns 404", async () => {
  @Injectable()
  @Controller("/users")
  class UsersController {
    @Get("")
    findAll() {
      return [];
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { status } = await request(port, "GET", "/does-not-exist");
    assert.equal(status, 404);
  } finally {
    await stopServer(server);
  }
});

test("the response carries an X-Request-Id header, generated when the client sends none and echoed when it does", async () => {
  @Injectable()
  @Controller("/ping")
  class PingController {
    @Get("")
    ping() {
      return { ok: true };
    }
  }

  const server = createDispatcher([PingController]);
  const port = await startServer(server);

  try {
    const generated = await fetch(`http://localhost:${port}/ping`);
    const generatedId = generated.headers.get("x-request-id");
    assert.ok(generatedId, "expected an X-Request-Id header to be generated");

    const suppliedId = "client-supplied-id";
    const echoed = await fetch(`http://localhost:${port}/ping`, {
      headers: { "x-request-id": suppliedId },
    });
    assert.equal(echoed.headers.get("x-request-id"), suppliedId);
  } finally {
    await stopServer(server);
  }
});

test("ten parallel requests each see only their own request id — no leaking across concurrent ALS contexts", async () => {
  @Injectable()
  @Controller("/echo-id")
  class EchoIdController {
    constructor(private readonly requestLog: RequestLogService) {}

    @Get("")
    async get() {
      // Random delay so the ten requests actually interleave.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      return { requestId: this.requestLog.logAndGetRequestId("handled") };
    }
  }

  const server = createDispatcher([EchoIdController]);
  const port = await startServer(server);

  try {
    const expectedIds = Array.from({ length: 10 }, (_unused, index) => `req-${index}`);

    // Promise.all preserves input order regardless of completion order.
    const responses = await Promise.all(
      expectedIds.map((id) =>
        fetch(`http://localhost:${port}/echo-id`, { headers: { "x-request-id": id } }).then(
          (response) => response.json(),
        ),
      ),
    );

    assert.deepEqual(
      responses.map((body) => (body as { requestId: string }).requestId),
      expectedIds,
    );
  } finally {
    await stopServer(server);
  }
});
