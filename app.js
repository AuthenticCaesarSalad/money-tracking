/* =========================================================
   Pencatatan Keuangan Pribadi
   Backend: Supabase (@supabase/supabase-js via CDN)
   ========================================================= */

/* Konfigurasi Supabase (SUPABASE_URL, SUPABASE_ANON_KEY, TABLE_NAME)
   dan pembuatan klien sudah dipindahkan ke auth.js, yang harus dimuat
   sebelum app.js. */

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

  /* AI invoice camera */
  openCameraButton: document.getElementById("openCameraButton"),
  cameraStage: document.getElementById("cameraStage"),
  cameraVideo: document.getElementById("cameraVideo"),
  cameraPreview: document.getElementById("cameraPreview"),
  cameraCanvas: document.getElementById("cameraCanvas"),
  captureInvoiceButton: document.getElementById("captureInvoiceButton"),
  retryCameraButton: document.getElementById("retryCameraButton"),
  closeCameraButton: document.getElementById("closeCameraButton"),
  invoiceFileInput: document.getElementById("invoiceFileInput"),
  cameraMessage: document.getElementById("cameraMessage"),
  receiptSelection: document.getElementById("receiptSelection"),
  receiptDialog: document.getElementById("receiptDialog"),
  receiptViewForm: document.getElementById("receiptViewForm"),
  receiptUsername: document.getElementById("receiptUsername"),
  receiptPassword: document.getElementById("receiptPassword"),
  receiptViewButton: document.getElementById("receiptViewButton"),
  receiptCancelButton: document.getElementById("receiptCancelButton"),
  receiptViewStatus: document.getElementById("receiptViewStatus"),
  receiptLink: document.getElementById("receiptLink"),

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

  /* Filter bar */
  filterSearch: document.getElementById("filterSearch"),
  filterType: document.getElementById("filterType"),
  filterCategory: document.getElementById("filterCategory"),
  filterFrom: document.getElementById("filterFrom"),
  filterTo: document.getElementById("filterTo"),
  resetFiltersButton: document.getElementById("resetFiltersButton"),

  /* Charts */
  monthlyChart: document.getElementById("monthlyChart"),
  monthlyChartEmpty: document.getElementById("monthlyChartEmpty"),
  categoryChart: document.getElementById("categoryChart"),
  categoryLegend: document.getElementById("categoryLegend"),
  donutChartSub: document.getElementById("donutChartSub"),
};

/* State lokal untuk flag proses */
let isSubmitting = false;
let deletingIds = new Set();

/* Pengguna yang sedang login (diisi dari auth.js saat boot) */
let currentUserId = null;
let currentUsername = null;

/* Privasi nominal: sembunyikan angka uang (sensor) */
const VISIBILITY_KEY = "keuangan_hide_amounts";
const AMOUNT_MASK = "*****";
let amountsHidden = false;
let allRows = [];

/* Paginasi tabel riwayat */
const PAGE_SIZE = 10;
let currentPage = 1;

/* Filter & pencarian tabel riwayat */
let filterState = {
  search: "",
  type: "all",
  category: "all",
  from: "",
  to: "",
};

/* Mode edit transaksi */
let editingId = null;
let receiptPath = null;
let formUnavailable = false;

/* AI invoice camera */
let cameraStream = null;
let isScanningInvoice = false;
let cameraRequestVersion = 0;
let receiptTransactionId = null;
let receiptViewVersion = 0;
let receiptViewController = null;

/* =========================================================
   Util
   ========================================================= */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatRupiah(value) {
  const number = Number(value) || 0;
  return rupiahFormatter.format(number);
}

function formatRupiahMasked(value) {
  return amountsHidden ? `Rp ${AMOUNT_MASK}` : formatRupiah(value);
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
   AI invoice camera
   ========================================================= */
function setCameraMessage(text, kind) {
  if (!el.cameraMessage) return;
  el.cameraMessage.textContent = text;
  el.cameraMessage.classList.remove("error", "success");
  if (kind) el.cameraMessage.classList.add(kind);
}

function syncReceiptSelection() {
  el.receiptSelection.textContent = receiptPath
    ? "Struk terlampir. Lampiran akan dipertahankan saat disimpan."
    : "Tidak ada struk terlampir.";
}

function lockTransactionForm() {
  const controls = [...el.form.querySelectorAll("input, select, button")];
  const previous = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  el.form.setAttribute("aria-busy", "true");
  renderPage();
  return () => {
    controls.forEach((control, index) => {
      control.disabled = previous[index] || formUnavailable;
    });
    el.form.removeAttribute("aria-busy");
    renderPage();
  };
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  if (el.cameraVideo) el.cameraVideo.srcObject = null;
}

async function openInvoiceCamera() {
  if (isScanningInvoice || isSubmitting || formUnavailable || !currentUserId || !supabaseClient) return;
  const requestVersion = ++cameraRequestVersion;
  el.cameraStage.hidden = false;
  el.cameraPreview.hidden = true;
  el.cameraVideo.hidden = false;
  el.captureInvoiceButton.hidden = false;
  el.retryCameraButton.hidden = true;
  setCameraMessage("Meminta akses kamera...", null);

  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    el.cameraVideo.hidden = true;
    el.captureInvoiceButton.hidden = true;
    setCameraMessage("Kamera langsung tidak tersedia. Gunakan tombol Pilih Foto.", "error");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    if (requestVersion !== cameraRequestVersion || el.cameraStage.hidden || isSubmitting || isScanningInvoice) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = stream;
    el.cameraVideo.srcObject = cameraStream;
    await el.cameraVideo.play();
    if (requestVersion !== cameraRequestVersion) return;
    setCameraMessage(editingId
      ? "Mode edit: scan berhasil akan membatalkan edit dan menyiapkan transaksi BARU, bukan mengganti struk transaksi ini."
      : "Posisikan seluruh struk di dalam gambar. Scan berhasil menyiapkan transaksi baru.", null);
  } catch (error) {
    if (requestVersion !== cameraRequestVersion) return;
    stopCamera();
    console.error("Gagal membuka kamera:", error);
    el.cameraVideo.hidden = true;
    el.captureInvoiceButton.hidden = true;
    setCameraMessage("Akses kamera ditolak. Gunakan tombol Pilih Foto.", "error");
  }
}

