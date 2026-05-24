import { escapeHtml, formatJST } from './utils.js';
import { CONFIG } from './config.js';
import { NostrAPI } from './nostr.js';

export const UI = {
  // NIP-05文字列の横に ✅ または ❌ を付けて返す
  renderNip05: async (nip05, pubkey, containerEl) => {
    if (!nip05) return;
    containerEl.textContent = nip05 + " (検証中...)";
    const isValid = await NostrAPI.validateNip05(nip05, pubkey);
    containerEl.textContent = nip05 + (isValid ? " ✅" : " ❌");
  },

  // 投稿リストの描画
  renderPosts: async (posts, containerId, profile) => {
    const container = document.getElementById(containerId);
    const iconSrc = profile?.picture || CONFIG.FALLBACK_ICON;
    const displayName = escapeHtml(profile?.display_name || profile?.name || "Unknown");

    posts.forEach(post => {
      const div = document.createElement('div');
      div.className = 'post';
      div.innerHTML = `
        <div class="post-header">
          <img src="${escapeHtml(iconSrc)}" class="icon" style="width:32px; height:32px; margin-top:0; margin-right:10px;">
          <strong>${displayName}</strong>
          <span class="post-time">${formatJST(post.created_at)}</span>
        </div>
        <div class="post-content">${escapeHtml(post.content)}</div>
      `;
      container.appendChild(div);
    });
  },

  // ユーザーリスト（フォロー・フォロワー等）の描画
  renderUserList: async (pubkeys, containerId) => {
    const container = document.getElementById(containerId);
    if (pubkeys.length === 0) {
      container.innerHTML = "<p style='padding: 15px;'>ユーザーがいません</p>";
      return;
    }

    // プロファイルを一括取得
    const profiles = await NostrAPI.getProfilesBatch(pubkeys);

    for (const pk of pubkeys) {
      const p = profiles[pk] || {};
      const iconSrc = p.picture || CONFIG.FALLBACK_ICON;
      const dName = escapeHtml(p.display_name || p.name || "Unknown");
      const name = escapeHtml(p.name ? `@${p.name}` : "");
      
      const a = document.createElement('a');
      a.className = 'user-item';
      a.href = `?hex=${pk}`; // クリックでプロフィールへ飛ぶ
      
      a.innerHTML = `
        <img src="${escapeHtml(iconSrc)}" class="icon" alt="icon">
                <div class="user-item-info">
                    <div class="user-item-name">${dName} <span class="nip05-status" data-nip05="${escapeHtml(p.nip05 || '')}" data-pk="${pk}"></span></div>
                    <div class="user-item-handle">${name}</div>
                </div>
            `;
            
            // ログイン済みならリスト内にもフォローボタンを追加 (自分のクリック伝播を防ぐ)
            if (window.loggedInPubkey) {
                const followBtn = document.createElement('button');
                followBtn.className = 'btn btn-outline';
                followBtn.textContent = 'Follow';
                followBtn.onclick = async (e) => {
                    e.preventDefault(); // リンク遷移を防ぐ
                    await NostrAPI.followUser(pk);
                };
                a.appendChild(followBtn);
            }

            container.appendChild(a);
        }

        // NIP-05の非同期検証（リスト描画後に裏で回す）
        container.querySelectorAll('.nip05-status').forEach(async el => {
            const nip05 = el.getAttribute('data-nip05');
            const pk = el.getAttribute('data-pk');
            if (nip05) {
                const isValid = await NostrAPI.validateNip05(nip05, pk);
                el.textContent = isValid ? "✅" : "❌";
            }
        });
    },

    // リレーリストの描画
    renderRelayList: (relaysDict, containerId) => {
        const container = document.getElementById(containerId);
        const relays = Object.keys(relaysDict || {});
        if (relays.length === 0) {
            container.innerHTML = "<p style='padding: 15px;'>設定されていません</p>";
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
