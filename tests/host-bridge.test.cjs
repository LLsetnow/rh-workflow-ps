const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function bridge(options = {}) {
  const replies = [];
  const listeners = {};
  const webview = { style: {}, addEventListener() {}, postMessage(data, target) { replies.push({data, target}); } };
  const elements = new Map([['workflow-webview', webview]]);
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {style: {}, addEventListener() {}});
    return elements.get(id);
  } };
  const photoshop = options.photoshop || {app: {documents: []}, core: {}, imaging: {}, action: {batchPlay() {}}};
  const uxp = {host: {version: '27.11.0'}, versions: {uxp: '9.4.1'}, storage: {localFileSystem: {}}, entrypoints: {setup() {}}};
  const context = vm.createContext({
    document, window: {addEventListener(type, fn) { listeners[type] = fn; }},
    require(name) {return name === 'photoshop' ? photoshop : uxp;},
    fetch: options.fetch || (async () => ({ok: true, json: async () => ({})})), console,
    Uint8Array, Uint16Array, Float32Array, btoa, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin/host.js'), 'utf8'), context);
  return {webview, replies, context, send(event) {listeners.message(event);}};
}

test('UXP full content URL with path and query receives a correlated native response', async () => {
  const host = bridge();
  const origin = 'http://localhost:8768/lab?autorun=1';
  host.send({source: host.webview, origin, data: {channel: 'rh-ps-webview-v1', type: 'request', id: 'request-1', method: 'runtime'}});
  await new Promise(setImmediate);
  assert.equal(host.replies.length, 1);
  assert.equal(host.replies[0].target, origin);
  assert.equal(host.replies[0].data.id, 'request-1');
  assert.equal(host.replies[0].data.result.photoshop, '27.11.0');
});

test('A busy Photoshop modal releases the automatic claim for retry without creating a layer', async () => {
  const states = [];
  let entered = 0;
  const doc = {id: 71, width: 300, height: 200, activeLayers: [], layers: []};
  const host = bridge({
    photoshop: {app: {documents: [doc], activeDocument: doc}, core: {async executeAsModal() {entered++; throw Object.assign(new Error('host is in a modal state'), {number: 9});}}, imaging: {}, action: {}},
    fetch: async (url, options) => {
      if (url.endsWith('/imports')) {
        states.push(JSON.parse(options.body));
        return {ok: true, json: async () => ({task: {import_claimed: true}})};
      }
      if (url.includes('/import-info')) return {ok: true, json: async () => ({output_id: 'output_test', width: 2, height: 1, placement: {mode: 'canvas_center'}, source_document: {width: 300, height: 200}, has_mask: false})};
      if (url.includes('/pixels')) return {ok: true, arrayBuffer: async () => new Uint8Array(8).buffer};
      return {ok: true, json: async () => ({})};
    }
  });
  const task = {id: 'task_test', photoshop_context: {document_id: '71', session_id: host.context.sessionId}, outputs: [{kind: 'file', output_id: 'output_test', path: 'result.png'}]};
  const result = await host.context.performImport(task, 0, {});
  assert.equal(result.status, 'busy');
  assert.equal(entered, 1);
  assert.deepEqual(states.map(record => record.status), ['importing', 'pending']);
  assert.equal(states[0].request_id, states[1].request_id);
  assert.equal(doc.layers.length, 0);
});

test('A fresh import claim from another panel is left alone while it finishes', async () => {
  let mutations = 0;
  const doc = {id: 71, width: 300, height: 200, activeLayers: [], layers: []};
  const host = bridge({
    photoshop: {app: {documents: [doc], activeDocument: doc}, core: {}, imaging: {}, action: {}},
    fetch: async (url) => {
      if (url.endsWith('/imports')) mutations++;
      return {ok: true, json: async () => url.includes('/import-info') ? {output_id: 'output_test', source_document: {width: 300, height: 200}} : {}};
    }
  });
  const task = {id: 'task_test', photoshop_context: {document_id: '71', session_id: host.context.sessionId, output_imports: {output_test: {status: 'importing', request_id: 'owner', updated_at: Date.now()}}}, outputs: [{kind: 'file', output_id: 'output_test', path: 'result.png'}]};
  assert.equal((await host.context.performImport(task, 0, {})).status, 'busy');
  assert.equal(mutations, 0);
});

test('Foreign sources, deceptive hosts, and unknown methods cannot invoke native operations', async () => {
  const host = bridge();
  const data = {channel: 'rh-ps-webview-v1', type: 'request', id: 'request-2', method: 'runtime'};
  for (const origin of ['http://localhost:8768.attacker.example/lab', 'https://localhost:8768/', 'http://localhost:9876/', 'http://evil.example/']) {
    host.send({source: host.webview, origin, data});
  }
  host.send({source: {}, origin: 'http://localhost:8768/', data});
  await new Promise(setImmediate);
  assert.equal(host.replies.length, 0);
  host.send({source: host.webview, origin: 'http://127.0.0.1:8768/', data: {...data, method: '__proto__'}});
  assert.equal(host.replies.length, 1);
  assert.match(host.replies[0].data.error, /未知宿主方法/);
});

test('Import inspection accepts the task API response and detects mask pixels outside the saved rectangle without editing a layer', async () => {
  const layer = {id: 9, name: 'Existing result', bounds: {left: 1, top: 1, right: 3, bottom: 2}, layerMaskFeather: 0, layerMaskDensity: 100};
  const doc = {id: 71, width: 4, height: 3, layers: [layer], activeLayers: [layer]};
  const actual = new Uint8Array(12); actual[5] = 80; actual[6] = 180;
  let disposed = 0;
  const task = {id: 'task_fixture', outputs: [{output_id: 'output_fixture'}], photoshop_context: {manual_imports: {'drag-fixture': {status: 'imported', output_id: 'output_fixture', document_id: '71', layer_id: '9'}}}};
  const host = bridge({
    photoshop: {app: {documents: [doc], activeDocument: doc}, core: {async executeAsModal(fn) {return fn();}}, imaging: {async getLayerMask() {return {sourceBounds: {left: 0, top: 0, right: 4, bottom: 3}, imageData: {width: 4, height: 3, components: 1, componentSize: 8, async getData() {return actual;}, dispose() {disposed++;}}};}}, action: {}},
    fetch: async (url, options) => {
      assert.equal(options?.method || 'GET', 'GET');
      if (url.includes('/selection-mask')) return {ok: true, arrayBuffer: async () => new Uint8Array([80, 180]).buffer};
      if (url.includes('/import-info')) return {ok: true, json: async () => ({width: 2, height: 1, has_mask: true, placement: {mode: 'selection', rect: {left: 1, top: 1, right: 3, bottom: 2}}})};
      return {ok: true, json: async () => url.endsWith('/api/tasks/task_fixture') ? task : {}};
    },
  });
  const passed = await host.context.inspectImport({task_id: task.id, request_id: 'drag-fixture'});
  assert.equal(passed.status, 'passed');
  assert.equal(passed.mask_samples, 12);
  actual[0] = 255;
  const failed = await host.context.inspectImport({task_id: task.id, request_id: 'drag-fixture'});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.mask_mismatches, 1);
  assert.equal(failed.max_gray_difference, 255);
  assert.equal(disposed, 2);
  assert.equal(layer.name, 'Existing result');
  assert.equal(doc.activeLayers[0], layer);
});

