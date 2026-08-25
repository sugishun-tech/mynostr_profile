import { NostrAPI } from './nostr.js?v=2026082502';
import { UI } from './ui.js?v=2026082502';
import { CONFIG } from './config.js?v=2026082502';
import {
  copyToClipboard,
  getConfiguredRelays,
  parseRelayText,
  resetConfiguredRelays,
  saveConfiguredRelays
} from './utils.js?v=2026082502';

const LAST_LOGIN_PUBKEY_KEY = 'nostr_profile_viewer_last_login_pubkey';

window.loggedInPubkey = null;
let currentProfileHex = null;
let profileData = null;
let listLoadToken = 0;

const postsState = {
  cursor: null,
  loadedIds: new Set(),
  loading: false,
  exhausted: false
};

const loggedInFollowingSet = new Set();
const currentProfileFollowingSet = new Set();
const currentProfileFollowerSet = new Set();
const pendingFollowPubkeys = new Set();

const localListStates = {
  following: {
    items: [],
    offset: 0,
    loading: false,
    containerId: 'following-list',
    buttonId: 'btn-load-more-following',
    showMutual: true
  },
  mutes: {
    items: [],
    offset: 0,
    loading: false,
    containerId: 'mutes-list',
    buttonId: 'btn-load-more-mutes',
    showMutual: false
  },
  relays: {
    items: [],
    offset: 0,
    loading: false,
    containerId: 'relays-list',
    buttonId: 'btn-load-more-relays'
  }
};

const followersState = {
  cursor: null,
  loadedPubkeys: new Set(),
  loading: false,
  exhausted: false,
  containerId: 'followers-list',
  buttonId: 'btn-load-more-followers'
};

async function init() {
  setupEventListeners();
  renderSettingsView();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('settings') === '1') {
    showSettingsPage();
    try {
      await NostrAPI.ready();
      restoreSavedLoginPubkey();
    } catch (error) {
      console.warn('nostr runtime unavailable on settings page', error);
    }
    return;
  }

  try {
    await NostrAPI.ready();
    restoreSavedLoginPubkey();

    const resolvedHex = await resolveProfileHex(urlParams);
    if (!resolvedHex) {
      showOwnProfileLoginPrompt();
      return;
    }

    if (window.loggedInPubkey) {
      await refreshLoggedInFollowingSet();
    }

    await loadProfilePage(resolvedHex);
  } catch (error) {
    console.error('application initialization failed', error);
    showInitializationError();
  }
}

function showInitializationError() {
  document.getElementById('settings-page')?.classList.add('hidden');
  document.getElementById('profile-page')?.classList.add('hidden');

  const startPage = document.getElementById('start-page');
  if (!startPage) return;
  startPage.innerHTML = `
    <div class="message-card">
      <h2>アプリケーションを読み込めませんでした</h2>
      <p>Nostrライブラリの取得に失敗しました。ネットワーク設定やコンテンツブロッカーを確認して再読み込みしてください。</p>
    </div>
  `;
  startPage.classList.remove('hidden');
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
    const pubkey = await tryGetLoggedInPubkey(false);
    if (pubkey) return pubkey;
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
  } catch (error) {
    console.warn('getPublicKey failed', error);
    if (showError) {
      alert(error?.message ? `ログインに失敗しました: ${error.message}` : 'ログインに失敗しました');
    }
    return null;
  }
}

function restoreSavedLoginPubkey() {
  const saved = localStorage.getItem(LAST_LOGIN_PUBKEY_KEY) || '';
  if (!/^[0-9a-f]{64}$/i.test(saved)) return;
  window.loggedInPubkey = saved.toLowerCase();
  renderLoggedInState();
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
      const pubkey = await tryGetLoggedInPubkey(true);
      if (!pubkey) return;
      await refreshLoggedInFollowingSet();
      history.replaceState(null, '', '?view=me');
      startPage?.classList.add('hidden');
      profilePage?.classList.remove('hidden');
      await loadProfilePage(pubkey);
    } finally {
      btn.disabled = false;
      btn.textContent = 'ログインして自分のプロフィールを表示';
    }
  };
}

