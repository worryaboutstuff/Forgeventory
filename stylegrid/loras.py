"""Local LoRA discovery, sidecar previews, and organizer-only categories."""

from __future__ import annotations

import hashlib
import json
import math
import os
import uuid
from pathlib import Path

from modules import shared

from stylegrid.config import LORA_TAGS_FILE, get_lora_dirs

MODEL_EXTENSIONS = {".pt", ".ckpt", ".safetensors"}
PREVIEW_EXTENSIONS = (
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".avif",
    ".jxl",
    ".heif",
    ".heic",
    ".bmp",
)
_RECORDS_BY_ID: dict[str, dict] = {}
_WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def normalize_categories(value) -> list[str]:
    """Return up to 25 unique, display-ready category names."""
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        raise ValueError("Categories must be a list or comma-separated string")

    categories: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise ValueError("Every category must be a string")
        category = item.strip()[:100]
        key = category.casefold()
        if category and key not in seen:
            categories.append(category)
            seen.add(key)
    return categories[:25]


def load_lora_tags() -> dict[str, list[str]]:
    """Load private local LoRA categories without failing library discovery."""
    if not os.path.isfile(LORA_TAGS_FILE):
        return {}
    try:
        with open(LORA_TAGS_FILE, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(raw, dict):
        return {}

    tags: dict[str, list[str]] = {}
    for lora_id, value in raw.items():
        if not isinstance(lora_id, str):
            continue
        try:
            categories = normalize_categories(value)
        except ValueError:
            continue
        if categories:
            tags[lora_id] = categories
    return tags


def save_lora_tags(tags: dict[str, list[str]]) -> None:
    """Atomically save organizer categories beside other ignored runtime data."""
    os.makedirs(os.path.dirname(LORA_TAGS_FILE), exist_ok=True)
    cleaned = {}
    for model_id, values in tags.items():
        categories = normalize_categories(values)
        if categories:
            cleaned[str(model_id)] = categories
    temporary = LORA_TAGS_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(cleaned, handle, indent=2, ensure_ascii=False)
    os.replace(temporary, LORA_TAGS_FILE)


def lora_id(filename: str) -> str:
    """Build a stable opaque id without exposing the local absolute path."""
    normalized = os.path.normcase(os.path.abspath(filename)).replace("\\", "/")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]


def find_sidecar(filename: str) -> str | None:
    """Find a same-name or `.preview` image beside a LoRA model."""
    base = os.path.splitext(filename)[0]
    for extension in PREVIEW_EXTENSIONS:
        for candidate in (base + extension, base + ".preview" + extension):
            if os.path.isfile(candidate):
                return candidate
    return None


def _finite_float(value) -> float | None:
    """Return a finite numeric value without accepting malformed metadata."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _forge_default_lora_weight() -> float:
    """Read Forge's global extra-network multiplier with a safe legacy fallback."""
    value = _finite_float(getattr(getattr(shared, "opts", None), "extra_networks_default_multiplier", None))
    return 1.0 if value is None else value


def _format_lora_weight(value: float) -> str:
    """Keep prompt tokens compact while retaining practical decimal precision."""
    return format(value, ".12g")


def _load_forge_lora_prompt_metadata(filename: str) -> dict:
    """Read Forge's sibling user-metadata JSON and build its prompt additions."""
    metadata_path = os.path.splitext(filename)[0] + ".json"
    try:
        with open(metadata_path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError, TypeError):
        raw = {}
    if not isinstance(raw, dict):
        raw = {}

    activation_text = raw.get("activation text", "")
    negative_text = raw.get("negative text", "")
    activation_text = activation_text.strip() if isinstance(activation_text, str) else ""
    negative_text = negative_text.strip() if isinstance(negative_text, str) else ""

    preferred_weight = _finite_float(raw.get("preferred weight", 0.0))
    effective_weight = (
        preferred_weight
        if preferred_weight is not None and preferred_weight != 0.0
        else _forge_default_lora_weight()
    )
    return {
        "activation_text": activation_text,
        "negative_text": negative_text,
        "preferred_weight": preferred_weight or 0.0,
        "effective_weight": effective_weight,
    }


def _walk_model_files(root: str):
    if not os.path.isdir(root):
        return
    for directory, child_dirs, filenames in os.walk(root, followlinks=False):
        child_dirs[:] = sorted(child_dirs, key=str.casefold)
        for filename in sorted(filenames, key=str.casefold):
            if Path(filename).suffix.casefold() in MODEL_EXTENSIONS:
                yield os.path.join(directory, filename)


def scan_loras() -> list[dict]:
    """Scan all configured Forge LoRA roots recursively."""
    tags = load_lora_tags()
    records: list[dict] = []
    seen_paths: set[str] = set()
    for root_index, root in enumerate(get_lora_dirs()):
        root_path = os.path.abspath(root)
        for filename in _walk_model_files(root_path) or ():
            normalized = os.path.normcase(os.path.abspath(filename))
            if normalized in seen_paths:
                continue
            seen_paths.add(normalized)
            model_id = lora_id(filename)
            name = Path(filename).stem
            preview = find_sidecar(filename)
            prompt_metadata = _load_forge_lora_prompt_metadata(filename)
            token = f"<lora:{name}:{_format_lora_weight(prompt_metadata['effective_weight'])}>"
            positive_prompt = token
            if prompt_metadata["activation_text"]:
                positive_prompt += " " + prompt_metadata["activation_text"]
            try:
                relative_path = os.path.relpath(filename, root_path)
            except ValueError:
                relative_path = os.path.basename(filename)
            records.append(
                {
                    "id": model_id,
                    "name": name,
                    "token": token,
                    "prompt": positive_prompt,
                    "activation_text": prompt_metadata["activation_text"],
                    "negative_prompt": prompt_metadata["negative_text"],
                    "preferred_weight": prompt_metadata["preferred_weight"],
                    "effective_weight": prompt_metadata["effective_weight"],
                    "relative_path": relative_path.replace("\\", "/"),
                    "root": os.path.basename(root_path.rstrip("\\/")) or f"Root {root_index + 1}",
                    "categories": tags.get(model_id, []),
                    "has_preview": preview is not None,
                    "preview_version": int(os.path.getmtime(preview)) if preview else 0,
                    "_filename": filename,
                    "_preview": preview,
                }
            )
    records.sort(key=lambda item: (item["name"].casefold(), item["relative_path"].casefold()))
    global _RECORDS_BY_ID
    _RECORDS_BY_ID = {record["id"]: record for record in records}
    return records


