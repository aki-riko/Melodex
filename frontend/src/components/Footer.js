import React from 'react';

const Footer = () => {
  return (
    <footer className="bg-zinc-950/100 backdrop-blur-sm text-text py-7 mt-4">
      <div className="container mx-auto container-padding flex justify-between items-center">
        <div className="text-sm text-primary">
          © 2024 TuneScout. All Rights Reserved. <br />
          This app uses data from Spotify and Last.fm APIs.
        </div>
        <div className="flex space-x-4">
          <a href="/" className="text-primary hover:text-white transition duration-300 ease-in-out">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M24 4.557a9.93 9.93 0 01-2.828.775 4.932 4.932 0 002.165-2.724 9.865 9.865 0 01-3.127 1.195 4.92 4.92 0 00-8.384 4.482 13.96 13.96 0 01-10.141-5.143 4.92 4.92 0 001.523 6.573 4.903 4.903 0 01-2.229-.616c-.054 2.281 1.581 4.415 3.95 4.89a4.93 4.93 0 01-2.224.084 4.922 4.922 0 004.6 3.417A9.868 9.868 0 010 19.54a13.944 13.944 0 007.548 2.212c9.142 0 14.307-7.721 13.995-14.646a9.935 9.935 0 002.457-2.549z"/>
            </svg>
          </a>
          <a href="/" className="text-primary hover:text-white transition duration-300 ease-in-out">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19.615 3.184C17.626 2.998 12 2.998 12 2.998s-5.625 0-7.614.186c-2.572.23-4.58 2.239-4.815 4.815C-.003 9.98-.003 12-.003 12s0 2.021.186 4.001c.234 2.576 2.243 4.585 4.815 4.815 1.989.186 7.614.186 7.614.186s5.625 0 7.615-.186c2.572-.23 4.581-2.239 4.815-4.815.186-1.98.186-4.001.186-4.001s0-2.021-.186-4.001c-.234-2.576-2.243-4.585-4.815-4.815zM9.545 15.568V8.432l6.363 3.568-6.363 3.568z"/>
            </svg>
          </a>
          <a href="/" className="text-primary hover:text-white transition duration-300 ease-in-out">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.88v-6.99h-2.54V12h2.54V9.797c0-2.507 1.492-3.89 3.774-3.89 1.094 0 2.239.196 2.239.196v2.48h-1.261c-1.242 0-1.629.774-1.629 1.564V12h2.773l-.443 2.89h-2.33v6.99C18.343 21.128 22 16.991 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
          </a>
          <a href="/" className="text-primary hover:text-white transition duration-300 ease-in-out">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.317 4.369c-1.346-.595-2.782-1-4.262-1.193-.195.263-.42.621-.575.91-1.726-.258-3.451-.258-5.176 0-.156-.283-.385-.647-.57-.91-1.48.192-2.917.598-4.262 1.193-2.702 4.035-3.442 7.977-3.086 11.863 1.774 1.311 3.508 2.105 5.216 2.622.42-.576.794-1.183 1.115-1.818-.614-.23-1.198-.512-1.763-.853.147-.111.291-.227.428-.348 3.445 1.604 7.165 1.604 10.543 0 .137.121.282.237.428.348-.565.341-1.149.624-1.763.853.321.635.695 1.242 1.115 1.818 1.708-.517 3.442-1.311 5.216-2.622.367-3.755-.458-7.66-3.086-11.863zm-12.2 7.55c-1.041 0-1.889-.951-1.889-2.119 0-1.168.838-2.128 1.889-2.128 1.053 0 1.901.96 1.883 2.128 0 1.168-.838 2.119-1.883 2.119zm7.765 0c-1.041 0-1.889-.951-1.889-2.119 0-1.168.838-2.128 1.889-2.128 1.053 0 1.901.96 1.883 2.128 0 1.168-.83 2.119-1.883 2.119z"/>
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
