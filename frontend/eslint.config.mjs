// ESLint 配置 —— 只做一件事:让 react-hooks 的两条规则**真正生效**。
//
// 背景(2026-11 全库扫描发现):项目此前**完全没有 ESLint**,但源码里躺着 5 处
// `// eslint-disable-next-line react-hooks/exhaustive-deps`。没有 lint 就没人读那些
// 指令 —— 等于 94 个 useEffect 的依赖数组完全靠人肉保证,而那 5 处"刻意跳过依赖"
// 的地方也没写清为什么安全。现状是两不靠。
//
// 本配置刻意**只开这两个规则**,不开任何风格规则(缩进/引号/分号一概不管):
//   · 目的是抓"依赖数组写错"这类**真 bug**,不是统一代码长相;
//   · 风格规则会在一次提交里改动上百个文件,把真改动埋掉。
//
// 规则级别按用户决定设为 **error**:依赖数组有问题就必须修,不许只报警。
//
// 运行:
//   npm run lint          # 报告问题
//   npm run lint:fix      # 自动修可修的部分(注意:不自动改依赖数组)
//
// ★ 如果某处确实需要跳过依赖检查,必须在注释里写清**为什么安全**,
//   而不是只写一句 eslint-disable 了事(那正是本次要消灭的"惰性注释")。

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default [
  {
    // 只 lint 源码与门禁脚本;构建产物与依赖不碰。
    ignores: [
      'build/**',
      'dist/**',
      'node_modules/**',
      'public/**',
      'snapshot-build/**',
    ],
  },
  {
    files: ['src/**/*.{js,jsx}', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // ★ 必须显式设 jsx:true 并配 ecmaFeatures。
      //   踩过的坑:`...js.configs.recommended` 展开时它自带的 languageOptions
      //   会把这里的覆盖掉,JSX 就不被解析 —— 表现是 `<Suspense>` 这类
      //   JSX 里明明用到的标识符全被报成 no-unused-vars(实测 269 条误报)。
      //   所以下面 rules 只从 recommended 取,languageOptions 完全自己写。
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      react,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // 从 recommended 取基础规则集(只取 rules,不取它的 languageOptions)。
      ...js.configs.recommended.rules,

      // 这两条是本次接入的唯一目的。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // ★ 关键:让 JSX 里出现的组件被算作"已使用"。
      //   没有这条时 `<Suspense>` 这类 JSX 用法不被跟踪,no-unused-vars 会把
      //   App.js 全部 30 个 import 都报成未使用(实测),完全是噪音。
      //   本项与下面 no-unused-vars 配合才有效。
      'react/jsx-uses-react': 'off',   // 自动 runtime 下不需要
      'react/jsx-uses-vars': 'error',

      // no-unused-vars 收窄:JSX 已被正确解析后,这条只剩真实告警。
      // 允许 `_` 前缀显式表示"故意不用"。
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      // 项目大量使用 `useEffect(() => {...})` 无返回值 + 可选链,
      // recommended 里这条与现有写法的告警无实际价值。
      'no-useless-escape': 'warn',
    },
  },
];
