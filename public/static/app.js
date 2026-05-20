// 村田鉄筋㈱ 見積データベース フロントエンド SPA

// ========== グローバル状態 ==========
const State = {
  user: null,
  token: localStorage.getItem('murata_token') || null,
  estimates: [],
  stats: null,
  filters: {},
  currentRoute: '/',
  charts: {},
};

const API = axios.create({ baseURL: '' });
API.interceptors.request.use((config) => {
  if (State.token) config.headers.Authorization = `Bearer ${State.token}`;
  return config;
});
API.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      logout();
    }
    return Promise.reject(err);
  }
);

// ========== ユーティリティ ==========
const yen = (n) => (n == null ? '-' : '¥' + Math.round(n).toLocaleString());
const num = (n, d = 1) => (n == null ? '-' : Number(n).toFixed(d));
const num0 = (n) => (n == null ? '-' : Math.round(n).toLocaleString());
const escapeHtml = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));

const STRUCTURES = ['RC造', 'S造', 'SRC造', '壁構造', 'ラーメン構造', '木造基礎'];
const BUILDING_USES = ['マンション', '工場', '倉庫', '学校', '病院', '店舗', '住宅', 'オフィス', 'ホテル', 'その他'];
const MATERIAL_TYPES = ['材工', '手間請け', '支給材'];
const RESULTS = ['受注', '失注', '未定'];
const LOST_REASONS = ['金額が高い', '他社決定', '工期が合わない', '条件が合わない', '不明', 'その他'];
const DIFFICULTIES = ['低', '中', '高'];

function resultBadge(r) {
  if (r === '受注') return '<span class="badge badge-won"><i class="fas fa-check"></i> 受注</span>';
  if (r === '失注') return '<span class="badge badge-lost"><i class="fas fa-times"></i> 失注</span>';
  return '<span class="badge badge-pending"><i class="fas fa-clock"></i> 未定</span>';
}

function calcOrderRate(won, lost) {
  const total = (won || 0) + (lost || 0);
  if (total === 0) return 0;
  return ((won / total) * 100);
}

// ========== ルーター ==========
function navigate(path, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  render();
}

window.addEventListener('popstate', render);

// ========== 初期化 ==========
async function init() {
  if (State.token) {
    try {
      const { data } = await API.get('/api/me');
      State.user = data.user;
    } catch {
      State.token = null;
      localStorage.removeItem('murata_token');
    }
  }
  render();
}

function logout() {
  State.token = null;
  State.user = null;
  localStorage.removeItem('murata_token');
  navigate('/login', true);
}

// ========== レンダラー ==========
async function render() {
  const path = location.pathname;
  State.currentRoute = path;
  const app = document.getElementById('app');

  if (!State.user && path !== '/login') {
    navigate('/login', true);
    return;
  }
  if (State.user && path === '/login') {
    navigate('/dashboard', true);
    return;
  }

  if (path === '/login') return renderLogin(app);

  // ログイン後は共通レイアウト
  app.innerHTML = layoutHTML();
  attachLayoutEvents();

  const main = document.getElementById('main-content');
  if (path === '/' || path === '/dashboard') return renderDashboard(main);
  if (path === '/estimates') return renderEstimateList(main);
  if (path === '/estimates/new') return renderEstimateForm(main, null);
  if (path.startsWith('/estimates/')) {
    const id = path.split('/').pop();
    return renderEstimateForm(main, id);
  }
  if (path === '/stats/clients') return renderStats(main, 'clients');
  if (path === '/stats/structure') return renderStats(main, 'structure');
  if (path === '/stats/price') return renderStats(main, 'price');
  if (path === '/stats/lost') return renderStats(main, 'lost');
  if (path === '/stats/export') return renderExport(main);

  main.innerHTML = '<div class="p-8 text-center text-gray-500">ページが見つかりません</div>';
}

// ========== レイアウト ==========
function layoutHTML() {
  const path = State.currentRoute;
  const active = (p) => path === p || (p !== '/dashboard' && path.startsWith(p)) ? 'active' : '';
  return `
  <div class="min-h-screen flex flex-col md:flex-row">
    <!-- サイドバー -->
    <aside class="bg-slate-900 text-white md:w-60 md:min-h-screen flex-shrink-0">
      <div class="p-4 border-b border-slate-700">
        <div class="font-bold text-lg flex items-center gap-2">
          <i class="fas fa-building text-blue-400"></i>
          <span>村田鉄筋㈱</span>
        </div>
        <div class="text-xs text-gray-400 mt-1">見積データベース</div>
      </div>
      <nav class="py-2">
        <a class="sidebar-link ${active('/dashboard')}" data-nav="/dashboard"><i class="fas fa-chart-pie w-5"></i> ダッシュボード</a>
        <a class="sidebar-link ${active('/estimates')}" data-nav="/estimates"><i class="fas fa-list w-5"></i> 見積データ一覧</a>
        <a class="sidebar-link ${active('/estimates/new')}" data-nav="/estimates/new"><i class="fas fa-plus w-5"></i> 新規登録</a>
        <div class="mt-3 px-4 text-xs text-gray-500 uppercase tracking-wider">集計</div>
        <a class="sidebar-link ${active('/stats/clients')}" data-nav="/stats/clients"><i class="fas fa-handshake w-5"></i> 元請け別</a>
        <a class="sidebar-link ${active('/stats/structure')}" data-nav="/stats/structure"><i class="fas fa-building w-5"></i> 建物構造別</a>
        <a class="sidebar-link ${active('/stats/price')}" data-nav="/stats/price"><i class="fas fa-yen-sign w-5"></i> 単価別</a>
        <a class="sidebar-link ${active('/stats/lost')}" data-nav="/stats/lost"><i class="fas fa-ban w-5"></i> 失注理由別</a>
        <div class="mt-3 px-4 text-xs text-gray-500 uppercase tracking-wider">出力</div>
        <a class="sidebar-link ${active('/stats/export')}" data-nav="/stats/export"><i class="fas fa-download w-5"></i> CSV / PDF</a>
      </nav>
      <div class="p-4 border-t border-slate-700 mt-auto md:absolute md:bottom-0 md:w-60">
        <div class="text-sm text-gray-300">
          <i class="fas fa-user-circle"></i> ${escapeHtml(State.user?.display_name || '')}
        </div>
        <div class="text-xs text-gray-500 mb-2">${State.user?.role === 'admin' ? '管理者' : '一般ユーザー'}</div>
        <button class="btn btn-secondary btn-sm w-full" id="btn-logout"><i class="fas fa-sign-out-alt"></i> ログアウト</button>
      </div>
    </aside>

    <!-- メインコンテンツ -->
    <main class="flex-1 p-4 md:p-6" id="main-content"></main>
  </div>
  `;
}

function attachLayoutEvents() {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.nav);
    });
  });
  document.getElementById('btn-logout')?.addEventListener('click', logout);
}

