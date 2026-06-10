# Hello Plugin

Minimal standalone plugin package for `moodle-mcp-server`.

It demonstrates the public runtime contract without importing private server internals. The package is already plain ESM JavaScript, so it can be loaded directly by the core.

Example config:

```json
{
  "plugins": {
    "searchPaths": [
      {
        "path": "./examples/plugins/hello-plugin"
      }
    ]
  }
}
```

After restart, the core should expose the `hello_plugin` tool.
