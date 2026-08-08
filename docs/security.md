# Access control

Two audiences, two treatments.

**Public, always.** Tiles, TileJSON and the `.torrent` under `/archives/`, the
RSS feeds, and the console's own HTML. Serving the first three to anyone is the
point of the server; the console has to load or its sign-in page could never be
reached. The page carries no secrets — everything it displays it fetches from
the API.

**Guarded, whenever a credential is configured.** Everything under `/api/`,
except `/api/login` and `/api/session`. These can create torrents, move files,
delete data and rewrite the configuration.

## Turning it on

```json
{
  "auth": {
    "username": "andrew",
    "password": "choose-something-long",
    "apiKey": "a-long-random-string"
  }
}
```

Any one of `apiKey`, `password` or `passwordHash` switches guarding on. Set none
and the node behaves exactly as it did before — which is fine on a machine only
you can reach, and is why the default changes nothing.

**Scripts and sibling nodes** use the token:

```sh
curl -H 'authorization: Bearer a-long-random-string' \
  http://maps.internal:8090/api/torrents
```

**People** use the console. Where a password is configured, sign in with it;
where only `apiKey` is set, paste the token into the same box — the console says
so rather than asking for a password that does not exist. Either way the console
posts to `/api/login` and gets a session cookie — `HttpOnly`, `SameSite=Lax`, and `Secure` when the request arrived over
TLS. Sessions live in memory, so a restart signs everyone out and there is no
signing secret to keep safe.

Trading the token for a session grants nothing new — whoever holds it already
has every route — and means it is typed once rather than kept in the browser.

### Passwords

`password` is plaintext in the config file; keep that file readable only by its
owner. `passwordHash` is preferred and holds a scrypt digest:

```json
{ "auth": { "passwordHash": "scrypt$<salt>$<digest>" } }
```

Setting a password through the settings screen stores the hash and discards the
plaintext. Credentials are redacted from every API response, and a redaction
placeholder is never written back as a real secret.

## Refusing to start

A node with no credential that is bound to a reachable address **will not
start**:

```
refusing to listen on 0.0.0.0 with no authentication configured.
```

This is deliberately fatal rather than a warning. The failure it prevents is
silent — the node works perfectly, nothing looks wrong, and the first sign of
trouble is somebody else finding the port. A line in a log that nobody reads
arrives after the mistake; refusing to start arrives before it.

Three ways past it, in order of preference:

1. Configure `auth`.
2. Bind to `127.0.0.1` and reach it through a reverse proxy that authenticates.
3. Set `allowUnauthenticated: true`, if the network really is trusted.

## What this is not

**It is not a defence against someone on your network.** Sessions are bearer
credentials over whatever transport you chose; on plain HTTP they can be read
off the wire. Put a TLS-terminating proxy in front of anything that leaves the
machine, and set `trustProxy` so the console builds correct URLs.

**It does not sandbox the filesystem.** An authenticated caller can name any
path when adding an archive. What it cannot do is publish a file that is not a
map archive — that is checked by content, independently of who is asking — but
an operator credential is still an operator credential.

**There are no roles.** A credential is full access or none.
