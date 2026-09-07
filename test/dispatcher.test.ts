import "reflect-metadata";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import { Controller } from "../src/decorators/controller";
import { Get, Post } from "../src/decorators/methods";
import { Injectable } from "../src/decorators/injectable";
import { Body, Param, Query } from "../src/decorators/params";
import { CreateUserDto } from "../src/dto/create-user.dto";
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
    create(@Body() body: CreateUserDto) {
      return { name: body.name };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { status, body } = await request(port, "POST", "/users", { email: "not-an-email" });
    assert.equal(status, 400);
    const emailError = body.errors.find((error: { field: string }) => error.field === "email");
    assert.ok(emailError, "expected a validation error naming the 'email' field");
  } finally {
    await stopServer(server);
  }
});

test("a valid body reaches the handler as a real DTO instance, not a plain object", async () => {
  let receivedIsInstance = false;

  @Injectable()
  @Controller("/users")
  class UsersController {
    @Post("")
    create(@Body() body: CreateUserDto) {
      receivedIsInstance = body instanceof CreateUserDto;
      return { name: body.name };
    }
  }

  const server = createDispatcher([UsersController]);
  const port = await startServer(server);

  try {
    const { status } = await request(port, "POST", "/users", {
      name: "Margaret",
      email: "margaret@example.com",
    });
    assert.equal(status, 201);
    assert.equal(receivedIsInstance, true);
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