async function loadProfilePage(hex) {
  currentProfileHex = hex;
  resetPostsState();

  document.getElementById('settings-page')?.classList.add('hidden');
  document.getElementById('start-page')?.classList.add('hidden');
  document.getElementById('profile-page')?.classList.remove('hidden');

  await loadProfile();
  await loadInitialPosts();
  void loadLists();
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
  const profile = profileData || {};

  const icon = document.getElementById('profile-icon');
  icon.src = profile.picture || CONFIG.FALLBACK_ICON;
  icon.onerror = () => { icon.src = CONFIG.FALLBACK_ICON; };

  document.getElementById('profile-display-name').textContent = profile.display_name || profile.name || 'Unknown';
  document.getElementById('profile-name').textContent = profile.name || '';
  const aboutEl = document.getElementById('profile-about');
  aboutEl.textContent = profile.about || '';
  setupAboutExpansion();

  const banner = document.getElementById('profile-banner');
  banner.style.backgroundImage = '';
  if (profile.banner) {
    banner.style.backgroundImage = `url('${profile.banner.replace(/'/g, '%27')}')`;
  } else {
    banner.style.backgroundColor = CONFIG.FALLBACK_BANNER_COLOR;
  }

  await UI.renderNip05(profile.nip05, currentProfileHex, document.getElementById('profile-nip05'));

  const npub = NostrAPI.hexToNpub(currentProfileHex);
  document.getElementById('btn-copy-npub').onclick = () => copyToClipboard(npub);
  document.getElementById('btn-copy-hex').onclick = () => copyToClipboard(currentProfileHex);

  await updateProfileActionButtons();
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

function resetPostsState() {
  postsState.cursor = null;
  postsState.loadedIds.clear();
  postsState.loading = false;
  postsState.exhausted = false;
}

function setPostsPaginationButton(hasMore, loading = false) {
  const button = document.getElementById('btn-load-more');
  button.classList.toggle('hidden', !hasMore && !loading);
  button.disabled = loading;
  button.textContent = loading ? '読み込み中...' : 'さらに読み込む';
}

async function loadInitialPosts() {
  const list = document.getElementById('posts-list');
  list.innerHTML = '';
  resetPostsState();
  setPostsPaginationButton(false);

  try {
    const page = await NostrAPI.getPostsPage(
      currentProfileHex,
      null,
      CONFIG.POSTS_PER_PAGE,
      postsState.loadedIds
    );

    await UI.renderPosts(page.posts, 'posts-list', profileData, false);
    for (const post of page.posts) postsState.loadedIds.add(post.id);
    postsState.cursor = page.nextUntil;
    postsState.exhausted = !page.hasMore;
    setPostsPaginationButton(page.hasMore);
  } catch (error) {
    console.error('initial post page load failed', error);
    postsState.exhausted = true;
    setPostsPaginationButton(false);
    list.innerHTML = "<p class='empty-message'>投稿の読み込みに失敗しました</p>";
  }
}

async function loadMorePosts() {
  if (postsState.loading || postsState.exhausted || postsState.cursor === null) return;

  postsState.loading = true;
  setPostsPaginationButton(true, true);

  try {
    const page = await NostrAPI.getPostsPage(
      currentProfileHex,
      postsState.cursor,
      CONFIG.POSTS_PER_PAGE,
      postsState.loadedIds
    );

    await UI.renderPosts(page.posts, 'posts-list', profileData, true);
    for (const post of page.posts) postsState.loadedIds.add(post.id);

    postsState.cursor = page.nextUntil;
    postsState.exhausted = !page.hasMore || page.posts.length === 0;
    setPostsPaginationButton(!postsState.exhausted);
  } catch (error) {
    console.error('post page load failed', error);
    setPostsPaginationButton(true);
    alert('投稿の読み込みに失敗しました');
  } finally {
    postsState.loading = false;
  }
}

function replaceSet(target, values) {
  target.clear();
  for (const value of values || []) target.add(value);
}

function uniqueValues(values) {
  return [...new Set(values || [])].filter(Boolean);
}

function setContainerMessage(containerId, message) {
  const container = document.getElementById(containerId);
  if (container) container.innerHTML = `<p class="message">${message}</p>`;
}

function setPaginationButton(buttonId, hasMore, loading = false) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  button.classList.toggle('hidden', !hasMore && !loading);
  button.disabled = loading;
  button.textContent = loading ? '読み込み中...' : 'さらに読み込む';
}

