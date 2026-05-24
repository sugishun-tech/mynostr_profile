import { NostrAPI } from './nostr.js';
import { UI } from './ui.js';
import { CONFIG } from './config.js';
import {
  copyToClipboard,
  getConfiguredRelays,
  parseRelayText,
  resetConfiguredRelays,
  saveConfiguredRelays
} from './utils.js';

const LAST_LOGIN_PUBKEY_KEY = 'nostr_profile_viewer_last_login_pubkey';

window.loggedInPubkey = null;
let currentProfileHex = null;
let profileData = null;
let oldestPostTime = null;
let loggedInFollowingSet = new Set();
let profilePageLoaded = false;

async function init() {
  setupEventListeners();
  renderSettingsView();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('settings') === '1') {
    showSettingsPage();
    return;
  }

  const resolvedHex = await resolveProfileHex(urlParams);
  if (!resolvedHex) {
    showOwnProfileLoginPrompt();
    return;
  }

  await loadProfilePage(resolvedHex);
}

async function resolveProfileHex(urlParams) {
  const explicitHex = urlParams.get('hex');
  if (explicitHex) return explicitHex;

  const explicitNpub = urlParams.get('npub');
  if (explicitNpub) return NostrAPI.npubToHex(explicitNpub);

  const view = urlParams.get('view');
  const wantsMe = view === 'me' || urlParams.get('me') === '1';

  // ?view=me は「ログイン中の自分」を明示するルート。
  // ?hex は他人を見るために残す。クエリがない場合も、NIP-07 が許せば自分を開く。
  if (wantsMe || !explicitHex) {
    const pk = await tryGetLoggedInPubkey(false);
    if (pk) return pk;
  }

  return null;
}

async function tryGetLoggedInPubkey(showError = true) {
  if (window.loggedInPubkey) return window.loggedInPubkey;
  if (!window.nostr) {
    if (showError) alert('NIP-07拡張機能 (nos2x, Alby等) をインストールしてください');
    return null;
  }
  try {
    window.loggedInPubkey = await window.nostr.getPublicKey();
    localStorage.setItem(LAST_LOGIN_PUBKEY_KEY, window.loggedInPubkey);
    renderLoggedInState();
    return window.loggedInPubkey;
  } catch (e) {
    console.warn('getPublicKey failed', e);
    if (showError) alert(e?.message ? `ログインに失敗しました: ${e.message}` : 'ログインに失敗しました');
    return null;
  }
}

function renderLoggedInState() {
  const loginBtn = document.getElementById('btn-login');
  if (window.loggedInPubkey && loginBtn) loginBtn.classList.add('hidden');

  const infoDiv = document.getElementById('logged-in-info');
  if (window.loggedInPubkey && infoDiv) {
    infoDiv.classList.remove('hidden');
    const npub = NostrAPI.hexToNpub(window.loggedInPubkey);
    document.getElementById('logged-in-pubkey').textContent = `Logged in: ${npub.substring(0, 10)}...`;
  }
}

function showOwnProfileLoginPrompt() {
  const startPage = document.getElementById('start-page');
  const profilePage = document.getElementById('profile-page');
  const settingsPage = document.getElementById('settings-page');

  settingsPage?.classList.add('hidden');
  profilePage?.classList.add('hidden');
  startPage?.classList.remove('hidden');

  const btn = document.getElementById('btn-open-my-profile');
  if (!btn) return;

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'ログイン中...';
    try {
      const pk = await tryGetLoggedInPubkey(true);
      if (!pk) return;
      await refreshLoggedInFollowingSet();
      history.replaceState(null, '', '?view=me');
      startPage?.classList.add('hidden');
      profilePage?.classList.remove('hidden');
      await loadProfilePage(pk);
    } finally {
      btn.disabled = false;
      btn.textContent = 'ログインして自分のプロフィールを表示';
    }
  };
}

async function loadProfilePage(hex) {
  currentProfileHex = hex;
  profilePageLoaded = true;
  oldestPostTime = null;

  document.getElementById('settings-page')?.classList.add('hidden');
  document.getElementById('start-page')?.classList.add('hidden');
  document.getElementById('profile-page')?.classList.remove('hidden');

  await loadProfile();
  await loadInitialPosts();
  loadLists();
}

function showSettingsPage() {
  document.getElementById('settings-page').classList.remove('hidden');
  document.getElementById('profile-page').classList.add('hidden');
  document.getElementById('start-page')?.classList.add('hidden');
  document.getElementById('nav-settings')?.classList.add('active');
}

function renderSettingsView() {
  const relays = getConfiguredRelays();
  const input = document.getElementById('relay-settings-input');
  if (input) input.value = relays.join('\n');
  UI.renderRelayList(relays, 'active-relays-list');
}

