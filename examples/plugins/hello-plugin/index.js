export const plugin = {
  manifest: {
    id: "com.example.hello",
    name: "Hello Plugin",
    version: "1.0.0",
    apiVersion: "1",
    description: "Example plugin showing the public runtime contract",
    requiresLicense: false,
    requiredCapabilities: [],
    tools: ["hello_plugin"],
  },
  initialize: (ctx) => {
    ctx.log("info", "hello_plugin initialized");
  },
  shutdown: (ctx) => {
    ctx.log("info", "hello_plugin shutting down");
  },
  tools: [
    {
      name: "hello_plugin",
      description: "Return a simple plugin test payload",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            default: "world",
          },
        },
      },
      createHandler: (ctx) => async (args) => {
        const input = args && typeof args === "object" ? args : {};
        const name = typeof input.name === "string" && input.name.length > 0
          ? input.name
          : "world";

        ctx.log("info", `hello_plugin invoked for ${name}`);

        return {
          ok: true,
          greeting: `Hello, ${name}`,
          server: ctx.config.serverName,
          licensed: ctx.license.status === "valid",
        };
      },
    },
  ],
};

export default plugin;
