"""Local Photoshop capture and pixel preparation helpers."""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import uuid
import io
import shutil
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .app import DATA_ROOT


MAX_CAPTURE_BYTES = 200 * 1024 * 1024
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,180}$")


def _decode_png(value: Any, label: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError(f"缺少{label} PNG 数据")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"{label}不是有效的 Base64") from exc
    if len(raw) > MAX_CAPTURE_BYTES:
        raise ValueError(f"{label}超过 200 MB 限制")
    try:
        with Image.open(__import__("io").BytesIO(raw)) as image:
            image.verify()
    except Exception as exc:
        raise ValueError(f"{label}不是有效图像") from exc
    return raw


def _safe_rect(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        raise ValueError("缺少图层坐标矩形")
    try:
        left, top, right, bottom = (int(value[key]) for key in ("left", "top", "right", "bottom"))
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("图层坐标矩形无效") from exc
    if right <= left or bottom <= top:
        raise ValueError("图层坐标矩形必须具有正宽高")
    if any(abs(number) > 2_000_000 for number in (left, top, right, bottom)):
        raise ValueError("图层坐标超出支持范围")
    return {"left": left, "top": top, "right": right, "bottom": bottom}


def _reused_snapshot(value: Any, body: dict[str, Any]) -> Path:
    """Resolve only an immutable PNG from this project's matching capture state."""
    path = Path(str(value or "")).expanduser().resolve()
    root = (DATA_ROOT / "photoshop" / "captures").resolve()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise ValueError("复用图片必须属于此项目的捕获快照") from exc
    if len(relative.parts) != 2 or not re.fullmatch(r"ps_[a-f0-9]{16}", path.parent.name) or not re.fullmatch(r"(?:input-\d+|selection)\.png", path.name):
        raise ValueError("复用图片路径无效")
    if not path.is_file():
        raise ValueError("捕获快照已失效，请重新捕获")
    source = json.loads((path.parent / "context.json").read_text())
    for key in ("document_id", "session_id", "source_revision"):
        if not body.get(key) or source.get(key) != body.get(key):
            raise ValueError("复用图片与当前工程状态不一致")
    with Image.open(path) as image:
        image.verify()
    return path


def save_capture(body: dict[str, Any]) -> dict[str, Any]:
    """Persist UXP-created immutable PNG snapshots and return task file paths."""
    raw_inputs = body.get("inputs")
    if not isinstance(raw_inputs, list):
        raise ValueError("inputs 必须是数组")
    capture_id = f"ps_{uuid.uuid4().hex[:16]}"
    root = DATA_ROOT / "photoshop" / "captures" / capture_id
    root.mkdir(parents=True, exist_ok=False)
    context: dict[str, Any] = {
        "version": 2,
        "session_id": str(body.get("session_id") or "")[:160],
        "document_id": str(body.get("document_id") or "")[:160],
        "document_name": str(body.get("document_name") or "")[:255],
        "document_width": int(body.get("document_width") or 0),
        "document_height": int(body.get("document_height") or 0),
        "placement_input_id": str(body.get("placement_input_id") or ""),
        "selection_path": "",
        "selection_rect": None,
        "inputs": [],
        "imports": [],
        "capture_id": capture_id,
        "active_layer_id": str(body.get("active_layer_id") or ""),
        "document_path": str(body.get("document_path") or ""),
        "source_revision": str(body.get("source_revision") or "")[:4096],
        "auto_import": True,
    }
    files: dict[str, str] = {}
    total = 0
    try:
        selection_png = body.get("selection_png")
        selection_source = body.get("selection_path")
        if bool(selection_png or selection_source) != bool(body.get("selection_rect")):
            raise ValueError("选区必须同时保存矩形和蒙版")
        if selection_png or selection_source:
            if selection_png:
                raw = _decode_png(selection_png, "选区快照")
                selection_path = root / "selection.png"
                selection_path.write_bytes(raw)
                os.chmod(selection_path, 0o600)
            else:
                selection_path = _reused_snapshot(selection_source, body)
            total += selection_path.stat().st_size
            if body.get("selection_rect"):
                selection_rect = _safe_rect(body["selection_rect"])
                with Image.open(selection_path) as image:
                    if image.size != (selection_rect["right"] - selection_rect["left"], selection_rect["bottom"] - selection_rect["top"]):
                        raise ValueError("选区蒙版尺寸与外接矩形不一致")
            context["selection_path"] = str(selection_path)
            if body.get("selection_rect"):
                context["selection_rect"] = selection_rect

        for index, item in enumerate(raw_inputs):
            if not isinstance(item, dict):
                raise ValueError(f"第 {index + 1} 个输入无效")
            input_id = str(item.get("input_id") or "")
            mode = str(item.get("mode") or "")
            if not _SAFE_ID.fullmatch(input_id):
                raise ValueError(f"工作流输入 ID 无效：{input_id}")
            if input_id in files:
                raise ValueError("图片输入 ID 重复")
            if mode not in {"layer_full", "layer_crop", "mask_full", "mask_crop", "selection_image", "selection_mask"}:
                raise ValueError(f"输入 {input_id} 的 Photoshop 模式无效")
            if item.get("png"):
                raw = _decode_png(item.get("png"), f"输入 {input_id}")
                file_path = root / f"input-{index:03d}.png"
                file_path.write_bytes(raw)
                os.chmod(file_path, 0o600)
            else:
                file_path = _reused_snapshot(item.get("snapshot_path"), body)
            total += file_path.stat().st_size
            if total > MAX_CAPTURE_BYTES:
                raise ValueError("本次捕获总量超过 200 MB")
            rect = _safe_rect(item.get("rect"))
            full_bounds = _safe_rect(item.get("full_bounds") or item.get("rect"))
            with Image.open(file_path) as image:
                if image.size != (rect["right"] - rect["left"], rect["bottom"] - rect["top"]):
                    raise ValueError(f"输入 {input_id} 图像尺寸与坐标矩形不一致")
            files[input_id] = str(file_path)
            context["inputs"].append({
                "input_id": input_id,
                "mode": mode,
                "layer_id": str(item.get("layer_id") or "")[:160],
                "layer_name": str(item.get("layer_name") or "")[:255],
                "rect": rect,
                "full_bounds": full_bounds,
                "snapshot_path": str(file_path),
                "width": int(item.get("width") or rect["right"] - rect["left"]),
                "height": int(item.get("height") or rect["bottom"] - rect["top"]),
            })

        placement = context["placement_input_id"]
        placement_entry = next((entry for entry in context["inputs"] if entry["input_id"] == placement), None)
        if placement and not placement_entry:
            raise ValueError("定位输入必须是本次捕获的 Photoshop 图层输入")
        context["selection"] = {"present": bool(context["selection_rect"]), "rect": context["selection_rect"], "mask_path": context["selection_path"]}
        if context["selection_rect"]:
            rect = context["selection_rect"]
            context["placement"] = {"mode": "selection", "rect": rect, "left": rect["left"], "top": rect["top"], "size_policy": "stretch_to_selection", "mask_policy": "saved_selection"}
            context["placement_rect"] = rect
            context["placement_mode"] = "layer_crop"
        elif placement_entry and placement_entry["mode"] == "layer_full":
            rect = placement_entry["rect"]
            context["placement"] = {"mode": "layer_anchor", "left": rect["left"], "top": rect["top"], "anchor_input_id": placement, "anchor_layer_id": placement_entry["layer_id"], "size_policy": "native", "mask_policy": "none"}
            context["placement_rect"] = rect
            context["placement_mode"] = "layer_full"
        else:
            context["placement"] = {"mode": "canvas_center", "size_policy": "native", "mask_policy": "none"}
        snapshot = root / "context.json"
        snapshot.write_text(json.dumps(context, ensure_ascii=False, indent=2) + "\n")
        os.chmod(snapshot, 0o600)
        return {"capture_id": capture_id, "files": files, "photoshop_context": context}
    except Exception:
        for path in root.glob("*"):
            path.unlink(missing_ok=True)
        root.rmdir()
        raise


def rgba_for_placement(path: str | Path, width: int, height: int) -> tuple[bytes, int, int]:
    """Decode and fit an output to the saved target rectangle as RGBA bytes."""
    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    width, height = int(width), int(height)
    if width < 1 or height < 1 or width > 30000 or height > 30000:
        raise ValueError("目标矩形尺寸无效")
    with Image.open(source) as image:
        image.load()
        image = ImageOps.exif_transpose(image).convert("RGBA")
        if image.size != (width, height):
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        return image.tobytes(), width, height


def image_dimensions(path: str | Path) -> dict[str, int]:
    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    with Image.open(source) as image:
        image.verify()
    with Image.open(source) as image:
        width, height = ImageOps.exif_transpose(image).size
    if width < 1 or height < 1 or width > 30000 or height > 30000:
        raise ValueError("产物尺寸无效")
    return {"width": width, "height": height}


def grayscale_mask(path: str | Path, width: int, height: int) -> tuple[bytes, int, int]:
    """Return the saved selection mask as a single-channel image."""
    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    width, height = int(width), int(height)
    if width < 1 or height < 1 or width > 30000 or height > 30000:
        raise ValueError("目标蒙版尺寸无效")
    with Image.open(source) as image:
        image.load()
        image = image.convert("L")
        if image.size != (width, height):
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        return image.tobytes(), width, height


def update_import_state(store: Any, task_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Claim/finish an import in a SQLite transaction, across panels/processes."""
    status = str(body.get("status") or "").lower()
    if status not in {"pending", "importing", "imported", "failed", "needs_document", "needs_review"}:
        raise ValueError("回贴状态无效")
    request_id = str(body.get("request_id") or "")
    manual = bool(body.get("manual"))
    if manual and not _SAFE_ID.fullmatch(request_id):
        raise ValueError("手动导入必须提供有效请求 ID")
    index = int(body.get("output_index", -1))
    now = int(time.time() * 1000)
    claimed = True
    with store._lock:
        store._db.execute("BEGIN IMMEDIATE")
        try:
            row = store._db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row:
                raise KeyError("找不到任务")
            task = dict(row)
            outputs = json.loads(task.get("outputs_json") or "[]")
            wanted_id = str(body.get("output_id") or "")
            if wanted_id:
                index = next((i for i, item in enumerate(outputs) if item.get("output_id") == wanted_id), -1)
            if index < 0 or index >= len(outputs) or outputs[index].get("kind") != "file":
                raise ValueError("output_index 超出任务图片产物范围")
            output_id = outputs[index].get("output_id") or f"legacy:{index}"
            context = json.loads(task.get("photoshop_context_json") or "{}")
            collection = context.setdefault("manual_imports" if manual else "output_imports", {})
            identity = request_id if manual else output_id
            current = collection.get(identity) or {}
            # Read pre-v2 import markers without reinterpreting their placement.
            legacy = context.get("imports") or []
            if not current and not manual and index < len(legacy):
                current = legacy[index] or {}
            if current.get("status") == "imported":
                claimed = False
            elif status == "importing" and current.get("status") == "importing":
                # Only the existing owner may journal a completed pixel/mask write.
                claimed = current.get("request_id") == request_id and body.get("write_complete") is True and bool(body.get("layer_id"))
            elif current.get("status") == "importing" and status != "importing" and current.get("request_id") != request_id:
                claimed = False
            if claimed:
                record = {**current, "status": status, "output_id": output_id, "output_index": index,
                          "request_id": request_id, "updated_at": now, "error": str(body.get("error") or "")[:1000]}
                for key in ("layer_id", "group_id", "document_id", "session_id"):
                    record[key] = str(body.get(key) or current.get(key) or "")[:160]
                record["write_complete"] = body.get("write_complete") is True or bool(current.get("write_complete"))
                collection[identity] = record
                if not manual:
                    while len(legacy) <= index:
                        legacy.append({"status": "pending"})
                    legacy[index] = record
                    context["imports"] = legacy
                store._db.execute("UPDATE tasks SET photoshop_context_json=?,updated_at=? WHERE id=?", (json.dumps(context, ensure_ascii=False), now, task_id))
            store._db.commit()
        except Exception:
            store._db.rollback()
            raise
    with store._lock:
        updated = store.task(task_id)
        if claimed and updated:
            # A manifest failure must not erase the SQLite claim or successful layer.
            store.save_task_manifest_snapshot(updated, updated.get("prompt_group") or {})
    return {**(updated or {}), "import_claimed": claimed}


def update_workflow_config(store: Any, workflow_id: str, config: Any) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ValueError("photoshop_config 必须是对象")
    detail = store.workflow_detail(workflow_id)
    workflow = detail["workflow"]
    metadata = workflow.get("__rh_meta__")
    metadata = dict(metadata) if isinstance(metadata, dict) else {}
    clean_inputs: dict[str, dict[str, str]] = {}
    raw_inputs = config.get("inputs")
    if isinstance(raw_inputs, dict):
        for input_id, settings in raw_inputs.items():
            if not _SAFE_ID.fullmatch(str(input_id)) or not isinstance(settings, dict):
                continue
            mode = str(settings.get("mode") or "file")
            if mode not in {"file", "auto", "selection_mask", "layer_full", "layer_crop", "mask_full", "mask_crop"}:
                continue
            clean_inputs[str(input_id)] = {"mode": mode, **{key: str(settings.get(key) or "")[:160] for key in ("layer_id", "document_id", "session_id")}}
    placement = str(config.get("placement_input_id") or "")
    if placement and placement not in clean_inputs:
        raise ValueError("定位输入必须是已配置的图片输入")
    metadata["photoshop_config"] = {"inputs": clean_inputs, "placement_input_id": placement}
    workflow["__rh_meta__"] = metadata
    path = store.workflow_path(workflow_id)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    return metadata["photoshop_config"]


def update_workflow_input_config(store: Any, workflow_id: str, config: Any) -> dict[str, Any] | None:
    return store.update_workflow(workflow_id, {"input_config": config}).get("input_config")


def import_desktop_data(store: Any, source_directory: str) -> dict[str, int]:
    """Copy workflow packages, keys, account mappings and safe settings locally."""
    source = Path(source_directory).expanduser().resolve()
    if not source.is_dir():
        raise ValueError("请选择 RH Workflow Desk 的 data 文件夹或项目文件夹")
    candidates = [source, source / "data"]
    root = next((item for item in candidates if (item / "keys.json").is_file() or (item / "workflow-registry.json").is_file()), None)
    if root is None:
        raise ValueError("所选文件夹中没有找到工作流或 API Key 数据")

    def read_json(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    account_data = read_json(root / "accounts.json")
    incoming_accounts = account_data.get("accounts") if isinstance(account_data.get("accounts"), list) else []
    accounts_by_id = {str(item.get("id") or ""): item for item in store.accounts() if isinstance(item, dict)}
    account_count = 0
    for item in incoming_accounts:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            continue
        clean = dict(item)
        # Session state belongs to the source desktop runtime and cannot be
        # carried into this process. Only the account mapping is imported.
        clean["status"] = "login_required"
        clean["status_message"] = "已导入账号映射；请在 Photoshop 插件中重新登录 RunningHub。"
        accounts_by_id[str(clean["id"])] = clean
        account_count += 1
    store.save_accounts(list(accounts_by_id.values()))

    key_data = read_json(root / "keys.json")
    incoming_keys = key_data.get("keys") if isinstance(key_data.get("keys"), list) else []
    key_records = store.keys()
    known_secrets = {str(item.get("api_key") or "") for item in key_records}
    key_count = 0
    for item in incoming_keys:
        if not isinstance(item, dict):
            continue
        secret = str(item.get("api_key") or "").strip()
        if not secret or secret in known_secrets:
            continue
        record = dict(item)
        record.setdefault("id", f"key_{uuid.uuid4().hex[:12]}")
        account_id = str(record.get("account_id") or "")
        if account_id and account_id not in accounts_by_id:
            record["account_id"] = ""
        key_records.append(record)
        known_secrets.add(secret)
        key_count += 1
    store.save_keys(key_records)
    strategy = str(key_data.get("api_key_strategy") or "").strip().lower()
    if strategy in {"personal_only", "personal_then_shared", "shared_only"}:
        store.set_api_key_strategy(strategy)
    elif strategy == "single":
        store.set_api_key_strategy("personal_only")
    elif strategy in {"round_robin", "least_busy"}:
        # Older desktop builds routed among keys; retain their intent to use
        # personal keys before falling back to shared keys.
        store.set_api_key_strategy("personal_then_shared")
    if key_data.get("personal_capacity") is not None:
        try:
            store.set_personal_capacity(key_data["personal_capacity"])
        except (ValueError, TypeError):
            pass
    selected_account = str(key_data.get("current_account_id") or "")
    if selected_account and selected_account in accounts_by_id:
        store.set_current_account(selected_account)

    registry = read_json(root / "workflow-registry.json")
    records = registry.get("workflows") if isinstance(registry.get("workflows"), list) else []
    workflow_root = root / "workflow"
    legacy_root = root / "workflows"
    imported = 0
    for index_record in records:
        if not isinstance(index_record, dict):
            continue
        record = dict(index_record)
        workflow_id = str(record.get("id") or "").strip()
        if not workflow_id or Path(workflow_id).name != workflow_id:
            continue
        source_manifest = workflow_root / workflow_id / "manifest.json"
        manifest_data = read_json(source_manifest)
        record = {**record, **manifest_data, "id": workflow_id}
        package = workflow_root / workflow_id / "workflow_api.json"
        legacy = legacy_root / f"{workflow_id}.json"
        workflow_path = package if package.is_file() else legacy
        if not workflow_path.is_file():
            continue
        try:
            workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            continue
        if not isinstance(workflow, dict):
            continue
        metadata = workflow.get("__rh_meta__")
        metadata = dict(metadata) if isinstance(metadata, dict) else {}
        source_account_id = str(record.get("account_id") or metadata.get("accountId") or "")
        if source_account_id and source_account_id not in accounts_by_id:
            source_account_id = ""
            metadata.pop("accountId", None)
        workflow["__rh_meta__"] = metadata
        config = record.get("input_config") if isinstance(record.get("input_config"), dict) else None
        prompt_path = workflow_path.parent / "prompt_group.json" if workflow_path.parent.name == workflow_id else None
        prompt_group = None
        if prompt_path and prompt_path.is_file():
            prompt_group = read_json(prompt_path)
        try:
            store.save_workflow(
                str(record.get("name") or workflow_path.name),
                json.dumps(workflow, ensure_ascii=False),
                account_id=source_account_id,
                remote_workflow_id=str(record.get("remote_workflow_id") or ""),
                input_config=config,
                prompt_group=prompt_group,
            )
            imported += 1
        except Exception:
            continue
    return {"accounts": account_count, "keys": key_count, "workflows": imported}
