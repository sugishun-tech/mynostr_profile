import { escapeHtml, formatJST } from './utils.js';
import { CONFIG } from './config.js';
import { NostrAPI } from './nostr.js';

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

  renderUserList: async (pubkeys, containerId, followingSet = new Set()) => {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const uniquePubkeys = [...new Set(pubkeys || [])].filter(Boolean);
    if (uniquePubkeys.length === 0) {
      container.innerHTML = "<p class='empty-message'>ユーザーがいません</p>";
      return;
    }

    const profiles = await NostrAPI.getProfilesBatch(uniquePubkeys);

    for (const pk of uniquePubkeys) {
      const p = profiles[pk] || {};
      const iconSrc = p.picture || CONFIG.FALLBACK_ICON;
      const dName = escapeHtml(p.display_name || p.name || 'Unknown');
      const name = escapeHtml(p.name ? `@${p.name}` : '');
      const isSelf = window.loggedInPubkey === pk;
      const isFollowing = followingSet.has(pk);
      
      const a = document.createElement('a');
      a.className = 'user-item';
      a.href = `?hex=${encodeURIComponent(pk)}`;
      a.innerHTML = `
        <img src="${escapeHtml(iconSrc)}" class="icon" alt="icon">
        <div class="user-item-info">
          <div class="user-item-name">${dName} <span class="nip05-status" data-nip05="${escapeHtml(p.nip05 || '')}" data-pk="${pk}"></span></div>
          <div class="user-item-handle">${name}</div>
        </div>
      `;
            
      if (window.loggedInPubkey && !isSelf) {
        const followBtn = document.createElement('button');
        followBtn.className = isFollowing ? 'btn btn-outline' : 'btn btn-primary';
        followBtn.textContent = isFollowing ? 'Unfollow' : 'Follow';
        followBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          followBtn.disabled = true;
          try {
            if (isFollowing) await NostrAPI.unfollowUser(pk);
            else await NostrAPI.followUser(pk);
            location.reload();
          } catch (err) {
            alert(err.message || '更新に失敗しました');
            followBtn.disabled = false;
          }
        };
        a.appendChild(followBtn);
      }

      container.appendChild(a);
    }

    container.querySelectorAll('.nip05-status').forEach(async el => {
      const nip05 = el.getAttribute('data-nip05');
      const pk = el.getAttribute('data-pk');
      if (nip05) {
        const isValid = await NostrAPI.validateNip05(nip05, pk);
        el.textContent = isValid ? '✅' : '❌';
      }
    });
  },

  renderRelayList: (relaysDictOrArray, containerId) => {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const relays = Array.isArray(relaysDictOrArray) ? relaysDictOrArray : Object.keys(relaysDictOrArray || {});
    if (relays.length === 0) {
      container.innerHTML = "<p class='empty-message'>設定されていません</p>";
      return;
    }
    relays.forEach(r => {
      const div = document.createElement('div');
      div.className = 'relay-item';
      div.textContent = r;
      container.appendChild(div);
    });
  }
};
