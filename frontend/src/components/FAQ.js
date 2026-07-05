import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import Footer from './Footer';

const FAQ_DATA = {
  faq: '常见问题',
  questions: [
    {
      question: 'Melodex 现在主要用来做什么?',
      answer: [
        'Melodex 是一个自托管的 PWA 音乐工具:搜索国内多源歌曲、在线播放、管理歌单,并把需要长期保存的歌曲下载到 NAS 曲库。',
        '它也支持把歌曲缓存到当前浏览器或 PWA,这样手机或电脑临时离线时仍然能播放已经缓存过的歌。',
      ],
    },
    {
      question: '搜索结果为什么不是立刻全部显示?',
      answer: [
        '搜索会先从多个音乐源拉取候选结果,再并发检测真实播放链接、码率和文件大小。检测失败、版权受限或已经失效的结果会被自动隐藏。',
        '所以第一次搜索会看到“正在筛选可播放结果”。这不是卡住,而是在尽量只把能播、能存的结果展示出来。',
      ],
    },
    {
      question: '下载到 NAS 和缓存到本机有什么区别?',
      answer: [
        '「下载到 NAS」会让服务器把音频落盘到下载目录,并尽量写入标题、歌手、专辑、歌词和封面。保存后会出现在「NAS 曲库」里,适合长期收藏和被其他媒体库扫描。',
        '「缓存到本机」只保存在当前浏览器/PWA 的 IndexedDB 里,用于离线播放,不会进入 NAS 曲库,也不会自动同步到其他设备。空间紧张时浏览器可能回收缓存,可以在「离线音乐」里请求持久保存。',
      ],
    },
    {
      question: '为什么音质会和搜索时看到的不一样?',
      answer: [
        '搜索接口给出的音质经常只是预览值,Melodex 会自动用真实下载链接检测最终码率和大小,并把检测结果缓存到数据库。列表里的音质标签以真实检测结果为准。',
        '无损或高品质还取决于音乐源、版权状态和平台会员 Cookie。QQ 等平台扫码登录不一定能拿到完整无损授权,需要时由管理员在「设置」里手动粘贴对应平台的完整 Cookie。',
      ],
    },
    {
      question: '歌单、收藏和账号数据保存在哪里?',
      answer: [
        'Melodex 有自己的登录态和多用户隔离。每个用户都有独立的「我喜欢」、自建歌单、搜索历史、本机缓存归属和 NAS 下载归属。',
        '生产环境的数据保存在服务端数据库里,当前部署使用 PostgreSQL。平台会员 Cookie 属于系统级配置,只有管理员可以维护,普通用户不会单独配置平台 Cookie。',
      ],
    },
    {
      question: '首页和发现页的数据来自哪里?',
      answer: [
        '现在首页以国内音乐源的推荐歌单和分类歌单为主,不再使用 Last.fm 或 Spotify 数据。',
        '国内源能稳定拿到的主要是歌单维度,不是完整的艺人榜或单曲榜;需要精准找歌时,直接在「搜索下载」里输入“歌手 歌名”通常更可靠。',
      ],
    },
    {
      question: '手机上可以像原生播放器一样离线用吗?',
      answer: [
        '在 Android/Chromium 内核浏览器或 PWA 里,可以把歌曲缓存到本机并在「离线音乐」里播放。离线模式只会读取已经缓存过的歌曲,不会请求 NAS 或音乐源。',
        'iOS Safari/PWA 的后台播放和存储策略更严格,目前没有完整真机覆盖。能用,但不要把它当成和 Android 完全一致的体验。',
      ],
    },
    {
      question: '项目开源吗?',
      answer: [
        '是的。Melodex 整体采用 AGPL-3.0,基于 go-music-dl 和 TuneScout 改造,仅供学习、研究和自托管自用。',
        'GitHub 地址在下方「项目与开源说明」里,也可以在那里看到相关上游项目和界面设计来源。',
      ],
    },
  ],
};

const FAQ = () => {
  const [openIndex, setOpenIndex] = useState(null);

  const toggleFAQ = (index) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-4xl font-bold mb-8 text-center">{FAQ_DATA.faq}</h1>
      <div className="max-w-2xl mx-auto space-y-4">
        {FAQ_DATA.questions.map((faq, index) => {
          const open = openIndex === index;
          const Icon = open ? Minus : Plus;
          return (
            <div key={faq.question} className="border border-border">
              <button
                type="button"
                onClick={() => toggleFAQ(index)}
                className="w-full cursor-pointer flex justify-between items-center gap-4 p-4 bg-muted text-left"
                aria-expanded={open}
              >
                <h2 className="min-w-0 text-lg md:text-xl font-semibold">{faq.question}</h2>
                <Icon size={18} className="flex-shrink-0" />
              </button>
              {open && (
                <div className="space-y-3 p-4 bg-card border-t-2 border-border">
                  {(Array.isArray(faq.answer) ? faq.answer : [faq.answer]).map((paragraph) => (
                    <p key={paragraph} className="text-base leading-7 text-foreground/90">{paragraph}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <Footer />
      </div>
    </div>
  );
};

export default FAQ;
