"""Paths and static config for Forgeventory."""

import os

from modules import shared  # type: ignore[reportMissingImports]

# Extension root (parent of scripts/)
EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(EXT_DIR, "data")
PRESETS_FILE = os.path.join(DATA_DIR, "presets.json")
USAGE_FILE = os.path.join(DATA_DIR, "usage.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
THUMBNAILS_DIR = os.path.join(DATA_DIR, "thumbnails")
PRESET_THUMBNAILS_DIR = os.path.join(DATA_DIR, "preset_thumbnails")
LORA_TAGS_FILE = os.path.join(DATA_DIR, "lora_tags.json")
UI_PREFERENCES_FILE = os.path.join(DATA_DIR, "ui_preferences.json")

for _d in [DATA_DIR, BACKUP_DIR]:
    os.makedirs(_d, exist_ok=True)
os.makedirs(THUMBNAILS_DIR, exist_ok=True)
os.makedirs(PRESET_THUMBNAILS_DIR, exist_ok=True)


def get_lora_dir():
    """Return Forge's primary configured LoRA directory."""
    configured = getattr(getattr(shared, "cmd_opts", None), "lora_dir", None)
    if configured:
        return os.path.abspath(configured)
    webui_root = os.path.dirname(os.path.dirname(EXT_DIR))
    return os.path.join(webui_root, "models", "Lora")


def get_lora_dirs():
    """Return every configured Forge LoRA root, primary first and deduplicated."""
    roots = [get_lora_dir()]
    configured = getattr(getattr(shared, "cmd_opts", None), "lora_dirs", None) or []
    if isinstance(configured, (str, os.PathLike)):
        configured = [configured]
    roots.extend(str(path) for path in configured if path)

    result = []
    seen = set()
    for root in roots:
        absolute = os.path.abspath(os.path.expanduser(str(root)))
        key = os.path.normcase(absolute)
        if key not in seen:
            seen.add(key)
            result.append(absolute)
    return result


def get_styles_dirs():
    ext_styles_dir = os.path.join(EXT_DIR, "styles")
    all_styles_parent_dirs_paths = [ext_styles_dir]
    seen = {ext_styles_dir}
    for p in shared.prompt_styles.all_styles_files:
        p_abs_str = str(p.parent.absolute())
        if p_abs_str not in seen:
            all_styles_parent_dirs_paths.append(p_abs_str)
            seen.add(p_abs_str)
    return all_styles_parent_dirs_paths


def get_all_styles_file_paths():
    ext_styles_dir = os.path.join(EXT_DIR, "styles")
    all_styles_file_paths = []
    if os.path.isdir(ext_styles_dir):
        for fname in sorted(os.listdir(ext_styles_dir)):
            if fname.lower().endswith(".csv"):
                filepath = os.path.join(ext_styles_dir, fname)
                all_styles_file_paths.append(filepath)

    samples_dir = os.path.join(EXT_DIR, "samples")
    if os.path.isdir(samples_dir):
        for fname in sorted(os.listdir(samples_dir)):
            if fname.lower().endswith(".csv"):
                filepath = os.path.join(samples_dir, fname)
                all_styles_file_paths.append(filepath)

    try:
        shared_paths = [str(p.absolute()) for p in shared.prompt_styles.all_styles_files]
        all_styles_file_paths.extend(shared_paths)
    except Exception:
        shared_paths = []
    webui_root = os.getcwd()
    for fname in sorted(os.listdir(webui_root)):
        if fname.lower().endswith(".csv"):
            fp = os.path.join(webui_root, fname)
            if fp not in all_styles_file_paths:
                all_styles_file_paths.append(fp)
    return all_styles_file_paths
