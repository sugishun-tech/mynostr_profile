import { escapeHtml, formatJST } from './utils.js';
import { CONFIG } from './config.js';
import { NostrAPI } from './nostr.js';

function followButtonsFor(pubkey) {
  return [...document.querySelectorAll('[data-follow-pubkey]')]
    .filter(button => button.dataset.followPubkey === pubkey);
}

function applyFollowButtonState(button, isFollowing) {
  button.classList.remove('btn-primary', 'btn-outline');
  button.classList.add(isFollowing ? 'btn-outline' : 'btn-primary');
  button.textContent = isFollowing ? 'アンフォロー' : 'フォロー';
  button.disabled = false;
  button.setAttribute('aria-pressed', isFollowing ? 'true' : 'false');
}

export const UI = {
  renderNip05: async (nip05, pubkey, containerEl) => {
    if (!containerEl) return;
    containerEl.textContent = '';
    if (!nip05) return;
    containerEl.textContent = `${nip05} (検証中...)`;
    const isValid = await NostrAPI.validateNip05(nip05, pubkey);
    containerEl.textContent = nip05 + (isValid ? ' ✅' : ' ❌');
  },

  renderPosts: async (posts, containerId, profile, append = true) => {
    const container = document.getElementById(containerId);
    if (!append) container.innerHTML = '';
    const iconSrc = profile?.picture || CONFIG.FALLBACK_ICON;
    const displayName = escapeHtml(profile?.display_name || profile?.name || 'Unknown');

    if (!posts || posts.length === 0) {
      if (!append) container.innerHTML = "<p class='empty-message'>投稿がありません</p>";
      return;
    }

    posts.forEach(post => {
      const div = document.createElement('div');
      div.className = 'post';
      div.innerHTML = `
        <div class="post-header">
          <img src="${escapeHtml(iconSrc)}" class="post-icon" alt="icon">
          <strong class="post-author">${displayName}</strong>
          <span class="post-time">${formatJST(post.created_at)}</span>
        </div>
        <div class="post-content">${escapeHtml(post.content)}</div>
      `;
      container.appendChild(div);
    });
  },

  renderUserList: async (pubkeys, containerId, options = {}) => {
    const {
      followingSet = new Set(),
      mutualSet = new Set(),
      showMutual = false,
      append = false,
      profiles: suppliedProfiles = null,
      onToggleFollow = null
    } = options;
    const container = document.getElementById(containerId);
    if (!append) container.innerHTML = '';

    const uniquePubkeys = [...new Set(pubkeys || [])].filter(Boolean);
    if (uniquePubkeys.length === 0) {
      if (!append) container.innerHTML = "<p class='empty-message'>ユーザーがいません</p>";
      return;
    }

    const profiles = suppliedProfiles || await NostrAPI.getProfilesBatch(uniquePubkeys);

    for (const pubkey of uniquePubkeys) {
      const profile = profiles[pubkey] || {};
      const isSelf = window.loggedInPubkey === pubkey;
      const isFollowing = followingSet.has(pubkey);

      const row = document.createElement('div');
      row.className = 'user-item';
      row.dataset.pubkey = pubkey;

      const profileLink = document.createElement('a');
      profileLink.className = 'user-item-link';
      profileLink.href = `?hex=${encodeURIComponent(pubkey)}`;

      const icon = document.createElement('img');
      icon.className = 'icon';
      icon.alt = 'icon';
      icon.src = profile.picture || CONFIG.FALLBACK_ICON;
      icon.addEventListener('error', () => {
        icon.src = CONFIG.FALLBACK_ICON;
      }, { once: true });

      const info = document.createElement('div');
      info.className = 'user-item-info';

      const nameLine = document.createElement('div');
      nameLine.className = 'user-item-name';
      nameLine.append(document.createTextNode(profile.display_name || profile.name || 'Unknown'));

      const nip05Status = document.createElement('span');
      nip05Status.className = 'nip05-status';
      nameLine.append(document.createTextNode(' '), nip05Status);

      if (showMutual) {
        const mutualBadge = document.createElement('span');
        mutualBadge.className = 'mutual-badge';
        mutualBadge.dataset.mutualPubkey = pubkey;
        mutualBadge.textContent = '相互';
        mutualBadge.title = '相互フォロー';
        mutualBadge.setAttribute('aria-label', '相互フォロー');
        mutualBadge.classList.toggle('hidden', !mutualSet.has(pubkey));
        nameLine.append(document.createTextNode(' '), mutualBadge);
      }

      const handle = document.createElement('div');
      handle.className = 'user-item-handle';
      handle.textContent = profile.name ? `@${profile.name}` : '';

      info.append(nameLine, handle);
      profileLink.append(icon, info);
      row.appendChild(profileLink);

      if (window.loggedInPubkey && !isSelf && onToggleFollow) {
        const followButton = document.createElement('button');
        followButton.className = 'btn follow-toggle';
        followButton.dataset.followPubkey = pubkey;
        followButton.type = 'button';
        applyFollowButtonState(followButton, isFollowing);
        followButton.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          onToggleFollow(pubkey);
        });
        row.appendChild(followButton);
      }

      container.appendChild(row);

      if (profile.nip05) {
        NostrAPI.validateNip05(profile.nip05, pubkey).then(isValid => {
          if (nip05Status.isConnected) nip05Status.textContent = isValid ? '✅' : '❌';
        });
      }
    }
  },

  renderRelayList: (relaysDictOrArray, containerId, append = false) => {
    const container = document.getElementById(containerId);
    if (!append) container.innerHTML = '';
    const relays = Array.isArray(relaysDictOrArray)
      ? relaysDictOrArray
      : Object.keys(relaysDictOrArray || {});
    if (relays.length === 0) {
      if (!append) container.innerHTML = "<p class='empty-message'>設定されていません</p>";
      return;
    }
    relays.forEach(relay => {
      const div = document.createElement('div');
      div.className = 'relay-item';
      div.textContent = relay;
      container.appendChild(div);
    });
  },

  updateFollowButtons: (pubkey, isFollowing) => {
    followButtonsFor(pubkey).forEach(button => applyFollowButtonState(button, isFollowing));
  },

  setFollowButtonsLoading: (pubkey, isLoading) => {
    followButtonsFor(pubkey).forEach(button => {
      button.disabled = isLoading;
      if (isLoading) button.textContent = '更新中...';
    });
  },

  updateMutualMarks: (pubkey, isMutual) => {
    document.querySelectorAll('[data-mutual-pubkey]').forEach(mark => {
      if (mark.dataset.mutualPubkey === pubkey) {
        mark.classList.toggle('hidden', !isMutual);
      }
    });
  }
};
