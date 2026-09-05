import "reflect-metadata";
import { CONTROLLER_KEY } from "../tokens";

export const Controller =
  (prefix: string): ClassDecorator =>
  (constructor: Function) => {
    Reflect.defineMetadata(CONTROLLER_KEY, prefix, constructor);
  };
