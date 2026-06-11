# Codex Fix Design for `mcp-remote`

## Why This Exists

This document records the implemented Codex-focused OAuth fix for `mcp-remote`.

The fix addresses two problems:

1. Codex-managed `mcp-remote` instances could trigger repeated browser launches during OAuth.
2. Jira and Confluence are hosted on separate Atlassian cloud tenants, so authentication state must stay isolated per resource.

The implemented fix keeps the normal OAuth 2.1 browser flow, but changes how auth is coordinated and how callbacks are resolved.

## What Changed

The proxy path still supports the original single-process OAuth flow.

If `--callback-port` is not provided:

- the proxy starts its own callback server
- the proxy opens the browser
- the same process handles the callback and token exchange

The fix adds an optional fixed-callback mode for Codex-driven use cases.

If `--callback-port` is provided:

- the callback port becomes fixed instead of random
- a listener-only process can handle callback processing and token exchange
- browser-open suppression uses the auth lock to prevent repeated browser launches for the same resource

Across both modes, the proxy now uses:

- an auth lock file as the active auth coordination record
- OAuth `state` in the format `<uuid>:<serverUrlHash>`
- resource-specific client display names on the Atlassian consent screen

This applies to the `proxy.ts` path, which is the path used by Codex.

The old coordination module still exists in the repo, but it is marked deprecated and is not the active model for the proxy path.

## Main Options

### `--callback-port <port>`

Use a fixed localhost callback port for OAuth.

Effect:

- callback host remains `127.0.0.1` or the configured host
- callback path remains `/oauth/callback`
- callback port becomes fixed instead of automatically selected
- in normal fixed-port mode, the initiating proxy does not bind the callback port

Example:

- `http://127.0.0.1:3736/oauth/callback`

### `--listen-only`

Start only the callback listener and token-exchange handling on the configured callback port.

Effect:

- bind `127.0.0.1:<port>`
- handle OAuth callback requests
- process token exchange
- do not initiate a new authorization request
- do not open the browser

## How It Works

### Normal proxy mode

Normal proxy mode is used by the Codex-managed MCP instance.

It runs with:

- `--resource <tenant-url>`
- `--send-resource` when the OAuth server expects an OAuth `resource` parameter
- `--callback-port <port>`

Behavior:

1. compute `serverUrlHash` using server URL, resource, and headers
2. check whether a fresh auth lock already exists
3. if no valid lock exists:
   - generate OAuth `state` as `<uuid>:<serverUrlHash>`
   - generate PKCE `codeVerifier`
   - write or update the auth lock
   - log a warning that a listener must be running on the callback port
   - open the browser once
4. if a valid lock exists:
   - do not open another browser
   - wait for tokens to appear on disk

In fixed callback mode, the normal proxy does not bind the callback port.

### Listener-only mode

Listener-only mode is used by a separately launched process.

It runs with:

- `--callback-port <port>`
- `--listen-only`

Behavior:

1. bind the callback port
2. wait for browser callback requests
3. parse `state` as `<uuid>:<serverUrlHash>`
4. load the auth lock for that `serverUrlHash`
5. validate that the callback and auth lock match
6. complete token exchange using the stored PKCE verifier and the originating MCP server URL from the auth lock
7. write tokens into the correct auth files
8. remove the auth lock after callback processing completes, whether success or failure

A single listener-only instance can serve callbacks for multiple MCP server URLs and resources because callback routing is state-based and the auth lock stores the originating MCP server URL.

## Key Data

### Resource isolation

Auth state is isolated by `serverUrlHash`, which already includes:

- server URL
- `--resource`
- custom headers

That existing mechanism is reused. The fix does not add a second resource-isolation model.

`--resource` is a local discriminator by default. It affects hash isolation, auth lock lookup, and the registered OAuth client display name. It is sent to the OAuth authorization endpoint only when `--send-resource` is also supplied.

`--send-resource` also controls RFC 8707 resource indicators selected by the MCP SDK from protected-resource metadata. Without `--send-resource`, the provider suppresses SDK-selected resource indicators so OAuth servers that reject `resource` can still use the same local `--resource` discriminator.

### OAuth `state`

The implemented `state` format is:

- `<uuid>:<serverUrlHash>`

Example:

- `60effb6e-25c7-4b9a-93c5-cdb8c431bb46:d95d9d98355a8c0ecccb0da89d0d20ab`

Why:

- the UUID preserves randomness and uniqueness
- `serverUrlHash` makes callback routing deterministic
- no secrets or PKCE material are embedded in `state`

### Auth lock file

