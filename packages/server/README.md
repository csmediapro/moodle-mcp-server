# @csmediapro/moodle-mcp-server

Open-source MCP server for querying Moodle LMS data through Moodle Web Services.

This package provides the stdio MCP server from the `moodle-mcp-server` repository.

Project page: https://csmediapro.com/products/moodle-mcp-server

## Install From Source

```bash
git clone https://github.com/csmediapro/moodle-mcp-server
cd moodle-mcp-server
npm install
npm run server:build
```

## Configure

```bash
cp packages/server/.env.example packages/server/.env
cp packages/server/config.example.json packages/server/config.json
```

Set:

```bash
MOODLE_URL=https://your-moodle-instance.example
MOODLE_TOKEN=your-moodle-web-services-token
```

## Run

```bash
node packages/server/dist/index.js
```

Most users launch the server through an MCP client such as Claude Desktop.

## Claude Desktop Example

```json
{
  "mcpServers": {
    "moodle-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/moodle-mcp-server/packages/server/dist/index.js"],
      "env": {
        "MOODLE_URL": "https://your-moodle-instance.example",
        "MOODLE_TOKEN": "your-moodle-web-services-token"
      }
    }
  }
}
```

## License

AGPL-3.0.

Moodle is a trademark of Moodle Pty Ltd. This project is not affiliated with, endorsed by, or sponsored by Moodle Pty Ltd.
