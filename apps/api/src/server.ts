import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildMimexApi } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const workspaceRoot = process.env.MIMEX_WORKSPACE_ROOT ?? path.resolve(process.cwd(), "data/workspaces");

export const app = buildMimexApi({ workspaceRoot, logger: true });

export async function start(): Promise<void> {
  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void start();
}
