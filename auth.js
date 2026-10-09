/* =========================================================
   Konfigurasi Supabase
   Ganti URL dan anon key di bawah dengan kredensial proyek
   Supabase Anda sendiri (Settings > API di dashboard).
   ========================================================= */
const SUPABASE_URL = "https://pfhbijsqekteeyavbvnj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmaGJpanNxZWt0ZWV5YXZidm5qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MjEyMzEsImV4cCI6MjEwNzA5NzIzMX0.tl3vJ0Bdcg5HXzcjSgnX2BGdrKiVqAIomv-XCUbDgcg";
const TABLE_NAME = "transactions";
const SESSION_KEY = "keuangan_session";
const LOGIN_FUNCTION = "login_user";

/* ====== Klien Supabase (deklarasi tunggal, dipakai bersama app.js) ====== */
let supabaseClient = null;

/* =========================================================
   Sesi pengguna (localStorage)
   ========================================================= */
function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.userId || !session.username) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch (err) {
    // JSON rusak / tidak terbaca: bersihkan dan anggap belum login
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function requireSession() {
  const session = getSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }
  return session;
}

/* ====== Keluar / logout ====== */
function doLogout() {
  clearSession();
  window.location.href = "login.html";
}

/* =========================================================
   Pelaporan kesalahan konfigurasi
   ========================================================= */
function reportConfigError(message) {
  console.error(message);
  const el = document.getElementById("loginMessage");
  if (el) {
    el.textContent = message;
    el.classList.add("error");
  }
}

/* =========================================================
   Inisialisasi klien Supabase
   Mengembalikan true jika berhasil, false jika gagal.
   ========================================================= */
function initSupabaseClient() {
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    reportConfigError("Klien Supabase gagal dimuat. Periksa koneksi internet lalu muat ulang halaman ini.");
    return false;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    reportConfigError("Kredensial Supabase belum dikonfigurasi di auth.js.");
    return false;
  }

  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    reportConfigError("Klien Supabase gagal dimuat. Periksa koneksi internet lalu muat ulang halaman ini.");
    console.error(err);
    return false;
  }

  return true;
}

/* =========================================================
   Formulir login (hanya aktif di login.html)
   ========================================================= */
function bindLoginForm() {
  const form = document.getElementById("loginForm");
  if (!form) return;

  const usernameInput = document.getElementById("loginUsername");
  const passwordInput = document.getElementById("loginPassword");
  const messageEl = document.getElementById("loginMessage");
  const button = document.getElementById("loginButton");

  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    messageEl.textContent = "";
    messageEl.classList.remove("error");

    if (!username || !password) {
      messageEl.textContent = "Isi nama pengguna dan kata sandi.";
      messageEl.classList.add("error");
      return;
    }

    button.disabled = true;
    button.textContent = "Memproses...";

    try {
      const { data, error } = await supabaseClient.rpc(LOGIN_FUNCTION, {
        p_username: username,
        p_password: password,
      });

      if (error) {
        throw error;
      }

      const user = Array.isArray(data) ? data[0] : data;

      if (!user || !user.id) {
        messageEl.textContent = "Nama pengguna atau kata sandi salah.";
        messageEl.classList.add("error");
        passwordInput.value = "";
        button.disabled = false;
        button.textContent = "Masuk";
        return;
      }

      setSession({ userId: user.id, username: user.username });
      window.location.href = "index.html";
    } catch (err) {
      console.error("Login gagal:", err);
      const msg = (err && err.message) || "";
      const lower = msg.toLowerCase();
      const isDbProblem =
        lower.includes("function") ||
        lower.includes("permission") ||
        lower.includes("could not find") ||
        lower.includes("rls") ||
        lower.includes("row-level security");
      // Pesan generatif hanya untuk kredensial salah;
      // masalah database (fungsi belum dibuat, RLS) ditampilkan apa adanya.
      messageEl.textContent = isDbProblem
        ? "Login belum siap di database: " + msg
        : "Nama pengguna atau kata sandi salah.";
      messageEl.classList.add("error");
      passwordInput.value = "";
    } finally {
      button.disabled = false;
      button.textContent = "Masuk";
    }
  });
}

/* =========================================================
   Inisialisasi saat DOM siap
   ========================================================= */
document.addEventListener("DOMContentLoaded", function () {
  if (initSupabaseClient()) {
    bindLoginForm();
  }

  const logoutButton = document.getElementById("logoutButton");
  if (logoutButton) {
    logoutButton.addEventListener("click", function () {
      doLogout();
    });
  }
});
