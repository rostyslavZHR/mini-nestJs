import { ServerResponse } from "node:http";
import { ZodError } from "zod";
import { NotFoundError } from "../errors/not-found.error";
import { HttpError } from "../errors/http.error";
import { sendJson } from "../send-json";
import { getRequestId } from "../context/request-context";

// requestId is stamped on every branch this filter builds the body for
// itself — NotFoundError, ZodError, the catch-all — so a client debugging
// any error has the same correlation id to hand back. HttpError is left
// alone: its body is whatever the thrower constructed, and merging into an
// arbitrary caller-defined shape isn't worth the risk of clobbering a field.
export const exceptionFilter = (error: unknown, response: ServerResponse): void => {
  if (error instanceof NotFoundError) {
    sendJson(response, 404, { error: error.message, requestId: getRequestId() });
    return;
  }

  if (error instanceof ZodError) {
    sendJson(response, 400, { errors: error.issues, requestId: getRequestId() });
    return;
  }

  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, error.body);
    return;
  }

  console.error(error);
  sendJson(response, 500, { error: "Internal Server Error", requestId: getRequestId() });
};
