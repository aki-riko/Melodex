import React, { useState } from 'react';

const translations = {
  en: {
    faq: "常见问题",
    questions: [
      {
        question: "TuneScout 是什么?",
        answer: "TuneScout 是一个动态的音乐探索平台,帮助你发现符合自己口味的新音乐。"
      },
      {
        question: "如何搜索音乐?",
        answer: "你可以在「发现」页面的搜索栏里搜索音乐,只需输入你想找的歌曲或专辑名称即可。"
      },
      {
        question: "TuneScout 用到了哪些 API?",
        answer: "TuneScout 整合了 Spotify 和 Last.fm 的 API 数据,带来全面的音乐发现体验。"
      },
      {
        question: "TuneScout 是免费的吗?",
        answer: "是的,TuneScout 完全免费,为你提供最新的热门音乐和热门艺人。"
      }
    ]
  },
  fr: {
    faq: "Questions Fréquemment Posées",
    questions: [
      {
        question: "Qu'est-ce que TuneScout?",
        answer: "TuneScout est une plateforme dynamique d'exploration musicale conçue pour vous aider à découvrir de nouvelles musiques adaptées à vos goûts."
      },
      {
        question: "Comment rechercher de la musique?",
        answer: "Vous pouvez rechercher de la musique en utilisant la barre de recherche sur la page Découvrir. Entrez simplement le nom de la chanson ou de l'album que vous recherchez."
      },
      {
        question: "Quelles API utilise TuneScout?",
        answer: "TuneScout intègre les données des API de Spotify et Last.fm pour offrir une expérience de découverte musicale complète."
      },
      {
        question: "TuneScout est-il gratuit?",
        answer: "Oui, TuneScout est gratuit et vous fournit les dernières tendances musicales et les meilleurs artistes."
      }
    ]
  }
};

const FAQ = () => {
  const [openIndex, setOpenIndex] = useState(null);
  const [language, setLanguage] = useState('en');

  const toggleFAQ = (index) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  const handleLanguageChange = (e) => {
    setLanguage(e.target.value);
  };

  return (
    <div className="container mx-auto p-6">
      <div className="flex justify-end mb-4">
        <select
          value={language}
          onChange={handleLanguageChange}
          className="bg-transparent border-none text-primary"
        >
          <option value="en">EN</option>
          <option value="fr">FR</option>
        </select>
      </div>
      <h1 className="text-4xl font-bold mb-8 text-center">{translations[language].faq}</h1>
      <div className="max-w-2xl mx-auto space-y-4">
        {translations[language].questions.map((faq, index) => (
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
