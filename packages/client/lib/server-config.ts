import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ClientConfig {
  mcp?: {
    serverCwd?: string;
  };
}

interface ServerConfig {
  server?: {
    name?: string;
  };
}

export interface ServerDisplayConfig {
  serverName: string;
}

const DEFAULT_SERVER_NAME = "Moodle MCP Server";

export function readServerDisplayConfig(): ServerDisplayConfig {
  const clientConfigPath = resolve(process.cwd(), "config.json");
  let serverName = DEFAULT_SERVER_NAME;

  if (!existsSync(clientConfigPath)) {
    return { serverName };
  }

  try {
    const clientConfig = JSON.parse(
      readFileSync(clientConfigPath, "utf-8"),
    ) as ClientConfig;

    if (!clientConfig.mcp?.serverCwd) {
      return { serverName };
    }

    const serverConfigPath = resolve(
      process.cwd(),
      clientConfig.mcp.serverCwd,
      "config.json",
    );

    if (!existsSync(serverConfigPath)) {
      return { serverName };
    }

    const serverConfig = JSON.parse(
      readFileSync(serverConfigPath, "utf-8"),
    ) as ServerConfig;

    if (serverConfig.server?.name?.trim()) {
      serverName = serverConfig.server.name.trim();
    }
  } catch {
    // Fall back to the stable display name when config parsing fails.
  }

  return { serverName };
}
