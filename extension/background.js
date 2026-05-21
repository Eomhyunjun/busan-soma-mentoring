const DB_NAME = "swmMentoringDB";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const LATEST_KEY = "latest";
const MESSAGE_TYPES = {
  runCollector: "SWM_RUN_COLLECTOR",
  saveMarkdown: "SWM_MENTORING_SAVE_MARKDOWN",
  dataUpdated: "SWM_MENTORING_DATA_UPDATED",
};

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
