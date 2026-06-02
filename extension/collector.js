(async () => {
  const CONFIG = {
    months: ["2026-05", "2026-06"],
    menuNo: "200046",
    delayMs: 120,
    applicantPageSize: 10,
    detailConcurrency: 10,
  };
  const MESSAGE_TYPES = {
    getSnapshot: "SWM_MENTORING_GET_SNAPSHOT",
    saveMarkdown: "SWM_MENTORING_SAVE_MARKDOWN",
  };
  const LOGIN_URL =
    "https://www.swmaestro.ai/busan/sw/member/user/forLogin.do?menuNo=200025";
  const OVERLAY_STYLE = [
    "position:fixed",
    "z-index:2147483647",
    "right:16px",
    "bottom:16px",
    "width:360px",
    "max-width:calc(100vw - 32px)",
    "box-sizing:border-box",
    "padding:14px 16px",
    "border-radius:8px",
    "background:#111827",
    "color:#fff",
    "font:13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
    "box-shadow:0 10px 30px rgba(0,0,0,.25)",
    "overflow:hidden",
  ].join(";");
  const OVERLAY_ROW_STYLE =
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

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
  const numericId = (value) => {
    const id = parseInt(value, 10);
    return Number.isFinite(id) ? id : null;
  };
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
      console.warn(
        `[mentoring bookmarklet] fetch failed; retrying via iframe: ${url}`,
        error,
      );
      return fetchViaIframe(url);
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
        (a.title || "").localeCompare(b.title || "", "ko"),
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

  const unescapeMarkdownTable = (value) =>
    String(value || "")
      .replace(/<br>/g, "\n")
      .replace(/\\\|/g, "|")
      .trim();

  const splitMarkdownTableRow = (row) =>
    row.split("|").slice(1, -1).map((cell) => unescapeMarkdownTable(cell));

  const getMarkdownListValue = (section, label) => {
    const match = section.match(new RegExp(`^- ${label}:\\s*(.*)$`, "m"));
    const value = match?.[1]?.trim() || "";
    return value === "-" ? "" : value;
  };

  const parseTimetableDetail = (line) => {
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 10) return null;

    let date;
    let time;
    let category;
    let title;
    let status;
    let method;
    let place;
    let capacity;
    let appliedCountText;
    let author;
    let id;
    if (cells.length >= 11) {
      [
        date,
        time,
        category,
        title,
        status,
        method,
        place,
        capacity,
        appliedCountText,
        author,
        id,
      ] = cells;
    } else {
      [date, time, category, title, status, method, place, capacity, author, id] = cells;
      appliedCountText = "-";
    }

    const parsedId = numericId(id);
    if (parsedId === null) return null;

    const [start = "", end = ""] = String(time || "").split("-");
    return {
      id: parsedId,
      url: `${mentoPath}/view.do?qustnrSn=${parsedId}&menuNo=${CONFIG.menuNo}&pageIndex=1`,
      title: (title || "").replace(/^\[.*?\]\s*/, ""),
      status,
      approval: "",
      applyPeriod: "",
      lectureRaw: time,
      date,
      start,
      end,
      method,
      place,
      capacity,
      appliedCount: /^\d+/.test(appliedCountText) ? parseInt(appliedCountText, 10) : null,
      applicants: [],
      author,
      registeredAt: "",
      category,
      content: "",
    };
  };

  const parseTimetableDetails = (markdown) => {
    const lines = markdown.split("\n");
    const tableStart = lines.findIndex((line) => /^\|\s*날짜\s*\|/.test(line));
    const tableEnd = lines.findIndex(
      (line, index) => index > tableStart + 1 && !line.startsWith("|"),
    );
    const tableLines = tableStart === -1
      ? []
      : lines.slice(tableStart + 2, tableEnd === -1 ? lines.length : tableEnd);

    return tableLines.map(parseTimetableDetail).filter(Boolean);
  };

  const parseMarkdownApplicants = (section) => {
    const applicantMatch = section.match(/\*\*신청자 명단\*\*\s*\n\s*\n([\s\S]+?)\n\n/);
    if (!applicantMatch) return null;

    return applicantMatch[1].split("\n").slice(2).map((row) => {
      const cells = splitMarkdownTableRow(row);
      if (cells.length < 5 || !cells[1]) return null;
      return {
        no: cells[0],
        name: cells[1],
        applyAt: cells[2],
        cancelAt: cells[3] === "-" ? "" : cells[3],
        status: cells[4],
      };
    }).filter(Boolean);
  };

  const parseMarkdownContent = (section, detailUrl) => {
    const contentStart = detailUrl ? section.lastIndexOf(detailUrl) : -1;
    if (contentStart === -1) return "";

    const content = section.slice(contentStart + detailUrl.length)
      .replace(/^\s*\*\*신청자 명단\*\*[\s\S]+?\n\n/, "")
      .trim();
    return content && content !== "_상세 내용 없음_" ? content : "";
  };

  const parseDetailSection = (section, existingDetail) => {
    const id = numericId(getMarkdownListValue(section, "ID"));
    if (id === null) return null;

    const heading = section.split("\n")[0]?.trim() || "";
    const detail = existingDetail || {
      id,
      title: heading.replace(/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s+/, ""),
      applicants: [],
      content: "",
    };
    detail.category = getMarkdownListValue(section, "구분") || detail.category || "";
    detail.status = getMarkdownListValue(section, "상태") || detail.status || "";
    detail.applyPeriod = getMarkdownListValue(section, "접수 기간") || detail.applyPeriod || "";
    detail.lectureRaw = getMarkdownListValue(section, "강의 날짜") || detail.lectureRaw || "";
    detail.method = getMarkdownListValue(section, "진행 방식") || detail.method || "";
    detail.place = getMarkdownListValue(section, "장소") || detail.place || "";
    detail.capacity = getMarkdownListValue(section, "모집 인원") || detail.capacity || "";

    const appliedCountText = getMarkdownListValue(section, "신청자");
    if (/^\d+/.test(appliedCountText)) detail.appliedCount = parseInt(appliedCountText, 10);
    detail.author = getMarkdownListValue(section, "작성자") || detail.author || "";
    detail.url = getMarkdownListValue(section, "상세 URL") || detail.url || "";

    const lecture = parseKoreanDateTime(detail.lectureRaw);
    detail.date = lecture.date || detail.date || "";
    detail.start = lecture.start || detail.start || "";
    detail.end = lecture.end || detail.end || "";

    const applicants = parseMarkdownApplicants(section);
    if (applicants) detail.applicants = applicants;

    const content = parseMarkdownContent(section, detail.url);
    if (content) detail.content = content;

    return detail;
  };

  const parseExistingDetailsFromMarkdown = (markdown) => {
    if (!markdown) return [];

    const byId = new Map(
      parseTimetableDetails(markdown).map((detail) => [String(detail.id), detail]),
    );
    const detailStart = markdown.indexOf("## 상세 내용");
    if (detailStart === -1) return Array.from(byId.values());

    const sections = markdown.slice(detailStart).split(/^####\s+/m).slice(1);
    for (const section of sections) {
      const id = parseInt(getMarkdownListValue(section, "ID"), 10);
      const detail = parseDetailSection(section, byId.get(String(id)));
      if (detail) byId.set(String(detail.id), detail);
    }

    return Array.from(byId.values());
  };

  const getExistingSnapshot = async () => {
    if (!globalThis.chrome?.runtime?.sendMessage) return null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.getSnapshot,
      });
      return response?.ok ? response.snapshot : null;
    } catch (error) {
      console.warn("[mentoring bookmarklet] 기존 스냅샷 로드 실패:", error);
      return null;
    }
  };

  const detailsFromSnapshot = (snapshot) => {
    if (Array.isArray(snapshot?.details)) return snapshot.details;
    return parseExistingDetailsFromMarkdown(snapshot?.markdown || "");
  };

  const mergeDetails = (...detailGroups) => {
    const byId = new Map();
    for (const details of detailGroups) {
      for (const detail of details || []) {
        if (detail?.id === undefined || detail?.id === null) continue;
        byId.set(String(detail.id), detail);
      }
    }
    return Array.from(byId.values());
  };

  const maxDetailId = (details) =>
    details.reduce((max, detail) => {
      const id = numericId(detail.id);
      return id === null ? max : Math.max(max, id);
    }, 0);

  const saveExtensionData = async (markdown, details, options = {}) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error("확장 메시지를 사용할 수 없습니다. 익스텐션에서 실행했는지 확인하세요.");
    }

    const payload = {
      snapshotVersion: 2,
      markdown,
      details,
      generatedAt: new Date().toISOString(),
      count: details.length,
      sourceUrl: location.href,
      phase: options.phase || "final",
      addedCount: options.addedCount || 0,
    };

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.saveMarkdown,
      payload,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "IndexedDB 저장에 실패했습니다.");
    }
  };

  const saveDetailsSnapshot = async (details, options = {}) => {
    await saveExtensionData(makeMarkdown(details), details, options);
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
    overlay.style.cssText = OVERLAY_STYLE;
    document.body.appendChild(overlay);
    return overlay;
  };

  const setOverlay = (overlay, message) => {
    overlay.replaceChildren();
    String(message || "").split("\n").forEach((line) => {
      const row = document.createElement("div");
      row.textContent = line;
      row.style.cssText = OVERLAY_ROW_STYLE;
      overlay.appendChild(row);
    });
  };

  const collectDetails = async (listItems, overlay, label = "상세 수집 중") => {
    let completed = 0;
    return mapLimit(listItems, CONFIG.detailConcurrency, async (item) => {
      setOverlay(
        overlay,
        `${label}... ${completed}/${listItems.length}\n${item.subjectTitle || item.id}`,
      );
      const html = await fetchText(item.url);
      const detail = await parseDetail(html, item);
      completed += 1;
      setOverlay(
        overlay,
        `${label}... ${completed}/${listItems.length}\n${item.subjectTitle || item.id}`,
      );
      await sleep(CONFIG.delayMs);
      return detail;
    });
  };

  const partitionListItemsByExistingMaxId = (listItems, existingMaxId) => {
    const newItems = [];
    const existingItems = [];

    for (const item of listItems) {
      const id = numericId(item.id);
      if (existingMaxId > 0 && id !== null && id > existingMaxId) {
        newItems.push(item);
      } else {
        existingItems.push(item);
      }
    }

    return { newItems, existingItems };
  };

  const collectAndSaveNewDetails = async (newItems, existingDetails, overlay) => {
    if (!newItems.length) return [];

    const newDetails = await collectDetails(newItems, overlay, "신규 상세 수집 중");
    const partialDetails = mergeDetails(existingDetails, newDetails);
    await saveDetailsSnapshot(partialDetails, {
      phase: "partial",
      addedCount: newDetails.length,
    });
    setOverlay(overlay, `신규 ${newDetails.length}건 반영\n기존 멘토링 비교 중...`);
    return newDetails;
  };

  const collectExistingDetails = async (existingItems, overlay, hasNewItems) => {
    if (!existingItems.length) return [];

    return collectDetails(
      existingItems,
      overlay,
      hasNewItems ? "기존 상세 비교 중" : "상세 수집 중",
    );
  };

  const runCollection = async (overlay) => {
    const existingSnapshot = await getExistingSnapshot();
    const existingDetails = detailsFromSnapshot(existingSnapshot);
    const existingMaxId = maxDetailId(existingDetails);

    const listItems = await collectIds();
    if (!listItems.length) {
      throw new Error("목록에서 멘토링 ID를 찾지 못했습니다.");
    }

    const { newItems, existingItems } = partitionListItemsByExistingMaxId(
      listItems,
      existingMaxId,
    );
    const newDetails = await collectAndSaveNewDetails(
      newItems,
      existingDetails,
      overlay,
    );
    const existingCurrentDetails = await collectExistingDetails(
      existingItems,
      overlay,
      newItems.length > 0,
    );
    const details = mergeDetails(newDetails, existingCurrentDetails);

    await saveDetailsSnapshot(details, {
      phase: "final",
      addedCount: newDetails.length,
    });
    setOverlay(overlay, `완료: ${details.length}건 수집\n확장 일정 데이터가 업데이트되었습니다.`);
    setTimeout(() => overlay.remove(), 5000);
  };

  const overlay = createOverlay();
  setOverlay(overlay, "멘토링 목록 수집 중...");

  try {
    await runCollection(overlay);
  } catch (error) {
    if (error.loginRequired) {
      console.warn("[mentoring bookmarklet] login required:", error.message);
      setOverlay(overlay, `로그인이 필요합니다.\n로그인 페이지로 이동합니다...`);
      setTimeout(redirectToLogin, 800);
      return;
    }
    console.error(error);
    setOverlay(overlay, `실패: ${error.message}`);
  }
})();