function imageToDataUrl(source, width, height) {
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = el.cameraCanvas;
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > 3_700_000 && quality > 0.5) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return dataUrl;
}

async function captureInvoice() {
  if (isScanningInvoice || isSubmitting || formUnavailable) return;
  if (!el.cameraVideo.videoWidth || !el.cameraVideo.videoHeight) {
    setCameraMessage("Kamera belum siap. Coba lagi sesaat.", "error");
    return;
  }
  const dataUrl = imageToDataUrl(
    el.cameraVideo,
    el.cameraVideo.videoWidth,
    el.cameraVideo.videoHeight
  );
  await scanInvoice(dataUrl);
}

function readInvoiceFile(file) {
  if (isScanningInvoice || isSubmitting || formUnavailable) return;
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    setCameraMessage("Pilih foto JPEG, PNG, atau WebP.", "error");
    return;
  }
  if (file.size > 10_000_000) {
    setCameraMessage("Foto sumber maksimal 10 MB.", "error");
    return;
  }

  return scanInvoice(file);
}

function applyInvoiceExpense(expense, savedPath = null) {
  cancelEdit(true);
  document.querySelector('input[name="type"][value="expense"]').checked = true;
  syncCategoryOptions();
  el.amount.value = expense.amount;
  el.category.value = CATEGORIES.expense.includes(expense.category)
    ? expense.category
    : "Lainnya";
  el.transactionDate.value = expense.transaction_date;
  el.description.value = String(expense.description || "").slice(0, 120);
  receiptPath = savedPath;
  syncReceiptSelection();
  [el.amount, el.category, el.transactionDate].forEach((input) =>
    input.removeAttribute("aria-invalid")
  );
  setFormMessage("Transaksi baru dari struk. Periksa nominal dan tanggal lalu simpan transaksi.", "success");
  el.amount.focus();
}

async function scanInvoice(source) {
  if (isScanningInvoice || isSubmitting || formUnavailable || !currentUserId || !supabaseClient || el.submitButton.disabled) return;
  isScanningInvoice = true;
  ++cameraRequestVersion;
  const unlock = lockTransactionForm();
  stopCamera();
  el.cameraStage.hidden = false;
  el.cameraVideo.hidden = true;
  el.captureInvoiceButton.hidden = true;
  el.retryCameraButton.hidden = true;
  setCameraMessage(editingId
    ? "Membaca struk... Jika berhasil, edit dibatalkan untuk menyiapkan transaksi BARU."
    : "Menyimpan foto dan membaca struk dengan AI...", null);

  try {
    const dataUrl = typeof source === "string" ? source : await new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(source);
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        try {
          resolve(imageToDataUrl(image, image.naturalWidth, image.naturalHeight));
        } catch (error) { reject(error); }
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Foto tidak dapat dibaca."));
      };
      image.src = objectUrl;
    });
    el.cameraPreview.src = dataUrl;
    el.cameraPreview.hidden = false;
    const response = await fetch("/api/invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, user_id: currentUserId }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const suffix = result.saved_path
        ? " Foto tersimpan, tetapi tidak dilampirkan. Form dan lampiran sebelumnya tidak diubah."
        : "";
      const message = String(result.error || "Struk gagal diproses.").replace(/invoice/gi, "struk");
      throw new Error(message + suffix);
    }
    if (!result.expense || !Number.isFinite(result.expense.amount) || result.expense.amount <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(result.expense.transaction_date) ||
        typeof result.saved_path !== "string" || !result.saved_path.trim()) {
      throw new Error("Hasil struk tidak lengkap. Form dan lampiran sebelumnya tidak diubah.");
    }
    applyInvoiceExpense(result.expense, result.saved_path);
    setCameraMessage("Foto terlampir pada transaksi BARU. Periksa form lalu simpan.", "success");
  } catch (error) {
    console.error("Gagal memindai invoice:", error);
    setCameraMessage(error.message || "Struk gagal diproses.", "error");
  } finally {
    isScanningInvoice = false;
    unlock();
    el.retryCameraButton.hidden = false;
  }
}

