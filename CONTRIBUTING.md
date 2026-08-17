# Contributing

Thanks for helping improve `moodle-mcp-server`.

## Development Setup

```bash
git clone https://github.com/csmediapro/moodle-mcp-server
cd moodle-mcp-server
npm install
```

Create local config files from examples:

```bash
cp packages/server/.env.example packages/server/.env
cp packages/server/config.example.json packages/server/config.json
cp packages/client/.env.example packages/client/.env
cp packages/client/config.example.json packages/client/config.json
```

Do not commit real Moodle URLs, tokens, logs, cache files, generated schemas, or local client config.

## Validation

Run these before opening a pull request:

```bash
npm run server:test
npm run client:build
npm pack --dry-run -w packages/server
```

Check the dry-run package output for accidental data, logs, configs, or local build artifacts.

## Pull Request Style

- Keep changes focused.
- Add or update tests for behavior changes.
- Update README/docs when changing setup, tools, config, or plugin behavior.
- Preserve the stdio-only boundary for the open-source core.

## Plugin Contributions

Plugins should use the public contract documented in:

- `docs/plugins/CONTRACT.md`
- `docs/plugins/CREATING-PLUGINS.md`

Do not import private core internals from plugin code.
