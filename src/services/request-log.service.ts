import { Injectable } from "../decorators/injectable";
import { getRequestId } from "../context/request-context";

// Reads the request id off the ALS store instead of taking it as a
// parameter — proves the id propagates through the call stack (dispatcher
// -> controller -> here) on its own, without every layer in between having
// to thread it through.
@Injectable()
export class RequestLogService {
  logAndGetRequestId(message: string): string {
    const requestId = getRequestId();
    console.log(`[${requestId}] ${message}`);
    return requestId;
  }
}