function resetListStates() {
  for (const state of Object.values(localListStates)) {
    state.items = [];
    state.offset = 0;
    state.loading = false;
    setContainerMessage(state.containerId, '読み込み中...');
    setPaginationButton(state.buttonId, false);
  }

  followersState.cursor = null;
  followersState.loadedPubkeys.clear();
  followersState.loading = false;
  followersState.exhausted = false;
  setContainerMessage(followersState.containerId, '読み込み中...');
  setPaginationButton(followersState.buttonId, false);

  currentProfileFollowingSet.clear();
  currentProfileFollowerSet.clear();
}

async function loadLists() {
  const token = ++listLoadToken;
  resetListStates();

  const [contactEvent, muteEvent] = await Promise.all([
    NostrAPI.getContactList(currentProfileHex),
    NostrAPI.getMuteList(currentProfileHex)
  ]);
  if (token !== listLoadToken) return;

  if (contactEvent) {
    localListStates.following.items = uniqueValues(
      contactEvent.tags.filter(tag => tag[0] === 'p').map(tag => tag[1])
    );
    replaceSet(currentProfileFollowingSet, localListStates.following.items);

    try {
      const relays = JSON.parse(contactEvent.content || '{}');
      localListStates.relays.items = Array.isArray(relays)
        ? uniqueValues(relays)
        : uniqueValues(Object.keys(relays || {}));
    } catch (error) {
      console.warn('relay list parse failed', error);
      localListStates.relays.items = [];
    }
  }

  if (muteEvent) {
    localListStates.mutes.items = uniqueValues(
      muteEvent.tags.filter(tag => tag[0] === 'p').map(tag => tag[1])
    );
  }

  await Promise.all([
    loadMoreLocalUserList('following', token),
    loadMoreFollowers(token),
    loadMoreLocalUserList('mutes', token)
  ]);
  if (token !== listLoadToken) return;
  loadMoreRelays(token);
}

async function loadMoreLocalUserList(listName, token = listLoadToken) {
  const state = localListStates[listName];
  if (!state || state.loading || token !== listLoadToken) return;

  const page = state.items.slice(
    state.offset,
    state.offset + CONFIG.LIST_ITEMS_PER_PAGE
  );
  const append = state.offset > 0;

  if (page.length === 0) {
    await UI.renderUserList([], state.containerId, { append });
    setPaginationButton(state.buttonId, false);
    return;
  }

  state.loading = true;
  if (append) setPaginationButton(state.buttonId, true, true);

  try {
    const [profiles, mutualSet] = await Promise.all([
      NostrAPI.getProfilesBatch(page),
      listName === 'following'
        ? NostrAPI.getFollowingBackSet(currentProfileHex, page)
        : Promise.resolve(new Set())
    ]);
    if (token !== listLoadToken) return;

    for (const pubkey of mutualSet) currentProfileFollowerSet.add(pubkey);

    await UI.renderUserList(page, state.containerId, {
      followingSet: loggedInFollowingSet,
      mutualSet,
      showMutual: state.showMutual,
      append,
      profiles,
      onToggleFollow: toggleFollow
    });
    state.offset += page.length;
    setPaginationButton(state.buttonId, state.offset < state.items.length);
  } catch (error) {
    console.error(`${listName} page load failed`, error);
    if (!append) setContainerMessage(state.containerId, '読み込みに失敗しました');
    setPaginationButton(state.buttonId, state.offset < state.items.length);
  } finally {
    if (token === listLoadToken) state.loading = false;
  }
}

