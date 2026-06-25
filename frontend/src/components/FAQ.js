import React, { useState } from 'react';

const translations = {
  en: {
    faq: "Frequently Asked Questions",
    questions: [
      {
        question: "What is TuneScout?",
        answer: "TuneScout is a dynamic music exploration platform designed to help you discover new music tailored to your tastes."
      },
      {
        question: "How do I search for music?",
        answer: "You can search for music using the search bar on the Discover page. Simply enter the name of the song or album you are looking for."
      },
      {
        question: "Which APIs does TuneScout use?",
        answer: "TuneScout integrates data from Spotify and Last.fm APIs to deliver a comprehensive music discovery experience."
      },
      {
        question: "Is TuneScout free to use?",
        answer: "Yes, TuneScout is free to use and provides you with the latest trending music and top artists."
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
          <div key={index} className="border rounded-lg">
            <div
              onClick={() => toggleFAQ(index)}
              className="cursor-pointer flex justify-between items-center p-4 bg-gray-100 rounded-t-lg"
            >
              <h2 className="text-xl font-semibold">{faq.question}</h2>
              <span>{openIndex === index ? '-' : '+'}</span>
            </div>
            {openIndex === index && (
              <div className="p-4 bg-white">
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