test('Import supplies RGBA at the target document depth, preserving alpha and saved position', async () => {
  const bytes = new Uint8Array([0, 128, 255, 0, 128, 128, 128, 64, 255, 0, 0, 128, 40, 160, 140, 255]);
  for (const bits of ['bitDepth8', 'bitDepth16', 'bitDepth32']) {
    let prepared, write, disposed = 0;
    const originalLayer = {id: 3, name: 'Original'};
    const doc = {id: 71, width: 300, height: 200, bitsPerChannel: bits, layers: [originalLayer], activeLayers: [originalLayer],
      async createLayerGroup() {assert.fail('Import must not create a group');},
      async createLayer({name}) {const layer = {id: 21, name, async move(target, placement) {
        assert.equal(target, originalLayer); assert.equal(placement, 'before'); doc.layers.unshift(this);
      }}; return layer;},
    };
    const records = [];
    const host = bridge({
      photoshop: {app: {documents: [doc], activeDocument: doc}, constants: {ElementPlacement: {PLACEBEFORE: 'before'}},
        core: {async executeAsModal(fn) {return fn({});}}, action: {},
        imaging: {async createImageDataFromBuffer(data, options) {prepared = {data, options}; return {dispose() {disposed++;}};}, async putPixels(options) {write = options;}},
      },
      fetch: async (url, options) => {
        if (url.endsWith('/imports')) {records.push(JSON.parse(options.body)); return {ok: true, json: async () => ({task: {import_claimed: true}})};}
        if (url.includes('/import-info')) return {ok: true, json: async () => ({output_id: 'output_alpha', width: 4, height: 1, has_mask: false, placement: {mode: 'layer', left: 13, top: 17}, source_document: {width: 300, height: 200}})};
        if (url.includes('/pixels')) return {ok: true, arrayBuffer: async () => bytes.buffer};
        return {ok: true, json: async () => ({})};
      },
    });
    const task = {id: 'task_alpha', prompts: {'516:prompt': '保留透明背景，温暖火焰', '517:negative_prompt': '模糊'}, photoshop_context: {document_id: '71', session_id: host.context.sessionId}, outputs: [{kind: 'file', output_id: 'output_alpha', path: 'alpha.png'}]};
    assert.equal((await host.context.performImport(task, 0, {})).status, 'imported');
    assert.equal(prepared.options.components, 4);
    assert.equal(prepared.options.chunky, true);
    assert.equal(prepared.options.fullRange, false);
    assert.equal(prepared.data.length, bytes.length);
    if (bits === 'bitDepth8') assert.deepEqual(prepared.data, bytes);
    if (bits === 'bitDepth16') {
      assert.ok(prepared.data instanceof Uint16Array);
      assert.deepEqual(Array.from(prepared.data.slice(0, 8)), [0, 16448, 32768, 0, 16448, 16448, 16448, 8224]);
      assert.equal(prepared.data[15], 32768);
    }
    if (bits === 'bitDepth32') {
      assert.ok(prepared.data instanceof Float32Array);
      assert.equal(prepared.data[0], 0); assert.equal(prepared.data[2], 1); assert.equal(prepared.data[3], 0);
      assert.ok(Math.abs(prepared.data[1] - 0.2158605) < 1e-7, 'RGB uses linear light');
      assert.ok(Math.abs(prepared.data[7] - 64 / 255) < 1e-7, 'Alpha remains linear coverage');
      assert.equal(prepared.data[15], 1);
    }
    assert.equal(write.documentID, 71); assert.equal(write.layerID, 21);
    assert.equal(write.targetBounds.left, 13); assert.equal(write.targetBounds.top, 17);
    assert.equal(write.replace, true); assert.equal(disposed, 1);
    assert.deepEqual(records.map(record => record.status), ['importing', 'importing', 'imported']);
    assert.equal(records[1].write_complete, true); assert.equal(records[1].layer_id, '21');
    assert.equal(doc.layers[0].name, '保留透明背景，温暖火焰');
    assert.ok(records.every(record => !record.group_id));
    assert.equal(doc.activeLayers[0], originalLayer);
    assert.equal(originalLayer.name, 'Original');
    assert.deepEqual(Array.from(bytes), [0, 128, 255, 0, 128, 128, 128, 64, 255, 0, 0, 128, 40, 160, 140, 255]);
  }
});

