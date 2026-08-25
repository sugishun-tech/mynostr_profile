import { getConfiguredRelays } from './utils.js?v=2026082502';

const NOSTR_TOOLS_SOURCES = [
  'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.0/lib/nostr.bundle.js',
  'https://unpkg.com/nostr-tools@2.7.0/lib/nostr.bundle.js'
];

let pool = null;
let nip19 = null;

function isUsableNostrTools(value) {
  return Boolean(
    value
    && typeof value.SimplePool === 'function'
    && typeof value.nip19?.npubEncode === 'function'
    && typeof value.nip19?.decode === 'function'
  );
}

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.nostrToolsSource = src;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`スクリプトを読み込めませんでした: ${src}`));
    };
    document.head.appendChild(script);
  });
}

async function loadNostrTools() {
  if (isUsableNostrTools(globalThis.NostrTools)) return globalThis.NostrTools;

  const failures = [];
  for (const src of NOSTR_TOOLS_SOURCES) {
    try {
      await loadClassicScript(src);
      if (isUsableNostrTools(globalThis.NostrTools)) return globalThis.NostrTools;
      throw new Error(`NostrTools グローバルが作成されませんでした: ${src}`);
    } catch (error) {
      failures.push(error);
      console.warn('nostr-tools load failed; trying fallback', src, error);
    }
  }

  const error = new Error(
    'Nostrライブラリを読み込めませんでした。CDNへの接続、広告ブロッカー、ネットワーク設定を確認してください。'
  );
  error.cause = failures.at(-1);
  throw error;
}

const runtimePromise = typeof document === 'undefined'
  ? Promise.resolve()
  : loadNostrTools().then(tools => {
      pool = new tools.SimplePool();
      nip19 = tools.nip19;
    });

async function ensureRuntime() {
  await runtimePromise;
  if (!pool || !nip19) {
    throw new Error('Nostrランタイムが初期化されていません');
  }
}

function requireNip19() {
  if (!nip19) throw new Error('Nostrランタイムの初期化前です');
  return nip19;
}

export function normalizePageSize(value, fallback = 30) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

export function sortUniqueEvents(events) {
  const byId = new Map();

  for (const event of events || []) {
    if (
      !event
      || typeof event.id !== 'string'
      || event.id.length === 0
      || !Number.isFinite(event.created_at)
    ) {
      continue;
    }

    if (!byId.has(event.id)) byId.set(event.id, event);
  }

  return [...byId.values()].sort((left, right) => {
    const timeDifference = right.created_at - left.created_at;
    return timeDifference || left.id.localeCompare(right.id);
  });
}

export function buildEventPage(events, pageSize, excludeIds = []) {
  const size = normalizePageSize(pageSize);
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const ordered = sortUniqueEvents(events);
  const unseen = ordered.filter(event => !excluded.has(event.id));
  const posts = unseen.slice(0, size);

  return {
    posts,
    orderedCount: ordered.length,
    unseenCount: unseen.length,
    nextUntil: posts.length > 0 ? posts[posts.length - 1].created_at : null,
    oldestFetchedTime: ordered.length > 0 ? ordered[ordered.length - 1].created_at : null
  };
}

export async function fetchPostPage(queryEvents, options) {
  const {
    hex,
    until = null,
    limit = 30,
    excludeIds = [],
    minimumQueryLimit = 120,
    maximumQueryLimit = 960,
    maximumAttempts = 8
  } = options || {};

  const pageSize = normalizePageSize(limit);
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  let cursor = Number.isFinite(until) ? Math.floor(until) : null;
  let queryLimit = Math.max(pageSize * 4, minimumQueryLimit);

  // Nostr の limit はリレーごとに適用される。複数リレーの結果をそのまま
  // 1ページとして扱うと、保存範囲の疎なリレーが返した古いイベントまで
  // カーソルが進み、中間の投稿を飛ばす。統合・整列後に pageSize 件へ絞る。
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const filter = { kinds: [1], authors: [hex], limit: queryLimit };
    if (cursor !== null) filter.until = cursor;

    const queried = await queryEvents(filter);
    const page = buildEventPage(queried, pageSize, excluded);

    if (page.posts.length > 0) {
      return {
        posts: page.posts,
        nextUntil: page.nextUntil,
        hasMore: (
          page.unseenCount > pageSize
          || page.posts.length === pageSize
          || page.orderedCount >= queryLimit
        )
      };
    }

    if (page.orderedCount === 0) {
      return { posts: [], nextUntil: cursor, hasMore: false };
    }

    // 境界秒の既表示イベントが上限を埋めた場合は、同じ秒を捨てずに
    // 取得上限を広げる。秒単位カーソルによる取りこぼしを防ぐ。
    if (page.orderedCount >= queryLimit && queryLimit < maximumQueryLimit) {
      queryLimit = Math.min(maximumQueryLimit, queryLimit * 2);
      continue;
    }

    const baseTime = cursor === null
      ? page.oldestFetchedTime
      : Math.min(cursor, page.oldestFetchedTime);
    const nextCursor = baseTime - 1;

    if (!Number.isFinite(nextCursor) || nextCursor < 0 || (cursor !== null && nextCursor >= cursor)) {
      return { posts: [], nextUntil: cursor, hasMore: false };
    }

    cursor = nextCursor;
  }

  return { posts: [], nextUntil: cursor, hasMore: false };
}

