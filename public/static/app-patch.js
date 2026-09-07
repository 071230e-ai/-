// 見積一覧の30件ずつ読み込み + 失注理由UI整合性パッチ
// 既存 app.js の業務ロジックを変えずに、一覧読み込みとフォーム表示だけを補強する。

const ESTIMATE_PAGE_SIZE = 30;

loadAndRenderList = async function(reset = true) {
  try {
    const current = reset ? [] : (State.estimates || []);
    const params = {
      ...State.filters,
      sort: listSortField,
      order: listSortOrder,
      limit: ESTIMATE_PAGE_SIZE,
      offset: current.length,
    };

    const { data } = await API.get('/api/estimates', { params });
    State.estimates = reset ? (data.estimates || []) : [...current, ...(data.estimates || [])];

    const total = Number(data.total_count ?? State.estimates.length);
    const isAdmin = State.user?.role === 'admin';
    const sortIcon = (f) => listSortField === f
      ? `<i class="fas fa-sort-${listSortOrder === 'asc' ? 'up' : 'down'}"></i>`
      : '<i class="fas fa-sort text-gray-400"></i>';

    document.getElementById('list-content').innerHTML = `
      <div class="bg-white border rounded-lg overflow-hidden">
        <div class="p-3 bg-gray-50 border-b text-sm text-gray-600 flex flex-wrap items-center justify-between gap-2">
          <div>表示: <strong>${State.estimates.length}</strong> / <strong>${total}</strong> 件</div>
          ${State.estimates.length < total ? '<div class="text-xs text-gray-500">30件ずつ読み込みます</div>' : ''}
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
              ${State.estimates.map(e => `
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
        ${State.estimates.length < total ? `
          <div class="p-4 border-t text-center">
            <button class="btn btn-secondary" id="btn-load-more-estimates">
              <i class="fas fa-chevron-down"></i> さらに30件表示
            </button>
          </div>
        ` : ''}
      </div>
    `;

    document.querySelectorAll('[data-sort]').forEach(el => {
      el.addEventListener('click', () => {
        const f = el.dataset.sort;
        if (listSortField === f) listSortOrder = listSortOrder === 'asc' ? 'desc' : 'asc';
        else { listSortField = f; listSortOrder = 'asc'; }
        loadAndRenderList(true);
      });
    });

    document.querySelectorAll('[data-edit]').forEach(el => {
      el.addEventListener('click', () => navigate('/estimates/' + el.dataset.edit));
    });

    document.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', async () => {
        if (!confirm('この見積データを削除しますか?')) return;
        try {
          await API.delete('/api/estimates/' + el.dataset.delete);
          loadAndRenderList(true);
        } catch (err) {
          alert(err.response?.data?.error || '削除に失敗しました');
        }
      });
    });

    document.getElementById('btn-load-more-estimates')?.addEventListener('click', () => {
      loadAndRenderList(false);
    });
  } catch (err) {
    const el = document.getElementById('list-content');
    if (el) el.innerHTML = `<div class="text-red-600 p-4">${escapeHtml(err.message || '読み込みに失敗しました')}</div>`;
  }
};

function syncLostReasonField() {
  const resultEl = document.getElementById('f_result');
  const wrap = document.getElementById('f_lost_wrap');
  if (!resultEl || !wrap) return;
  const lostSelect = wrap.querySelector('[name="lost_reason"]');
  const isLost = resultEl.value === '失注';
  wrap.style.display = isLost ? '' : 'none';
  if (!isLost && lostSelect) lostSelect.value = '';
}

// 元のフォーム側change処理より後に実行して、表示状態を確実に整える。
document.addEventListener('change', (e) => {
  if (e.target?.id === 'f_result') syncLostReasonField();
});

// 元のsubmitハンドラがFormDataを作る前に値をクリアする。
document.addEventListener('submit', (e) => {
  if (e.target?.id !== 'estimate-form') return;
  const resultEl = e.target.querySelector('[name="result"]');
  const lostEl = e.target.querySelector('[name="lost_reason"]');
  if (resultEl && resultEl.value !== '失注' && lostEl) lostEl.value = '';
}, true);

// 編集画面の初期表示時にも適用する。
const estimateFormObserver = new MutationObserver(() => syncLostReasonField());
estimateFormObserver.observe(document.body, { childList: true, subtree: true });
syncLostReasonField();
