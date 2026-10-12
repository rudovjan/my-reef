# Hosting My Reef

Run a single persistent Node process for each owner. The app keeps browser sessions and an encrypted vendor vault on disk and polls in the background. It needs durable storage and an always-running process; a static host or sleeping service alone will not provide this behaviour.

## Local computer or home server

Use the README's Node or Docker instructions. An HTTPS reverse proxy or tunnel can expose the loopback port to your phone without changing the dashboard code. Set `PUBLIC_ORIGIN` to its exact HTTPS origin before starting the app. Your computer must stay awake for polling.

For a step-by-step setup using a Docker container and an ngrok agent on the same computer, see [Docker + ngrok](NGROK.md). It includes the exact origin setting, persistent storage, home-screen installation, restarting after updates and common errors. A tunnel supplies remote access; the computer still runs the app and stores its data.

Keep the existing Playground instance separate. My Reef uses its own port, data directory and `my_reef_session` cookie. The source is extracted without Playground credentials, history or unrelated apps. Sign into equipment on your new instance; extraction does not copy private connections from the existing server.

## Managed Node host

Examples include Render and Railway. Create one paid, continuously running web service with a persistent disk/volume:

1. Connect your fork or copy of this repository.
2. Choose Node 24 LTS. No build or dependency installation is needed; start with `sh docker-entrypoint.sh` (or use the Dockerfile).
3. Mount persistent storage, for example at `/data`.
4. Set `MY_REEF_DATA_DIR=/data`, `HOST=0.0.0.0` and `PUBLIC_ORIGIN=https://your-exact-hostname`. Use the platform's provided `PORT`.
5. Use `/healthz` as the health-check path.
6. On first startup, read `/data/password.txt` privately through the host's shell. The entrypoint creates the password only when the auth file is absent.
7. Open your HTTPS URL, sign into My Reef and connect your own equipment.

Only one replica may use a data directory. File-based state is not designed for multiple processes sharing the same volume. Keep the entire volume when redeploying. Back up both the vault and its encryption key privately. A paid managed database is not required for this single-owner version.

Cloud hosts cannot normally reach your controller's private home-network address. Red Sea and AquaWiz cloud paths remain usable; a local-device-only integration would require a home-network connection.

## VPS and reverse proxy

On a Linux server with Node 24, run setup using a dedicated unprivileged account and a private persistent directory. Configure a service manager to restart the process. Put an HTTPS reverse proxy in front of `127.0.0.1:3000`, preserving the incoming `Host` header. Set the exact HTTPS `PUBLIC_ORIGIN` in the service environment.

An example Caddy configuration:

```caddyfile
reef.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Replace the hostname with a domain you control. Server maintenance, certificates, backups and hosting bills belong to the operator.
