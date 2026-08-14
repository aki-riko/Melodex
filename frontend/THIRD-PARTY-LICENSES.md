# 第三方资源许可声明 / Third-Party Licenses

Melodex Provider 使用固定的开源音乐服务快照,Web 前端改编了第三方界面设计。
此处保留当前源码实际使用部分的版权与许可声明。Melodex 整体采用
**AGPL-3.0**。

---

## CharlesPikachu/musicdl (多源 Provider)

Melodex 的歌曲搜索、媒体地址和歌词 Provider 使用
**CharlesPikachu/musicdl** 的固定源码快照。快照通过独立 sidecar 运行，Melodex Go
后端只使用稳定 JSON 接口与它通信。

- 原作者 / Author: **CharlesPikachu**
- 原作出处 / Source: https://github.com/CharlesPikachu/musicdl
- 固定提交 / Pinned commit: `b4cecd9d450ede6f5c8d4df08763668256dfee58`
- 许可 / License: **Apache-2.0**
- 许可证与来源记录: `backend/third_party/charles-musicdl/LICENSE`、`UPSTREAM.md`

## Spotify Artist Page UI (视觉设计参考)

Melodex 的暗色界面皮肤(配色、播放器条、曲目行、卡片等视觉样式)
改编自 Adam Lowenthal 在 CodePen 发布的 "Spotify Artist Page UI" 作品。
原作为静态 HTML/CSS 视觉稿,本项目将其视觉语言移植为 React 组件并接入实际功能。

- 原作者 / Author: **Adam Lowenthal**
- 原作出处 / Source: https://codepen.io/alowenthal/pen/rxboRv
- 许可 / License: **MIT**

原始许可全文如下 / Original license text:

```
The MIT License (MIT)

Copyright (c) 2026 Adam Lowenthal (https://codepen.io/alowenthal/pen/rxboRv)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

> 注:MIT 视觉资源并入 AGPL 项目时保留上述版权与许可声明。
