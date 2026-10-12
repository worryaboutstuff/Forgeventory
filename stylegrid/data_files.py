"""Presets, usage stats, CSV backups (JSON / filesystem under data/)."""

import json
import os
import shutil
import threading
import time
import zipfile
from copy import deepcopy

from stylegrid.config import (
    BACKUP_DIR,
    PRESETS_FILE,
    UI_PREFERENCES_FILE,
    USAGE_FILE,
    get_all_styles_file_paths,
)

DEFAULT_PRESETS = {
    "Starter Template": {
        "styles": [],
        "created": "2026-09-22T07:32:49",
        "pinned": True,
        "prompt": "**Subject**\n\n\n**Action/Pose**\n\n\n**Location**\n\n\n**Details**",
        "description": (
            "Insert Subject, Action/Pose, Location, and Details headings with blank lines "
            "at the prompt cursor."
        ),
    }
}

DEFAULT_UI_PREFERENCES = {
    "compact_mode": False,
    "group_by_category": False,
    "favorites": [],
    "recent_names": [],
    "active_source": None,
    "category_order": [],
    "style_multi_select": False,
    "style_tag_multi_select": False,
    "preset_multi_select": False,
    "lora_multi_select": False,
}

_UI_PREFERENCES_LOCK = threading.RLock()


def _normalize_string_list(value, *, limit):
    if not isinstance(value, list):
        return []
    result = []
    seen = set()
    for item in value:
        if not isinstance(item, str):
            continue
        item = item.strip()
        key = item.casefold()
        if not item or key in seen:
            continue
        result.append(item[:4096])
        seen.add(key)
        if len(result) >= limit:
            break
    return result


def normalize_ui_preferences(value):
    """Return the supported preference schema with bounded, typed values."""
    source = value if isinstance(value, dict) else {}
    preferences = deepcopy(DEFAULT_UI_PREFERENCES)
    for key in (
        "compact_mode",
        "group_by_category",
        "style_multi_select",
        "style_tag_multi_select",
        "preset_multi_select",
        "lora_multi_select",
    ):
        if isinstance(source.get(key), bool):
            preferences[key] = source[key]

    active_source = source.get("active_source")
    if isinstance(active_source, str):
        preferences["active_source"] = active_source.strip()[:4096] or None
    elif active_source is None:
        preferences["active_source"] = None

    preferences["favorites"] = _normalize_string_list(source.get("favorites"), limit=5000)
    preferences["recent_names"] = _normalize_string_list(
        source.get("recent_names"), limit=10
    )
    preferences["category_order"] = _normalize_string_list(
        source.get("category_order"), limit=1000
    )
    return preferences


def load_ui_preferences_with_status():
    """Load private UI preferences and report whether a valid file existed."""
    with _UI_PREFERENCES_LOCK:
        if not os.path.isfile(UI_PREFERENCES_FILE):
            return deepcopy(DEFAULT_UI_PREFERENCES), False
        try:
            with open(UI_PREFERENCES_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                return deepcopy(DEFAULT_UI_PREFERENCES), False
            return normalize_ui_preferences(raw), True
        except (OSError, ValueError, TypeError):
            return deepcopy(DEFAULT_UI_PREFERENCES), False


def load_ui_preferences():
    preferences, _ = load_ui_preferences_with_status()
    return preferences


def update_ui_preferences(patch):
    """Merge a supported preference patch and replace the private file atomically."""
    if not isinstance(patch, dict):
        raise ValueError("Preferences must be a JSON object")
    with _UI_PREFERENCES_LOCK:
        current, _ = load_ui_preferences_with_status()
        supported_patch = {
            key: value
            for key, value in patch.items()
            if key in DEFAULT_UI_PREFERENCES
        }
        preferences = normalize_ui_preferences({**current, **supported_patch})
        os.makedirs(os.path.dirname(UI_PREFERENCES_FILE), exist_ok=True)
        temporary_path = UI_PREFERENCES_FILE + ".tmp"
        with open(temporary_path, "w", encoding="utf-8") as f:
            json.dump(preferences, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(temporary_path, UI_PREFERENCES_FILE)
        return preferences


def load_presets():
    presets = deepcopy(DEFAULT_PRESETS)
    if os.path.isfile(PRESETS_FILE):
        try:
            with open(PRESETS_FILE, "r", encoding="utf-8") as f:
                local_presets = json.load(f)
            if isinstance(local_presets, dict):
                presets.update(local_presets)
        except Exception:
            pass
    return presets


def save_presets(presets):
    with open(PRESETS_FILE, "w", encoding="utf-8") as f:
        json.dump(presets, f, indent=2, ensure_ascii=False)


def load_usage():
    if os.path.isfile(USAGE_FILE):
        try:
            with open(USAGE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_usage(usage):
    with open(USAGE_FILE, "w", encoding="utf-8") as f:
        json.dump(usage, f, indent=2, ensure_ascii=False)


def increment_usage(style_names):
    usage = load_usage()
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    for name in style_names:
        if name not in usage:
            usage[name] = {"count": 0, "last_used": None, "first_used": ts}
        usage[name]["count"] = usage[name].get("count", 0) + 1
        usage[name]["last_used"] = ts
    save_usage(usage)


def backup_csv_files():
    ts = time.strftime("%Y%m%d_%H%M%S")
    backup_subdir = os.path.join(BACKUP_DIR, ts)
    backed_up = False

    for fp in get_all_styles_file_paths():
        if not os.path.isfile(fp):
            continue
        if not backed_up:
            os.makedirs(backup_subdir, exist_ok=True)
            backed_up = True
        fname = os.path.basename(fp)
        shutil.copy2(fp, os.path.join(backup_subdir, fname))

    if os.path.isfile(PRESETS_FILE):
        if not backed_up:
            os.makedirs(backup_subdir, exist_ok=True)
            backed_up = True
        shutil.copy2(PRESETS_FILE, os.path.join(backup_subdir, "presets.json"))

    if backed_up:
        zip_path = backup_subdir + ".zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fp in get_all_styles_file_paths():
                if os.path.isfile(fp):
                    zf.write(fp, arcname=os.path.basename(fp))
            if os.path.isfile(PRESETS_FILE):
                zf.write(PRESETS_FILE, arcname="presets.json")

    if os.path.isdir(BACKUP_DIR):
        backups = sorted(os.listdir(BACKUP_DIR))
        while len(backups) > 20:
            old_name = backups.pop(0)
            old_path = os.path.join(BACKUP_DIR, old_name)
            if os.path.isdir(old_path):
                shutil.rmtree(old_path, ignore_errors=True)
            elif os.path.isfile(old_path) and old_name.endswith(".zip"):
                try:
                    os.remove(old_path)
                except Exception:
                    pass
    return backed_up
