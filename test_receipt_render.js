const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    let value = "";
    let checked = false;
    elements.set(id, {
      innerHTML: "", textContent: "", disabled: false, hidden: false, open: false, style: {},
      attributes: new Map(), listeners: new Map(),
      get value() { return value; },
      set value(next) { value = String(next); },
      get checked() { return checked; },
      set checked(next) {
        checked = next;
        if (next && id.endsWith("Type")) {
          element(id === "expenseType" ? "incomeType" : "expenseType").checked = false;
        }
      },
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, next) { this.attributes.set(name, String(next)); },
      removeAttribute(name) { this.attributes.delete(name); },
      focus() {}, scrollIntoView() {},
      querySelector: () => id === "tableState" ? element("state-inner") : null,
      querySelectorAll: () => [],
      showModal() { this.open = true; },
      close() { this.open = false; },
      play: async () => {},
    });
  }
  return elements.get(id);
}

const controls = ["amount", "category", "transactionDate", "description", "expenseType", "incomeType",
  "submitButton", "resetButton", "openCameraButton", "captureInvoiceButton", "retryCameraButton",
  "closeCameraButton", "invoiceFileInput"].map(element);
element("transactionForm").querySelectorAll = () => controls;
element("cameraStage").hidden = true;
element("expenseType").value = "expense";
element("incomeType").value = "income";
element("expenseType").checked = true;
const requests = [];
const saves = [];
const reads = [];
let dbRows = [];
let saveResult = async () => ({ error: { message: "Stub: save failed" } });
let invoiceResult = () => { throw new Error("Unexpected invoice request"); };
const database = {
  from() {
    const query = {
      filters: [],
      select(projection) { if (projection) reads.push(projection); return this; },
      eq(name, value) { this.filters.push([name, value]); return this; },
      order() { return this; },
      insert(payload) { this.save = { kind: "insert", payload, filters: this.filters }; return this; },
      update(payload) { this.save = { kind: "update", payload, filters: this.filters }; return this; },
      single() { saves.push(this.save); return saveResult(this.save); },
      then(resolve, reject) { return Promise.resolve({ data: dbRows, error: null }).then(resolve, reject); },
    };
    return query;
  },
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function response(result, ok = true) { return { ok, json: async () => result }; }
const event = () => ({ preventDefault() { this.prevented = true; } });
function fire(id, type, data = event()) { return element(id).listeners.get(type)(data); }

const context = vm.createContext({
  console: { ...console, error() {} },
  URL, AbortController, TypeError,
  TABLE_NAME: "transactions",
  SUPABASE_URL: "https://project.supabase.co",
  supabaseClient: database,
  document: {
    getElementById: element,
    querySelector: (selector) => element(selector.includes('value="income"') ||
      (selector.includes(":checked") && element("incomeType").checked) ? "incomeType" : "expenseType"),
    querySelectorAll: () => [element("expenseType"), element("incomeType")],
    addEventListener() {}, // Do not boot or make network requests.
  },
  window: { addEventListener() {} },
  navigator: { mediaDevices: { getUserMedia() { throw new Error("Unexpected camera request"); } } },
  localStorage: { getItem() { throw new Error("Unexpected storage read"); },
    setItem() { throw new Error("Secrets must not be persisted"); } },
  fetch(url, options) {
    assert.equal(url, "/api/invoice", "Tests never call a production endpoint");
    requests.push({ url, options, payload: JSON.parse(options.body) });
    return invoiceResult();
  },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), context);
const run = (code) => vm.runInContext(code, context);
const userId = "11111111-1111-4111-8111-111111111111";
const transactionId = "22222222-2222-4222-8222-222222222222";
const username = 'user <img src=x onerror="alert(4)">';
context.userId = userId;
context.username = username;
run("currentUserId = userId; currentUsername = username; bindEvents()");

const description = '<img src=x onerror="alert(1)"> & "tea" \'cash\' &lt;b&gt;';
const safeDescription = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;tea&quot; &#39;cash&#39; &amp;lt;b&amp;gt;';
const category = '"><img src=x onerror=\'alert(2)\'></select></title><svg onload="alert(3)">';
const safeCategory = '&quot;&gt;&lt;img src=x onerror=&#39;alert(2)&#39;&gt;&lt;/select&gt;&lt;/title&gt;&lt;svg onload=&quot;alert(3)&quot;&gt;';
const plainText = 'Tea & "cake" \'cash\'';
const safePlainText = 'Tea &amp; &quot;cake&quot; &#39;cash&#39;';
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
const rows = [
  { id: transactionId, type: "expense", amount: 100, category, description, transaction_date: date,
    receipt_path: `${userId}/old-receipt.jpg` },
  { id: "plain", type: "expense", amount: 50, category: plainText, description: plainText, transaction_date: date },
  { id: "empty", type: "expense", amount: 25, category: "", description: "", transaction_date: date },
  { id: "null", type: "expense", amount: 25, category: null, description: null, transaction_date: date },
];
const originalRows = JSON.stringify(rows);
context.rows = rows;
vm.runInContext("renderTransactions(rows)", context);

function checkRendering() {
  const table = element("transactionsBody").innerHTML;
  assert.ok(table.includes(`<td class="cell-desc">${safeDescription}</td>`));
  assert.ok(table.includes(`<td class="cell-cat"><span class="tag">${safeCategory}</span></td>`));
  assert.ok(table.includes(`<td class="cell-desc">${safePlainText}</td>`));
  assert.equal((table.match(/<span class="desc-empty">Tidak ada keterangan<\/span>/g) || []).length, 2);
  assert.ok(table.includes('<span class="tag">Lainnya</span>'));
  assert.ok(table.includes('class="btn-edit"') && table.includes('class="btn-delete"'));
  assert.equal((table.match(/data-receipt=/g) || []).length, 1);
  assert.ok(table.includes(`data-receipt="${transactionId}">Lihat Struk</button>`));
  assert.ok(!table.includes(rows[0].receipt_path), "Private storage path must not be rendered");
  assert.ok(table.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
  for (const [raw, safe] of [[category, safeCategory], [plainText, safePlainText]]) {
    assert.ok(element("filterCategory").innerHTML.includes(`<option value="${safe}">${safe}</option>`));
    assert.ok(element("categoryChart").innerHTML.includes(`<title>${safe}: `));
    assert.ok(element("categoryLegend").innerHTML.includes(`<span class="legend-name">${safe}</span>`));
    assert.equal(rows.find((row) => row.category === raw).category, raw);
  }
  for (const id of ["transactionsBody", "filterCategory", "categoryChart", "categoryLegend"]) {
    assert.doesNotMatch(element(id).innerHTML, /<(?:img|script)\b|<svg\s+onload=/i, id);
  }
}
checkRendering();
vm.runInContext("applyVisibility()", context);
checkRendering();
assert.equal(JSON.stringify(rows), originalRows, "Rendering must not mutate saved text");

// Filter raw text, not its HTML encoding, and keep the original option value.
context.rawCategory = category;
vm.runInContext("filterState.category = rawCategory; renderTransactions(rows)", context);
assert.equal(element("filterCategory").value, category);
assert.equal(vm.runInContext("getFilteredRows().length", context), 1);
vm.runInContext("resetFilters(); filterState.search = '&'; applyFilters()", context);
assert.equal(vm.runInContext("getFilteredRows().length", context), 2);

async function checks() {
  // Existing literal text/XSS protection and edit attachment preservation.
  run("applyInvoiceExpense(rows[0]); startEdit(rows[0].id)");
  assert.equal(element("description").value, description);
  assert.equal(element("category").value, category);
  await fire("transactionForm", "submit");
  assert.equal(saves.at(-1).kind, "update");
  assert.equal(saves.at(-1).payload.description, description);
  assert.equal(saves.at(-1).payload.category, category);
  assert.equal(saves.at(-1).payload.receipt_path, rows[0].receipt_path);
  assert.deepEqual(saves.at(-1).filters, [["id", transactionId], ["user_id", userId]]);
  assert.equal(run("receiptPath"), rows[0].receipt_path, "Failed edit save retains attachment");

  // Failed AI extraction never attaches its uploaded photo or changes old fields.
  const oldForm = [element("amount").value, element("description").value];
  invoiceResult = async () => response({ error: "invoice AI failed", saved_path: `${userId}/orphan.jpg` }, false);
  await run("scanInvoice('data:image/jpeg;base64,old')");
  assert.equal(run("receiptPath"), rows[0].receipt_path);
  assert.deepEqual([element("amount").value, element("description").value], oldForm);
  assert.equal(run("editingId"), transactionId);
  assert.match(element("cameraMessage").textContent, /struk AI failed/);
  invoiceResult = async () => response({ saved_path: `${userId}/bad.jpg`, expense: {} });
  await run("scanInvoice('data:image/jpeg;base64,bad')");
  assert.equal(run("receiptPath"), rows[0].receipt_path, "Malformed success must not attach to stale fields");
  assert.deepEqual([element("amount").value, element("description").value], oldForm);

  // Successful scan prepares NEW transaction; locks prevent late form replacement.
  const pendingScan = deferred();
  invoiceResult = () => pendingScan.promise;
  element("retryCameraButton").disabled = true;
  const scanning = run("scanInvoice('data:image/jpeg;base64,new')");
  assert.match(element("cameraMessage").textContent, /edit dibatalkan.*BARU/);
  controls.forEach((control) => assert.equal(control.disabled, true));
  assert.match(element("transactionsBody").innerHTML, /data-edit="[^"]+"[^>]*disabled/);
  const count = saves.length;
  const requestCount = requests.length;
  await fire("transactionForm", "submit");
  await run("captureInvoice(); openInvoiceCamera(); scanInvoice('ignored'); readInvoiceFile({type:'image/jpeg',size:1})");
  run("startEdit('plain'); cancelEdit(); resetForm(); closeInvoiceCamera()");
  const resetWhileScanning = event();
  fire("transactionForm", "reset", resetWhileScanning);
  assert.equal(resetWhileScanning.prevented, true);
  assert.equal(saves.length, count);
  assert.equal(requests.length, requestCount);
  assert.equal(run("editingId"), transactionId);
  assert.equal(run("receiptPath"), rows[0].receipt_path);
  assert.equal(element("cameraStage").hidden, false, "Close is disallowed throughout scan");
  const scannedPath = `${userId}/new-receipt.jpg`;
  pendingScan.resolve(response({ saved_path: scannedPath, expense: {
    type: "expense", amount: 250, category: "Makanan", transaction_date: date, description,
  } }));
  await scanning;
  assert.equal(run("editingId"), null);
  assert.equal(run("receiptPath"), scannedPath);
  assert.equal(element("description").value, description);
  assert.equal(element("retryCameraButton").disabled, true, "Restore previous disabled state");
  assert.equal(element("submitButton").disabled, false);
  element("retryCameraButton").disabled = false;
  assert.deepEqual(requests[requestCount - 1].payload, { image: "data:image/jpeg;base64,new", user_id: userId });

  // Failed insert retains attachment; save lock blocks scan/camera/edit/reset.
  const pendingSave = deferred();
  saveResult = () => pendingSave.promise;
  const saving = fire("transactionForm", "submit");
  assert.equal(saves.at(-1).kind, "insert");
  assert.equal(saves.at(-1).payload.receipt_path, scannedPath);
  const beforeSubmitRequests = requests.length;
  await run("scanInvoice('ignored'); openInvoiceCamera(); captureInvoice()");
  run("readInvoiceFile({type:'image/jpeg',size:1}); startEdit('plain'); resetForm(); cancelEdit()");
  fire("transactionForm", "reset");
  assert.equal(requests.length, beforeSubmitRequests);
  assert.equal(run("receiptPath"), scannedPath);
  assert.equal(run("editingId"), null);
  pendingSave.resolve({ error: { message: "Stub: retry save" } });
  await saving;
  assert.equal(run("receiptPath"), scannedPath);
  saveResult = async ({ payload }) => {
    dbRows = [{ ...payload, id: transactionId }];
    return { data: dbRows[0], error: null };
  };
  await fire("transactionForm", "submit");
  assert.equal(saves.at(-1).payload.receipt_path, scannedPath);
  assert.equal(run("receiptPath"), null, "Successful save clears attachment");
  assert.equal(element("amount").value, "");
  assert.match(element("formMessage").textContent, /berhasil disimpan/);
  assert.ok(reads.at(-1).includes("receipt_path"));
  assert.ok(element("transactionsBody").innerHTML.includes(`data-receipt="${transactionId}"`));
  run("startEdit(allRows[0].id)");
  element("description").value = "Edited receipt & text";
  await fire("transactionForm", "submit");
  assert.equal(saves.at(-1).kind, "update");
  assert.equal(saves.at(-1).payload.receipt_path, scannedPath);
  assert.equal(dbRows[0].receipt_path, scannedPath, "Successful ordinary edit preserves stored receipt");
  assert.equal(run("receiptPath"), null);
  assert.equal(run("editingId"), null);
  assert.match(element("formMessage").textContent, /berhasil diperbarui/);

  // Manual insert has no receipt; both resets and cancel clear synchronously.
  element("amount").value = "100";
  element("category").value = "Makanan";
  await fire("transactionForm", "submit");
  assert.equal(saves.at(-1).payload.receipt_path, null);
  assert.doesNotMatch(element("transactionsBody").innerHTML, /data-receipt=/);
  context.scannedPath = scannedPath;
  run("applyInvoiceExpense(rows[0], scannedPath)");
  const nativeReset = event();
  fire("transactionForm", "reset", nativeReset);
  assert.equal(nativeReset.prevented, true);
  assert.equal(run("receiptPath"), null);
  assert.equal(element("description").value, "");
  run("applyInvoiceExpense(rows[0], scannedPath); resetForm()");
  assert.equal(run("receiptPath"), null);
  run("applyInvoiceExpense(rows[0], scannedPath); cancelEdit()");
  assert.equal(run("receiptPath"), null);
  // There is no setTimeout stub: any deferred native reset would fail this check.
  run("applyInvoiceExpense(rows[0], scannedPath)");
  assert.equal(run("receiptPath"), scannedPath);

  // Decode is part of scan lock, not an unguarded asynchronous prefill.
  let decodedImage;
  context.Image = class { constructor() { decodedImage = this; } };
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  element("cameraCanvas").getContext = () => ({ drawImage() {} });
  element("cameraCanvas").toDataURL = () => "data:image/jpeg;base64,decoded";
  invoiceResult = async () => response({ saved_path: scannedPath, expense: rows[0] });
  const decoding = run("readInvoiceFile({type:'image/jpeg',size:1})");
  assert.equal(run("isScanningInvoice"), true);
  run("resetForm(); startEdit('plain'); closeInvoiceCamera()");
  assert.equal(run("receiptPath"), scannedPath);
  decodedImage.naturalWidth = decodedImage.naturalHeight = 100;
  decodedImage.onload();
  await decoding;
  assert.equal(run("receiptPath"), scannedPath);

  // Closing while camera permission is pending stops late stream acquisition.
  const pendingCamera = deferred();
  let stopped = 0;
  context.navigator.mediaDevices.getUserMedia = () => pendingCamera.promise;
  const opening = run("openInvoiceCamera()");
  run("closeInvoiceCamera(); resetForm()");
  pendingCamera.resolve({ getTracks: () => [{ stop() { stopped++; } }] });
  await opening;
  assert.equal(stopped, 1);
  assert.equal(element("cameraVideo").srcObject, null);
  assert.equal(element("cameraStage").hidden, true);
  assert.equal(run("receiptPath"), null);

  // View is a transaction lookup with confirmation, not a path/user-ID request.
  run("renderTransactions(rows)");
  const viewButton = { disabled: false, dataset: { receipt: transactionId } };
  fire("transactionsBody", "click", { target: { closest: (selector) => selector === "button[data-receipt]" ? viewButton : null } });
  assert.equal(element("receiptDialog").open, true);
  assert.equal(element("receiptUsername").value, username);
  const pendingView = deferred();
  invoiceResult = () => pendingView.promise;
  const password = ' secret <>&" ';
  element("receiptPassword").value = password;
  const viewing = fire("receiptViewForm", "submit");
  assert.equal(element("receiptPassword").value, "", "Password cleared before awaiting network");
  assert.equal(element("receiptViewButton").disabled, true);
  const viewRequest = requests.at(-1);
  assert.deepEqual(viewRequest.payload, { action: "view_receipt", transaction_id: transactionId, username, password });
  assert.equal(viewRequest.options.cache, "no-store");
  const viewCount = requests.length;
  await fire("receiptViewForm", "submit");
  assert.equal(requests.length, viewCount, "No duplicate lookup while busy");
  const signedUrl = "https://project.supabase.co/storage/v1/object/sign/invoices/private.jpg?token=test";
  pendingView.resolve(response({ signed_url: signedUrl, expires_in: 60 }));
  await viewing;
  assert.equal(element("receiptLink").attributes.get("href"), signedUrl);
  assert.equal(element("receiptLink").hidden, false);
  assert.equal(element("receiptPassword").value, "");
  assert.match(element("receiptViewStatus").textContent, /60 detik/);
  element("receiptPassword").value = "cancel me";
  fire("receiptCancelButton", "click");
  assert.equal(element("receiptPassword").value, "");
  assert.equal(element("receiptLink").attributes.has("href"), false);
  assert.equal(element("receiptLink").hidden, true);
  assert.equal(element("receiptDialog").open, false);

  for (const invalidUrl of ["javascript:alert(1)", "/relative", "not a URL", "http://project.supabase.co/x",
    "https://evil.example/x", "https://project.supabase.co.evil.example/x", "https://user:pass@project.supabase.co/x", null]) {
    run("openReceiptDialog(rows[0].id)");
    element("receiptPassword").value = "confirm";
    invoiceResult = async () => response({ signed_url: invalidUrl, expires_in: 60 });
    await fire("receiptViewForm", "submit");
    assert.equal(element("receiptLink").attributes.has("href"), false, String(invalidUrl));
    assert.equal(element("receiptViewButton").disabled, false);
    assert.equal(element("receiptPassword").value, "");
    assert.ok(element("receiptViewStatus").textContent);
  }
  invoiceResult = async () => response({ error: '<img onerror="alert(5)"> kata sandi salah' }, false);
  element("receiptPassword").value = "wrong";
  await fire("receiptViewForm", "submit");
  assert.equal(element("receiptViewStatus").innerHTML, "");
  assert.match(element("receiptViewStatus").textContent, /kata sandi salah/);
  assert.equal(element("receiptPassword").value, "");

  // Cancellation/reopen ignores the old response and queued close event.
  const staleView = deferred();
  invoiceResult = () => staleView.promise;
  element("receiptPassword").value = "first";
  const firstView = fire("receiptViewForm", "submit");
  const staleSignal = requests.at(-1).options.signal;
  fire("receiptDialog", "cancel");
  assert.equal(staleSignal.aborted, true);
  context.otherRows = [...rows, { ...rows[0], id: "33333333-3333-4333-8333-333333333333" }];
  run("renderTransactions(otherRows); openReceiptDialog(otherRows[4].id)");
  fire("receiptDialog", "close"); // Browser may queue old close after showModal.
  assert.equal(run("receiptTransactionId"), context.otherRows[4].id);
  const currentView = deferred();
  invoiceResult = () => currentView.promise;
  element("receiptPassword").value = "second";
  const secondView = fire("receiptViewForm", "submit");
  const currentStatus = element("receiptViewStatus").textContent;
  assert.equal(requests.at(-1).payload.transaction_id, context.otherRows[4].id);
  staleView.resolve(response({ signed_url: signedUrl, expires_in: 60 }));
  await firstView;
  assert.equal(element("receiptLink").attributes.has("href"), false);
  assert.equal(element("receiptViewStatus").textContent, currentStatus);
  assert.equal(element("receiptViewButton").disabled, true, "Old finally must not unlock newer request");
  currentView.resolve(response({ signed_url: signedUrl + "-second", expires_in: 60 }));
  await secondView;
  assert.equal(element("receiptLink").attributes.get("href"), signedUrl + "-second");
  run("closeReceiptDialog()");

  // Fatal/unready conditions remain disabled instead of finally re-enabling.
  run("resetForm()");
  const fatalScan = deferred();
  invoiceResult = () => fatalScan.promise;
  const fatalScanning = run("scanInvoice('data:image/jpeg;base64,fatal')");
  run("showFatalError('Stub fatal', 'Unavailable')");
  fatalScan.resolve(response({ error: "failed" }, false));
  await fatalScanning;
  assert.equal(element("submitButton").disabled, true);
  const fatalCount = requests.length;
  await run("scanInvoice('ignored'); openInvoiceCamera()");
  assert.equal(requests.length, fatalCount);
  run("formUnavailable = false; supabaseClient = null");
  await run("scanInvoice('ignored'); openInvoiceCamera()");
  await fire("transactionForm", "submit");
  assert.equal(requests.length, fatalCount);

  // Static HTML supplies native accessibility and safe, explicit navigation.
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.match(html, /<dialog[^>]*aria-labelledby="receiptDialogTitle"[^>]*aria-describedby="receiptDialogNote"/);
  assert.match(html, /id="receiptPassword"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="receiptLink"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*referrerpolicy="no-referrer"/);
  assert.match(html, /style\.css\?v=13/);
  assert.match(html, /app\.js\?v=14/);
  assert.match(html, /auth\.js\?v=11/);
  console.log("Receipt rendering and attachment regression checks passed");
}
checks().catch((error) => { console.error(error); process.exitCode = 1; });
