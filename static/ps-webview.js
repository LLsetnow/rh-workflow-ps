/* Photoshop integration. The Desk UI remains in the browser WebView. */
(function () {
  "use strict";
  var channel = "rh-ps-webview-v1", pluginId = "com.llsetnow.rhworkflowpswebview";
  var pending = new Map(), counter = 0, runtime = null, preparing = false, toastTimer;
  var nativeFetch = window.fetch.bind(window);
  function call(method, args, timeout) {
    return new Promise(function (resolve, reject) {
      if (!window.uxpHost || typeof window.uxpHost.postMessage !== "function") return reject(new Error("请在 Photoshop WebView 面板中执行此操作"));
      var id = "rpc-" + Date.now() + "-" + (++counter);
      var timer = setTimeout(function () {pending.delete(id); reject(new Error("Photoshop 操作超时：" + method));}, timeout || 20000);
      pending.set(id, {resolve: resolve, reject: reject, timer: timer});
      try {window.uxpHost.postMessage({channel: channel, type: "request", id: id, method: method, args: args || {}});}
      catch (error) {clearTimeout(timer); pending.delete(id); reject(error);}
    });
  }
  window.addEventListener("message", function (event) {
    if ([pluginId, "uxp://" + pluginId].indexOf(String(event.origin).replace(/\/$/, "")) < 0) return;
    if (event.source && window.uxpHost && event.source !== window.uxpHost) return;
    var message = event.data;
    if (!message || message.channel !== channel || message.type !== "response") return;
    var request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
  });
  async function getRuntime() {runtime = await call("runtime"); updateInputStatus(); return runtime;}
  var host = window.RHHost = {call: call, runtime: getRuntime, isPhotoshop: function () {return !!window.uxpHost;}};
  async function api(path, body, method) {
    var response = await nativeFetch(path, body ? {method: method || "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : undefined);
    var data = await response.json();
    if (!response.ok) throw new Error(data.message || "请求失败");
    return data;
  }
  window.fetch = async function (input, options) {
    var url = typeof input === "string" ? input : input.url;
    var path = new URL(url, location.href).pathname;
    if (host.isPhotoshop() && options && options.method === "POST") {
      var method = path === "/api/pick-file" ? "chooseFile" : ["/api/pick-directory", "/api/pick-media-root", "/api/pick-output-dir"].indexOf(path) >= 0 ? "chooseDirectory" : "";
      if (method) {
        var selected = await call(method);
        return new Response(JSON.stringify(selected.cancelled ? {message: "已取消选择"} : selected), {status: selected.cancelled ? 400 : 200, headers: {"Content-Type": "application/json"}});
      }
    }
    return nativeFetch(input, options);
  };
  function escape(value) {return String(value == null ? "" : value).replace(/[&<>"']/g, function (s) {return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[s];});}
  function notify(message, error) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    if (window.RHMotion && window.RHMotion.showToast) return window.RHMotion.showToast(toast, message, !!error);
    clearTimeout(toastTimer); toast.textContent = message; toast.classList.add("show"); toast.classList.toggle("error", !!error);
    toastTimer = setTimeout(function () {toast.classList.remove("show");}, 4000);
  }
  host.notify = notify;
  function modal(id, markup) {
    var node = document.getElementById(id);
    if (node) return node;
    node = document.createElement("div"); node.id = id; node.className = "modal-backdrop"; node.hidden = true;
    node.innerHTML = markup; document.body.appendChild(node); return node;
  }
  function openModal(id) {window.RHMotion.openModal(id);}
  function closeModal(id) {window.RHMotion.closeModal(id);}
  host.confirm = function (message) {
    var id = "psConfirmModal-" + (++counter);
    var node = modal(id, '<section class="dialog-panel ps-dialog" role="dialog" aria-modal="true" aria-labelledby="' + id + '-title"><div class="dialog-heading"><h2 id="' + id + '-title">确认删除</h2></div><p class="ps-document-label">' + escape(message) + '</p><div class="ps-dialog-actions"><button type="button" class="secondary-button ps-cancel">取消</button><button type="button" class="primary-button ps-confirm">删除</button></div></section>');
    return new Promise(function (resolve) {
      var settled = false;
      function finish(value) {if (settled) return; settled = true; closeModal(id); document.removeEventListener("keydown", onKey); node.remove(); resolve(value);}
      function onKey(event) {if (event.key === "Escape") finish(false);}
      node.querySelector(".ps-cancel").onclick = function () {finish(false);};
      node.querySelector(".ps-confirm").onclick = function () {finish(true);};
      node.onclick = function (event) {if (event.target === node) finish(false);};
      document.addEventListener("keydown", onKey); openModal(id); node.querySelector(".ps-cancel").focus();
    });
  };
  function workflowState() {return window.RHWorkflow && window.RHWorkflow.state;}
  function config() {
    var state = workflowState();
    if (!state || !state.workflow) return {inputs: {}};
    var meta = state.workflow.__rh_meta__ = state.workflow.__rh_meta__ || {};
    var cfg = meta.photoshop_config = meta.photoshop_config || {inputs: {}, placement_input_id: ""};
    cfg.inputs = cfg.inputs || {};
    return cfg;
  }
  function changed() {
    var state = workflowState();
    if (state) state.workflowDirty = true;
    if (window.RHWorkflow) window.RHWorkflow.saveDraftNow();
  }
  function inputNode(inputId) {
    var state = workflowState();
    return state && state.workflow && state.workflow[inputId.split(":")[0]] || {};
  }
  host.connectionTargets = function (workflow, kind) {
    var types = {
      VAEEncode: {pixels: "image"}, VAEEncodeForInpaint: {pixels: "image", mask: "mask"},
      InpaintModelConditioning: {pixels: "image", mask: "mask"}, SetLatentNoiseMask: {mask: "mask"},
      ImageScale: {image: "image"}, ImageScaleBy: {image: "image"}, SaveImage: {images: "image"},
      PreviewImage: {images: "image"}, ImageToMask: {image: "image"},
      ImageCompositeMasked: {destination: "image", source: "image", mask: "mask"}
    }, targets = [];
    Object.keys(workflow || {}).forEach(function (id) {
      var node = workflow[id], fields = types[node.class_type] || {};
      Object.keys(fields).forEach(function (field) {
        var value = (node.inputs || {})[field];
        if (fields[field] === kind && (value == null || value === "")) targets.push({type: "image-slot", nodeIds: [id], field: field, label: id + " · " + ((node._meta || {}).title || node.class_type) + " · " + field});
      });
      if (kind !== "image") return;
      var classType = String(node.class_type || "").toLowerCase(), prefix = "", next = 0, limit = Infinity;
      if (classType.indexOf("textencodeqwenimage21") >= 0) {prefix = "images.image_"; next = 1; limit = 16;}
      else if (classType.indexOf("minimaxh3audioconditioning") >= 0) prefix = "ref_images.ref_image_";
      if (!prefix) return;
      while (Object.prototype.hasOwnProperty.call(node.inputs || {}, prefix + next)) next++;
      if (next <= limit) targets.push({type: "image-slot", nodeIds: [id], field: prefix + next, label: id + " · " + node.class_type + " · " + prefix + next});
    });
    return targets;
  };
  function setting(inputId) {
    var node = inputNode(inputId), cfg = config();
    var mask = node.class_type === "LoadImageMask";
    var item = cfg.inputs[inputId] || {mode: "auto", layer_id: "active"};
    item = Object.assign({}, item, {mode: mask ? "selection_mask" : item.mode === "file" ? "file" : "auto"});
    cfg.inputs[inputId] = item;
    return item;
  }
  function setMode(controls, mode) {
    var id = controls.dataset.psInputId;
    if (inputNode(id).class_type === "LoadImageMask") mode = "selection_mask";
    setting(id).mode = mode;
    var card = controls.closest(".file-input-card");
    card.dataset.psSource = mode;
    var path = card.querySelector(".file-path"), meta = card.querySelector(".file-meta");
    if (path) path.placeholder = "输入本机图片路径";
    if (meta && meta.textContent.indexOf("点击“选择文件”") === 0) meta.textContent = "选择图片后可查看预览，提交时保存本次输入。";
    card.querySelectorAll(".file-dropzone, .input-control-row, .paste-file-button").forEach(function (item) {item.hidden = mode !== "file";});
    // Desk opens its hidden file picker through a styled button.
    card.querySelectorAll(".file-picker").forEach(function (item) {item.hidden = true;});
    controls.querySelector(".ps-layer-field").hidden = mode !== "auto";
    controls.querySelector(".ps-capture").hidden = mode === "file";
    var toggle = controls.querySelector(".ps-use-file");
    if (toggle) {toggle.textContent = mode === "file" ? "使用 Photoshop 图层" : "使用本地图片"; toggle.setAttribute("aria-pressed", mode === "file" ? "true" : "false");}
    updateInputStatus();
  }
  function installInputControls() {
    if (!host.isPhotoshop() || !workflowState()) return;
    document.querySelectorAll('.file-preview[data-expected-preview-kind="image"]').forEach(function (preview) {
      var card = preview.closest(".file-input-card"), id = preview.dataset.previewId;
      if (!card || !id || card.querySelector(".ps-input-controls")) return;
      var mask = inputNode(id).class_type === "LoadImageMask";
      var controls = document.createElement("div"); controls.className = "ps-input-controls"; controls.dataset.psInputId = id;
      controls.innerHTML = '<div class="ps-input-summary" role="status"></div><label class="field-group ps-layer-field"><span class="field-label">Photoshop 图层</span><select class="ps-layer" aria-label="Photoshop 图层"><option value="active">当前活动图层</option></select></label><div class="ps-input-actions"><button class="secondary-button button-compact ps-capture" type="button">捕获预览</button>' + (mask ? '' : '<button class="secondary-button button-compact ps-use-file" type="button">使用本地图片</button>') + '</div><div class="ps-connection-field"></div>';
      var inputControls = card.querySelector(".file-input-controls"), head = card.querySelector(".input-card-head");
      if (inputControls) inputControls.prepend(controls); else if (head) head.after(controls); else card.prepend(controls);
      var item = setting(id); setMode(controls, item.mode);
      controls.querySelector(".ps-layer").addEventListener("change", function () {
        var value = setting(id); value.layer_id = this.value;
        value.document_id = runtime && runtime.document ? runtime.document.id : ""; value.session_id = runtime ? runtime.sessionId : "";
        changed();
      });
      var toggle = controls.querySelector(".ps-use-file");
      if (toggle) toggle.onclick = function () {setMode(controls, setting(id).mode === "file" ? "auto" : "file"); changed();};
      controls.querySelector(".ps-capture").onclick = async function () {
        this.disabled = true;
        try {await capture([bindingFor(controls)], false); notify("已捕获 Photoshop 输入");} catch (error) {notify(error.message, true);} finally {this.disabled = false;}
      };
      installConnection(controls, id);
    });
    installPlacement(); updateInputStatus();
  }
  function installConnection(controls, id) {
    var nodeId = id.split(":")[0], state = workflowState(), connections = [];
    Object.keys(state.workflow).forEach(function (consumerId) {
      var node = state.workflow[consumerId];
      Object.keys(node.inputs || {}).forEach(function (field) {
        var value = node.inputs[field];
        if (Array.isArray(value) && value.length === 2 && String(value[0]) === nodeId) connections.push(consumerId + ":" + field);
      });
    });
    var area = controls.querySelector(".ps-connection-field");
    if (connections.length) {area.textContent = "已连接：" + connections.join("、"); return;}
    var targets = host.connectionTargets ? host.connectionTargets(state.workflow, inputNode(id).class_type === "LoadImageMask" ? "mask" : "image") : [];
    area.innerHTML = '<span class="ps-connection-warning">未连接</span>' + (targets.length ? '<label class="field-group"><span class="field-label">下游连接</span><select class="ps-connect" aria-label="下游连接"><option value="">选择连接位置</option>' + targets.map(function (target, index) {return '<option value="' + index + '">' + escape(target.label || target.nodeIds.join(",") + ":" + target.field) + '</option>';}).join("") + '</select></label>' : '<span>请在工作流 JSON 中连接此节点</span>');
    var select = area.querySelector("select");
    if (select) select.onchange = function () {
      if (this.value === "") return;
      var target = targets[Number(this.value)];
      target.nodeIds.forEach(function (consumerId) {state.workflow[consumerId].inputs[target.field] = [nodeId, 0];});
      changed(); area.textContent = "已连接：" + (target.label || target.nodeIds.join(",") + ":" + target.field);
    };
  }
  function updateInputStatus() {
    if (!runtime) return;
    var selected = runtime.selection && runtime.selection.present;
    document.querySelectorAll(".ps-input-controls").forEach(function (controls) {
      var id = controls.dataset.psInputId, item = setting(id), mask = item.mode === "selection_mask";
      var summary = controls.querySelector(".ps-input-summary");
      var text = item.mode === "file" ? "本地图片 · 提交时保存副本" : mask ? "选区蒙版 · 必须有活动图层选区" : selected ? "选区图像 · 当前活动图层" : "完整图层 · 按图层像素边界";
      if (summary.textContent !== text) summary.textContent = text;
      summary.classList.toggle("is-error", mask && (!selected || !runtime.activeLayerId));
      var select = controls.querySelector(".ps-layer");
      var options = '<option value="active">当前活动图层</option>' + (runtime.layers || []).map(function (layer) {return '<option value="' + escape(layer.id) + '">' + escape(layer.label + " · #" + layer.id) + '</option>';}).join("");
      if (select.dataset.document !== (runtime.document && runtime.document.id || "") || select.dataset.options !== options) {
        select.innerHTML = options; select.dataset.document = runtime.document && runtime.document.id || ""; select.dataset.options = options;
        select.value = item.layer_id || "active";
        if (!select.value) {var stale = document.createElement("option"); stale.value = item.layer_id; stale.textContent = "原图层已失效，请重新选择"; select.add(stale); select.value = item.layer_id;}
      }
      select.disabled = !!selected;
    });
    var placement = document.getElementById("psPlacement");
    if (placement) {
      var inputs = Object.keys(config().inputs).filter(function (id) {return setting(id).mode === "auto" && inputNode(id).class_type;});
      var select = placement.querySelector("select"), options = inputs.map(function (id) {return '<option value="' + escape(id) + '">' + escape((inputNode(id)._meta || {}).title || id) + ' · ' + escape(id) + '</option>';}).join("");
      if (select.dataset.options !== options) {select.innerHTML = options; select.dataset.options = options; select.value = config().placement_input_id || inputs[0] || "";}
      var label = placement.querySelector(".ps-placement-summary");
      var text = selected ? "按提交时的选区位置、尺寸和蒙版导入原工程" : inputs.length ? "保持结果原尺寸，对齐定位图层左上角" : "保持结果原尺寸，居中导入原工程";
      if (label.textContent !== text) label.textContent = text;
      placement.querySelector("label").hidden = !!selected || inputs.length < 2;
    }
  }
  function installPlacement() {
    var inputs = document.getElementById("workflowInputs");
    if (!inputs || document.getElementById("psPlacement")) return;
    var panel = document.createElement("div"); panel.id = "psPlacement"; panel.className = "ps-placement";
    panel.innerHTML = '<span class="field-label">任务完成后自动加入原工程</span><p class="ps-placement-summary"></p><label class="field-group"><span class="field-label">定位图层输入</span><select aria-label="定位图层输入"></select></label>';
    inputs.after(panel);
    panel.querySelector("select").onchange = function () {config().placement_input_id = this.value; changed();};
  }
  function bindingFor(controls) {
    var id = controls.dataset.psInputId;
    return Object.assign({input_id: id}, setting(id));
  }
  async function capture(bindings, submitting) {
    var cfg = config();
    var anchor = cfg.placement_input_id;
    if (!bindings.some(function (item) {return item.input_id === anchor && item.mode === "auto";})) anchor = "";
    var captured = await call("captureInputs", {inputs: bindings, placement_input_id: anchor}, 120000);
    Object.keys(captured.assets || {}).forEach(function (id) {document.dispatchEvent(new CustomEvent("rh:photoshop-input-captured", {detail: {inputId: id, asset: captured.assets[id]}}));});
    if (submitting) window.RHPhotoshopDraftContext = captured.photoshop_context || {};
    return captured;
  }
  host.prepareWorkflowInputs = async function () {
    if (!host.isPhotoshop()) return;
    if (preparing) throw new Error("正在捕获输入，请稍候");
    preparing = true;
    window.RHPhotoshopDraftContext = {};
    try {
      installInputControls();
      var workflow = workflowState().workflow;
      await api("/api/photoshop/validate", {workflow: workflow});
      var bindings = Array.from(document.querySelectorAll(".ps-input-controls")).filter(function (node) {return setting(node.dataset.psInputId).mode !== "file" && !node.closest(".is-bypassed, [data-bypassed='true']");}).map(bindingFor);
      await capture(bindings, true);
    } finally {preparing = false;}
  };
  function outputUrl(item, suffix) {return "/api/photoshop/tasks/" + encodeURIComponent(item.task_id) + "/outputs/" + Number(item.output_index) + "/" + suffix + "?output_id=" + encodeURIComponent(item.output_id || "");}
  host.openOutputImport = async function (item) {
    if (!host.isPhotoshop()) return notify("请在 Photoshop WebView 面板中选择导入工程", true);
    var id = "psOutputImportModal", node = modal(id, '<section class="dialog-panel ps-dialog" role="dialog" aria-modal="true" aria-labelledby="psImportTitle"><div class="dialog-heading"><h2 id="psImportTitle">导入项目</h2><button class="secondary-button button-compact ps-close" type="button">关闭</button></div><p class="ps-import-name"></p><label class="field-group"><span class="field-label">已打开的 Photoshop 工程</span><select class="ps-target-document" aria-label="已打开的 Photoshop 工程"></select></label><p class="ps-import-rule"></p><label class="ps-geometry-confirm" hidden><input type="checkbox"> 已核对画布差异，按成片保存的坐标和蒙版继续导入</label><p class="ps-import-status" role="status"></p><button class="primary-button ps-import-submit" type="button">导入为新图层</button></section>');
    node.querySelector(".ps-close").onclick = function () {closeModal(id);};
    node.onclick = function (event) {if (event.target === node) closeModal(id);};
    node.querySelector(".ps-import-name").textContent = item.name || "图片成片";
    var status = node.querySelector(".ps-import-status"), button = node.querySelector(".ps-import-submit");
    status.textContent = "正在读取工程和成片信息…"; button.disabled = true; openModal(id);
    try {
      var values = await Promise.all([getRuntime(), api(outputUrl(item, "import-info"))]);
      var info = values[0], artifact = values[1], select = node.querySelector("select"), checkbox = node.querySelector('input[type="checkbox"]');
      checkbox.checked = false;
      select.innerHTML = (info.documents || []).map(function (doc) {return '<option value="' + escape(doc.id) + '">' + escape(doc.name) + ' · ' + doc.width + ' × ' + doc.height + '</option>';}).join("");
      select.value = info.document && info.document.id || select.value;
      node.querySelector(".ps-import-rule").textContent = artifact.has_mask ? "恢复成片原位置、矩形尺寸和选区蒙版" : artifact.placement.mode === "layer_anchor" ? "保持成片原尺寸，恢复原图层左上角" : "保持成片原尺寸，在目标画布居中";
      function updateTarget() {
        var doc = (info.documents || []).find(function (value) {return value.id === select.value;});
        var source = artifact.source_document;
        var mismatch = doc && source.width && source.height && (doc.width !== source.width || doc.height !== source.height);
        node.querySelector(".ps-geometry-confirm").hidden = !mismatch;
        status.textContent = !doc ? "请先打开目标工程" : mismatch ? "原画布为 " + source.width + " × " + source.height + "，请核对目标工程" : "只导入当前选中的成片";
        button.disabled = !doc || !!mismatch && !checkbox.checked;
      }
      select.onchange = function () {checkbox.checked = false; updateTarget();}; checkbox.onchange = updateTarget; updateTarget();
      var requestId = "manual-" + Date.now() + "-" + (++counter);
      button.onclick = async function () {
        if (button.disabled) return;
        button.disabled = true; button.setAttribute("aria-busy", "true"); status.textContent = "正在导入…";
        try {
          var result = await call("importOutput", {task_id: item.task_id, output_index: Number(item.output_index), output_id: artifact.output_id, document_id: select.value, request_id: requestId, manual: true, geometry_confirmed: checkbox.checked}, 120000);
          if (result.status === "busy") throw new Error("Photoshop 正在执行其他操作，请稍后再点导入");
          if (result.status !== "imported") throw new Error("导入需要核对工程，请重新选择目标工程");
          closeModal(id); notify("成片已作为新图层导入工程");
        } catch (error) {status.textContent = error.message; button.disabled = false;} finally {button.removeAttribute("aria-busy");}
      };
    } catch (error) {status.textContent = error.message;}
  };
  host.importDraggedOutput = async function (item) {
    var info = await getRuntime();
    if (!info.document) throw new Error("请先打开目标工程");
    var result = await call("importOutput", {task_id: item.task_id, output_index: Number(item.output_index), output_id: item.output_id || "", document_id: info.document.id, manual: true, request_id: "drag-" + Date.now() + "-" + (++counter)}, 120000);
    if (result.status === "needs_review") return host.openOutputImport(item);
    if (result.status === "busy") return host.openOutputImport(item);
    if (result.status !== "imported") throw new Error("成片导入未完成");
    notify("成片已作为新图层导入 " + info.document.name);
  };
  var outputDrag = null;
  document.addEventListener("dragstart", function (event) {
    if (!host.isPhotoshop()) return;
    var card = event.target.closest('.artifact-card[data-ps-draggable="true"]');
    if (!card || !event.dataTransfer) return;
    outputDrag = {item: {task_id: card.dataset.taskId, output_index: Number(card.dataset.psOutputIndex), output_id: card.dataset.psOutputId}, cancelled: false, internal: false};
    // Only an identity token leaves the WebView. Photoshop imports through the
    // bridge so saved coordinates and a real layer mask survive the drag.
    event.dataTransfer.setData("application/x-rh-photoshop-output", JSON.stringify(outputDrag.item));
  });
  document.addEventListener("drop", function () {if (outputDrag) outputDrag.internal = true;}, true);
  document.addEventListener("keydown", function (event) {if (event.key === "Escape" && outputDrag) outputDrag.cancelled = true;}, true);
  document.addEventListener("dragend", function (event) {
    var drag = outputDrag; outputDrag = null;
    if (!drag || drag.cancelled || drag.internal) return;
    // WKWebView can report dropEffect:none for a native Photoshop destination.
    // An external, non-zero drop coordinate distinguishes it from cancellation.
    var outside = event.clientX < 0 || event.clientY < 0 || event.clientX > innerWidth || event.clientY > innerHeight;
    var ended = outside && (event.screenX !== 0 || event.screenY !== 0);
    if (!ended) return;
    host.importDraggedOutput(drag.item).catch(function (error) {notify(error.message, true);});
  });
  async function openPhotoshopDialog() {
    var id = "photoshopModal", node = modal(id, '<section class="dialog-panel ps-dialog" role="dialog" aria-modal="true" aria-labelledby="photoshopTitle"><div class="dialog-heading"><h2 id="photoshopTitle">Photoshop 工作区</h2><button type="button" class="secondary-button button-compact ps-close">关闭</button></div><p class="ps-document-label"></p><label class="field-group"><span class="field-label">图片成片</span><select class="ps-result"></select></label><p class="ps-receive-status" role="status"></p><button class="primary-button ps-open-import" type="button">选择工程并导入</button><div class="ps-dialog-footer"><a class="secondary-button button-compact" href="/lab">开发自检</a><span class="ps-runtime-label"></span></div></section>');
    node.querySelector(".ps-close").onclick = function () {closeModal(id);};
    node.onclick = function (event) {if (event.target === node) closeModal(id);}; openModal(id);
    try {
      var info = await getRuntime(), data = await api("/api/state"), items = [];
      node.querySelector(".ps-document-label").textContent = info.document ? info.document.name + " · " + info.document.width + " × " + info.document.height : "请打开目标工程";
      node.querySelector(".ps-runtime-label").textContent = "PS " + info.photoshop;
      (data.tasks || []).forEach(function (task) {(task.outputs || []).forEach(function (output, index) {
        if (output.kind === "file" && /\.(?:png|jpe?g|webp|tiff?|bmp)$/i.test(output.path || output.name || "")) {
          var record = (task.photoshop_context && task.photoshop_context.output_imports || {})[output.output_id] || (task.photoshop_context && task.photoshop_context.imports || [])[index] || {};
          items.push({task_id: task.id, output_index: index, output_id: output.output_id, name: (task.workflow_name || task.id) + " · " + output.name, record: record});
        }
      });});
      var select = node.querySelector(".ps-result"), status = node.querySelector(".ps-receive-status");
      var labels = {pending: "等待回贴", importing: "正在回贴", imported: "已回贴", failed: "回贴失败", needs_document: "等待目标工程", needs_review: "等待核对"};
      select.innerHTML = items.map(function (item, index) {return '<option value="' + index + '">' + escape(item.name) + '</option>';}).join("") || '<option value="">暂无图片成片</option>';
      select.onchange = function () {var item = items[Number(select.value)]; status.textContent = item ? (labels[item.record.status] || "等待回贴") + (item.record.error ? " · " + item.record.error : "") : "";}; select.onchange();
      var button = node.querySelector(".ps-open-import"); button.disabled = !items.length;
      button.onclick = function () {closeModal(id); host.openOutputImport(items[Number(select.value)]);};
    } catch (error) {node.querySelector(".ps-document-label").textContent = error.message;}
  }
  function installDragVerification() {
    var taskId = new URLSearchParams(location.search).get("ps_drag_test");
    if (!host.isPhotoshop() || !/^task_ps_selftest_[a-f0-9]{12}$/.test(taskId || "")) return;
    var panel = document.createElement("section"); panel.className = "panel ps-drag-lab";
    panel.innerHTML = '<h2>Photoshop 画布拖放验收</h2><p>将下面的合成成片拖到“RH WebView · 拖放验收”画布。当前选区已取消，结果仍须恢复保存的位置和蒙版。</p><div class="ps-lab-actions"><button class="primary-button ps-verify-drag" type="button">校验并关闭临时工程</button><button class="secondary-button ps-cleanup-drag" type="button">取消并清理</button><a class="secondary-button" href="/outputs">返回全部成片</a></div><p class="ps-drag-status" role="status">拖动后点击校验。不会调用生成服务。</p>';
    document.querySelector(".app-shell").prepend(panel);
    var grid = document.getElementById("outputGrid"), status = panel.querySelector(".ps-drag-status");
    function filterCards() {if (grid) grid.querySelectorAll(".artifact-card").forEach(function (card) {card.hidden = card.dataset.taskId !== taskId;});}
    if (grid) {new MutationObserver(filterCards).observe(grid, {childList: true}); filterCards();}
    panel.querySelector(".ps-verify-drag").onclick = async function () {
      this.disabled = true; status.textContent = "读取真实图层和蒙版像素…";
      try {
        var runtime = await getRuntime(), result = await call("dragTest", {action: "verify"}, 120000);
        var report = await api("/api/webview/diagnostics");
        report.canvasDrag = {at: new Date().toISOString(), native: true, photoshop: runtime.photoshop, uxp: runtime.uxp, viewport: {width: innerWidth, height: innerHeight}, result: result};
        await api("/api/webview/diagnostics", report);
        status.textContent = "已通过：原位置 30,40，尺寸 64×32，真实蒙版灰度正确。临时工程已关闭且未保存。";
      } catch (error) {status.textContent = error.message; this.disabled = false;}
    };
    panel.querySelector(".ps-cleanup-drag").onclick = async function () {
      this.disabled = true;
      try {await call("dragTest", {action: "cleanup"}, 120000); location.assign("/outputs");}
      catch (error) {status.textContent = error.message; this.disabled = false;}
    };
  }
  document.addEventListener("DOMContentLoaded", function () {
    var actions = document.querySelector(".topbar-actions");
    if (actions) {var button = document.createElement("button"); button.className = "settings-button ps-host-button"; button.type = "button"; button.textContent = "Photoshop"; button.onclick = openPhotoshopDialog; actions.prepend(button);}
    var mediaTypes = document.getElementById("mediaInputType");
    if (mediaTypes) mediaTypes.innerHTML = '<option value="image">图片 · LoadImage</option><option value="mask">蒙版 · LoadImageMask</option>';
    if (host.isPhotoshop()) {
      var inputs = document.getElementById("workflowInputs");
      if (inputs) {new MutationObserver(installInputControls).observe(inputs, {childList: true, subtree: true}); installInputControls();}
      getRuntime().catch(function () {});
      setInterval(function () {if (!document.hidden && !preparing) getRuntime().catch(function () {});}, 5000);
    }
    installDragVerification();
  });
  document.addEventListener("rh:workflow-rendered", installInputControls);
  window.addEventListener("pagehide", function () {pending.forEach(function (entry) {clearTimeout(entry.timer); entry.reject(new Error("页面已切换"));}); pending.clear();});
})();
