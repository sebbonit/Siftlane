import fs from "node:fs/promises";
import path from "node:path";
import type { Connect, Plugin } from "vite";

async function readFileWithRetry(filePath: string, attempts = 8) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EAGAIN") throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Softens intermittent macOS/iCloud EPERM while Vite serves index.html. */
export function resilientIndexHtml(): Plugin {
  return {
    name: "resilient-index-html",
    configureServer(server) {
      const indexPath = path.join(server.config.root, "index.html");
      const handler: Connect.NextHandleFunction = async (req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url !== "/" && url !== "/index.html") {
          next();
          return;
        }
        try {
          const raw = await readFileWithRetry(indexPath);
          const html = await server.transformIndexHtml(url === "/" ? "/index.html" : url, raw);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        } catch (error) {
          next(error);
        }
      };
      // Register before Vite's built-in index HTML middleware so we can retry
      // transient EPERM/EBUSY from iCloud/Documents instead of surfacing the overlay.
      server.middlewares.use(handler);
    },
  };
}
