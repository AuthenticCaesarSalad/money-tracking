/* =========================================================
   Pencatatan Keuangan Pribadi
   Backend: Supabase (@supabase/supabase-js via CDN)
   ========================================================= */

/*
 * KONFIGURASI SUPABASE
 * Ganti kedua nilai di bawah dengan kredensial proyek Anda.
 * Project Settings > API di dashboard Supabase.
 */
const SUPABASE_URL = "https://xnuyjoszpmquxuileuqm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhudXlqb3N6cG1xdXh1aWxldXFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDY4MjQsImV4cCI6MjEwNzA4MjgyNH0.CZohTfsvhqVlkol1_RZvpQPh8onbMAIGflXeTeN3zMg";

/* Nama tabel di database Supabase */
const TABLE_NAME = "transactions";

/* Opsi kategori per jenis transaksi */
const CATEGORIES = {
  income: ["Gaji", "Lainnya"],
  expense: ["Makanan", "Transportasi", "Tagihan", "Lainnya"],
};

/* Format mata uang Rupiah */
const rupiahFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/* Format tanggal (d-m-Y) */
const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const monthFormatter = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
});

/* =========================================================
   Inisialisasi client Supabase
   ========================================================= */
let supabase = null;

function initSupabase() {
  if (!window.supabase || !window.supabase.createClient) {
    showFatalError(
      "Klien Supabase gagal dimuat",
      "Periksa koneksi internet Anda lalu muat ulang halaman ini."
    );
    return false;
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_URL.startsWith("https://xnuyjoszpmquxuileuqm.supabase.co") ||
    SUPABASE_ANON_KEY.startsWith("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhudXlqb3N6cG1xdXh1aWxldXFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MDY4MjQsImV4cCI6MjEwNzA4MjgyNH0.CZohTfsvhqVlkol1_RZvpQPh8onbMAIGflXeTeN3zMg")
  ) {
    showFatalError(
      "Kredensial Supabase belum dikonfigurasi",
      "Isi SUPABASE_URL dan SUPABASE_ANON_KEY pada bagian atas file app.js."
    );
    return false;
  }

  try {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return true;
  } catch (error) {
    showFatalError("Gagal menginisialisasi Supabase", error.message);
    return false;
  }
}

/* =========================================================
   Referensi DOM
   ========================================================= */
const el = {
  form: document.getElementById("transactionForm"),
  amount: document.getElementById("amount"),
  category: document.getElementById("category"),
  transactionDate: document.getElementById("transactionDate"),
  description: document.getElementById("description"),
  typeInputs: document.querySelectorAll('input[name="type"]'),
  submitButton: document.getElementById("submitButton"),
  resetButton: document.getElementById("resetButton"),
  formMessage: document.getElementById("formMessage"),

  totalBalance: document.getElementById("totalBalance"),
  totalIncome: document.getElementById("totalIncome"),
  totalExpense: document.getElementById("totalExpense"),

  tableBody: document.getElementById("transactionsBody"),
  tableState: document.getElementById("tableState"),
  stateTitle: document.getElementById("stateTitle"),
  stateSub: document.getElementById("stateSub"),
  tableCount: document.getElementById("tableCount"),
  tableWrap: document.querySelector(".table-wrap"),
  periodLabel: document.getElementById("periodLabel"),
};

/* State lokal untuk flag proses */
let isSubmitting = false;
let deletingIds = new Set();

/* =========================================================
   Util
   ========================================================= */
function formatRupiah(value) {
  const number = Number(value) || 0;
  return rupiahFormatter.format(number);
}

function formatAmount(value, type) {
  const sign = type === "income" ? "+" : "-";
  return `${sign} ${formatRupiah(value)}`;
}

function formatDateString(dateStr) {
  if (!dateStr) return "-";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return dateFormatter.format(date);
}

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function currentMonthLabel() {
  return monthFormatter.format(new Date());
}

