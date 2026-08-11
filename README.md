# MrowSearch

MrowSearch is a self-hosted private search application. It sends searches to an internal SearXNG service and opens destination sites in isolated remote Chromium workers. The local browser stays on the MrowSearch origin unless the user confirms Open Externally.

MrowSearch reduces data exposure. It does not provide absolute anonymity. Destination sites see the Ubuntu server exit address or the host VPN exit address. Search engines used by SearXNG receive the full search query.

## Stack

The Compose application runs these services:

- `mrow-app` serves the React application and Fastify API. It owns authentication, SQLite data, viewer leases, stream relay, and file transfer.
- `mrow-search` runs SearXNG with JSON results enabled and no public port.
- `mrow-egress` validates DNS and destination addresses before it opens HTTP or HTTPS connections.
- Four `mrow-browser` workers run Chromium, KasmVNC, Openbox, PulseAudio, Playwright, and the worker control service.

Each worker has no Docker network. Chromium reaches the egress gateway through a protected Unix socket and a loopback bridge inside its container. The application reaches each worker through a separate Unix socket volume.

## Requirements

- Ubuntu or Debian on AMD64 or ARM64
- Four CPU cores and 8 GB of memory
- A host VPN route that covers the Docker bridge subnet when VPN egress is required

Only port `3080` is published by default. SearXNG, the egress gateway, and browser workers have no public ports.

## One-command setup

Clone the repository into your home directory. Then run the installer.

```sh
git clone https://github.com/Alana86521/MrowSearch.git ~/MrowSearch
bash ~/MrowSearch/install.sh
```

The installer completes these tasks:

- It installs Docker Engine and Docker Compose when they are missing.
- It selects an available port from `3080` through `3099`.
- It creates `.env` and generates all required secrets.
- It builds the application and browser images.
- It registers the application through the local CasaOS app-management service when CasaOS is present.
- It starts the stack and waits for a browser worker.
- It enables startup through CasaOS or a systemd service.

A local installation does not require configuration.

The final output shows the application URL and owner setup token. Open the URL and create the owner account.

The generated HTTP URL is for trusted local networks. Use HTTPS before you expose MrowSearch to the internet.

Set a public HTTPS URL before the first install when a reverse proxy is ready:

```sh
MROW_PUBLIC_URL=https://search.example.com bash install.sh
```

The installer keeps an existing `.env` file during later runs. It never replaces an existing data key or secret.

Never commit `.env` or copy recoverable encryption keys into the repository. Back up the file in a separate secret store.

## CasaOS behavior

The installer reads CasaOS's local app-management address. It submits the generated Compose configuration through the CasaOS API.

CasaOS then owns the application entry and its startup state. If CasaOS is absent, the installer creates `mrowsearch.service` for systemd.

Both paths use Docker restart policies. The stack starts again after a host restart or Docker restart.

Use these maintenance commands from the repository directory:

```sh
bash install.sh status
bash install.sh logs
bash install.sh setup-token
bash install.sh update
bash install.sh uninstall
```

The uninstall command keeps the data volume, images, and `.env` file. It stops and removes only the running stack and startup entry.

## Reverse proxy

The reverse proxy must:

- Terminate HTTPS.
- Send HTTP to `127.0.0.1:3080` or the selected bind address.
- Preserve the original host and HTTPS scheme.
- Support WebSocket upgrades for `/api/viewer/control` and `/api/viewer/stream`.
- Allow request bodies larger than the configured upload limit.
- Use long read timeouts for active viewer connections.

An Nginx example is in `deploy/nginx.conf.example`. Add equivalent settings to the CasaOS proxy if it manages Nginx for the hostname.

## Host VPN routing

MrowSearch does not manage VPN credentials. Configure Ubuntu so the Docker bridge subnet created for the `services` network follows the VPN route. Confirm both cases from Owner, Network and DNS:

1. With the VPN off, the reported outbound address matches the VPS address.
2. With the VPN on, the reported outbound address matches the VPN exit address.

Also open a destination in the private viewer and confirm the same address from a destination test page. Application diagnostics do not prove the worker route by themselves.

## Accounts