test('RGBA native image data is disposed if Photoshop rejects a write', async () => {
  let disposed = 0;
  const host = bridge({photoshop: {app: {documents: []}, core: {}, action: {}, imaging: {
    async createImageDataFromBuffer() {return {dispose() {disposed++;}};},
    async putPixels() {throw new Error('write failed');},
  }}});
  await assert.rejects(host.context.putRgbaPixels({id: 71, bitsPerChannel: 'bitDepth16'}, {id: 9}, new Uint8Array([1, 2, 3, 80]), 1, 1, 0, 0), /write failed/);
  assert.equal(disposed, 1);
});

test('Capture reads the document native depth and normalizes sRGB and alpha before padding RGBA', async () => {
  const fixtures = [
    {bits: 'bitDepth8', size: 8, pixels: new Uint8Array([128, 255, 0, 64, 0, 0, 255, 255])},
    {bits: 'bitDepth16', size: 16, pixels: new Uint16Array([16448, 32768, 0, 8224, 0, 0, 32768, 32768])},
    {bits: 'bitDepth32', size: 32, pixels: new Float32Array([0.2158605, 1, 0, 64 / 255, 0, 0, 1, 1])},
  ];
  for (const fixture of fixtures) {
    let disposed = 0;
    const host = bridge({photoshop: {app: {documents: []}, core: {}, action: {}, imaging: {
      async getPixels(options) {
        assert.equal(options.documentID, 71); assert.equal(options.layerID, 9);
        assert.equal(options.componentSize, fixture.size, 'Do not request Photoshop depth conversion');
        assert.equal(options.applyAlpha, false);
        assert.equal(options.colorProfile, 'sRGB IEC61966-2.1');
        return {sourceBounds: {left: 11, top: 20, right: 13, bottom: 21}, imageData: {
          width: 2, height: 1, components: 4, componentSize: fixture.size,
          async getData() {return fixture.pixels;}, dispose() {disposed++;},
        }};
      },
    }}});
    const layer = {id: 9, bounds: {left: 10, top: 20, right: 13, bottom: 21}};
    const rect = {left: 10, top: 20, right: 13, bottom: 21, width: 3, height: 1};
    const captured = await host.context.captureLayer({id: 71, bitsPerChannel: fixture.bits}, layer, rect, false);
    assert.deepEqual(Array.from(captured), [0, 0, 0, 0, 128, 255, 0, 64, 0, 0, 255, 255]);
    assert.equal(disposed, 1);
  }
});