// ========== ログイン画面 ==========
function renderLogin(app) {
  app.innerHTML = `
  <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-800 to-blue-900 p-4">
    <div class="bg-white rounded-lg shadow-2xl w-full max-w-md p-8">
      <div class="text-center mb-6">
        <div class="inline-block bg-blue-900 text-white p-3 rounded-full mb-3">
          <i class="fas fa-building text-3xl"></i>
        </div>
        <h1 class="text-2xl font-bold text-gray-800">村田鉄筋㈱</h1>
        <p class="text-gray-500 text-sm">見積データベース</p>
      </div>
      <form id="login-form" class="space-y-4">
        <div>
          <label class="form-label">ユーザー名</label>
          <input type="text" name="username" class="form-input" autocomplete="username" required />
        </div>
        <div>
          <label class="form-label">パスワード</label>
          <input type="password" name="password" class="form-input" autocomplete="current-password" required />
        </div>
        <div id="login-error" class="text-red-600 text-sm hidden"></div>
        <button type="submit" class="btn btn-primary w-full justify-center">
          <i class="fas fa-sign-in-alt"></i> ログイン
        </button>
      </form>
      <div class="mt-6 text-xs text-gray-500 border-t pt-4">
        <p><strong>テストアカウント:</strong></p>
        <p>管理者: admin / admin123</p>
        <p>一般: user / user123</p>
      </div>
    </div>
  </div>
  `;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = fd.get('username');
    const password = fd.get('password');
    const errorEl = document.getElementById('login-error');
    errorEl.classList.add('hidden');
    errorEl.innerHTML = '';
    try {
      // 同一オリジンの /api/login にPOST (相対パスなのでプレビュー/本番どちらでも自動的に同じドメインを使用)
      const { data } = await API.post('/api/login', { username, password });
      State.token = data.token;
      State.user = data.user;
      localStorage.setItem('murata_token', data.token);
      console.log('[LOGIN] success:', data.user);
      navigate('/dashboard');
    } catch (err) {
      // 詳細エラーをコンソールに出力 (開発者向け)
      console.error('[LOGIN] failed:', err);
      const resp = err.response;
      let msg = '';
      if (!resp) {
        msg = `ログインAPIに接続できません: ${err.message || '原因不明'}`;
      } else {
        msg = resp.data?.error || `HTTP ${resp.status} エラー`;
        if (resp.data?.hint) msg += `<br><span class="text-xs text-gray-500">ヒント: ${escapeHtml(resp.data.hint)}</span>`;
        if (resp.data?.detail) console.error('[LOGIN] detail:', resp.data.detail);
      }
      errorEl.innerHTML = msg;
      errorEl.classList.remove('hidden');
    }
  });
}

