# Security Policy

## Supported Versions

The project is pre-1.0. Security fixes are made on the default branch until stable release branches exist.

## Reporting A Vulnerability

Please do not open a public GitHub issue for suspected vulnerabilities or accidental data exposure.

Email: contact@csmediapro.com

Include:

- affected version or commit
- a concise description of the issue
- reproduction steps when safe to share
- any logs with secrets, tokens, personal data, and customer data removed

We will acknowledge the report and coordinate a fix before public disclosure when appropriate.

## Deployment Notes

- Use a dedicated Moodle Web Services token for this server.
- Grant only the Moodle functions needed for your use case.
- Treat Moodle responses as sensitive operational data.
- Do not commit `.env`, `config.json`, cache files, logs, or generated site schema files.
- Review package contents with `npm pack --dry-run -w packages/server` before publishing or distributing.
