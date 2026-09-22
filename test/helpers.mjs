// Charge un catalogue réel dans le module de traduction du renderer, tel que
// le fait le pont IPC à l'ouverture d'une fenêtre.
import { readFileSync } from 'node:fs';
import { initI18n } from '../src/renderer/shared/i18n.js';

const INTL = { fr: 'fr-FR', en: 'en-US' };

export function useLocale(locale) {
  const strings = JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8'));
  initI18n({ locale, intlLocale: INTL[locale], strings });
}
