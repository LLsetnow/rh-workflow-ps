"""Output-owned placement/masks and validation for the Photoshop workflow."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps
from rh_cli.errors import RhCliError

from .photoshop import _safe_rect, image_dimensions


def placement_from_context(context: dict) -> dict:
    placement = context.get("placement")
    if isinstance(placement, dict):
        if placement.get("mode") not in {"selection", "layer_anchor", "canvas_center"}:
            raise ValueError("回贴位置模式无效")
        if placement["mode"] == "selection":
            rect = _safe_rect(placement.get("rect"))
            return {**placement, "rect": rect, "left": rect["left"], "top": rect["top"]}
        return dict(placement)
    # Legacy metadata is only eligible for explicit manual import.
    rect = context.get("selection_rect") or context.get("placement_rect")
    if context.get("selection_path") and rect:
        rect = _safe_rect(rect)
        return {"mode": "selection", "rect": rect, "left": rect["left"], "top": rect["top"], "size_policy": "stretch_to_selection", "mask_policy": "saved_selection"}
    if rect:
        rect = _safe_rect(rect)
        return {"mode": "layer_anchor", "left": rect["left"], "top": rect["top"], "size_policy": "native", "mask_policy": "none"}
    return {"mode": "canvas_center", "size_policy": "native", "mask_policy": "none"}


def persist_outputs(task: dict, outputs: list) -> list:
    """Publish independent attachments before publishing completed outputs.

    The hidden attachment directory is within the task's output folder. Rename
    and project classification retain the same output_id and attachment unit.
    It never enters the generated output list or delivery/export queues.
    """
    context = task.get("photoshop_context") or {}
    root = (Path(task["output_dir"]) / task["id"]).resolve()
    saved = []
    for output in outputs:
        if not isinstance(output, dict):
            saved.append(output)
            continue
        output = dict(output)
        if output.get("kind") != "file":
            saved.append(output)
            continue
        path = Path(str(output.get("path") or "")).resolve()
        if root not in path.parents or not path.is_file():
            saved.append(output)
            continue
        try:
            dimensions = image_dimensions(path)
        except (OSError, ValueError):
            saved.append(output)
            continue
        output_id = str(output.get("output_id") or "")
        if not output_id:
            output_id = "output_" + uuid.uuid4().hex[:24]
        if not output_id.startswith("output_") or not output_id.replace("_", "").isalnum():
            raise ValueError("成片 ID 无效")
        output["output_id"] = output_id
        folder = root / ".photoshop" / output_id
        metadata_path = folder / "photoshop.json"
        if metadata_path.is_file():
            # Never rebuild an existing asset using a later task/selection.
            output["photoshop"] = {"metadata_path": str(metadata_path), "output_id": output_id}
            saved.append(output)
            continue
        placement = placement_from_context(context)
        metadata = {"version": 1, "output_id": output_id, "source_task_id": task["id"], "image_size": dimensions,
                    "source_document": {"width": context.get("document_width", 0), "height": context.get("document_height", 0)},
                    "placement": placement, "selection_mask": None}
        folder.mkdir(parents=True, exist_ok=True)
        if placement["mode"] == "selection":
            rect = placement["rect"]
            source = Path(str(context.get("selection_path") or ""))
            expected = (rect["right"] - rect["left"], rect["bottom"] - rect["top"])
            metadata["selection_mask"] = {"path": "selection-mask.png", "width": expected[0], "height": expected[1], "role": "selection_mask"}
            try:
                if not source.is_file():
                    raise ValueError("原选区蒙版缺失")
                with Image.open(source) as image:
                    image.load()
                    if image.size != expected:
                        raise ValueError("原选区蒙版尺寸与矩形不一致")
                    image.convert("L").save(folder / "selection-mask.png")
            except (OSError, ValueError) as exc:
                # Generation succeeded. Keep its image and original geometry,
                # but require the declared mask before any Photoshop import.
                metadata["attachment_error"] = str(exc)
        temporary = folder / "photoshop.json.tmp"
        temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        os.chmod(temporary, 0o600)
        temporary.replace(metadata_path)
        output["photoshop"] = {"metadata_path": str(metadata_path), "output_id": output_id}
        saved.append(output)
    return saved


def resolve_output(task: dict, index: int, output_id: str = "") -> tuple[dict, Path]:
    outputs = task.get("outputs") or []
    if output_id:
        output = next((item for item in outputs if isinstance(item, dict) and item.get("output_id") == output_id), None)
    else:
        output = outputs[index] if 0 <= index < len(outputs) else None
    if not output or output.get("kind") != "file":
        raise ValueError("找不到指定成片，请刷新列表")
    root = (Path(task["output_dir"]) / task["id"]).resolve()
    path = Path(str(output.get("path") or "")).resolve()
    if root not in path.parents or not path.is_file():
        raise FileNotFoundError("成片文件不存在")
    return output, path


def import_info(task: dict, index: int, output_id: str = "") -> dict:
    output, path = resolve_output(task, index, output_id)
    dimensions = image_dimensions(path)
    ref = output.get("photoshop") or {}
    if ref:
        expected = (Path(task["output_dir"]) / task["id"] / ".photoshop" / output["output_id"]).resolve()
        metadata_path = Path(ref["metadata_path"]).resolve()
        if metadata_path != expected / "photoshop.json":
            raise ValueError("成片附件路径不属于此成片")
        metadata = json.loads(metadata_path.read_text())
        if metadata.get("output_id") != output["output_id"] or metadata.get("source_task_id") != task["id"]:
            raise ValueError("成片附件身份不匹配")
    else:
        context = task.get("photoshop_context") or {}
        metadata = {"placement": placement_from_context(context), "source_document": {"width": context.get("document_width", 0), "height": context.get("document_height", 0)}, "selection_mask": None}
        if metadata["placement"]["mode"] == "selection":
            raise ValueError("成片尚未保存选区附件，请刷新后重试")
    placement = placement_from_context(metadata)
    mask_path = ""
    if placement["mode"] == "selection":
        mask = metadata.get("selection_mask")
        if not isinstance(mask, dict) or mask.get("path") != "selection-mask.png":
            raise ValueError("成片声明选区蒙版，但蒙版附件缺失")
        mask_file = (metadata_path.parent / mask["path"]).resolve()
        if mask_file.parent != metadata_path.parent:
            raise ValueError("蒙版附件路径无效")
        rect = placement["rect"]
        width, height = rect["right"] - rect["left"], rect["bottom"] - rect["top"]
        if image_dimensions(mask_file) != {"width": width, "height": height}:
            raise ValueError("成片蒙版尺寸与原矩形不一致")
        mask_path = str(mask_file)
    else:
        width, height = dimensions["width"], dimensions["height"]
    return {"output_id": output.get("output_id", ""), "placement": placement,
            "width": width, "height": height, "original_width": dimensions["width"], "original_height": dimensions["height"],
            "source_document": metadata["source_document"], "mask_path": mask_path,
            "image_path": str(path), "has_mask": bool(mask_path)}


def attachment_files(output: dict, root: Path) -> list[Path]:
    ref = output.get("photoshop") or {}
    if not ref or not output.get("output_id"):
        return []
    folder = (root / ".photoshop" / output["output_id"]).resolve()
    path = Path(ref.get("metadata_path", "")).resolve()
    if root.resolve() not in folder.parents or path != folder / "photoshop.json":
        raise ValueError("成片附件不在任务目录内")
    return [file for file in folder.iterdir() if file.is_file() and file.resolve().parent == folder] if folder.is_dir() else []


def validate_graph(workflow: dict) -> None:
    nodes = {str(key): value for key, value in workflow.items() if isinstance(value, dict) and key != "__rh_meta__"}
    issues = []
    for node_id, node in nodes.items():
        for field, value in (node.get("inputs") or {}).items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int)) and isinstance(value[1], int):
                source = nodes.get(str(value[0]))
                if not source:
                    issues.append(f"{node_id}:{field} 引用了已删除的节点 {value[0]}")
                elif source.get("class_type") == "LoadImageMask" and value[1] != 0:
                    issues.append(f"{node_id}:{field} 的 LoadImageMask 只有 MASK 输出 0")
                elif source.get("class_type") == "LoadImageMask" and field in {"image", "images", "pixels"}:
                    issues.append(f"{node_id}:{field} 需要图像，不能连接 MASK")
    metadata = workflow.get("__rh_meta__") or {}
    for item in metadata.get("photoshop_disconnected_inputs") or []:
        node = nodes.get(str(item.get("node_id")))
        if node and item.get("field") not in (node.get("inputs") or {}):
            issues.append(f"{item['node_id']}:{item['field']} 缺少删除图片节点后断开的必填连接")
    for node_id, node in nodes.items():
        if node.get("class_type") not in {"LoadImage", "LoadImageMask"}:
            continue
        connected = any(isinstance(value, list) and len(value) == 2 and str(value[0]) == node_id
                        for other in nodes.values() for value in (other.get("inputs") or {}).values())
        if not connected:
            issues.append(f"图片节点 {node_id} 未连接到工作流，请选择下游连接或删除该节点")
    if issues:
        raise RhCliError("INVALID_IMAGE_GRAPH", "；".join(issues))


def freeze_inputs(files: dict, workflow: dict, context: dict, root: Path) -> dict:
    """Copy only explicit local inputs. Never retain mutable originals as tasks."""
    frozen = dict(files)
    root.mkdir(parents=True, exist_ok=True)
    entries = {item["input_id"]: item for item in context.get("inputs") or []}
    for input_id, raw_path in files.items():
        node = workflow.get(input_id.split(":", 1)[0]) or {}
        if node.get("class_type") not in {"LoadImage", "LoadImageMask"}:
            raise RhCliError("PS_IMAGE_ONLY", "Photoshop 图片工作流仅支持图片输入")
        path = Path(raw_path).expanduser().resolve()
        dimensions = image_dimensions(path)
        if node.get("class_type") == "LoadImageMask":
            entry = entries.get(input_id) or {}
            if not (context.get("selection") or {}).get("present") or entry.get("mode") != "selection_mask" or not context.get("active_layer_id"):
                raise RhCliError("PS_SELECTION_REQUIRED", "LoadImageMask 必须使用活动图层的选区蒙版")
            channel = (node.get("inputs") or {}).get("channel", "red")
            if channel not in {"red", "green", "blue", "alpha"}:
                raise RhCliError("INVALID_MASK_CHANNEL", "蒙版节点的 channel 无效")
            with Image.open(path) as image:
                mask = image.convert("L")
                uploaded = mask.convert("RGBA")
                if channel == "alpha":
                    uploaded.putalpha(ImageOps.invert(mask))
                destination = root / (hashlib.sha256(input_id.encode()).hexdigest()[:16] + ".png")
                uploaded.save(destination)
        else:
            destination = root / (hashlib.sha256(input_id.encode()).hexdigest()[:16] + path.suffix)
            shutil.copyfile(path, destination)
        os.chmod(destination, 0o600)
        frozen[input_id] = str(destination)
    return frozen


def project_for_document(context: dict) -> dict | None:
    name = str(context.get("document_name") or "").strip()
    if not name:
        return None
    name = Path(name).stem
    return {"name": name, "id": "project_" + hashlib.sha1(("name:" + name).encode()).hexdigest()[:12], "path": ""}
