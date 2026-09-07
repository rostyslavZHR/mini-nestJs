import { CONTROLLER_KEY, ROUTE_KEY } from "./tokens";
import { Constructor } from "./types";

export interface Route {
  controller: Constructor;
  property: string;
  method: string;
  path: string;
}

// Uses getOwnMetadata, not Reflect.getMetadata — the "own" variant doesn't
// walk the prototype chain, so a subclass can't silently inherit its
// parent's @Controller()/@Get()/@Post() metadata as its own routes.
const collectRoutes = (controller: Constructor): Route[] => {
  const prefix = Reflect.getOwnMetadata(CONTROLLER_KEY, controller);
  const proto = controller.prototype;

  const propertyNames = Object.getOwnPropertyNames(proto).filter(
    (propertyName: string) => propertyName !== "constructor",
  );

  const routes: Route[] = [];
  for (const propertyName of propertyNames) {
    const routeMetadata = Reflect.getOwnMetadata(ROUTE_KEY, proto, propertyName);
    if (!routeMetadata) continue; // not every method is a route handler

    const path = [prefix, routeMetadata.path].filter((segment) => !!segment).join("/");
    routes.push({ controller, property: propertyName, method: routeMetadata.method, path });
  }

  return routes;
};

export const router = (controllers: Constructor[]): Route[] =>
  controllers.flatMap(collectRoutes);
