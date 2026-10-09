"""Independent Desk UI server for the Photoshop WebView experiment."""
from __future__ import annotations

import argparse
import json
import threading
import webbrowser
import uuid
import time
import shutil
from pathlib import Path
from urllib.parse import urlparse
from urllib.parse import parse_qs
from PIL import Image

from . import server as base
from .app import DATA_ROOT, TaskManager, public_outputs
from .photoshop_assets import import_info, persist_outputs, resolve_output, validate_graph
from .photoshop import grayscale_mask, rgba_for_placement

FEATURES = {"prompt_workshop": False, "focus_mode": False, "telegram_inbound": False, "photoshop": True}
PLUGIN_ID = "com.llsetnow.rhworkflowpswebview"


class WebviewHandler(base.LocalHandler):
    def _headers(self, content_type="application/json; charset=utf-8", length=None):
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if length is not None:
            self.send_header("Content-Length", str(length))

    def _allowed_request(self):
        origin = self.headers.get("Origin", "")
        if origin and origin not in self.server.allowed_origins:
            self._json(403, {"message": "请求来源未获允许"})
            return False
        return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/favicon.ico":
            self._serve_static("/static/assets/rh-workflow-desk-icon.png")
            return
        if path in {"/prompt", "/prompt/", "/focus", "/focus/"} or path.startswith("/uxp-preview"):
            self._json(404, {"message": "此实验版未启用该页面"})
            return
        if path == "/lab":
            self._serve_static("/static/lab.html")
            return
        if path == "/api/webview/health":
            self._json(200, {"app": "rh-workflow-ps", "data_directory": str(DATA_ROOT), "features": FEATURES})
            return
        if path == "/api/outputs":
            store, manager = self.state
            tasks = manager.public_tasks()
            for index, task in enumerate(tasks):
                images = [
                    item for item in task.get("outputs") or []
                    if isinstance(item, dict) and item.get("kind") == "file"
                    and (str(item.get("mime") or "").startswith("image/")
                         or Path(str(item.get("path") or "")).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif"})
                ]
                if not any(not item.get("output_id") for item in images):
                    continue
                # Assign old cards their stable identity before drag/context
                # actions. Hold the lock so simultaneous pages cannot race.
                with store._lock:
                    current = store.task(task["id"])
                    if current:
                        outputs = persist_outputs(current, current.get("outputs") or [])
                        store.update_task(task["id"], outputs_json=json.dumps(outputs, ensure_ascii=False))
                        tasks[index] = store.task(task["id"])
            self._json(200, public_outputs(store, manager, tasks=tasks))
            return
        if path.startswith("/api/photoshop/tasks/") and "/outputs/" in path and path.rsplit("/", 1)[-1] in {"import-info", "pixels", "selection-mask", "image-info"}:
            try:
                parts = path.split("/")
                task_id, index = parts[4], int(parts[6])
                query = parse_qs(urlparse(self.path).query)
                output_id = query.get("output_id", [""])[0]
                store, _ = self.state
                task = store.task(task_id)
                if not task:
                    raise FileNotFoundError("找不到任务")
                output, _ = resolve_output(task, index, output_id)
                if not output.get("photoshop"):
                    outputs = persist_outputs(task, task.get("outputs") or [])
                    store.update_task(task_id, outputs_json=json.dumps(outputs, ensure_ascii=False))
                    task = store.task(task_id)
                info = import_info(task, index, output_id)
                action = parts[-1]
                if action in {"import-info", "image-info"}:
                    self._json(200, {key: value for key, value in info.items() if key not in {"mask_path", "image_path"}})
                elif action == "pixels":
                    raw, width, height = rgba_for_placement(info["image_path"], info["width"], info["height"])
                    self._send_pixel_data(raw, width, height, "rgba8")
                else:
                    if not info["mask_path"]:
                        raise ValueError("成片没有选区蒙版")
                    raw, width, height = grayscale_mask(info["mask_path"], info["width"], info["height"])
                    self._send_pixel_data(raw, width, height, "gray8")
            except (ValueError, KeyError, OSError, IndexError) as exc:
                self._json(400, {"message": str(exc), "code": "PS_ARTIFACT_UNAVAILABLE"})
            return
        if path == "/api/webview/diagnostics":
            report = DATA_ROOT / "webview-diagnostics.json"
            self._json(200, json.loads(report.read_text()) if report.exists() else {"status": "not_run"})
            return
        if path == "/api/webview/capture-pixels":
            try:
                value = parse_qs(urlparse(self.path).query).get("path", [""])[0]
                target = Path(value).resolve()
                target.relative_to((DATA_ROOT / "photoshop" / "captures").resolve())
                with Image.open(target) as image:
                    raw = image.convert("RGBA").tobytes()
                self.send_response(200)
                self._headers("application/octet-stream", len(raw))
                self.end_headers()
                self.wfile.write(raw)
            except Exception:
                self._json(400, {"message": "仅允许读取此项目的捕获图片"})
            return
        super().do_GET()

    def do_POST(self):
        if not self._allowed_request():
            return
        path = urlparse(self.path).path
        if path == "/api/webview/self-test-task":
            try:
                body = self._body()
                capture_id = str(body.get("capture_id") or "")
                if not __import__("re").fullmatch(r"ps_[a-f0-9]{16}", capture_id):
                    raise ValueError("自检只能读取已保存的捕获快照")
                context = json.loads((DATA_ROOT / "photoshop" / "captures" / capture_id / "context.json").read_text())
                if not context.get("document_name", "").startswith("RH WebView ·"):
                    raise ValueError("自检只能使用合成临时工程")
                context["auto_import"] = False
                width, height = int(body.get("width", 64)), int(body.get("height", 32))
                if not (1 <= width <= 512 and 1 <= height <= 512):
                    raise ValueError("合成图片尺寸必须在 1–512 像素内")
                task_id = "task_ps_selftest_" + uuid.uuid4().hex[:12]
                output_dir = DATA_ROOT / "photoshop" / "self-tests"
                folder = output_dir / task_id
                folder.mkdir(parents=True)
                image_path = folder / "synthetic-result.png"
                Image.new("RGBA", (width, height), (40, 160, 140, 255)).save(image_path)
                workflow_path = folder / "workflow_api.json"
                workflow_path.write_text('{}\n')
                task = {"id": task_id, "initial_status": "running", "created_at": int(time.time() * 1000), "workflow_path": str(workflow_path), "workflow_name": "Photoshop 本地合成自检.json", "files": {}, "prompts": {"1:prompt": "合成提示词 · 透明度与位置自检"}, "photoshop_context": context, "output_dir": str(output_dir), "input_config": {"mode": "auto", "items": []}, "remote_workflow_id": "", "custom_inputs": {}, "bypassed_nodes": [], "random_noise": {}, "resolution": {}}
                store, _ = self.state
                store.create_task(task)
                store.update_task(task_id, status="completed", completed_at=int(time.time() * 1000), progress="本地合成测试 · 未调用生成服务", outputs_json=json.dumps([{"kind": "file", "name": image_path.name, "path": str(image_path), "mime": "image/png"}]))
                self._json(200, {"task": store.task(task_id)})
            except Exception as exc:
                self._json(400, {"message": str(exc)})
            return
        if path == "/api/photoshop/validate":
            try:
                workflow = self._body().get("workflow")
                if not isinstance(workflow, dict):
                    raise ValueError("工作流必须是节点对象")
                validate_graph(workflow)
                self._json(200, {"valid": True})
            except Exception as exc:
                self._json(400, {"message": str(exc)})
            return
        if path == "/api/webview/diagnostics":
            if int(self.headers.get("Content-Length", "0")) > 64 * 1024:
                self._json(413, {"message": "诊断记录过大"})
                return
            report = self._body()
            target = DATA_ROOT / "webview-diagnostics.json"
            target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            self._json(200, {"saved": True})
            return
        if path == "/api/webview/file-info":
            try:
                self._json(200, self._local_file_preview(str(self._body().get("path", ""))))
            except Exception as exc:
                self._json(400, self._safe_error(exc))
            return
        super().do_POST()

    def _body(self):
        if hasattr(self, "_cached_body"):
            body = self._cached_body
            del self._cached_body
            return body
        return super()._body()

    def do_PATCH(self):
        if not self._allowed_request():
            return
        if urlparse(self.path).path == "/api/settings":
            body = self._body()
            inbound = [key for key in body if key.startswith("telegram_") and "inbound" in key]
            if any(body.get(key) for key in inbound if key.endswith("_enabled")):
                self._json(400, {"message": "WebView 实验版未启用 Telegram 入站"})
                return
            self._cached_body = {key: value for key, value in body.items() if key not in inbound}
        super().do_PATCH()

    def do_DELETE(self):
        if not self._allowed_request():
            return
        path = urlparse(self.path).path
        if path.startswith("/api/webview/self-test-task/"):
            task_id = path.rsplit("/", 1)[-1]
            if not __import__("re").fullmatch(r"task_ps_selftest_[a-f0-9]{12}", task_id):
                self._json(400, {"message": "只允许清理本地合成自检任务"})
                return
            store, _ = self.state
            store.delete_task(task_id)
            shutil.rmtree(DATA_ROOT / "photoshop" / "self-tests" / task_id, ignore_errors=True)
            self._json(200, {"deleted": True})
            return
        super().do_DELETE()


class WebviewServer(base.AppServer):
    def __init__(self, address):
        self.allowed_origins = {
            f"http://localhost:{address[1]}", f"http://127.0.0.1:{address[1]}", f"uxp://{PLUGIN_ID}"
        }
        super().__init__(address)
        self.RequestHandlerClass = WebviewHandler


class WebviewTaskManager(TaskManager):
    def _telegram_inbound_loop(self):
        return


base.TaskManager = WebviewTaskManager


def main():
    parser = argparse.ArgumentParser(description="RH Workflow PS 本地服务")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    # Keep output delivery, but never start the copied Telegram inbound worker.
    httpd = WebviewServer(("127.0.0.1", args.port))
    url = f"http://localhost:{args.port}/"
    print(f"RH Workflow PS: {url}", flush=True)
    print(f"数据目录: {DATA_ROOT}", flush=True)
    if not args.no_browser:
        threading.Timer(0.25, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.toolbox.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    main()
