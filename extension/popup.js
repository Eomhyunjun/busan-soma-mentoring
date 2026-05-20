const runButton = document.getElementById("runCollector");
const openBusanButton = document.getElementById("openBusan");
const statusEl = document.getElementById("status");
const SWM_ORIGIN = "https://www.swmaestro.ai/";
const BUSAN_MYPAGE_URL = `${SWM_ORIGIN}busan/sw/mypage/myMain/dashboard.do?menuNo=200026`;
const COLLECTOR_SCRIPT = "collector.js";

const setStatus = (message, kind = "") => {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
};

const getActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const assertCollectableTab = (tab) => {
  if (!tab?.id || !tab.url) throw new Error("활성 탭을 찾지 못했습니다.");
  if (!tab.url.startsWith(SWM_ORIGIN)) {
    throw new Error("www.swmaestro.ai 탭에서 실행해야 합니다.");
  }
};

const injectCollector = (tabId) =>
  chrome.scripting.executeScript({
    target: { tabId },
    files: [COLLECTOR_SCRIPT],
  });

const runCollector = async () => {
  const tab = await getActiveTab();
  assertCollectableTab(tab);
  await injectCollector(tab.id);
};

const openBusanPage = async () => {
  const tab = await getActiveTab();
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: BUSAN_MYPAGE_URL, active: true });
    return;
  }
  await chrome.tabs.create({ url: BUSAN_MYPAGE_URL });
};

openBusanButton.addEventListener("click", async () => {
  openBusanButton.disabled = true;
  setStatus("부산 소마 페이지로 이동하는 중...");

  try {
    await openBusanPage();
    window.close();
  } catch (error) {
    setStatus(`실패: ${error.message}`, "error");
  } finally {
    openBusanButton.disabled = false;
  }
});

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  setStatus("현재 탭에 수집기를 주입하는 중...");

  try {
    await runCollector();
    setStatus("실행됨. 페이지 오른쪽 아래 진행 상태를 확인하세요.", "ok");
  } catch (error) {
    setStatus(`실패: ${error.message}`, "error");
  } finally {
    runButton.disabled = false;
  }
});
