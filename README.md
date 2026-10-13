# Forgeventory

Forgeventory replaces Forge's style dropdown with a visual, searchable prompt library for both `txt2img` and `img2img`. This repository contains the extension and a fixed initial paired Natural Language and Tags style library with matching card thumbnails, without personal presets or LoRA data.

This is a substantially modified fork of [Style Grid for Forge by KazeKaze93](https://github.com/KazeKaze93/sd-webui-style-organizer). See [NOTICE.md](NOTICE.md) for attribution and modification information.

![Forgeventory interface showing category navigation and visual style cards](screenshots/Main_UI.jpg)

## Features

- Searchable style cards with source filters and optional multi-category and multi-tag filtering
- Top-level category navigation with right-click family/category renaming, Favorites, and Recent
- Standard and compact card layouts, category grouping, and fullscreen mode, with durable private preferences that survive cleared browser data
- Style creation, editing, duplication, source-safe batch category and organizer-tag editing, prompt replacement, and deletion
- Exact style tokens, category wildcards, and temporary wildcards assembled from batch-selected cards
- Manual preview assignment and Forge-based preview generation
- A recursive LoRA browser with in-place registry reload, direct sidecar previews, local multi-tag organization, multi-tag filtering, safe three-state batch tag editing, global tag rename, and same-basename model/sidecar renaming
- Reusable prompt presets with multiple categories and optional thumbnails
- Preset cards in the same browsing interface as styles, with multi-category filtering, safe three-state batch category editing, and global category rename
- Portable single-Style and flattened-preset sharing with optional embedded previews and local category/tag assignment on import
- `txt2img` and `img2img` support
- CSV backup, import, and export tools
- A shortcut for opening Forge's LoRA folder

## Interface tour

### Style library and tools

<table>
  <tr>
    <td width="67%"><img src="screenshots/Main_UI_Menu.jpg" alt="Forgeventory Style card context menu"></td>
    <td width="33%"><img src="screenshots/Main_Menu.jpg" alt="Forgeventory Library Tools menu"></td>
  </tr>
  <tr>
    <td align="center"><sub>Style actions include prompt editing, sharing, category changes, and preview management.</sub></td>
    <td align="center"><sub>Display controls and library-wide tools.</sub></td>
  </tr>
</table>

### Presets and scenes

<table>
  <tr>
    <td width="50%"><img src="screenshots/Presets_UI.jpg" alt="Forgeventory preset library"></td>
    <td width="50%"><img src="screenshots/Presets_UI_Menu.jpg" alt="Forgeventory preset context menu"></td>
  </tr>
  <tr>
    <td align="center"><sub>Browse saved scenes by one or several categories.</sub></td>
    <td align="center"><sub>Load, revise, organize, share, and assign images to presets.</sub></td>
  </tr>
</table>

<p align="center">
  <img src="screenshots/Manage_Templates.jpg" alt="Forgeventory scene and template manager" width="70%">
</p>
<p align="center"><sub>Save and search complete positive and negative prompt scenes.</sub></p>

### LoRA browser

<table>
  <tr>
    <td width="50%"><img src="screenshots/LoRA_UI.jpg" alt="Forgeventory LoRA browser"></td>
    <td width="50%"><img src="screenshots/LoRA_UI_Menu.jpg" alt="Forgeventory LoRA context menu"></td>
  </tr>
  <tr>
    <td align="center"><sub>Browse Forge's configured LoRA folders with local organizer tags.</sub></td>
    <td align="center"><sub>Apply LoRAs, edit Forge metadata, rename bundles, and manage tags.</sub></td>
  </tr>
</table>

## Installation

Git LFS is required for the compiled UI fonts and for any preview images that contributors intentionally add later.

```powershell
git lfs install
cd A:\path\to\Forge\extensions
git clone https://github.com/worryaboutstuff/Forgeventory.git Forgeventory
```

Restart Forge after installing or updating the extension. Node.js is not required for normal use because the compiled interface is included under `ui/dist`.

Forgeventory derives the compiled-interface URL from its installed directory. `Forgeventory` is the standard folder name, while the legacy `sd-webui-style-organizer` name remains compatible for existing installations.

## Included and local styles

The repository includes a compact fixed starter library of 12 example styles spanning aesthetics, clothing, hair, makeup, settings, and subject controls. Every example appears in both `Forgeventory - Natural Language.csv` and `Forgeventory - Tags.csv`, with organizer tags and a matching source-aware card thumbnail. Future releases update extension functionality and documentation without adding, changing, or removing this bundled sample snapshot.

You can edit the included library, create another CSV through the interface, or add an existing Forge-compatible style CSV.

CSV rows use these fields:

```text
name,prompt,negative_prompt,description,category,organizer_tags
```

Forgeventory inserts a readable token such as `{sg:Style Name}` into the prompt. The token expands when generation begins. A category wildcard such as `{sg:examples}` selects a random matching style.

Categories provide structure. The optional semicolon-separated `organizer_tags` field provides fine filtering across categories and never enters the generated prompt. Batch tag edits can preserve mixed values and mirror changes between paired Natural Language and Tags sheets.

See [docs/CSV_FORMAT.md](docs/CSV_FORMAT.md) for the complete format.

## Sharing individual items

Right-click a Style or preset card and choose **Export...** to create one portable `.forgeventory` file. Style packages include paired Natural Language and Tags prompts when available. Preset packages contain resolved positive and negative text, so they do not depend on matching Style names in another installation. An existing WebP card preview is embedded when available.

Import through **Library tools > Import shared item...**. Before writing anything, Forgeventory asks which local category and tags to use for a Style, or which local categories to use for a preset. Sender suggestions remain editable, and name conflicts can be copied, replaced, or canceled without changing the recipient's taxonomy.

## Private local data

The following paths are ignored so personal content is not committed accidentally:

- `data/presets.json`
- `data/preset_thumbnails/`
- `data/lora_tags.json`
- `data/ui_preferences.json`
- `data/category_order.json` (legacy panel compatibility)
- `data/*_previews/`
- `data/usage.json`
- `data/backups/`
- Additional local `styles/*.csv` files

The initial style CSVs and their exact card thumbnails are tracked as a frozen snapshot. Newly created local CSVs and thumbnails remain ignored so personal additions are not committed accidentally.

## Development

The Forge entry point is `scripts/style_grid.py`. Backend code is in `stylegrid/`, host integration is in `javascript/`, and React source is in `ui/src/`.

After changing the interface:

```powershell
npm --prefix ui ci
npm --prefix ui run lint
npm --prefix ui run build
```

Run Python tests with:

```powershell
pytest tests -v
```

Commit `ui/dist` with its corresponding source changes because Forge loads that compiled bundle directly.

## License

Forgeventory is distributed under the [GNU Affero General Public License, version 3](LICENSE). The public repository includes the complete corresponding source, including the React source and build configuration used for the compiled interface.

Notices and license texts for the JavaScript and font packages used in the compiled interface are included in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

