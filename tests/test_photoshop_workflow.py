from __future__ import annotations

import io
import json
import threading
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import MethodType

import pytest
from PIL import Image

from backend import app
from backend import photoshop


def png_bytes(mode: str, size: tuple[int, int], pixels: bytes) -> bytes:
    image = Image.frombytes(mode, size, pixels)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def local_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data_root = tmp_path / "data"
    monkeypatch.setattr(app, "DATA_ROOT", data_root)
    monkeypatch.setattr(app, "WORKFLOW_ROOT", data_root / "workflow")
    monkeypatch.setattr(app, "OUTPUT_ROOT", data_root / "outputs")
    monkeypatch.setattr(app, "DB_PATH", data_root / "tasks.sqlite3")
    monkeypatch.setattr(app, "KEYS_PATH", data_root / "keys.json")
    monkeypatch.setattr(app, "ACCOUNTS_PATH", data_root / "accounts.json")
    monkeypatch.setattr(photoshop, "DATA_ROOT", data_root)
    store = app.LocalStore()
    try:
        yield store
    finally:
        store.close()
        store._db.close()


def test_capture_saves_aligned_layer_and_feathered_selection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(photoshop, "DATA_ROOT", tmp_path / "data")
    layer = png_bytes("RGBA", (2, 2), bytes([255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]))
    selection = png_bytes("L", (2, 2), bytes([0, 80, 180, 255]))
    result = photoshop.save_capture({
        "session_id": "session-a",
        "document_id": "71",
        "document_name": "art.psd",
        "document_width": 1200,
        "document_height": 900,
        "placement_input_id": "10:image",
        "selection_rect": {"left": 30, "top": 40, "right": 32, "bottom": 42},
        "selection_png": __import__("base64").b64encode(selection).decode(),
        "inputs": [{
            "input_id": "10:image", "mode": "layer_crop", "layer_id": "9", "layer_name": "Ink",
            "rect": {"left": 30, "top": 40, "right": 32, "bottom": 42},
            "full_bounds": {"left": 28, "top": 38, "right": 34, "bottom": 44},
            "png": __import__("base64").b64encode(layer).decode(),
        }],
    })
    context = result["photoshop_context"]
    assert result["files"]["10:image"] == context["inputs"][0]["snapshot_path"]
    assert context["placement_rect"] == {"left": 30, "top": 40, "right": 32, "bottom": 42}
    with Image.open(context["selection_path"]) as saved:
        assert saved.mode == "L"
        assert list(saved.get_flattened_data()) == [0, 80, 180, 255]
    with Image.open(result["files"]["10:image"]) as saved:
        assert saved.mode == "RGBA"
        assert saved.size == (2, 2)
        assert saved.getpixel((1, 0))[3] == 0


def test_capture_rejects_image_dimensions_that_do_not_match_saved_rect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(photoshop, "DATA_ROOT", tmp_path / "data")
    raw = png_bytes("RGBA", (1, 1), bytes([1, 2, 3, 255]))
    with pytest.raises(ValueError, match="尺寸与坐标矩形不一致"):
        photoshop.save_capture({
            "inputs": [{
                "input_id": "1:image", "mode": "layer_crop",
                "rect": {"left": 0, "top": 0, "right": 2, "bottom": 1},
                "png": __import__("base64").b64encode(raw).decode(),
            }],
        })


