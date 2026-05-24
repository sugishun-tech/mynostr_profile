export function formatJST(unixTimestamp) {
  const d = new Date(unixTimestamp * 1000);
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  // 2016/04/06 01:23:54 -> 2016-04-06 01:23:54
  return formatter.format(d).replace(/\//g, '-');
}

export function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert("コピーしました: " + text);
  }).catch(err => {
    console.error('Failed to copy: ', err);
  });
}

export function escapeHtml(unsafe) {
  return (unsafe || "").toString()
                       .replace(/&/g, "&amp;")
                       .replace(/</g, "&lt;")
                       .replace(/>/g, "&gt;")
                       .replace(/"/g, "&quot;")
                       .replace(/'/g, "&#039;");
}
