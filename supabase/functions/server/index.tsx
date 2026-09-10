import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import * as kv from "./kv_store.tsx";
const app = new Hono();

// Enable logger
app.use('*', logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// Health check endpoint
app.get("/make-server-f263515b/health", (c) => {
  return c.json({ status: "ok" });
});
// 读取 PassMate 数据
app.get("/make-server-f263515b/passmate", async (c) => {
  try {
    const data = await kv.get("passmate:v1");
    return c.json(data ?? {});
  }  catch (error: any) {
    console.error("Error fetching passmate data:", error);
    return c.json({ error: error.message }, 500);
  }
});

// 保存 PassMate 数据
app.put("/make-server-f263515b/passmate", async (c) => {
  try {
    const body = await c.req.json();
    await kv.set("passmate:v1", body);
    return c.json({ success: true });
 } catch (error: any) {
    console.error("Error saving passmate data:", error);
    return c.json({ error: error.message }, 500);
  }
});
Deno.serve(app.fetch);