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

Any one of `apiKey`, `password`, `passwordHash` or a named token switches
guarding on. Set none and the node behaves exactly as it did before — which is
fine on a machine only you can reach, and is why the default changes nothing.

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

## Two ports, so the console is not merely guarded but absent

Set `adminPort` and the split stops being about credentials and starts being
about reachability:

```json
{
  "port": 8090,
  "host": "0.0.0.0",
  "adminPort": 8091,
  "adminHost": "127.0.0.1"
}
```

| listener | serves |
| --- | --- |
| `port` | tiles, TileJSON, `.torrent` files, the feeds, the `latest` endpoints, and `/api/catalog` — everything a stranger or a peer is meant to reach |
| `adminPort` | the console and the rest of the API, plus all of the above |

The public port can then face the internet while the admin port is bound to
loopback or a private interface, so the thing that can rewrite the
configuration is not password-protected — it is *unreachable*. That is a much
stronger statement, and it is the one a firewall can enforce.

On the public listener the admin surface answers **404, not 403**. A refusal
confirms there is something behind it; an absence does not.

Routing is by the port the request arrived on, never by a header, because a
header is something the caller controls.

`/api/catalog` is public on purpose: it is how another node keeps itself in
step, so it has to be reachable from outside. What it publishes is already
decided by `feedCategories` and by whatever token was presented. The map
preview is *not* public — it is part of the console, and it loads MapLibre from
`/vendor`, which is not published either, so serving it would serve a page that
cannot render.

With a split, **the refusal to start reads the admin interface** rather than
the public one. Tiles on `0.0.0.0` is the entire point of the tiles; what
matters is where the console is.

## Named tokens, and roles

`apiKey` is one credential with one power. That is fine while the only caller is
you, and stops being fine the moment another node wants to follow this one:
"let them mirror my internal archives" and "let them delete my library" were the
same sentence.

So there are named tokens, minted in **Settings → Access tokens** or at
`POST /api/tokens`:

| role | may |
| --- | --- |
| `peer` | read this node — the catalogue, the feeds, tiles and `.torrent` files. What another swarm node needs in order to follow it, and nothing else. |
| `admin` | everything the console can do. |

One per person or node, so any of them can be revoked without disturbing the
rest, and each records when it was last used — which is what makes retiring an
old one an informed decision rather than a guess.

```sh
curl -X POST -H 'authorization: Bearer <admin token>' \
  -H 'content-type: application/json' \
  -d '{"name":"partner org","role":"peer","categories":["internal"]}' \
  http://maps.internal:8090/api/tokens
```

The response carries the token itself. That is the only time it is ever
returned: only a SHA-256 of it is stored, so a lost token is replaced rather
than recovered — which is the property that makes keeping the list safe.

SHA-256 rather than scrypt, deliberately, and for the opposite reason passwords
want scrypt. A password is short, human-chosen and worth attacking with a
dictionary. A token is 32 bytes from the CSPRNG with no dictionary to attack, so
slowness buys nothing — and it would cost a slow hash per candidate token on
every single request, which is a denial of service handed out for free. A fast
hash also lets tokens be looked up by hash rather than compared one at a time,
so a node with fifty peers checks as quickly as one with one.

### Narrowing a peer to some categories

A `peer` token may carry a category list, and then sees exactly those:

```json
{
  "auth": {
    "tokens": [
      { "id": "…", "name": "partner org", "role": "peer",
        "hash": "…", "categories": ["internal"] }
    ]
  }
}
```

Not even what the node publishes openly. The point of narrowing a token is to
describe one peer's slice, not to add to the public view, so it applies before
`feedCategories` rather than on top of it. This holds on the feeds as well as
the catalogue, which matters because the feeds are public — the token does not
unlock them, it widens what they show.

An `admin` token cannot be narrowed. It can rewrite the configuration, and the
configuration is where the categories are, so the restriction would be one it
could lift.

### The original apiKey

Still works, still means admin. It cannot be listed or revoked through the API,
because it lives in the config file — remove it from there to retire it. The
token list reports whether one exists so its presence is not a surprise.

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

**A peer token is a read credential, not a sandbox.** It cannot change
anything, and it cannot list or revoke tokens — that would tell it who else
holds a credential for this node. What it can do is read everything it is
scoped to, including the `.torrent` files and the tiles, which is the whole
point of issuing one.

**An admin credential is an operator credential.** Whoever holds one can name
any path when adding an archive, and can turn on `allowHooksFromApi` only by
editing the config file — that flag is deliberately unreachable from the API,
including by someone who already has it, because the decision to let a token
run commands as the service user has to be made somewhere a token cannot
reach.
