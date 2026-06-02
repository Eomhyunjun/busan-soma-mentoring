(async () => {
  const CONFIG = {
    months: ["2026-05", "2026-06"],
    menuNo: "200046",
    delayMs: 120,
    applicantPageSize: 10,
    detailConcurrency: 10,
  };
  const MESSAGE_TYPES = {
    saveMarkdown: "SWM_MENTORING_SAVE_MARKDOWN",
  };
  const LOGIN_URL =
    "https://www.swmaestro.ai/busan/sw/member/user/forLogin.do?menuNo=200025";

  class LoginRequiredError extends Error {
    constructor(message) {
      super(message);
      this.name = "LoginRequiredError";
      this.loginRequired = true;
    }
  }

  const appPrefix = (() => {
    const match = location.pathname.match(/^\/(?:busan\/)?sw(?=\/)/);
    return match ? match[0] : "/busan/sw";
  })();
  const mentoPath = `${appPrefix}/mypage/mentoLec`;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const absolutize = (url) => new URL(url, location.origin).toString();
  const normalizeText = (value) =>
    (value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/&nbsp;?/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/<[^>]+>/g, "")
      .replace(/\r/g, "")
      .replace(/\u2028/g, "\n")
      .replace(/\u2029/g, "\n\n")
      .replace(/\u0085/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

  const escapeMarkdownTable = (value) =>
    String(value || "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, "<br>");

  const parseKoreanDateTime = (value) => {
    const text = normalizeText(value);
    const match = text.match(
      /(\d{4})[.-](\d{2})[.-](\d{2})\s*(?:\([^)]*\))?\s*(\d{1,2}:\d{2})시?\s*~\s*(\d{1,2}:\d{2})시?/,
    );
    if (!match) return { raw: text };

    const [, year, month, day, start, end] = match;
    return {
      raw: text,
      date: `${year}-${month}-${day}`,
      start: start.padStart(5, "0"),
      end: end.padStart(5, "0"),
    };
  };

  const looksLikeLoginPage = (text) =>
    /forLogin\.do|name=["']loginForm|id=["']loginForm|접근할 수 없는 세션|세션이\s*만료|로그인이\s*필요|로그인\s*후|비밀번호|아이디/i.test(
      text,
    ) &&
    !/mentoLec\/(?:list|view)\.do|resultList\.push|모집 명|강의날짜|로그아웃/i.test(
      text,
    );

  const redirectToLogin = () => {
    if (location.href !== LOGIN_URL) location.replace(LOGIN_URL);
  };

  const fetchViaIframe = async (url) =>
    new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      const timer = setTimeout(() => {
        iframe.remove();
        reject(new Error(`iframe 로드 시간 초과: ${url}`));
      }, 20000);

      iframe.style.cssText =
        "position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;border:0;opacity:0";
      iframe.onload = () => {
        try {
          const html = iframe.contentDocument?.documentElement?.outerHTML || "";
          clearTimeout(timer);
          iframe.remove();
          if (!html) reject(new Error(`iframe HTML을 읽지 못했습니다: ${url}`));
          else if (looksLikeLoginPage(html)) {
            reject(new LoginRequiredError("로그인이 필요하거나 세션이 만료되었습니다."));
          } else resolve(html);
        } catch (error) {
          clearTimeout(timer);
          iframe.remove();
          reject(error);
        }
      };
      iframe.src = absolutize(url);
      document.body.appendChild(iframe);
    });

  const fetchText = async (url) => {
    let response;
    try {
      response = await fetch(absolutize(url), {
        credentials: "include",
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
    } catch (error) {
      throw new LoginRequiredError(`로그인 상태 확인 실패: ${error.message}`);
    }

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new LoginRequiredError(`로그인이 필요합니다. (HTTP ${response.status})`);
      }
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    if (looksLikeLoginPage(text)) {
      console.warn(
        `[mentoring bookmarklet] fetch returned login page; retrying via iframe: ${url}`,
      );
      return fetchViaIframe(url);
    }
    return text;
  };

  const extractCalendarItems = (html) => {
    const items = [];
    const regex = /resultList\.push\(\s*(\{[\s\S]*?\})\s*\);/g;
    let match;

    while ((match = regex.exec(html))) {
      const raw = match[1];
      const item = {};
      for (const key of [
        "subjectTitle",
        "subject",
        "date",
        "url",
        "category",
        "categoryNm",
      ]) {
        const field = raw.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"`));
        if (field) item[key] = field[1];
      }
      const id = item.url?.match(/qustnrSn=(\d+)/)?.[1];
      if (id) items.push({ ...item, id });
    }

    return items;
  };

  const extractListLinks = (html) => {
    const items = [];
    const regex =
      /href=["']([^"']*mentoLec\/view\.do\?[^"']*qustnrSn=(\d+)[^"']*)["'][^>]*>\s*([\s\S]*?)<\/a>/g;
    let match;

    while ((match = regex.exec(html))) {
      items.push({
        url: match[1].replace(/&amp;/g, "&"),
        id: match[2],
        subjectTitle: normalizeText(match[3]),
      });
    }

    return items;
  };

  const extractApplicants = (html) => {
    const applicants = [];
    const listMatch = html.match(
      /신청자\s*리스트[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/i,
    );
    if (!listMatch) return applicants;

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(listMatch[1])) !== null) {
      const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
        (m) => normalizeText(m[1]),
      );
      if (cells.length >= 5) {
        applicants.push({
          no: cells[0],
          name: cells[1],
          applyAt: cells[2],
          cancelAt: cells[3],
          status: cells[4].replace(/[\[\]]/g, ""),
        });
      }
    }
    return applicants;
  };

  const withDetailPageIndex = (url, pageIndex) => {
    const next = new URL(absolutize(url));
    next.searchParams.set("pageIndex", String(pageIndex));
    if (!next.searchParams.get("menuNo")) next.searchParams.set("menuNo", CONFIG.menuNo);
    return `${next.pathname}?${next.searchParams.toString()}`;
  };

  const collectApplicantPageUrls = (html, detailUrl, appliedCount, collectedCount) => {
    let endPage = null;
    const pageCandidates = [
      Math.ceil((appliedCount || 0) / CONFIG.applicantPageSize),
      Math.ceil((collectedCount || 0) / CONFIG.applicantPageSize),
    ];
    const urlsByPage = {};

    const paginationMatch = html.match(
      /<div[^>]*class=["'][^"']*paginationSet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    if (paginationMatch) {
      const endPageMatch = paginationMatch[1].match(/data-endpage=["'](\d+)["']/i);
      if (endPageMatch) endPage = parseInt(endPageMatch[1], 10);

      const pageTextRegex =
        /<li[^>]*>\s*(?:<a[^>]*>|<span[^>]*>)?\s*(?:<em[^>]*>)?\s*<span>\s*(\d+)\s*<\/span>/gi;
      let pageTextMatch;
      while ((pageTextMatch = pageTextRegex.exec(paginationMatch[1])) !== null) {
        pageCandidates.push(parseInt(pageTextMatch[1], 10));
      }
    }

    const maxPage = endPage || Math.max(1, ...pageCandidates.filter(Number.isFinite));

    if (paginationMatch) {
      const linkRegex = /href=["']([^"']*pageIndex=(\d+)[^"']*)["']/g;
      let linkMatch;
      while ((linkMatch = linkRegex.exec(paginationMatch[1])) !== null) {
        const page = parseInt(linkMatch[2], 10);
        if (page > 1 && page <= maxPage) {
          urlsByPage[page] = linkMatch[1].replace(/&amp;/g, "&");
        }
      }
    }

    for (let page = 2; page <= maxPage; page += 1) {
      if (!urlsByPage[page]) urlsByPage[page] = withDetailPageIndex(detailUrl, page);
    }

    return Object.keys(urlsByPage)
      .map((page) => [parseInt(page, 10), urlsByPage[page]])
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
  };

  const parseDetail = async (html, fallback) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const getField = (label) => {
      const pattern = new RegExp(
        `<strong[^>]*class=["']t["'][^>]*>\\s*${label}\\s*<\\/strong>\\s*<div[^>]*class=["']c[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`,
        "i",
      );
      return normalizeText(html.match(pattern)?.[1] || "");
    };

    const lecture = parseKoreanDateTime(getField("강의날짜"));
    const title = getField("모집 명") || fallback.subjectTitle || "";
    const contentNode = doc.querySelector(".bbs-view-new .cont") || doc.querySelector(".cont");
    contentNode?.querySelectorAll(".file, script, style").forEach((node) => node.remove());
    const content = normalizeText(contentNode?.innerHTML || "");
    // 신청자 수 추출 — 페이지 JS에 appCnt: "N" 형태로 들어있음
    const appliedMatch =
      html.match(/appCnt\s*:\s*["'](\d+)["']/) ||
      html.match(/신청자\s*리스트\s*\[\s*<strong[^>]*>\s*(\d+)\s*명/i) ||
      html.match(/신청자[^\[]*\[\s*(\d+)\s*명\s*\]/);
    const appliedCount = appliedMatch ? parseInt(appliedMatch[1], 10) : null;

    // 신청자 명단 추출 — 신청자 리스트가 페이지네이션되면 pageIndex=2..N도 추가 수집
    const detailUrl =
      fallback.url ||
      `${mentoPath}/view.do?qustnrSn=${fallback.id}&menuNo=${CONFIG.menuNo}&pageIndex=1`;
    const applicants = extractApplicants(html);
    const applicantPageUrls = collectApplicantPageUrls(
      html,
      detailUrl,
      appliedCount,
      applicants.length,
    );
    if (applicantPageUrls.length) {
      for (const url of applicantPageUrls) {
        const pageHtml = await fetchText(url);
        applicants.push(...extractApplicants(pageHtml));
        await sleep(CONFIG.delayMs);
      }
    }

    const applicantKeys = new Set();
    const uniqueApplicants = applicants.filter((applicant) => {
      const key = `${applicant.no}|${applicant.name}|${applicant.applyAt}`;
      if (applicantKeys.has(key)) return false;
      applicantKeys.add(key);
      return true;
    });

    return {
      id: fallback.id,
      url: detailUrl,
      title,
      status: getField("상태"),
      approval: getField("개설 승인"),
      applyPeriod: getField("접수 기간"),
      lectureRaw: lecture.raw,
      date: lecture.date || fallback.date || "",
      start: lecture.start || "",
      end: lecture.end || "",
      method: getField("진행방식"),
      place: getField("장소"),
      capacity: getField("모집인원"),
      appliedCount,
      applicants: uniqueApplicants,
      author: getField("작성자"),
      registeredAt: getField("등록일"),
      category: fallback.categoryNm || "",
      content,
    };
  };

  const listUrlsForMonth = (month) => {
    const [year, monthNumber] = month.split("-").map(Number);
    const lastDay = new Date(year, monthNumber, 0).getDate();
    const params = new URLSearchParams({
      menuNo: CONFIG.menuNo,
      setDate: month,
      scdate: `${month}-01`,
      ecdate: `${month}-${String(lastDay).padStart(2, "0")}`,
      edcDateOrder: "",
      regDateOrder: "",
      pageIndex: "1",
    });
    return [
      `${mentoPath}/list.do?${params.toString()}`,
      `${mentoPath}/list.do?menuNo=${CONFIG.menuNo}&setDate=${month}&pageIndex=1`,
    ];
  };

  const collectIds = async () => {
    const byId = Object.create(null);
    const upsertListItem = (item, month, listUrl) => {
      const previous = byId[item.id] || {};
      byId[item.id] = {
        ...previous,
        ...item,
        month: month || item.date?.slice(0, 7) || "",
        listUrl,
        url:
          item.url ||
          previous.url ||
          `${mentoPath}/view.do?qustnrSn=${item.id}&menuNo=${CONFIG.menuNo}&pageIndex=1`,
      };
    };

    const currentHtml =
      location.pathname.includes("/mypage/mentoLec/list.do") ||
      document.querySelector("input[name='pageIndex'], .mypageCalendar")
        ? document.documentElement.outerHTML
        : "";

    if (currentHtml) {
      for (const item of [
        ...extractCalendarItems(currentHtml),
        ...extractListLinks(currentHtml),
      ]) {
        upsertListItem(item, "", location.href);
      }
    }

    for (const month of CONFIG.months) {
      let html = "";
      let usedUrl = "";

      for (const url of listUrlsForMonth(month)) {
        try {
          html = await fetchText(url);
          usedUrl = url;
          break;
        } catch (error) {
          console.warn(
            `[mentoring bookmarklet] list fetch failed: ${url}`,
            error,
          );
        }
      }

      if (!html) continue;

      const calendarItems = extractCalendarItems(html);
      const linkItems = extractListLinks(html);

      for (const item of [...calendarItems, ...linkItems]) {
        const date = item.date || "";
        if (date && !date.startsWith(month)) continue;
        upsertListItem(item, month, usedUrl);
      }
    }

    return Object.keys(byId).map((id) => byId[id]);
  };

  const makeMarkdown = (details) => {
    const sorted = [...details].sort(
      (a, b) =>
        (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99") ||
        (a.start || "99:99").localeCompare(b.start || "99:99") ||
        a.title.localeCompare(b.title, "ko"),
    );

    const lines = [];
    lines.push("# 2026년 5-6월 멘토링 일정");
    lines.push("");
    lines.push(`- 생성일: ${new Date().toLocaleString("ko-KR")}`);
    lines.push(`- 수집 건수: ${sorted.length}건`);
    lines.push(`- 실행 URL: ${location.href}`);
    lines.push("");
    lines.push("## 타임테이블");
    lines.push("");
    lines.push(
      "| 날짜 | 시간 | 구분 | 모집명 | 상태 | 방식 | 장소 | 모집인원 | 신청자수 | 작성자 | ID |",
    );
    lines.push("|---|---:|---|---|---|---|---|---:|---:|---|---:|");

    for (const item of sorted) {
      lines.push(
        [
          item.date,
          item.start && item.end
            ? `${item.start}-${item.end}`
            : item.lectureRaw,
          item.category,
          item.title,
          item.status,
          item.method,
          item.place,
          item.capacity,
          (item.appliedCount === null || item.appliedCount === undefined) ? "-" : `${item.appliedCount}명`,
          item.author,
          item.id,
        ]
          .map(escapeMarkdownTable)
          .join(" | ")
          .replace(/^/, "| ")
          .replace(/$/, " |"),
      );
    }

    lines.push("");
    lines.push("## 상세 내용");

    let currentDate = "";
    for (const item of sorted) {
      if (item.date !== currentDate) {
        currentDate = item.date;
        lines.push("");
        lines.push(`### ${currentDate || "날짜 미확인"}`);
      }

      lines.push("");
      lines.push(
        `#### ${item.start && item.end ? `${item.start}-${item.end} ` : ""}${item.title}`,
      );
      lines.push("");
      lines.push(`- ID: ${item.id}`);
      lines.push(`- 구분: ${item.category || "-"}`);
      lines.push(`- 상태: ${item.status || "-"}`);
      lines.push(`- 접수 기간: ${item.applyPeriod || "-"}`);
      lines.push(`- 강의 날짜: ${item.lectureRaw || "-"}`);
      lines.push(`- 진행 방식: ${item.method || "-"}`);
      lines.push(`- 장소: ${item.place || "-"}`);
      lines.push(`- 모집 인원: ${item.capacity || "-"}`);
      lines.push(
        `- 신청자: ${item.appliedCount === null || item.appliedCount === undefined ? "-" : `${item.appliedCount}명`}`,
      );
      lines.push(`- 작성자: ${item.author || "-"}`);
      lines.push(`- 상세 URL: ${absolutize(item.url)}`);
      if (item.applicants && item.applicants.length) {
        lines.push("");
        lines.push("**신청자 명단**");
        lines.push("");
        lines.push("| NO | 연수생 | 신청일 | 취소일 | 상태 |");
        lines.push("|---:|---|---|---|---|");
        for (const a of item.applicants) {
          lines.push(
            `| ${a.no} | ${escapeMarkdownTable(a.name)} | ${a.applyAt} | ${a.cancelAt || "-"} | ${a.status} |`,
          );
        }
      }
      lines.push("");
      lines.push(item.content || "_상세 내용 없음_");
    }

    return lines.join("\n") + "\n";
  };

  const saveExtensionData = async (markdown, details) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error("확장 메시지를 사용할 수 없습니다. 익스텐션에서 실행했는지 확인하세요.");
    }

    const payload = {
      markdown,
      generatedAt: new Date().toISOString(),
      count: details.length,
      sourceUrl: location.href,
    };

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.saveMarkdown,
      payload,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "IndexedDB 저장에 실패했습니다.");
    }
  };

  const mapLimit = async (items, limit, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;

    const runners = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await worker(items[index], index);
        }
      },
    );

    await Promise.all(runners);
    return results;
  };

  const createOverlay = () => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:14px 16px;border-radius:8px;background:#111827;color:#fff;font:13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);white-space:pre-wrap";
    document.body.appendChild(overlay);
    return overlay;
  };

  const setOverlay = (overlay, message) => {
    overlay.textContent = message;
  };

  const collectDetails = async (listItems, overlay) => {
    let completed = 0;
    return mapLimit(listItems, CONFIG.detailConcurrency, async (item) => {
      setOverlay(
        overlay,
        `상세 수집 중... ${completed}/${listItems.length}\n${item.subjectTitle || item.id}`,
      );
      const html = await fetchText(item.url);
      const detail = await parseDetail(html, item);
      completed += 1;
      setOverlay(
        overlay,
        `상세 수집 중... ${completed}/${listItems.length}\n${item.subjectTitle || item.id}`,
      );
      await sleep(CONFIG.delayMs);
      return detail;
    });
  };

  const overlay = createOverlay();
  setOverlay(overlay, "멘토링 목록 수집 중...");

  try {
    const listItems = await collectIds();
    if (!listItems.length)
      throw new Error("목록에서 멘토링 ID를 찾지 못했습니다.");

    const details = await collectDetails(listItems, overlay);
    const markdown = makeMarkdown(details);
    await saveExtensionData(markdown, details);
    setOverlay(overlay, `완료: ${details.length}건 수집\n확장 일정 데이터가 업데이트되었습니다.`);
    setTimeout(() => overlay.remove(), 5000);
  } catch (error) {
    console.error(error);
    if (error.loginRequired) {
      setOverlay(overlay, `로그인이 필요합니다.\n로그인 페이지로 이동합니다...`);
      setTimeout(redirectToLogin, 800);
      return;
    }
    setOverlay(overlay, `실패: ${error.message}`);
  }
})();
