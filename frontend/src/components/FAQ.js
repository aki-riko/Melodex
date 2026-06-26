import React, { useState } from 'react';

const FAQ_DATA = {
  faq: '常见问题',
  questions: [
    {
      question: 'TuneScout+ 是什么?',
      answer: 'TuneScout+ 是音乐发现与下载二合一的工具:在发现页浏览榜单与艺人,在下载页从国内多源搜索、在线播放并下载音乐。',
    },
    {
      question: '如何搜索并下载音乐?',
      answer: '进入「下载」页,在搜索栏输入歌曲或歌手名即可从国内多源(网易云 / QQ / 酷狗 / 酷我 / 咪咕 / 汽水 等)搜索,支持在线播放与下载,也可粘贴歌曲/歌单链接解析。',
    },
    {
      question: '发现页用到了哪些数据源?',
      answer: '发现页整合了 Spotify 和 Last.fm 的 API 数据,展示榜单与艺人信息(需在 .env 配置对应密钥)。',
    },
    {
      question: '可以把歌曲做成视频吗?',
      answer: '可以。在「视频生成」页选一首歌,即可生成带封面与歌词的 1080P 视频。',
    },
    {
      question: 'TuneScout+ 是免费的吗?',
      answer: '是的,TuneScout+ 完全免费且开源,仅供学习与技术交流使用。',
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
        {FAQ_DATA.questions.map((faq, index) => (
          <div key={index} className="border-2 border-border shadow-brutal-sm">
            <div
              onClick={() => toggleFAQ(index)}
              className="cursor-pointer flex justify-between items-center p-4 bg-muted"
            >
              <h2 className="text-xl font-semibold">{faq.question}</h2>
              <span>{openIndex === index ? '-' : '+'}</span>
            </div>
            {openIndex === index && (
              <div className="p-4 bg-card border-t-2 border-border">
                <p className="text-lg">{faq.answer}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default FAQ;
