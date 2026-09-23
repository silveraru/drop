# Drop

Leave a note, photo or voice clip pinned to an exact spot. Anyone can see the pin on the map, but it only opens for someone standing there. Think geocaching, but for messages.

- **Drops**: a note, photo or voice clip (up to 60 s) pinned where you stand, with an optional public hint.
- **Private drops**: kept off the map. Only people with the link can find them, and they still have to go there.
- **Self-destructing drops**: vanish after the first N finders, after a set time, or both.
- **Replies**: a guestbook on each drop that only people who opened it can read or sign.
- **Treasure hunts**: a chain of drops. Players only see step 1; opening a step reveals where the next one is. Hunts can be public or link-only.
- **Reporting**: anyone can flag a drop or reply. Enough flags hide it until an admin reviews it at `/admin.html`.

There are no accounts. Each browser generates a random device key (kept in `localStorage`, sent as `X-Device-Key`) and the server stores only its hash. That's enough to know who made what, who has opened what, and to count reports once per person. Clearing site data means losing ownership of your drops.

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
| `ADMIN_TOKEN` | unset | Enables the moderation API and `/admin.html`. Admin endpoints return 404 without it |
| `UNLOCK_RADIUS_M` | `25` | How close you must be to open a drop |
| `MAX_ACCURACY_M` | `40` | Reject GPS fixes less precise than this |
| `REPORT_HIDE_THRESHOLD` | `3` | Distinct reporters before something is hidden |
| `TRUST_PROXY` | unset | Number of proxy hops, so rate limiting sees real client IPs |

## How it works

- **Opening**: the server checks the distance and only returns content when you're within `UNLOCK_RADIUS_M`. Media is served through signed links that expire after 5 minutes and is never served statically. Location is taken on trust, which is fine for a game.
- **Self-destruct**: each device counts once toward the "N finders" limit, and the dropper never counts. The person who uses up the last open still sees the content; after that the text and replies are wiped right away, and the media file is deleted once its link has expired. Timed drops are swept every minute.
- **Hunts**: you start one, walk the route adding a step wherever you stand, then publish. Published hunts can't be edited, so a route can't change under players. Steps have to be opened in order, and the previous step's response reveals where the next one is. Steps can't self-destruct, because that would break the hunt for everyone after.
- **Moderation**: reports are counted once per device. At the threshold, the drop or reply disappears from the map, links and reply lists; the owner still sees it marked as hidden. In `/admin.html` you can restore it (clearing its reports) or delete it. Deleting one step deletes its whole hunt.
- **Rate limits**: opens are limited per IP; creating drops, replies, reports and hunts is limited per device.
- **Migrations**: the schema version lives in `PRAGMA user_version`, and databases from older releases upgrade automatically on start.

### API

All write endpoints need an `X-Device-Key` header (22 to 128 URL-safe characters).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/drops` | Multipart: `kind`, `lat`, `lng`, `accuracy`, `body?`, `hint?`, `media?`, `visibility?`, `maxOpens?`, `expiresInHours?`, `huntId?` |
| `GET` | `/api/drops/nearby?lat&lng&radius` | Public drops and hunt starts. No content |
| `GET` | `/api/drops/:id` | Locked details, used for private links and hunt clues |
| `POST` | `/api/drops/:id/open` | JSON `{lat, lng, accuracy}`. Returns content, replies and the hunt's `next` step |
| `DELETE` | `/api/drops/:id` | Owner only (standalone drops) |
| `GET` / `POST` | `/api/drops/:id/replies` | Only after opening (or as the owner) |
| `DELETE` | `/api/replies/:id` | Reply author or drop owner |
| `POST` | `/api/hunts` | `{title, description?, visibility?}` |
| `GET` | `/api/hunts/:id` | Start point, progress and finisher count; the owner also gets every step |
| `POST` | `/api/hunts/:id/publish` | Needs at least 2 steps |
| `DELETE` | `/api/hunts/:id` | Owner only |
| `GET` | `/api/me` | Your drops and hunts |
| `POST` | `/api/reports` | `{targetType: drop\|reply, targetId, reason, note?}` |
| `GET` | `/api/admin/reports` | `Authorization: Bearer $ADMIN_TOKEN` |
| `POST` | `/api/admin/:type/:id/restore` | Unhide and clear reports |
| `DELETE` | `/api/admin/:type/:id` | Take down |
| `GET` | `/api/media/:id?exp&sig` | Signed link from `/open` |

## Known limitations

- **Location is easy to fake.** Deliberately not fought; it's a game. Don't market drops as secure.
- **Pins are public.** Dropping at your home reveals where you live. The drop form warns about this.
- **Device keys aren't accounts.** Clearing browser data or switching phones means losing control of your drops. Adding real sign-in later is straightforward, since everything already hangs off one owner hash.
- **Reports can be abused.** A few people can hide something together until an admin restores it. Raise `REPORT_HIDE_THRESHOLD` as usage grows.
- **GPS is rough in cities and indoors.** 25 m balances "you must actually be there" against signal error in built-up areas. Tune it with `UNLOCK_RADIUS_M`.
- **The nearby query uses a lat/lng box** on a B-tree index. That's fine up to hundreds of thousands of drops; beyond that, use a geohash or H3 column, or PostGIS.
- **Map tiles come from the public OpenStreetMap servers**, whose [usage policy](https://operations.osmfoundation.org/policies/tiles/) forbids heavy use. Switch to a tile provider before real traffic.