def test_preview_snapshots_are_reused_without_copying_images(monkeypatch, tmp_path):
    monkeypatch.setattr(photoshop, "DATA_ROOT", tmp_path / "data")
    rect = {"left": 30, "top": 40, "right": 32, "bottom": 42}
    body = {"document_id": "71", "session_id": "session-a", "source_revision": "history-123",
            "selection_rect": rect, "selection_png": __import__("base64").b64encode(png_bytes("L", (2, 2), bytes([0, 80, 180, 255]))).decode(),
            "inputs": [{"input_id": "1:image", "mode": "selection_image", "rect": rect,
                        "png": __import__("base64").b64encode(png_bytes("RGBA", (2, 2), bytes([40, 160, 140, 128]) * 4)).decode()}]}
    preview = photoshop.save_capture(body)
    source = preview["photoshop_context"]
    reuse = {**body, "selection_png": "", "selection_path": source["selection_path"],
             "inputs": [source["inputs"][0], {"input_id": "543:image", "mode": "selection_mask", "rect": rect,
                                             "snapshot_path": source["selection_path"]}]}
    submitted = photoshop.save_capture(reuse)
    assert submitted["capture_id"] != preview["capture_id"]
    assert submitted["files"]["1:image"] == preview["files"]["1:image"]
    assert submitted["files"]["543:image"] == source["selection_path"]
    assert submitted["photoshop_context"]["placement"]["rect"] == rect
    roots = tmp_path / "data" / "photoshop" / "captures"
    assert len(list(roots.rglob("*.png"))) == 2
    metadata = json.loads((roots / submitted["capture_id"] / "context.json").read_text())
    assert len(metadata["inputs"]) == 2
    assert metadata["selection_path"] == source["selection_path"]
    # Failure must not remove an immutable image referenced by another capture.
    reuse["inputs"].append(reuse["inputs"][0])
    with pytest.raises(ValueError, match="重复"):
        photoshop.save_capture(reuse)
    assert Path(preview["files"]["1:image"]).is_file()
    assert len(list(roots.iterdir())) == 2


@pytest.mark.parametrize("mismatch", ["document_id", "session_id", "source_revision", "outside", "symlink"])
def test_capture_reuse_rejects_foreign_or_stale_snapshots(monkeypatch, tmp_path, mismatch):
    monkeypatch.setattr(photoshop, "DATA_ROOT", tmp_path / "data")
    rect = {"left": 0, "top": 0, "right": 1, "bottom": 1}
    raw = png_bytes("RGBA", (1, 1), bytes([1, 2, 3, 255]))
    body = {"document_id": "71", "session_id": "session-a", "source_revision": "history-123",
            "inputs": [{"input_id": "1:image", "mode": "layer_full", "rect": rect,
                        "png": __import__("base64").b64encode(raw).decode()}]}
    preview = photoshop.save_capture(body)
    reused = {**body, "inputs": preview["photoshop_context"]["inputs"]}
    if mismatch in ("outside", "symlink"):
        outside = tmp_path / "outside.png"
        outside.write_bytes(raw)
        if mismatch == "symlink":
            path = Path(preview["files"]["1:image"])
            path.unlink()
            path.symlink_to(outside)
        else:
            reused["inputs"][0]["snapshot_path"] = str(outside)
    else:
        reused[mismatch] = "different"
    with pytest.raises(ValueError, match="此项目|工程状态"):
        photoshop.save_capture(reused)
    assert len(list((tmp_path / "data" / "photoshop" / "captures").iterdir())) == 1


def test_pixel_preparation_resizes_rgba_and_keeps_native_output(tmp_path: Path):
    source = tmp_path / "native.png"
    source.write_bytes(png_bytes("RGBA", (2, 2), bytes([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 255])))
    original = source.read_bytes()
    rgba, width, height = photoshop.rgba_for_placement(source, 3, 1)
    assert (width, height) == (3, 1)
    assert len(rgba) == 3 * 1 * 4
    assert source.read_bytes() == original
    assert photoshop.image_dimensions(source) == {"width": 2, "height": 2}


def create_minimal_task(store: app.LocalStore, tmp_path: Path, context: dict) -> str:
    output_dir = tmp_path / "task-output"
    task_id = "task_photoshop_roundtrip"
    (output_dir / task_id).mkdir(parents=True, exist_ok=True)
    task = {
        "id": task_id,
        "created_at": 1_800_000_000_000,
        "workflow_path": str(tmp_path / "workflow.json"),
        "workflow_name": "sample.json",
        "remote_workflow_id": "12345",
        "registered_workflow_id": "",
        "local_workflow_id": "",
        "submission_source": "local",
        "files": {"10:image": str(tmp_path / "snapshot.png")},
        "prompts": {},
        "custom_inputs": {},
        "input_config": {"mode": "auto", "items": []},
        "photoshop_context": context,
        "outputs": [{"kind": "file", "name": "result.png", "path": str(output_dir / task_id / "result.png")}],
        "bypassed_nodes": [],
        "random_noise": {},
        "resolution": {},
        "output_dir": str(output_dir),
    }
    Path(task["files"]["10:image"]).write_bytes(png_bytes("RGBA", (1, 1), bytes([1, 2, 3, 255])))
    store.create_task(task)
    store.update_task(task_id, outputs_json=json.dumps(task["outputs"]))
    return task_id


