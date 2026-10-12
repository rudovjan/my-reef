# Protocol notes and attribution

My Reef originated as an app in [remote-playground](https://github.com/rudovjan/remote-playground) and was extracted into this independent repository. The UI, server adapters and tests were implemented for this project. No vendor application bundle or third-party integration code is shipped here.

## Red Sea ReefBeat / ReefControl

- OAuth login: `POST https://cloud.reef-beat.com/oauth/token`, using ReefBeat's published app client identifier and URL-encoded credentials. A public app identifier is not an aquarium owner's password or token.
- Bearer inventory: `GET /device` and `/aquarium`.
- Cloud readings: `GET /reef-control/<hwid>/dashboard`. This community route follows the vendor's device-family pattern and was verified against the original owner's controller on 2026-10-11. Successful authentication alone does not prove readings work; the adapter requires a probes array.
- Local fallback: `GET http://<discovered-private-IP>/dashboard`. Only a literal RFC1918 IPv4 discovered in the owner's inventory is used, on port 80 with redirects disabled. No arbitrary URL proxy or network scanning.
- Vendor-supplied OAuth refresh tokens renew saved connections without retaining account passwords.
- Requests have an eight-second timeout and bounded JSON responses. Last good measurements are retained and marked stale during failures.

References consulted for protocol behaviour and sanitized test-payload structure:

- [Elwinmage's cloud implementation](https://github.com/Elwinmage/ha-reefbeat-component/blob/main/custom_components/redsea/reefbeat/cloud.py)
- [Elwinmage's local ReefControl endpoints](https://github.com/Elwinmage/ha-reefbeat-component/blob/main/custom_components/redsea/reefbeat/control.py)
- [RedSeaHA device-family route patterns](https://github.com/thetastate1/RedSeaHA)
- [ReefBeat device simulator](https://github.com/Elwinmage/reefbeat-devices-simulator)

## AquaWiz

Requests were traced from the vendor's [public web application](https://www.aquawiz.net/auth/en) and its publicly served `/dist/build.js?ver=122725` bundle on 2026-10-11. It was read as text, not executed, copied or included in the repository.

- Sign-in: `POST https://server.aquawiz.net/api/v1/KH/auth` with `{user, password, token: {access_token: ""}}`.
- Measurement read: `POST /api/v1/KH/<serial>/all_field` with `{user, password: "", appid: 1, token: {access_token}}` and a bearer token. This vendor endpoint uses POST for reading.
- `latest_kh / 1000` gives dKH; `latest_time` is actual measurement time in milliseconds; `field8 / 1000` supplies the device's KH target.
- Graph read: `POST /api/v1/query/device/<serial>/graphs`, adding an ISO start date. `results` contains timestamp/field pairs; `field22 / 1000` gives KH history.
- A response may supply updated `access_token` and `tokenExp`; the server adopts them without an account password.
- The only alternative origin is `https://server.aquawiz.cn` for China accounts.
- Calcium reactor devices are excluded because their values have different meanings. pH conversion is not guessed across AquaWiz models.

Only authentication, inventory and measurement/history reads are implemented. No equipment control or configuration commands exist. Vendor interfaces can change independently of this project. Red Sea and AquaWiz names belong to their respective owners; their inclusion does not imply endorsement.
