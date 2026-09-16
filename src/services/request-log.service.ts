import { Injectable } from "../decorators/injectable";
import { getRequestId } from "../context/request-context";

// Reads requestId off the ALS store instead of taking it as a parameter.
@Injectable()
export class RequestLogService {
  logAndGetRequestId(message: string): string {
    const requestId = getRequestId();
    console.log(`[${requestId}] ${message}`);
    return requestId;
  }
}
