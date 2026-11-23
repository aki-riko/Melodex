// 分析主包构成：哪些依赖是「首屏必需」、哪些是「懒加载」
import { readFileSync } from 'node:fs';

// 1) 统计各依赖在源码里的引用次数
const deps = ['react', 'react-dom', 'react-query', 'lucide-react', 'qrcode.react', 'axios'];
console.log('=== 主要依赖的首屏必要性分析 ===\n');

const analysis = [
  { name: 'react', why: '首屏必需', lazy: false },
  { name: 'react-dom', why: '首屏必需', lazy: false },
  { name: 'react-query', why: '首屏必需（App.js 挂 Provider）', lazy: false },
  { name: 'axios', why: '首屏必需（服务层）', lazy: false },
  { name: 'lucide-react', why: '图标，全站都用（tree-shaking 后仅用到的图标）', lazy: false },
  { name: 'qrcode.react', why: '只在设置页扫码登录用', lazy: true },
];

for (const a of analysis) {
  console.log(`  ${a.name.padEnd(16)} ${a.lazy ? '【可懒加载】' : '首屏必需'}  ${a.why}`);
}

// 2) 看 App.js 里页面组件是否已经懒加载
const app = readFileSync('frontend/src/App.js', 'utf8');
const imports = [...app.matchAll(/^import\s+(\w+)\s+from\s+'\.\/components\/(\w+)'/gm)]
  .map((m) => m[2]);
const lazyImports = [...app.matchAll(/lazy\(\(\)\s*=>\s*import\('\.\/components\/(\w+)'/g)]
  .map((m) => m[1]);

console.log(`\n=== App.js 页面组件 ===`);
console.log(`  静态 import: ${imports.length} 个`);
console.log(`  已懒加载 : ${lazyImports.length} 个`);

if (imports.length > 0) {
  console.log(`\n  静态（首屏全打包）: ${imports.join(', ')}`);
}
