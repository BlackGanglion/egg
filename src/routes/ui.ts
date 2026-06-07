import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

export function registerUiRoutes(app: Hono): void {
  app.use("/assets/*", serveStatic({ root: "./src/web/dist" }));
  const spaEntry = serveStatic({ root: "./src/web/dist", path: "index.html" });
  app.get("/", spaEntry);
  app.get("/chat", spaEntry);
  app.get("/admin", spaEntry);
}
