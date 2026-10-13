# Changelog

## Public release

- Added a current GitHub README interface tour covering the Style library, context menus, Library Tools, presets, scene management, and LoRA browser.
- Added portable `.forgeventory` sharing for individual Styles and flattened presets, with optional embedded previews, recipient-chosen categories/tags, and safe duplicate handling.
- Made the extension folder-independent and standardized new installations on the `Forgeventory` directory name while preserving compatibility with legacy checkout names.
- Added prompt-neutral Style organizer tags with sidebar single/multi-tag filtering, three-state batch editing, paired prompt-format synchronization, and right-click global rename.
- Added right-click Style category renaming for exact grouped categories and top-level sidebar families across prompt-format sheets.
- Fixed the narrow-sidebar batch action layout so button labels remain readable.
- Added a **Forgeventory on GitHub** shortcut at the bottom of the Library Tools menu.
- Added explicit **Multi-category select** and **Multi-tag select** labels, multi-category Style filtering, and source-safe batch Style category editing alongside temporary wildcard creation.
- Stored durable Forgeventory UI preferences in a private, Git-ignored extension data file so clearing browser site data no longer resets layout, favorites, recents, source, ordering, or multi-select choices.
- Renamed the user-facing extension to Forgeventory and added a pixel-art inventory bag mark while retaining compatible internal routes, tokens, and storage keys.
- Replaced the broad initial style snapshot with a compact frozen starter library: 12 examples in two paired Natural Language and Tags sheets, including organizer tags and 24 source-aware card thumbnails.
- Added a recursive LoRA browser with direct model-folder sidecar previews, Forge metadata editing, and local multi-category tags.
- Published the substantially modified Forgeventory interface and backend as a clean public distribution.
- Added a current Forgeventory interface screenshot to the public README.
- Excluded personal presets, preset thumbnails, LoRA organizer tags, LoRA files and sidecars, local style additions, source previews, and runtime data.
