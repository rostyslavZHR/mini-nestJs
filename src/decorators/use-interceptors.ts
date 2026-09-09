import "reflect-metadata";
import { INTERCEPTOR_METADATA_KEY } from "../tokens";
import { Constructor, Interceptor } from "../types";

// Works on a controller class or a single route method — the dispatcher
// merges both when it resolves a route's interceptors, so scoping to the
// whole controller or to one handler are both just "attach metadata here".
export const UseInterceptors =
  (...interceptors: Constructor<Interceptor>[]): ClassDecorator & MethodDecorator =>
  ((target: Object, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      Reflect.defineMetadata(INTERCEPTOR_METADATA_KEY, interceptors, target);
    } else {
      Reflect.defineMetadata(INTERCEPTOR_METADATA_KEY, interceptors, target, propertyKey);
    }
  }) as ClassDecorator & MethodDecorator;
