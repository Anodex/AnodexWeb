/** Public GitHub release discovery. No credentials or build-time versions. */
export const PRODUCTS = Object.freeze({
  desktop: { repo: 'Anodex/Anodex', platforms: ['windows', 'mac', 'linux'] },
  mobile: { repo: 'Anodex/anodex-mobile', platforms: ['android'] },
});

export const PLATFORMS = Object.freeze({
  windows: { name: 'Windows', extensions: /\.(exe|msi)$/i },
  mac: { name: 'macOS', extensions: /\.dmg$/i },
  linux: { name: 'Linux', extensions: /\.(appimage|deb|rpm)$/i },
  android: { name: 'Android', extensions: /\.apk$/i },
});

export function trustedGitHubUrl(value, repo, kind = 'release') {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const prefix = `/${repo}/releases/${kind === 'asset' ? 'download/' : 'tag/'}`.toLowerCase();
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || !url.pathname.toLowerCase().startsWith(prefix)) return null;
    return url.href;
  } catch { return null; }
}

export function selectLatestRelease(data, repo) {
  if (!Array.isArray(data)) throw new Error('Unexpected GitHub response');
  // Most recently published, including previews. A preview is always labelled.
  // Do not use semver ordering: older tags can be newly published releases.
  const releases = data.filter((release) => release && !release.draft &&
    typeof release.tag_name === 'string' && release.tag_name.trim() &&
    Number.isFinite(Date.parse(release.published_at)) && trustedGitHubUrl(release.html_url, repo));
  releases.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  if (!releases.length) throw new Error('No published releases');
  const release = releases[0];
  return {
    tag: release.tag_name,
    url: trustedGitHubUrl(release.html_url, repo),
    publishedAt: release.published_at,
    preview: Boolean(release.prerelease) || /(?:^|[.\-])(preview|alpha|beta|rc|test|dev|nightly)(?:[.\-\d]|$)/i.test(release.tag_name),
    assets: (Array.isArray(release.assets) ? release.assets : []).filter((asset) =>
      asset && typeof asset.name === 'string' && Number.isFinite(asset.size) && asset.size > 0 &&
      (!asset.state || asset.state === 'uploaded') && trustedGitHubUrl(asset.browser_download_url, repo, 'asset')
    ).map((asset) => ({ name: asset.name, size: asset.size, url: trustedGitHubUrl(asset.browser_download_url, repo, 'asset') })),
  };
}

export function assetsForPlatform(release, platform) {
  const definition = PLATFORMS[platform];
  if (!definition) return [];
  return release.assets.filter((asset) => definition.extensions.test(asset.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function assetDescription(asset, platform) {
  const name = asset.name.toLowerCase();
  const extension = name.slice(name.lastIndexOf('.') + 1);
  const architecture = /(?:arm64|aarch64)/.test(name) ? (platform === 'mac' ? 'Apple Silicon' : 'ARM64')
    : /(?:x64|x86_64|amd64)/.test(name) ? (platform === 'mac' ? 'Intel' : 'x64')
    : /universal/.test(name) ? 'Universal' : '';
  const type = extension === 'appimage' ? 'AppImage' : extension.toUpperCase();
  const size = asset.size >= 1024 ** 3 ? `${(asset.size / 1024 ** 3).toFixed(1)} GB` : `${(asset.size / 1024 ** 2).toFixed(1)} MB`;
  return [architecture, type, size].filter(Boolean).join(' · ');
}

export async function fetchLatestRelease(repo, { fetcher = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!Object.values(PRODUCTS).some((product) => product.repo === repo)) throw new Error('Unknown product');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return selectLatestRelease(await response.json(), repo);
  } finally { clearTimeout(timeout); }
}