/* =========================================================
   Kategori dinamis
   ========================================================= */
function syncCategoryOptions() {
  const checked = document.querySelector('input[name="type"]:checked');
  const selectedType = checked ? checked.value : "expense";
  const previous = el.category.value;
  const options = CATEGORIES[selectedType] || CATEGORIES.expense;

  el.category.innerHTML =
    '<option value="">Pilih kategori</option>' +
    options.map((c) => `<option value="${c}">${c}</option>`).join("");

  if (options.includes(previous)) {
    el.category.value = previous;
  }
}

/* =========================================================
   Pesan form
   ========================================================= */
function setFormMessage(text, kind) {
  el.formMessage.textContent = text;
  el.formMessage.classList.remove("error", "success");
  if (kind) el.formMessage.classList.add(kind);
}

/* Deteksi error yang disebabkan oleh Row Level Security / hak akses */
function isPermissionError(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return (
    text.includes("42501") ||
    text.includes("permission") ||
    text.includes("row-level security") ||
    text.includes("rls")
  );
}

function permissionHint() {
  return "Akses ditolak oleh database. Jalankan ulang file sql/schema.sql di Supabase SQL Editor untuk membuat kebijakan Row Level Security bagi peran anon.";
}

/* =========================================================
   State tabel (empty / error)
   ========================================================= */
function showTableState(title, sub, isError) {
  el.stateTitle.textContent = title;
  el.stateSub.textContent = sub;
  el.tableState.hidden = false;
  el.tableState.querySelector(".state-inner").classList.toggle("is-error", Boolean(isError));
  el.tableBody.innerHTML = "";
}

function hideTableState() {
  el.tableState.hidden = true;
  el.tableState.querySelector(".state-inner").classList.remove("is-error");
}

/* =========================================================
   Skeleton saat memuat data
   ========================================================= */
function renderSkeleton() {
  hideTableState();
  const columns = 6;
  let html = "";
  for (let i = 0; i < 4; i++) {
    html += `<tr class="skeleton-row" aria-hidden="true">${"<td><span class='skeleton-bar'></span></td>".repeat(
      columns
    )}</tr>`;
  }
  el.tableBody.innerHTML = html;
  el.tableCount.textContent = "Memuat data...";
}

/* =========================================================
   Update summary (3 panel metrik)
   ========================================================= */
function updateSummary(transactions) {
  let totalIncome = 0;
  let totalExpense = 0;

  for (const t of transactions) {
    if (t.type === "income") totalIncome += Number(t.amount) || 0;
    else if (t.type === "expense") totalExpense += Number(t.amount) || 0;
  }

  const balance = totalIncome - totalExpense;

  el.totalIncome.textContent = formatRupiah(totalIncome);
  el.totalExpense.textContent = formatRupiah(totalExpense);
  el.totalBalance.textContent = formatRupiah(balance);
  el.totalBalance.classList.toggle("is-negative", balance < 0);

  el.periodLabel.textContent = currentMonthLabel();
}

/* =========================================================
   READ - ambil semua transaksi
   ========================================================= */
async function fetchTransactions() {
  renderSkeleton();

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select("id, type, amount, category, description, transaction_date, created_at")
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Gagal mengambil transaksi:", error);
    const message = isPermissionError(error)
      ? `${error.message || "Akses ditolak."} — ${permissionHint()}`
      : error.message || "Terjadi kesalahan saat menghubungi database.";
    showTableState("Gagal memuat data", message, true);
    el.tableCount.textContent = "0 catatan";
    updateSummary([]);
    return;
  }

  renderTransactions(data || []);
}

/* =========================================================
   Render baris tabel
   ========================================================= */