function closeInvoiceCamera() {
  if (isScanningInvoice) return;
  ++cameraRequestVersion;
  stopCamera();
  el.cameraStage.hidden = true;
  el.cameraPreview.removeAttribute("src");
  setCameraMessage("", null);
}

/* URL privat hanya ada di dialog terbuka; respons lama dibuang saat ditutup/diganti. */
function clearReceiptView() {
  ++receiptViewVersion;
  if (receiptViewController) receiptViewController.abort();
  receiptViewController = null;
  receiptTransactionId = null;
  el.receiptPassword.value = "";
  el.receiptPassword.disabled = false;
  el.receiptUsername.value = "";
  el.receiptViewButton.disabled = false;
  el.receiptViewStatus.textContent = "";
  el.receiptLink.removeAttribute("href");
  el.receiptLink.hidden = true;
}

function closeReceiptDialog() {
  clearReceiptView();
  if (el.receiptDialog.open) el.receiptDialog.close();
}

function openReceiptDialog(id) {
  if (!allRows.some((row) => row.id === id && row.receipt_path)) return;
  if (typeof el.receiptDialog.showModal !== "function") {
    setFormMessage("Browser ini belum mendukung dialog struk. Gunakan browser terbaru.", "error");
    return;
  }
  clearReceiptView();
  receiptTransactionId = id;
  el.receiptUsername.value = currentUsername;
  if (!el.receiptDialog.open) el.receiptDialog.showModal();
  el.receiptPassword.focus();
}

async function submitReceiptView(event) {
  event.preventDefault();
  if (!receiptTransactionId || receiptViewController || !el.receiptDialog.open) return;
  if (!el.receiptPassword.value) {
    el.receiptViewStatus.textContent = "Masukkan kata sandi akun untuk melihat struk privat.";
    el.receiptPassword.focus();
    return;
  }
  const body = JSON.stringify({
    action: "view_receipt",
    transaction_id: receiptTransactionId,
    username: currentUsername,
    password: el.receiptPassword.value,
  });
  el.receiptPassword.value = "";
  const version = ++receiptViewVersion;
  receiptViewController = new AbortController();
  el.receiptPassword.disabled = true;
  el.receiptViewButton.disabled = true;
  el.receiptLink.hidden = true;
  el.receiptLink.removeAttribute("href");
  el.receiptViewStatus.textContent = "Memverifikasi akun dan menyiapkan tautan privat...";
  try {
    const response = await fetch("/api/invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: receiptViewController.signal,
      body,
    });
    const result = await response.json().catch(() => ({}));
    if (version !== receiptViewVersion || !el.receiptDialog.open) return;
    if (!response.ok) throw new Error(result.error || "Struk tidak dapat dibuka.");
    const url = new URL(result.signed_url);
    if (typeof result.signed_url !== "string" || url.protocol !== "https:" ||
        url.origin !== new URL(SUPABASE_URL).origin || url.username || url.password) {
      throw new Error("Tautan struk tidak valid.");
    }
    el.receiptLink.setAttribute("href", url.href);
    el.receiptLink.hidden = false;
    el.receiptViewStatus.textContent = "Struk siap dibuka. Tautan privat berlaku 60 detik; verifikasi ulang jika kedaluwarsa.";
  } catch (error) {
    if (version === receiptViewVersion && el.receiptDialog.open) {
      el.receiptViewStatus.textContent = error instanceof TypeError
        ? "Tautan struk tidak valid atau koneksi gagal. Coba lagi."
        : error.message || "Struk tidak dapat dibuka.";
    }
  } finally {
    if (version === receiptViewVersion) {
      receiptViewController = null;
      el.receiptPassword.disabled = false;
      el.receiptViewButton.disabled = false;
    }
  }
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
    options.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

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

  el.totalIncome.textContent = formatRupiahMasked(totalIncome);
  el.totalExpense.textContent = formatRupiahMasked(totalExpense);
  el.totalBalance.textContent = formatRupiahMasked(balance);
  el.totalBalance.classList.toggle("is-negative", balance < 0);

  el.periodLabel.textContent = currentMonthLabel();
}

/* =========================================================
   Charts (SVG murni, tanpa library)
   ========================================================= */

/* Palet warna untuk kategori (donut chart) */
const CATEGORY_COLORS = [
  "#18181b",
  "#3f3f46",
  "#71717a",
  "#a1a1aa",
  "#d4d4d8",
  "#166534",
  "#991b1b",
  "#1d4ed8",
  "#b45309",
  "#6d28d9",
];

/* Ambil warna kategori berdasarkan index (melingkar) */
function categoryColor(index) {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length];
}

/* Format ringkas untuk label sumbu (contoh: "Rp 1,2 jt") */
function formatCompact(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `Rp ${(value / 1_000_000_000).toFixed(1)} M`;
  if (abs >= 1_000_000) return `Rp ${(value / 1_000_000).toFixed(1)} jt`;
  if (abs >= 1_000) return `Rp ${(value / 1_000).toFixed(0)} rb`;
  return formatRupiah(value);
}

