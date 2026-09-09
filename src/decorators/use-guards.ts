import "reflect-metadata";
import { GUARD_METADATA_KEY } from "../tokens";
import { CanActivate, Constructor } from "../types";

// Works on a controller class or a single route method — the dispatcher
// merges both when it resolves a route's guards, so scoping to the whole
// controller or to one handler are both just "attach metadata here".
export const UseGuards =
  (...guards: Constructor<CanActivate>[]): ClassDecorator & MethodDecorator =>
  ((target: Object, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      Reflect.defineMetadata(GUARD_METADATA_KEY, guards, target);
    } else {
      Reflect.defineMetadata(GUARD_METADATA_KEY, guards, target, propertyKey);
    }
  }) as ClassDecorator & MethodDecorator;
