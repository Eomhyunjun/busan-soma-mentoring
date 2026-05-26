const DB_NAME = "swmMentoringDB";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const LATEST_KEY = "latest";
const MESSAGE_TYPES = {
  runCollector: "SWM_RUN_COLLECTOR",
  saveMarkdown: "SWM_MENTORING_SAVE_MARKDOWN",
  dataUpdated: "SWM_MENTORING_DATA_UPDATED",
  openViewer: "SWM_OPEN_VIEWER",
};

const SWM_ORIGIN = "https://www.swmaestro.ai/";
const BUSAN_PAGE_URL = `${SWM_ORIGIN}busan/sw/main/main.do`;

const openDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const putSnapshot = async (snapshot) => {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({
        key: LATEST_KEY,
        ...snapshot,
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.runCollector) {
    if (!sender.tab?.id) {
      sendResponse({ ok: false, error: "활성 SWM 탭을 찾지 못했습니다." });
      return false;
    }

    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      files: ["collector.js"],
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type !== MESSAGE_TYPES.saveMarkdown) return false;

  putSnapshot(message.payload)
    .then(() => {
      sendResponse({ ok: true });
      chrome.tabs.sendMessage(sender.tab.id, {
        type: MESSAGE_TYPES.dataUpdated,
        payload: {
          count: message.payload.count,
          generatedAt: message.payload.generatedAt,
        },
      }).catch(() => {});
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

// 아이콘 클릭 → (소마 /sw/ 페이지가 아니면) 부산 소마로 이동 후 일정 뷰어를 연다.
// 수집은 뷰어의 '데이터 갱신'으로 처리하므로 별도 팝업이 필요 없다.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isSwmSwUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.swmaestro.ai" && /^\/(?:busan\/)?sw\//.test(parsed.pathname);
  } catch {
    return false;
  }
};

const waitForTabComplete = (tabId) =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, 8000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

const ensureBusanTab = async (tab) => {
  if (tab?.id && isSwmSwUrl(tab.url)) return tab.id;
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: BUSAN_PAGE_URL, active: true });
    await waitForTabComplete(tab.id);
    return tab.id;
  }
  const created = await chrome.tabs.create({ url: BUSAN_PAGE_URL });
  await waitForTabComplete(created.id);
  return created.id;
};

const openViewerInTab = async (tabId) => {
  // 갓 이동한 직후엔 content.js 주입이 한 박자 늦을 수 있어 1회 재시도한다.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.openViewer });
      return;
    } catch (error) {
      if (attempt === 0) await delay(300);
      else console.warn("[SWM Mentoring] 일정 화면 열기 메시지 전달 실패:", error);
    }
  }
};

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const tabId = await ensureBusanTab(tab);
    await openViewerInTab(tabId);
  } catch (error) {
    console.warn("[SWM Mentoring] 일정 화면 열기 실패:", error);
  }
});