/* Sama seperti formatCompact, tapi sensor ***** saat mode privasi aktif */
function formatCompactMasked(value) {
  return amountsHidden ? AMOUNT_MASK : formatCompact(value);
}

/* Key unik per bulan (YYYY-MM) */
function monthKey(dateStr) {
  return String(dateStr || "").slice(0, 7);
}

/* Agregasi pemasukan/pengeluaran per bulan (6 bulan terakhir) */
function buildMonthlyData(rows) {
  const buckets = new Map();

  for (const t of rows) {
    const key = monthKey(t.transaction_date);
    if (!key) continue;

    const bucket = buckets.get(key) || { key, income: 0, expense: 0 };
    if (t.type === "income") bucket.income += Number(t.amount) || 0;
    else bucket.expense += Number(t.amount) || 0;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([, bucket]) => bucket);
}

/* Render bar chart pemasukan vs pengeluaran per bulan */
function renderMonthlyChart(rows) {
  const svg = el.monthlyChart;
  if (!svg) return;

  const data = buildMonthlyData(rows);

  if (!data.length) {
    svg.innerHTML = "";
    if (el.monthlyChartEmpty) el.monthlyChartEmpty.hidden = false;
    return;
  }

  if (el.monthlyChartEmpty) el.monthlyChartEmpty.hidden = true;

  const W = 640;
  const H = 240;
  const padTop = 28;
  const padBottom = 34;
  const padLeft = 48;
  const padRight = 12;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;

  const maxValue = Math.max(1, ...data.flatMap((d) => [d.income, d.expense]));

  /* Garis kisi horizontal (4 level) */
  const gridLines = [0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = padTop + plotH - plotH * ratio;
    const value = maxValue * ratio;
    return `<line class="chart-axis-line" x1="${padLeft}" y1="${y}" x2="${W - padRight}" y2="${y}" />
      <text class="bar-month-label" x="${padLeft - 8}" y="${y + 3.5}" text-anchor="end">${formatCompactMasked(
      value
    )}</text>`;
  });

  /* Kelompok batang per bulan */
  const groupW = plotW / data.length;
  const barW = Math.min(26, groupW * 0.28);
  const gap = 6;

  const bars = data.map((d, i) => {
    const cx = padLeft + groupW * i + groupW / 2;
    const incomeH = (d.income / maxValue) * plotH;
    const expenseH = (d.expense / maxValue) * plotH;
    const baseY = padTop + plotH;

    const incomeX = cx - barW - gap / 2;
    const expenseX = cx + gap / 2;

    const [, month] = d.key.split("-");
    const monthName = new Date(Number(d.key.slice(0, 4)), Number(month) - 1, 1).toLocaleDateString(
      "id-ID",
      { month: "short" }
    );

    return `<g class="bar-group">
      <rect x="${incomeX}" y="${baseY - incomeH}" width="${barW}" height="${incomeH}" rx="2" fill="var(--color-income)" />
      <rect x="${expenseX}" y="${baseY - expenseH}" width="${barW}" height="${expenseH}" rx="2" fill="var(--color-expense)" />
      <text class="bar-month-label" x="${cx}" y="${H - padBottom + 18}" text-anchor="middle">${monthName}</text>
    </g>`;
  });

  svg.innerHTML = gridLines.join("") + bars.join("");
}

