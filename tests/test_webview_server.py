"""Exercise the real isolated HTTP server without cloud jobs or user credentials."""
from __future__ import annotations

import base64
import io
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def webview_server(tmp_path_factory):
    data = tmp_path_factory.mktemp("webview") / "data"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, RH_WORKFLOW_WEBVIEW_DATA_ROOT=str(data))
    process = subprocess.Popen(
        [sys.executable, "-m", "backend.webview_server", "--port", str(port), "--no-browser"],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                pytest.fail("Isolated WebView server exited before becoming ready")
            try:
                with urllib.request.urlopen(url + "/api/webview/health", timeout=1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            pytest.fail("Isolated WebView server did not start")
        yield url, data
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def request(server, path, body=None, origin=None, method=None):
    headers = {"Content-Type": "application/json"}
    if origin:
        headers["Origin"] = origin
    req = urllib.request.Request(server + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as response:
        return response.code, response.read(), response.headers


def test_isolated_data_and_excluded_pages(webview_server):
    server, data = webview_server
    status, raw, _ = request(server, "/api/webview/health")
    assert status == 200
    info = json.loads(raw)
    assert info["data_directory"] == str(data)
    assert info["features"] == {"photoshop": True, "prompt_workshop": False, "focus_mode": False, "telegram_inbound": False}
    for path in ("/prompt", "/focus", "/uxp-preview"):
        assert request(server, path)[0] == 404
    for path in ("/", "/workflows", "/outputs", "/dashboard", "/settings"):
        status, markup, _ = request(server, path)
        assert status == 200
        assert b'/static/ps-webview.js' in markup
        assert b'href="/prompt"' not in markup
        assert b'href="/focus"' not in markup
        if path == "/settings":
            assert b'telegram-inbound-block" hidden data-disabled-feature="telegram-inbound"' in markup


def test_browser_origin_and_disabled_inbound(webview_server):
    server, _ = webview_server
    assert request(server, "/api/webview/diagnostics", {"status": "forged"}, "https://foreign.example")[0] == 403
    status, _, headers = request(server, "/api/webview/diagnostics", {"status": "test"}, server)
    assert status == 200
    assert headers["Access-Control-Allow-Origin"] == server
    assert request(server, "/api/settings", {"telegram_inbound_enabled": True}, method="PATCH")[0] == 400
    assert request(server, "/api/settings", {"telegram_video_inbound_enabled": True}, method="PATCH")[0] == 400
    # Desk still submits inactive hidden inbound controls when saving push settings.
    assert request(server, "/api/settings", {"telegram_inbound_enabled": False, "telegram_inbound_mode": "fixed", "telegram_video_inbound_enabled": False}, method="PATCH")[0] == 200


def test_diagnostics_are_saved_and_bounded(webview_server):
    server, data = webview_server
    report = {"native": True, "status": "fixture", "viewport": {"width": 460, "height": 860}}
    assert request(server, "/api/webview/diagnostics", report)[0] == 200
    assert json.loads(request(server, "/api/webview/diagnostics")[1]) == report
    assert json.loads((data / "webview-diagnostics.json").read_text()) == report
    assert request(server, "/api/webview/diagnostics", {"data": "x" * (65 * 1024)})[0] == 413
    assert json.loads(request(server, "/api/webview/diagnostics")[1]) == report


def test_capture_http_roundtrip_and_path_boundary(webview_server):
    server, data = webview_server
    pixels = bytes([40, 160, 140, 255, 100, 80, 60, 128])
    image = Image.frombytes("RGBA", (2, 1), pixels)
    png = io.BytesIO()
    image.save(png, format="PNG")
    status, raw, _ = request(server, "/api/photoshop/captures", {
        "session_id": "webview-test", "document_id": "synthetic",
        "document_width": 2, "document_height": 1,
        "inputs": [{"input_id": "1:image", "mode": "layer_full", "rect": {"left": 0, "top": 0, "right": 2, "bottom": 1}, "png": base64.b64encode(png.getvalue()).decode()}],
    })
    assert status == 201
    saved = json.loads(raw)
    path = saved["files"]["1:image"]
    assert Path(path).is_relative_to(data / "photoshop" / "captures")
    status, rgba, _ = request(server, "/api/webview/capture-pixels?path=" + urllib.parse.quote(path))
    assert status == 200
    assert rgba == pixels
    outside = data.parent / "outside.png"
    outside.write_bytes(png.getvalue())
    assert request(server, "/api/webview/capture-pixels?path=" + urllib.parse.quote(str(outside)))[0] == 400
    status, raw, _ = request(server, "/api/webview/file-info", {"path": path})
    assert status == 200
    assert json.loads(raw)["preview_kind"] == "image"


def test_canonical_desk_css_is_unmodified():
    recorded = json.loads((ROOT / "docs" / "source-ui.json").read_text())
    import hashlib
    assert hashlib.sha256((ROOT / "static" / "app.css").read_bytes()).hexdigest() == recorded["files"]["app.css"]


def test_synthetic_workflow_http_import_info_mask_and_claims(webview_server):
    server, data = webview_server
    encoded = io.BytesIO()
    Image.frombytes("L", (2, 2), bytes([0, 80, 180, 255])).save(encoded, format="PNG")
    body = {"document_name": "RH WebView · HTTP 自检", "document_id": "71", "session_id": "s1", "active_layer_id": "9", "document_width": 300, "document_height": 200,
            "selection_rect": {"left": 30, "top": 40, "right": 32, "bottom": 42}, "selection_png": base64.b64encode(encoded.getvalue()).decode(), "inputs": []}
    status, raw, _ = request(server, "/api/photoshop/captures", body)
    assert status == 201
    capture = json.loads(raw)
    status, raw, _ = request(server, "/api/webview/self-test-task", {"capture_id": capture["capture_id"], "width": 6, "height": 3})
    assert status == 200, raw
    task = json.loads(raw)["task"]
    assert task["status"] == "completed" and task["photoshop_context"]["auto_import"] is False
    output_id = task["outputs"][0]["output_id"]
    prefix = "/api/photoshop/tasks/" + task["id"] + "/outputs/0/"
    query = "?output_id=" + output_id
    __import__("shutil").rmtree(Path(capture["photoshop_context"]["selection_path"]).parent)
    status, raw, _ = request(server, prefix + "import-info" + query)
    assert status == 200, raw
    info = json.loads(raw)
    assert info["has_mask"] and (info["width"], info["height"]) == (2, 2)
    assert (info["original_width"], info["original_height"]) == (6, 3)
    assert "image_path" not in info and "mask_path" not in info
    status, raw, headers = request(server, prefix + "pixels" + query)
    assert status == 200 and len(raw) == 16 and headers["X-Image-Width"] == "2"
    assert request(server, prefix + "selection-mask" + query)[1] == bytes([0, 80, 180, 255])
    claim = {"output_id": output_id, "output_index": 0, "status": "importing", "request_id": "manual-a", "manual": True}
    status, raw, _ = request(server, "/api/photoshop/tasks/" + task["id"] + "/imports", claim, method="PATCH")
    assert status == 200 and json.loads(raw)["task"]["import_claimed"]
    assert not json.loads(request(server, "/api/photoshop/tasks/" + task["id"] + "/imports", claim, method="PATCH")[1])["task"]["import_claimed"]
    assert request(server, "/api/webview/self-test-task/" + task["id"], method="DELETE")[0] == 200


def test_image_graph_validation_http(webview_server):
    server, _ = webview_server
    graph = {"1": {"class_type": "LoadImageMask", "inputs": {"image": "undefined", "channel": "red"}}, "2": {"class_type": "SetLatentNoiseMask", "inputs": {"mask": ["1", 0]}}}
    assert request(server, "/api/photoshop/validate", {"workflow": graph})[0] == 200
    graph["2"]["inputs"] = {"images": ["1", 0]}
    assert request(server, "/api/photoshop/validate", {"workflow": graph})[0] == 400
