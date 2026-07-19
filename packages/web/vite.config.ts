import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const apiPort = Number(process.env.API_PORT || process.env.PORT || 8787);
  const uiPort = Number(process.env.VITE_PORT || 5173);
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react()],
    server: {
      port: uiPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("error", (err, _req, res) => {
              console.error("[vite proxy /api]", err.message);
              if (res && "writeHead" in res && typeof res.writeHead === "function") {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: `API server is not running on :${apiPort}. Start the matching stand/server first.`,
                  }),
                );
              }
            });
          },
        },
        "/ws": {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on("error", (err) => {
              console.error("[vite proxy /ws]", err.message);
            });
          },
        },
      },
    },
  };
});
