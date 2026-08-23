import { stackRevision } from './stacks.js';

/**
 * Publishing stack recipes, and adopting the ones another node publishes.
 *
 * Archives already travel: a node subscribes to a category and the builds
 * arrive. The recipes that combine them did not, so a pair of tile servers fed
 * from one builder had the same archives and no way to have the same stacks —
 * every recipe typed twice, and corrected twice.
 *
 * A feed, because that is the transport that arrangement already runs. The
 * objection to one was that a stack is a mutable document and syncing mutable
 * documents is about conflicts; that holds where two nodes both edit, and not
 * here. One node authors and the rest follow, exactly as they follow a category.
 * See docs/tile-stacks.md — "Syncing a stack to another node".
 *
 * A recipe is small, so it travels inside the item rather than behind a link:
 * a subscriber that has read the feed has the recipe, with nothing else to
 * fetch and no second request to authenticate.
 */

/** The same namespace the archive feed carries its own fields in. */
const NS = 'https://github.com/TechIdiots-LLC/pmtiles-swarm/ns/1.0';

/**
 * Escapes text for an XML document.
 * @param {string|number|undefined} value - What to escape.
 * @returns {string} - Safe to put between tags.
 */
function xml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The four elements a stack feed carries, named rather than built.
 *
 * A pattern assembled from a variable is one somebody else's document can
 * surprise, and these are the only tags this reads.
 */
const TAGS = new Map([
  ['title', /<title[^>]*>([\s\S]*?)<\/title>/i],
  ['pmtiles:stack', /<pmtiles:stack[^>]*>([\s\S]*?)<\/pmtiles:stack>/i],
  [
    'pmtiles:revision',
    /<pmtiles:revision[^>]*>([\s\S]*?)<\/pmtiles:revision>/i,
  ],
  ['pmtiles:recipe', /<pmtiles:recipe[^>]*>([\s\S]*?)<\/pmtiles:recipe>/i],
]);

/**
 * Reads one tag's text out of a block.
 * @param {string} block - The XML.
 * @param {string} name - The tag, which has to be one of the four above.
 * @returns {string|undefined} - Its text, unescaped.
 */
function tag(block, name) {
  const found = TAGS.get(name)?.exec(block);
  if (!found) return undefined;
  return found[1]
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .trim();
}

/**
 * Whether a stack is this node's own rather than one it adopted.
 *
 * Only these are published. A node that republished what it adopted would put
 * two nodes' names on one recipe and, where two subscribed to each other, would
 * hand it back and forth for ever.
 * @param {object} stack - The recipe.
 * @returns {boolean} - True when this node authored it.
 */
export function isLocal(stack) {
  return !stack?.adopted;
}

/**
 * This node's stacks, as a feed another node can follow.
 * @param {object[]} stacks - Every stack this node holds.
 * @param {object} options - `baseUrl`, `title`, and the node's name.
 * @returns {string} - An RSS document.
 */
