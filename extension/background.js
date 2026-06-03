const DB_NAME = "swmMentoringDB";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const LATEST_KEY = "latest";
const MESSAGE_TYPES = {
  runCollector: "SWM_RUN_COLLECTOR",
  getSnapshot: "SWM_MENTORING_GET_SNAPSHOT",
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

const withDb = async (operation) => {
  const db = await openDb();
  try {
    return await operation(db);
  } finally {
    db.close();
  }
};

const putSnapshot = (snapshot) =>
  withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put({
          key: LATEST_KEY,
          ...snapshot,
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );

const getSnapshot = () =>
  withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(LATEST_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(tx.error);
      }),
  );

const dataUpdatedPayload = (payload) => ({
  count: payload.count,
  generatedAt: payload.generatedAt,
  phase: payload.phase || "final",
  addedCount: payload.addedCount || 0,
});

const notifyDataUpdated = (tabId, payload) => {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: MESSAGE_TYPES.dataUpdated,
    payload: dataUpdatedPayload(payload),
  }).catch(() => {});
};

const respondAsync = (sendResponse, promise) => {
  promise
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
};

const injectCollector = (tabId) =>
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["collector.js"],
  }).then(() => ({ ok: true }));

const saveSnapshotAndNotify = async (payload, tabId) => {
  await putSnapshot(payload);
  notifyDataUpdated(tabId, payload);
  return { ok: true };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.runCollector) {
    if (!sender.tab?.id) {
      sendResponse({ ok: false, error: "활성 SWM 탭을 찾지 못했습니다." });
      return false;
    }

    return respondAsync(sendResponse, injectCollector(sender.tab.id));
  }

  if (message?.type === MESSAGE_TYPES.getSnapshot) {
    return respondAsync(
      sendResponse,
      getSnapshot().then((snapshot) => ({ ok: true, snapshot })),
    );
  }

  if (message?.type !== MESSAGE_TYPES.saveMarkdown) return false;

  return respondAsync(
    sendResponse,
    saveSnapshotAndNotify(message.payload, sender.tab?.id),
  );
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
