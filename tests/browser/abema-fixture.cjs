function abemaFixture({ keyword, laterLabel = 'あとで', modalKind = 'semantic' }) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${keyword}</title>
  <style>
    [hidden] { display: none !important; }
    body { margin: 20px; }
    button { padding: 12px; }
    #notice { position: fixed; left: 25%; top: 25%; width: 400px; height: 180px; z-index: 10; background: white; border: 1px solid; }
    #panel { height: 180px; }
  </style></head><body><h1>${keyword}</h1>
  <button id="unrelated">あとで</button>
  <div hidden role="dialog"><button id="hiddenLater">あとで</button></div>
  <div id="notice" ${modalKind === 'semantic' ? 'role="dialog" aria-modal="true"' : ''}>
    <p>視聴前の案内</p><button id="primary">設定する</button><button id="later">${laterLabel}</button>
  </div>
  <button id="comments" aria-label="コメント" aria-expanded="false" aria-controls="panel" hidden>コメント</button>
  <section id="panel" hidden><textarea aria-label="コメントを入力" placeholder="コメントを入力"></textarea><ul id="rows"></ul></section>
  <script>
    window.fixture = { laterClicks: 0, otherClicks: 0, primaryClicks: 0, commentClicks: 0, controlsRevealed: 0 };
    const notice = document.getElementById('notice');
    const button = document.getElementById('comments');
    const panel = document.getElementById('panel');
    for (const id of ['unrelated', 'hiddenLater']) document.getElementById(id).onclick = () => fixture.otherClicks++;
    document.getElementById('primary').onclick = () => fixture.primaryClicks++;
    document.getElementById('later').onclick = () => { fixture.laterClicks++; notice.hidden = true; };
    document.addEventListener('mousemove', () => { fixture.controlsRevealed++; button.hidden = false; });
    button.onclick = () => {
      fixture.commentClicks++;
      if (!notice.hidden) return;
      // A real page may render asynchronously after a click. Duplicate clicks toggle it closed.
      setTimeout(() => {
        panel.hidden = !panel.hidden;
        button.setAttribute('aria-expanded', String(!panel.hidden));
        if (!panel.hidden && !document.getElementById('sampleComment')) {
          const row = document.createElement('li');
          row.id = 'sampleComment';
          row.textContent = '自動記録で取得したコメント';
          row.__reactProps$fixture = { comments: [{ id: 'fixture-comment', userId: 'fixture-user', message: row.textContent, createdAtMs: Date.now() }] };
          document.getElementById('rows').appendChild(row);
        }
      }, 200);
    };
  </script></body></html>`;
}

module.exports = { abemaFixture };