The auth lock file is the single active source of truth for in-progress auth coordination.

There is one active auth lock per `serverUrlHash`.

The auth lock contains:

- `state`
- `serverUrlHash`
- `serverUrl`
- `resource`
- `codeVerifier`
- `timestamp`
- `status`
- optional `pid`
- optional `authorizationUrl`
- optional `port`

`resource` is stored because `serverUrlHash` is operational but opaque. The resource makes the lock file readable in logs and debugging.

`serverUrl` is stored because listener-only mode may be running under a different command line from the proxy that opened the browser. The listener uses the stored MCP server URL when exchanging the authorization code, so a shared callback listener can process callbacks for different MCP servers such as Atlassian and Lucid.

### PKCE verifier storage

The auth lock is the active PKCE source of truth.

The proxy path no longer relies on `code_verifier.txt` as the active verifier storage location.

## Rules

### Browser-open suppression

Before opening the browser in normal fixed-port mode:

1. compute `serverUrlHash`
2. check for an existing auth lock for that hash
3. if a valid lock exists, do not open another browser
4. if no valid lock exists, write the auth lock and open the browser once

This is the core browser-storm fix.

### Stale lock handling

An auth lock is stale if it is older than 10 minutes.

If a lock is stale:

- log a stale-lock warning
- treat it as non-existent
- overwrite it with a new auth lock
- continue normal auth flow

The listener removes the auth lock after callback processing completes, whether success or failure.

### Callback validation

Listener-side token exchange only proceeds if all of the following are true:

1. auth lock exists for the parsed `serverUrlHash`
2. auth lock `serverUrlHash` matches the parsed `serverUrlHash`
3. auth lock full `state` exactly matches callback `state`
4. auth lock `resource` is present
5. auth lock is not stale

If any validation fails:

- write error log
- refuse token exchange
- do not write tokens

### Token wait behavior

When a normal proxy detects that auth is already in progress, it waits for tokens to appear on disk instead of opening another browser.

Current implementation:

- shared token wait timeout: 10 minutes
- shared token poll interval: 3 seconds

### Port conflict behavior

If `--listen-only` cannot bind the configured callback port:

- log a clear error
- fail hard
- do not fall back to a random port

No random-port fallback is used in fixed callback mode because it would break the shared understanding between the normal proxy and the listener.

## Consent Screen Label

The proxy path derives a more specific OAuth client display name from `--resource`.

Examples:

- `MCP CLI Proxy (tenancy1.atlassian.net)`
- `MCP CLI Proxy (tenancy2.atlassian.net)`

This makes it easier to distinguish Jira vs Confluence consent flows on the Atlassian consent screen.

This display label is sent through OAuth dynamic client registration as `client_name`. It does not require sending the OAuth authorization request `resource` parameter.

Important note:

- if client registration already exists for a resource hash, Atlassian may continue showing the previously registered name until that resource's `*_client_info.json` is removed and the client is re-registered.

## Logging

The patched build identifies itself at startup:

- `Starting mcp-remote proxy <package-version> (local patched build)`

Debug logging was also reduced so normal shared-auth waits no longer flood logs with repeated no-token stack-trace noise.

## Build And Install It Locally

### Build the package

From the `mcp-remote` repo root:

```bash
cd ~/workspaces/atlassian/mcp-remote
npm run build
```

### Recommended local install

If this needs to work without depending on the current project folder, install it into `~/.mcp-auth`.

Run:

```bash
npm run install:fix
```

This script:

- builds the package
- creates the tarball
- copies the versioned tarball into `~/.mcp-auth`

Then run it with `npx`:

```bash
npx --yes --package /Users/<your-username>/.mcp-auth/mcp-remote-<package-version>.tgz mcp-remote https://mcp.atlassian.com/v1/mcp --callback-port 3736 --listen-only
```

This keeps the package in a stable home-relative location and preserves the `npx --package ...` execution model.

### Run it without installing to `~/.mcp-auth`

Yes. You can run the packaged tarball directly without installing it there.

Preferred form:

```bash
npm exec --yes --package=mcp-remote-<package-version>.tgz -- \
  mcp-remote https://mcp.atlassian.com/v1/mcp --callback-port 3736 --listen-only
```

Equivalent `npx` form:

```bash
npx --yes --package /Users/<your-username>/workspaces/atlassian/mcp-remote/mcp-remote-<package-version>.tgz \
  mcp-remote https://mcp.atlassian.com/v1/mcp --callback-port 3736 --listen-only
```

This is useful if you want the current `npx`-style experience without installing into `~/.mcp-auth`.