function captureFixture() {
  const rect = {left: 30, top: 40, right: 32, bottom: 42, width: 2, height: 2};
  const layer = {id: 9, name: 'Ink', bounds: rect};
  const doc = {id: 71, width: 300, height: 200, bitsPerChannel: 'bitDepth16', colorProfileName: 'Display P3',
    activeHistoryState: {id: 100}, layers: [layer], activeLayers: [layer]};
  const stats = {pixelReads: 0, selectionReads: 0, encoded: 0, bodies: [], failReuse: false};
  const host = bridge({
    photoshop: {app: {documents: [doc], activeDocument: doc}, core: {async executeAsModal(fn) {return fn();}}, action: {}, imaging: {}},
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/captures')) {
        stats.bodies.push(body);
        if (stats.failReuse && body.selection_path) {stats.failReuse = false; return {ok: false, json: async () => ({message: 'snapshot removed'})};}
        const root = '/captures/' + stats.bodies.length;
        const inputs = body.inputs.map((input, i) => ({...input, png: undefined, snapshot_path: input.snapshot_path || root + '/input-' + i + '.png'}));
        return {ok: true, json: async () => ({capture_id: root, files: Object.fromEntries(inputs.map(input => [input.input_id, input.snapshot_path])),
          photoshop_context: {...body, selection_png: undefined, selection_path: body.selection_path || root + '/selection.png', inputs}})};
      }
      assert.ok(url.endsWith('/file-info'));
      return {ok: true, json: async () => ({path: body.path, preview_url: '/preview.png'})};
    },
  });
  host.context.readSelectionBounds = async () => rect;
  host.context.selectionSnapshot = async () => {stats.selectionReads++; return {rect, pixels: new Uint8Array([0, 80, 180, 255])};};
  host.context.captureLayer = async () => {stats.pixelReads++; return new Uint8Array(16);};
  host.context._encodePng = () => {stats.encoded++; return new Uint8Array([1, 2, 3]);};
  return {host, doc, stats};
}

test('Preview and submission reuse each node and selection image until Photoshop history changes', async () => {
  const {host, doc, stats} = captureFixture();
  const input = {input_id: '1:image', mode: 'auto', layer_id: 'active'};
  const mask = {input_id: '543:image', mode: 'selection_mask'};
  const preview = await host.context.captureInputs({inputs: [input]});
  const submitted = await host.context.captureInputs({inputs: [input, mask]});
  assert.equal(submitted.files['1:image'], preview.files['1:image']);
  assert.equal(submitted.files['543:image'], preview.photoshop_context.selection_path);
  assert.deepEqual(Array.from(submitted.reused_inputs), ['1:image', '543:image']);
  assert.equal(stats.pixelReads, 1); assert.equal(stats.selectionReads, 1); assert.equal(stats.encoded, 2);
  assert.ok(stats.bodies[0].inputs[0].png);
  assert.ok(stats.bodies[0].selection_png);
  assert.ok(stats.bodies[1].inputs.every(input => !input.png));
  assert.equal(stats.bodies[1].selection_png, '');
  assert.equal(stats.bodies[1].source_revision, stats.bodies[0].source_revision);
  await host.context.captureInputs({inputs: [input, mask]});
  assert.equal(stats.encoded, 2, 'Repeated submissions only send immutable snapshot references');
  doc.activeHistoryState = {id: 101};
  const changed = await host.context.captureInputs({inputs: [input, mask]});
  assert.notEqual(changed.files['1:image'], preview.files['1:image']);
  assert.equal(stats.pixelReads, 2); assert.equal(stats.selectionReads, 2);
  assert.notEqual(stats.bodies.at(-1).source_revision, stats.bodies[0].source_revision);
  assert.deepEqual(Array.from(changed.reused_inputs), []);
});