async function loadProfile() {
  profileData = await NostrAPI.getProfile(currentProfileHex);
  const p = profileData || {};

  const icon = document.getElementById('profile-icon');
  icon.src = p.picture || CONFIG.FALLBACK_ICON;
  icon.onerror = () => { icon.src = CONFIG.FALLBACK_ICON; };

  document.getElementById('profile-display-name').textContent = p.display_name || p.name || 'Unknown';
  document.getElementById('profile-name').textContent = p.name || '';
  const aboutEl = document.getElementById('profile-about');
  aboutEl.textContent = p.about || '';
  setupAboutExpansion();
  
  const banner = document.getElementById('profile-banner');
  banner.style.backgroundImage = '';
  if (p.banner) {
    banner.style.backgroundImage = `url('${p.banner.replace(/'/g, "%27")}')`;
  } else {
    banner.style.backgroundColor = CONFIG.FALLBACK_BANNER_COLOR;
  }

  await UI.renderNip05(p.nip05, currentProfileHex, document.getElementById('profile-nip05'));

  const npub = NostrAPI.hexToNpub(currentProfileHex);
  document.getElementById('btn-copy-npub').onclick = () => copyToClipboard(npub);
  document.getElementById('btn-copy-hex').onclick = () => copyToClipboard(currentProfileHex);

  updateProfileActionButtons();
}

function setupAboutExpansion() {
  const aboutEl = document.getElementById('profile-about');
  const btn = document.getElementById('btn-about-more');
  aboutEl.classList.add('collapsed');
  aboutEl.classList.remove('expanded');
  btn.textContent = 'view more';
  btn.classList.add('hidden');

  requestAnimationFrame(() => {
    if (aboutEl.scrollHeight > aboutEl.clientHeight + 2) {
      btn.classList.remove('hidden');
    }
  });

  btn.onclick = () => {
    const expanded = aboutEl.classList.toggle('expanded');
    aboutEl.classList.toggle('collapsed', !expanded);
    btn.textContent = expanded ? 'view less' : 'view more';
  };
}

async function loadInitialPosts() {
  const list = document.getElementById('posts-list');
  list.innerHTML = '';
  document.getElementById('btn-load-more').classList.add('hidden');

  const posts = await NostrAPI.getPosts(currentProfileHex, null, CONFIG.POSTS_PER_PAGE);
  await UI.renderPosts(posts, 'posts-list', profileData, false);
  
  if (posts.length > 0) {
    oldestPostTime = posts[posts.length - 1].created_at;
    document.getElementById('btn-load-more').classList.remove('hidden');
  }
}

async function loadMorePosts() {
  if (!oldestPostTime) return;
  const btn = document.getElementById('btn-load-more');
  btn.textContent = '読み込み中...';
  btn.disabled = true;
  
  const posts = await NostrAPI.getPosts(currentProfileHex, oldestPostTime - 1, CONFIG.POSTS_PER_PAGE);
  await UI.renderPosts(posts, 'posts-list', profileData, true);
  
  if (posts.length > 0) {
    oldestPostTime = posts[posts.length - 1].created_at;
    btn.textContent = 'さらに読み込む';
    btn.disabled = false;
  } else {
    btn.classList.add('hidden');
  }
}

async function loadLists() {
  const contactEvent = await NostrAPI.getContactList(currentProfileHex);
  if (contactEvent) {
    const follows = contactEvent.tags.filter(t => t[0] === 'p').map(t => t[1]);
    UI.renderUserList(follows, 'following-list', loggedInFollowingSet);
    try {
      const relays = JSON.parse(contactEvent.content || '{}');
      UI.renderRelayList(relays, 'relays-list');
    } catch(e) {
      UI.renderRelayList([], 'relays-list');
    }
  } else {
    document.getElementById('following-list').innerHTML = "<p class='empty-message'>データなし</p>";
    UI.renderRelayList([], 'relays-list');
  }

  const muteEvent = await NostrAPI.getMuteList(currentProfileHex);
  if (muteEvent) {
    const mutes = muteEvent.tags.filter(t => t[0] === 'p').map(t => t[1]);
    UI.renderUserList(mutes, 'mutes-list', loggedInFollowingSet);
  } else {
    document.getElementById('mutes-list').innerHTML = "<p class='empty-message'>データなし</p>";
  }

  const followers = await NostrAPI.getFollowers(currentProfileHex);
  UI.renderUserList(followers, 'followers-list', loggedInFollowingSet);
}

