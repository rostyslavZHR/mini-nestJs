import { Injectable } from "../decorators/injectable";
import { CanActivate, ExecutionContext } from "../types";

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return Boolean(context.req.headers.authorization);
  }
}
