import { SimplePool, nip19 } from 'https://esm.sh/nostr-tools@2.7.0';
import { CONFIG } from './config.js';

const pool = new SimplePool();

export const NostrAPI = {
  hexToNpub: (hex) => nip19.npubEncode(hex),
  
  // プロフィール(kind:0)を取得し、JSONパースして返す
  getProfile: async (hex) => {
    const event = await pool.get(CONFIG.DEFAULT_RELAYS, { kinds: [0], authors: [hex] });
    if (!event) return null;
    try {
      return { ...JSON.parse(event.content), pubkey: event.pubkey };
    } catch (e) {
      return null;
    }
  },

  // 複数のプロファイルをまとめて取得 (フォローリスト等で使用)
  getProfilesBatch: async (pubkeys) => {
    const events = await pool.querySync(CONFIG.DEFAULT_RELAYS, { kinds: [0], authors: pubkeys });
    const profiles = {};
    events.forEach(ev => {
      try { profiles[ev.pubkey] = JSON.parse(ev.content); } catch(e){}
    });
    return profiles;
  },

  // NIP-05のバリデーション
  validateNip05: async (nip05, pubkey) => {
    try {
      const [name, domain] = nip05.split('@');
      if (!domain) return false;
      const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
      const data = await res.json();
      return data.names[name] === pubkey;
    } catch (error) {
      return false;
    }
  },

  // 投稿一覧取得
  getPosts: async (hex, until, limit) => {
    const filter = { kinds: [1], authors: [hex], limit: limit };
    if (until) filter.until = until;
    const posts = await pool.querySync(CONFIG.DEFAULT_RELAYS, filter);
    // 時刻降順(新しい順)にソート
    return posts.sort((a, b) => b.created_at - a.created_at);
  },

  // フォローリスト/リレー取得 (kind:3)
  getContactList: async (hex) => {
    return await pool.get(CONFIG.DEFAULT_RELAYS, { kinds: [3], authors: [hex] });
  },

  // ミュートリスト取得 (kind:10000)
  getMuteList: async (hex) => {
    return await pool.get(CONFIG.DEFAULT_RELAYS, { kinds: [10000], authors: [hex] });
  },

  // フォロワー取得 (該当ユーザーをkind:3のタグに含むイベントを検索)
  getFollowers: async (hex) => {
    // 注: クライアントサイドでのフォロワー検索は接続リレーに依存するため、完全ではない場合があります
    const events = await pool.querySync(CONFIG.DEFAULT_RELAYS, { kinds: [3], "#p": [hex], limit: 100 });
    return events.map(ev => ev.pubkey);
  },

  // ユーザーをフォローする (NIP-07)
  followUser: async (targetHex) => {
    if (!window.nostr) throw new Error("NIP-07 拡張機能が見つかりません");
    const myPubkey = await window.nostr.getPublicKey();
    
    // 最新の自分のkind:3を取得（既存のフォローリストを消さないため）
    let myKind3 = await pool.get(CONFIG.DEFAULT_RELAYS, { kinds: [3], authors: [myPubkey] });
    let tags = myKind3 ? myKind3.tags : [];
    let content = myKind3 ? myKind3.content : "";
    
    // 既にフォローしているかチェック
    if (tags.some(t => t[0] === 'p' && t[1] === targetHex)) {
      alert("すでにフォローしています");
      return;
    }

    tags.push(["p", targetHex]);

    const eventTemplate = {
      kind: 3,
      created_at: Math.floor(Date.now() / 1000),
      tags: tags,
      content: content
    };

    const signedEvent = await window.nostr.signEvent(eventTemplate);
    await Promise.any(pool.publish(CONFIG.DEFAULT_RELAYS, signedEvent));
    alert("フォローしました！");
  }
};