async function refreshLoggedInFollowingSet() {
  if (!window.loggedInPubkey) {
    loggedInFollowingSet = new Set();
    return;
  }
  try {
    loggedInFollowingSet = await NostrAPI.getFollowingSet(window.loggedInPubkey);
  } catch (e) {
    console.warn('following list load failed after login', e);
    loggedInFollowingSet = new Set();
  }
}

async function updateProfileActionButtons() {
  const followBtn = document.getElementById('btn-follow-main');
  const editBtn = document.getElementById('btn-edit-profile');
  followBtn.classList.add('hidden');
  editBtn.classList.add('hidden');

  if (!window.loggedInPubkey || !currentProfileHex) return;

  if (window.loggedInPubkey === currentProfileHex) {
    editBtn.classList.remove('hidden');
    editBtn.onclick = openEditModal;
    return;
  }

  const isFollowing = loggedInFollowingSet.has(currentProfileHex) || await NostrAPI.isFollowing(window.loggedInPubkey, currentProfileHex);
  followBtn.classList.remove('hidden');
  followBtn.className = isFollowing ? 'btn btn-outline' : 'btn btn-primary';
  followBtn.textContent = isFollowing ? 'Unfollow' : 'Follow';
  followBtn.onclick = async () => {
    followBtn.disabled = true;
    try {
      if (isFollowing) await NostrAPI.unfollowUser(currentProfileHex);
      else await NostrAPI.followUser(currentProfileHex);
      await refreshLoggedInFollowingSet();
      await updateProfileActionButtons();
      loadLists();
    } catch (e) {
      alert(e.message || 'フォロー状態の更新に失敗しました');
    } finally {
      followBtn.disabled = false;
    }
  };
}

function openEditModal() {
  const p = profileData || {};
  document.getElementById('edit-picture').value = p.picture || '';
  document.getElementById('edit-banner').value = p.banner || '';
  document.getElementById('edit-display-name').value = p.display_name || '';
  document.getElementById('edit-name').value = p.name || '';
  document.getElementById('edit-nip05').value = p.nip05 || '';
  document.getElementById('edit-about').value = p.about || '';
  document.getElementById('profile-edit-modal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('profile-edit-modal').classList.add('hidden');
}

async function saveProfile() {
  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true;
  btn.textContent = '送信中...';
  try {
    await NostrAPI.updateProfile({
      picture: document.getElementById('edit-picture').value,
      banner: document.getElementById('edit-banner').value,
      display_name: document.getElementById('edit-display-name').value,
      name: document.getElementById('edit-name').value,
      nip05: document.getElementById('edit-nip05').value,
      about: document.getElementById('edit-about').value
    });
    closeEditModal();
    await loadProfile();
    alert('プロフィールを保存しました');
  } catch (e) {
    alert(e.message || 'プロフィール保存に失敗しました');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存してリレーへ送信';
  }
}

function setupEventListeners() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.getAttribute('data-target')).classList.add('active');
    };
  });

  document.getElementById('btn-load-more').onclick = loadMorePosts;

  const myProfileBtn = document.getElementById('btn-open-my-profile');
  if (myProfileBtn) {
    myProfileBtn.onclick = async () => {
      const pk = await tryGetLoggedInPubkey(true);
      if (!pk) return;
      await refreshLoggedInFollowingSet();
      history.replaceState(null, '', '?view=me');
      await loadProfilePage(pk);
    };
  }

  document.getElementById('btn-save-relays').onclick = () => {
    const relays = parseRelayText(document.getElementById('relay-settings-input').value);
    saveConfiguredRelays(relays);
    renderSettingsView();
    alert('リレー設定を保存しました');
  };

  document.getElementById('btn-reset-relays').onclick = () => {
    resetConfiguredRelays();
    renderSettingsView();
    alert('デフォルトリレーに戻しました');
  };

  document.getElementById('btn-close-edit').onclick = closeEditModal;
  document.getElementById('btn-save-profile').onclick = saveProfile;
  document.getElementById('profile-edit-modal').onclick = (e) => {
    if (e.target.id === 'profile-edit-modal') closeEditModal();
  };

  const loginBtn = document.getElementById('btn-login');
  loginBtn.onclick = async () => {
    const pk = await tryGetLoggedInPubkey(true);
    if (!pk) return;

    // ログイン自体と、リレーからのフォローリスト取得を分離する。
    // リレーが落ちているだけでログイン失敗扱いにするのは、UIとして普通に地雷。
    await refreshLoggedInFollowingSet();

    if (!currentProfileHex) {
      history.replaceState(null, '', '?view=me');
      await loadProfilePage(pk);
      return;
    }

    await updateProfileActionButtons();
    loadLists();
  };
}

document.addEventListener('DOMContentLoaded', init);