The owner can create one-use invite codes. Each code expires after seven days. An invited account stays pending until the owner approves it. The owner can reject, disable, remove, or issue a temporary password reset code for invited users.

Passwords use Argon2id with 19 MiB of memory, two iterations, and one parallel lane. Sessions expire after 30 minutes without activity or 12 hours from sign-in. Authenticator secrets and persistent Chromium storage use AES-256-GCM with a new 96-bit initialization vector and bound additional data for each encrypted value.

## Browser privacy modes

- Ephemeral uses a separate Chromium context for each tab and destroys its data when the tab closes.
- Session Only shares site sessions until logout, viewer destruction, or Clear Session.
- Persistent stores only an encrypted Playwright storage snapshot. It does not store browser cache, service workers, downloads, or uploaded files.

Camera and microphone input remain blocked. Location, notifications, clipboard access, popups, uploads, and downloads require application handling. Temporary files are deleted after transfer, rejection, viewer destruction, or expiry.

## DNS and egress

The owner can select system DNS, custom DNS servers, DNS over HTTPS, or DNS over TLS. Ports 80 and 443 are always allowed. Extra public destination ports can be added by the owner.

The egress gateway validates every A and AAAA response. It rejects the destination when any response is loopback, private, carrier-grade NAT, link-local, multicast, reserved, documentation, or metadata space. It resolves again for each new proxy connection. Chromium has no direct network path and has proxy bypass disabled.

Standard and Strict tracking protection use the pinned host snapshot in `deploy/tracking-hosts.txt`. The source policy check verifies its tracked SHA-256 checksum before each build.

## Back up and restore

The `mrowsearch_app-data` volume contains the SQLite database and egress settings. Stop the application before a file-level backup so the database and write-ahead log stay consistent.

```sh
docker compose stop mrow-app
docker run --rm -v mrowsearch_app-data:/data:ro -v "$PWD:/backup" alpine:3.22.1 tar -czf /backup/mrowsearch-data.tar.gz -C /data .
docker compose start mrow-app
```

Store the matching `MROW_DATA_KEY` and environment secrets separately. A database backup without its data key cannot restore encrypted values.

To restore, stop the full stack, create a new empty data volume, extract the archive into that volume, restore the original environment secrets, then start the pinned application version. Keep the previous application image and volume backup until the updated database and workers pass health checks.

## Updates and rollback

1. Back up the data volume and environment secrets.
2. Run `bash install.sh update` from the repository directory.
3. Check `/health/ready`, owner worker health, sign-in, search, and a viewer navigation.

If a database migration fails, stop the stack, restore the pre-update data volume, and start the previous pinned image versions. Do not run two application versions against the same SQLite volume.

## Development

Use Node 24.18.0 or newer.

```sh
npm ci
npm run check
npm run build
npm run dev
```

The source policy check rejects first-party comments, em dashes, and tracked assistant provenance text. It scans source, styles, scripts, configuration, Docker files, and documentation. Generated dependency files remain unchanged.

## Verification boundaries

A local build does not prove the remote browser path on Ubuntu. Before release, run the target checks described below:

- Install through CasaOS on both AMD64 and ARM64 hosts.
- Run four active viewers with four tabs each on the target four-core, 8 GB server.
- Confirm one 720p media session stays at or above 24 frames per second.
- Check Chrome and Firefox history before and after search and viewer workflows.
- Confirm only the MrowSearch application entry appears in local history.
- Inspect application, SearXNG, egress, and worker logs for query, URL, page title, form, clipboard, and file name leakage.
- Confirm the worker route sees the VPS address, then repeat with the host VPN and confirm the VPN exit address.
- Test uploads, downloads, WebSockets, service workers, forms, redirects, audio, video, cookies, permissions, and cross-domain links against controlled fixtures.
- Run keyboard-only, mobile width, reduced motion, and accessibility checks.

DRM media and destination WebRTC calls are unsupported. Open Externally sends the URL to the local browser, local history, and device network.

## Licenses

First-party source is provided under the license in `LICENSE`. Required third-party notices are in `THIRD_PARTY_NOTICES.md`.
