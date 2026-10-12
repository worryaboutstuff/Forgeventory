"""Thumbnail file paths, listing, and background SD preview generation."""

import hashlib
import json
import os
import threading

from stylegrid.cache import get_cached_styles
from stylegrid.config import DATA_DIR, THUMBNAILS_DIR, get_styles_dirs
from stylegrid.csv_io import categorize_styles


PREVIEW_SETTINGS_FILE = os.path.join(DATA_DIR, "preview_settings.json")

DEFAULT_PREVIEW_SETTINGS = {
    "prompt_template": (
        "fashion model, full-body reference image, {style_prompt}, "
        "neutral studio background, clear view of styling details"
    ),
    "placeholder_prompt": "adult fashion model",
    "negative_prompt": (
        "low quality, blurry, "
        "distorted anatomy, bad hands, bad feet, watermark, text"
    ),
    "append_style_negative": True,
    "width": 384,
    "height": 256,
    "steps": 9,
    "cfg_scale": 0.0,
    "sampler_name": "Euler",
    "scheduler": "Simple",
    "webp_quality": 85,
    "category_prompt_templates": {
        "EXPRESSIONS": (
            "close-up portrait of a model, {style_prompt}, "
            "neutral studio background, clear facial expression"
        ),
        "MAKEUP_": (
            "close-up beauty portrait of a model, {style_prompt}, "
            "neutral studio background, clear makeup detail"
        ),
        "HAIR_": (
            "beauty portrait of a model, {style_prompt}, "
            "neutral studio background, clear view of the hairstyle"
        ),
        "SHOES_": (
            "full-body fashion reference image of an adult model, "
            "clear view of the footwear, {style_prompt}, neutral studio background"
        ),
        "LINGERIE_": (
            "boudoir editorial reference image, {style_prompt}, "
            "soft studio lighting, clear garment detail"
        ),
        "ART_": (
            "portrait of a model, {style_prompt}, simple composition, "
            "clear view of the art style"
        ),
        "PHOTO_": (
            "professional model photoshoot reference image, {style_prompt}, "
            "clear composition"
        ),
    },
}


def _load_preview_settings():
    settings = dict(DEFAULT_PREVIEW_SETTINGS)
    settings["category_prompt_templates"] = dict(
        DEFAULT_PREVIEW_SETTINGS["category_prompt_templates"]
    )
    try:
        with open(PREVIEW_SETTINGS_FILE, "r", encoding="utf-8") as f:
            user_settings = json.load(f)
    except Exception:
        user_settings = {}

    if isinstance(user_settings, dict):
        for key, value in user_settings.items():
            if key == "category_prompt_templates" and isinstance(value, dict):
                settings["category_prompt_templates"].update(value)
            else:
                settings[key] = value
    return settings


def _int_setting(settings, key, default, min_value=1, max_value=4096):
    try:
        value = int(settings.get(key, default))
    except Exception:
        return default
    return max(min_value, min(max_value, value))


def _float_setting(settings, key, default, min_value=0.0, max_value=50.0):
    try:
        value = float(settings.get(key, default))
    except Exception:
        return default
    return max(min_value, min(max_value, value))


def _merge_negative(base_negative, style_negative):
    parts = []
    for chunk in (base_negative or "", style_negative or ""):
        for item in str(chunk).split(","):
            token = item.strip()
            if token and token not in parts:
                parts.append(token)
    return ", ".join(parts)


def _template_for_category(settings, category):
    templates = settings.get("category_prompt_templates")
    if not isinstance(templates, dict):
        return settings.get("prompt_template") or DEFAULT_PREVIEW_SETTINGS["prompt_template"]

    category_upper = (category or "").upper()
    best_key = ""
    best_template = None
    for key, template in templates.items():
        key_upper = str(key).upper()
        if category_upper.startswith(key_upper) and len(key_upper) > len(best_key):
            best_key = key_upper
            best_template = template
    if isinstance(best_template, str) and best_template.strip():
        return best_template
    return settings.get("prompt_template") or DEFAULT_PREVIEW_SETTINGS["prompt_template"]


def _build_preview_prompt(style, settings):
    style_prompt = style.get("prompt", "") or ""
    placeholder = settings.get("placeholder_prompt") or DEFAULT_PREVIEW_SETTINGS["placeholder_prompt"]
    style_prompt = style_prompt.replace("{prompt}", str(placeholder))
    template = _template_for_category(settings, style.get("category") or "")
    if "{style_prompt}" in template:
        return template.replace("{style_prompt}", style_prompt)
    return f"{template}, {style_prompt}".strip(", ")


def _thumbnail_hash_input(style_name, csv_path=""):
    """Stable string for thumbnail filename hash; empty csv_path keeps legacy name-only hash."""
    if not csv_path:
        return style_name
    ap = os.path.normpath(os.path.abspath(csv_path))
    rel = None
    for base in get_styles_dirs():
        try:
            b = os.path.normpath(os.path.abspath(base))
            r = os.path.relpath(ap, b)
            if not r.startswith(".."):
                rel = r.replace("\\", "/")
                break
        except ValueError:
            continue
    if rel is None:
        rel = os.path.basename(ap).replace("\\", "/")
    return f"{style_name}::{rel}"


