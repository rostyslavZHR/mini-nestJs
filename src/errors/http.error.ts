export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${statusCode}`);
    this.name = "HttpError";
  }
}