test('A missing reused snapshot forces one fresh capture and then supports preview reuse again', async () => {
  const {host, stats} = captureFixture();
  const args = {inputs: [{input_id: '1:image', mode: 'auto'}]};
  const first = await host.context.captureInputs(args);
  stats.failReuse = true;
  const fresh = await host.context.captureInputs(args);
  assert.equal(stats.bodies.length, 3);
  assert.equal(stats.pixelReads, 2); assert.equal(stats.selectionReads, 2);
  assert.notEqual(fresh.files['1:image'], first.files['1:image']);
  assert.ok(stats.bodies[2].inputs[0].png);
  assert.equal((await host.context.captureInputs(args)).files['1:image'], fresh.files['1:image']);
  assert.equal(stats.pixelReads, 2);
});

test('An import recovers its completed prompt-named layer after a lost acknowledgement without confusing identical prompts', async () => {
  let created = 0, failAcknowledgement = true;
  const original = {id: 3, name: 'Original'};
  const doc = {id: 71, width: 300, height: 200, layers: [original], activeLayers: [original],
    async createLayerGroup() {assert.fail('Import must not create a group');},
    async createLayer({name}) {
      created++;
      return {id: created + 20, name, async move(target, placement) {
        assert.equal(placement, 'before'); doc.layers.splice(doc.layers.indexOf(target), 0, this);
      }, async delete() {doc.layers.splice(doc.layers.indexOf(this), 1);}};
    },
  };
  const records = {};
  const host = bridge({
    photoshop: {app: {documents: [doc], activeDocument: doc}, constants: {ElementPlacement: {PLACEBEFORE: 'before'}},
      core: {async executeAsModal(fn) {return fn({});}}, action: {},
      imaging: {async createImageDataFromBuffer() {return {dispose() {}};}, async putPixels() {}},
    },
    fetch: async (url, options) => {
      if (url.endsWith('/imports')) {
        const body = JSON.parse(options.body);
        if (body.status === 'imported' && failAcknowledgement) {
          failAcknowledgement = false; return {ok: false, json: async () => ({message: 'lost completion acknowledgement'})};
        }
        records[body.output_id] = {...records[body.output_id], ...body};
        return {ok: true, json: async () => ({task: {import_claimed: true}})};
      }
      if (url.includes('/import-info')) return {ok: true, json: async () => ({output_id: new URL(url).searchParams.get('output_id'), width: 1, height: 1, has_mask: false, placement: {mode: 'canvas_center'}, source_document: {width: 300, height: 200}})};
      if (url.includes('/pixels')) return {ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 255]).buffer};
      assert.fail(url);
    },
  });
  const task = {id: 'task_recovery', prompts: {'516:prompt': '相同提示词'}, photoshop_context: {document_id: '71', session_id: host.context.sessionId, output_imports: records},
    outputs: [{kind: 'file', output_id: 'output_one', path: 'one.png'}, {kind: 'file', output_id: 'output_two', path: 'two.png'}]};
  await assert.rejects(host.context.performImport(task, 0, {}), /lost completion/);
  assert.equal(created, 1);
  assert.equal(doc.layers[0].name, '相同提示词');
  assert.equal(records.output_one.status, 'importing');
  assert.equal(records.output_one.write_complete, true);
  const recovered = await host.context.performImport(task, 0, {});
  assert.equal(recovered.reconciled, true); assert.equal(recovered.layer_id, '21');
  assert.equal(created, 1);
  const second = await host.context.performImport(task, 1, {});
  assert.equal(second.layer_id, '22'); assert.equal(created, 2);
  assert.equal(doc.layers[0].name, doc.layers[1].name);
  assert.equal(doc.layers.length, 3);
  assert.equal((await host.context.performImport(task, 0, {})).already_imported, true);
});
