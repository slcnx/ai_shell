import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          antd: ["antd", "@ant-design/icons"],
          tauri: ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
          xterm: ["xterm", "xterm-addon-fit"],
          markdown: ["react-markdown", "remark-gfm", "rc-virtual-list"]
        }
      }
    }
  },
  server: {
    port: 1420,
    strictPort: true
  }
});