// ========== フィルタUI(共通) ==========
function filterPanel() {
  const f = State.filters;
  return `
  <div class="bg-white border rounded-lg p-4 mb-4 no-print">
    <div class="flex items-center justify-between mb-3">
      <div class="font-semibold text-gray-700"><i class="fas fa-filter"></i> 絞り込み</div>
      <button class="btn btn-secondary btn-sm" id="btn-reset-filter"><i class="fas fa-rotate-left"></i> リセット</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div>
        <label class="form-label text-xs">見積期間(開始)</label>
        <input type="date" class="form-input" data-filter="date_from" value="${f.date_from || ''}" />
      </div>
      <div>
        <label class="form-label text-xs">見積期間(終了)</label>
        <input type="date" class="form-input" data-filter="date_to" value="${f.date_to || ''}" />
      </div>
      <div>
        <label class="form-label text-xs">元請け会社名</label>
        <input type="text" class="form-input" data-filter="client_name" value="${escapeHtml(f.client_name || '')}" placeholder="部分一致" />
      </div>
      <div>
        <label class="form-label text-xs">建物の構造</label>
        <select class="form-select" data-filter="structure">
          <option value="">全て</option>
          ${STRUCTURES.map(s => `<option value="${s}" ${f.structure === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label text-xs">建物用途</label>
        <select class="form-select" data-filter="building_use">
          <option value="">全て</option>
          ${BUILDING_USES.map(s => `<option value="${s}" ${f.building_use === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label text-xs">材料区分</label>
        <select class="form-select" data-filter="material_type">
          <option value="">全て</option>
          ${MATERIAL_TYPES.map(s => `<option value="${s}" ${f.material_type === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label text-xs">結果</label>
        <select class="form-select" data-filter="result">
          <option value="">全て</option>
          ${RESULTS.map(s => `<option value="${s}" ${f.result === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label text-xs">見積担当者</label>
        <input type="text" class="form-input" data-filter="estimator" value="${escapeHtml(f.estimator || '')}" />
      </div>
      <div>
        <label class="form-label text-xs">単価下限(円/kg)</label>
        <input type="number" class="form-input" data-filter="price_min" value="${f.price_min || ''}" />
      </div>
      <div>
        <label class="form-label text-xs">単価上限(円/kg)</label>
        <input type="number" class="form-input" data-filter="price_max" value="${f.price_max || ''}" />
      </div>
      <div>
        <label class="form-label text-xs">失注理由</label>
        <select class="form-select" data-filter="lost_reason">
          <option value="">全て</option>
          ${LOST_REASONS.map(s => `<option value="${s}" ${f.lost_reason === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="form-label text-xs">キーワード検索</label>
        <input type="text" class="form-input" data-filter="search" value="${escapeHtml(f.search || '')}" placeholder="現場名・備考など" />
      </div>
    </div>
    <div class="mt-3 text-right">
      <button class="btn btn-primary" id="btn-apply-filter"><i class="fas fa-search"></i> 適用</button>
    </div>
  </div>
  `;
}

function attachFilterEvents(onApply) {
  const collect = () => {
    const filters = {};
    document.querySelectorAll('[data-filter]').forEach((el) => {
      if (el.value) filters[el.dataset.filter] = el.value;
    });
    State.filters = filters;
  };
  document.getElementById('btn-apply-filter')?.addEventListener('click', () => {
    collect();
    onApply();
  });
  document.getElementById('btn-reset-filter')?.addEventListener('click', () => {
    State.filters = {};
    onApply();
  });
  // Enter キー
  document.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { collect(); onApply(); }
    });
  });
}

// ========== ダッシュボード ==========
async function renderDashboard(main) {
  main.innerHTML = `
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-bold text-gray-800"><i class="fas fa-chart-pie text-blue-900"></i> ダッシュボード</h1>
      <div class="text-sm text-gray-500"><i class="fas fa-calendar"></i> ${dayjs().format('YYYY年MM月DD日')}</div>
    </div>
    ${filterPanel()}
    <div id="dash-content"><div class="text-center text-gray-400 py-10"><i class="fas fa-spinner fa-spin"></i> 集計中...</div></div>
  `;
  attachFilterEvents(renderDashboard.bind(null, main));
  await loadAndRenderDashboard();
}

async function loadAndRenderDashboard() {
  try {
    const { data } = await API.get('/api/stats', { params: State.filters });
    State.stats = data;
    const ov = data.overall || {};
    const orderRate = calcOrderRate(ov.won_count, ov.lost_count);

    document.getElementById('dash-content').innerHTML = `
      <!-- 全体集計カード -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div class="stat-card"><div class="label"><i class="fas fa-file-invoice"></i> 総見積件数</div><div class="value">${ov.total_count || 0}<span class="text-sm font-normal text-gray-500"> 件</span></div></div>
        <div class="stat-card" style="border-color:#10b981"><div class="label text-green-700"><i class="fas fa-check-circle"></i> 受注件数</div><div class="value text-green-600">${ov.won_count || 0}<span class="text-sm font-normal text-gray-500"> 件</span></div></div>
        <div class="stat-card" style="border-color:#ef4444"><div class="label text-red-700"><i class="fas fa-times-circle"></i> 失注件数</div><div class="value text-red-600">${ov.lost_count || 0}<span class="text-sm font-normal text-gray-500"> 件</span></div></div>
        <div class="stat-card" style="border-color:#f59e0b"><div class="label text-orange-700"><i class="fas fa-clock"></i> 未定件数</div><div class="value text-orange-600">${ov.pending_count || 0}<span class="text-sm font-normal text-gray-500"> 件</span></div></div>
        <div class="stat-card" style="border-color:#3b82f6"><div class="label"><i class="fas fa-percentage"></i> 受注率</div><div class="value">${orderRate.toFixed(1)}<span class="text-sm font-normal text-gray-500"> %</span></div></div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div class="stat-card"><div class="label">総見積金額</div><div class="value">${yen(ov.total_amount)}</div></div>
        <div class="stat-card" style="border-color:#10b981"><div class="label">受注金額合計</div><div class="value text-green-600">${yen(ov.won_amount)}</div></div>
        <div class="stat-card"><div class="label">平均単価</div><div class="value">${num(ov.avg_unit_price, 1)}<span class="text-sm font-normal text-gray-500"> 円/kg</span></div></div>
        <div class="stat-card"><div class="label">平均数量</div><div class="value">${num(ov.avg_quantity, 1)}<span class="text-sm font-normal text-gray-500"> t</span></div></div>
      </div>

      <!-- グラフ -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold text-gray-700 mb-2"><i class="fas fa-chart-bar"></i> 月別見積件数</div>
          <canvas id="chart-monthly" height="200"></canvas>
        </div>
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold text-gray-700 mb-2"><i class="fas fa-chart-pie"></i> 失注理由別</div>
          <canvas id="chart-lost" height="200"></canvas>
        </div>
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold text-gray-700 mb-2"><i class="fas fa-chart-bar"></i> 構造別見積件数</div>
          <canvas id="chart-structure" height="200"></canvas>
        </div>
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold text-gray-700 mb-2"><i class="fas fa-chart-line"></i> 単価帯別 受注率</div>
          <canvas id="chart-price" height="200"></canvas>
        </div>
      </div>

      <!-- 元請けTOP5 -->
      <div class="bg-white border rounded-lg p-4 mb-6">
        <div class="font-semibold text-gray-700 mb-3"><i class="fas fa-trophy text-yellow-500"></i> 元請け別 サマリ (TOP10)</div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th>元請け</th><th class="num-cell">見積</th><th class="num-cell">受注</th><th class="num-cell">失注</th><th class="num-cell">未定</th>
              <th class="num-cell">受注率</th><th class="num-cell">見積金額</th><th class="num-cell">受注金額</th>
            </tr></thead>
            <tbody>
              ${(data.by_client || []).slice(0, 10).map(r => `
                <tr>
                  <td>${escapeHtml(r.client_name)}</td>
                  <td class="num-cell">${r.total_count}</td>
                  <td class="num-cell text-green-600 font-semibold">${r.won_count}</td>
                  <td class="num-cell text-red-600">${r.lost_count}</td>
                  <td class="num-cell text-orange-600">${r.pending_count}</td>
                  <td class="num-cell font-semibold">${calcOrderRate(r.won_count, r.lost_count).toFixed(1)}%</td>
                  <td class="num-cell">${yen(r.total_amount)}</td>
                  <td class="num-cell">${yen(r.won_amount)}</td>
                </tr>
              `).join('') || '<tr><td colspan="8" class="text-center text-gray-400">データなし</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    drawDashboardCharts(data);
  } catch (err) {
    document.getElementById('dash-content').innerHTML = `<div class="text-red-600 p-4">読み込みエラー: ${err.message}</div>`;
  }
}

function destroyChart(id) {
  if (State.charts[id]) { State.charts[id].destroy(); delete State.charts[id]; }
}

function drawDashboardCharts(data) {
  // 月別
  destroyChart('monthly');
  const m = data.by_month || [];
  State.charts.monthly = new Chart(document.getElementById('chart-monthly'), {
    type: 'bar',
    data: {
      labels: m.map(x => x.month),
      datasets: [
        { label: '見積', data: m.map(x => x.total_count), backgroundColor: '#3b82f6' },
        { label: '受注', data: m.map(x => x.won_count), backgroundColor: '#10b981' },
        { label: '失注', data: m.map(x => x.lost_count), backgroundColor: '#ef4444' },
      ]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });

  // 失注理由
  destroyChart('lost');
  const l = data.by_lost_reason || [];
  State.charts.lost = new Chart(document.getElementById('chart-lost'), {
    type: 'doughnut',
    data: {
      labels: l.map(x => x.lost_reason),
      datasets: [{ data: l.map(x => x.count), backgroundColor: ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#6b7280'] }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });

  // 構造別
  destroyChart('structure');
  const s = data.by_structure || [];
  State.charts.structure = new Chart(document.getElementById('chart-structure'), {
    type: 'bar',
    data: {
      labels: s.map(x => x.structure),
      datasets: [{ label: '見積件数', data: s.map(x => x.total_count), backgroundColor: '#1e3a8a' }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });

  // 単価帯別受注率
  destroyChart('price');
  const p = data.by_price || [];
  State.charts.price = new Chart(document.getElementById('chart-price'), {
    type: 'bar',
    data: {
      labels: p.map(x => x.price_range),
      datasets: [{ label: '受注率(%)', data: p.map(x => calcOrderRate(x.won_count, x.lost_count).toFixed(1)), backgroundColor: '#10b981' }]
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { max: 100 } }, plugins: { legend: { display: false } } }
  });
}

// ========== 見積一覧 ==========
async function renderEstimateList(main) {
  main.innerHTML = `
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-bold text-gray-800"><i class="fas fa-list text-blue-900"></i> 見積データ一覧</h1>
      <div class="flex gap-2">
        <button class="btn btn-secondary" id="btn-csv-list"><i class="fas fa-file-csv"></i> CSV出力</button>
        <button class="btn btn-primary" data-nav="/estimates/new"><i class="fas fa-plus"></i> 新規登録</button>
      </div>
    </div>
    ${filterPanel()}
    <div id="list-content"></div>
  `;
  attachLayoutEvents();
  attachFilterEvents(() => renderEstimateList(main));
  document.getElementById('btn-csv-list').addEventListener('click', () => exportCSV('estimates'));
  await loadAndRenderList();
}

let listSortField = 'estimate_date';
let listSortOrder = 'desc';

async function loadAndRenderList() {
  try {
    const params = { ...State.filters, sort: listSortField, order: listSortOrder };
    const { data } = await API.get('/api/estimates', { params });
    State.estimates = data.estimates;
    const isAdmin = State.user?.role === 'admin';

    const sortIcon = (f) => listSortField === f ? `<i class="fas fa-sort-${listSortOrder === 'asc' ? 'up' : 'down'}"></i>` : '<i class="fas fa-sort text-gray-400"></i>';

    document.getElementById('list-content').innerHTML = `
      <div class="bg-white border rounded-lg overflow-hidden">
        <div class="p-3 bg-gray-50 border-b text-sm text-gray-600">
          件数: <strong>${data.estimates.length}</strong> 件
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th class="cursor-pointer" data-sort="estimate_date">見積日 ${sortIcon('estimate_date')}</th>
              <th class="cursor-pointer" data-sort="estimate_no">見積番号 ${sortIcon('estimate_no')}</th>
              <th class="cursor-pointer" data-sort="client_name">元請け ${sortIcon('client_name')}</th>
              <th class="cursor-pointer" data-sort="site_name">現場名 ${sortIcon('site_name')}</th>
              <th class="cursor-pointer" data-sort="structure">構造 ${sortIcon('structure')}</th>
              <th class="cursor-pointer num-cell" data-sort="rebar_quantity">数量(t) ${sortIcon('rebar_quantity')}</th>
              <th class="cursor-pointer num-cell" data-sort="estimate_amount">見積金額 ${sortIcon('estimate_amount')}</th>
              <th class="cursor-pointer num-cell" data-sort="unit_price">単価(円/kg) ${sortIcon('unit_price')}</th>
              <th class="cursor-pointer" data-sort="result">結果 ${sortIcon('result')}</th>
              <th>失注理由</th>
              <th>備考</th>
              <th>操作</th>
            </tr></thead>
            <tbody>
              ${data.estimates.map(e => `
                <tr>
                  <td>${e.estimate_date || ''}</td>
                  <td>${escapeHtml(e.estimate_no)}</td>
                  <td>${escapeHtml(e.client_name)}</td>
                  <td>${escapeHtml(e.site_name)}</td>
                  <td>${escapeHtml(e.structure || '-')}</td>
                  <td class="num-cell">${num(e.rebar_quantity)}</td>
                  <td class="num-cell">${yen(e.estimate_amount)}</td>
                  <td class="num-cell">${num(e.unit_price, 1)}</td>
                  <td>${resultBadge(e.result)}</td>
                  <td>${escapeHtml(e.lost_reason || '-')}</td>
                  <td class="max-w-xs truncate" title="${escapeHtml(e.remarks || '')}">${escapeHtml(e.remarks || '-')}</td>
                  <td class="whitespace-nowrap">
                    <button class="btn btn-secondary btn-sm" data-edit="${e.id}"><i class="fas fa-edit"></i></button>
                    ${isAdmin ? `<button class="btn btn-danger btn-sm" data-delete="${e.id}"><i class="fas fa-trash"></i></button>` : ''}
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="12" class="text-center text-gray-400 py-6">データがありません</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // ソート
    document.querySelectorAll('[data-sort]').forEach(el => {
      el.addEventListener('click', () => {
        const f = el.dataset.sort;
        if (listSortField === f) listSortOrder = listSortOrder === 'asc' ? 'desc' : 'asc';
        else { listSortField = f; listSortOrder = 'asc'; }
        loadAndRenderList();
      });
    });
    // 編集
    document.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', () => navigate('/estimates/' + el.dataset.edit));
    });
    // 削除
    document.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', async () => {
        if (!confirm('この見積データを削除しますか?')) return;
        try {
          await API.delete('/api/estimates/' + el.dataset.delete);
          loadAndRenderList();
        } catch (err) {
          alert(err.response?.data?.error || '削除に失敗しました');
        }
      });
    });
  } catch (err) {
    document.getElementById('list-content').innerHTML = `<div class="text-red-600 p-4">${err.message}</div>`;
  }
}

// ========== 見積フォーム (新規/編集) ==========
async function renderEstimateForm(main, id) {
  const isEdit = !!id;
  let data = {
    estimate_no: '', estimate_date: dayjs().format('YYYY-MM-DD'),
    result: '未定', material_type: '材工',
  };
  if (isEdit) {
    try {
      const res = await API.get('/api/estimates/' + id);
      data = res.data.estimate;
    } catch (err) {
      main.innerHTML = `<div class="text-red-600 p-4">${err.message}</div>`;
      return;
    }
  }

  main.innerHTML = `
    <div class="mb-4 flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-800">
        <i class="fas fa-${isEdit ? 'edit' : 'plus'} text-blue-900"></i>
        ${isEdit ? '見積データ編集' : '新規見積登録'}
      </h1>
      <button class="btn btn-secondary" data-nav="/estimates"><i class="fas fa-arrow-left"></i> 一覧に戻る</button>
    </div>
    <form id="estimate-form" class="bg-white border rounded-lg p-4 md:p-6 space-y-6">
      <!-- 基本情報 -->
      <fieldset>
        <legend class="text-sm font-bold text-blue-900 border-b border-blue-900 pb-1 mb-3 w-full"><i class="fas fa-info-circle"></i> 基本情報</legend>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div><label class="form-label">見積番号 *</label><input type="text" name="estimate_no" class="form-input" value="${escapeHtml(data.estimate_no || '')}" required /></div>
          <div><label class="form-label">見積日 *</label><input type="date" name="estimate_date" class="form-input" value="${data.estimate_date || ''}" required /></div>
          <div><label class="form-label">見積担当者</label><input type="text" name="estimator" class="form-input" value="${escapeHtml(data.estimator || '')}" /></div>
        </div>
      </fieldset>

      <!-- 元請け・現場 -->
      <fieldset>
        <legend class="text-sm font-bold text-blue-900 border-b border-blue-900 pb-1 mb-3 w-full"><i class="fas fa-handshake"></i> 元請け・現場</legend>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><label class="form-label">元請け会社名 *</label><input type="text" name="client_name" class="form-input" value="${escapeHtml(data.client_name || '')}" required /></div>
          <div><label class="form-label">現場名 *</label><input type="text" name="site_name" class="form-input" value="${escapeHtml(data.site_name || '')}" required /></div>
          <div><label class="form-label">工事場所</label><input type="text" name="site_location" class="form-input" value="${escapeHtml(data.site_location || '')}" /></div>
          <div><label class="form-label">元請け担当者名</label><input type="text" name="client_contact_name" class="form-input" value="${escapeHtml(data.client_contact_name || '')}" /></div>
          <div class="md:col-span-2"><label class="form-label">元請け担当者の連絡先</label><input type="text" name="client_contact_info" class="form-input" value="${escapeHtml(data.client_contact_info || '')}" placeholder="電話・メールなど" /></div>
        </div>
      </fieldset>

      <!-- 建物情報 -->
      <fieldset>
        <legend class="text-sm font-bold text-blue-900 border-b border-blue-900 pb-1 mb-3 w-full"><i class="fas fa-building"></i> 建物情報</legend>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label class="form-label">建物の構造</label>
            <input type="text" name="structure" class="form-input" value="${escapeHtml(data.structure || '')}" list="structure-list" placeholder="RC造、S造など (自由入力可)" />
            <datalist id="structure-list">${STRUCTURES.map(s => `<option value="${s}"></option>`).join('')}</datalist>
          </div>
          <div>
            <label class="form-label">建物用途</label>
            <input type="text" name="building_use" class="form-input" value="${escapeHtml(data.building_use || '')}" list="use-list" placeholder="マンション、工場など" />
            <datalist id="use-list">${BUILDING_USES.map(s => `<option value="${s}"></option>`).join('')}</datalist>
          </div>
        </div>
      </fieldset>

      <!-- 数量・金額 -->
      <fieldset>
        <legend class="text-sm font-bold text-blue-900 border-b border-blue-900 pb-1 mb-3 w-full"><i class="fas fa-calculator"></i> 数量・金額 <span class="text-xs text-gray-500 font-normal">(数量と見積金額を入力すると単価が自動計算されます)</span></legend>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div><label class="form-label">鉄筋数量 (t)</label><input type="number" step="0.01" name="rebar_quantity" id="f_quantity" class="form-input" value="${data.rebar_quantity || ''}" /></div>
          <div><label class="form-label">見積金額 (円)</label><input type="number" step="1" name="estimate_amount" id="f_amount" class="form-input" value="${data.estimate_amount || ''}" /></div>
          <div><label class="form-label">単価 (円/kg)</label><input type="number" step="0.01" name="unit_price" id="f_unitprice" class="form-input bg-blue-50" value="${data.unit_price || ''}" /></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          <div>
            <label class="form-label">材料区分</label>
            <select name="material_type" class="form-select">
              <option value="">選択</option>
              ${MATERIAL_TYPES.map(s => `<option value="${s}" ${data.material_type === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div><label class="form-label">予想実行単価 (円/kg)</label><input type="number" step="0.01" name="expected_actual_unit_price" class="form-input" value="${data.expected_actual_unit_price || ''}" /></div>
          <div><label class="form-label">利益見込み (円)</label><input type="number" step="1" name="profit_estimate" class="form-input" value="${data.profit_estimate || ''}" /></div>
        </div>
      </fieldset>

      <!-- 工期 -->
      <fieldset>
        <legend class="text-sm font-bold text-blue-900 border-b border-blue-900 pb-1 mb-3 w-full"><i class="fas fa-clock"></i> 工期・スケジュール</legend>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div><label class="form-label">工期</label><input type="text" name="construction_period" class="form-input" value="${escapeHtml(data.construction_period || '')}" placeholder="例: 12ヶ月" /></div>
          <div><label class="form-label">着工予定日</label><input type="date" name="construction_start_date" class="form-input" value="${data.construction_start_date || ''}" /></div>
          <div><label class="form-label">加工開始予定日</label><input type="date" name="processing_start_date" class="form-input" value="${data.processing_start_date || ''}" /></div>
          <div>
            <label class="form-label">難易度</label>
            <select name="difficulty" class="form-select">
              <option value="">選択</option>
              ${DIFFICULTIES.map(s => `<option value="${s}" ${data.difficulty === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div><label class="form-label">現場担当予定者</label><input type="text" name="site_manager" class="form-input" value="${escapeHtml(data.site_manager || '')}" /></div>
          <div class="flex items-center pt-6">
            <label class="inline-flex items-center gap-2">
              <input type="checkbox" name="re_estimate" value="1" ${data.re_estimate ? 'checked' : ''} />
              <span class="text-sm">再見積</span>
            </label>
          </div>
        </div>
      </fieldset>

      <!-- 結果 -->
      <fieldset>
        <legend class="text-sm font-bold text-blue-900 border-b border-blue-900 pb-1 mb-3 w-full"><i class="fas fa-flag-checkered"></i> 結果</legend>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label class="form-label">結果 *</label>
            <select name="result" id="f_result" class="form-select" required>
              ${RESULTS.map(s => `<option value="${s}" ${data.result === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div id="f_lost_wrap">
            <label class="form-label">失注理由</label>
            <select name="lost_reason" class="form-select">
              <option value="">選択</option>
              ${LOST_REASONS.map(s => `<option value="${s}" ${data.lost_reason === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div><label class="form-label">受注日</label><input type="date" name="order_date" class="form-input" value="${data.order_date || ''}" /></div>
          <div class="md:col-span-3"><label class="form-label">競合会社名</label><input type="text" name="competitor" class="form-input" value="${escapeHtml(data.competitor || '')}" placeholder="競合があれば入力" /></div>
        </div>
      </fieldset>

      <!-- 備考 -->
      <fieldset>
        <legend class="text-sm font-bold text-blue-900 border-b border-blue-900 pb-1 mb-3 w-full"><i class="fas fa-comment"></i> 備考</legend>
        <textarea name="remarks" class="form-textarea" rows="3">${escapeHtml(data.remarks || '')}</textarea>
      </fieldset>

      <div class="flex justify-end gap-2 pt-4 border-t">
        <button type="button" class="btn btn-secondary" data-nav="/estimates"><i class="fas fa-times"></i> キャンセル</button>
        <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> ${isEdit ? '更新' : '登録'}</button>
      </div>
    </form>
  `;
  attachLayoutEvents();

  // 自動計算: 単価 = 見積金額 ÷ 数量 ÷ 1000
  const qEl = document.getElementById('f_quantity');
  const aEl = document.getElementById('f_amount');
  const uEl = document.getElementById('f_unitprice');
  const updateUnitPrice = () => {
    const q = parseFloat(qEl.value);
    const a = parseFloat(aEl.value);
    if (q > 0 && a > 0) {
      uEl.value = (a / q / 1000).toFixed(2);
    }
  };
  qEl.addEventListener('input', updateUnitPrice);
  aEl.addEventListener('input', updateUnitPrice);

  // 失注理由の表示制御
  const resultEl = document.getElementById('f_result');
  const updateLostVisibility = () => {
    document.getElementById('f_lost_wrap').style.display = resultEl.value === '失注' ? '' : '';
  };
  resultEl.addEventListener('change', updateLostVisibility);

  // 送信
  document.getElementById('estimate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.re_estimate = fd.get('re_estimate') ? 1 : 0;
    try {
      if (isEdit) await API.put('/api/estimates/' + id, body);
      else await API.post('/api/estimates', body);
      navigate('/estimates');
    } catch (err) {
      alert(err.response?.data?.error || '保存に失敗しました');
    }
  });
}

// ========== 集計画面 ==========
async function renderStats(main, type) {
  const titles = {
    clients: { icon: 'handshake', name: '元請け別集計' },
    structure: { icon: 'building', name: '建物構造別集計' },
    price: { icon: 'yen-sign', name: '単価別集計' },
    lost: { icon: 'ban', name: '失注理由別集計' },
  };
  const t = titles[type];
  main.innerHTML = `
    <div class="mb-4 flex items-center justify-between">
      <h1 class="text-2xl font-bold text-gray-800"><i class="fas fa-${t.icon} text-blue-900"></i> ${t.name}</h1>
      <button class="btn btn-secondary" id="btn-csv-stats"><i class="fas fa-file-csv"></i> CSV出力</button>
    </div>
    ${filterPanel()}
    <div id="stats-content"><div class="text-center text-gray-400 py-10"><i class="fas fa-spinner fa-spin"></i></div></div>
  `;
  attachFilterEvents(() => renderStats(main, type));
  document.getElementById('btn-csv-stats').addEventListener('click', () => exportCSV(type));

  try {
    const { data } = await API.get('/api/stats', { params: State.filters });
    State.stats = data;
    renderStatsTable(type, data);
  } catch (err) {
    document.getElementById('stats-content').innerHTML = `<div class="text-red-600">${err.message}</div>`;
  }
}

function renderStatsTable(type, data) {
  const content = document.getElementById('stats-content');
  if (type === 'clients') {
    const rows = data.by_client || [];
    content.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold mb-2"><i class="fas fa-chart-bar"></i> 元請け別 受注率</div>
          <canvas id="chart-client-rate" height="200"></canvas>
        </div>
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold mb-2"><i class="fas fa-chart-bar"></i> 元請け別 見積金額</div>
          <canvas id="chart-client-amount" height="200"></canvas>
        </div>
      </div>
      <div class="bg-white border rounded-lg overflow-hidden">
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th>元請け会社</th><th class="num-cell">見積件数</th><th class="num-cell">受注</th><th class="num-cell">失注</th><th class="num-cell">未定</th>
              <th class="num-cell">受注率</th><th class="num-cell">見積金額合計</th><th class="num-cell">受注金額合計</th>
              <th class="num-cell">平均単価</th><th class="num-cell">平均数量</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => {
                const rate = calcOrderRate(r.won_count, r.lost_count);
                const rateClass = rate >= 70 ? 'text-green-700 font-bold' : rate >= 40 ? 'text-orange-600' : 'text-red-600';
                return `<tr>
                  <td>${escapeHtml(r.client_name)}</td>
                  <td class="num-cell">${r.total_count}</td>
                  <td class="num-cell text-green-600">${r.won_count}</td>
                  <td class="num-cell text-red-600">${r.lost_count}</td>
                  <td class="num-cell text-orange-600">${r.pending_count}</td>
                  <td class="num-cell ${rateClass}">${rate.toFixed(1)}%</td>
                  <td class="num-cell">${yen(r.total_amount)}</td>
                  <td class="num-cell">${yen(r.won_amount)}</td>
                  <td class="num-cell">${num(r.avg_unit_price, 1)}</td>
                  <td class="num-cell">${num(r.avg_quantity, 1)}</td>
                </tr>`;
              }).join('') || '<tr><td colspan="10" class="text-center text-gray-400">データなし</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
    destroyChart('client-rate');
    State.charts['client-rate'] = new Chart(document.getElementById('chart-client-rate'), {
      type: 'bar',
      data: {
        labels: rows.map(r => r.client_name),
        datasets: [{ label: '受注率(%)', data: rows.map(r => calcOrderRate(r.won_count, r.lost_count).toFixed(1)), backgroundColor: '#10b981' }]
      },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { max: 100 } } }
    });
    destroyChart('client-amount');
    State.charts['client-amount'] = new Chart(document.getElementById('chart-client-amount'), {
      type: 'bar',
      data: {
        labels: rows.map(r => r.client_name),
        datasets: [
          { label: '見積金額', data: rows.map(r => r.total_amount), backgroundColor: '#3b82f6' },
          { label: '受注金額', data: rows.map(r => r.won_amount), backgroundColor: '#10b981' },
        ]
      },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false }
    });

  } else if (type === 'structure') {
    const rows = data.by_structure || [];
    content.innerHTML = `
      <div class="bg-white border rounded-lg p-4 mb-4">
        <div class="font-semibold mb-2"><i class="fas fa-chart-bar"></i> 構造別 件数と受注率</div>
        <canvas id="chart-struct" height="180"></canvas>
      </div>
      <div class="bg-white border rounded-lg overflow-hidden">
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th>構造</th><th class="num-cell">見積件数</th><th class="num-cell">受注</th><th class="num-cell">失注</th>
              <th class="num-cell">受注率</th><th class="num-cell">平均単価</th><th class="num-cell">平均数量</th><th class="num-cell">見積金額合計</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `<tr>
                <td><strong>${escapeHtml(r.structure)}</strong></td>
                <td class="num-cell">${r.total_count}</td>
                <td class="num-cell text-green-600">${r.won_count}</td>
                <td class="num-cell text-red-600">${r.lost_count}</td>
                <td class="num-cell font-semibold">${calcOrderRate(r.won_count, r.lost_count).toFixed(1)}%</td>
                <td class="num-cell">${num(r.avg_unit_price, 1)}</td>
                <td class="num-cell">${num(r.avg_quantity, 1)}</td>
                <td class="num-cell">${yen(r.total_amount)}</td>
              </tr>`).join('') || '<tr><td colspan="8" class="text-center text-gray-400">データなし</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
    destroyChart('struct');
    State.charts['struct'] = new Chart(document.getElementById('chart-struct'), {
      type: 'bar',
      data: {
        labels: rows.map(r => r.structure),
        datasets: [
          { label: '見積件数', data: rows.map(r => r.total_count), backgroundColor: '#3b82f6', yAxisID: 'y' },
          { label: '受注率(%)', data: rows.map(r => calcOrderRate(r.won_count, r.lost_count).toFixed(1)), backgroundColor: '#10b981', type: 'line', yAxisID: 'y1', borderColor: '#10b981' },
        ]
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { position: 'left' }, y1: { position: 'right', max: 100, grid: { drawOnChartArea: false } } } }
    });

  } else if (type === 'price') {
    const rows = data.by_price || [];
    content.innerHTML = `
      <div class="bg-white border rounded-lg p-4 mb-4">
        <div class="font-semibold mb-2"><i class="fas fa-chart-bar"></i> 単価帯別 受注率</div>
        <canvas id="chart-price-rate" height="180"></canvas>
      </div>
      <div class="bg-white border rounded-lg overflow-hidden">
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr>
              <th>単価帯</th><th class="num-cell">見積件数</th><th class="num-cell">受注</th><th class="num-cell">失注</th>
              <th class="num-cell">受注率</th><th class="num-cell">平均数量</th><th class="num-cell">見積金額合計</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `<tr>
                <td><strong>${escapeHtml(r.price_range)}</strong></td>
                <td class="num-cell">${r.total_count}</td>
                <td class="num-cell text-green-600">${r.won_count}</td>
                <td class="num-cell text-red-600">${r.lost_count}</td>
                <td class="num-cell font-semibold">${calcOrderRate(r.won_count, r.lost_count).toFixed(1)}%</td>
                <td class="num-cell">${num(r.avg_quantity, 1)}</td>
                <td class="num-cell">${yen(r.total_amount)}</td>
              </tr>`).join('') || '<tr><td colspan="7" class="text-center text-gray-400">データなし</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
    destroyChart('price-rate');
    State.charts['price-rate'] = new Chart(document.getElementById('chart-price-rate'), {
      type: 'bar',
      data: {
        labels: rows.map(r => r.price_range),
        datasets: [
          { label: '見積件数', data: rows.map(r => r.total_count), backgroundColor: '#3b82f6' },
          { label: '受注', data: rows.map(r => r.won_count), backgroundColor: '#10b981' },
          { label: '失注', data: rows.map(r => r.lost_count), backgroundColor: '#ef4444' },
        ]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });

  } else if (type === 'lost') {
    const rows = data.by_lost_reason || [];
    content.innerHTML = `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold mb-2"><i class="fas fa-chart-pie"></i> 失注理由別 円グラフ</div>
          <canvas id="chart-lost-pie" height="200"></canvas>
        </div>
        <div class="bg-white border rounded-lg p-4">
          <div class="font-semibold mb-2"><i class="fas fa-chart-bar"></i> 失注理由別 件数</div>
          <canvas id="chart-lost-bar" height="200"></canvas>
        </div>
      </div>
      <div class="bg-white border rounded-lg overflow-hidden">
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>失注理由</th><th class="num-cell">件数</th><th class="num-cell">割合</th></tr></thead>
            <tbody>
              ${(() => {
                const total = rows.reduce((s, r) => s + r.count, 0);
                return rows.map(r => `<tr>
                  <td>${escapeHtml(r.lost_reason)}</td>
                  <td class="num-cell font-bold">${r.count}</td>
                  <td class="num-cell">${total > 0 ? ((r.count / total) * 100).toFixed(1) : 0}%</td>
                </tr>`).join('') || '<tr><td colspan="3" class="text-center text-gray-400">データなし</td></tr>';
              })()}
            </tbody>
          </table>
        </div>
      </div>
    `;
    const colors = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#6b7280'];
    destroyChart('lost-pie');
    State.charts['lost-pie'] = new Chart(document.getElementById('chart-lost-pie'), {
      type: 'pie',
      data: { labels: rows.map(r => r.lost_reason), datasets: [{ data: rows.map(r => r.count), backgroundColor: colors }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
    destroyChart('lost-bar');
    State.charts['lost-bar'] = new Chart(document.getElementById('chart-lost-bar'), {
      type: 'bar',
      data: { labels: rows.map(r => r.lost_reason), datasets: [{ label: '件数', data: rows.map(r => r.count), backgroundColor: colors }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }
}

// ========== CSV / PDF 出力画面 ==========
function renderExport(main) {
  main.innerHTML = `
    <div class="mb-4">
      <h1 class="text-2xl font-bold text-gray-800"><i class="fas fa-download text-blue-900"></i> CSV / PDF 出力</h1>
      <p class="text-gray-500 text-sm mt-1">現在の絞り込み条件が適用されます。</p>
    </div>
    ${filterPanel()}
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="bg-white border rounded-lg p-5">
        <h2 class="font-bold text-lg mb-3"><i class="fas fa-file-csv text-green-600"></i> CSV出力</h2>
        <div class="space-y-2">
          <button class="btn btn-secondary w-full justify-start" data-csv="estimates"><i class="fas fa-list"></i> 見積データ一覧 CSV</button>
          <button class="btn btn-secondary w-full justify-start" data-csv="clients"><i class="fas fa-handshake"></i> 元請け別集計 CSV</button>
          <button class="btn btn-secondary w-full justify-start" data-csv="structure"><i class="fas fa-building"></i> 構造別集計 CSV</button>
          <button class="btn btn-secondary w-full justify-start" data-csv="price"><i class="fas fa-yen-sign"></i> 単価別集計 CSV</button>
          <button class="btn btn-secondary w-full justify-start" data-csv="lost"><i class="fas fa-ban"></i> 失注理由別集計 CSV</button>
        </div>
      </div>
      <div class="bg-white border rounded-lg p-5">
        <h2 class="font-bold text-lg mb-3"><i class="fas fa-file-pdf text-red-600"></i> PDF出力</h2>
        <p class="text-sm text-gray-500 mb-3">集計ダッシュボードをA4横向きでPDF出力します。</p>
        <button class="btn btn-primary w-full justify-center" id="btn-pdf"><i class="fas fa-file-pdf"></i> 集計ダッシュボードをPDF出力</button>
      </div>
    </div>
  `;
  attachFilterEvents(() => renderExport(main));
  document.querySelectorAll('[data-csv]').forEach(el => {
    el.addEventListener('click', () => exportCSV(el.dataset.csv));
  });
  document.getElementById('btn-pdf').addEventListener('click', exportPDF);
}

// ========== CSV出力 ==========
async function exportCSV(type) {
  let rows = [], headers = [], filename = '';
  if (type === 'estimates') {
    const { data } = await API.get('/api/estimates', { params: State.filters });
    headers = ['見積番号','見積日','元請け','現場名','工事場所','構造','建物用途','数量(t)','見積金額','単価(円/kg)','材料区分','担当者','結果','失注理由','受注日','備考','競合','予想実行単価','利益見込み','工期','着工予定日','加工開始予定日','難易度','現場担当','再見積','元請担当者','連絡先'];
    rows = data.estimates.map(e => [
      e.estimate_no, e.estimate_date, e.client_name, e.site_name, e.site_location, e.structure, e.building_use,
      e.rebar_quantity, e.estimate_amount, e.unit_price, e.material_type, e.estimator, e.result, e.lost_reason,
      e.order_date, e.remarks, e.competitor, e.expected_actual_unit_price, e.profit_estimate, e.construction_period,
      e.construction_start_date, e.processing_start_date, e.difficulty, e.site_manager, e.re_estimate ? '有' : '', e.client_contact_name, e.client_contact_info
    ]);
    filename = `見積データ一覧_${dayjs().format('YYYYMMDD')}.csv`;
  } else {
    const { data } = await API.get('/api/stats', { params: State.filters });
    if (type === 'clients') {
      headers = ['元請け','見積件数','受注','失注','未定','受注率(%)','見積金額合計','受注金額合計','平均単価','平均数量'];
      rows = (data.by_client || []).map(r => [r.client_name, r.total_count, r.won_count, r.lost_count, r.pending_count, calcOrderRate(r.won_count, r.lost_count).toFixed(1), r.total_amount, r.won_amount, num(r.avg_unit_price, 1), num(r.avg_quantity, 1)]);
      filename = `元請け別集計_${dayjs().format('YYYYMMDD')}.csv`;
    } else if (type === 'structure') {
      headers = ['構造','見積件数','受注','失注','未定','受注率(%)','平均単価','平均数量','見積金額合計'];
      rows = (data.by_structure || []).map(r => [r.structure, r.total_count, r.won_count, r.lost_count, r.pending_count, calcOrderRate(r.won_count, r.lost_count).toFixed(1), num(r.avg_unit_price, 1), num(r.avg_quantity, 1), r.total_amount]);
      filename = `構造別集計_${dayjs().format('YYYYMMDD')}.csv`;
    } else if (type === 'price') {
      headers = ['単価帯','見積件数','受注','失注','未定','受注率(%)','平均数量','見積金額合計'];
      rows = (data.by_price || []).map(r => [r.price_range, r.total_count, r.won_count, r.lost_count, r.pending_count, calcOrderRate(r.won_count, r.lost_count).toFixed(1), num(r.avg_quantity, 1), r.total_amount]);
      filename = `単価別集計_${dayjs().format('YYYYMMDD')}.csv`;
    } else if (type === 'lost') {
      headers = ['失注理由','件数'];
      rows = (data.by_lost_reason || []).map(r => [r.lost_reason, r.count]);
      filename = `失注理由別集計_${dayjs().format('YYYYMMDD')}.csv`;
    }
  }

  const csv = [headers, ...rows].map(r =>
    r.map(c => c == null ? '' : '"' + String(c).replace(/"/g, '""') + '"').join(',')
  ).join('\n');
  // BOM追加 (Excel対応)
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ========== PDF出力 ==========
async function exportPDF() {
  // ダッシュボードページに遷移してから取得
  if (!State.stats) {
    const { data } = await API.get('/api/stats', { params: State.filters });
    State.stats = data;
  }
  const stats = State.stats;
  const ov = stats.overall || {};

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  // 日本語フォント未組み込みのため、英数字＋一部カナで対応 (記号は ¥ は使えない)
  const today = dayjs().format('YYYY-MM-DD');

  let y = 12;
  pdf.setFontSize(16);
  pdf.text('Murata Tekkin Co., Ltd. - Estimate Summary', 14, y);
  y += 6;
  pdf.setFontSize(10);
  pdf.text(`Date: ${today}`, 14, y);
  if (State.filters.date_from || State.filters.date_to) {
    pdf.text(`Period: ${State.filters.date_from || ''} ~ ${State.filters.date_to || ''}`, 100, y);
  }
  y += 8;

  // 全体集計
  pdf.setFontSize(12);
  pdf.text('[ Overall Summary ]', 14, y); y += 6;
  pdf.setFontSize(9);
  const overallRows = [
    ['Total Estimates', ov.total_count || 0, 'Total Amount (JPY)', Math.round(ov.total_amount || 0).toLocaleString()],
    ['Won', ov.won_count || 0, 'Won Amount (JPY)', Math.round(ov.won_amount || 0).toLocaleString()],
    ['Lost', ov.lost_count || 0, 'Avg Unit Price (JPY/kg)', num(ov.avg_unit_price, 1)],
    ['Pending', ov.pending_count || 0, 'Avg Quantity (t)', num(ov.avg_quantity, 1)],
    ['Win Rate (%)', calcOrderRate(ov.won_count, ov.lost_count).toFixed(1), '', ''],
  ];
  drawPdfTable(pdf, 14, y, [50, 30, 60, 50], overallRows);
  y += overallRows.length * 6 + 8;

  // 元請け別 (TOP10)
  pdf.setFontSize(12);
  pdf.text('[ By Client (TOP 10) ]', 14, y); y += 6;
  pdf.setFontSize(8);
  drawPdfTable(pdf, 14, y,
    [50, 18, 18, 18, 18, 22, 38, 38],
    [['Client', 'Total', 'Won', 'Lost', 'Pend', 'Win%', 'Amount(JPY)', 'Won Amount(JPY)'],
     ...((stats.by_client || []).slice(0, 10).map(r => [
        r.client_name, r.total_count, r.won_count, r.lost_count, r.pending_count,
        calcOrderRate(r.won_count, r.lost_count).toFixed(1) + '%',
        Math.round(r.total_amount || 0).toLocaleString(),
        Math.round(r.won_amount || 0).toLocaleString(),
      ]))],
    true
  );
  y += (Math.min((stats.by_client || []).length, 10) + 1) * 5 + 6;

  // 新ページ
  pdf.addPage(); y = 12;
  pdf.setFontSize(12);
  pdf.text('[ By Structure ]', 14, y); y += 6;
  pdf.setFontSize(8);
  drawPdfTable(pdf, 14, y,
    [40, 22, 20, 20, 20, 24, 28, 28, 38],
    [['Structure', 'Total', 'Won', 'Lost', 'Pend', 'Win%', 'Avg Price', 'Avg Qty', 'Amount(JPY)'],
     ...((stats.by_structure || []).map(r => [
        r.structure, r.total_count, r.won_count, r.lost_count, r.pending_count,
        calcOrderRate(r.won_count, r.lost_count).toFixed(1) + '%',
        num(r.avg_unit_price, 1), num(r.avg_quantity, 1),
        Math.round(r.total_amount || 0).toLocaleString(),
      ]))],
    true
  );
  y += ((stats.by_structure || []).length + 1) * 5 + 8;

  pdf.setFontSize(12);
  pdf.text('[ By Unit Price Range ]', 14, y); y += 6;
  pdf.setFontSize(8);
  drawPdfTable(pdf, 14, y,
    [40, 22, 20, 20, 20, 24, 28, 38],
    [['Range', 'Total', 'Won', 'Lost', 'Pend', 'Win%', 'Avg Qty', 'Amount(JPY)'],
     ...((stats.by_price || []).map(r => [
        r.price_range, r.total_count, r.won_count, r.lost_count, r.pending_count,
        calcOrderRate(r.won_count, r.lost_count).toFixed(1) + '%',
        num(r.avg_quantity, 1),
        Math.round(r.total_amount || 0).toLocaleString(),
      ]))],
    true
  );
  y += ((stats.by_price || []).length + 1) * 5 + 8;

  pdf.setFontSize(12);
  pdf.text('[ By Lost Reason ]', 14, y); y += 6;
  pdf.setFontSize(8);
  drawPdfTable(pdf, 14, y,
    [60, 30],
    [['Reason', 'Count'],
     ...((stats.by_lost_reason || []).map(r => [r.lost_reason, r.count]))],
    true
  );

  // ダッシュボードグラフがあればキャプチャ
  if (document.getElementById('chart-monthly')) {
    pdf.addPage(); y = 12;
    pdf.setFontSize(12);
    pdf.text('[ Charts ]', 14, y); y += 8;
    try {
      const charts = ['chart-monthly', 'chart-lost', 'chart-structure', 'chart-price'];
      for (let i = 0; i < charts.length; i++) {
        const el = document.getElementById(charts[i]);
        if (!el) continue;
        const dataUrl = el.toDataURL('image/png');
        const col = i % 2;
        const row = Math.floor(i / 2);
        pdf.addImage(dataUrl, 'PNG', 14 + col * 140, 20 + row * 80, 130, 70);
      }
    } catch {}
  }

  pdf.save(`Murata_Estimate_Summary_${today}.pdf`);
  alert('PDFを出力しました。\n※日本語フォントの制約により、英数字での出力となります。');
}

function drawPdfTable(pdf, x, y, widths, rows, withHeader = false) {
  const rowH = 5;
  rows.forEach((row, i) => {
    let cx = x;
    if (withHeader && i === 0) {
      pdf.setFillColor(30, 58, 138);
      pdf.setTextColor(255, 255, 255);
      pdf.rect(x, y + i * rowH, widths.reduce((a, b) => a + b, 0), rowH, 'F');
    } else {
      pdf.setTextColor(0, 0, 0);
      if (i % 2 === 1) {
        pdf.setFillColor(245, 245, 245);
        pdf.rect(x, y + i * rowH, widths.reduce((a, b) => a + b, 0), rowH, 'F');
      }
    }
    row.forEach((cell, j) => {
      const text = String(cell == null ? '' : cell);
      pdf.text(text.substring(0, 30), cx + 1.5, y + i * rowH + 3.5);
      cx += widths[j];
    });
  });
  pdf.setTextColor(0, 0, 0);
}

// ========== 起動 ==========
init();
