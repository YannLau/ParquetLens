from fastapi.testclient import TestClient

from parquet_lens.server import create_app


def test_access_control(tmp_path):
    app = create_app("secret", tmp_path)
    with TestClient(app) as client:
        assert client.get("/api/files").status_code == 401
        assert client.get("/?token=wrong").status_code == 401
        launch = client.get("/?token=secret")
        assert launch.status_code == 200
        assert str(launch.url).endswith("/")
        assert "HttpOnly" in launch.history[0].headers["set-cookie"]
        assert (
            client.post(
                "/api/demo", headers={"origin": "https://evil.example"}
            ).status_code
            == 403
        )
        assert "frame-ancestors 'none'" in launch.headers["content-security-policy"]


def test_local_open_schema_page_and_stats(client, parquet):
    opened = client.post("/api/files/local", json={"path": str(parquet)})
    assert opened.status_code == 200
    file = opened.json()
    assert client.get("/api/files").json()[0]["id"] == file["id"]
    detail = client.get(f"/api/files/{file['id']}").json()
    assert {field["name"] for field in detail["schema"][3]["children"]} == {
        "tags",
        "count",
    }
    result = client.post(
        f"/api/files/{file['id']}/page", json={"columns": ["id"], "offset": 70}
    )
    assert result.status_code == 200
    assert result.json()["rows"] == [[70], [71], [72]]
    assert client.get(f"/api/files/{file['id']}/groups").json()["total"] == 6
    assert client.get(f"/api/files/{file['id']}/stats?column=value").status_code == 200
    assert client.delete(f"/api/files/{file['id']}").status_code == 200
    assert parquet.exists()
    assert client.get(f"/api/files/{file['id']}").status_code == 404


def test_stream_upload_cleanup_and_invalid_files(client, parquet):
    response = client.post(
        "/api/files/upload?name=sample.parquet", content=parquet.read_bytes()
    )
    assert response.status_code == 200
    dataset = client.app.state.engine.get(response.json()["id"])
    assert dataset.owned and dataset.path.exists()
    assert client.delete(f"/api/files/{dataset.id}").status_code == 200
    assert not dataset.path.exists()
    before = set(client.app.state.storage.iterdir())
    assert (
        client.post("/api/files/upload?name=broken.parquet", content=b"bad").status_code
        == 400
    )
    assert set(client.app.state.storage.iterdir()) == before
    assert client.post("/api/files/upload?name=x.csv", content=b"a").status_code == 400
    assert (
        client.post("/api/files/upload?name=x.parquet", content=b"").status_code == 400
    )


def test_remote_device_cannot_open_local_path(tmp_path, parquet):
    app = create_app("secret", tmp_path)
    with TestClient(app, client=("192.168.1.9", 5000)) as client:
        client.get("/?token=secret")
        assert client.get("/api/config").json()["local_path"] is False
        assert (
            client.post("/api/files/local", json={"path": str(parquet)}).status_code
            == 403
        )
        assert (
            client.post(
                "/api/files/upload?name=remote.parquet", content=parquet.read_bytes()
            ).status_code
            == 200
        )


def test_upload_limit_and_parameter_validation(tmp_path, parquet):
    app = create_app("secret", tmp_path, max_upload=16)
    with TestClient(app, client=("127.0.0.1", 1)) as client:
        client.get("/?token=secret")
        assert (
            client.post(
                "/api/files/upload?name=x.parquet", content=b"x" * 17
            ).status_code
            == 413
        )
        dataset = app.state.engine.register(parquet)
        url = f"/api/files/{dataset.id}/page"
        assert client.post(url, json={"limit": 10000}).status_code == 422
        assert client.post(url, json={"offset": -1}).status_code == 422
        assert client.post(url, json={"columns": []}).status_code == 400
        assert (
            client.post(
                url, json={"filters": [{"column": "id", "op": "sql"}]}
            ).status_code
            == 422
        )


def test_demo_idempotent_and_assets(client):
    first = client.post("/api/demo").json()
    second = client.post("/api/demo").json()
    assert first["id"] == second["id"]
    assert first["rows"] == 240000
    for path in ("/", "/app.js", "/style.css", "/favicon.svg"):
        assert client.get(path).status_code == 200
