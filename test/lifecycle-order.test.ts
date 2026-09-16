import "reflect-metadata";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { Server } from "node:http";
import { Controller } from "../src/decorators/controller";
import { Get } from "../src/decorators/methods";
import { Injectable } from "../src/decorators/injectable";
import { createDispatcher } from "../src/dispatcher";
import { lifecycleLog, resetLifecycleLog } from "../src/lifecycle-log";

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

test("a request walks the full lifecycle in order", async () => {
  @Injectable()
  @Controller("/ping")
  class PingController {
    @Get("")
    ping() {
      return { ok: true };
    }
  }

  resetLifecycleLog();

  const server = createDispatcher([PingController]);
  const port = await startServer(server);

  try {
    await fetch(`http://localhost:${port}/ping`);

    assert.deepEqual(lifecycleLog, [
      "middleware",
      "guard",
      "interceptor:before",
      "pipe",
      "handler",
      "interceptor:after",
    ]);
  } finally {
    await stopServer(server);
  }
});
