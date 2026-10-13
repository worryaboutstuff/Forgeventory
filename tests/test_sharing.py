"""Tests for portable single-item Forgeventory packages."""

import pytest

from stylegrid.sharing import (
    SharePackageError,
    build_style_manifest,
    create_share_package,
    flatten_preset,
    read_share_package,
)

WEBP_BYTES = b"RIFF\x08\x00\x00\x00WEBPVP8 "


def test_paired_style_package_round_trip_with_preview(tmp_path):
    name = "Shared Look"
    styles = [
        {
            "name": name,
            "prompt": "A complete natural-language description.",
            "negative_prompt": "wrong material",
            "description": "Portable paired style.",
            "category": "Clothing - Outfits",
            "organizer_tags": ["Glossy", "Costume"],
            "source_file": str(tmp_path / "Forgeventory - Natural Language.csv"),
        },
        {
            "name": name,
            "prompt": "complete outfit, glossy material",
            "negative_prompt": "wrong material",
            "description": "Portable paired style.",
            "category": "Clothing - Outfits",
            "organizer_tags": ["Glossy", "Costume"],
            "source_file": str(tmp_path / "Forgeventory - Tags.csv"),
        },
    ]

    manifest, rows = build_style_manifest(styles, name, styles[0]["source_file"])
    package = create_share_package(manifest, WEBP_BYTES)
    restored, preview = read_share_package(package)

    assert len(rows) == 2
    assert restored["kind"] == "style"
    assert restored["item"]["suggested_category"] == "Clothing - Outfits"
    assert restored["item"]["suggested_tags"] == ["Glossy", "Costume"]
    assert [variant["format"] for variant in restored["item"]["variants"]] == [
        "natural_language",
        "tags",
    ]
    assert preview == WEBP_BYTES


def test_style_list_preset_flattens_to_self_contained_prompt_text(tmp_path):
    source = str(tmp_path / "Forgeventory - Tags.csv")
    styles = [
        {
            "name": "Lighting",
            "prompt": "cinematic light",
            "negative_prompt": "flat light",
            "source_file": source,
        },
        {
            "name": "Portrait Wrapper",
            "prompt": "portrait of {prompt}",
            "negative_prompt": "bad hands",
            "source_file": source,
        },
    ]

    prompt, negative = flatten_preset(
        {"styles": ["Lighting", "Portrait Wrapper"]},
        styles,
        source,
    )

    assert prompt == "portrait of cinematic light"
    assert negative == "flat light, bad hands"


def test_package_rejects_invalid_sender_metadata():
    manifest = {
        "schema": "forgeventory.shared-item",
        "version": 1,
        "kind": "style",
        "item": {
            "name": "Unsafe Metadata",
            "description": "",
            "suggested_category": "Clothing",
            "suggested_tags": "must be a list",
            "variants": [{"format": "tags", "prompt": "coat", "negative_prompt": ""}],
        },
    }

    with pytest.raises(SharePackageError, match="tag suggestions"):
        create_share_package(manifest)
