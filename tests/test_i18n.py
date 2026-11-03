import ast
import json
import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

from parquet_lens.i18n import ENGLISH, language_from_header, translate

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    "header,expected",
    [
        ("", "zh"),
        ("en-US,en;q=0.9", "en"),
        ("zh-CN,zh;q=0.9,en;q=0.8", "zh"),
        ("en;q=0.2,zh;q=0.9", "zh"),
        ("fr-FR,en;q=0.8", "en"),
        ("en;q=0,zh;q=0.5", "zh"),
        ("en;q=bad,zh;q=0.5", "zh"),
        ("en;q=nan", "zh"),
        ("en;q=2", "zh"),
    ],
)
def test_language_negotiation(header, expected):
    assert language_from_header(header) == expected


def test_catalog_covers_ui_and_backend_errors():
    source = (ROOT / "parquet_lens/static/app.js").read_text(encoding="utf-8")
    keys = {
        json.loads('"' + match.group(1) + '"')
        for match in re.finditer(r'\bt\("((?:[^"\\]|\\.)*)"', source)
    }

    class MarkedStrings(HTMLParser):
        def handle_starttag(self, tag, attrs):
            keys.update(value for name, value in attrs if name.startswith("data-i18n"))

    MarkedStrings().feed(
        (ROOT / "parquet_lens/static/index.html").read_text(encoding="utf-8")
    )
    for file in ("engine.py", "server.py"):
        tree = ast.parse((ROOT / "parquet_lens" / file).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "ViewerError"
            ):
                assert isinstance(node.args[0], ast.Constant)
                keys.add(node.args[0].value)
    assert keys - ENGLISH.keys() == set(), (
        "Every marked UI string and application error needs a translation"
    )
    assert all(
        value and not re.search(r"[\u3400-\u9fff]", value) for value in ENGLISH.values()
    )
    assert translate("文件为空。", "en") == "The file is empty."
    assert translate("文件为空。", "zh") == "文件为空。"


def test_api_errors_follow_language_without_changing_data(client, parquet):
    result = client.post("/api/files/local", json={"path": str(parquet)})
    dataset_id = result.json()["id"]
    english = client.post(
        f"/api/files/{dataset_id}/page",
        json={"columns": []},
        headers={"Accept-Language": "en-US"},
    )
    assert english.status_code == 400
    assert english.headers["content-language"] == "en"
    assert english.json()["detail"] == "Select at least one field, without duplicates."
    chinese = client.post(
        f"/api/files/{dataset_id}/page",
        json={"columns": []},
        headers={"Accept-Language": "zh-CN"},
    )
    assert chinese.json()["detail"] == "请至少选择一个字段，且不能重复。"
    for language in ("en", "zh"):
        page = client.post(
            f"/api/files/{dataset_id}/page",
            json={"columns": ["name"], "limit": 1},
            headers={"Accept-Language": language},
        )
        assert page.json()["rows"] == [["客户 0"]]


def test_upload_error_and_translation_assets(client):
    error = client.post(
        "/api/files/upload?name=bad.parquet",
        content=b"not parquet",
        headers={"Accept-Language": "en"},
    )
    assert error.status_code == 400
    assert error.json()["detail"].startswith("Unable to open the file.")
    for path in ("/i18n.js", "/locales/en.json"):
        assert client.get(path).status_code == 200