## Operator Quick Start

Use this when setting up or revisiting the local patched build.

### Install or update the local copy

```bash
cd ~/workspaces/atlassian/mcp-remote
npm run install:fix
```

### Start the shared listener

```bash
npx --yes --package ~/.mcp-auth/mcp-remote-<package-version>.tgz mcp-remote https://mcp.atlassian.com/v1/mcp --callback-port 3736 --listen-only --debug
```

### Start tenancy 1

```bash
npx --yes --package ~/.mcp-auth/mcp-remote-<package-version>.tgz mcp-remote https://mcp.atlassian.com/v1/mcp --resource https://tenancy1.atlassian.net/ --send-resource --callback-port 3736 --debug
```

### Start tenancy 2

```bash
npx --yes --package ~/.mcp-auth/mcp-remote-<package-version>.tgz mcp-remote https://mcp.atlassian.com/v1/mcp --resource https://tenancy2.atlassian.net/ --send-resource --callback-port 3736 --debug
```

### When the consent screen label does not update

Delete the existing client registration file for that resource hash and re-authenticate.

Relevant file pattern:

```bash
~/.mcp-auth/mcp-remote-<package-version>/*_client_info.json
```

## How To Run It

### Jira proxy

```bash
mcp-remote https://mcp.atlassian.com/v1/mcp \
  --resource https://tenancy1.atlassian.net/ \
  --send-resource \
  --callback-port 3736
```

### Confluence proxy

```bash
mcp-remote https://mcp.atlassian.com/v1/mcp \
  --resource https://tenancy2.atlassian.net/ \
  --send-resource \
  --callback-port 3736
```

### Shared callback listener

```bash
mcp-remote https://mcp.atlassian.com/v1/mcp \
  --callback-port 3736 \
  --listen-only
```

## Example: Split-Tenancy Run

Assumptions:

- tenancy 1: `https://tenancy1.atlassian.net/`
- tenancy 2: `https://tenancy2.atlassian.net/`
- shared callback port: `3736`

### 1. Start the shared callback listener

```bash
mcp-remote https://mcp.atlassian.com/v1/mcp \
  --callback-port 3736 \
  --listen-only \
  --debug
```

### 2. Start the tenancy 1 proxy

```bash
mcp-remote https://mcp.atlassian.com/v1/mcp \
  --resource https://tenancy1.atlassian.net/ \
  --send-resource \
  --callback-port 3736 \
  --debug
```

### 3. Start the tenancy 2 proxy

```bash
mcp-remote https://mcp.atlassian.com/v1/mcp \
  --resource https://tenancy2.atlassian.net/ \
  --send-resource \
  --callback-port 3736 \
  --debug
```

### What happens

- the listener owns `127.0.0.1:3736`
- each tenancy-specific proxy computes a different `serverUrlHash` because `--resource` differs
- each tenancy-specific proxy writes its own auth lock and browser flow metadata
- the browser callback returns `state=<uuid>:<serverUrlHash>`
- the shared listener uses `serverUrlHash` from `state` to load the correct auth lock and complete token exchange for the correct tenancy

### Notes

- only the listener binds the callback port
- the normal tenancy-specific proxies do not bind `3736`
- both tenancy-specific proxies can share the same listener because callback routing is state-based
- if a tenancy-specific proxy is interrupted after browser launch, the listener can still complete callback processing and write tokens for that tenancy

## What Was Verified

Verified:

- proxy path compiles
- unit tests pass
- live Jira auth handoff succeeded:
  - initiator wrote auth lock and opened browser
  - listener processed callback and wrote `tokens.json`
  - subsequent Jira proxy startup reused tokens successfully

Not claimed here:

- no blanket statement about all future Atlassian consent edge cases
- no statement that the deprecated coordination module is removed

## Files Changed

Primary implementation files:

- `src/proxy.ts`
- `src/lib/node-oauth-client-provider.ts`
- `src/lib/mcp-auth-config.ts`
- `src/lib/utils.ts`
- `src/lib/types.ts`

Legacy/deprecated file:

- `src/lib/coordination.ts`

## Summary

The implemented Codex fix uses:

- `--callback-port <port>`
- `--listen-only`
- `--resource`-based auth isolation through `serverUrlHash`
- auth lock coordination keyed by `serverUrlHash`
- callback routing through OAuth `state = <uuid>:<serverUrlHash>`
- listener-side token exchange using the auth lock as the active PKCE source of truth

This provides:

- stable callback target
- per-resource browser suppression
- shared callback processing
- deterministic callback routing
- recovery when the original auth-initiating process is disrupted
