"use strict";

// Only explicitly marked interface strings are translated. File names, schema
// fields, metadata, and data values never pass through this catalog.
window.I18n = (() => {
  let language = "zh";
  let english = {};
  let reverse = new Map();
  try {
    const saved = localStorage.getItem("parquet-lens-language");
    language = ["zh", "en"].includes(saved)
      ? saved
      : navigator.language.toLowerCase().startsWith("zh")
        ? "zh"
        : "en";
  } catch {
    // Storage is optional; switching still works for this page.
  }

  function t(message, ...values) {
    const key = reverse.get(message) ?? message;
    const text = language === "en" ? (english[key] ?? key) : key;
    return String(text).replace(/\{(\d+)\}/g, (match, index) =>
      index < values.length ? String(values[index]) : match,
    );
  }

  function applyStatic() {
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    for (const attribute of ["aria-label", "placeholder", "content"]) {
      document
        .querySelectorAll(`[data-i18n-${attribute}]`)
        .forEach((element) => {
          element.setAttribute(
            attribute,
            t(element.getAttribute(`data-i18n-${attribute}`)),
          );
        });
    }
  }

  async function init() {
    const response = await fetch("/locales/en.json");
    if (!response.ok) throw new Error("界面语言加载失败，请刷新重试。");
    english = await response.json();
    // Keep the first canonical key for duplicated English translations.
    for (const [key, value] of Object.entries(english)) {
      if (!reverse.has(value)) reverse.set(value, key);
    }
    applyStatic();
  }

  function setLanguage(value) {
    if (!["zh", "en"].includes(value)) return;
    language = value;
    try {
      localStorage.setItem("parquet-lens-language", language);
    } catch {
      /* Optional preference. */
    }
    applyStatic();
  }

  return {
    t,
    init,
    applyStatic,
    setLanguage,
    get language() {
      return language;
    },
  };
})();