def test_photoshop_context_round_trips_in_sqlite_and_manifest_and_import_is_idempotent(
    local_store: app.LocalStore, tmp_path: Path
):
    context = {"session_id": "s-1", "document_id": "123", "inputs": [], "imports": [], "placement_rect": {"left": 9, "top": 11, "right": 15, "bottom": 18}}
    task_id = create_minimal_task(local_store, tmp_path, context)
    task = local_store.task(task_id)
    assert task["photoshop_context"]["placement_rect"] == context["placement_rect"]
    local_store.save_task_manifest_snapshot(task, {})

    updated = photoshop.update_import_state(local_store, task_id, {
        "output_index": 0, "status": "imported", "layer_id": "456", "document_id": "123", "session_id": "s-1"
    })
    assert updated["photoshop_context"]["imports"][0]["status"] == "imported"
    manifest_path = local_store.task_manifest_path(updated)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["photoshop_context"]["imports"][0]["layer_id"] == "456"

    unchanged = photoshop.update_import_state(local_store, task_id, {"output_index": 0, "status": "failed", "error": "late poll"})
    assert unchanged["photoshop_context"]["imports"][0]["status"] == "imported"
    with pytest.raises(ValueError, match="产物范围"):
        photoshop.update_import_state(local_store, task_id, {"output_index": 10, "status": "importing"})


def test_workflow_photoshop_config_is_saved_as_local_metadata(local_store: app.LocalStore):
    workflow = {"10": {"class_type": "LoadImage", "inputs": {"image": "seed.png"}}}
    workflow_id, _, _ = local_store.save_workflow("layers.json", json.dumps(workflow), remote_workflow_id="77")
    config = photoshop.update_workflow_config(local_store, workflow_id, {
        "inputs": {"10:image": {"mode": "mask_crop"}}, "placement_input_id": "10:image"
    })
    detail = local_store.workflow_detail(workflow_id)
    assert config["placement_input_id"] == "10:image"
    assert detail["workflow"]["__rh_meta__"]["photoshop_config"]["inputs"]["10:image"]["mode"] == "mask_crop"
    assert "__rh_meta__" not in app.workflow_nodes(detail["workflow"])


def test_desktop_import_copies_workflows_keys_and_account_mapping_without_session_state(
    local_store: app.LocalStore, tmp_path: Path
):
    source = tmp_path / "desktop-data"
    workflow_dir = source / "workflow" / "workflow_demo"
    workflow_dir.mkdir(parents=True)
    (source / "accounts.json").write_text(json.dumps({"accounts": [{
        "id": "account_demo", "name": "Demo", "site": "cn", "status": "ready",
        "session_token": "session-secret-that-must-not-copy",
    }]}), encoding="utf-8")
    (source / "keys.json").write_text(json.dumps({
        "keys": [{"id": "key_demo", "name": "Demo key", "site": "cn", "api_key": "test-api-key", "account_id": "account_demo"}],
        "api_key_strategy": "personal_then_shared", "personal_capacity": 2,
    }), encoding="utf-8")
    (source / "workflow-registry.json").write_text(json.dumps({"workflows": [{
        "id": "workflow_demo", "name": "Demo workflow", "remote_workflow_id": "remote-1",
        "account_id": "account_demo", "input_config": {"mode": "manual", "items": []},
    }]}), encoding="utf-8")
    (workflow_dir / "manifest.json").write_text(json.dumps({"name": "Demo workflow", "remote_workflow_id": "remote-1"}), encoding="utf-8")
    (workflow_dir / "workflow_api.json").write_text(json.dumps({"10": {"class_type": "LoadImage", "inputs": {"image": "seed.png"}}}), encoding="utf-8")
    (workflow_dir / "prompt_group.json").write_text(json.dumps({"id": "", "name": "", "items": []}), encoding="utf-8")

    imported = photoshop.import_desktop_data(local_store, str(source))

    assert imported == {"accounts": 1, "keys": 1, "workflows": 1}
    account = local_store.accounts()[0]
    assert account["status"] == "login_required"
    assert "session_token" not in account
    key = local_store.keys()[0]
    assert key["api_key"] == "test-api-key"
    assert key["account_id"] == "account_demo"
    assert local_store.api_key_strategy() == "personal_then_shared"
    workflow = local_store.workflow_detail(local_store.workflows()[0]["id"])
    assert workflow["record"]["remote_workflow_id"] == "remote-1"
    assert workflow["record"]["input_config"]["mode"] == "manual"
    assert (source / "keys.json").is_file()


