"use strict";
// Native imaging helpers adapted from rh-workflow-ps; business UI is in WebView.
var Photoshop = require("photoshop");
var UXP = require("uxp");
var psApp = Photoshop.app;
var psCore = Photoshop.core;
var imaging = Photoshop.imaging;
var batchPlay = Photoshop.action.batchPlay;
var fs = UXP.storage.localFileSystem;
var API = "http://localhost:8768";
var PLUGIN_ID = "com.llsetnow.rhworkflowpswebview";
var CHANNEL = "rh-ps-webview-v1";
var sessionId = "ps-webview-" + Date.now() + "-" + Math.random().toString(36).slice(2);
var model = {activeLayerId: ""};
var webview = document.getElementById("workflow-webview");
var nativeQueue = Promise.resolve();
async function api(path, options) {
  options = options || {};
  var response = await fetch(API + path, {method: options.method || "GET", headers: options.body ? {"Content-Type": "application/json"} : undefined, body: options.body ? JSON.stringify(options.body) : undefined});
  var data = await response.json();
  if (!response.ok) throw new Error(data.message || ("HTTP " + response.status));
  return data;
}
async function readBinary(path) {
  var response = await fetch(API + path);
  if (!response.ok) throw new Error("无法读取图像像素：" + response.status);
  return new Uint8Array(await response.arrayBuffer());
}
function bytesToBase64(bytes) {
  var parts = [];
  for (var i = 0; i < bytes.length; i += 0x6000) {
    var binary = "";
    var end = Math.min(bytes.length, i + 0x6000);
    for (var j = i; j < end; j++) binary += String.fromCharCode(bytes[j]);
    parts.push(binary);
  }
  return btoa(parts.join(""));
}
function pixelsFromImageData(imageData) {
  return imageData.getData({ chunky: true });
}

function srgbToLinear(value) {
  value /= 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
function documentComponentSize(doc) {
  var depth = String(doc.bitsPerChannel);
  return depth === "bitDepth16" || depth === "16" ? 16 : (depth === "bitDepth32" || depth === "32" ? 32 : 8);
}
function rgbaForDocument(pixels, doc) {
  var depth = documentComponentSize(doc);
  // putPixels drops alpha when Photoshop converts an 8-bit buffer to 16/32-bit.
  // Supply the document's native depth; 16-bit uses Photoshop's 0..32768 range.
  if (depth === 16) return Uint16Array.from(pixels, function (value) {return Math.round(value * 32768 / 255);});
  if (depth === 32) return Float32Array.from(pixels, function (value, index) {return index % 4 === 3 ? value / 255 : srgbToLinear(value);});
  return pixels;
}
async function putRgbaPixels(doc, layer, pixels, width, height, left, top) {
  var image = await imaging.createImageDataFromBuffer(rgbaForDocument(pixels, doc), {width: width, height: height, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", fullRange: false});
  try {await imaging.putPixels({documentID: doc.id, layerID: layer.id, imageData: image, replace: true, targetBounds: {left: left, top: top}});} finally {image.dispose();}
}

function px(value) {
  if (typeof value === "number") return value;
  if (value && typeof value._value === "number") return value._value;
  if (value && typeof value.value === "number") return value.value;
  var parsed = parseFloat(value);
  return isNaN(parsed) ? 0 : parsed;
}

function rectFromBounds(bounds, clipWidth, clipHeight) {
  if (!bounds) throw new Error("图层没有可读取的像素范围");
  var left = Math.floor(px(bounds.left));
  var top = Math.floor(px(bounds.top));
  var right = Math.ceil(px(bounds.right));
  var bottom = Math.ceil(px(bounds.bottom));
  if (clipWidth !== undefined && clipHeight !== undefined) {
    left = Math.max(0, Math.min(left, Math.floor(clipWidth)));
    top = Math.max(0, Math.min(top, Math.floor(clipHeight)));
    right = Math.max(0, Math.min(right, Math.ceil(clipWidth)));
    bottom = Math.max(0, Math.min(bottom, Math.ceil(clipHeight)));
  }
  if (right <= left || bottom <= top) throw new Error("图层或选区矩形为空");
  return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
}

function rectJson(rect) { return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; }

function flattenLayers(layers, parents, output) {
  if (!layers) return;
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i];
    if (!layer || layer.id === undefined) continue;
    var id = String(layer.id);
    var name = String(layer.name || ("图层 " + id));
    var label = parents ? parents + " / " + name : name;
    output.push({ id: id, name: name, label: label, layer: layer });
    if (layer.layers && layer.layers.length) flattenLayers(layer.layers, label, output);
  }
}

function listDocuments() {
  var list = [];
  try {
    for (var i = 0; i < psApp.documents.length; i++) list.push(psApp.documents[i]);
  } catch (_) {}
  return list;
}

function selectedLayer(layerValue, doc) {
  if (!doc) throw new Error("当前没有打开的 Photoshop 文档");
  var wanted = layerValue === "active" || !layerValue ? model.activeLayerId : String(layerValue);
  if (!wanted) throw new Error("请先在 Photoshop 中选择一个活动图层");
  var all = [];
  flattenLayers(doc.layers, "", all);
  for (var i = 0; i < all.length; i++) if (all[i].id === wanted) return all[i].layer;
  throw new Error("图层已失效，请为该输入重新选择图层");
}

function isLocalMode(mode) { return mode === "layer_crop" || mode === "mask_crop"; }

function readSelectionBounds(doc) {
  try {
    var bounds = doc.selection && doc.selection.bounds;
    if (bounds) return rectFromBounds(bounds, px(doc.width), px(doc.height));
  } catch (_) {}
  try {
    var result = batchPlay([{
      _obj: "get",
      _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }],
      _options: { dialogOptions: "dontDisplay" }
    }], {});
    return result.then(function (rows) {
      var row = rows && rows[0]; var bounds = row && (row.selection || row);
      if (!bounds || bounds.left === undefined) return null;
      return rectFromBounds(bounds, px(doc.width), px(doc.height));
    }).catch(function () { return null; });
  } catch (_) { return Promise.resolve(null); }
}

function padPixels(source, components, sourceWidth, sourceHeight, sourceBounds, targetBounds, gray) {
  var width = targetBounds.width, height = targetBounds.height;
  var outComponents = gray ? 1 : 4;
  var output = new Uint8Array(width * height * outComponents);
  var offsetX = Math.round(px(sourceBounds.left) - targetBounds.left);
  var offsetY = Math.round(px(sourceBounds.top) - targetBounds.top);
  for (var y = 0; y < sourceHeight; y++) {
    var dy = offsetY + y;
    if (dy < 0 || dy >= height) continue;
    for (var x = 0; x < sourceWidth; x++) {
      var dx = offsetX + x;
      if (dx < 0 || dx >= width) continue;
      var sourceOffset = (y * sourceWidth + x) * components;
      var targetOffset = (dy * width + dx) * outComponents;
      if (gray) output[targetOffset] = source[sourceOffset];
      else {
        output[targetOffset] = source[sourceOffset];
        output[targetOffset + 1] = components >= 3 ? source[sourceOffset + 1] : source[sourceOffset];
        output[targetOffset + 2] = components >= 3 ? source[sourceOffset + 2] : source[sourceOffset];
        output[targetOffset + 3] = components === 4 ? source[sourceOffset + 3] : (components === 2 ? source[sourceOffset + 1] : 255);
      }
    }
  }
  return output;
}

