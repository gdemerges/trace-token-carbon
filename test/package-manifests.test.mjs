import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAssets, wingetManifests, caskRuby, pkgbuild } from '../scripts/package-manifests.mjs';

const asset = (name) => ({ name, url: `https://github.com/gdemerges/trace-token-carbon/releases/download/v0.1.0/${name}` });
const HASH = 'a'.repeat(64);

test('chaque gestionnaire ne reçoit que le binaire qu\'il sait installer', () => {
  const p = pickAssets(
    [
      'TRACE_0.1.0_x64-setup.exe',
      'TRACE_0.1.0_aarch64.dmg',
      'TRACE_0.1.0_x64.dmg',
      'TRACE_0.1.0_amd64.deb',
      'TRACE_0.1.0_amd64.AppImage',
      'latest.json',
    ].map(asset),
  );
  assert.equal(p.windows.name, 'TRACE_0.1.0_x64-setup.exe');
  assert.equal(p.macArm.name, 'TRACE_0.1.0_aarch64.dmg');
  assert.equal(p.macIntel.name, 'TRACE_0.1.0_x64.dmg');
  assert.equal(p.debian.name, 'TRACE_0.1.0_amd64.deb');
});

test('une plateforme absente de la release reste absente, jamais devinée', () => {
  const p = pickAssets([asset('TRACE_0.1.0_aarch64.dmg')]);
  assert.equal(p.windows, undefined);
  assert.equal(p.macIntel, undefined);
  assert.equal(p.debian, undefined);
});

test('winget : trois manifestes, empreinte en capitales, aucune valeur inventée', () => {
  const m = wingetManifests({
    version: '0.1.0',
    installer: asset('TRACE_0.1.0_x64-setup.exe'),
    sha256: HASH,
    date: '2026-09-28',
  });
  assert.equal(Object.keys(m).length, 3);
  const installer = m['gdemerges.TRACE.installer.yaml'];
  assert.match(installer, /InstallerSha256: A{64}\n/);
  assert.match(installer, /InstallerUrl: https:\/\/github\.com\/gdemerges\/trace-token-carbon\/releases\/download\/v0\.1\.0\/TRACE_0\.1\.0_x64-setup\.exe/);
  for (const body of Object.values(m)) assert.match(body, /PackageVersion: 0\.1\.0/);
});

test('le cask suit les deux architectures, ou une seule si l\'autre manque', () => {
  const arm = { ...asset('TRACE_0.1.0_aarch64.dmg'), sha256: 'b'.repeat(64) };
  const intel = { ...asset('TRACE_0.1.0_x64.dmg'), sha256: 'c'.repeat(64) };
  const both = caskRuby({ version: '0.1.0', arm, intel });
  assert.match(both, /arch arm: "aarch64", intel: "x64"/);
  assert.match(both, /TRACE_#\{version\}_#\{arch\}\.dmg/);
  assert.match(both, /b{64}/);
  assert.match(both, /c{64}/);

  const only = caskRuby({ version: '0.1.0', arm, intel: null });
  assert.match(only, /depends_on arch: :arm64/);
  assert.doesNotMatch(only, /c{64}/);

  assert.equal(caskRuby({ version: '0.1.0', arm: null, intel: null }), null);
});

test('le PKGBUILD extrait le .deb publié et porte son empreinte', () => {
  const b = pkgbuild({ version: '0.1.0', deb: asset('TRACE_0.1.0_amd64.deb'), sha256: HASH });
  assert.match(b, /pkgver=0\.1\.0/);
  assert.match(b, /sha256sums=\('a{64}'\)/);
  assert.match(b, /\$\{pkgver\}_amd64\.deb/);
  assert.match(b, /bsdtar -xf data\.tar/);
});
