# CLIProxyAPI TypeScript

Minimal TypeScript port of `CLIProxyAPI`, limited to ChatGPT/Codex.

## Scope

Supported:

- `GET /v1/models`
- `GET /v1/responses` websocket transport with `response.create` / `response.append`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `GET /v0/management/auth-files`
- `GET /v0/management/auth-files/models`
- `GET /v0/management/auth-files/download`
- `POST /v0/management/auth-files`
- `DELETE /v0/management/auth-files`
- `PATCH /v0/management/auth-files/status`
- `PATCH /v0/management/auth-files/fields`
- `GET /v0/management/codex-auth-url`
- `POST /v0/management/oauth-callback`
- `GET /v0/management/get-auth-status`
- `codex-api-key` config entries
- optional Codex auth JSON files from `auth-dir`
- `codex-login` OAuth command
- `codex-device-login` device-flow command

Not supported:

- Gemini, Claude, Qwen, Vertex, Amp, and the Go management UI
- the Go server's full watcher/reload/runtime-auth feature set
- multipart auth-file uploads

## Run

```bash
npm install
npm run build
node dist/index.js --config ./config.yaml
```

The server can now start with an empty `auth-dir`, so you can create the first Codex credential through the management API.

During development:

```bash
npm run dev -- --config ./config.yaml
```

Codex OAuth login:

```bash
node dist/index.js codex-login --config ./config.yaml
```

Codex device login:

```bash
node dist/index.js codex-device-login --config ./config.yaml
```

Add `--no-browser` if you want to open the URL manually.

## Config

Use `config.example.yaml` as the starting point. Only `codex-api-key` is supported in config.

`auth-dir` is optional. If present, the server reads JSON auth files with `provider: codex` and uses either:

- `attributes.api_key`
- `metadata.access_token`

It also reads real Go-style Codex token files with top-level `type: "codex"`, `access_token`, `refresh_token`, `id_token`, and `expired`, and refreshes those OAuth tokens automatically before expiry.

Management auth-file and OAuth routes require `auth-dir`.
