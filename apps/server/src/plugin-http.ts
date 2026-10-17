import type {
  HttpRouteOptions,
  HttpRouteService,
  PluginHttpHandler,
} from "@kestrel/protocol";

export interface RegisteredPluginRoute {
  method: string;
  path: string;
  segments: string[];
  public: boolean;
  handler: PluginHttpHandler;
}

export interface PluginRouteMatch {
  route: RegisteredPluginRoute;
  params: Record<string, string>;
}

/**
 * Registration table for plugin-contributed HTTP routes. Matching is exact per
 * segment; `:name` captures one segment. First registration wins, so a plugin
 * cannot shadow a route that was registered before it.
 */
export class PluginHttpRouter implements HttpRouteService {
  private readonly routes: RegisteredPluginRoute[] = [];

  route(options: HttpRouteOptions): () => void {
    const method = options.method.toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new Error(`Invalid HTTP method "${options.method}".`);
    if (!options.path.startsWith("/api/")) {
      throw new Error(`Plugin route "${options.path}" must start with "/api/".`);
    }
    if (!options.handler) throw new Error(`Plugin route "${options.path}" needs a handler.`);
    if (this.routes.some((route) => route.method === method && route.path === options.path)) {
      throw new Error(`Plugin route ${method} ${options.path} is already registered.`);
    }
    const route: RegisteredPluginRoute = {
      method,
      path: options.path,
      segments: splitPath(options.path),
      public: options.public === true,
      handler: options.handler,
    };
    this.routes.push(route);
    return () => {
      const index = this.routes.indexOf(route);
      if (index >= 0) this.routes.splice(index, 1);
    };
  }

  match(method: string, pathname: string): PluginRouteMatch | undefined {
    const incoming = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const params = matchSegments(route.segments, incoming);
      if (params) return { route, params };
    }
    return undefined;
  }

  list(): RegisteredPluginRoute[] {
    return [...this.routes];
  }
}

function splitPath(path: string): string[] {
  return path.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
}

function matchSegments(pattern: string[], incoming: string[]): Record<string, string> | undefined {
  if (pattern.length !== incoming.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const actual = incoming[index];
    if (expected.startsWith(":")) {
      if (!actual) return undefined;
      params[expected.slice(1)] = actual;
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

declare module "@kestrel/kernel" {
  interface ServiceMap {
    "http.routes": HttpRouteService;
  }
}
