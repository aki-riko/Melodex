// 分析主包 475KB 里还剩什么
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// 用 rollup 的 visualizer 太重，改用简单方式：看哪些大文件仍被 App.js 静态引用
const app = readFileSync('frontend/src/App.js', 'utf8');
console.log('=== App.js 仍静态 import 的本地组件 ===');
for (const m of app.matchAll(/^import\s+(?:(\w+)|\{([^}]+)\})\s+from\s+'\.\/([^']+)'/gm)) {
  const names = m[1] || m[2].trim();
  console.log(`  ${m[3].padEnd(35)} ${names.slice(0, 40)}`);
}

console.log('\n=== 这些文件的体积 ===');
const files = [
  'frontend/src/components/Sidebar.js',
  'frontend/src/components/TopBar.js',
  'frontend/src/components/HomeRecommendations.js',
  'frontend/src/components/AuthGate.js',
  'frontend/src/components/AddToPlaylistModal.js',
  'frontend/src/contexts/PlayerContext.js',
  'frontend/src/contexts/AuthContext.js',
  'frontend/src/contexts/CollectionsContext.js',
  'frontend/src/contexts/ServerDownloadsContext.js',
  'frontend/src/contexts/FeedbackContext.js',
];

for (const f of files) {
  try {
    const kb = Math.round(readFileSync(f).length / 1024 * 10) / 10;
    console.log(`  ${f.replace('frontend/src/', '').padEnd(40)} ${kb} KB (源码)`);
  } catch { /* skip */ }
}