/* Agregasi pengeluaran per kategori untuk bulan berjalan */
function buildCategoryData(rows) {
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const totals = new Map();
  for (const t of rows) {
    if (t.type !== "expense") continue;
    if (monthKey(t.transaction_date) !== currentKey) continue;

    const category = t.category || "Lainnya";
    totals.set(category, (totals.get(category) || 0) + (Number(t.amount) || 0));
  }

  return [...totals.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
}

/* Render donut chart pengeluaran per kategori */
function renderCategoryChart(rows) {
  const svg = el.categoryChart;
  if (!svg) return;

  const data = buildCategoryData(rows);
  const total = data.reduce((sum, d) => sum + d.total, 0);

  if (!data.length || total <= 0) {
    svg.innerHTML = "";
    if (el.categoryLegend) el.categoryLegend.innerHTML = "";
    if (el.donutChartSub) el.donutChartSub.textContent = "Belum ada pengeluaran bulan ini";
    return;
  }

  if (el.donutChartSub) el.donutChartSub.textContent = "Bulan ini";

  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 92;
  const innerRadius = 56;
  const twoPi = Math.PI * 2;

  let angle = -Math.PI / 2;

  const arcs = data.map((d, i) => {
    const fraction = d.total / total;
    const sweep = fraction * twoPi;
    const startAngle = angle;
    const endAngle = angle + sweep;
    angle = endAngle;

    /* Lingkaran penuh jadi satu segmen utuh */
    if (fraction >= 1) {
      return `<circle cx="${cx}" cy="${cy}" r="${(radius + innerRadius) / 2}"
        fill="none" stroke="${categoryColor(i)}" stroke-width="${radius - innerRadius}" />`;
    }

    const x1 = cx + radius * Math.cos(startAngle);
    const y1 = cy + radius * Math.sin(startAngle);
    const x2 = cx + radius * Math.cos(endAngle);
    const y2 = cy + radius * Math.sin(endAngle);
    const x3 = cx + innerRadius * Math.cos(endAngle);
    const y3 = cy + innerRadius * Math.sin(endAngle);
    const x4 = cx + innerRadius * Math.cos(startAngle);
    const y4 = cy + innerRadius * Math.sin(startAngle);

    const largeArc = sweep > Math.PI ? 1 : 0;

    return `<path d="M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}
      L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z"
      fill="${categoryColor(i)}">
      <title>${escapeHtml(d.category)}: ${formatRupiah(d.total)} (${(fraction * 100).toFixed(1)}%)</title>
    </path>`;
  });

  svg.innerHTML = arcs.join("") +
    `<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="bar-month-label" style="font-size:11px;">Total</text>
     <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="bar-value" style="font-size:11px;">${formatCompactMasked(
      total
    )}</text>`;

  /* Legenda di samping donut */
  if (el.categoryLegend) {
    el.categoryLegend.innerHTML = data
      .map((d, i) => {
        const fraction = d.total / total;
        return `<li>
          <span class="legend-swatch" style="background-color: ${categoryColor(i)}"></span>
          <span class="legend-name">${escapeHtml(d.category)}</span>
          <span class="legend-value">${(fraction * 100).toFixed(0)}%</span>
        </li>`;
      })
      .join("");
  }
}

/* =========================================================
   READ - ambil semua transaksi
   ========================================================= */
async function fetchTransactions() {
  renderSkeleton();

  const { data, error } = await supabaseClient
    .from(TABLE_NAME)
    .select("id, type, amount, category, description, transaction_date, created_at, receipt_path")
    .eq("user_id", currentUserId)
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
  allRows = transactions;
  syncFilterCategoryOptions();
  currentPage = clampPage(currentPage);

  const filtered = getFilteredRows();

  if (!filtered.length) {
    const hasFilters = isFilterActive();
    showTableState(
      hasFilters ? "Tidak ada hasil" : "Belum ada transaksi",
      hasFilters
        ? "Tidak ada transaksi yang cocok dengan filter. Coba ubah atau atur ulang filter."
        : "Tambahkan transaksi pertama Anda menggunakan form di samping.",
      false
    );
  } else {
    hideTableState();
    renderPage();
  }

  renderPagination();
  updateSummary(transactions);
  renderMonthlyChart(transactions);
  renderCategoryChart(transactions);
}

/* Terapkan filter (pencarian, jenis, kategori, rentang tanggal) pada allRows */
function getFilteredRows() {
  const search = filterState.search.trim().toLowerCase();
  const from = filterState.from;
  const to = filterState.to;

  return allRows.filter((t) => {
    if (filterState.type !== "all" && t.type !== filterState.type) return false;

    if (filterState.category !== "all" && t.category !== filterState.category) return false;

    if (from && t.transaction_date < from) return false;
    if (to && t.transaction_date > to) return false;

    if (search) {
      const description = String(t.description || "").toLowerCase();
      const category = String(t.category || "").toLowerCase();
      if (!description.includes(search) && !category.includes(search)) return false;
    }

    return true;
  });
}

/* Apakah ada filter yang sedang aktif? */
function isFilterActive() {
  return (
    filterState.search.trim() !== "" ||
    filterState.type !== "all" ||
    filterState.category !== "all" ||
    filterState.from !== "" ||
    filterState.to !== ""
  );
}

/* Isi dropdown kategori filter dengan kategori yang pernah dipakai */
function syncFilterCategoryOptions() {
  if (!el.filterCategory) return;

  const previous = filterState.category;
  const used = [...new Set(allRows.map((t) => t.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "id")
  );

  el.filterCategory.innerHTML =
    '<option value="all">Semua</option>' +
    used.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  if (used.includes(previous)) {
    el.filterCategory.value = previous;
  } else {
    el.filterCategory.value = "all";
    filterState.category = "all";
  }
}

/* Reset semua filter ke nilai awal */
function resetFilters() {
  filterState = { search: "", type: "all", category: "all", from: "", to: "" };

  if (el.filterSearch) el.filterSearch.value = "";
  if (el.filterType) el.filterType.value = "all";
  if (el.filterCategory) el.filterCategory.value = "all";
  if (el.filterFrom) el.filterFrom.value = "";
  if (el.filterTo) el.filterTo.value = "";

  currentPage = 1;
  renderTransactions(allRows);
}

/* Render ulang tabel + paginasi setelah filter berubah */
function applyFilters() {
  currentPage = clampPage(currentPage);

  const filtered = getFilteredRows();

  if (!filtered.length) {
    showTableState(
      "Tidak ada hasil",
      "Tidak ada transaksi yang cocok dengan filter. Coba ubah atau atur ulang filter.",
      false
    );
    renderPagination();
  } else {
    hideTableState();
    renderPage();
    renderPagination();
  }
}

/* Halaman aktif saja, sesuai PAGE_SIZE */
function renderPage() {
  const filtered = getFilteredRows();
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);

  const ICON_INCOME = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  const ICON_EXPENSE = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>`;

  const rows = pageRows.map((t) => {
    const type = t.type === "income" ? "income" : "expense";
    const typeLabel = type === "income" ? "Pemasukan" : "Pengeluaran";
    const description = t.description
      ? escapeHtml(t.description)
      : '<span class="desc-empty">Tidak ada keterangan</span>';

    const id = escapeHtml(t.id);
    const date = escapeHtml(formatDateString(t.transaction_date));
    return `<tr data-id="${id}">
      <td class="cell-date">${date}</td>
      <td class="cell-desc">${description}</td>
      <td class="cell-cat"><span class="tag">${escapeHtml(t.category || "Lainnya")}</span></td>
      <td class="cell-type">
        <span class="type-badge ${type}">
          ${type === "income" ? ICON_INCOME : ICON_EXPENSE}
          ${typeLabel}
        </span>
      </td>
      <td class="cell-amount ${type}">${
        amountsHidden ? AMOUNT_MASK : formatAmount(t.amount, type)
      }</td>
      <td class="cell-action">
        ${t.receipt_path ? `<button type="button" class="btn-receipt" data-receipt="${id}">Lihat Struk</button>` : ""}
        <button
          type="button"
          class="btn-edit"
          data-edit="${id}"
          title="Edit transaksi"
          aria-label="Edit transaksi tanggal ${date}"
          ${editingId || isScanningInvoice || isSubmitting ? "disabled" : ""}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
          </svg>
        </button>
        <button
          type="button"
          class="btn-delete"
          data-delete="${id}"
          title="Hapus transaksi"
          aria-label="Hapus transaksi tanggal ${date}"
          ${deletingIds.has(t.id) || isScanningInvoice || isSubmitting ? "disabled" : ""}
        >
          <svg xmlns="http://www.w3.org/2001/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5"/>
          </svg>
        </button>
      </td>
    </tr>`;
  });

  el.tableBody.innerHTML = rows.join("");
}

/* Batasi halaman ke rentang yang valid (1 .. jumlah halaman) */
function clampPage(page) {
  const maxPage = Math.max(1, Math.ceil(getFilteredRows().length / PAGE_SIZE));
  return Math.min(Math.max(1, page), maxPage);
}

/* Tombol Sebelumnya / nomor halaman / Berikutnya */
function renderPagination() {
  const container = document.getElementById("paginationBar");
  if (!container) return;

  const total = getFilteredRows().length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = (currentPage - 1) * PAGE_SIZE;

  if (!total) {
    container.hidden = true;
    container.innerHTML = "";
    el.tableCount.textContent = "0 catatan";
    return;
  }

  el.tableCount.textContent =
    total <= PAGE_SIZE
      ? `${total} catatan`
      : `Menampilkan ${start + 1}–${Math.min(start + PAGE_SIZE, total)} dari ${total} catatan`;

  if (total <= PAGE_SIZE) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  const parts = [];
  parts.push(
    `<button type="button" class="pg-btn" data-page="${currentPage - 1}"${
      currentPage === 1 ? " disabled" : ""
    }>Sebelumnya</button>`
  );

  for (let p = 1; p <= maxPage; p++) {
    const near = Math.abs(p - currentPage) <= 1 || p === 1 || p === maxPage;
    if (near) {
      parts.push(
        `<button type="button" class="pg-btn${
          p === currentPage ? " is-active" : ""
        }" data-page="${p}">${p}</button>`
      );
    } else if (parts[parts.length - 1] !== `<span class="pg-ellipsis" aria-hidden="true">…</span>`) {
      parts.push(`<span class="pg-ellipsis" aria-hidden="true">…</span>`);
    }
  }

  parts.push(
    `<button type="button" class="pg-btn" data-page="${currentPage + 1}"${
      currentPage === maxPage ? " disabled" : ""
    }>Berikutnya</button>`
  );

  container.hidden = false;
  container.innerHTML = parts.join("");
}

