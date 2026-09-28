// Génère les manifestes winget, Homebrew (cask) et AUR d'une release publiée.
//
//   node scripts/package-manifests.mjs v0.1.0
//
// Rien n'y est deviné : le script lit les fichiers RÉELLEMENT attachés à la
// release, en télécharge chacun pour en calculer le SHA-256, et n'écrit un
// manifeste que pour les plateformes dont il a trouvé le binaire. Un nom
// d'installeur inventé ou une empreinte recopiée d'ailleurs feraient échouer
// l'installation chez l'utilisateur, au pire moment.
//
// Les manifestes sortent dans `dist-packaging/<version>/`, à soumettre ensuite
// à winget-pkgs, au tap Homebrew et à l'AUR — trois dépôts qui ne sont pas
// celui-ci, et dont la soumission reste un geste humain.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO = 'gdemerges/trace-token-carbon';
export const APP = { id: 'gdemerges.TRACE', name: 'TRACE', publisher: 'Guillaume Demergès', license: 'MIT' };
export const DESCRIPTION =
  'AI token consumption, rate limits and carbon footprint, from the menu bar.';

/**
 * Choisit, parmi les fichiers d'une release, ceux que chaque gestionnaire de
 * paquets sait installer. Les noms suivent la convention de Tauri
 * (`TRACE_<version>_<arch>…`) ; on filtre par motif plutôt que de les
 * reconstruire.
 */
export function pickAssets(assets) {
  const by = (re) => assets.find((a) => re.test(a.name));
  return {
    windows: by(/x64.*setup\.exe$/i),
    macArm: by(/(aarch64|arm64).*\.dmg$/i),
    macIntel: by(/(x64|x86_64|intel).*\.dmg$/i),
    debian: by(/(amd64|x86_64).*\.deb$/i),
  };
}

const q = (s) => JSON.stringify(String(s));

export function wingetManifests({ version, installer, sha256, date }) {
  const head = (type) =>
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.6.0.schema.json\n` +
    `PackageIdentifier: ${APP.id}\nPackageVersion: ${version}\n`;
  return {
    [`${APP.id}.yaml`]:
      head('version') + `DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n`,
    [`${APP.id}.installer.yaml`]:
      head('installer') +
      `InstallerType: nullsoft\nScope: user\nInstallModes:\n  - interactive\n  - silent\n` +
      `ReleaseDate: ${date}\nInstallers:\n  - Architecture: x64\n    InstallerUrl: ${installer.url}\n` +
      `    InstallerSha256: ${sha256.toUpperCase()}\nManifestType: installer\nManifestVersion: 1.6.0\n`,
    [`${APP.id}.locale.en-US.yaml`]:
      head('defaultLocale') +
      `PackageLocale: en-US\nPublisher: ${APP.publisher}\nPackageName: ${APP.name}\n` +
      `License: ${APP.license}\nShortDescription: ${q(DESCRIPTION)}\n` +
      `PackageUrl: https://github.com/${REPO}\nManifestType: defaultLocale\nManifestVersion: 1.6.0\n`,
  };
}

/** Un cask Homebrew ; les architectures absentes de la release sont omises. */
export function caskRuby({ version, arm, intel }) {
  if (!arm && !intel) return null;
  const url = (a) => a.url.replaceAll(version, '#{version}');
  const lines = [`cask "trace" do`, `  version "${version}"`];
  if (arm && intel) {
    lines.push(
      `  arch arm: "aarch64", intel: "x64"`,
      `  sha256 arm:   "${arm.sha256}",`,
      `         intel: "${intel.sha256}"`,
      `  url "${url(arm).replace('aarch64', '#{arch}')}"`,
    );
  } else {
    const only = arm || intel;
    lines.push(`  sha256 "${only.sha256}"`, `  url "${url(only)}"`);
    lines.push(`  depends_on arch: :${arm ? 'arm64' : 'x86_64'}`);
  }
  lines.push(
    `  name "${APP.name}"`,
    `  desc ${q(DESCRIPTION)}`,
    `  homepage "https://github.com/${REPO}"`,
    ``,
    `  app "${APP.name}.app"`,
    ``,
    `  zap trash: "~/Library/Application Support/TRACE"`,
    `end`,
  );
  return lines.join('\n') + '\n';
}

/** Un PKGBUILD qui extrait le `.deb` publié. */
export function pkgbuild({ version, deb, sha256 }) {
  return [
    `# Maintainer: ${APP.publisher}`,
    `pkgname=trace-bin`,
    `pkgver=${version}`,
    `pkgrel=1`,
    `pkgdesc=${q(DESCRIPTION)}`,
    `arch=('x86_64')`,
    `url="https://github.com/${REPO}"`,
    `license=('${APP.license}')`,
    `depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator')`,
    `provides=('trace')`,
    `source=("trace-\${pkgver}.deb::${deb.url.replaceAll(version, '${pkgver}')}")`,
    `sha256sums=('${sha256}')`,
    ``,
    `package() {`,
    `  bsdtar -xf data.tar.* -C "\${pkgdir}"`,
    `}`,
    ``,
  ].join('\n');
}

async function sha256Of(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
}

async function main() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage : node scripts/package-manifests.mjs v0.1.0');
    process.exit(2);
  }
  const version = tag.replace(/^v/, '');
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    console.error(
      `release ${tag} introuvable (HTTP ${res.status}). Un brouillon n'est pas public : ` +
        `publiez la release avant de générer les manifestes.`,
    );
    process.exit(1);
  }
  const release = await res.json();
  const picked = pickAssets(release.assets.map((a) => ({ name: a.name, url: a.browser_download_url })));
  const out = join('dist-packaging', version);
  mkdirSync(out, { recursive: true });
  const written = [];
  const hashed = async (a) => (a ? { ...a, sha256: await sha256Of(a.url) } : null);

  const win = await hashed(picked.windows);
  if (win) {
    const dir = join(out, 'winget');
    mkdirSync(dir, { recursive: true });
    const date = (release.published_at || new Date().toISOString()).slice(0, 10);
    for (const [name, body] of Object.entries(
      wingetManifests({ version, installer: win, sha256: win.sha256, date }),
    )) {
      writeFileSync(join(dir, name), body);
    }
    written.push('winget');
  }
  const cask = caskRuby({ version, arm: await hashed(picked.macArm), intel: await hashed(picked.macIntel) });
  if (cask) {
    writeFileSync(join(out, 'trace.rb'), cask);
    written.push('homebrew');
  }
  const deb = await hashed(picked.debian);
  if (deb) {
    writeFileSync(join(out, 'PKGBUILD'), pkgbuild({ version, deb, sha256: deb.sha256 }));
    written.push('aur');
  }
  console.log(written.length ? `écrit dans ${out} : ${written.join(', ')}` : 'aucun binaire reconnu dans cette release');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