export function renderStackFeed(stacks, options = {}) {
  const base = options.baseUrl ?? '';
  const mine = (stacks ?? []).filter(isLocal);

  const items = mine
    .map((stack) => {
      const revision = stackRevision(stack);
      const recipe = { ...stack };
      // The id travels in its own element; leaving it in the recipe as well is
      // two places for one fact to be written and to disagree.
      delete recipe.id;
      return `    <item>
      <title>${xml(stack.title ?? stack.id)}</title>
      <link>${xml(`${base}/stacks/${encodeURIComponent(stack.id)}/tiles.json`)}</link>
      <description>${xml(
        `${(stack.sources ?? []).length} source(s), ${stack.space ?? 'elevation'}`,
      )}</description>
      <guid isPermaLink="false">${xml(`${stack.id}@${revision}`)}</guid>
      <pmtiles:stack>${xml(stack.id)}</pmtiles:stack>
      <pmtiles:revision>${xml(revision)}</pmtiles:revision>
      <pmtiles:recipe><![CDATA[${JSON.stringify(recipe)}]]></pmtiles:recipe>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:pmtiles="${NS}">
  <channel>
    <title>${xml(options.title ?? 'Tile stacks')}</title>
    <link>${xml(base)}</link>
    <description>${xml('Stack recipes published by this node')}</description>
    <generator>pmtiles-swarm</generator>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${xml(`${base}/stacks.xml`)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

/**
 * The recipes a stack feed carries.
 *
 * An item without a readable recipe is skipped rather than failing the poll:
 * one malformed entry should not stop the others being adopted, and a feed is
 * something somebody else controls.
 * @param {string} body - The document.
 * @returns {object[]} - `{id, revision, recipe}` per item.
 */
export function parseStackFeed(body) {
  const found = [];
  for (const [block] of String(body ?? '').matchAll(
    /<item[\s>][\s\S]*?<\/item>/gi,
  )) {
    const id = tag(block, 'pmtiles:stack');
    const raw = tag(block, 'pmtiles:recipe');
    if (!id || !raw) continue;

    let recipe;
    try {
      recipe = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!recipe || typeof recipe !== 'object') continue;

    found.push({
      id,
      revision: tag(block, 'pmtiles:revision'),
      title: tag(block, 'title'),
      recipe: { ...recipe, id },
    });
  }
  return found;
}

/**
 * What adopting one recipe would do, without doing it.
 *
 * Separated from the doing so the reasons are testable and so the console can
 * say why a stack was left alone. A node that silently declined to adopt would
 * be indistinguishable from one whose feed was not being read.
 * @param {object} incoming - What the feed said.
 * @param {object|null} held - What this node has under that id, if anything.
 * @returns {object} - `{action, why}`; action is adopt, update, or skip.
 */
export function adoptionFor(incoming, held) {
  if (!held) return { action: 'adopt' };

  // A recipe somebody typed here is theirs. Overwriting it because a feed
  // happened to use the same name is the one outcome that loses work, so it is
  // refused rather than resolved.
  if (isLocal(held)) {
    return {
      action: 'skip',
      why: `a stack named ${incoming.id} was made on this node`,
    };
  }

  if (
    held.adopted?.from &&
    incoming.from &&
    held.adopted.from !== incoming.from
  ) {
    return {
      action: 'skip',
      why: `${incoming.id} is already adopted from ${held.adopted.from}`,
    };
  }

  // Unchanged. Compared by revision rather than by re-reading the recipe: the
  // publisher already hashed it, and a feed polled every few minutes should
  // cost nothing when nothing has happened.
  if (incoming.revision && held.adopted?.revision === incoming.revision) {
    return { action: 'skip', why: 'unchanged' };
  }

  return { action: 'update' };
}

/**
 * Follows other nodes' stack feeds and adopts what they publish.
 *
 * The same shape the archive subscriptions have, and on the same clock: a
 * minute's tick, each feed deciding for itself whether it is due. A recipe is a
 * few hundred bytes, so this is cheap in a way the archive side is not — what
 * costs is being wrong about which recipe won, which is what `adoptionFor`
 * exists to make explicit.
 */
export class StackFeedSubscriber {
  #stacks;
  #config;
  #now;
  #timer;
  #sweeping = false;
  #lastRun = new Map();

  /**
   * @param {object} deps - The stack store, the config and a clock.
   */
  constructor({ stacks, config, now = () => new Date() }) {
    this.#stacks = stacks;
    this.#config = config ?? {};
    this.#now = now;
  }

  /**
   * Starts polling.
   * @returns {void}
   */
  start() {
    const tick = () =>
      this.sweep().catch((error) =>
        console.error(`[stack-feed] poll failed: ${error.message}`),
      );
    tick();
    this.#timer = setInterval(tick, 60 * 1000);
    this.#timer.unref?.();

    const feeds = (this.#config.stackFeeds ?? []).filter((one) => one?.url);
    if (feeds.length > 0) {
      console.log(
        `[stack-feed] following ${feeds.length} stack feed(s): ` +
          feeds.map((one) => one.name ?? one.url).join(', '),
      );
    }
  }

  /**
   * Stops polling.
   * @returns {void}
   */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Reads every feed that is due and adopts what it finds.
   * @param {Date} [now] - Override the clock, for testing.
   * @returns {Promise<object[]>} - What changed this pass.
   */
  async sweep(now = this.#now()) {
    if (this.#sweeping) return [];
    this.#sweeping = true;
    try {
      const changed = [];
      for (const feed of this.#config.stackFeeds ?? []) {
        if (!feed?.url || feed.enabled === false) continue;

        const minutes = Number(feed.everyMinutes) || 0;
        const due =
          !this.#lastRun.has(feed.url) ||
          now - this.#lastRun.get(feed.url) >= (minutes || 15) * 60 * 1000;
        if (!due) continue;
        this.#lastRun.set(feed.url, now);

        try {
          changed.push(...(await this.read(feed, now)));
        } catch (error) {
          // Said and carried on. A feed that is down is somebody else's node
          // being down, which is not this node's problem to fail over.
          console.warn(
            `[stack-feed] ${feed.name ?? feed.url}: ${error.message}`,
          );
        }
      }
      return changed;
    } finally {
      this.#sweeping = false;
    }
  }

  /**
   * Reads one feed and settles this node's copy of what it carries.
   * @param {object} feed - One entry of `stackFeeds`.
   * @param {Date} now - The clock.
   * @returns {Promise<object[]>} - `{id, action, why}` per stack considered.
   */
  async read(feed, now = this.#now()) {
    const response = await fetch(feed.url, {
      signal: AbortSignal.timeout(Number(feed.timeoutMs) || 15000),
      headers: feed.token
        ? { authorization: `Bearer ${feed.token}` }
        : undefined,
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);

    const from = feed.name ?? feed.url;
    const published = parseStackFeed(await response.text());
    const settled = [];

    for (const incoming of published) {
      const held = this.#stacks?.get(incoming.id) ?? null;
      const { action, why } = adoptionFor({ ...incoming, from }, held);
      if (action === 'skip') {
        settled.push({ id: incoming.id, action, why });
        continue;
      }
      try {
        await this.#stacks.put({
          ...incoming.recipe,
          // Where it came from, so this node can tell its own recipes from
          // somebody else's, refuse to republish them, and know which feed to
          // stop following them from.
          adopted: {
            from,
            url: feed.url,
            revision: incoming.revision,
            at: now.toISOString(),
          },
        });
        settled.push({ id: incoming.id, action });
        console.log(`[stack-feed] ${from}: ${action}d ${incoming.id}`);
      } catch (error) {
        // A recipe this node cannot store -- an id it will not accept, a field
        // it refuses. Reported per stack, because the rest of the feed is
        // probably fine.
        settled.push({
          id: incoming.id,
          action: 'refused',
          why: error.message,
        });
        console.warn(`[stack-feed] ${from}: ${incoming.id}: ${error.message}`);
      }
    }

    settled.push(...(await this.#settleWithdrawn(feed, from, published, now)));
    return settled;
  }

  /**
   * What to do about stacks this feed used to carry and no longer does.
   *
   * The choice is the feed's, because it depends on what the far node is. A
   * replica of a builder should follow it down; a node that adopted one recipe
   * from a peer it barely knows should not lose a working endpoint because
   * somebody over there tidied up.
   * @param {object} feed - One entry of `stackFeeds`.
   * @param {string} from - What this feed is called.
   * @param {object[]} published - What it carried this time.
   * @param {Date} now - The clock.
   * @returns {Promise<object[]>} - What was done about each.
   */
  async #settleWithdrawn(feed, from, published, now) {
    const carried = new Set(published.map((one) => one.id));
    const done = [];

    for (const stack of this.#stacks?.list() ?? []) {
      if (stack.adopted?.url !== feed.url) continue;
      if (carried.has(stack.id)) {
        // Back again, so the mark comes off rather than being left to puzzle
        // over. Only worth a write when there is one to remove.
        if (stack.adopted.withdrawnAt) {
          const adopted = { ...stack.adopted };
          delete adopted.withdrawnAt;
          await this.#stacks.put({ ...stack, adopted }).catch(() => {});
        }
        continue;
      }

      if (feed.onWithdrawn === 'remove') {
        await this.#stacks.remove(stack.id).catch(() => {});
        done.push({ id: stack.id, action: 'removed' });
        console.log(`[stack-feed] ${from}: removed ${stack.id}`);
        continue;
      }

      // Kept, and marked. It goes on serving: a deletion on the far node,
      // meant or not, should not take an endpoint down everywhere at once.
      if (!stack.adopted.withdrawnAt) {
        await this.#stacks
          .put({
            ...stack,
            adopted: { ...stack.adopted, withdrawnAt: now.toISOString() },
          })
          .catch(() => {});
        done.push({ id: stack.id, action: 'withdrawn' });
        console.log(
          `[stack-feed] ${from}: no longer carries ${stack.id}; keeping it`,
        );
      }
    }
    return done;
  }
}