/* =========================================================
   CREATE / UPDATE - simpan transaksi
   ========================================================= */
async function addTransaction(event) {
  event.preventDefault();

  if (isSubmitting || isScanningInvoice || formUnavailable || !currentUserId || !supabaseClient || el.submitButton.disabled) return;

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
  closeInvoiceCamera();
  isSubmitting = true;
  const unlock = lockTransactionForm();
  el.submitButton.classList.add("is-busy");
  setFormMessage(editingId ? "Memperbarui transaksi..." : "Menyimpan transaksi...", null);

  const payload = {
    user_id: currentUserId,
    type,
    amount: Math.round(amount),
    category,
    description: description || null,
    transaction_date: transactionDate,
    receipt_path: receiptPath,
  };

  try {
    let data, error;

    if (editingId) {
      /* UPDATE transaksi yang dipilih */
      ({ data, error } = await supabaseClient
        .from(TABLE_NAME)
        .update(payload)
        .eq("id", editingId)
        .eq("user_id", currentUserId)
        .select()
        .single());
    } else {
      /* INSERT transaksi baru */
      ({ data, error } = await supabaseClient
        .from(TABLE_NAME)
        .insert(payload)
        .select()
        .single());
    }

    if (error) throw error;

    const wasEditing = Boolean(editingId);
    resetForm(true);
    setFormMessage(
      wasEditing ? "Transaksi berhasil diperbarui." : "Transaksi berhasil disimpan.",
      "success"
    );

    /* Transaksi terbaru tampil di halaman pertama */
    currentPage = 1;

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
    unlock();
    el.submitButton.classList.remove("is-busy");
  }
}

