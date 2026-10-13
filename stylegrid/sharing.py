"""Portable single-item packages for Forgeventory styles and presets."""

from __future__ import annotations

import io
import json
import os
import re
import time
import zipfile

from stylegrid.wildcards import resolve_sg_wildcards_with_styles

SHARE_SCHEMA = "forgeventory.shared-item"
SHARE_VERSION = 1
MAX_PACKAGE_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
MAX_PREVIEW_BYTES = 2 * 1024 * 1024


class SharePackageError(ValueError):
    """Raised when a shared-item package is invalid or cannot be resolved."""


def safe_package_filename(name: str) -> str:
    """Return a filesystem-friendly package filename without exposing paths."""
    safe = re.sub(r"[^\w .()-]+", "-", str(name or "").strip(), flags=re.UNICODE)
    safe = re.sub(r"\s+", " ", safe).strip(" .-")[:120]
    return f"{safe or 'Forgeventory item'}.forgeventory"


def create_share_package(manifest: dict, preview: bytes | None = None) -> bytes:
    """Create a one-file ZIP package containing a manifest and optional WebP preview."""
    validate_manifest(manifest)
    payload = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    if len(payload) > MAX_MANIFEST_BYTES:
        raise SharePackageError("Shared-item manifest is too large")
    if preview is not None:
        if len(preview) > MAX_PREVIEW_BYTES:
            raise SharePackageError("Preview image is too large")
        if not (preview.startswith(b"RIFF") and preview[8:12] == b"WEBP"):
            raise SharePackageError("Shared previews must be WebP images")

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", payload)
        if preview is not None:
            archive.writestr("preview.webp", preview)
    package = output.getvalue()
    if len(package) > MAX_PACKAGE_BYTES:
        raise SharePackageError("Shared-item package is too large")
    return package


