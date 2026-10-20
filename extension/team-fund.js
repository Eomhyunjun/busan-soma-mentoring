(() => {
  const FUND_CAP = 12000000;
  const DASHBOARD_ID = "swm-fund-dashboard";
  const ENTRY_ROW_CLASS = "swm-fund-entry-row";
  const ITEM_ROW_CLASS = "swm-fund-item-row";
  const DETAIL_CONCURRENCY = 4;
  const MAX_LIST_PAGES = 20;
  const EVIDENCE_COLORS = ["#1e3a8a", "#0f766e", "#9a3412", "#6b21a8", "#9f1239", "#334155"];
  const SCALE_STEPS = [0, 3000000, 6000000, 9000000, 12000000];
  const LIST_HEADER_PATTERN = /구분|승인|증빙|품목/;
  const FIELD_PATTERNS = {
    category: /구분|비목/,
    itemName: /품목/,
    detail: /세부|상세/,
    approvedAmount: /승인.*(?:금액|액)/,
    evidenceStatus: /증빙/,
  };
  const EVIDENCE_DONE_PATTERN = /완료/;

  if (document.getElementById(DASHBOARD_ID)) return;

  const appPrefix = () =>
    location.pathname.match(/^\/(?:busan\/)?sw(?=\/)/)?.[0] || "/busan/sw";
  const menuNo = () => new URLSearchParams(location.search).get("menuNo") || "200054";
  const listUrl = (pageIndex) =>
    `${appPrefix()}/mypage/teamFound/list.do?menuNo=${menuNo()}&pageIndex=${pageIndex}`;
  const detailUrl = (foundId) =>
    `${appPrefix()}/mypage/projectSpt/view.do?foundId=${foundId}&menuNo=${menuNo()}&pageIndex=1`;

  const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim();
  const compactText = (value) => (value || "").replace(/\s+/g, "");
  // 금액 칸은 "₩14,744 / $11"처럼 원화와 달러가 함께 나온다. 한도가 원화 기준이라 원화만 읽는다.
  const parseKrwAmount = (value) => {
    const text = String(value || "");
    const krw = text.match(/[₩￦]\s*(\d[\d,]*)|(\d[\d,]*)\s*원/);
    if (krw) return Number((krw[1] || krw[2]).replace(/,/g, ""));
    if (/\$|USD|달러/i.test(text)) return null;
    const plain = text.match(/\d[\d,]*/);
    return plain ? Number(plain[0].replace(/,/g, "")) : null;
  };
  const multilineText = (node) => {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    clone.querySelectorAll("p, div, li").forEach((block) => block.append("\n"));
    return clone.textContent.split("\n").map(normalizeText).filter(Boolean).join("\n");
  };
  const pickField = (fields, pattern) => {
    const label = Object.keys(fields).find((key) => pattern.test(key));
    return label ? fields[label] : "";
  };

  const formatWon = (amount) => `${amount.toLocaleString("ko-KR")}원`;
  const formatManwon = (amount) =>
    amount === 0 ? "0" : `${(amount / 10000).toLocaleString("ko-KR")}만`;
  const percentOfCap = (amount) => Math.min(100, Math.max(0, (amount / FUND_CAP) * 100));
  const formatPercent = (amount) => `${((amount / FUND_CAP) * 100).toFixed(1)}%`;
  const evidenceColor = (index) => EVIDENCE_COLORS[index % EVIDENCE_COLORS.length];

  const fetchDocument = async (url) => {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return new DOMParser().parseFromString(await response.text(), "text/html");
  };

  const mapWithConcurrency = async (items, limit, mapper) => {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  };

  const findListTable = (doc) =>
    [...doc.querySelectorAll("table")]
      .filter((table) =>
        LIST_HEADER_PATTERN.test(compactText((table.tHead || table.rows[0])?.textContent)),
      )
      .sort((a, b) => b.rows.length - a.rows.length)[0] || null;

  const headerRow = (table) => table.tHead?.rows[table.tHead.rows.length - 1] || table.rows[0];
  const tableHeaders = (table) =>
    [...(headerRow(table)?.cells || [])].map((cell) => compactText(cell.textContent));

  const foundIdOf = (row) => row.outerHTML.match(/foundId=(\d+)/)?.[1] || "";

  const readListRows = (doc) => {
    const table = findListTable(doc);
    if (!table) return [];

    const headers = tableHeaders(table);
    return [...table.tBodies]
      .flatMap((tbody) => [...tbody.rows])
      .filter((row) => row.cells.length === headers.length)
      .map((row) => {
        const fields = {};
        headers.forEach((header, index) => {
          fields[header] = multilineText(row.cells[index]);
        });
        return { row, foundId: foundIdOf(row), fields };
      });
  };

  const lastPageOf = (doc) => {
    const pages = [...doc.querySelectorAll("[class*='pag']")]
      .flatMap((pagination) => [
        ...pagination.innerHTML.matchAll(/pageIndex=(\d+)|\w*[pP]age\w*\(\s*['"]?(\d+)/g),
      ])
      .map((match) => Number(match[1] || match[2]))
      .filter(Number.isFinite);
    return Math.min(MAX_LIST_PAGES, Math.max(1, ...pages));
  };

  const rowKey = (listRow) => listRow.foundId || Object.values(listRow.fields).join("|");

  const collectListRows = async () => {
    const rows = readListRows(document);
    const seen = new Set(rows.map(rowKey));
    const lastPage = lastPageOf(document);
    const currentPage = Number(new URLSearchParams(location.search).get("pageIndex")) || 1;

    for (let page = 1; page <= lastPage; page += 1) {
      if (page === currentPage) continue;
      // 마지막 페이지를 넘기면 같은 행이 다시 올 수 있어서, 새 행이 없으면 멈춘다.
      const newRows = readListRows(await fetchDocument(listUrl(page))).filter(
        (listRow) => !seen.has(rowKey(listRow)),
      );
      if (!newRows.length) break;
      newRows.forEach((listRow) => seen.add(rowKey(listRow)));
      rows.push(...newRows.map((listRow) => ({ ...listRow, row: null })));
    }
    return rows;
  };

  const readLabeledFields = (doc) => {
    const fields = {};
    const add = (labelNode, valueNode) => {
      const label = compactText(labelNode?.textContent);
      if (label && valueNode && !(label in fields)) fields[label] = multilineText(valueNode);
    };

    doc.querySelectorAll("th").forEach((th) => {
      if (th.nextElementSibling?.tagName === "TD") add(th, th.nextElementSibling);
    });
    doc.querySelectorAll("dt").forEach((dt) => {
      if (dt.nextElementSibling?.tagName === "DD") add(dt, dt.nextElementSibling);
    });
    doc.querySelectorAll("strong.t").forEach((strong) => {
      if (strong.nextElementSibling?.classList.contains("c")) add(strong, strong.nextElementSibling);
    });
    return fields;
  };

  const fetchDetailFields = async (listRow) => {
    if (!listRow.foundId) return {};
    try {
      return readLabeledFields(await fetchDocument(detailUrl(listRow.foundId)));
    } catch (error) {
      console.warn("[SWM Fund] 상세 페이지를 읽지 못했습니다:", listRow.foundId, error);
      return {};
    }
  };

  const toItem = (listRow, detailFields) => {
    const pick = (pattern) => pickField(listRow.fields, pattern) || pickField(detailFields, pattern);
    return {
      row: listRow.row,
      foundId: listRow.foundId,
      category: pick(FIELD_PATTERNS.category) || "기타",
      itemName: pick(FIELD_PATTERNS.itemName),
      detail: pick(FIELD_PATTERNS.detail),
      approvedAmount: parseKrwAmount(pick(FIELD_PATTERNS.approvedAmount)),
      evidenceDone: EVIDENCE_DONE_PATTERN.test(pick(FIELD_PATTERNS.evidenceStatus)),
    };
  };

  const summarize = (items) => {
    const krwItems = items.filter((item) => item.approvedAmount !== null);
    const byCategory = new Map();
    for (const item of krwItems) {
      if (!item.evidenceDone) continue;
      const group = byCategory.get(item.category) || { category: item.category, amount: 0, count: 0 };
      group.amount += item.approvedAmount;
      group.count += 1;
      byCategory.set(item.category, group);
    }

    const evidenceByCategory = [...byCategory.values()].sort((a, b) => b.amount - a.amount);
    return {
      approvedTotal: krwItems.reduce((sum, item) => sum + item.approvedAmount, 0),
      evidenceTotal: evidenceByCategory.reduce((sum, group) => sum + group.amount, 0),
      evidenceByCategory,
      countedItems: krwItems.length,
      skippedItems: items.length - krwItems.length,
    };
  };

  const createElement = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const createStat = (swatchClass, label, amount) => {
    const stat = createElement("div", "swm-fund-stat");
    const labelNode = createElement("div", "swm-fund-stat-label");
    labelNode.append(createElement("span", `swm-fund-swatch ${swatchClass}`), label);

    const value = createElement("div", "swm-fund-stat-value", formatWon(amount));
    value.append(createElement("span", "swm-fund-stat-percent", formatPercent(amount)));

    stat.append(labelNode, value);
    return stat;
  };

  const createGauge = (summary) => {
    const gauge = createElement("div", "swm-fund-gauge");
    gauge.setAttribute("role", "img");
    gauge.setAttribute(
      "aria-label",
      `한도 ${formatWon(FUND_CAP)} 중 승인 ${formatWon(summary.approvedTotal)}, 증빙 완료 ${formatWon(summary.evidenceTotal)}`,
    );

    const approved = createElement("div", "swm-fund-gauge-approved");
    approved.style.width = `${percentOfCap(summary.approvedTotal)}%`;

    const evidence = createElement("div", "swm-fund-gauge-evidence");
    evidence.style.width = `${percentOfCap(summary.evidenceTotal)}%`;
    summary.evidenceByCategory.forEach((group, index) => {
      const segment = createElement("span");
      segment.style.flex = `${group.amount} 0 0`;
      segment.style.background = evidenceColor(index);
      segment.title = `${group.category} ${formatWon(group.amount)}`;
      evidence.append(segment);
    });

    gauge.append(approved, evidence);
    return gauge;
  };

  const createScale = () => {
    const scale = createElement("div", "swm-fund-scale");
    for (const step of SCALE_STEPS) {
      const tick = createElement("span", "", formatManwon(step));
      tick.style.left = `${percentOfCap(step)}%`;
      scale.append(tick);
    }
    return scale;
  };

  const createCategoryList = (summary) => {
    if (!summary.evidenceByCategory.length) {
      return createElement("p", "swm-fund-empty", "증빙 완료된 항목이 아직 없습니다.");
    }

    const list = createElement("ul", "swm-fund-categories");
    summary.evidenceByCategory.forEach((group, index) => {
      const item = createElement("li", "swm-fund-category");
      const swatch = createElement("span", "swm-fund-swatch");
      swatch.style.background = evidenceColor(index);
      item.append(
        swatch,
        createElement("span", "swm-fund-category-name", group.category),
        createElement("span", "swm-fund-category-amount", formatWon(group.amount)),
        createElement("span", "swm-fund-category-count", `${group.count}건`),
      );
      list.append(item);
    });
    return list;
  };

  const renderDashboard = (dashboard, summary, statusText) => {
    const head = createElement("div", "swm-fund-head");
    head.append(
      createElement("h3", "swm-fund-title", "지원금 사용 현황"),
      createElement("span", "swm-fund-cap", `최대 ${formatWon(FUND_CAP)}`),
    );

    const stats = createElement("div", "swm-fund-stats");
    stats.append(
      createStat("is-approved", "승인 금액", summary.approvedTotal),
      createStat("is-evidence", "증빙 완료 금액", summary.evidenceTotal),
    );

    dashboard.replaceChildren(
      head,
      stats,
      createGauge(summary),
      createScale(),
      createCategoryList(summary),
    );
    if (statusText) dashboard.append(createElement("p", "swm-fund-status", statusText));
  };

  const renderStatus = (dashboard, text, isError = false) => {
    const status = createElement("p", `swm-fund-status${isError ? " is-error" : ""}`, text);
    dashboard.replaceChildren(createElement("h3", "swm-fund-title", "지원금 사용 현황"), status);
  };

  const createItemRow = (item, columnCount) => {
    const row = createElement("tr", ITEM_ROW_CLASS);
    const cell = createElement("td");
    cell.colSpan = columnCount;

    const grid = createElement("div", "swm-fund-item");
    for (const [label, value] of [
      ["품목명", item.itemName],
      ["세부사항", item.detail],
    ]) {
      grid.append(
        createElement("span", "swm-fund-item-label", label),
        createElement("span", "swm-fund-item-value", value || "-"),
      );
    }

    cell.append(grid);
    row.append(cell);
    return row;
  };

  // 원래 행 아래에 품목 행을 붙이고 첫 칸(NO)은 rowspan으로 두 행을 다 쓴다. 품목 라벨 열은 구분 칸 너비에,
  // 값은 제목 글자 시작점에 맞추는데 둘 다 표 너비에 따라 바뀌어서 구분 칸 크기가 바뀔 때마다 다시 잰다.
  const renderEntries = (table, items) => {
    const entries = items.filter(
      (item) => item.row?.cells.length > 2 && !item.row.classList.contains(ENTRY_ROW_CLASS),
    );
    if (!entries.length) return;

    for (const item of entries) {
      item.row.classList.add(ENTRY_ROW_CLASS);
      item.row.cells[0].rowSpan = 2;
      item.row.after(createItemRow(item, item.row.cells.length - 1));
    }

    const categoryHeader = headerRow(table).cells[1];
    const titleCell = entries[0].row.cells[2];
    const syncItemColumns = () => {
      table.style.setProperty("--swm-fund-label-width", `${categoryHeader.getBoundingClientRect().width}px`);
      table.style.setProperty("--swm-fund-value-indent", getComputedStyle(titleCell).paddingLeft);
    };
    syncItemColumns();
    new ResizeObserver(syncItemColumns).observe(categoryHeader);
  };

  const main = async () => {
    const table = findListTable(document);
    if (!table) return;

    const dashboard = createElement("section");
    dashboard.id = DASHBOARD_ID;
    table.before(dashboard);
    renderStatus(dashboard, "지원금 내역을 불러오는 중입니다...");

    try {
      const listRows = await collectListRows();
      const detailFields = await mapWithConcurrency(listRows, DETAIL_CONCURRENCY, fetchDetailFields);
      const items = listRows.map((listRow, index) => toItem(listRow, detailFields[index]));

      const summary = summarize(items);
      const skipped = summary.skippedItems
        ? ` · 승인 금액(₩)이 없는 ${summary.skippedItems}건 제외`
        : "";
      renderDashboard(dashboard, summary, `원화(₩) 기준 · 전체 ${items.length}건${skipped}`);
      renderEntries(table, items);
    } catch (error) {
      console.warn("[SWM Fund] 지원금 현황을 만들지 못했습니다:", error);
      renderStatus(dashboard, "지원금 내역을 불러오지 못했습니다. 페이지를 새로고침해 주세요.", true);
    }
  };

  main();
})();
