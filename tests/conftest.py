# pip install pytest
import os
import sys
from unittest.mock import MagicMock

# Stub Forge `modules.shared` before stylegrid.config (and thus csv_io) loads.
_mock_shared = MagicMock()
_mock_shared.cmd_opts = MagicMock()
_mock_shared.cmd_opts.data_path = None
_mod = MagicMock()
_mod.shared = _mock_shared
sys.modules.setdefault("modules", _mod)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import pytest


@pytest.fixture
def tmp_csv(tmp_path):
    """Minimal valid legacy 5-column CSV; missing organizer tags remain compatible."""
    content = (
        "name,prompt,negative_prompt,description,category\n"
        "Test Style A,(tag_a:1.2),bad_tag_a,Desc A,BASE\n"
        "Test Style B,tag_b,,Desc B,BODY\n"
        "Style With Spaces,tag_c,bad_c,,\n"
    )
    path = tmp_path / "styles.csv"
    path.write_text(content, encoding="utf-8")
    return path


@pytest.fixture
def patch_styles_dirs(monkeypatch, tmp_path):
    """Make CSV discovery return only the test CSV for save/delete operations."""
    from stylegrid import csv_io as sg_csv_io

    monkeypatch.setattr(
        sg_csv_io,
        "get_all_styles_file_paths",
        lambda: [str(tmp_path / "styles.csv")],
    )
