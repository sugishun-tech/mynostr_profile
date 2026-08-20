import { SimplePool, nip19 } from 'https://esm.sh/nostr-tools@2.7.0';
import { getConfiguredRelays } from './utils.js';

const pool = new SimplePool();

function latestEvent(events) {
  return [...events].sort((a, b) => b.created_at - a.created_at)[0] || null;
}

async function publishToConfiguredRelays(event) {
  const relays = getConfiguredRelays();
  const results = await Promise.allSettled(pool.publish(relays, event));
  const success = results.filter(r => r.status === 'fulfilled').length;
  if (success === 0) throw new Error('どのリレーにも publish できませんでした');
  return { success, total: relays.length };
}

export const NostrAPI = {
  hexToNpub: (hex) => nip19.npubEncode(hex),

  npubToHex: (npub) => {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') throw new Error('npub形式が不正です');
    return decoded.data;
  },

  getRelays: () => getConfiguredRelays(),

  getProfileEvent: async (hex) => {
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

  getPosts: async (hex, until, limit) => {
    const filter = { kinds: [1], authors: [hex], limit };
    if (until) filter.until = until;
    const posts = await pool.querySync(getConfiguredRelays(), filter);
    const byId = new Map(posts.map(post => [post.id, post]));
    return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
  },

  getContactList: async (hex) => {
    try {
      const events = await pool.querySync(getConfiguredRelays(), { kinds: [3], authors: [hex], limit: 50 });
      return latestEvent(events);
    } catch (e) {
      console.warn('contact list fetch failed', e);
      return null;
    }
  },

  getMuteList: async (hex) => {
    try {
      return await pool.get(getConfiguredRelays(), { kinds: [10000], authors: [hex] });
    } catch (e) {
      console.warn('mute list fetch failed', e);
      return null;
    }
  },

  getFollowers: async (hex) => {
    try {
      const events = await pool.querySync(getConfiguredRelays(), { kinds: [3], '#p': [hex], limit: 200 });
      return [...new Set(events.map(ev => ev.pubkey))];
    } catch (e) {
      console.warn('followers fetch failed', e);
      return [];
    }
  },

  getFollowersPage: async (hex, until = null, limit = 30, excludePubkeys = []) => {
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