async function loadMoreFollowers(token = listLoadToken) {
  const state = followersState;
  if (state.loading || state.exhausted || token !== listLoadToken) return;

  const append = state.loadedPubkeys.size > 0;
  state.loading = true;
  if (append) setPaginationButton(state.buttonId, true, true);

  try {
    const pageResult = await NostrAPI.getFollowersPage(
      currentProfileHex,
      state.cursor,
      CONFIG.LIST_ITEMS_PER_PAGE,
      state.loadedPubkeys
    );
    if (token !== listLoadToken) return;

    const page = uniqueValues(pageResult.pubkeys)
      .filter(pubkey => !state.loadedPubkeys.has(pubkey));
    const profiles = page.length > 0
      ? await NostrAPI.getProfilesBatch(page)
      : {};
    if (token !== listLoadToken) return;

    const mutualSet = new Set(
      page.filter(pubkey => currentProfileFollowingSet.has(pubkey))
    );

    for (const pubkey of page) {
      state.loadedPubkeys.add(pubkey);
      currentProfileFollowerSet.add(pubkey);
      if (currentProfileFollowingSet.has(pubkey)) {
        UI.updateMutualMarks(pubkey, true);
      }
    }

    await UI.renderUserList(page, state.containerId, {
      followingSet: loggedInFollowingSet,
      mutualSet,
      showMutual: true,
      append,
      profiles,
      onToggleFollow: toggleFollow
    });

    state.cursor = pageResult.nextUntil;
    state.exhausted = !pageResult.hasMore;
    setPaginationButton(state.buttonId, !state.exhausted);
  } catch (error) {
    console.error('followers page load failed', error);
    if (!append) setContainerMessage(state.containerId, '読み込みに失敗しました');
    setPaginationButton(state.buttonId, true);
  } finally {
    if (token === listLoadToken) state.loading = false;
  }
}

function loadMoreRelays(token = listLoadToken) {
  const state = localListStates.relays;
  if (state.loading || token !== listLoadToken) return;

  const page = state.items.slice(
    state.offset,
    state.offset + CONFIG.LIST_ITEMS_PER_PAGE
  );
  const append = state.offset > 0;

  UI.renderRelayList(page, state.containerId, append);
  state.offset += page.length;
  setPaginationButton(state.buttonId, state.offset < state.items.length);
}

async function refreshLoggedInFollowingSet() {
  if (!window.loggedInPubkey) {
    loggedInFollowingSet.clear();
    return;
  }

  try {
    const following = await NostrAPI.getFollowingSet(window.loggedInPubkey);
    replaceSet(loggedInFollowingSet, following);
  } catch (error) {
    console.warn('following list load failed after login', error);
    loggedInFollowingSet.clear();
  }
}

async function toggleFollow(targetHex) {
  if (!window.loggedInPubkey || !targetHex || pendingFollowPubkeys.has(targetHex)) return;

  const wasFollowing = loggedInFollowingSet.has(targetHex);
  const shouldFollow = !wasFollowing;
  pendingFollowPubkeys.add(targetHex);
  UI.setFollowButtonsLoading(targetHex, true);

  try {
    await NostrAPI.setFollow(targetHex, shouldFollow);

    if (shouldFollow) loggedInFollowingSet.add(targetHex);
    else loggedInFollowingSet.delete(targetHex);
    UI.updateFollowButtons(targetHex, shouldFollow);

    if (window.loggedInPubkey === currentProfileHex) {
      if (shouldFollow) currentProfileFollowingSet.add(targetHex);
      else currentProfileFollowingSet.delete(targetHex);
      UI.updateMutualMarks(
        targetHex,
        shouldFollow && currentProfileFollowerSet.has(targetHex)
      );
    }
  } catch (error) {
    UI.updateFollowButtons(targetHex, wasFollowing);
    alert(error.message || 'フォロー状態の更新に失敗しました');
  } finally {
    pendingFollowPubkeys.delete(targetHex);
  }
}