@contextmanager
def fake_runninghub():
    seen: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def _json(self, status: int, value: object):
            payload = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode())
            seen.append(body)
            self._json(200, {"taskId": "fake-rh-task-001"})

        def do_GET(self):
            self._json(200, [{"fileName": "generated.png", "fileType": "png", "fileUrl": "http://fake.invalid/generated.png"}])

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = "http://127.0.0.1:%s" % server.server_port
    try:
        yield base, seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_task_queue_uses_fake_runninghub_and_keeps_photoshop_data_local(
    local_store: app.LocalStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    with fake_runninghub() as (base, seen):
        monkeypatch.setattr(app, "_site_urls", lambda _site: (base + "/upload", base + "/submit", base + "/poll"))
        monkeypatch.setattr(app, "_site_cancel_url", lambda _site: base + "/cancel")

        class FakeClient:
            def __init__(self, *_args, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        monkeypatch.setattr(app, "RhHttpClient", FakeClient)

        def upload(_client, workflow, _args, _url):
            workflow["10"]["inputs"]["image"] = "fake-upload.png"
            return ["10:image uploaded"]

        def submit(_client, _key, workflow_id, workflow_json, **kwargs):
            request = urllib.request.Request(
                kwargs["create_url"],
                data=json.dumps({"workflow_id": workflow_id, "prompt": json.loads(workflow_json)}).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                return json.loads(response.read().decode())["taskId"]

        def poll(_client, _key, task_id, **kwargs):
            with urllib.request.urlopen(kwargs["outputs_url"] + "/" + task_id, timeout=3) as response:
                return json.loads(response.read().decode())

        monkeypatch.setattr(app, "_apply_file_args", upload)
        monkeypatch.setattr(app, "_submit", submit)
        monkeypatch.setattr(app, "_poll_outputs", poll)

        manager = app.TaskManager.__new__(app.TaskManager)
        manager.store = local_store
        manager._lock = threading.RLock()
        manager._claimed = set()
        manager._active_by_key = {}
        manager._cancel_events = {}
        manager._wake = threading.Event()
        manager._queue_telegram_delivery = lambda *_args: None
        manager._queue_telegram_task_failure = lambda *_args: None

        def download(_self, _client, _outputs, folder, _prefix=None):
            folder.mkdir(parents=True, exist_ok=True)
            output = folder / "generated.png"
            output.write_bytes(png_bytes("RGBA", (2, 1), bytes([255, 0, 0, 255, 0, 255, 0, 80])))
            return [{"kind": "file", "name": output.name, "path": str(output), "mime": "image/png", "file_type": "png"}]

        manager._download_outputs = MethodType(download, manager)
        manager._log_stage = MethodType(lambda self, task_id, stage, message, **kwargs: self.store.append_stage_log(task_id, stage, message, **kwargs), manager)

        input_path = tmp_path / "input.png"
        input_path.write_bytes(png_bytes("RGBA", (1, 1), bytes([9, 8, 7, 255])))
        workflow = {
            "10": {"class_type": "LoadImage", "inputs": {"image": "input.png"}},
            "__rh_meta__": {"photoshop_config": {"inputs": {"10:image": {"mode": "layer_crop"}}}},
        }
        task = manager.submit_task(
            "wf_local_ps",
            {"10:image": str(input_path)},
            {},
            None,
            str(tmp_path / "outputs"),
            remote_workflow_id="9988",
            workflow_data=workflow,
            workflow_name="Photoshop sample.json",
            photoshop_context={"session_id": "s-test", "document_id": "91", "placement_rect": {"left": 24, "top": 35, "right": 44, "bottom": 55}},
        )
        manager._run_task(task["id"], {"id": "key-test", "name": "fake", "api_key": "local-test", "site": "ai", "capacity": 1}, threading.Event())

        finished = local_store.task(task["id"])
        assert finished["status"] == "completed"
        assert finished["photoshop_context"]["placement_rect"] == {"left": 24, "top": 35, "right": 44, "bottom": 55}
        assert len(finished["outputs"]) == 1
        assert seen and seen[0]["workflow_id"] == "9988"
        assert "__rh_meta__" not in seen[0]["prompt"]
        assert "photoshop_context" not in seen[0]


def selected_capture(monkeypatch, tmp_path, inputs=None):
    import base64
    monkeypatch.setattr(photoshop, "DATA_ROOT", tmp_path / "data")
    return photoshop.save_capture({
        "document_name": "A.psd", "document_id": "71", "session_id": "s1", "active_layer_id": "9",
        "document_width": 300, "document_height": 200,
        "selection_rect": {"left": 30, "top": 40, "right": 32, "bottom": 42},
        "selection_png": base64.b64encode(png_bytes("L", (2, 2), bytes([0, 80, 180, 255]))).decode(),
        "inputs": inputs or [],
    })


def test_zero_image_inputs_still_freeze_selection(monkeypatch, tmp_path):
    captured = selected_capture(monkeypatch, tmp_path)
    context = captured["photoshop_context"]
    assert captured["files"] == {}
    assert context["version"] == 2
    assert context["placement"]["mode"] == "selection"
    assert context["placement"]["rect"] == context["selection_rect"]
    assert context["selection"]["present"] and context["auto_import"]
    assert (Path(context["selection_path"]).parent / "context.json").is_file()


def test_layer_anchor_is_independent_of_output_size(monkeypatch, tmp_path):
    import base64
    context = photoshop.save_capture({
        "inputs": [{"input_id": "1:image", "mode": "layer_full", "rect": {"left": -13, "top": 17, "right": -11, "bottom": 19}, "png": base64.b64encode(png_bytes("RGBA", (2, 2), bytes([0, 0, 0, 255] * 4))).decode()}],
        "placement_input_id": "1:image",
    })["photoshop_context"]
    assert context["placement"]["mode"] == "layer_anchor"
    assert context["placement"]["left"] == -13
    assert context["placement"]["size_policy"] == "native"


def test_artifact_mask_outlives_capture_and_follows_rename_and_project(local_store, monkeypatch, tmp_path):
    from backend.photoshop_assets import import_info
    context = selected_capture(monkeypatch, tmp_path)["photoshop_context"]
    task_id = create_minimal_task(local_store, tmp_path, context)
    task = local_store.task(task_id)
    result = Path(task["outputs"][0]["path"])
    result.write_bytes(png_bytes("RGBA", (6, 3), bytes([10, 20, 30, 255] * 18)))
    original = result.read_bytes()
    local_store.update_task(task_id, status="completed", outputs_json=json.dumps(task["outputs"]))
    task = local_store.task(task_id)
    output_id = task["outputs"][0]["output_id"]
    __import__("shutil").rmtree(Path(context["selection_path"]).parent)
    info = import_info(task, 0, output_id)
    assert (info["width"], info["height"], info["original_width"], info["original_height"]) == (2, 2, 6, 3)
    assert list(Image.open(info["mask_path"]).get_flattened_data()) == [0, 80, 180, 255]
    assert result.read_bytes() == original
    local_store.rename_output_file(task_id, 0, "renamed-result")
    project = local_store.create_project_folder("另一项目")
    local_store.set_task_project(task_id, {"id": project["id"]})
    after = import_info(local_store.task(task_id), 0, output_id)
    assert after["mask_path"] == info["mask_path"] and after["placement"] == info["placement"]
    assert Path(after["image_path"]).stem == "renamed-result"
    Path(info["mask_path"]).unlink()
    with pytest.raises(FileNotFoundError):
        import_info(local_store.task(task_id), 0, output_id)


def test_missing_capture_mask_keeps_generated_image_but_blocks_import(local_store, monkeypatch, tmp_path):
    from backend.photoshop_assets import import_info
    context = selected_capture(monkeypatch, tmp_path)["photoshop_context"]
    Path(context["selection_path"]).unlink()
    task_id = create_minimal_task(local_store, tmp_path, context)
    task = local_store.task(task_id)
    Path(task["outputs"][0]["path"]).write_bytes(png_bytes("RGBA", (2, 2), bytes([40, 160, 140, 255] * 4)))
    local_store.update_task(task_id, status="completed", outputs_json=json.dumps(task["outputs"]))
    task = local_store.task(task_id)
    output = task["outputs"][0]
    assert Path(output["path"]).is_file()
    metadata = json.loads(Path(output["photoshop"]["metadata_path"]).read_text())
    assert metadata["selection_mask"]["path"] == "selection-mask.png"
    assert metadata["attachment_error"] == "原选区蒙版缺失"
    with pytest.raises(FileNotFoundError):
        import_info(task, 0, output["output_id"])


@pytest.mark.parametrize("channel", ["red", "green", "blue", "alpha"])
def test_load_image_mask_channels_have_selection_polarity(tmp_path, channel):
    from backend.photoshop_assets import freeze_inputs
    mask_path = tmp_path / "mask.png"
    mask_path.write_bytes(png_bytes("L", (2, 2), bytes([0, 80, 180, 255])))
    workflow = {"543": {"class_type": "LoadImageMask", "inputs": {"image": "undefined", "channel": channel}}}
    context = {"active_layer_id": "9", "selection": {"present": True}, "inputs": [{"input_id": "543:image", "mode": "selection_mask"}]}
    frozen = freeze_inputs({"543:image": str(mask_path)}, workflow, context, tmp_path / "snapshots")
    image = Image.open(frozen["543:image"])
    if channel == "alpha":
        observed = [255 - value for value in image.getchannel("A").get_flattened_data()]
    else:
        observed = list(image.getchannel(channel[0].upper()).get_flattened_data())
    assert observed == [0, 80, 180, 255]
    assert Image.open(mask_path).mode == "L"
    with pytest.raises(app.RhCliError, match="活动图层"):
        freeze_inputs({"543:image": str(mask_path)}, workflow, {}, tmp_path / "bad")


def test_local_reference_is_frozen_without_changing_original(tmp_path):
    from backend.photoshop_assets import freeze_inputs
    path = tmp_path / "reference.png"
    path.write_bytes(png_bytes("RGB", (1, 1), bytes([1, 2, 3])))
    frozen = freeze_inputs({"1:image": str(path)}, {"1": {"class_type": "LoadImage"}}, {}, tmp_path / "snapshot")
    path.write_bytes(png_bytes("RGB", (1, 1), bytes([4, 5, 6])))
    assert Image.open(frozen["1:image"]).getpixel((0, 0)) == (1, 2, 3)
    assert Image.open(path).getpixel((0, 0)) == (4, 5, 6)


def test_concurrent_claims_and_manual_requests_are_independent(local_store, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    task_id = create_minimal_task(local_store, tmp_path, {"session_id": "original-session", "document_id": "71"})
    def claim(request_id):
        return photoshop.update_import_state(local_store, task_id, {"status": "importing", "output_index": 0, "request_id": request_id})["import_claimed"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(claim, ["owner-a", "owner-b"]))
    assert sum(results) == 1
    owner = local_store.task(task_id)["photoshop_context"]["imports"][0]["request_id"]
    for status in ("pending", "failed", "needs_review"):
        rejected = photoshop.update_import_state(local_store, task_id, {"status": status, "output_index": 0, "request_id": "not-the-owner"})
        assert not rejected["import_claimed"]
        assert rejected["photoshop_context"]["imports"][0]["status"] == "importing"
    assert not claim(owner)
    for request_id in ("not-the-owner", owner):
        journal = photoshop.update_import_state(local_store, task_id, {"status": "importing", "output_index": 0,
            "request_id": request_id, "write_complete": True, "layer_id": "45", "document_id": "71"})
        assert journal["import_claimed"] == (request_id == owner)
    assert local_store.task(task_id)["photoshop_context"]["imports"][0]["write_complete"]
    photoshop.update_import_state(local_store, task_id, {"status": "imported", "output_index": 0, "request_id": owner, "layer_id": "45"})
    for request_id in ("manual-a", "manual-b"):
        claimed = photoshop.update_import_state(local_store, task_id, {"status": "importing", "output_index": 0, "request_id": request_id, "manual": True})
        assert claimed["import_claimed"]
        photoshop.update_import_state(local_store, task_id, {"status": "imported", "output_index": 0, "request_id": request_id, "manual": True, "layer_id": request_id, "session_id": "another-session"})
    repeat = photoshop.update_import_state(local_store, task_id, {"status": "importing", "output_index": 0, "request_id": "manual-a", "manual": True})
    assert not repeat["import_claimed"]
    context = local_store.task(task_id)["photoshop_context"]
    assert context["session_id"] == "original-session"
    assert context["imports"][0]["layer_id"] == "45"
    assert len(context["manual_imports"]) == 2


def test_stable_output_id_survives_filtered_files_and_deleting_an_earlier_output(local_store, tmp_path):
    from backend.photoshop_assets import resolve_output
    task_id = create_minimal_task(local_store, tmp_path, {})
    task = local_store.task(task_id)
    path = Path(task["outputs"][0]["path"])
    path.write_bytes(png_bytes("RGBA", (1, 1), bytes([1, 2, 3, 255])))
    second = path.with_name("second.png")
    second.write_bytes(path.read_bytes())
    outputs = [{"kind": "text", "text": "description"}, task["outputs"][0], {"kind": "file", "name": second.name, "path": str(second)}]
    local_store.update_task(task_id, outputs_json=json.dumps(outputs))
    task = local_store.task(task_id)
    output_id = task["outputs"][2]["output_id"]
    assert resolve_output(task, 2, output_id)[1] == second
    local_store.delete_outputs_by_keys({(task_id, 1)})
    task = local_store.task(task_id)
    assert resolve_output(task, 2, output_id)[1] == second
    assert len(list((second.parent / ".photoshop").glob("*/photoshop.json"))) == 1


@pytest.mark.parametrize("workflow", [
    {"1": {"class_type": "LoadImage", "inputs": {"image": "undefined"}}},
    {"1": {"class_type": "SaveImage", "inputs": {"images": ["99", 0]}}},
    {"1": {"class_type": "LoadImageMask", "inputs": {"image": "undefined"}}, "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}}},
    {"2": {"class_type": "VAEEncode", "inputs": {}}, "__rh_meta__": {"photoshop_disconnected_inputs": [{"node_id": "2", "field": "pixels"}]}},
])
def test_invalid_image_graphs_block_submission(workflow):
    from backend.photoshop_assets import validate_graph
    with pytest.raises(app.RhCliError):
        validate_graph(workflow)


def test_psd_auto_classification_and_explicit_project_precedence(local_store, tmp_path):
    manager = app.TaskManager.__new__(app.TaskManager)
    manager.store = local_store
    manager._wake = threading.Event()
    context = {"version": 2, "document_name": "A.psd", "document_id": "71", "session_id": "s1", "inputs": [], "selection": {"present": False}, "placement": {"mode": "canvas_center"}}
    workflow = {"1": {"class_type": "EmptyImage", "inputs": {}}}
    first = manager.submit_task("wf_ps", {}, {}, None, str(tmp_path / "outputs"), remote_workflow_id="77", workflow_data=workflow, photoshop_context=context)
    again = manager.submit_task("wf_ps", {}, {}, None, str(tmp_path / "outputs"), remote_workflow_id="77", workflow_data=workflow, photoshop_context={**context, "document_id": "999"})
    assert first["project_name"] == "A" and first["project_id"] == again["project_id"]
    chosen = local_store.create_project_folder("自选项目")
    explicit = manager.submit_task("wf_ps", {}, {}, None, str(tmp_path / "outputs"), remote_workflow_id="77", workflow_data=workflow, photoshop_context=context, project={"id": chosen["id"]})
    assert explicit["project_id"] == chosen["id"]
