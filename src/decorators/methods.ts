import "reflect-metadata";
import { ROUTE_KEY } from "../tokens";
import { METHOD_DECORATOR_KEYS } from "../constants";

export const Get =
  (path = ""): MethodDecorator =>
  (
    target: Object,
    propertyKey: string | symbol,
    _descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(
      ROUTE_KEY,
      { method: METHOD_DECORATOR_KEYS.GET, path },
      target,
      propertyKey
    );
  };

export const Post =
  (path = ""): MethodDecorator =>
  (
    target: Object,
    propertyKey: string | symbol,
    _descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(
      ROUTE_KEY,
      { method: METHOD_DECORATOR_KEYS.POST, path },
      target,
      propertyKey
    );
  };
