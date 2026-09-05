/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { resolveGatewaySecret } from "./gateway-secret.mjs";

interface Env {
  ASSETS: Fetcher;
  NURSERY_GATEWAY_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const GATEWAY_SECRET_HEADER = "x-nursery-gateway-secret";
const GATEWAY_PROTECTED_PATHS = new Set([
  "/account/password",
  "/admin/accounts",
  "/admin/schedules",
  "/parent/account",
  "/parent/schedule",
  "/staff/preferences",
]);

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env | undefined, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (GATEWAY_PROTECTED_PATHS.has(url.pathname)) {
      const expectedSecret = resolveGatewaySecret(env);
      const receivedSecret = request.headers.get(GATEWAY_SECRET_HEADER);
      if (!expectedSecret || receivedSecret !== expectedSecret) {
        return new Response("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    if (url.pathname === "/_vinext/image") {
      if (!env?.ASSETS || !env?.IMAGES) return new Response("Not Found", { status: 404 });
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
