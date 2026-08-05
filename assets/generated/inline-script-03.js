(() => {
      try {
        const savedTheme = localStorage.getItem("theme");
        if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
        const savedLang = localStorage.getItem("app_lang");
        if (savedLang) document.documentElement.setAttribute("lang", savedLang);
      } catch(e) {} 
    })();
