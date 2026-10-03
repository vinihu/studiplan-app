/// <reference types="vite/client" />
import type { StudiplanApi } from "@shared/ipc";

declare global {
  interface Window {
    /** The typed bridge to the main process, exposed by the preload script. */
    readonly studiplan: StudiplanApi;
  }
}