/* =========================================================
   EDIT - muat transaksi ke form
   ========================================================= */
function startEdit(id) {
  if (!id || editingId || isScanningInvoice || isSubmitting || formUnavailable) return;

  const transaction = allRows.find((t) => t.id === id);
  if (!transaction) return;

  closeInvoiceCamera();
  editingId = id;
  receiptPath = transaction.receipt_path || null;
  syncReceiptSelection();

  /* Isi form dengan data transaksi yang dipilih */
  const type = transaction.type === "income" ? "income" : "expense";
  document.querySelector(`input[name="type"][value="${type}"]`).checked = true;
  syncCategoryOptions();

  el.amount.value = transaction.amount;
  el.category.value = transaction.category;
  el.transactionDate.value = transaction.transaction_date;
  el.description.value = transaction.description || "";

  syncFormMode();

  setFormMessage("Mode edit: ubah data lalu simpan. Scan berhasil akan membatalkan edit dan menyiapkan transaksi baru.", null);

  /* Scroll ke form agar terlihat di layar kecil */
  el.form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  el.amount.focus();
}

/* Batalkan mode edit, kembali ke mode tambah */
function cancelEdit(internal = false) {
  if (!internal && (isScanningInvoice || isSubmitting)) return;
  editingId = null;
  receiptPath = null;
  syncReceiptSelection();
  syncFormMode();
  setFormMessage("", null);
}

/* Ubah tampilan form sesuai mode (tambah / edit) */
function syncFormMode() {
  if (!el.submitButton) return;

  if (editingId) {
    el.submitButton.textContent = "Simpan Perubahan";
    el.resetButton.textContent = "Batal Edit";
  } else {
    el.submitButton.textContent = "Simpan Transaksi";
    el.resetButton.textContent = "Bersihkan";
  }
}

/* =========================================================
   DELETE - hapus transaksi
   ========================================================= */
