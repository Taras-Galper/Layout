// Every user-facing string goes through t(). English is the only language for now; adding one means
// adding a JSON file with the same keys (and setting dir="rtl" on <html> for right-to-left languages).
import en from './en.json';

type Dict = Record<string, string>;
const dictionaries: Record<string, Dict> = { en };
let current: Dict = en;
let currentLang = 'en';

export function setLanguage(lang: string): void {
  current = dictionaries[lang] ?? en;
  currentLang = dictionaries[lang] ? lang : 'en';
  document.documentElement.lang = currentLang;
}

export function language(): string {
  return currentLang;
}

export function t(key: string, params?: Record<string, string | number>): string {
  let s = current[key] ?? (en as Dict)[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Fill every element carrying data-i18n (text) or data-i18n-title (tooltip). */
export function translateDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle!)));
}

export function formatNumber(v: number, digits = 1): string {
  return v.toLocaleString(currentLang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