async function captureSelection(doc, rect) {
  var result = await imaging.getSelection({ documentID: doc.id, sourceBounds: rectJson(rect) });
  var imageData = result.imageData;
  try {
    var data = gray8(await pixelsFromImageData(imageData), imageData);
    var components = imageData.components || 1;
    return padPixels(data, components, imageData.width, imageData.height, result.sourceBounds || rect, rect, true);
  } finally {
    try { if (imageData && imageData.dispose) imageData.dispose(); } catch (_) {}
  }
}

async function captureLayer(doc, layer, rect, gray) {
  if (!gray) {
    var bounds = rectFromBounds(layer.boundsNoEffects || layer.bounds);
    if (rect.right <= bounds.left || rect.left >= bounds.right || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return new Uint8Array(rect.width * rect.height * 4);
  }
  var result = gray
    ? await imaging.getSelection({ documentID: doc.id, sourceBounds: rectJson(rect) })
    : await imaging.getPixels({
      documentID: doc.id,
      layerID: layer.id,
      sourceBounds: rectJson(rect),
      colorSpace: "RGB",
      colorProfile: "sRGB IEC61966-2.1",
      // Photoshop 27.11 can fail (-32005) when converting 16/32-bit to 8-bit.
      // Read native depth and normalize locally before encoding the preview PNG.
      componentSize: documentComponentSize(doc),
      applyAlpha: false
    });
  var imageData = result.imageData;
  try {
    var raw = await pixelsFromImageData(imageData);
    var data = gray ? gray8(raw, imageData) : rgba8(raw, imageData);
    return padPixels(data, imageData.components || (gray ? 1 : 4), imageData.width, imageData.height, result.sourceBounds || rect, rect, gray);
  } finally {
    try { if (imageData && imageData.dispose) imageData.dispose(); } catch (_) {}
  }
}

function findDocument(id) {
  var documents = listDocuments();
  for (var i = 0; i < documents.length; i++) if (String(documents[i].id) === String(id)) return documents[i];
  return null;
}

function findNamedLayer(doc, name) {
  var layers = [];
  flattenLayers(doc.layers, "", layers);
  for (var i = 0; i < layers.length; i++) if (layers[i].name === name) return layers[i].layer;
  return null;
}
function findLayerById(doc, id) {
  var rows = []; flattenLayers(doc.layers, "", rows);
  return (rows.find(function (row) {return row.id === String(id);}) || {}).layer;
}
function promptLayerName(task) {
  var prompts = task.prompts || {}, ids = Object.keys(prompts);
  var positive = ids.filter(function (id) {return !/(?:negative|neg_prompt)/i.test(id.split(":").slice(1).join(":"));});
  var values = (positive.length ? positive : ids).map(function (id) {return String(prompts[id] || "").trim();}).filter(Boolean);
  return (values.join(" ") || task.output_prefix || task.workflow_name || "成片").replace(/[\u0000\r\n]+/g, " ").trim();
}

function isImageOutput(output) {
  var mime = String(output.mime || output.file_type || "").toLowerCase();
  var path = String(output.name || output.path || "").toLowerCase();
  return mime.indexOf("image/") === 0 || /\.(png|jpe?g|webp|bmp|tif?f|avif)$/.test(path);
}

function taskOutputUrl(taskId, index, suffix, query) {
  return "/api/photoshop/tasks/" + encodeURIComponent(taskId) + "/outputs/" + index + "/" + suffix + (query ? "?" + query : "");
}

async function patchImport(taskId, body) {
  return api("/api/photoshop/tasks/" + encodeURIComponent(taskId) + "/imports", { method: "PATCH", body: body });
}

async function performImport(task, outputIndex, args) {
  args = args || {};
  var context = task.photoshop_context || {};
  var output = (task.outputs || [])[outputIndex];
  if (!output || output.kind !== "file" || !isImageOutput(output)) throw new Error("该产物不是可回贴的图片");
  var manual = !!(args.document_id || args.force_current || args.manual);
  var query = "output_id=" + encodeURIComponent(args.output_id || output.output_id || "");
  var info;
  try {info = await api(taskOutputUrl(task.id, outputIndex, "import-info", query));}
  catch (error) {
    if (!manual) await patchImport(task.id, {output_index: outputIndex, output_id: output.output_id || "", request_id: "auto-" + sessionId + "-" + (output.output_id || outputIndex), status: "failed", session_id: sessionId, error: error.message || String(error)});
    throw error;
  }
  var identity = info.output_id;
  var records = context.output_imports || {};
  var existing = manual ? (context.manual_imports || {})[args.request_id] || {} : records[identity] || (context.imports || [])[outputIndex] || {};
  if (existing.status === "imported") return {status: "imported", already_imported: true, layer_id: existing.layer_id};
  var requestId = manual ? String(args.request_id || "") : existing.request_id || "auto-" + sessionId + "-" + identity;
  if (manual && !/^[\w.:-]{1,180}$/.test(requestId)) throw new Error("手动导入缺少请求 ID");
  var state = {output_index: outputIndex, output_id: identity, request_id: requestId, manual: manual, session_id: sessionId};
  async function setState(status, fields) {return patchImport(task.id, Object.assign({}, state, fields || {}, {status: status}));}
  var targetDoc = null;
  if (manual) {
    if (args.document_id) targetDoc = findDocument(args.document_id);
    else try {targetDoc = psApp.activeDocument;} catch (_) {}
  } else if (context.session_id === sessionId) targetDoc = findDocument(context.document_id);
  if (!targetDoc) {
    await setState("needs_document", {error: "原工程已关闭或 Photoshop 会话已变化，请在成片页选择目标工程。"});
    if (manual) throw new Error("请打开目标 Photoshop 工程");
    return {status: "needs_document"};
  }
  state.document_id = String(targetDoc.id);
  var sourceDoc = info.source_document || {};
  var changed = Number(sourceDoc.width) && Number(sourceDoc.height) && (px(targetDoc.width) !== Number(sourceDoc.width) || px(targetDoc.height) !== Number(sourceDoc.height));
  if (changed && !(manual && args.geometry_confirmed)) {
    await setState("needs_review", {error: "目标画布与提交时的 " + sourceDoc.width + " × " + sourceDoc.height + " 不一致，请在导入面板核对。"});
    return {status: "needs_review"};
  }
  var marker = "RHWP " + task.id + " " + identity + (manual ? " " + requestId : "");
  var priorLayer = existing.write_complete && String(existing.document_id) === String(targetDoc.id) ? findLayerById(targetDoc, existing.layer_id) : null;
  priorLayer = priorLayer || findNamedLayer(targetDoc, marker);
  if (priorLayer) {
    if (priorLayer.name === marker) await psCore.executeAsModal(async function () {priorLayer.name = promptLayerName(task);}, {commandName: "RH Workflow · 恢复成片名称"});
    await setState("imported", {layer_id: String(priorLayer.id), error: ""});
    return {status: "imported", reconciled: true, layer_id: String(priorLayer.id)};
  }
  if (existing.status === "importing") {
    // A fresh claim may belong to another panel. Allow it to finish before
    // treating a missing completion marker as an interrupted import.
    if (Date.now() - Number(existing.updated_at || 0) < 120000) return {status: "busy"};
    await setState("needs_review", {error: "上次回贴已中断，未找到完整结果图层，请核对后手动导入。"});
    return {status: "needs_review"};
  }
  var claimed = await setState("importing", {error: ""});
  if (!claimed.task.import_claimed) return {status: "busy"};
  var layer = null, enteredModal = false;
  var originalDoc = null, originalLayers = [], targetLayers = [];
  try {
    var pixels = await readBinary(taskOutputUrl(task.id, outputIndex, "pixels", query));
    var mask = info.has_mask ? await readBinary(taskOutputUrl(task.id, outputIndex, "selection-mask", query)) : null;
    if (pixels.length !== info.width * info.height * 4 || (mask && mask.length !== info.width * info.height)) throw new Error("成片像素或蒙版数据不完整");
    try {originalDoc = psApp.activeDocument; originalLayers = Array.from(originalDoc.activeLayers);} catch (_) {}
    targetLayers = Array.from(targetDoc.activeLayers);
    await psCore.executeAsModal(async function (executionContext) {
      enteredModal = true;
      var history = executionContext.hostControl && await executionContext.hostControl.suspendHistory({documentID: targetDoc.id, name: "RH Workflow · 导入成片"});
      try {
        psApp.activeDocument = targetDoc;
        var topLayer = targetDoc.layers.length ? targetDoc.layers[0] : null;
        layer = await targetDoc.createLayer({name: "RH Workflow · 正在写入"});
        if (layer.move && topLayer && topLayer.id !== layer.id) await layer.move(topLayer, Photoshop.constants.ElementPlacement.PLACEBEFORE);
        var placement = info.placement;
        var left = placement.mode === "canvas_center" ? Math.round((px(targetDoc.width) - info.width) / 2) : Number(placement.left);
        var top = placement.mode === "canvas_center" ? Math.round((px(targetDoc.height) - info.height) / 2) : Number(placement.top);
        await putRgbaPixels(targetDoc, layer, pixels, info.width, info.height, left, top);
        if (mask) {
          // Start with hide-all, then write only the saved selection rectangle.
          // replace:false keeps every pixel outside that rectangle black.
          targetDoc.activeLayers = [layer];
          var made = await batchPlay([{_obj: "make", new: {_class: "channel"}, at: {_ref: "channel", _enum: "channel", _value: "mask"}, using: {_enum: "userMaskEnabled", _value: "hideAll"}, _options: {dialogOptions: "dontDisplay"}}], {});
          if (made && made[0] && made[0]._obj === "error") throw new Error(made[0].message || "无法创建图层蒙版");
          var gray = await imaging.createImageDataFromBuffer(mask, {width: info.width, height: info.height, components: 1, chunky: true, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2"});
          try {await imaging.putLayerMask({documentID: targetDoc.id, layerID: layer.id, kind: "user", imageData: gray, replace: false, targetBounds: {left: left, top: top}});} finally {gray.dispose();}
        }
        // Journal the completed layer ID before its human-readable name replaces
        // the marker, so an interrupted final acknowledgement never duplicates it.
        layer.name = marker;
        var written = await setState("importing", {layer_id: String(layer.id), write_complete: true, error: ""});
        if (!written.task.import_claimed) throw new Error("无法确认成片图层的写入记录");
        layer.name = promptLayerName(task);
      } catch (error) {
        if (layer) {try {await layer.delete();} catch (_) {}}
        throw error;
      } finally {
        try {if (targetLayers.length) targetDoc.activeLayers = targetLayers;} catch (_) {}
        if (originalDoc && findDocument(originalDoc.id)) {
          psApp.activeDocument = originalDoc;
          try {if (originalLayers.length) originalDoc.activeLayers = originalLayers;} catch (_) {}
        }
        if (history) await executionContext.hostControl.resumeHistory(history);
      }
    }, {commandName: "RH Workflow · 导入成片", timeOut: 10000});
  } catch (error) {
    if (!enteredModal && Number(error.number) === 9) {
      await setState("pending", {error: "Photoshop 正在执行其他操作，等待下次回贴。"});
      return {status: "busy"};
    }
    await setState("failed", {error: error.message || String(error)});
    throw error;
  }
  // A persistence failure leaves the completed layer ID available for recovery.
  await setState("imported", {layer_id: String(layer.id), error: ""});
  return {status: "imported", layer_id: String(layer.id), document_id: String(targetDoc.id)};
}

function documentContext(doc) {
  var path = "";
  try {path = String(doc.path || "");} catch (_) {}
  return doc ? {version: 2, session_id: sessionId, document_id: String(doc.id), document_name: String(doc.title || doc.name || ""), document_path: path, document_width: px(doc.width), document_height: px(doc.height), active_layer_id: doc.activeLayers.length ? String(doc.activeLayers[0].id) : "", inputs: [], imports: [], auto_import: true} : {};
}
async function runtimeInfo() {
  var doc = null;
  try {doc = psApp.activeDocument;} catch (_) {}
  var layers = [];
  if (doc) flattenLayers(doc.layers, "", layers);
  var rect = doc ? await readSelectionBounds(doc) : null;
  return {
    photoshop: String(UXP.host && UXP.host.version || psApp.version || "unknown"), uxp: String(UXP.versions && UXP.versions.uxp || "unknown"),
    pluginId: PLUGIN_ID, sessionId: sessionId,
    document: doc ? {id: String(doc.id), name: String(doc.title || doc.name || ""), width: px(doc.width), height: px(doc.height)} : null,
    documents: listDocuments().map(function (item) {return {id: String(item.id), name: String(item.title || item.name || ""), width: px(item.width), height: px(item.height)};}),
    activeLayerId: doc && doc.activeLayers.length ? String(doc.activeLayers[0].id) : "",
    selection: rect ? {present: true, rect: rectJson(rect)} : {present: false},
    layers: layers.map(function (entry) {return {id: entry.id, name: entry.name, label: entry.label};})
  };
}
function gray8(data, imageData) {
  if (data instanceof Uint8Array) return data;
  var scale = imageData.componentSize === 16 ? 255 / 32768 : 255;
  return Uint8Array.from(data, function (value) {return Math.max(0, Math.min(255, Math.round(value * scale)));});
}
function rgba8(data, imageData) {
  if (imageData.componentSize !== 32) return gray8(data, imageData);
  return Uint8Array.from(data, function (value, index) {
    if (index % imageData.components < 3) value = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(value * 255)));
  });
}
async function selectionSnapshot(doc) {
  if (!await readSelectionBounds(doc)) return null;
  var result = await imaging.getSelection({documentID: doc.id});
  var imageData = result.imageData;
  try {
    var rect = rectFromBounds(result.sourceBounds, px(doc.width), px(doc.height));
    var pixels = padPixels(gray8(await pixelsFromImageData(imageData), imageData), imageData.components || 1, imageData.width, imageData.height, result.sourceBounds, rect, true);
    return {rect: rect, pixels: pixels};
  } finally {imageData.dispose();}
}
var inputSnapshotCache = {revision: "", context: null, entries: {}};
function captureRevision(doc, rect) {
  try {
    var id = doc.activeHistoryState.id;
    if (!Number.isFinite(id)) return "";
    return JSON.stringify([doc.id, id, px(doc.width), px(doc.height), String(doc.bitsPerChannel), String(doc.colorProfileName || ""), Array.from(doc.activeLayers).map(function (layer) {return layer.id;}), rect ? rectJson(rect) : null]);
  } catch (_) {return "";}
}
function snapshotKey(binding, rect) {
  return JSON.stringify([binding.input_id, binding.mode, binding.layer_id || "active", binding.document_id || "", binding.session_id || "", rectJson(rect)]);
}
async function captureInputs(args) {
  var bindings = Array.isArray(args.inputs) ? args.inputs : [];
  var doc = null;
  try {doc = psApp.activeDocument;} catch (_) {}
  if (!doc) throw new Error("请先在 Photoshop 中打开目标工程");
  var payload, revision, usedKeys = {}, reused = {}, reusedAssets = {};
  await psCore.executeAsModal(async function () {
    model.activeLayerId = doc.activeLayers.length ? String(doc.activeLayers[0].id) : "";
    var selectionRect = await readSelectionBounds(doc);
    revision = captureRevision(doc, selectionRect);
    var cachedContext = !args.force_capture && revision && inputSnapshotCache.revision === revision ? inputSnapshotCache.context : null;
    var selection = selectionRect && cachedContext && cachedContext.selection_path ? {rect: selectionRect, path: cachedContext.selection_path} : await selectionSnapshot(doc);
    var inputs = [], cache = {};
    for (var i = 0; i < bindings.length; i++) {
      var binding = bindings[i];
      if (!/^[\w.-]+:[\w.-]+$/.test(String(binding.input_id))) throw new Error("输入节点 ID 无效");
      var mask = binding.mode === "selection_mask" || binding.mode === "mask_crop";
      var auto = binding.mode === "auto";
      if (["auto", "layer_full", "layer_crop", "selection_mask", "mask_crop"].indexOf(binding.mode) < 0) throw new Error("输入模式无效");
      if ((mask || binding.mode === "layer_crop") && !selection) throw new Error("蒙版节点必须有活动图层选区");
      if (mask && !model.activeLayerId) throw new Error("请先选择活动图层并建立选区");
      if (!selection && binding.layer_id && binding.layer_id !== "active" && ((binding.document_id && String(binding.document_id) !== String(doc.id)) || (binding.session_id && binding.session_id !== sessionId))) throw new Error("固定图层属于另一工程或旧会话，请重新选择");
      var cropped = selection && (auto || mask || binding.mode === "layer_crop");
      var layer = mask ? null : selectedLayer(cropped ? "active" : binding.layer_id || "active", doc);
      var full = layer ? rectFromBounds(layer.boundsNoEffects || layer.bounds) : selection.rect;
      var rect = cropped ? selection.rect : full;
      var key = snapshotKey(binding, rect), cached = cachedContext && inputSnapshotCache.entries[key];
      usedKeys[binding.input_id] = key;
      if (cached) {
        inputs.push(Object.assign({}, cached.input)); reused[binding.input_id] = true; reusedAssets[binding.input_id] = cached.asset;
        continue;
      }
      if (mask && selection.path) {
        inputs.push({input_id: binding.input_id, mode: "selection_mask", layer_id: model.activeLayerId, layer_name: "选区蒙版", rect: rectJson(rect), full_bounds: rectJson(full), width: rect.width, height: rect.height, snapshot_path: selection.path});
        reused[binding.input_id] = true;
        continue;
      }
      var cacheKey = mask ? "mask" : String(layer.id) + ":" + [rect.left, rect.top, rect.right, rect.bottom].join(",");
      if (!cache[cacheKey]) cache[cacheKey] = mask ? selection.pixels : await captureLayer(doc, layer, rect, false);
      inputs.push({input_id: binding.input_id, mode: mask ? "selection_mask" : cropped ? "selection_image" : "layer_full", layer_id: layer ? String(layer.id) : model.activeLayerId, layer_name: layer ? String(layer.name || "") : "选区蒙版", rect: rectJson(rect), full_bounds: rectJson(full), width: rect.width, height: rect.height, png: bytesToBase64(_encodePng(cache[cacheKey], rect.width, rect.height, mask ? 1 : 4))});
    }
    var anchor = args.placement_input_id || (inputs.find(function (item) {return item.mode === "layer_full";}) || {}).input_id || "";
    payload = Object.assign(documentContext(doc), {source_revision: revision, placement_input_id: selection ? "" : anchor, selection_rect: selection ? rectJson(selection.rect) : null, selection_path: selection && selection.path || "", selection_png: selection && !selection.path ? bytesToBase64(_encodePng(selection.pixels, selection.rect.width, selection.rect.height, 1)) : "", inputs: inputs});
  }, {commandName: "RH WebView · 捕获输入", timeOut: 10000});
  var saved;
  try {saved = await api("/api/photoshop/captures", {method: "POST", body: payload});}
  catch (error) {
    if (!args.force_capture && (Object.keys(reused).length || payload.selection_path)) {
      inputSnapshotCache = {revision: "", context: null, entries: {}};
      return captureInputs(Object.assign({}, args, {force_capture: true}));
    }
    throw error;
  }
  saved.assets = {};
  for (var id in saved.files) saved.assets[id] = reusedAssets[id] || await api("/api/webview/file-info", {method: "POST", body: {path: saved.files[id]}});
  if (revision) {
    if (inputSnapshotCache.revision !== revision) inputSnapshotCache = {revision: revision, context: null, entries: {}};
    inputSnapshotCache.context = saved.photoshop_context;
    (saved.photoshop_context.inputs || []).forEach(function (input) {inputSnapshotCache.entries[usedKeys[input.input_id]] = {input: input, asset: saved.assets[input.input_id]};});
  }
  saved.reused_inputs = Object.keys(reused);
  return saved;
}
async function chooseFile() {
  var entry = await fs.getFileForOpening({allowMultiple: false});
  if (!entry) return {cancelled: true};
  return api("/api/webview/file-info", {method: "POST", body: {path: entry.nativePath}});
}
async function chooseDirectory() {
  var entry = await fs.getFolder();
  return {path: entry ? entry.nativePath : "", cancelled: !entry};
}
async function importOutput(args) {
  var data = await api("/api/tasks/" + encodeURIComponent(args.task_id));
  var task = data.task || data;
  var index = Number(args.output_index || 0);
  if (args.output_id) index = (task.outputs || []).findIndex(function (item) {return item.output_id === args.output_id;});
  if (index < 0) throw new Error("找不到成片，请刷新列表");
  return performImport(task, index, args);
}
var autoImportBusy = false;
async function receiveCompletedOutputs() {
  if (autoImportBusy) return;
  autoImportBusy = true;
  try {
    var data = await api("/api/state");
    for (var task of data.tasks || []) {
      var context = task.photoshop_context || {};
      if (task.status !== "completed" || context.version !== 2 || context.auto_import !== true) continue;
      for (var i = 0; i < (task.outputs || []).length; i++) {
        var output = task.outputs[i];
        if (output.kind !== "file" || !isImageOutput(output)) continue;
        var record = (context.output_imports || {})[output.output_id] || (context.imports || [])[i] || {};
        if (["imported", "failed", "needs_document", "needs_review"].indexOf(record.status) >= 0) continue;
        // A busy Photoshop modal is retried on the next tick, before any layer exists.
        try {await performImport(task, i, {});} catch (error) {console.warn("RH 回贴：", error.message);}
      }
    }
  } catch (_) {} finally {autoImportBusy = false;}
}
function assertNative(condition, message) {if (!condition) throw new Error(message);}
async function solidPixels(doc, layer, width, height, left, top) {
  var pixels = new Uint8Array(width * height * 4);
  for (var i = 0; i < pixels.length; i += 4) {pixels[i] = 40; pixels[i + 1] = 160; pixels[i + 2] = 140; pixels[i + 3] = 255;}
  await putRgbaPixels(doc, layer, pixels, width, height, left, top);
  return pixels;
}
async function makeSyntheticSelection(doc) {
  var mask = new Uint8Array(64 * 32);
  for (var i = 0; i < mask.length; i++) mask[i] = [0, 80, 180, 255][i % 4];
  // Keep a nonzero pixel on every edge so the true bounds remain 64 x 32.
  mask[0] = 80;
  var image = await imaging.createImageDataFromBuffer(mask, {width: 64, height: 32, components: 1, chunky: true, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2"});
  try {await imaging.putSelection({documentID: doc.id, imageData: image, replace: true, targetBounds: {left: 30, top: 40}});} finally {image.dispose();}
  return mask;
}
async function syntheticTask(capture, width, height) {
  return (await api("/api/webview/self-test-task", {method: "POST", body: {capture_id: capture.capture_id, width: width, height: height}})).task;
}
async function runTransparencySelfTest(args) {
  args = args || {};
  var original = null, scratch = null, cases = [];
  try {original = psApp.activeDocument;} catch (_) {}
  var width = 32, height = 8, rect = {left: 3, top: 2, width: width, height: height};
  var canvasWidth = 40, canvasHeight = 12, info = null;
  var pixels = new Uint8Array(width * height * 4), alpha = [0, 1, 64, 127, 128, 192, 254, 255];
  for (var index = 0; index < width * height; index++) {
    pixels[index * 4] = 40 + (index % 8) * 25;
    pixels[index * 4 + 1] = 160; pixels[index * 4 + 2] = 140; pixels[index * 4 + 3] = alpha[index % 8];
  }
  if (args.task_id) {
    var outputIndex = Number(args.output_index || 0), query = args.output_id ? "output_id=" + encodeURIComponent(args.output_id) : "";
    info = await api(taskOutputUrl(args.task_id, outputIndex, "import-info", query));
    width = info.width; height = info.height;
    canvasWidth = Number(info.source_document.width) || width + 8;
    canvasHeight = Number(info.source_document.height) || height + 8;
    if (width * height > 16000000 || canvasWidth * canvasHeight > 16000000) throw new Error("透明度自检样本超过 1600 万像素");
    rect = {left: info.placement.mode === "canvas_center" ? Math.round((canvasWidth - width) / 2) : Number(info.placement.left), top: info.placement.mode === "canvas_center" ? Math.round((canvasHeight - height) / 2) : Number(info.placement.top), width: width, height: height};
    pixels = await readBinary(taskOutputUrl(args.task_id, outputIndex, "pixels", query));
    assertNative(pixels.length === width * height * 4, "透明度自检像素数据不完整");
  }
  try {
    var depths = [8, 16, 32].indexOf(Number(args.depth)) >= 0 ? [Number(args.depth)] : [8, 16, 32];
    for (var depth of depths) {
      await psCore.executeAsModal(async function () {
        var stage = "创建工程";
        try {
          scratch = await psApp.createDocument({width: canvasWidth, height: canvasHeight, resolution: 72, depth: depth, profile: args.color_profile || "sRGB IEC61966-2.1", name: "RH WebView · " + depth + "位透明度自检"});
          stage = "创建图层";
          var layer = await scratch.createLayer({name: "合成透明渐变"});
          stage = "写入 RGBA";
          await putRgbaPixels(scratch, layer, pixels, width, height, rect.left, rect.top);
          stage = "读取 RGBA";
          var result = await imaging.getPixels({documentID: scratch.id, layerID: layer.id, sourceBounds: {left: rect.left, top: rect.top, right: rect.left + width, bottom: rect.top + height}, componentSize: depth, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", applyAlpha: false});
          try {
            var actual = padPixels(rgba8(await pixelsFromImageData(result.imageData), result.imageData), result.imageData.components, result.imageData.width, result.imageData.height, result.sourceBounds, rect, false);
            stage = "捕获预览 RGBA";
            var captured = await captureLayer(scratch, layer, Object.assign({}, rect, {right: rect.left + width, bottom: rect.top + height}), false);
            var alphaMismatches = 0, rgbMismatches = 0, maxAlphaDifference = 0, maxColorDifference = 0, examples = [];
            var captureAlphaMismatches = 0, captureRgbMismatches = 0;
            for (var point = 0; point < width * height; point++) {
              var offset = point * 4, difference = Math.abs(actual[offset + 3] - pixels[offset + 3]);
              if (Math.abs(captured[offset + 3] - pixels[offset + 3]) > 1) captureAlphaMismatches++;
              maxAlphaDifference = Math.max(maxAlphaDifference, difference);
              if (difference > 1) {alphaMismatches++; if (examples.length < 4) examples.push({point: point, expected: Array.from(pixels.slice(offset, offset + 4)), actual: Array.from(actual.slice(offset, offset + 4))});}
              if (pixels[offset + 3] >= 64) for (var component = 0; component < 3; component++) {
                difference = Math.abs(actual[offset + component] - pixels[offset + component]);
                maxColorDifference = Math.max(maxColorDifference, difference); if (difference > 1) rgbMismatches++;
                if (Math.abs(captured[offset + component] - pixels[offset + component]) > 1) captureRgbMismatches++;
              }
            }
            cases.push({depth: depth, document_bits: String(scratch.bitsPerChannel), color_profile: scratch.colorProfileName, alpha_mismatches: alphaMismatches, rgb_mismatches: rgbMismatches, capture_alpha_mismatches: captureAlphaMismatches, capture_rgb_mismatches: captureRgbMismatches, max_alpha_difference: maxAlphaDifference, max_color_difference: maxColorDifference, samples: width * height, read_components: result.imageData.components, read_has_alpha: result.imageData.hasAlpha, source_bounds: result.sourceBounds, examples: examples});
          } finally {result.imageData.dispose();}
        } catch (error) {
          throw new Error(depth + "位 " + stage + "：" + (error.message || String(error)) + "；已完成：" + JSON.stringify(cases));
        } finally {
          if (scratch) {await scratch.closeWithoutSaving(); scratch = null;}
          if (original && findDocument(original.id)) psApp.activeDocument = original;
        }
      }, {commandName: "RH WebView · " + depth + "位透明度自检", timeOut: 10000});
    }
    return {status: cases.every(function (item) {return !item.alpha_mismatches && !item.rgb_mismatches && !item.capture_alpha_mismatches && !item.capture_rgb_mismatches;}) ? "passed" : "failed", task_id: args.task_id || null, output_id: info ? info.output_id : null, placement: rect, cases: cases, steps: cases.map(function (item) {return item.depth + "位 RGBA 导入/捕获：透明度差异 " + item.alpha_mismatches + "/" + item.capture_alpha_mismatches + "，颜色差异 " + item.rgb_mismatches + "/" + item.capture_rgb_mismatches;})};
  } finally {
    if (scratch) await psCore.executeAsModal(async function () {await scratch.closeWithoutSaving(); if (original && findDocument(original.id)) psApp.activeDocument = original;}, {commandName: "RH WebView · 清理透明度自检"});
  }
}
async function runSelfTest(args) {
  if (args && args.alpha_only === true) return runTransparencySelfTest(args);
  var original = null, scratch = null, tasks = [], steps = [], pixels;
  try {original = psApp.activeDocument;} catch (_) {}
  function layerById(doc, id) {var rows = []; flattenLayers(doc.layers, "", rows); return (rows.find(function (row) {return row.id === String(id);}) || {}).layer;}
  function boundsEqual(layer, expected, label) {
    var rect = rectFromBounds(layer.boundsNoEffects || layer.bounds);
    assertNative(rect.left === expected[0] && rect.top === expected[1] && rect.width === expected[2] && rect.height === expected[3], label + " 位置或尺寸错误：" + JSON.stringify(rect));
  }
  async function simulate(captured, width, height) {var task = await syntheticTask(captured, width, height); tasks.push(task.id); return task;}
  try {
    var source;
    await psCore.executeAsModal(async function () {
      scratch = await psApp.createDocument({width: 300, height: 200, resolution: 72, depth: 8, name: "RH WebView · 图像工作流自检"});
      source = await scratch.createLayer({name: "WebView bridge fixture"});
      pixels = await solidPixels(scratch, source, 33, 19, 13, 17);
      scratch.activeLayers = [source];
    }, {commandName: "RH WebView · 创建自检工程"});
    var layerCapture = await captureInputs({inputs: [{input_id: "1:image", mode: "auto", layer_id: "active"}]});
    var stored = await readBinary("/api/webview/capture-pixels?path=" + encodeURIComponent(layerCapture.files["1:image"]));
    assertNative(stored.length === pixels.length && stored.every(function (value, index) {return Math.abs(value - pixels[index]) <= 1;}), "PNG 捕获像素往返失败");
    steps.push("33x19 图层按自身边界导出、PNG/HTTP RGBA 像素往返");
    var previewAgain = await captureInputs({inputs: [{input_id: "1:image", mode: "auto", layer_id: "active"}]});
    assertNative(previewAgain.files["1:image"] === layerCapture.files["1:image"] && previewAgain.reused_inputs.indexOf("1:image") >= 0, "预览与提交重复保存了图片内容");
    steps.push("预览与提交复用同一图片文件，不重复传入 PNG 内容");
    await psCore.executeAsModal(async function () {source.name = "WebView bridge fixture · 历史变化";}, {commandName: "RH WebView · 校验预览刷新"});
    var refreshed = await captureInputs({inputs: [{input_id: "1:image", mode: "auto", layer_id: "active"}]});
    assertNative(refreshed.files["1:image"] !== layerCapture.files["1:image"] && refreshed.reused_inputs.length === 0, "工程历史改变后仍使用旧预览");
    steps.push("工程历史改变后自动重新捕获，保留提交时快照");
    var centered = await simulate(await captureInputs({inputs: []}), 64, 32);
    var centerResult = await performImport(centered, 0, {});
    assertNative(centerResult.status === "imported", "零输入成片未导入");
    boundsEqual(layerById(scratch, centerResult.layer_id), [118, 84, 64, 32], "零输入原尺寸居中");
    steps.push("零输入原尺寸居中 (118,84) 64x32");
    assertNative(scratch.layers.some(function (layer) {return String(layer.id) === centerResult.layer_id && layer.name === promptLayerName(centered);}) && !scratch.layers.some(function (layer) {return layer.layers;}), "成片未作为提示词命名的顶层图层导入");
    steps.push("直接创建顶层图层，名称使用提示词，不创建组");
    var again = await importOutput({task_id: centered.id, output_index: 0});
    assertNative(again.already_imported && again.layer_id === centerResult.layer_id, "重复通知创建了重复图层");
    steps.push("重复完成通知只创建一份图层");
    var anchored = await simulate(layerCapture, 66, 38);
    var anchorResult = await performImport(anchored, 0, {});
    boundsEqual(layerById(scratch, anchorResult.layer_id), [13, 17, 66, 38], "保持结果尺寸对齐图层");
    steps.push("无选区保持 66x38，定位到输入 (13,17)");
    var selectionMask;
    await psCore.executeAsModal(async function () {scratch.activeLayers = [source]; selectionMask = await makeSyntheticSelection(scratch);}, {commandName: "RH WebView · 创建羽化样本"});
    var selected = await captureInputs({inputs: [{input_id: "1:image", mode: "auto"}, {input_id: "543:image", mode: "selection_mask"}]});
    assertNative(selected.photoshop_context.placement.mode === "selection", "未保存选区 placement");
    var rect = selected.photoshop_context.placement.rect;
    assertNative(rect.left === 30 && rect.top === 40 && rect.right === 94 && rect.bottom === 72, "真实选区矩形错误");
    var zeroSelected = await captureInputs({inputs: []});
    assertNative(zeroSelected.photoshop_context.selection.present && zeroSelected.photoshop_context.selection_path === selected.photoshop_context.selection_path, "零输入未复用选区快照");
    steps.push("活动图层选区图像、LoadImageMask、零输入选区使用同一快照");
    var selectedTask = await simulate(selected, 128, 64);
    await psCore.executeAsModal(async function () {await scratch.selection.deselect();}, {commandName: "RH WebView · 取消当前选区"});
    var selectedResult = await performImport(selectedTask, 0, {});
    var selectedLayer = layerById(scratch, selectedResult.layer_id);
    boundsEqual(selectedLayer, [30, 40, 64, 32], "选区结果拉伸与位置");
    var resultMask;
    await psCore.executeAsModal(async function () {resultMask = await imaging.getLayerMask({documentID: scratch.id, layerID: selectedLayer.id, kind: "user", sourceBounds: {left: 0, top: 0, right: 300, bottom: 200}});}, {commandName: "RH WebView · 校验蒙版像素"});
    try {
      var full = padPixels(gray8(await pixelsFromImageData(resultMask.imageData), resultMask.imageData), 1, resultMask.imageData.width, resultMask.imageData.height, resultMask.sourceBounds, {left: 0, top: 0, width: 300, height: 200}, true);
      for (var y = 0; y < 200; y++) for (var x = 0; x < 300; x++) {
        var expected = x >= 30 && x < 94 && y >= 40 && y < 72 ? selectionMask[(y - 40) * 64 + x - 30] : 0;
        assertNative(Math.abs(full[y * 300 + x] - expected) <= 1, "蒙版像素错误 @ " + x + "," + y + ": " + full[y * 300 + x] + " != " + expected);
      }
    } finally {resultMask.imageData.dispose();}
    steps.push("128x64 拉伸至原 64x32，恢复 0/80/180/255 灰度，矩形外黑色");
    var manualResult = await importOutput({task_id: selectedTask.id, output_index: 0, manual: true, document_id: String(scratch.id), request_id: "self-test-manual-1"});
    var manualAgain = await importOutput({task_id: selectedTask.id, output_index: 0, manual: true, document_id: String(scratch.id), request_id: "self-test-manual-1"});
    var manualNew = await importOutput({task_id: selectedTask.id, output_index: 0, manual: true, document_id: String(scratch.id), request_id: "self-test-manual-2"});
    assertNative(manualAgain.already_imported && manualAgain.layer_id === manualResult.layer_id && manualNew.layer_id !== manualResult.layer_id, "手动导入请求幂等失败");
    steps.push("手动请求幂等，新点击可再次创建图层，自动记录保留");
    var existingGroup;
    await psCore.executeAsModal(async function () {
      existingGroup = await scratch.createLayerGroup({name: "合成已有分组"});
      await source.move(existingGroup, Photoshop.constants.ElementPlacement.PLACEINSIDE);
      scratch.activeLayers = [source];
    }, {commandName: "RH WebView · 创建嵌套图层样本"});
    var fromGroup = await importOutput({task_id: selectedTask.id, output_index: 0, manual: true, document_id: String(scratch.id), request_id: "self-test-manual-group"});
    assertNative(scratch.layers.some(function (layer) {return String(layer.id) === fromGroup.layer_id && layer.name === promptLayerName(selectedTask);}), "活动图层位于组内时，成片未作为顶层图层导入");
    assertNative(scratch.layers.filter(function (layer) {return layer.layers;}).length === 1 && existingGroup.layers.length === 1 && existingGroup.layers[0].id === source.id, "导入修改或新增了分组");
    boundsEqual(layerById(scratch, fromGroup.layer_id), [30, 40, 64, 32], "组内来源导入");
    steps.push("活动图层位于已有组内时，成片仍直接创建顶层图层，原组保持不变");
    var largeMask = new Uint8Array(377 * 611);
    for (var my = 0; my < 611; my++) for (var mx = 0; mx < 377; mx++) largeMask[my * 377 + mx] = [0, 80, 180, 255][(mx + Math.floor(my / 11)) % 4];
    largeMask[0] = 80;
    await psCore.executeAsModal(async function () {
      await scratch.closeWithoutSaving(); scratch = null;
      scratch = await psApp.createDocument({width: 724, height: 1086, resolution: 72, depth: 8, name: "RH WebView · 大尺寸蒙版自检"});
      source = await scratch.createLayer({name: "合成原始图层"});
      await solidPixels(scratch, source, 33, 19, 13, 17); scratch.activeLayers = [source];
      var image = await imaging.createImageDataFromBuffer(largeMask, {width: 377, height: 611, components: 1, chunky: true, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2"});
      try {await imaging.putSelection({documentID: scratch.id, imageData: image, replace: true, targetBounds: {left: 258, top: 223}});} finally {image.dispose();}
    }, {commandName: "RH WebView · 创建大尺寸蒙版样本"});
    var largeCapture = await captureInputs({inputs: []}), largeTask = await simulate(largeCapture, 512, 512);
    await psCore.executeAsModal(async function () {await makeSyntheticSelection(scratch);}, {commandName: "RH WebView · 改变当前选区"});
    var largeResult = await performImport(largeTask, 0, {}), largeLayer = layerById(scratch, largeResult.layer_id);
    boundsEqual(largeLayer, [258, 223, 377, 611], "大尺寸蒙版定位");
    await psCore.executeAsModal(async function () {
      var mask = await imaging.getLayerMask({documentID: scratch.id, layerID: largeLayer.id, kind: "user", sourceBounds: {left: 0, top: 0, right: 724, bottom: 1086}});
      try {
        var full = padPixels(gray8(await pixelsFromImageData(mask.imageData), mask.imageData), mask.imageData.components || 1, mask.imageData.width, mask.imageData.height, mask.sourceBounds, {left: 0, top: 0, width: 724, height: 1086}, true);
        for (var y = 0; y < 1086; y++) for (var x = 0; x < 724; x++) {
          var expected = x >= 258 && x < 635 && y >= 223 && y < 834 ? largeMask[(y - 223) * 377 + x - 258] : 0;
          assertNative(Math.abs(full[y * 724 + x] - expected) <= 1, "大尺寸蒙版像素错误 @ " + x + "," + y);
        }
      } finally {mask.imageData.dispose();}
    }, {commandName: "RH WebView · 校验大尺寸蒙版"});
    steps.push("377x611 灰度蒙版逐像素往返；当前选区改变后仍恢复原坐标，矩形外黑色");
    var transparency = await runTransparencySelfTest();
    assertNative(transparency.status === "passed", "原生透明度自检失败：" + JSON.stringify(transparency.cases));
    return {status: "passed", steps: steps.concat(transparency.steps), transparency: transparency, bytes: pixels.length, width: 300, height: 200, firstPixel: Array.from(pixels.slice(0, 4))};
  } catch (error) {
    throw new Error((error.message || String(error)) + "；已通过：" + steps.join(" / "));
  } finally {
    if (scratch) await psCore.executeAsModal(async function () {await scratch.closeWithoutSaving(); if (original && findDocument(original.id)) psApp.activeDocument = original;}, {commandName: "RH WebView · 清理自检工程"});
    for (var taskId of tasks) {try {await api("/api/webview/self-test-task/" + encodeURIComponent(taskId), {method: "DELETE"});} catch (_) {}}
  }
}
// A manual drag fixture stays open only until its explicit verify/cleanup step.
// Its document and task are created here; callers cannot name a document to close.
var dragFixture = null;
async function cleanupDragFixture() {
  var fixture = dragFixture;
  if (!fixture) return {status: "cleaned"};
  if (fixture.document && findDocument(fixture.document.id)) await psCore.executeAsModal(async function () {
    await fixture.document.closeWithoutSaving();
    if (fixture.original && findDocument(fixture.original.id)) psApp.activeDocument = fixture.original;
  }, {commandName: "RH WebView · 清理拖放工程"});
  if (fixture.task) await api("/api/webview/self-test-task/" + encodeURIComponent(fixture.task.id), {method: "DELETE"});
  dragFixture = null;
  return {status: "cleaned"};
}
async function dragTest(args) {
  var action = args.action;
  if (action === "cleanup") return cleanupDragFixture();
  if (action === "prepare") {
    if (dragFixture) {
      if (dragFixture.task && dragFixture.document && findDocument(dragFixture.document.id)) return {status: "prepared", task_id: dragFixture.task.id, document_id: String(dragFixture.document.id)};
      await cleanupDragFixture();
    }
    var original = null;
    try {original = psApp.activeDocument;} catch (_) {}
    dragFixture = {original: original, document: null, task: null, mask: null};
    try {
      await psCore.executeAsModal(async function () {
        var doc = await psApp.createDocument({width: 300, height: 200, resolution: 72, depth: 8, name: "RH WebView · 拖放验收"});
        dragFixture.document = doc;
        var source = await doc.createLayer({name: "合成原始图层"});
        await solidPixels(doc, source, 33, 19, 13, 17);
        doc.activeLayers = [source];
        dragFixture.mask = await makeSyntheticSelection(doc);
      }, {commandName: "RH WebView · 创建拖放样本"});
      var capture = await captureInputs({inputs: []});
      dragFixture.task = await syntheticTask(capture, 128, 64);
      await psCore.executeAsModal(async function () {await dragFixture.document.selection.deselect();}, {commandName: "RH WebView · 清除当前选区"});
      return {status: "prepared", task_id: dragFixture.task.id, document_id: String(dragFixture.document.id), output_id: dragFixture.task.outputs[0].output_id};
    } catch (error) {try {await cleanupDragFixture();} catch (_) {} throw error;}
  }
  if (action !== "verify" || !dragFixture || !dragFixture.task) throw new Error("请先准备拖放测试样本");
  var data = await api("/api/tasks/" + encodeURIComponent(dragFixture.task.id));
  var task = data.task || data;
  var records = Object.values(task.photoshop_context.manual_imports || {}).filter(function (record) {return record.status === "imported" && record.request_id.indexOf("drag-") === 0 && record.document_id === String(dragFixture.document.id);});
  if (!records.length) throw new Error("尚未检测到拖入测试画布的图层，请拖入合成成片后再校验");
  try {
    for (var record of records) {
      var rows = []; flattenLayers(dragFixture.document.layers, "", rows);
      var layer = (rows.find(function (row) {return row.id === record.layer_id;}) || {}).layer;
      assertNative(layer, "拖放结果图层不存在");
      var rect = rectFromBounds(layer.boundsNoEffects || layer.bounds);
      assertNative(rect.left === 30 && rect.top === 40 && rect.width === 64 && rect.height === 32, "拖放结果位置或尺寸错误");
      var full;
      await psCore.executeAsModal(async function () {
        var mask = await imaging.getLayerMask({documentID: dragFixture.document.id, layerID: layer.id, kind: "user", sourceBounds: {left: 0, top: 0, right: 300, bottom: 200}});
        try {full = padPixels(gray8(await pixelsFromImageData(mask.imageData), mask.imageData), 1, mask.imageData.width, mask.imageData.height, mask.sourceBounds, {left: 0, top: 0, width: 300, height: 200}, true);} finally {mask.imageData.dispose();}
      }, {commandName: "RH WebView · 校验拖放蒙版"});
      for (var y = 0; y < 200; y++) for (var x = 0; x < 300; x++) {
        var expected = x >= 30 && x < 94 && y >= 40 && y < 72 ? dragFixture.mask[(y - 40) * 64 + x - 30] : 0;
        assertNative(Math.abs(full[y * 300 + x] - expected) <= 1, "拖放蒙版像素错误 @ " + x + "," + y);
      }
    }
    return {status: "passed", layers: records.length, position: {left: 30, top: 40, width: 64, height: 32}, mask: "0/80/180/255; outside black", current_selection: "none"};
  } finally {await cleanupDragFixture();}
}
async function inspectImport(args) {
  var data = await api("/api/tasks/" + encodeURIComponent(args.task_id));
  var task = data.task || data;
  var record = (task.photoshop_context.manual_imports || {})[args.request_id];
  if (!record || record.status !== "imported") throw new Error("找不到已完成的手动导入记录");
  var doc = findDocument(record.document_id);
  if (!doc) throw new Error("导入目标工程已关闭");
  var rows = []; flattenLayers(doc.layers, "", rows);
  var layer = (rows.find(function (row) {return row.id === record.layer_id;}) || {}).layer;
  if (!layer) throw new Error("导入的图层已删除");
  var index = (task.outputs || []).findIndex(function (output) {return output.output_id === record.output_id;});
  var query = "output_id=" + encodeURIComponent(record.output_id);
  var info = await api(taskOutputUrl(task.id, index, "import-info", query));
  var bounds = rectFromBounds(layer.boundsNoEffects || layer.bounds);
  var samples = 0, mismatches = 0, maxDifference = 0, maskRead = null, examples = [];
  if (info.has_mask) {
    var expected = await readBinary(taskOutputUrl(task.id, index, "selection-mask", query));
    await psCore.executeAsModal(async function () {
      var width = px(doc.width), height = px(doc.height);
      var mask = await imaging.getLayerMask({documentID: doc.id, layerID: layer.id, kind: "user", sourceBounds: {left: 0, top: 0, right: width, bottom: height}});
      try {
        var data = await pixelsFromImageData(mask.imageData);
        maskRead = {width: mask.imageData.width, height: mask.imageData.height, components: mask.imageData.components, componentSize: mask.imageData.componentSize, sourceBounds: mask.sourceBounds, values: data.constructor.name};
        var full = padPixels(gray8(data, mask.imageData), mask.imageData.components || 1, mask.imageData.width, mask.imageData.height, mask.sourceBounds, {left: 0, top: 0, width: width, height: height}, true);
        var rect = info.placement.rect;
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) {
          var value = x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom ? expected[(y - rect.top) * info.width + x - rect.left] : 0;
          var difference = Math.abs(full[y * width + x] - value);
          if (difference > 1) {mismatches++; if (examples.length < 8) examples.push({x: x, y: y, expected: value, actual: full[y * width + x]});}
          maxDifference = Math.max(maxDifference, difference); samples++;
        }
      } finally {mask.imageData.dispose();}
    }, {commandName: "RH WebView · 只读核对导入蒙版"});
  }
  return {status: mismatches ? "failed" : "passed", task_id: task.id, request_id: args.request_id, document_id: record.document_id, layer_id: record.layer_id,
    bounds: rectJson(bounds), width: bounds.width, height: bounds.height, saved_placement: info.placement,
    has_mask: info.has_mask, mask_samples: samples, mask_mismatches: mismatches, max_gray_difference: maxDifference, mask_read: maskRead, mismatch_examples: examples,
    mask_feather: layer.layerMaskFeather, mask_density: layer.layerMaskDensity};
}
var operations = {runtime: runtimeInfo, captureInputs: captureInputs, chooseFile: chooseFile, chooseDirectory: chooseDirectory, importOutput: importOutput, selfTest: runSelfTest, dragTest: dragTest, inspectImport: inspectImport};
window.addEventListener("message", function (event) {
  var request = event.data;
  // UXP sends the entire content URL as origin, including the path/query.
  var origin = String(event.origin).match(/^(http:\/\/(?:localhost|127\.0\.0\.1):8768)(?:[/?#]|$)/);
  if (event.source !== webview || !origin) return;
  if (!request || request.channel !== CHANNEL || request.type !== "request" || typeof request.id !== "string") return;
  var operation = operations[request.method];
  function reply(data) {webview.postMessage(Object.assign({channel: CHANNEL, type: "response", id: request.id}, data), event.origin);}
  if (!Object.prototype.hasOwnProperty.call(operations, request.method)) return reply({error: "未知宿主方法"});
  var call = function () {return operation(request.args || {});};
  // Serialize modal operations. Runtime reads may bypass a long imaging operation.
  var promise = request.method === "runtime" ? Promise.resolve().then(call) : nativeQueue.then(call);
  if (request.method !== "runtime") nativeQueue = promise.catch(function () {});
  promise.then(function (result) {reply({result: result});}, function (error) {reply({error: String(error && error.message || error)});});
});
async function connect(path) {
  try {
    await api("/api/webview/health");
    document.getElementById("service-fallback").style.display = "none";
    webview.style.display = "flex";
    webview.src = API + (path || "/?workspace=submit");
  } catch (error) {
    webview.style.display = "none";
    document.getElementById("service-fallback").style.display = "block";
    document.getElementById("service-message").textContent = "请启动 localhost:8768 的独立服务。";
  }
}
document.getElementById("retry").addEventListener("click", function () {connect();});
document.getElementById("start-server").addEventListener("click", async function () {
  var folder = await fs.getPluginFolder();
  var entry = await folder.getEntry("start-server.command");
  await UXP.shell.openPath(entry.nativePath);
});
webview.addEventListener("loaderror", function (event) {console.error("RH WebView load error", event.code);});
UXP.entrypoints.setup({
  panels: {rhWorkflowWebviewPanel: {show: function () {if (!webview.src) connect();}}},
  commands: {openWebviewLab: function () {connect("/lab?autorun=1");}, openWebviewDragLab: function () {connect("/lab?drag=1");}}
});
connect();

// The host keeps receiving results while the WebView is on another page.
if (typeof setInterval === "function") setInterval(function () {
  if (autoImportBusy) return;
  nativeQueue = nativeQueue.then(receiveCompletedOutputs).catch(function () {});
}, 4000);
