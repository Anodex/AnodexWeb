# Anodex website

A complete replacement of the previous landing page. A static, responsive website for Anodex desktop and Anodex Mobile, using the supplied Anodex brand assets and product copy grounded in the current applications and the Mobile product/security handoff.

## Local development

Node.js 20.11+ is required. There are no third-party JavaScript dependencies or install step.

```sh
npm run dev
npm test
npm run build
```

The local preview runs at http://127.0.0.1:4173. The build copies public files to `dist/` and verifies referenced assets.

## Downloads update automatically

`releases.js` reads the public GitHub releases APIs for `Anodex/Anodex` and `Anodex/anodex-mobile`. It selects the most recently published, non-draft release. Preview/prerelease tags are clearly labelled, including Mobile tags that GitHub itself marks as stable.

- Fetch on page load, every five minutes while visible, and when a visitor returns after at least a minute.
- Installer URLs, versions, dates, sizes, architectures, and release-note links come from the API. No pinned version numbers or generated installer filenames.
- Match Windows EXE/MSI, macOS DMG, Linux AppImage/DEB/RPM, and Android APK. Ignore update metadata, blockmaps, source archives, and incomplete uploads. Show each available architecture/package.
- A missing platform links to the selected release with an explicit unavailable message. Never silently substitute an older release.
- Network errors, rate limits, invalid responses, or an eight-second timeout restore official release-page links. No JavaScript also leaves usable links. No GitHub token is shipped to visitors.
- GitHub's public API has unauthenticated rate limits. Its release pages are always the fallback. No website rebuild or cross-repository workflow is needed when a product release is published.

## Hosting

The repository remains compatible with the existing GitHub Pages configuration: the root contains `index.html` and all required assets; `CNAME` preserves `www.anodex.dev`. Publishing these changes to the Pages source branch will replace the public site.

`npm run build` also produces a static artifact for other hosts. `.openai/hosting.json` tracks the separate private Sites review deployment. Neither hosting option requires a backend.

## Content and design sources

- Desktop source, product features, and release assets: https://github.com/Anodex/Anodex
- Mobile source and release assets: https://github.com/Anodex/anodex-mobile
- User-provided `MOBILE_PRODUCT_SECURITY_UI_HANDOFF.md` (2026-09-08).
- Brand mark: the supplied `resources/brand/title-logo.png`, with its high-resolution counterpart from `src/renderer/assets/title-logo.png`. App and browser icons use the original `src/renderer/assets/app-icon.png` and `build/icon.ico`. Artwork is copied without recoloring or redrawing.

The page uses the supplied Anodex logo, subtle hover depth and a separate ambient light field, and explanatory connection diagrams. There are no simulated application screens. The hero has a static brand fallback and a pause control, and respects reduced-motion preferences. Copy avoids claims that nothing leaves the computer, cloud requests remain on-device, Mobile is LAN-only, or proposed mobile caching/biometric features already ship.

## Checks

`npm test` covers release selection, mobile preview labels, asset filtering, missing installers, trusted URLs, API failure handling, and timeouts. The CI workflow runs these checks and the static build. Browser UI testing is separate.
