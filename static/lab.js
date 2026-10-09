(function () {
  "use strict";
  async function run() {
    var button = document.getElementById("runSelfTest"), status = document.getElementById("labStatus"), view = document.getElementById("labResults");
    if (button.disabled) return;
    button.disabled = true; status.textContent = "正在运行…";
    var report = {at: new Date().toISOString(), native: !!window.uxpHost, viewport: {width: innerWidth, height: innerHeight}, userAgent: navigator.userAgent, css: {grid: CSS.supports("display", "grid"), colorMix: CSS.supports("color", "color-mix(in srgb, red 50%, blue)"), clamp: CSS.supports("font-size", "clamp(12px, 2vw, 20px)")}};
    try {
      var runtime = await window.RHHost.runtime();
      report.photoshop = runtime.photoshop; report.uxp = runtime.uxp;
      var params = new URLSearchParams(location.search);
      report.pixelTest = await window.RHHost.call("selfTest", {alpha_only: params.get("alpha") === "1", task_id: params.get("alpha_task"), output_id: params.get("alpha_output"), depth: params.get("alpha_depth"), color_profile: params.get("alpha_profile")}, 120000);
      report.status = report.pixelTest.status;
      status.textContent = report.status === "passed" ? "已通过" : "未通过";
    } catch (error) {report.status = "failed"; report.error = error.message; status.textContent = "未通过";}
    view.textContent = JSON.stringify(report, null, 2);
    await fetch("/api/webview/diagnostics", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(report)});
    button.disabled = false;
  }
  if (!window.RHHost.isPhotoshop()) {
    document.getElementById("runSelfTest").disabled = true;
    document.getElementById("labStatus").textContent = "请在 Photoshop 面板中运行";
    fetch("/api/webview/diagnostics").then(function (response) {return response.json();}).then(function (report) {
      if (report.native) document.getElementById("labResults").textContent = "最近一次 Photoshop 自检记录：\n" + JSON.stringify(report, null, 2);
    }).catch(function () {});
    return;
  }
  document.getElementById("runSelfTest").addEventListener("click", run);
  var query = new URLSearchParams(location.search);
  if (query.get("inspect_task") && query.get("inspect_request")) {
    document.getElementById("runSelfTest").disabled = true;
    window.RHHost.call("inspectImport", {task_id: query.get("inspect_task"), request_id: query.get("inspect_request")}, 120000).then(async function (result) {
      document.getElementById("labStatus").textContent = result.status === "passed" ? "导入核对已通过" : "导入核对未通过";
      document.getElementById("labResults").textContent = JSON.stringify(result, null, 2);
      var report = await (await fetch("/api/webview/diagnostics")).json();
      report.observedDrag = {at: new Date().toISOString(), native: true, viewport: {width: innerWidth, height: innerHeight}, result: result};
      await fetch("/api/webview/diagnostics", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(report)});
    }).catch(async function (error) {
      document.getElementById("labStatus").textContent = error.message;
      var report = await (await fetch("/api/webview/diagnostics")).json();
      report.observedDrag = {at: new Date().toISOString(), native: true, viewport: {width: innerWidth, height: innerHeight}, result: {status: "failed", error: error.message}};
      await fetch("/api/webview/diagnostics", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(report)});
    });
  } else if (query.get("drag") === "1") {
    document.getElementById("runSelfTest").disabled = true;
    document.getElementById("labStatus").textContent = "准备拖放临时工程…";
    window.RHHost.call("dragTest", {action: "prepare"}, 120000).then(function (fixture) {
      location.assign("/outputs?ps_drag_test=" + encodeURIComponent(fixture.task_id));
    }).catch(function (error) {document.getElementById("labStatus").textContent = error.message;});
  } else if (query.get("autorun") === "1") run();
})();