async function deleteTransaction(id) {
  if (!id || deletingIds.has(id) || isScanningInvoice || isSubmitting) return;

  const row = el.tableBody.querySelector(`tr[data-id="${id}"]`);
  if (row) row.classList.add("deleting");

  deletingIds.add(id);
  const btn = el.tableBody.querySelector(`button[data-delete="${id}"]`);
  if (btn) btn.disabled = true;

  const { error } = await supabaseClient
    .from(TABLE_NAME)
    .delete()
    .eq("id", id)
    .eq("user_id", currentUserId);

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
function resetForm(internal = false) {
  if (!internal && (isScanningInvoice || isSubmitting)) return;
  closeInvoiceCamera();
  el.amount.value = "";
  el.description.value = "";
  el.invoiceFileInput.value = "";
  el.transactionDate.value = todayISO();
  document.querySelector('input[name="type"][value="expense"]').checked = true;
  syncCategoryOptions();
  el.category.value = "";
  el.amount.removeAttribute("aria-invalid");
  el.category.removeAttribute("aria-invalid");
  el.transactionDate.removeAttribute("aria-invalid");

  /* Tombol reset juga membatalkan mode edit */
  cancelEdit(true);
}

/* =========================================================
   Error fatal (konfigurasi / koneksi)
   ========================================================= */
function showFatalError(title, sub) {
  formUnavailable = true;
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
  el.receiptViewForm.addEventListener("submit", submitReceiptView);
  el.receiptCancelButton.addEventListener("click", closeReceiptDialog);
  el.receiptDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeReceiptDialog();
  });
  el.receiptDialog.addEventListener("close", () => {
    if (!el.receiptDialog.open) clearReceiptView();
  });

  if (el.openCameraButton) el.openCameraButton.addEventListener("click", openInvoiceCamera);
  if (el.captureInvoiceButton) el.captureInvoiceButton.addEventListener("click", captureInvoice);
  if (el.retryCameraButton) el.retryCameraButton.addEventListener("click", openInvoiceCamera);
  if (el.closeCameraButton) el.closeCameraButton.addEventListener("click", closeInvoiceCamera);
  if (el.invoiceFileInput) {
    el.invoiceFileInput.addEventListener("change", () => {
      const file = el.invoiceFileInput.files && el.invoiceFileInput.files[0];
      readInvoiceFile(file);
      el.invoiceFileInput.value = "";
    });
  }

  el.typeInputs.forEach((input) => {
    input.addEventListener("change", syncCategoryOptions);
  });

  /* Reset sinkron: tidak ada callback native tertunda yang menimpa hasil scan. */
  el.form.addEventListener("reset", (event) => {
    event.preventDefault();
    resetForm();
  });

  /* Event delegation untuk tombol hapus */
  el.tableBody.addEventListener("click", (event) => {
    const receiptButton = event.target.closest("button[data-receipt]");
    if (receiptButton && !receiptButton.disabled) {
      openReceiptDialog(receiptButton.dataset.receipt);
      return;
    }
    const deleteButton = event.target.closest("button[data-delete]");
    if (deleteButton && !deleteButton.disabled) {
      deleteTransaction(deleteButton.dataset.delete);
      return;
    }

    const editButton = event.target.closest("button[data-edit]");
    if (editButton && !editButton.disabled) {
      startEdit(editButton.dataset.edit);
    }
  });

  /* Filter bar - perbarui tabel saat filter berubah */
  if (el.filterSearch) {
    el.filterSearch.addEventListener("input", () => {
      filterState.search = el.filterSearch.value;
      currentPage = 1;
      applyFilters();
    });
  }

  if (el.filterType) {
    el.filterType.addEventListener("change", () => {
      filterState.type = el.filterType.value;
      currentPage = 1;
      applyFilters();
    });
  }

  if (el.filterCategory) {
    el.filterCategory.addEventListener("change", () => {
      filterState.category = el.filterCategory.value;
      currentPage = 1;
      applyFilters();
    });
  }

  if (el.filterFrom) {
    el.filterFrom.addEventListener("change", () => {
      filterState.from = el.filterFrom.value;
      currentPage = 1;
      applyFilters();
    });
  }

  if (el.filterTo) {
    el.filterTo.addEventListener("change", () => {
      filterState.to = el.filterTo.value;
      currentPage = 1;
      applyFilters();
    });
  }

  if (el.resetFiltersButton) {
    el.resetFiltersButton.addEventListener("click", () => {
      resetFilters();
      setFormMessage("Filter diatur ulang.", null);
    });
  }

  /* Event delegation untuk tombol pagination */
  const paginationBar = document.getElementById("paginationBar");
  if (paginationBar) {
    paginationBar.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled || !button.dataset.page) return;
      const page = Number(button.dataset.page);
      if (!Number.isFinite(page)) return;
      currentPage = clampPage(page);
      renderPage();
      renderPagination();
    });
  }

  el.amount.addEventListener("input", () => {
    el.amount.removeAttribute("aria-invalid");
  });
  el.category.addEventListener("change", () => {
    el.category.removeAttribute("aria-invalid");
  });
  el.transactionDate.addEventListener("change", () => {
    el.transactionDate.removeAttribute("aria-invalid");
  });

  /* Tombol sembunyikan/tampilkan nominal */
  const visibilityButton = document.getElementById("toggleVisibilityButton");
  if (visibilityButton) {
    visibilityButton.addEventListener("click", toggleVisibility);
  }
}

/* =========================================================
   Privasi nominal (sensor *****)
   ========================================================= */
const VISIBILITY_ICON_ON = `<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />`;
const VISIBILITY_ICON_OFF = `<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><line x1="2" x2="22" y1="2" y2="22" />`;

function applyVisibility() {
  const button = document.getElementById("toggleVisibilityButton");
  const icon = document.getElementById("visibilityIcon");

  if (button) {
    button.setAttribute("aria-pressed", String(amountsHidden));
    const label = amountsHidden ? "Tampilkan nominal" : "Sembunyikan nominal";
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  if (icon) {
    icon.innerHTML = amountsHidden ? VISIBILITY_ICON_OFF : VISIBILITY_ICON_ON;
  }

  updateSummary(allRows);
  renderMonthlyChart(allRows);
  renderCategoryChart(allRows);
  if (allRows.length) {
    renderPage();
    renderPagination();
  }
}

function toggleVisibility() {
  amountsHidden = !amountsHidden;
  try {
    localStorage.setItem(VISIBILITY_KEY, String(amountsHidden));
  } catch (error) {
    console.error("Gagal menyimpan preferensi privasi:", error);
  }
  applyVisibility();
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    const session = requireSession();
    if (!session) return; // sudah diredirect ke login.html

    currentUserId = session.userId;
    currentUsername = session.username;

    const badge = document.getElementById("userBadge");
    if (badge) badge.textContent = currentUsername;

    if (!supabaseClient) {
      displayRuntimeError(
        "Klien Supabase belum siap. Periksa konfigurasi di auth.js lalu muat ulang halaman."
      );
      return;
    }

    el.transactionDate.value = todayISO();
    el.periodLabel.textContent = currentMonthLabel();
    syncCategoryOptions();
    syncReceiptSelection();
    bindEvents();

    /* Preferensi sensor nominal dari sesi sebelumnya */
    try {
      amountsHidden = localStorage.getItem(VISIBILITY_KEY) === "true";
    } catch (error) {
      amountsHidden = false;
    }
    applyVisibility();

    fetchTransactions();
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
    formUnavailable = true;
    el.submitButton.disabled = true;
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
