"""Tests for stylegrid.wildcards.resolve_sg_wildcards (generation-time {sg:...} tokens)."""
from unittest.mock import patch

from stylegrid.wildcards import resolve_sg_wildcards, resolve_sg_wildcards_with_styles


def test_replaces_with_random_style_prompt():
    styles_by = {
        "accessory": [
            {"prompt": "picked_prompt"},
            {"prompt": "other"},
        ]
    }
    with patch("stylegrid.wildcards.random.choice", lambda seq: seq[0]):
        assert resolve_sg_wildcards("prefix {sg:accessory} suffix", styles_by) == (
            "prefix picked_prompt suffix"
        )


def test_category_wildcard_does_not_report_an_exact_style():
    styles_by = {"accessory": [{"prompt": "picked_prompt"}]}
    with patch("stylegrid.wildcards.random.choice", lambda seq: seq[0]):
        resolved, exact_styles = resolve_sg_wildcards_with_styles(
            "{sg:accessory}", styles_by
        )
    assert resolved == "picked_prompt"
    assert exact_styles == []


def test_unknown_category_leaves_token():
    styles_by = {"animal": [{"prompt": "x"}]}
    assert resolve_sg_wildcards("{sg:missing}", styles_by) == "{sg:missing}"


def test_category_match_is_case_insensitive():
    styles_by = {"accessory": [{"prompt": "low"}]}
    with patch("stylegrid.wildcards.random.choice", lambda seq: seq[0]):
        assert resolve_sg_wildcards("{sg:ACCESSORY}", styles_by) == "low"


def test_top_level_family_wildcard_chooses_from_child_categories():
    styles_by = {
        "clothing - dresses": [{"prompt": "dress"}],
        "clothing - shoes": [{"prompt": "shoes"}],
        "hair - colors": [{"prompt": "red hair"}],
    }
    with patch("stylegrid.wildcards.random.choice", lambda seq: seq[0]):
        assert resolve_sg_wildcards("{sg:Clothing}", styles_by) == "dress"


def test_temporary_pool_chooses_only_from_selected_style_names():
    first = {"name": "First", "prompt": "first prompt", "negative_prompt": "first negative"}
    second = {"name": "Second", "prompt": "second prompt", "negative_prompt": "second negative"}
    unselected = {"name": "Other", "prompt": "other prompt", "negative_prompt": "other negative"}
    styles_by_name = {style["name"].lower(): style for style in (first, second, unselected)}

    with patch("stylegrid.wildcards.random.choice", lambda seq: seq[-1]):
        resolved, chosen = resolve_sg_wildcards_with_styles(
            "prefix {sg:temp-1} suffix",
            {},
            styles_by_name,
            temporary_pools={"temp-1": ["First", "Second"]},
        )

    assert resolved == "prefix second prompt suffix"
    assert chosen == [second]


def test_temporary_pool_ignores_names_missing_from_active_source():
    available = {"name": "Available", "prompt": "active prompt", "negative_prompt": ""}

    with patch("stylegrid.wildcards.random.choice", lambda seq: seq[0]):
        assert resolve_sg_wildcards(
            "{sg:temp-2}",
            {},
            {"available": available},
            temporary_pools={"temp-2": ["Missing", "Available"]},
        ) == "active prompt"


def test_empty_temporary_pool_does_not_fall_through_to_category():
    category_style = {"name": "Collision", "prompt": "wrong category", "negative_prompt": ""}
    assert resolve_sg_wildcards(
        "{sg:temp-3}",
        {"temp-3": [category_style]},
        {},
        temporary_pools={"temp-3": ["Unavailable"]},
    ) == "{sg:temp-3}"


def test_empty_prompt_falls_back_to_original_token():
    styles_by = {"x": [{"prompt": ""}]}
    with patch("stylegrid.wildcards.random.choice", lambda seq: seq[0]):
        assert resolve_sg_wildcards("{sg:x}", styles_by) == "{sg:x}"


def test_exact_style_name_takes_priority_over_category():
    exact = {"name": "Boots", "prompt": "exact boots"}
    styles_by = {"boots": [{"prompt": "random boots"}]}
    styles_by_name = {"boots": exact}
    resolved, chosen = resolve_sg_wildcards_with_styles(
        "wearing {sg:Boots}", styles_by, styles_by_name
    )
    assert resolved == "wearing exact boots"
    assert chosen == [exact]


def test_exact_style_name_match_is_case_insensitive():
    style = {"name": "High-Shine Tights", "prompt": "shiny tights"}
    assert resolve_sg_wildcards(
        "{sg:HIGH-SHINE TIGHTS}", {}, {"high-shine tights": style}
    ) == "shiny tights"


def test_negative_field_uses_style_negative_prompt():
    style = {
        "name": "Example",
        "prompt": "positive descriptor",
        "negative_prompt": "negative descriptor",
    }
    resolved, chosen = resolve_sg_wildcards_with_styles(
        "{sg:Example}", {}, {"example": style}, field="negative_prompt"
    )
    assert resolved == "negative descriptor"
    assert chosen == [style]


def test_exact_negative_only_style_removes_token_and_is_reported():
    style = {"name": "Negative Only", "prompt": "", "negative_prompt": "artifact"}
    resolved, chosen = resolve_sg_wildcards_with_styles(
        "subject, {sg:Negative Only}", {}, {"Negative Only": style}
    )
    assert resolved == "subject, "
    assert chosen == [style]


def test_prompt_placeholder_does_not_survive_expansion():
    style = {"name": "Wrapped", "prompt": "cinematic, {prompt}"}
    assert resolve_sg_wildcards(
        "subject, {sg:Wrapped}", {}, {"wrapped": style}
    ) == "cinematic, subject, "
