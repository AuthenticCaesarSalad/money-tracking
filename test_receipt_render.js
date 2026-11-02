const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    innerHTML: "", value: "", textContent: "",
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {},
    querySelector: () => element("state-inner"),
  });
  return elements.get(id);
}

const context = vm.createContext({
  console,
  document: {
    getElementById: element,
    querySelector: () => element("expenseType"),
    querySelectorAll: () => [],
    addEventListener() {}, // Do not boot or make network requests.
  },
  window: { addEventListener() {} },
  fetch() { throw new Error("Unexpected network request"); },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "app.js"), "utf8"), context);
element("expenseType").value = "expense";

const description = '<img src=x onerror="alert(1)"> & "tea" \'cash\' &lt;b&gt;';
const safeDescription = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;tea&quot; &#39;cash&#39; &amp;lt;b&amp;gt;';
const category = '"><img src=x onerror=\'alert(2)\'></select></title><svg onload="alert(3)">';
const safeCategory = '&quot;&gt;&lt;img src=x onerror=&#39;alert(2)&#39;&gt;&lt;/select&gt;&lt;/title&gt;&lt;svg onload=&quot;alert(3)&quot;&gt;';
const plainText = 'Tea & "cake" \'cash\'';
const safePlainText = 'Tea &amp; &quot;cake&quot; &#39;cash&#39;';
const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
const rows = [
  { id: "receipt", type: "expense", amount: 100, category, description, transaction_date: date },
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

// Receipt prefill and editing retain the literal text; save sends it unchanged.
vm.runInContext("applyInvoiceExpense(rows[0]); startEdit('receipt')", context);
assert.equal(element("description").value, description);
assert.equal(element("category").value, category);
let saved;
context.supabaseClient = {
  from: () => ({ update(payload) {
    saved = payload;
    return { eq() { return this; }, select() { return this; },
      single: async () => ({ error: { message: "Stub: skip refresh" } }) };
  } }),
};
context.TABLE_NAME = "transactions";
context.console = { ...console, error() {} };
element("amount").value = "100";
vm.runInContext("addTransaction({ preventDefault() {} })", context).then(() => {
  assert.equal(saved.description, description);
  assert.equal(saved.category, category);
  console.log("Receipt rendering regression checks passed");
}).catch((error) => { console.error(error); process.exitCode = 1; });
