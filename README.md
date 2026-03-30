# CodexProxy

Minimal Codex-only proxy and management server for ChatGPT/Codex. It started as a TypeScript port of `CLIProxyAPI`, but this repo is intentionally scoped to Codex only.

## Scope

Supported:

- `GET /v1/models`
- `POST /v1/completions`
- `GET /v1/responses` websocket transport with `response.create` / `response.append`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `GET /management.html`
- `GET /v0/management/config`
- `GET /v0/management/config.yaml`
- `PUT/PATCH /v0/management/config.yaml`
- `GET /v0/management/latest-version`
- `GET/PUT/PATCH /v0/management/debug`
- `GET/PUT/PATCH /v0/management/request-log`
- `GET/PUT/PATCH /v0/management/request-retry`
- `GET/PUT/PATCH/DELETE /v0/management/proxy-url`
- `GET /v0/management/usage`
- `GET /v0/management/usage/export`
- `POST /v0/management/usage/import`
- `GET/DELETE /v0/management/logs`
- `GET /v0/management/request-log-by-id/:id`
- `GET/PUT/PATCH /v0/management/quota-exceeded/switch-project`
- `GET/PUT/PATCH /v0/management/quota-exceeded/switch-preview-model`
- `GET/PUT/PATCH/DELETE /v0/management/codex-api-key`
- `GET/PUT/PATCH/DELETE /v0/management/oauth-excluded-models`
- `GET/PUT/PATCH/DELETE /v0/management/oauth-model-alias`
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
- config/auth-dir file watchers for live reload

Not supported:

- Gemini, Claude, Qwen, Vertex, Amp, and any non-Codex provider runtime
- the original Go server's broader multi-provider module ecosystem and provider-specific management routes
- multipart auth-file uploads
- native upstream Codex websocket/session transport parity; the TS websocket route is still a downstream bridge

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

## Management

The management API is Codex-only and local-first.

- If `management-key` is empty, localhost requests are allowed without a key.
- If `management-key` is set, send it as `x-management-key` or `Authorization: Bearer ...`.
- Remote management requests are blocked unless `allow-remote-management: true`.

Minimal examples:

```bash
curl http://127.0.0.1:8317/v0/management/config
curl http://127.0.0.1:8317/v0/management/codex-auth-url
curl http://127.0.0.1:8317/v0/management/auth-files
curl http://127.0.0.1:8317/v0/management/logs
```

## Config

Use `config.example.yaml` as the starting point. CodexProxy supports Codex-focused runtime fields such as `management-key`, `proxy-url`, `request-retry`, `oauth-excluded-models`, `oauth-model-alias`, and `codex-api-key`.

`auth-dir` is optional. If present, the server reads JSON auth files with `provider: codex` and uses either:

- `attributes.api_key`
- `metadata.access_token`

It also reads real Go-style Codex token files with top-level `type: "codex"`, `access_token`, `refresh_token`, `id_token`, and `expired`, and refreshes those OAuth tokens automatically before expiry.

Management auth-file and OAuth routes require `auth-dir`.

CodexProxy watches:

- the config file for live runtime reload
- `auth-dir` for JSON auth-file changes
