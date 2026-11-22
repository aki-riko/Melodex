// 验证壳内歌词直连：在页面上下文里调用 lyrics_push_state，看歌词窗是否收到。
// 只读探针：不触发播放、不改站点数据。
//
// 用法（由 Rust 侧 eval 注入，或手动在 WebView2 DevTools 里跑）：
//   window.__melodexLyricsProbe()
(function () {
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  const report = (payload) => {
    try {
      fetch('http://127.0.0.1:47901/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {});
    } catch (e) {}
  };

  window.__melodexLyricsProbe = async function () {
    const results = {};
    // 1) 有权限的命令应当成功
    try {
      await invoke('lyrics_push_state', {
        state: {
          type: 'track',
          track: { id: 'probe', source: 'probe', name: '探针测试', artist: '本地' },
          lyrics: [{ t: 0, end: 5, text: '第一行测试歌词' }, { t: 5, end: 10, text: '第二行测试歌词' }],
          position: 1.0,
          duration: 10,
          paused: false,
          current_index: 0,
        },
      });
      results.push_state = 'allowed';
    } catch (e) {
      results.push_state = 'denied: ' + String(e);
    }

    // 2) 无权限的本地命令必须被拒绝（安全边界验证）
    try {
      await invoke('get_click_through');
      results.get_click_through = 'ALLOWED (BAD!)';
    } catch (e) {
      results.get_click_through = 'denied (expected)';
    }

    // 3) 配对命令也必须被拒绝
    try {
      await invoke('public_device_config');
      results.public_device_config = 'ALLOWED (BAD!)';
    } catch (e) {
      results.public_device_config = 'denied (expected)';
    }

    report({ kind: 'lyrics-probe', results: results });
    return results;
  };

  report({ kind: 'probe-installed', hasInvoke: typeof invoke === 'function' });
})();
