/**
 * 极简路由：只支持 /a/:param/b 这种形态，足够本项目的 RESTful 端点。
 * 不引 express 是为了保持「npm install 都不用跑」的零依赖体验。
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({
      method,
      pattern,
      segments: pattern.split('/').filter(Boolean),
      handler
    });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /** @returns {{handler:Function, params:object, pattern:string}|null} */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let hit = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { hit = false; break; }
      }
      if (hit) return { handler: route.handler, params, pattern: route.pattern };
    }
    return null;
  }

  list() {
    return this.routes.map(r => `${r.method} ${r.pattern}`);
  }
}
