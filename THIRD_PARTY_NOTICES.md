# Third-party notices

## Bundled fonts

Airport ships the following font files in `dist/`. Each family uses the SIL Open Font License 1.1. Keep the corresponding copyright and license text with copies of the font files.

| Font family | Bundled files | Copyright and license |
| --- | --- | --- |
| Bricolage Grotesque | `bricolage-latin.woff2` | © 2022 The Bricolage Grotesque Project Authors. [License](dist/Bricolage-Grotesque-license.txt) |
| Public Sans | `public.ttf`, `public-semibold.ttf`, `public-sans-regular.woff2`, `public-sans-semibold.woff2` | © 2015 The Public Sans Project Authors. [License](dist/Public-Sans-license.txt) |
| IBM Plex Mono | `plex.ttf` | © 2017 IBM Corp. Reserved Font Name “Plex”. [License](dist/IBM-Plex-Mono-license.txt) |

## Integration catalog and product marks

The bundled directory uses Composio toolkit metadata for integration names, authentication methods and tool counts. The catalog and images are snapshots. [Toolkit API](https://docs.composio.dev/reference/api-reference/toolkits/getToolkits) · [Catalog](dist/toolkits.json)

The integration artwork in `dist/integrations/` comes from Composio’s logo service and, for the individual Zoho products, Zoho’s brand kit. The refresh script records the source URLs and converts the images to WebP. [Refresh script](live/refresh-integration-icons.py) · [Zoho brand kit](https://www.zoho.com/branding-kit.html)

The images in `dist/agents/` identify the agents listed below. These links identify their publishers’ product pages.

| Image | Product |
| --- | --- |
| `muse.png` | [Muse from Meta](https://apps.apple.com/us/app/muse-from-meta/id6760173601) |
| `dots.png` | [Dots](https://chatgpt.com/features/dots/) |
| `duet.png` | [Claude Duet](https://apps.apple.com/us/app/claude-duet-by-anthropic/id6803276000) |
| `grok-bot.png` | [Grok Bot](https://apps.apple.com/us/app/grok-bot/id6794501026) |
| `instinct.png` | [Instinct](https://instinct.com/) |

Third-party names and logos, including inline product marks in `dist/icons.js`, belong to their respective rights holders. Consult each publisher’s brand and usage terms when reusing or redistributing its marks. The Airport project license grants rights only in material the project is authorized to license.

## Installed software

The lockfile pins the Node.js packages used by the gateway and its browser tests. Their license and notice files ship with the installed packages. [Lockfile](live/package-lock.json)

| Package | Use | License files in `live/node_modules/` after `npm ci` |
| --- | --- | --- |
| `jose` | Runtime | `jose/LICENSE.md` (MIT) |
| `playwright-core` | Browser tests | `playwright-core/LICENSE` (Apache-2.0), `playwright-core/NOTICE`, `playwright-core/ThirdPartyNotices.txt` |