function latestEvent(events) {
  return sortUniqueEvents(events)[0] || null;
}

async function publishToConfiguredRelays(event) {
  await ensureRuntime();
  const relays = getConfiguredRelays();
  const results = await Promise.allSettled(pool.publish(relays, event));
  const success = results.filter(r => r.status === 'fulfilled').length;
  if (success === 0) throw new Error('どのリレーにも publish できませんでした');
  return { success, total: relays.length };
}

export const NostrAPI = {
  ready: () => ensureRuntime(),

  hexToNpub: (hex) => requireNip19().npubEncode(hex),

  npubToHex: (npub) => {
    const decoded = requireNip19().decode(npub);
    if (decoded.type !== 'npub') throw new Error('npub形式が不正です');
    return decoded.data;
  },

  getRelays: () => getConfiguredRelays(),

  getProfileEvent: async (hex) => {
    await ensureRuntime();
    return await pool.get(getConfiguredRelays(), { kinds: [0], authors: [hex] });
  },
  
  getProfile: async (hex) => {
    const event = await NostrAPI.getProfileEvent(hex);
    if (!event) return null;
    try {
      return { ...JSON.parse(event.content), pubkey: event.pubkey, _event: event };
    } catch (e) {
      return null;
    }
  },

  getProfilesBatch: async (pubkeys) => {
    await ensureRuntime();
    const uniquePubkeys = [...new Set(pubkeys || [])].filter(Boolean);
    if (uniquePubkeys.length === 0) return {};
    const events = await pool.querySync(getConfiguredRelays(), { kinds: [0], authors: uniquePubkeys });
    const profiles = {};
    events.forEach(ev => {
      const current = profiles[ev.pubkey]?._event;
      if (current && current.created_at > ev.created_at) return;
      try { profiles[ev.pubkey] = { ...JSON.parse(ev.content), _event: ev }; } catch(e) {}
    });
    return profiles;
  },

  validateNip05: async (nip05, pubkey) => {
    try {
      const [name, domain] = (nip05 || '').split('@');
      if (!name || !domain) return false;
      const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      return data.names?.[name] === pubkey;
    } catch (error) {
      return false;
    }
  },

  getPostsPage: async (hex, until = null, limit = 30, excludeIds = []) => {
    await ensureRuntime();
    const relays = getConfiguredRelays();
    return await fetchPostPage(
      filter => pool.querySync(relays, filter),
      { hex, until, limit, excludeIds }
    );
  },

  getPosts: async (hex, until, limit) => {
    const page = await NostrAPI.getPostsPage(hex, until, limit);
    return page.posts;
  },

  getContactList: async (hex) => {
    await ensureRuntime();
    try {
      const events = await pool.querySync(getConfiguredRelays(), { kinds: [3], authors: [hex], limit: 50 });
      return latestEvent(events);
    } catch (e) {
      console.warn('contact list fetch failed', e);
      return null;
    }
  },

  getMuteList: async (hex) => {
    await ensureRuntime();
    try {
      return await pool.get(getConfiguredRelays(), { kinds: [10000], authors: [hex] });
    } catch (e) {
      console.warn('mute list fetch failed', e);
      return null;
    }
  },

  getFollowers: async (hex) => {
    await ensureRuntime();
    try {
      const events = await pool.querySync(getConfiguredRelays(), { kinds: [3], '#p': [hex], limit: 200 });
      return [...new Set(events.map(ev => ev.pubkey))];
    } catch (e) {
      console.warn('followers fetch failed', e);
      return [];
    }
  },

  getFollowersPage: async (hex, until = null, limit = 30, excludePubkeys = []) => {
    await ensureRuntime();
    try {
      const pageSize = Math.max(1, Number(limit) || 30);
      const queryLimit = Math.max(pageSize * 3, 100);
      const seenPubkeys = new Set(excludePubkeys || []);
      const pubkeys = [];
      let cursor = Number.isFinite(until) ? until : null;
      let nextUntil = cursor;
      let hasMore = true;

      // 同じ kind:3 が複数リレーに存在したり、同一ユーザーの古いイベントが
      // 混ざったりするため、1回の問い合わせ結果がそのまま1ページになるとは限らない。
      for (let attempt = 0; attempt < 12 && pubkeys.length < pageSize; attempt += 1) {
        const filter = { kinds: [3], '#p': [hex], limit: queryLimit };
        if (cursor !== null) filter.until = cursor;

        const queried = await pool.querySync(getConfiguredRelays(), filter);
        const events = [...new Map((queried || []).map(ev => [ev.id, ev])).values()]
          .sort((a, b) => b.created_at - a.created_at);

        if (events.length === 0) {
          hasMore = false;
          break;
        }

        let lastProcessedTime = null;
        let stoppedBeforeBatchEnd = false;

        for (let index = 0; index < events.length; index += 1) {
          const event = events[index];
          lastProcessedTime = event.created_at;

          if (
            event.tags?.some(tag => tag[0] === 'p' && tag[1] === hex)
            && !seenPubkeys.has(event.pubkey)
          ) {
            seenPubkeys.add(event.pubkey);
            pubkeys.push(event.pubkey);
          }

          if (pubkeys.length >= pageSize) {
            stoppedBeforeBatchEnd = index < events.length - 1;
            break;
          }
        }

        if (lastProcessedTime === null || lastProcessedTime <= 0) {
          hasMore = false;
          break;
        }

        const newCursor = lastProcessedTime - 1;
        if (cursor !== null && newCursor >= cursor) {
          hasMore = false;
          break;
        }
        nextUntil = newCursor;

        if (pubkeys.length >= pageSize) {
          hasMore = stoppedBeforeBatchEnd || events.length >= queryLimit;
          break;
        }

        if (events.length < queryLimit) {
          hasMore = false;
          break;
        }

        cursor = newCursor;
      }

      return { pubkeys, nextUntil, hasMore };
    } catch (e) {
      console.warn('followers page fetch failed', e);
      return { pubkeys: [], nextUntil: until, hasMore: false };
    }
  },

  getFollowingBackSet: async (hex, candidatePubkeys) => {
    await ensureRuntime();
    const uniquePubkeys = [...new Set(candidatePubkeys || [])].filter(Boolean);
    if (uniquePubkeys.length === 0) return new Set();

    try {
      const events = await pool.querySync(getConfiguredRelays(), {
        kinds: [3],
        authors: uniquePubkeys
      });
      const latestByAuthor = new Map();

      for (const event of events || []) {
        const current = latestByAuthor.get(event.pubkey);
        if (!current || event.created_at > current.created_at) {
          latestByAuthor.set(event.pubkey, event);
        }
      }

      return new Set(
        uniquePubkeys.filter(pubkey => latestByAuthor.get(pubkey)?.tags
          ?.some(tag => tag[0] === 'p' && tag[1] === hex))
      );
    } catch (e) {
      console.warn('following-back check failed', e);
      return new Set();
    }
  },

  getFollowingSet: async (hex) => {
    const ev = await NostrAPI.getContactList(hex);
    return new Set((ev?.tags || []).filter(t => t[0] === 'p').map(t => t[1]));
  },

  isFollowing: async (myPubkey, targetHex) => {
    if (!myPubkey || !targetHex || myPubkey === targetHex) return false;
    const following = await NostrAPI.getFollowingSet(myPubkey);
    return following.has(targetHex);
  },

  setFollow: async (targetHex, shouldFollow) => {
    if (!window.nostr) throw new Error('NIP-07 拡張機能が見つかりません');
    const myPubkey = await window.nostr.getPublicKey();
    if (myPubkey === targetHex) throw new Error('自分自身はフォロー/アンフォロー対象外です');

    const myKind3 = await NostrAPI.getContactList(myPubkey);
    let tags = myKind3 ? [...myKind3.tags] : [];
    const content = myKind3 ? myKind3.content : '';
    const exists = tags.some(t => t[0] === 'p' && t[1] === targetHex);

    if (shouldFollow && !exists) tags.push(['p', targetHex]);
    if (!shouldFollow) tags = tags.filter(t => !(t[0] === 'p' && t[1] === targetHex));

    const signedEvent = await window.nostr.signEvent({
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content
    });
    return await publishToConfiguredRelays(signedEvent);
  },

  followUser: async (targetHex) => NostrAPI.setFollow(targetHex, true),
  unfollowUser: async (targetHex) => NostrAPI.setFollow(targetHex, false),

  updateProfile: async (profile) => {
    if (!window.nostr) throw new Error('NIP-07 拡張機能が見つかりません');
    const myPubkey = await window.nostr.getPublicKey();
    const current = await NostrAPI.getProfile(myPubkey);
    const merged = { ...(current || {}) };
    delete merged.pubkey;
    delete merged._event;

    ['picture', 'banner', 'display_name', 'name', 'about', 'nip05'].forEach(key => {
      const value = profile[key];
      if (value === undefined) return;
      if ((value || '').trim() === '') delete merged[key];
      else merged[key] = value.trim();
    });

    const signedEvent = await window.nostr.signEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(merged)
    });
    return await publishToConfiguredRelays(signedEvent);
  }
};
