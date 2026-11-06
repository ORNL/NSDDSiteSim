# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues, discussions, or pull requests.

Report suspected vulnerabilities privately via [GitHub Private Vulnerability Reporting](https://github.com/ORNL/NSDDSiteSim/security/advisories/new) or contact the repository maintainer `@tyronechrisharris` directly.

## Deployment Scope & Hygiene

- `NSDDSiteSim` emulates unauthenticated TCP/RTSP radiation portal monitor, mobile detector, and camera endpoints for isolated test networks only. Bind published ports only to trusted test-LAN interfaces and never expose simulator ports to the public internet.
- Never commit `.env` files, credentials, private keys, or internal host/IP inventory details.
