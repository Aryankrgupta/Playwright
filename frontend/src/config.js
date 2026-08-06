// Base origin of the Wayfinder backend API. Overridable at build time via the
// VITE_API_BASE env var; defaults to the local dev backend.
export const API_BASE =
  import.meta.env.VITE_API_BASE || "http://localhost:3000";
