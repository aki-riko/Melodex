# 第三方资源许可声明 / Third-Party Licenses

Melodex 由两个开源项目合并而来,并改编了第三方界面设计。在此一并致谢,
保留各自的版权与许可声明。Melodex 整体采用 **AGPL-3.0**(继承自 go-music-dl)。

---

## go-music-dl (后端引擎本体)

Melodex 的后端(多源搜索 / 下载 / 在线播放 / Subsonic facade 等)在
**guohuiyuan/go-music-dl** 基础上改造而来,这是 Melodex 的核心引擎。

- 原作者 / Author: **guohuiyuan**
- 原作出处 / Source: https://github.com/guohuiyuan/go-music-dl
- 许可 / License: **AGPL-3.0**

## music-lib (平台解析库)

各音乐平台(QQ / 网易云 / 酷狗 等)的搜索与解析逻辑来自
**guohuiyuan/music-lib**,已本地化引入(`backend/third_party/music-lib`,见其 LICENSE)。
本项目对各源 Search 做了无损/正版信号等改动,保留原版权声明。

- 原作者 / Author: **guohuiyuan**
- 原作出处 / Source: https://github.com/guohuiyuan/music-lib
- 许可 / License: **AGPL-3.0**

## TuneScout (前端来源)

Melodex 的 React 前端在 **peter-bf/tunescout** 基础上改造而来
(原为音乐发现页 UI),本项目将其重构为暗色 Spotify 风并接入 go-music-dl 后端。

- 原作者 / Author: **peter-bf**
- 原作出处 / Source: https://github.com/peter-bf/tunescout

---

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

> 注:MIT 资源(Spotify UI 皮肤)并入 AGPL 项目合规,仅需保留上述版权与许可声明。
