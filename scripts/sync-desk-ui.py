#!/usr/bin/env python3
"""Copy Desk frontend assets and apply small, repeatable host integration hooks."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT.parent / "rh-workflow-desk"


def replace_once(source, before, after, filename):
    if source.count(before) != 1:
        raise RuntimeError(f"Desk integration hook changed in {filename}: {before[:80]}")
    return source.replace(before, after, 1)


def apply_image_workflow_hooks(source):
    def patch(before, after):
        nonlocal source
        source = replace_once(source, before, after, "app.js")
    patch('    image: { label: "图片", classType: "LoadImage", field: "image", accept: "image/*", icon: "▧" },', '    image: { label: "图片", classType: "LoadImage", field: "image", accept: "image/*", icon: "▧" },\n    mask: { label: "选区蒙版", classType: "LoadImageMask", field: "image", accept: "image/*", icon: "▧" },')
    patch('mediaInputTypes[["image", "audio", "video"].indexOf(kind)', 'mediaInputTypes[["image", "mask", "audio", "video"].indexOf(kind)')
    patch('    if (kind === "audio") inputs.audioUI = "";', '    if (kind === "audio") inputs.audioUI = "";\n    if (kind === "mask") inputs.channel = "red";')
    patch('    inputs[spec.field] = "";', '    inputs[spec.field] = kind === "mask" ? "undefined" : "";')
    patch('      _meta: { title: "媒体输入 · " + spec.label, rh_dynamic_media: true, rh_media_kind: kind }', '      _meta: { title: kind === "mask" ? "Load Image (as Mask)" : "媒体输入 · " + spec.label, rh_dynamic_media: true, rh_media_kind: kind }')
    patch('title: "媒体输入 · " + spec.label, class_type: spec.classType', 'title: kind === "mask" ? "Load Image (as Mask)" : "媒体输入 · " + spec.label, class_type: spec.classType')
    patch('  function mediaInputConnectionTargets(workflow, kind) {\n    var targets = [];', '  function mediaInputConnectionTargets(workflow, kind) {\n    if (window.RHHost && window.RHHost.connectionTargets) return window.RHHost.connectionTargets(workflow, kind);\n    var targets = [];')
    patch('  function mediaInputConnectionTargetLabel(target) {', '  function mediaInputConnectionTargetLabel(target) {\n    if (target.label) return target.label;')
    patch('    var connectionTargets = mediaInputConnectionTargets(appState.workflow, kind);', '    var candidates = mediaInputConnectionTargets(appState.workflow, kind);\n    var connectionTargets = candidates.length === 1 ? candidates : [];')
    patch('    if (targets.length) {\n      description.textContent', '    if (targets.length === 1) {\n      description.textContent')
    patch('    result.file_inputs = files;', '    (base.file_inputs || []).forEach(function (item) { if (/^LoadImage/.test(item.class_type) && !files.some(function (value) {return value.id === item.id;})) files.push(item); });\n    result.file_inputs = files;')
    patch('  function removeMediaInputNode(nodeId, inputId) {', '  async function removeMediaInputNode(nodeId, inputId) {')
    patch('    if (!window.confirm("删除「" + title + "」吗？将自动断开它连接的下游节点。")) return;', '    if (!await window.RHHost.confirm("删除「" + title + "」吗？将自动断开它连接的下游节点。")) return;')
    patch('    var disconnected = disconnectMediaInputConnections(appState.workflow, nodeId);', '    var disconnected = disconnectMediaInputConnections(appState.workflow, nodeId);\n    var metadata = appState.workflow.__rh_meta__ = appState.workflow.__rh_meta__ || {};\n    metadata.photoshop_disconnected_inputs = (metadata.photoshop_disconnected_inputs || []).concat(disconnected);\n    var psConfig = metadata.photoshop_config;\n    if (psConfig) {\n      delete (psConfig.inputs || {})[inputId];\n      if (psConfig.placement_input_id === inputId) psConfig.placement_input_id = "";\n    }')
    patch('    inputs.hidden = false;\n    $("submitStrip").hidden = false;', '    inputs.hidden = false;\n    document.dispatchEvent(new CustomEvent("rh:workflow-rendered"));\n    $("submitStrip").hidden = false;')
    patch('  bindEvents();\n  function loadToolboxRuntime()', '  window.RHWorkflow = {state: appState, saveDraftNow: saveDraftNow, collectInputs: collectInputs, refreshWorkflowAnalysis: refreshWorkflowAnalysis};\n  bindEvents();\n  function loadToolboxRuntime()')
    source = source.replace('图片可接入 MiniMax H3 或 Qwen Image 2.1；音频和视频接入 MiniMax H3。没有兼容节点时会作为独立输入添加。', '图片自动读取 Photoshop 图层；蒙版节点固定读取活动图层选区。未连接节点须选择下游连接。').replace('＋ 添加媒体输入', '＋ 添加图片 / 蒙版').replace('媒体输入</strong>', '图片输入</strong>')
    patch('    window.RHHost.prepareWorkflowInputs().then(submitTaskCore).catch(function (error) {showToast(error.message, true);}).finally(function () {delete button.dataset.preparing;});', '    var frozenWorkflow = JSON.stringify(appState.workflow);\n    var panel = $("workflowInputs").closest(".panel") || $("workflowInputs");\n    panel.inert = true;\n    window.RHHost.prepareWorkflowInputs().then(function () {\n      if (JSON.stringify(appState.workflow) !== frozenWorkflow) throw new Error("捕获期间工作流已变化，请重新提交");\n      submitTaskCore();\n    }).catch(function (error) {showToast(error.message, true);}).finally(function () {panel.inert = false; delete button.dataset.preparing;});')
    return source


def apply_output_delete_hooks(source):
    for name in ("deleteArtifactTask", "deleteSelectedOutputs", "deleteOneStarOutputs"):
        source = replace_once(source, "  function " + name + "(", "  async function " + name + "(", "outputs.js")
    source = source.replace("!window.confirm(", "!await window.RHHost.confirm(")
    source = replace_once(source, '''    }).catch(function (error) {
      if (button) button.disabled = false;
      showToast(error.message, true);
    });
  }
  function handleOutputKeyboardShortcut''', '''    }).catch(function (error) {
      showToast(error.message, true);
    }).finally(function () {
      if (button) button.disabled = false;
    });
  }
  function handleOutputKeyboardShortcut''', "outputs.js")
    return source


def apply_modal_focus_hook(source):
    return replace_once(source, '    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();', '''    var openModals = document.querySelectorAll(".modal-backdrop:not([hidden]):not(.is-closing)");
    var topModal = openModals[openModals.length - 1];
    if (returnFocus && document.contains(returnFocus) && (!topModal || topModal.contains(returnFocus))) returnFocus.focus();''', "motion.js")


def apply_host_hooks(target_root):
    app = target_root / "static" / "app.js"
    source = app.read_text()
    source = replace_once(source, "  function submitTask() {", '''  function submitTask() {
    if (!window.RHHost || !window.RHHost.isPhotoshop()) return submitTaskCore();
    var button = $("submitButton");
    if (button.disabled || button.dataset.preparing === "1") return;
    if (!appState.workflowId) return submitTaskCore();
    button.dataset.preparing = "1";
    window.RHHost.prepareWorkflowInputs().then(submitTaskCore).catch(function (error) {showToast(error.message, true);}).finally(function () {delete button.dataset.preparing;});
  }
  function submitTaskCore() {''', "app.js")
    source = replace_once(source, "      files: values.files,\n      prompts: values.prompts,", "      files: values.files,\n      photoshop_context: window.RHPhotoshopDraftContext || {},\n      prompts: values.prompts,", "app.js")
    source = replace_once(source, '  document.addEventListener("rh:video-frame-captured", function (event) {', '''  document.addEventListener("rh:photoshop-input-captured", function (event) {
    var detail = event.detail || {};
    if (detail.inputId && detail.asset) setPastedImageState(detail.inputId, detail.asset, detail.asset.name || "Photoshop 输入.png");
  });
  document.addEventListener("rh:video-frame-captured", function (event) {''', "app.js")
    source = apply_image_workflow_hooks(source)
    app.write_text(source)
    motion = target_root / "static" / "motion.js"
    source = motion.read_text().replace('["/workflows", "/prompt", "/", "/outputs", "/dashboard", "/settings", "/outputs/compare"]', '["/workflows", "/", "/outputs", "/dashboard", "/settings", "/outputs/compare"]')
    motion.write_text(apply_modal_focus_hook(source))
    workflows = target_root / "static" / "workflows.js"
    source = workflows.read_text()
    for name in ("deleteWorkflowLibraryRecord", "deleteWorkflowFolder"):
        source = source.replace("  function " + name + "(", "  async function " + name + "(")
    source = source.replace("!window.confirm(", "!await window.RHHost.confirm(")
    # Other confirmations in disabled prompt-group functions also become async.
    for name in ("deletePromptGroupFolder", "deletePromptGroup"):
        source = source.replace("  function " + name + "(", "  async function " + name + "(")
    workflows.write_text(source)
    outputs = target_root / "static" / "outputs.js"
    source = apply_output_delete_hooks(outputs.read_text())
    source = replace_once(source, '    if (action === "import") openOutputImport(item, button);', '    if (action === "import") openOutputImport(item, button);\n    if (action === "import-photoshop") window.RHHost.openOutputImport(item);', "outputs.js")
    source = replace_once(source, '    if (importAction) importAction.hidden = item.kind !== "file";', '    if (importAction) importAction.hidden = item.kind !== "file";\n    var psImportAction = menu.querySelector(\'[data-artifact-menu-action="import-photoshop"]\');\n    if (psImportAction) psImportAction.hidden = item.kind !== "file" || item.display_type !== "image";', "outputs.js")
    source = replace_once(source, '\'\" data-task-id=\"\' + esc(item.task_id)', '\'\" data-ps-draggable=\"\' + (item.display_type === "image" ? "true" : "false") + \'\" data-ps-output-index=\"\' + esc(item.output_index) + \'\" data-ps-output-id=\"\' + esc(item.output_id || "") + \'\" data-task-id=\"\' + esc(item.task_id)', "outputs.js")
    outputs.write_text(source)
    outputs_html = target_root / "static" / "outputs.html"
    source = outputs_html.read_text().replace('data-artifact-menu-action="import">导入媒体</button>', 'data-artifact-menu-action="import-photoshop">导入项目</button>\n      <button type="button" role="menuitem" data-artifact-menu-action="import">导入工作流输入</button>')
    outputs_html.write_text(source)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    args = parser.parse_args()
    source_root = args.source.resolve()
    files = {}
    for source in (source_root / "static").rglob("*"):
        if not source.is_file() or source.name.startswith(("prompt.", "focus.")) or source.name == ".DS_Store":
            continue
        relative = source.relative_to(source_root / "static")
        target = ROOT / "static" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        raw = source.read_bytes()
        files[str(relative)] = hashlib.sha256(raw).hexdigest()
        if source.suffix == ".html":
            markup = raw.decode()
            markup = re.sub(r'<a\b[^>]*href="/(?:prompt|focus)"[^>]*>.*?</a>', "", markup, flags=re.S)
            markup = markup.replace('class="telegram-function-panel telegram-inbound-panel"', 'class="telegram-function-panel telegram-inbound-panel" hidden data-disabled-feature="telegram-inbound"')
            markup = markup.replace('class="telegram-function-block telegram-inbound-block"', 'class="telegram-function-block telegram-inbound-block" hidden data-disabled-feature="telegram-inbound"')
            markup = markup.replace("推送与入站共用同一个 Bot Token，下面分别配置两项功能的 Chat ID。", "任务完成后可将成片推送到 Telegram。")
            markup = markup.replace("Bot Token（推送与入站共用）", "Bot Token")
            markup = markup.replace("RH Workflow Desk", "RH Workflow PS")
            markup = markup.replace("</head>", '<link rel="stylesheet" href="/static/ps-webview.css"><script src="/static/ps-webview.js"></script>\n</head>')
            markup = re.sub(r"(?m)^[ \t]+$", "", markup)
            target.write_text(markup)
        else:
            shutil.copy2(source, target)
    apply_host_hooks(ROOT)
    metadata = {"source": str(source_root), "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source_root, text=True).strip(), "files": files}
    (ROOT / "docs" / "source-ui.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    print(f"Synced {len(files)} Desk frontend assets; shared app.css is unchanged.")


if __name__ == "__main__":
    main()
