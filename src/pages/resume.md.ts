import type { APIRoute } from "astro";
import { toMarkdown } from "@/utils/resume";

export const GET: APIRoute = () =>
  new Response(toMarkdown(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
