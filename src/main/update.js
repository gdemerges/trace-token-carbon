'use strict';

/**
 * Vérification de version.
 *
 * TRACE n'a pas de mise à jour automatique, et n'en aura pas : installer du
 * code en arrière-plan sur la machine de quelqu'un demande une chaîne de
 * confiance (signature, canal, rollback) qu'une application de barre de menus
 * sans serveur ne peut pas tenir sérieusement. Mais ne rien dire du tout est
 * pire : un correctif de calcul — comme celui du doublon local/facturé —
 * reste alors sur le dépôt pendant que l'utilisateur regarde des chiffres
 * faux.
 *
 * Le compromis retenu : on lit la dernière version publiée, on le dit une
 * fois, et on ouvre la page si l'utilisateur le demande. Rien n'est
 * téléchargé, rien n'est exécuté.
 *
 * Ce que cela coûte en vie privée, dit franchement : un appel à api.github.com
 * au démarrage puis une fois par jour, qui expose l'adresse IP et la version
 * installée. Aucun identifiant, aucune donnée d'usage. Le réglage
 * `checkUpdates` le coupe, et le module ne fait alors plus un seul appel.
 *
 * Les fonctions pures de ce fichier (`compareVersions`, `pickRelease`) sont
 * exportées pour être testées sans lancer Electron ; les dépendances au
 * système sont injectées plutôt qu'importées, pour la même raison.
 */

const REPO = 'gdemerges/trace-token-carbon';
const ENDPOINT = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const TIMEOUT_MS = 8000;
const INTERVAL_MS = 24 * 3600 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

/**
 * Compare deux versions sémantiques. Renvoie > 0 si `a` est postérieure.
 *
 * Volontairement partiel : on compare les trois nombres, et une pré-version
 * (`1.2.0-beta.1`) est tenue pour ANTÉRIEURE à la version stable de même
 * numéro. On ne propose jamais une pré-version à quelqu'un qui n'en a pas
 * demandé — c'est la seule règle qui compte ici, et un analyseur semver
 * complet serait une dépendance pour rien.
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v || '').trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0; // format inconnu : on s'abstient plutôt que de deviner
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return 0;
}

/**
 * Décide s'il y a lieu d'avertir, à partir de la réponse de l'API.
 *
 * @param {object} release  objet « release » de GitHub
 * @param {string} current  version installée
 * @returns {?{version:string, url:string, notes:?string}}
 */
function pickRelease(release, current) {
  if (!release || typeof release !== 'object') return null;
  if (release.draft || release.prerelease) return null;
  const version = String(release.tag_name || release.name || '').replace(/^v/, '');
  if (!version) return null;
  if (compareVersions(version, current) <= 0) return null;
  return {
    version,
    url: typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/')
      ? release.html_url
      : RELEASES_PAGE,
    notes: typeof release.body === 'string' ? release.body.slice(0, 400) : null,
  };
}

/** Interroge GitHub. Résout à null sur toute anomalie : ce n'est pas critique. */
async function fetchLatest(fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(ENDPOINT, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'TRACE' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Met en place la vérification périodique.
 *
 * @param {object} deps  { version, isEnabled(), notify(update), fetchImpl }
 * @returns {function} pour arrêter la vérification
 */
function startUpdateChecks(deps) {
  const { version, isEnabled, notify, fetchImpl } = deps;
  // Une seule notification par version : réveiller quelqu'un tous les jours
  // pour la même mise à jour est le meilleur moyen de lui faire couper le
  // réglage — et de lui faire manquer la suivante.
  let announced = null;

  const run = async () => {
    if (!isEnabled()) return;
    const found = pickRelease(await fetchLatest(fetchImpl), version);
    if (!found || found.version === announced) return;
    announced = found.version;
    notify(found);
  };

  // Au démarrage, mais pas DANS le démarrage : la première seconde appartient
  // à l'affichage des chiffres, pas à une requête réseau facultative.
  const first = setTimeout(run, STARTUP_DELAY_MS);
  const every = setInterval(run, INTERVAL_MS);
  if (first.unref) first.unref();
  if (every.unref) every.unref();

  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

module.exports = { compareVersions, pickRelease, fetchLatest, startUpdateChecks, REPO, RELEASES_PAGE, INTERVAL_MS, STARTUP_DELAY_MS };