def get_thumbnail_path(style_name, csv_path=""):
    """Return deterministic thumbnail file path using md5(name + source path) hash naming."""
    safe = hashlib.md5(_thumbnail_hash_input(style_name, csv_path).encode("utf-8")).hexdigest()
    return os.path.join(THUMBNAILS_DIR, safe + ".webp")


def list_thumbnails():
    if not os.path.isdir(THUMBNAILS_DIR):
        return set()
    hashes = {
        os.path.splitext(f)[0]
        for f in os.listdir(THUMBNAILS_DIR)
        if f.endswith(".webp")
    }
    result = set()
    for s in get_cached_styles():
        h = hashlib.md5(
            _thumbnail_hash_input(s["name"], s.get("source_file") or "").encode("utf-8")
        ).hexdigest()
        if h in hashes:
            result.add(s["name"])
    return result


class ThumbnailGenerationManager:
    """Manages async thumbnail jobs: reserve style, run worker, and expose per-style status."""

    def __init__(self):
        self._gen_status = {}
        self._gen_lock = threading.Lock()

    def get_status(self, style_name):
        """Return current generation status dict for a style (idle/running/done/error)."""
        with self._gen_lock:
            return self._gen_status.get(style_name, {"status": "idle"})

    def try_begin(self, style_name):
        """Reserve style generation slot; returns False if same style is already running."""
        with self._gen_lock:
            if self._gen_status.get(style_name, {}).get("status") == "running":
                return False
            self._gen_status[style_name] = {"status": "running"}
            return True

    def spawn_generate(self, style_name, source_hint=None):
        """Start background thumbnail generation thread for a style already marked running."""
        t = threading.Thread(
            target=self._run_generation, args=(style_name, source_hint), daemon=True
        )
        t.start()

    def _run_generation(self, style_name, source_hint=None):
        thumb_csv_path = ""
        try:
            all_cached = get_cached_styles()
            categorize_styles(all_cached)
            style = None
            if source_hint and source_hint != "All":
                for s in all_cached:
                    if s.get("name") == style_name and source_hint in (
                        s.get("source") or "", s.get("source_file") or ""
                    ):
                        style = s
                        break
            if style is None:
                style_map = {s["name"]: s for s in all_cached}
                style = style_map.get(style_name)
            if not style:
                with self._gen_lock:
                    self._gen_status[style_name] = {
                        "status": "error", "message": "Style not found"
                    }
                return

            thumb_csv_path = style.get("source_file") or ""

            old_path = get_thumbnail_path(style_name, thumb_csv_path)
            if os.path.isfile(old_path):
                os.remove(old_path)

            img_path = get_thumbnail_path(style_name, thumb_csv_path)
            tmp_path = img_path + ".tmp"

            settings = _load_preview_settings()
            prompt = _build_preview_prompt(style, settings)
            negative = settings.get("negative_prompt", "")
            if settings.get("append_style_negative", True):
                negative = _merge_negative(negative, style.get("negative_prompt", ""))

            from modules import processing  # type: ignore[reportMissingImports]
            from modules.processing import (
                StableDiffusionProcessingTxt2Img,  # type: ignore[reportMissingImports]
            )
            from modules.shared import sd_model  # type: ignore[reportMissingImports]

            p = StableDiffusionProcessingTxt2Img(
                sd_model=sd_model,
                prompt=prompt,
                negative_prompt=negative,
                seed=-1,
                steps=_int_setting(settings, "steps", 9),
                cfg_scale=_float_setting(settings, "cfg_scale", 0.0),
                width=_int_setting(settings, "width", 512, min_value=64),
                height=_int_setting(settings, "height", 768, min_value=64),
                batch_size=1,
                n_iter=1,
                do_not_save_samples=True,
                do_not_save_grid=True,
                override_settings={"samples_filename_pattern": ""},
            )
            sampler_name = str(settings.get("sampler_name") or "").strip()
            if sampler_name:
                p.sampler_name = sampler_name
            scheduler = str(settings.get("scheduler") or settings.get("scheduler_name") or "").strip()
            if scheduler:
                for attr in ("scheduler", "scheduler_name"):
                    try:
                        setattr(p, attr, scheduler)
                    except Exception:
                        pass

            # Empty ScriptRunner — thumbnail generation must not trigger
            # extension scripts (Regional Prompter, ControlNet, etc.)
            # We only need p.scripts to not be None so Reforge's
            # process_images_inner can safely iterate alwayson_scripts.
            try:
                from modules.scripts import ScriptRunner
                p.scripts = ScriptRunner()
                p.scripts.scripts = []
                p.scripts.alwayson_scripts = []
                p.script_args = []
            except Exception:
                pass

            try:
                processed = processing.process_images(p)
            finally:
                p.close()

            if not processed.images:
                raise ValueError("No images returned")

            processed.images[0].save(
                tmp_path,
                "WEBP",
                quality=_int_setting(settings, "webp_quality", 85, min_value=1, max_value=100),
            )
            if os.path.isfile(img_path):
                os.remove(img_path)
            os.rename(tmp_path, img_path)

            with self._gen_lock:
                self._gen_status[style_name] = {"status": "done"}

        except Exception as e:
            try:
                tmp_path = get_thumbnail_path(style_name, thumb_csv_path) + ".tmp"
                if os.path.isfile(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            with self._gen_lock:
                self._gen_status[style_name] = {
                    "status": "error", "message": str(e)
                }


thumbnail_generation_manager = ThumbnailGenerationManager()
