import "reflect-metadata";
import { DecoratorScope } from "../types";
import { INJECTABLE_KEY } from "../tokens";

interface InjectableProps {
  scope?: DecoratorScope;
}

export interface InjectableMetadata {
  injectable: true;
  scope: DecoratorScope;
}

export const Injectable =
  (
    { scope = "singleton" }: InjectableProps = {},
  ): ClassDecorator =>
  (constructor: Function) => {
    Reflect.defineMetadata(
      INJECTABLE_KEY,
      { injectable: true, scope },
      constructor,
    );
  };