function renderTransactions(transactions) {
  if (!transactions.length) {
    showTableState(
      "Belum ada transaksi",
      "Tambahkan transaksi pertama Anda menggunakan form di samping.",
      false
    );
    el.tableCount.textContent = "0 catatan";
    updateSummary([]);
    return;
  }

  hideTableState();

  const ICON_INCOME = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  const ICON_EXPENSE = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>`;

  const rows = transactions.map((t) => {
    const type = t.type === "income" ? "income" : "expense";
    const typeLabel = type === "income" ? "Pemasukan" : "Pengeluaran";
    const description = t.description
      ? String(t.description)
      : '<span class="desc-empty">Tidak ada keterangan</span>';

    return `<tr data-id="${t.id}">
      <td class="cell-date">${formatDateString(t.transaction_date)}</td>
      <td class="cell-desc">${description}</td>
      <td class="cell-cat"><span class="tag">${t.category || "Lainnya"}</span></td>
      <td class="cell-type">
        <span class="type-badge ${type}">
          ${type === "income" ? ICON_INCOME : ICON_EXPENSE}
          ${typeLabel}
        </span>
      </td>
      <td class="cell-amount ${type}">${formatAmount(t.amount, type)}</td>
      <td class="cell-action">
        <button
          type="button"
          class="btn-delete"
          data-delete="${t.id}"
          title="Hapus transaksi"
          aria-label="Hapus transaksi tanggal ${formatDateString(t.transaction_date)}"
          ${deletingIds.has(t.id) ? "disabled" : ""}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5"/>
          </svg>
        </button>
      </td>
    </tr>`;
  });

  el.tableBody.innerHTML = rows.join("");
  el.tableCount.textContent = `${transactions.length} catatan`;
  updateSummary(transactions);
}

/* =========================================================
   CREATE - tambah transaksi
   ========================================================= */
async function addTransaction(event) {
  event.preventDefault();

  if (isSubmitting) return;

  const type = document.querySelector('input[name="type"]:checked').value;
  const amountRaw = el.amount.value.trim();
  const amount = Number(amountRaw);
  const category = el.category.value;
  const transactionDate = el.transactionDate.value;
  const description = el.description.value.trim();

  /* Validasi sederhana */
  el.amount.removeAttribute("aria-invalid");
  el.category.removeAttribute("aria-invalid");
  el.transactionDate.removeAttribute("aria-invalid");

  if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
    el.amount.setAttribute("aria-invalid", "true");
    setFormMessage("Nominal harus berupa angka lebih besar dari 0.", "error");
    el.amount.focus();
    return;
  }

  if (!category) {
    el.category.setAttribute("aria-invalid", "true");
    setFormMessage("Pilih kategori terlebih dahulu.", "error");
    el.category.focus();
    return;
  }

  if (!transactionDate) {
    el.transactionDate.setAttribute("aria-invalid", "true");
    setFormMessage("Tanggal transaksi wajib diisi.", "error");
    el.transactionDate.focus();
    return;
  }

  /* Nonaktifkan form selama proses simpan */
  isSubmitting = true;
  el.submitButton.disabled = true;
  el.submitButton.classList.add("is-busy");
  setFormMessage("Menyimpan transaksi...", null);

  const payload = {
    type,
    amount: Math.round(amount),
    category,
    description: description || null,
    transaction_date: transactionDate,
  };

  try {
    const { data, error } = await supabase.from(TABLE_NAME).insert(payload).select().single();

    if (error) throw error;

    setFormMessage("Transaksi berhasil disimpan.", "success");
    resetForm();

    /* Refresh data tabel */
    await fetchTransactions();
  } catch (error) {
    console.error("Gagal menyimpan transaksi:", error);
    const message = isPermissionError(error)
      ? `${error.message || "Akses ditolak."} — ${permissionHint()}`
      : error.message || "Gagal menyimpan transaksi.";
    setFormMessage(message, "error");
  } finally {
    isSubmitting = false;
    el.submitButton.disabled = false;
    el.submitButton.classList.remove("is-busy");
  }
}

/* =========================================================
   DELETE - hapus transaksi
   ========================================================= */
async function deleteTransaction(id) {
  if (!id || deletingIds.has(id)) return;

  const row = el.tableBody.querySelector(`tr[data-id="${id}"]`);
  if (row) row.classList.add("deleting");

  deletingIds.add(id);
  const btn = el.tableBody.querySelector(`button[data-delete="${id}"]`);
  if (btn) btn.disabled = true;

  const { error } = await supabase.from(TABLE_NAME).delete().eq("id", id);

  deletingIds.delete(id);

  if (error) {
    console.error("Gagal menghapus transaksi:", error);
    if (row) row.classList.remove("deleting");
    if (btn) btn.disabled = false;
    setFormMessage(error.message || "Gagal menghapus transaksi.", "error");
    return;
  }

  setFormMessage("Transaksi dihapus.", "success");
  await fetchTransactions();
}

/* =========================================================
   Reset form
   ========================================================= */
function resetForm() {
  el.form.reset();
  el.transactionDate.value = todayISO();
  document.querySelector('input[name="type"][value="expense"]').checked = true;
  syncCategoryOptions();
  el.amount.removeAttribute("aria-invalid");
  el.category.removeAttribute("aria-invalid");
  el.transactionDate.removeAttribute("aria-invalid");
}

/* =========================================================
   Error fatal (konfigurasi / koneksi)
   ========================================================= */
function showFatalError(title, sub) {
  el.tableCount.textContent = "0 catatan";
  showTableState(title, sub, true);
  el.submitButton.disabled = true;
  el.submitButton.style.opacity = "0.5";
  el.submitButton.style.cursor = "not-allowed";
  el.formMessage.textContent = sub;
  el.formMessage.classList.add("error");
  el.totalBalance.textContent = "Rp 0";
  el.totalIncome.textContent = "Rp 0";
  el.totalExpense.textContent = "Rp 0";
}

/* =========================================================
   Event listeners + boot
   ========================================================= */
function bindEvents() {
  el.form.addEventListener("submit", addTransaction);

  el.typeInputs.forEach((input) => {
    input.addEventListener("change", syncCategoryOptions);
  });

  el.resetButton.addEventListener("click", () => {
    setFormMessage("", null);
  });

  /* Event delegation untuk tombol hapus */
  el.tableBody.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-delete]");
    if (button && !button.disabled) {
      deleteTransaction(button.dataset.delete);
    }
  });

  el.amount.addEventListener("input", () => {
    el.amount.removeAttribute("aria-invalid");
  });
  el.category.addEventListener("change", () => {
    el.category.removeAttribute("aria-invalid");
  });
  el.transactionDate.addEventListener("change", () => {
    el.transactionDate.removeAttribute("aria-invalid");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    el.transactionDate.value = todayISO();
    el.periodLabel.textContent = currentMonthLabel();
    syncCategoryOptions();
    bindEvents();

    if (initSupabase()) {
      fetchTransactions();
    }
  } catch (error) {
    console.error("Gagal saat inisialisasi aplikasi:", error);
    displayRuntimeError(
      `Aplikasi gagal dimulai: ${error && error.message ? error.message : error}. ` +
        "Buka DevTools (F12) > Console untuk detail."
    );
  }
});

/* =========================================================
   Pelapor error runtime - tampilkan di layar, bukan hanya console
   ========================================================= */
function displayRuntimeError(message) {
  console.error("Runtime:", message);
  try {
    el.formMessage.textContent = message;
    el.formMessage.classList.remove("success");
    el.formMessage.classList.add("error");
  } catch (e) {
    /* elemen belum siap; abaikan */
  }
}

window.addEventListener("error", (event) => {
  displayRuntimeError(`Kesalahan JavaScript: ${event.message || "tidak diketahui"}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason && event.reason.message ? event.reason.message : event.reason;
  displayRuntimeError(`Kesalahan asinkron: ${reason}`);
});
