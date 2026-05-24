import { NostrAPI } from './nostr.js';
import { UI } from './ui.js';
import { CONFIG } from './config.js';
import { copyToClipboard } from './utils.js';

// グローバル状態
window.loggedInPubkey = null;
let currentProfileHex = null;
let profileData = null;
let oldestPostTime = null; // ページネーション用

// アプリの初期化
async function init() {
  setupEventListeners();

  // URLからhexを取得
  const urlParams = new URLSearchParams(window.location.search);
  currentProfileHex = urlParams.get('hex');

  if (!currentProfileHex) {
    document.querySelector('.main-content').innerHTML = "<h2 style='padding: 20px;'>URLに ?hex=PUBKEY_HEX を指定してください。</h2>";
    return;
  }

  await loadProfile();
  await loadInitialPosts();
  loadLists(); // 非同期で裏でロード
}

async function loadProfile() {
  profileData = await NostrAPI.getProfile(currentProfileHex);
  const p = profileData || {};

  // 基本情報セット
  document.getElementById('profile-icon').src = p.picture || CONFIG.FALLBACK_ICON;
  document.getElementById('profile-display-name').textContent = p.display_name || p.name || "Unknown";
  document.getElementById('profile-name').textContent = p.name || "";
  document.getElementById('profile-about').textContent = p.about || "";
  
  // バナー
  const banner = document.getElementById('profile-banner');
  if (p.banner) {
    banner.style.backgroundImage = `url('${p.banner}')`;
  } else {
    banner.style.backgroundColor = CONFIG.FALLBACK_BANNER_COLOR;
  }

  // NIP-05
  if (p.nip05) {
    UI.renderNip05(p.nip05, currentProfileHex, document.getElementById('profile-nip05'));
  }

  // コピー機能設定
  const npub = NostrAPI.hexToNpub(currentProfileHex);
  document.getElementById('btn-copy-npub').onclick = () => copyToClipboard(npub);
  document.getElementById('btn-copy-hex').onclick = () => copyToClipboard(currentProfileHex);
}

async function loadInitialPosts() {
  const posts = await NostrAPI.getPosts(currentProfileHex, null, CONFIG.POSTS_PER_PAGE);
  await UI.renderPosts(posts, 'posts-list', profileData);
  
  if (posts.length > 0) {
    oldestPostTime = posts[posts.length - 1].created_at;
    document.getElementById('btn-load-more').classList.remove('hidden');
  }
}

async function loadMorePosts() {
  if (!oldestPostTime) return;
  const btn = document.getElementById('btn-load-more');
  btn.textContent = "読み込み中...";
  
  // oldestPostTimeと同じ時間の投稿が重複しないよう -1 する
  const posts = await NostrAPI.getPosts(currentProfileHex, oldestPostTime - 1, CONFIG.POSTS_PER_PAGE);
  await UI.renderPosts(posts, 'posts-list', profileData);
  
  if (posts.length > 0) {
    oldestPostTime = posts[posts.length - 1].created_at;
    btn.textContent = "さらに読み込む";
  } else {
    btn.classList.add('hidden');
  }
}

async function loadLists() {
  // 1. Follows & Relays (kind 3)
  const contactEvent = await NostrAPI.getContactList(currentProfileHex);
  if (contactEvent) {
    const follows = contactEvent.tags.filter(t => t[0] === 'p').map(t => t[1]);
    UI.renderUserList(follows, 'following-list');
    try {
      const relays = JSON.parse(contactEvent.content);
      UI.renderRelayList(relays, 'relays-list');
    } catch(e) {}
  } else {
    document.getElementById('following-list').innerHTML = "<p style='padding: 15px;'>データなし</p>";
  }

  // 2. Mutes (kind 10000)
  const muteEvent = await NostrAPI.getMuteList(currentProfileHex);
  if (muteEvent) {
    const mutes = muteEvent.tags.filter(t => t[0] === 'p').map(t => t[1]);
    UI.renderUserList(mutes, 'mutes-list');
  } else {
    document.getElementById('mutes-list').innerHTML = "<p style='padding: 15px;'>データなし</p>";
  }

  // 3. Followers (逆引き)
  const followers = await NostrAPI.getFollowers(currentProfileHex);
  UI.renderUserList(followers, 'followers-list');
}

function setupEventListeners() {
  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(btn.getAttribute('data-target')).classList.add('active');
    };
  });

  // さらに読み込むボタン
  document.getElementById('btn-load-more').onclick = loadMorePosts;

  // NIP-07 ログイン
  const loginBtn = document.getElementById('btn-login');
  loginBtn.onclick = async () => {
    if (!window.nostr) {
      alert("NIP-07拡張機能 (nos2x, Alby等) をインストールしてください");
      return;
    }
    try {
      window.loggedInPubkey = await window.nostr.getPublicKey();
      loginBtn.classList.add('hidden');
      const infoDiv = document.getElementById('logged-in-info');
      infoDiv.classList.remove('hidden');
      
      const npub = NostrAPI.hexToNpub(window.loggedInPubkey);
      document.getElementById('logged-in-pubkey').textContent = `Logged in: ${npub.substring(0, 10)}...`;

      // フォローボタンを表示
      const followBtn = document.getElementById('btn-follow-main');
      followBtn.classList.remove('hidden');
      followBtn.onclick = () => NostrAPI.followUser(currentProfileHex);

      // リストの再描画でリスト内フォローボタンを出すため、一旦消して再取得(簡易的実装)
      // 実際はDOM追加だけで良いですが、簡略化のため
    } catch (e) {
      console.error(e);
      alert("ログインに失敗しました");
    }
  };
}

// 起動
document.addEventListener('DOMContentLoaded', init);