async function updateProfileActionButtons() {
  const followBtn = document.getElementById('btn-follow-main');
  const editBtn = document.getElementById('btn-edit-profile');
  followBtn.classList.add('hidden');
  editBtn.classList.add('hidden');
  followBtn.onclick = null;
  delete followBtn.dataset.followPubkey;

  if (!window.loggedInPubkey || !currentProfileHex) return;

  if (window.loggedInPubkey === currentProfileHex) {
    editBtn.classList.remove('hidden');
    editBtn.onclick = openEditModal;
    return;
  }

  let isFollowing = loggedInFollowingSet.has(currentProfileHex);
  if (!isFollowing) {
    try {
      isFollowing = await NostrAPI.isFollowing(window.loggedInPubkey, currentProfileHex);
      if (isFollowing) loggedInFollowingSet.add(currentProfileHex);
    } catch (error) {
      console.warn('profile follow status check failed', error);
    }
  }

  followBtn.dataset.followPubkey = currentProfileHex;
  followBtn.classList.remove('hidden');
  UI.updateFollowButtons(currentProfileHex, isFollowing);
  followBtn.onclick = () => toggleFollow(currentProfileHex);
}

function openEditModal() {
  const profile = profileData || {};
  document.getElementById('edit-picture').value = profile.picture || '';
  document.getElementById('edit-banner').value = profile.banner || '';
  document.getElementById('edit-display-name').value = profile.display_name || '';
  document.getElementById('edit-name').value = profile.name || '';
  document.getElementById('edit-nip05').value = profile.nip05 || '';
  document.getElementById('edit-about').value = profile.about || '';
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
  } catch (error) {
    alert(error.message || 'プロフィール保存に失敗しました');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存してリレーへ送信';
  }
}

function setupEventListeners() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(tab => tab.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.getAttribute('data-target')).classList.add('active');
    };
  });

  document.getElementById('btn-load-more').onclick = loadMorePosts;
  document.getElementById('btn-load-more-following').onclick = () => loadMoreLocalUserList('following');
  document.getElementById('btn-load-more-followers').onclick = () => loadMoreFollowers();
  document.getElementById('btn-load-more-mutes').onclick = () => loadMoreLocalUserList('mutes');
  document.getElementById('btn-load-more-relays').onclick = () => loadMoreRelays();

  const myProfileBtn = document.getElementById('btn-open-my-profile');
  if (myProfileBtn) {
    myProfileBtn.onclick = async () => {
      const pubkey = await tryGetLoggedInPubkey(true);
      if (!pubkey) return;
      await refreshLoggedInFollowingSet();
      history.replaceState(null, '', '?view=me');
      await loadProfilePage(pubkey);
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
  document.getElementById('profile-edit-modal').onclick = event => {
    if (event.target.id === 'profile-edit-modal') closeEditModal();
  };

  const loginBtn = document.getElementById('btn-login');
  loginBtn.onclick = async () => {
    const pubkey = await tryGetLoggedInPubkey(true);
    if (!pubkey) return;

    // ログイン自体と、リレーからのフォローリスト取得を分離する。
    // リレーが落ちているだけでログイン失敗扱いにするのは、UIとして普通に地雷。
    await refreshLoggedInFollowingSet();

    if (!currentProfileHex) {
      history.replaceState(null, '', '?view=me');
      await loadProfilePage(pubkey);
      return;
    }

    await updateProfileActionButtons();
    void loadLists();
  };
}

document.addEventListener('DOMContentLoaded', init);
