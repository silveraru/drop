# Drop

Leave a note, photo or voice clip pinned to an exact spot. Anyone can see the pin on the map, but it only opens for someone standing there. Think geocaching, but for messages.

## Run it

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```sh
npm install
npm start            # http://localhost:3000
npm test
```

Browsers only allow geolocation on **HTTPS or localhost**. To try it on a phone, put it behind an HTTPS tunnel or reverse proxy (e.g. Caddy, Cloudflare Tunnel, ngrok) and set `TRUST_PROXY=1`.

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite DB and uploaded media |
| `MEDIA_SECRET` | random per boot | HMAC key for media links. **Set this in production** |
| `UNLOCK_RADIUS_M` | `25` | How close you must be to open a drop |
| `MAX_ACCURACY_M` | `40` | Reject GPS fixes less precise than this |
| `TRUST_PROXY` | unset | Number of proxy hops, so rate limiting sees real client IPs |

## How it works

- **Dropping**: the drop is pinned to your current GPS fix. Fixes worse than `MAX_ACCURACY_M` are refused, so pins aren't placed somewhere vague. Photos are re-encoded in the browser (max 1600 px JPEG), which also removes EXIF metadata.
- **Discovering**: `GET /api/drops/nearby` returns location, type, hint and open count only. Content is never included.
- **Opening**: `POST /api/drops/:id/open` with your position. The **server** checks the distance and returns the content only if you're within `UNLOCK_RADIUS_M`. Media is served via a signed URL that expires after 5 minutes. Uploaded files are never publicly listed or served statically.

### API

| Method | Path | Body | |
|---|---|---|---|
| `POST` | `/api/drops` | multipart: `kind` (`note`/`photo`/`voice`), `lat`, `lng`, `accuracy`, `body?`, `hint?`, `media?` | Create |
| `GET` | `/api/drops/nearby?lat&lng&radius` | | Locked listing, radius ≤ 5 km |
| `POST` | `/api/drops/:id/open` | JSON `{lat, lng, accuracy}` | 403 with `distanceM` if too far |
| `GET` | `/api/media/:id?exp&sig` | | Signed media URL from `/open` |

## Known limitations (read before launching)

- **Location can be faked.** The server can only check the coordinates the client *claims*. Anyone with a GPS-spoofing app, browser devtools or a plain `curl` can open any drop from anywhere. Server-side checks, accuracy limits and rate limiting stop casual cheating, not a determined user. Real attestation (Play Integrity / App Attest plus mock-location detection) needs a native app, and even that can be beaten. **Don't let users treat drops as private or secure.**
- **No accounts or moderation.** Anyone can drop anything anywhere. Before a public launch you need abuse reporting, takedowns, and probably auth and per-user rate limits on creation.
- **Pins are public.** Dropping a note at your home reveals where you live. The UI says pins are visible, but consider a warning, or fuzzing the displayed pin while keeping the exact point for unlocking.
- **GPS is rough in cities and indoors.** 25 m is a compromise between "you have to actually be there" and "urban-canyon GPS error". Tune it with `UNLOCK_RADIUS_M`.
- The nearby query uses a lat/lng bounding box on a B-tree index. That's fine up to hundreds of thousands of drops; beyond that use a geohash/H3 column or PostGIS.
- Map tiles come from the public OpenStreetMap servers, whose [usage policy](https://operations.osmfoundation.org/policies/tiles/) forbids heavy use. Switch to a tile provider before real traffic.
