(() => {
  const SWM_HOST = "www.swmaestro.ai";
  const EXTENSION_ORIGIN = chrome.runtime.getURL("").slice(0, -1);
  const SCHEDULE_PAGE = "schedule.html";
  const SCHEDULE_VERSION = "20260526-scroll-offset";
  const LOGIN_URL =
    "https://www.swmaestro.ai/busan/sw/member/user/forLogin.do?menuNo=200025";
  const LOGIN_PATH = "/busan/sw/member/user/forLogin.do";
  const TOGGLE_ID = "swm-mentoring-toggle";
  const VIEWER_ID = "swm-mentoring-viewer";
  const FRAME_ID = "swm-mentoring-frame";
  const QUICK_MENU_SELECTOR = ".quick-menu";
  const QUICK_BAR_SELECTOR = ".quick-bar";
  const MESSAGE_TYPES = {
    selectedPerson: "SWM_SELECTED_PERSON",
    runCollector: "SWM_RUN_COLLECTOR",
    collectorStarted: "SWM_COLLECTOR_STARTED",
    dataUpdated: "SWM_MENTORING_DATA_UPDATED",
    openViewer: "SWM_OPEN_VIEWER",
  };

  if (document.getElementById(TOGGLE_ID)) return;

  const isSwmPage = () =>
    location.hostname === SWM_HOST &&
    /^\/(?:busan\/)?sw\//.test(location.pathname);

  const isLoginPage = () =>
    location.hostname === SWM_HOST && location.pathname === LOGIN_PATH;

  if (!isSwmPage()) return;
  if (isLoginPage()) return;

  let detectedPerson = "";
  let frameReady = false;

  const normalizeName = (value) => (value || "").replace(/\s+/g, "").trim();
  const scheduleUrl = () => `${chrome.runtime.getURL(SCHEDULE_PAGE)}?v=${SCHEDULE_VERSION}`;
  const looksLikeLoginOrSessionPage = (html) =>
    /forLogin\.do|name=["']loginForm|id=["']loginForm|접근할 수 없는 세션|세션이\s*만료|로그인이\s*필요|비밀번호|아이디/i.test(
      html || "",
    ) && !/로그아웃|teamPageGo2|mypage\/myMain|class=["']welcome/i.test(html || "");

  const redirectToLogin = (reason) => {
    console.warn(`[SWM Mentoring] ${reason} 로그인 페이지로 이동합니다.`);
    location.replace(LOGIN_URL);
  };

  const createToggleButton = () => {
    const button = document.createElement("button");
    button.id = TOGGLE_ID;
    button.type = "button";
    button.className = "btn btn-mentoring";
    button.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "quick-text";
    label.textContent = "멘토링 일정보기";
    button.appendChild(label);

    return button;
  };

  const createViewerFrame = () => {
    const viewer = document.createElement("div");
    viewer.id = VIEWER_ID;

    const frame = document.createElement("iframe");
    frame.id = FRAME_ID;
    frame.title = "멘토링 일정";
    frame.src = scheduleUrl();

    viewer.appendChild(frame);
    return { viewer, frame };
  };

  const setButtonLabel = (button, label) => {
    const textNode = button.querySelector(".quick-text");
    if (textNode) textNode.textContent = label;
    else button.textContent = label;
  };

  const mountToggleButton = (button) => {
    const quickMenu = document.querySelector(QUICK_MENU_SELECTOR);
    if (!quickMenu) {
      button.classList.add("swm-floating");
      document.documentElement.appendChild(button);
      return;
    }

    button.classList.add("swm-in-quick-menu");
    quickMenu.closest(QUICK_BAR_SELECTOR)?.classList.add("swm-mentoring-quick-bar");
    quickMenu.insertBefore(button, quickMenu.firstElementChild);
  };

  const detectPersonFromHtml = (html, options = {}) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const welcomeName = doc.querySelector(".welcome strong")?.textContent;
    if (welcomeName) return normalizeName(welcomeName);

    if (!options.allowTeamPageFallback) return "";

    const teamPageCall = html.match(/teamPageGo2\(['"]([^'"]+)['"]/);
    return normalizeName(teamPageCall?.[1] || "");
  };

  const sendPersonToFrame = () => {
    if (!frameReady) return;
    if (!detectedPerson || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      {
        type: MESSAGE_TYPES.selectedPerson,
        name: detectedPerson,
      },
      EXTENSION_ORIGIN,
    );
  };

  const detectCurrentPerson = async () => {
    detectedPerson = detectPersonFromHtml(document.documentElement.outerHTML);
    if (!detectedPerson && looksLikeLoginOrSessionPage(document.documentElement.outerHTML)) {
      redirectToLogin("로그인 상태를 확인할 수 없습니다.");
      return;
    }
    if (!detectedPerson) {
      const appPrefix = location.pathname.match(/^\/(?:busan\/)?sw(?=\/)/)?.[0] || "/busan/sw";
      let response;
      try {
        response = await fetch(`${appPrefix}/mypage/myMain/dashboard.do?menuNo=200026`, {
          credentials: "include",
        });
      } catch (error) {
        redirectToLogin(`사용자 정보 요청 실패: ${error.message}`);
        return;
      }
      const html = await response.text();
      if (!response.ok || looksLikeLoginOrSessionPage(html)) {
        redirectToLogin(`사용자 정보 응답 실패${response.ok ? "" : ` (${response.status})`}.`);
        return;
      }
      detectedPerson = detectPersonFromHtml(html, { allowTeamPageFallback: true });
    }
    sendPersonToFrame();
  };

  const button = createToggleButton();
  const { viewer, frame } = createViewerFrame();

  document.documentElement.appendChild(viewer);
  mountToggleButton(button);

  frame.addEventListener("load", () => {
    frameReady = true;
    sendPersonToFrame();
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== EXTENSION_ORIGIN) return;
    if (event.source !== frame.contentWindow) return;
    if (event.data?.type !== MESSAGE_TYPES.runCollector) return;

    // 확장을 리로드하면 이미 주입돼 있던 이 스크립트의 컨텍스트가 무효화되어
    // chrome.runtime 호출이 동기적으로 throw한다(.catch로 잡히지 않음). try로 감싸 안내한다.
    try {
      chrome.runtime.sendMessage({ type: MESSAGE_TYPES.runCollector }).catch((error) => {
        console.warn("[SWM Mentoring] 데이터 갱신 요청 실패:", error);
      });
      frame.contentWindow?.postMessage({ type: MESSAGE_TYPES.collectorStarted }, EXTENSION_ORIGIN);
    } catch (error) {
      console.warn("[SWM Mentoring] 확장이 갱신되어 컨텍스트가 무효화됐습니다. 이 페이지를 새로고침해 주세요.", error);
    }
  });

  detectCurrentPerson().catch((error) => {
    console.warn("[SWM Mentoring] 신청 기준 이름 감지 실패:", error);
  });

  const setOpen = (open) => {
    viewer.classList.toggle("swm-open", open);
    button.classList.toggle("swm-active", open);
    document.body.classList.toggle("swm-mentoring-open", open);
    document.querySelector(QUICK_BAR_SELECTOR)?.classList.toggle("swm-mentoring-view-open", open);
    setButtonLabel(button, open ? "원래 페이지 보기" : "멘토링 일정보기");
    button.setAttribute("aria-expanded", String(open));
  };

  button.addEventListener("click", () => {
    setOpen(!viewer.classList.contains("swm-open"));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && viewer.classList.contains("swm-open")) {
      setOpen(false);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE_TYPES.openViewer) {
      setOpen(true);
      return;
    }
    if (message?.type !== MESSAGE_TYPES.dataUpdated) return;
    frame.contentWindow?.postMessage(
      {
        type: MESSAGE_TYPES.dataUpdated,
        payload: message.payload,
      },
      EXTENSION_ORIGIN,
    );
  });
})();
