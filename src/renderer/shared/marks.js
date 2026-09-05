import { t } from './i18n.js';

/**
 * Marques de fournisseur.
 *
 * Deux mécanismes, dans cet ordre :
 *
 *  1. Le vrai logo, quand un fichier a été déposé dans `logo/` (voir
 *     `scripts/make-logos.js`). Il est rendu en MASQUE CSS et non en image :
 *     ce sont des silhouettes monochromes, et le masque laisse la couleur
 *     suivre le thème — le noir du logo OpenAI serait invisible sur fond
 *     sombre, alors que sa version blanche est son usage officiel.
 *  2. À défaut, un glyphe géométrique dessiné ici. Reproduire approximativement
 *     une marque déposée serait pire que de s'en tenir à une forme neutre.
 *
 * Dans les deux cas la marque suit le FOURNISSEUR, jamais le rang de la ligne
 * dans un tableau.
 */

import { LOGOS } from './logos.js';

const MARKS = {
  // Éclat à trois branches, dans l'esprit angulaire de la marque Anthropic.
  anthropic: (s) => `
    <path d="M${s * 0.5} ${s * 0.1} L${s * 0.5} ${s * 0.9}" stroke="currentColor" stroke-width="${s * 0.13}" stroke-linecap="round"/>
    <path d="M${s * 0.15} ${s * 0.3} L${s * 0.85} ${s * 0.7}" stroke="currentColor" stroke-width="${s * 0.13}" stroke-linecap="round"/>
    <path d="M${s * 0.15} ${s * 0.7} L${s * 0.85} ${s * 0.3}" stroke="currentColor" stroke-width="${s * 0.13}" stroke-linecap="round"/>`,

  // Nœud hexagonal réduit à son contour. Une barre centrale avait été tentée
  // pour évoquer l'entrelacs : à 13 px l'ensemble se lisait comme un « 0 ».
  // Le contour seul est plus franc et ne ressemble à aucun caractère.
  openai: (s) => `
    <path d="M${s * 0.5} ${s * 0.07} L${s * 0.88} ${s * 0.285} L${s * 0.88} ${s * 0.715}
             L${s * 0.5} ${s * 0.93} L${s * 0.12} ${s * 0.715} L${s * 0.12} ${s * 0.285} Z"
          fill="none" stroke="currentColor" stroke-width="${s * 0.13}" stroke-linejoin="round"/>`,




  unknown: (s) => `
    <circle cx="${s * 0.5}" cy="${s * 0.5}" r="${s * 0.3}" fill="none"
            stroke="currentColor" stroke-width="${s * 0.11}" stroke-dasharray="${s * 0.16} ${s * 0.12}"/>`,
};

/**
 * Couleur propre au fournisseur — stable d'un tableau à l'autre.
 *
 * Ces teintes évitent délibérément la sarcelle et le bleu, qui codent déjà le
 * CO₂e et le coût : dans la table « par modèle », une marque sarcelle sur la
 * même ligne qu'une valeur CO₂e sarcelle serait ambiguë. La forme reste de
 * toute façon l'identifiant principal ; la couleur ne fait qu'aider au
 * regroupement visuel.
 *
 * Elles se trouvent en outre être plus fidèles aux marques réelles : celle
 * d'OpenAI est monochrome.
 */
export const PROVIDER_COLOR = {
  anthropic: '#e0863c',
  openai: '#9aa4b2',
  unknown: 'var(--ink-faint)',
};

// Les deux premiers sont des noms propres : ils ne se traduisent pas. Seul le
// repli en a besoin.
export const PROVIDER_LABEL = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  get unknown() { return t('provider.unknown'); },
};

/** Renvoie la marque d'un fournisseur, prête à insérer dans du HTML. */
export function providerMark(provider, size = 13) {
  const logo = LOGOS[provider];
  if (logo) {
    // `mask` peint `background-color` à travers la silhouette : la forme vient
    // du fichier, la couleur du thème.
    return `<span class="mark logo" role="img" aria-label="${PROVIDER_LABEL[provider] || provider}"
      style="width:${size}px;height:${size}px;background-color:${logo.color};
             -webkit-mask-image:url(${logo.url});mask-image:url(${logo.url})"></span>`;
  }
  const key = MARKS[provider] ? provider : 'unknown';
  return `<svg class="mark" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"
    style="color:${PROVIDER_COLOR[key]}" role="img" aria-label="${PROVIDER_LABEL[key]}"
    focusable="false">${MARKS[key](size)}</svg>`;
}