def public_lora_records() -> list[dict]:
    """Return browser-safe records with no local absolute paths."""
    return [
        {key: value for key, value in record.items() if not key.startswith("_")}
        for record in scan_loras()
    ]


def resolve_lora(model_id: str) -> dict | None:
    """Resolve an opaque id against the current configured roots."""
    cached = _RECORDS_BY_ID.get(model_id)
    if cached and os.path.isfile(cached["_filename"]):
        return cached
    scan_loras()
    return _RECORDS_BY_ID.get(model_id)


def validate_lora_stem(value) -> str:
    """Validate a filename stem without accepting paths or Windows-unsafe names."""
    if not isinstance(value, str):
        raise ValueError("LoRA name must be a string")
    stem = value.strip()
    if not stem:
        raise ValueError("LoRA name is required")
    if len(stem) > 200:
        raise ValueError("LoRA name must be 200 characters or fewer")
    if stem.endswith((".", " ")):
        raise ValueError("LoRA name cannot end with a dot or space")
    if any(character in '<>:"/\\|?*' or ord(character) < 32 for character in stem):
        raise ValueError("LoRA name contains characters that are not allowed in filenames")
    if stem.split(".", 1)[0].upper() in _WINDOWS_RESERVED_NAMES:
        raise ValueError("That name is reserved by Windows")
    return stem


def _same_path(first: Path, second: Path) -> bool:
    return os.path.normcase(os.path.abspath(first)) == os.path.normcase(os.path.abspath(second))


def rename_lora_bundle(model_id: str, new_name: str) -> dict:
    """Rename a LoRA model and every same-basename sidecar, rolling back on failure."""
    record = resolve_lora(model_id)
    if record is None:
        raise FileNotFoundError("LoRA not found")

    model_path = Path(record["_filename"])
    old_name = model_path.stem
    new_stem = validate_lora_stem(new_name)
    if new_stem == old_name:
        return {
            "old_name": old_name,
            "new_name": new_stem,
            "id": model_id,
            "renamed": [],
        }

    old_key = old_name.casefold()
    sources = sorted(
        (
            candidate for candidate in model_path.parent.iterdir()
            if candidate.is_file()
            and (
                candidate.name.casefold() == old_key
                or candidate.name.casefold().startswith(old_key + ".")
            )
        ),
        key=lambda candidate: candidate.name.casefold(),
    )
    if not any(_same_path(candidate, model_path) for candidate in sources):
        raise FileNotFoundError("LoRA model file was not found")

    pairs = [
        (source, source.with_name(new_stem + source.name[len(old_name):]))
        for source in sources
    ]
    source_keys = {os.path.normcase(os.path.abspath(source)) for source in sources}
    destination_keys: set[str] = set()
    for _, destination in pairs:
        destination_key = os.path.normcase(os.path.abspath(destination))
        if destination_key in destination_keys:
            raise FileExistsError("More than one file would receive the same name")
        destination_keys.add(destination_key)
        if destination.exists() and destination_key not in source_keys:
            raise FileExistsError(f"A file named {destination.name} already exists")

    staged: list[tuple[Path, Path, Path]] = []
    completed: list[tuple[Path, Path, Path]] = []
    try:
        for source, destination in pairs:
            temporary = source.with_name(f".{source.name}.{uuid.uuid4().hex}.stylegrid-rename.tmp")
            os.replace(source, temporary)
            staged.append((source, temporary, destination))
        for item in staged:
            source, temporary, destination = item
            os.replace(temporary, destination)
            completed.append(item)
    except OSError:
        for source, _, destination in reversed(completed):
            try:
                if destination.exists():
                    os.replace(destination, source)
            except OSError:
                pass
        for source, temporary, _ in reversed(staged):
            try:
                if temporary.exists():
                    os.replace(temporary, source)
            except OSError:
                pass
        raise

    tags = load_lora_tags()
    tags_changed = False
    for source, destination in pairs:
        if source.suffix.casefold() not in MODEL_EXTENSIONS:
            continue
        old_id = lora_id(str(source))
        new_id = lora_id(str(destination))
        if old_id in tags:
            tags[new_id] = tags.pop(old_id)
            tags_changed = True
    if tags_changed:
        try:
            save_lora_tags(tags)
        except OSError:
            for source, destination in reversed(pairs):
                try:
                    if destination.exists():
                        os.replace(destination, source)
                except OSError:
                    pass
            scan_loras()
            raise

    renamed_model = next(
        destination for source, destination in pairs
        if _same_path(source, model_path)
    )
    new_id = lora_id(str(renamed_model))
    scan_loras()
    return {
        "old_name": old_name,
        "new_name": new_stem,
        "id": new_id,
        "renamed": [destination.name for _, destination in pairs],
    }