def read_share_package(raw: bytes) -> tuple[dict, bytes | None]:
    """Validate and read a portable Forgeventory package."""
    if not raw or len(raw) > MAX_PACKAGE_BYTES:
        raise SharePackageError("Shared-item package is empty or too large")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = [item for item in archive.infolist() if not item.is_dir()]
            names = {item.filename for item in members}
            if not names or "manifest.json" not in names:
                raise SharePackageError("Package is missing manifest.json")
            if len(names) != len(members):
                raise SharePackageError("Package contains duplicate files")
            if len(members) > 2 or not names.issubset({"manifest.json", "preview.webp"}):
                raise SharePackageError("Package contains unsupported files")
            for item in members:
                limit = MAX_MANIFEST_BYTES if item.filename == "manifest.json" else MAX_PREVIEW_BYTES
                if item.file_size > limit or item.compress_size > MAX_PACKAGE_BYTES:
                    raise SharePackageError(f"{item.filename} is too large")
            manifest_raw = archive.read("manifest.json")
            preview = archive.read("preview.webp") if "preview.webp" in names else None
    except (zipfile.BadZipFile, RuntimeError, OSError) as error:
        raise SharePackageError("Invalid Forgeventory package") from error

    try:
        manifest = json.loads(manifest_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SharePackageError("Package manifest is not valid JSON") from error
    validate_manifest(manifest)
    if preview is not None and not (
        preview.startswith(b"RIFF") and len(preview) >= 12 and preview[8:12] == b"WEBP"
    ):
        raise SharePackageError("Package preview is not a valid WebP image")
    return manifest, preview


def validate_manifest(manifest: object) -> None:
    """Validate the stable public portion of a shared-item manifest."""
    if not isinstance(manifest, dict):
        raise SharePackageError("Package manifest must be an object")
    if manifest.get("schema") != SHARE_SCHEMA or manifest.get("version") != SHARE_VERSION:
        raise SharePackageError("Unsupported Forgeventory package version")
    kind = manifest.get("kind")
    item = manifest.get("item")
    if kind not in {"style", "preset"} or not isinstance(item, dict):
        raise SharePackageError("Package item type is invalid")
    name = item.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
        raise SharePackageError("Package item name is invalid")
    description = item.get("description", "")
    if not isinstance(description, str) or len(description) > 20_000:
        raise SharePackageError("Package item description is invalid")
    if kind == "style":
        suggested_category = item.get("suggested_category", "")
        if not isinstance(suggested_category, str) or len(suggested_category) > 100:
            raise SharePackageError("Style category suggestion is invalid")
        suggested_tags = item.get("suggested_tags", [])
        if not isinstance(suggested_tags, list) or len(suggested_tags) > 25:
            raise SharePackageError("Style tag suggestions are invalid")
        if any(not isinstance(tag, str) or len(tag) > 100 for tag in suggested_tags):
            raise SharePackageError("Style tag suggestions are invalid")
        variants = item.get("variants")
        if not isinstance(variants, list) or not 1 <= len(variants) <= 3:
            raise SharePackageError("Style package must contain prompt variants")
        seen_formats = set()
        for variant in variants:
            if not isinstance(variant, dict):
                raise SharePackageError("Style prompt variant is invalid")
            format_name = variant.get("format")
            if format_name not in {"natural_language", "tags", "generic"}:
                raise SharePackageError("Style prompt format is invalid")
            if format_name in seen_formats:
                raise SharePackageError("Style package contains duplicate prompt formats")
            seen_formats.add(format_name)
            for field in ("prompt", "negative_prompt"):
                value = variant.get(field, "")
                if not isinstance(value, str) or len(value) > 200_000:
                    raise SharePackageError(f"Style {field} is invalid")
    else:
        suggested_categories = item.get("suggested_categories", [])
        if not isinstance(suggested_categories, list) or len(suggested_categories) > 25:
            raise SharePackageError("Preset category suggestions are invalid")
        if any(not isinstance(category, str) or len(category) > 100 for category in suggested_categories):
            raise SharePackageError("Preset category suggestions are invalid")
        for field in ("prompt", "negative_prompt"):
            value = item.get(field, "")
            if not isinstance(value, str) or len(value) > 200_000:
                raise SharePackageError(f"Preset {field} is invalid")


def prompt_format(source_file: str) -> str:
    """Identify the portable prompt format represented by a source CSV."""
    lower = os.path.basename(source_file or "").casefold()
    if lower.endswith(" - natural language.csv") or lower == "natural language.csv":
        return "natural_language"
    if lower.endswith(" - tags.csv") or lower == "tags.csv":
        return "tags"
    return "generic"


def source_family(source_file: str) -> str:
    """Return the local CSV family name used to find a paired prompt sheet."""
    basename = os.path.basename(source_file or "")
    lower = basename.casefold()
    if lower.endswith(" - natural language.csv"):
        return basename[: -len(" - Natural Language.csv")]
    if lower.endswith(" - tags.csv"):
        return basename[: -len(" - Tags.csv")]
    if lower in {"natural language.csv", "tags.csv"}:
        return ""
    return os.path.splitext(basename)[0]


def _source_matches(candidate: str, requested: str) -> bool:
    if not requested:
        return False
    candidate_norm = os.path.normcase(os.path.normpath(candidate or ""))
    requested_norm = os.path.normcase(os.path.normpath(requested))
    return candidate_norm == requested_norm or os.path.basename(candidate_norm) == os.path.basename(
        requested_norm
    )


def collect_style_variants(styles: list[dict], name: str, source_file: str = "") -> list[dict]:
    """Return the selected style row and its prompt-format partner, without unrelated duplicates."""
    matches = [style for style in styles if style.get("name") == name]
    if not matches:
        raise SharePackageError("Style not found")
    selected = next(
        (style for style in matches if _source_matches(style.get("source_file", ""), source_file)),
        matches[0],
    )
    selected_source = selected.get("source_file") or ""
    selected_format = prompt_format(selected_source)
    if selected_format == "generic":
        return [selected]
    family = source_family(selected_source).casefold()
    variants = [
        style
        for style in matches
        if source_family(style.get("source_file") or "").casefold() == family
        and prompt_format(style.get("source_file") or "") in {"natural_language", "tags"}
    ]
    variants.sort(key=lambda style: 0 if prompt_format(style.get("source_file") or "") == "natural_language" else 1)
    return variants or [selected]


def build_style_manifest(styles: list[dict], name: str, source_file: str = "") -> tuple[dict, list[dict]]:
    """Build a portable style manifest and return the source rows used for preview lookup."""
    variants = collect_style_variants(styles, name, source_file)
    selected = next(
        (style for style in variants if _source_matches(style.get("source_file", ""), source_file)),
        variants[0],
    )
    manifest = {
        "schema": SHARE_SCHEMA,
        "version": SHARE_VERSION,
        "kind": "style",
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "item": {
            "name": selected.get("name") or name,
            "description": selected.get("description") or "",
            "suggested_category": selected.get("category") or "",
            "suggested_tags": list(selected.get("organizer_tags") or []),
            "variants": [
                {
                    "format": prompt_format(style.get("source_file") or ""),
                    "prompt": style.get("prompt") or "",
                    "negative_prompt": style.get("negative_prompt") or "",
                }
                for style in variants
            ],
        },
    }
    return manifest, variants


def _dedup_prompt(prompt: str) -> str:
    result = []
    seen = set()
    for segment in str(prompt or "").split(","):
        value = segment.strip()
        if not value:
            continue
        if value.upper() == "BREAK":
            result.append(value)
            continue
        weighted = re.match(r"^\((.+?):\d+\.?\d*\)$", value)
        key = (weighted.group(1) if weighted else value).strip().casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return ", ".join(result)


def _apply_style_field(styles: list[dict], field: str) -> str:
    result = ""
    additions = []
    for style in styles:
        value = style.get(field) or ""
        if not value:
            continue
        if "{prompt}" in value:
            result = value.replace("{prompt}", result)
        else:
            additions.append(value)
    return _dedup_prompt(", ".join(value for value in [result, *additions] if value))


def flatten_preset(preset: dict, styles: list[dict], source_file: str = "") -> tuple[str, str]:
    """Turn every preset into self-contained positive and negative prompt text."""
    if preset.get("mode") == "scene" or not preset.get("styles"):
        return str(preset.get("prompt") or ""), str(preset.get("negative_prompt") or "")

    pool = styles
    if source_file:
        filtered = [
            style
            for style in styles
            if _source_matches(style.get("source_file", ""), source_file)
        ]
        if filtered:
            pool = filtered
    styles_by_name = {}
    for style in pool:
        key = str(style.get("name") or "").strip().casefold()
        if key and key not in styles_by_name:
            styles_by_name[key] = style
    requested = [str(name).strip() for name in preset.get("styles", []) if str(name).strip()]
    missing = [name for name in requested if name.casefold() not in styles_by_name]
    if missing:
        raise SharePackageError(f"Preset references a missing style: {missing[0]}")
    tokens = ", ".join(f"{{sg:{name}}}" for name in requested)
    resolved, chosen = resolve_sg_wildcards_with_styles(
        tokens,
        {},
        styles_by_name,
    )
    return _dedup_prompt(resolved), _apply_style_field(chosen, "negative_prompt")


def build_preset_manifest(
    name: str,
    preset: dict,
    styles: list[dict],
    source_file: str = "",
) -> dict:
    """Build a preset package whose payload never depends on recipient styles."""
    prompt, negative_prompt = flatten_preset(preset, styles, source_file)
    categories = preset.get("categories", preset.get("category", []))
    if isinstance(categories, str):
        categories = [categories]
    if not isinstance(categories, list):
        categories = []
    return {
        "schema": SHARE_SCHEMA,
        "version": SHARE_VERSION,
        "kind": "preset",
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "item": {
            "name": name,
            "description": str(preset.get("description") or ""),
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "suggested_categories": [str(category).strip() for category in categories if str(category).strip()],
        },
    }
