import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLatestRelease, trustedGitHubUrl, assetsForPlatform, assetDescription, fetchLatestRelease } from '../releases.js';

const repo = 'Anodex/Anodex';
const release = (tag, publishedAt, extra = {}) => ({ tag_name: tag, published_at: publishedAt, html_url: `https://github.com/${repo}/releases/tag/${tag}`, assets: [], ...extra });
const asset = (name, extra = {}) => ({ name, size: 10 * 1024 ** 2, state: 'uploaded', browser_download_url: `https://github.com/${repo}/releases/download/v2/${name}`, ...extra });

test('uses publication time, includes explicitly labelled previews, ignores drafts and malformed records', () => {
  const data = [release('v9', '2025-01-01'), release('v2-preview.3', '2026-04-01'), release('v3', '2026-05-01', { draft: true }), null, release('bad', 'no date')];
  const chosen = selectLatestRelease(data, repo);
  assert.equal(chosen.tag, 'v2-preview.3');
  assert.equal(chosen.preview, true);
  assert.equal(selectLatestRelease([release('v1', '2026-01-01', { prerelease: true })], repo).preview, true);
  assert.equal(selectLatestRelease([release('v1', '2026-01-01')], repo).preview, false);
});

test('mobile tags marked stable by GitHub still display their preview status', () => {
  const mobileRepo = 'Anodex/anodex-mobile';
  const mobile = release('v0.53.0-preview.61', '2026-09-08', { html_url: `https://github.com/${mobileRepo}/releases/tag/v0.53.0-preview.61`, prerelease: false });
  assert.equal(selectLatestRelease([mobile], mobileRepo).preview, true);
});

test('selects actual installers, excluding updater metadata, checksums, source archives, and unfinished uploads', () => {
  const chosen = selectLatestRelease([release('v2', '2026-09-08', { assets: ['Setup.exe', 'Setup.exe.blockmap', 'latest.yml', 'Anodex-arm64.dmg', 'Anodex-x64.dmg', 'Anodex.AppImage', 'Anodex.deb', 'source.zip', 'Anodex.apk'].map((name) => asset(name)).concat([asset('Pending.exe', { state: 'new' }), asset('Empty.exe', { size: 0 })]) })], repo);
  assert.deepEqual(assetsForPlatform(chosen, 'windows').map((a) => a.name), ['Setup.exe']);
  assert.equal(assetsForPlatform(chosen, 'mac').length, 2);
  assert.equal(assetsForPlatform(chosen, 'linux').length, 2);
  assert.equal(assetsForPlatform(chosen, 'android').length, 1);
  assert.match(assetDescription(assetsForPlatform(chosen, 'mac')[0], 'mac'), /Apple Silicon · DMG · 10.0 MB/);
});

test('does not silently serve an old installer when a new release has missing assets', () => {
  const chosen = selectLatestRelease([release('v1', '2026-01-01', { assets: [asset('Setup.exe')] }), release('v2', '2026-02-01')], repo);
  assert.equal(chosen.tag, 'v2');
  assert.deepEqual(assetsForPlatform(chosen, 'windows'), []);
});

test('untrusted links cannot become download destinations', () => {
  for (const url of ['javascript:alert(1)', 'https://github.com.evil.test/Anodex/Anodex/releases/tag/v1', 'https://evil.test/file.exe', 'https://github.com/other/project/releases/tag/v1', 'https://user:pass@github.com/Anodex/Anodex/releases/tag/v1', 'http://github.com/Anodex/Anodex/releases/tag/v1']) assert.equal(trustedGitHubUrl(url, repo), null);
  const chosen = selectLatestRelease([release('v2', '2026-01-01', { assets: [asset('Bad.exe', { browser_download_url: 'https://evil.test/Bad.exe' }), asset('Good.exe')] })], repo);
  assert.equal(chosen.assets.length, 1);
});

test('empty, malformed, and rate-limited responses produce an error for the UI fallback', async () => {
  assert.throws(() => selectLatestRelease([], repo));
  assert.throws(() => selectLatestRelease({ message: 'rate limit' }, repo));
  await assert.rejects(fetchLatestRelease(repo, { fetcher: async () => ({ ok: false, status: 403 }) }), /403/);
  await assert.rejects(fetchLatestRelease(repo, { fetcher: async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } }) }), /Invalid JSON/);
});

test('requests fresh public data without a token and aborts a stalled request', async () => {
  await fetchLatestRelease(repo, { fetcher: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/Anodex/Anodex/releases?per_page=100');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => [release('v2', '2026-09-08')] };
  } });
  await assert.rejects(fetchLatestRelease(repo, { timeoutMs: 10, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')))) }), /Aborted/);
});
