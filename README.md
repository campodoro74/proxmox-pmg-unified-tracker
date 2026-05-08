# Unified PMG Tracking Center (multi-node)

Fast, single-page “Tracking Center”-like search across multiple Proxmox Mail Gateway (PMG) nodes by querying the **official PMG API** in parallel.

## What it does

- One web page with the same core inputs as PMG Tracking Center:
  - Start / End
  - Sender (`from`)
  - Receiver (`target`)
  - Filter (`xfilter`)
  - Include Greylist, Include NDR
- Shows a single merged table across all nodes.
- Click a row to view per-message detailed syslog entries (PMG `/tracker/{id}`).

## UI modes

- **Simple mode (default)**: shows only the basic search fields and basic columns.
- **Advanced mode**: enables additional filters (nodes/status/errors/size/qid/msgid/client) and extra columns (D/R/QID/Relay/Client).

## Refreshing

- **Refresh button** reloads the page.
- **Auto-refresh** can periodically re-run the current search (default every 5 minutes) and shows a countdown.

## PMG API used

- List: `GET /api2/json/nodes/{node}/tracker`
- Detail: `GET /api2/json/nodes/{node}/tracker/{id}`

Authentication:

- **Recommended / universal**: **ticket auth** using a dedicated read-only user (role **Auditor**) and PMG’s login endpoint, then sending cookie `PMGAuthCookie=<ticket>`.
- **Optional**: API tokens (header `Authorization: PVEAPIToken=<token>`) if your PMG exposes them.

## Deploy (recommended) behind a hostname

1) Copy `.env.example` to `.env` and fill in:
- `PMG_NODES`
- `PMG_<NODE>_URL`
- Either `PMG_<NODE>_USERNAME` + `PMG_<NODE>_PASSWORD` **or** `PMG_<NODE>_TOKEN`
- Optional `APP_USERNAME` / `APP_PASSWORD`

2) Start:

```bash
docker compose up -d --build
```

3) Open the site:

- via Caddy: `https://pmg.example.com/`
- or directly: `http://127.0.0.1:8080/` (local only, by default)

## TLS / certificates

If your PMG nodes use self-signed certs, you have two options:

- **Preferred**: install the PMG CA certificate so TLS verification can stay enabled.
- **Fallback**: set `PMG_VERIFY_TLS=false` (or `PMG_<NODE>_VERIFY_TLS=false`) for quick testing.

## Notes

- Each PMG node only knows about mails processed on that node, so multi-node search requires querying each node.
- Message IDs are not globally unique across nodes; the UI identifies rows by `{node, id}`.
# Unified PMG Tracking Center

Small web app that searches the Proxmox Mail Gateway Tracking Center API across multiple PMG nodes in parallel and shows one combined result table.

## Why API, not SSH/syslog

PMG already exposes the Tracking Center data through:

- `GET /api2/json/nodes/{node}/tracker`
- `GET /api2/json/nodes/{node}/tracker/{id}`

Querying those endpoints on all three nodes in parallel is faster and more accurate than copying/merging syslog files on a fourth server.

## Configure

Copy the sample env file:

```bash
cp .env.example .env
```

Edit `.env`:

```text
PMG_NODES=pmg1,pmg2,pmg3
PMG_PMG1_URL=https://pmg1.example.com:8006
PMG_PMG1_TOKEN=tracker@pmg!tracking=token-secret
```

The node names in `PMG_NODES` must be the names PMG uses in the API path. Check them from any PMG node:

```bash
pmgsh get /nodes
```

For node names containing `-`, use `_` in the environment variable prefix. Example: `pmg-mail-1` becomes `PMG_PMG_MAIL_1_URL`.

## PMG credentials (required)

Create a dedicated PMG **read-only user** with permission to read Tracking Center data.

The PMG API documents `GET /api2/json/nodes/{node}/tracker` as requiring:

- `Check: ["admin","audit"]`

So the **minimal** role for read-only tracking access is **Auditor**.

### Create the user on each PMG node (GUI)

Do these steps on each node (e.g. `https://pmg1.example.com:8006`, `https://pmg2.example.com:8006`, ...):

1) Go to `Configuration` → `Access Control` → `Users`

2) Create a dedicated user (example):

- **User**: `tracker`
- **Realm**: `pmg`
- **Role**: `Auditor`

This yields the user ID `tracker@pmg`.

3) Set a strong password for `tracker@pmg` (select the user → change password).

4) Configure this app using ticket auth in `.env`:

```text
PMG_PMG1_USERNAME=tracker@pmg
PMG_PMG1_PASSWORD=YOUR_PASSWORD
```

### (Optional) API token auth

If your PMG UI does expose API tokens, the app also supports token auth:

- Header: `Authorization: PVEAPIToken=user@realm!tokenid=secret`
- Env: `PMG_PMG1_TOKEN=tracker@pmg!tracking=<SECRET>`

### CLI notes

PMG includes `pmgsh`, which can discover the exact endpoints/parameters on your installed version. Token endpoints may not exist on your version; ticket auth works regardless.

1) Verify the node names used in the API path:

```bash
pmgsh get /nodes
```

2) Create/enable the user (Auditor role):

```bash
pmgsh create /access/users -userid tracker@pmg -comment "PMG tracker read-only user"
pmgsh set /access/users/tracker@pmg -enable 1
pmgsh set /access/users/tracker@pmg -role Auditor
```

3) Set the user password (interactive):

```bash
pmgsh set /access/users/tracker@pmg/password
```

## Run locally

```bash
docker compose up --build
```

The app listens on `127.0.0.1:8080`.

## Deploy behind Caddy (example)

1. Install Docker and Docker Compose.
2. Copy this project to `/opt/pmg-tracker`.
3. Create `/opt/pmg-tracker/.env` from `.env.example`.
4. Start the app:

```bash
cd /opt/pmg-tracker
docker compose up -d --build
```

5. Put it behind Caddy on your hostname, forwarding to `tracker:8080` (see `Caddyfile`).

Keep `APP_USERNAME` and `APP_PASSWORD` set unless the reverse proxy already enforces authentication.

## Example `.env`

```text
PMG_NODES=pmg1,pmg2,pmg3
PMG_VERIFY_TLS=true

PMG_PMG1_URL=https://pmg1.example.com:8006
PMG_PMG1_USERNAME=tracker@pmg
PMG_PMG1_PASSWORD=CHANGE_ME

PMG_PMG2_URL=https://pmg2.example.com:8006
PMG_PMG2_USERNAME=tracker@pmg
PMG_PMG2_PASSWORD=CHANGE_ME

PMG_PMG3_URL=https://pmg3.example.com:8006
PMG_PMG3_USERNAME=tracker@pmg
PMG_PMG3_PASSWORD=CHANGE_ME

APP_USERNAME=
APP_PASSWORD=
```

## Search behavior

The UI sends the same fields as PMG Tracking Center:

- Sender -> `from`
- Receiver -> `target`
- Filter -> `xfilter`
- Start/End -> `starttime`/`endtime` Unix timestamps
- Include Greylist -> `greylist`
- Include NDRs -> `ndr`

If one PMG node is unavailable, the app returns results from the other nodes and shows a warning with the failed node.
