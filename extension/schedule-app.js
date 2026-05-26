// ===== 공통 유틸 =====
    const SWM_ORIGIN = 'https://www.swmaestro.ai';
    const EXTENSION_ORIGIN = window.location.origin;
    const TRUSTED_MESSAGE_ORIGINS = new Set([SWM_ORIGIN, EXTENSION_ORIGIN]);
    const MESSAGE_TYPES = {
      selectedPerson: 'SWM_SELECTED_PERSON',
      runCollector: 'SWM_RUN_COLLECTOR',
      collectorStarted: 'SWM_COLLECTOR_STARTED',
      dataUpdated: 'SWM_MENTORING_DATA_UPDATED',
    };
    const byId = (id) => document.getElementById(id);
    const setHtml = (id, html) => {
      byId(id).innerHTML = html;
    };
    const setText = (id, text) => {
      byId(id).textContent = text;
    };
    const openModal = (html) => {
      setHtml('modalContent', html);
      byId('modal').classList.add('open');
    };
    const isTrustedMessage = (event) => TRUSTED_MESSAGE_ORIGINS.has(event.origin);

    function setButtonState(id, text, disabled = false) {
      const button = byId(id);
      if (!button) return;
      button.disabled = disabled;
      button.textContent = text;
    }

    function setRefreshButtonState(text, disabled = false) {
      setButtonState('refreshData', text, disabled);
    }

    function setMentorButtonState(text, disabled = false) {
      setButtonState('refreshMentors', text, disabled);
    }

    function setBackupButtonState(text, disabled = false) {
      setButtonState('exportBackup', text, disabled);
    }

    function setActiveChip(groupSelector, activeButton) {
      document.querySelectorAll(`${groupSelector} .chip`).forEach(button => {
        button.classList.toggle('active', button === activeButton);
      });
    }

    function bindFilterChip(groupSelector, onSelect) {
      document.querySelectorAll(`${groupSelector} .chip`).forEach(button => {
        button.onclick = () => {
          setActiveChip(groupSelector, button);
          onSelect(button);
          render();
        };
      });
    }

// ===== 상태 관리 =====
    const STORAGE_KEY = 'mentoring_user_state_v1';
    const PERSON_APPLIED_KEY = 'mentoring_person_applied_v1';
    const MENTOR_FAVORITES_KEY = 'mentoring_mentor_favorites_v1';
    const USER_DATA_KEYS = [STORAGE_KEY, PERSON_APPLIED_KEY, MENTOR_FAVORITES_KEY];
    const STATES = ['none', 'applied', 'interest', 'meh', 'exclude'];
    const STATE_LABELS = {
      none: '·',
      applied: '✓',
      interest: '★',
      meh: '⚪',
      exclude: '✕',
    };
    const STATE_NAMES = {
      none: '없음',
      applied: '신청',
      interest: '관심',
      meh: '그닥',
      exclude: '제외',
    };

    // chrome.storage.local 어댑터 — 손으로 표시한 사용자 상태의 영구 저장소.
    // 즐겨찾기/관심 등은 재수집으로 복구할 수 없어 확장 전용 저장소에 보관한다.
    const storage = {
      get(key) {
        return new Promise((resolve, reject) => {
          chrome.storage.local.get(key, (result) => {
            const err = chrome.runtime.lastError;
            err ? reject(new Error(err.message)) : resolve(result[key]);
          });
        });
      },
      set(key, value) {
        return new Promise((resolve, reject) => {
          chrome.storage.local.set({ [key]: value }, () => {
            const err = chrome.runtime.lastError;
            err ? reject(new Error(err.message)) : resolve();
          });
        });
      },
    };

    const persist = (key, value) =>
      storage.set(key, value).catch(e => console.warn(`상태 저장 실패 (${key}):`, e.message));

    const asObject = (value) => (value && typeof value === 'object' ? value : {});

    let selectedPerson = '';

    // chrome.storage는 비동기라 초기화 시 loadUserData()로 채운다. 그 전까지는 빈 상태.
    let userState = {};
    let personApplied = {};
    let mentorFavorites = {};

    async function loadUserData() {
      userState = asObject(await storage.get(STORAGE_KEY));
      personApplied = asObject(await storage.get(PERSON_APPLIED_KEY));
      mentorFavorites = asObject(await storage.get(MENTOR_FAVORITES_KEY));
    }

    // 구버전 localStorage 데이터를 chrome.storage.local로 1회 이전(멱등).
    // chrome.storage에 값이 있으면 건너뛰고, 원본은 롤백 대비로 남겨둔다.
    async function migrateFromLocalStorage() {
      for (const key of USER_DATA_KEYS) {
        if ((await storage.get(key)) !== undefined) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          await storage.set(key, JSON.parse(raw));
        } catch (e) {
          console.warn(`localStorage 이전 실패 (${key}):`, e.message);
        }
      }
    }

    function saveState() { persist(STORAGE_KEY, userState); }
    function savePersonApplied() { persist(PERSON_APPLIED_KEY, personApplied); }
    function saveMentorFavorites() { persist(MENTOR_FAVORITES_KEY, mentorFavorites); }

    // 멘토 즐겨찾기 안정 키 — 불안정한 Notion 블록 id 대신 정규화한 멘토 이름을 쓴다.
    // indexMentors의 키 생성과 같은 규칙(한글 이름 우선, 없으면 정제 이름)이라 mentorMap과 일관된다.
    function mentorKey(mentor) {
      if (!mentor || !mentor.name) return '';
      const korean = mentor.name.match(/[가-힣]{2,4}/);
      if (korean) return korean[0];
      return mentor.name.replace(/멘토|✨|✯|¸\.|•|´|¨|\*|✿|`|\.|\s/g, '').toLowerCase();
    }

    function isFavoriteMentor(mentor) {
      const key = mentorKey(mentor);
      return !!key && !!mentorFavorites[key];
    }

    function countFavoriteMentors() {
      return Object.keys(mentorFavorites).length;
    }

    function toggleFavoriteMentor(key) {
      if (!key) return;
      if (mentorFavorites[key]) delete mentorFavorites[key];
      else mentorFavorites[key] = true;
      saveMentorFavorites();
    }

    function renderFavoriteButton(mentor) {
      const key = mentorKey(mentor);
      if (!key) return '';
      const active = !!mentorFavorites[key];
      return `
        <button class="mentor-fav ${active ? 'active' : ''}" type="button" data-mentor-favorite="${escape(key)}" data-mentor-modal-id="${escape(mentor.id)}" title="${active ? '즐겨찾기 해제' : '즐겨찾기 추가'}">
          ${active ? '★' : '☆'}
        </button>
      `;
    }

    // 구버전 즐겨찾기(Notion id 키)를 이름 키로 이전. 멘토 로드 후 호출.
    // 멘토 목록이 비었으면(로드 실패) 건너뛰고, 현재 멘토와 매칭 안 되는 id는 손실 방지를 위해 보존한다.
    function migrateFavoriteKeys() {
      if (!mentorMap || mentorMap.size === 0) return;
      const byId = new Map(Array.from(mentorMap.values()).map(m => [m.id, m]));
      let changed = false;
      for (const oldKey of Object.keys(mentorFavorites)) {
        if (!isNotionBlockId(oldKey)) continue;
        const mentor = byId.get(oldKey);
        if (!mentor) continue;
        const newKey = mentorKey(mentor);
        if (newKey) mentorFavorites[newKey] = true;
        delete mentorFavorites[oldKey];
        changed = true;
      }
      if (changed) saveMentorFavorites();
    }

    function isNotionBlockId(value) {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    function hasManualPersonApplied(id) {
      if (!selectedPerson) return false;
      const applied = personApplied[selectedPerson] || {};
      return !!applied[String(id)];
    }

    function setManualPersonApplied(id, applied) {
      if (!selectedPerson) return false;
      const key = String(id);
      if (!personApplied[selectedPerson]) personApplied[selectedPerson] = {};

      if (applied) personApplied[selectedPerson][key] = true;
      else delete personApplied[selectedPerson][key];

      if (Object.keys(personApplied[selectedPerson]).length === 0) {
        delete personApplied[selectedPerson];
      }
      savePersonApplied();
      return true;
    }

    function countSelectedPersonApplied() {
      if (!selectedPerson) return 0;
      let count = 0;
      for (const item of allItems) {
        if (isAppliedBySelectedPerson(item.id)) count += 1;
      }
      return count;
    }

    function isAppliedBySelectedPerson(id) {
      if (!selectedPerson) return false;
      const detail = detailMap.get(Number(id)) || {};
      return hasManualPersonApplied(id) || (detail.applicants || []).some(a =>
        a.name === selectedPerson && a.status === '신청완료'
      );
    }

    function getState(id) {
      if (selectedPerson) {
        if (isAppliedBySelectedPerson(id)) return 'applied';
        return userState[id] && userState[id] !== 'applied' ? userState[id] : 'none';
      }
      return userState[id] && userState[id] !== 'applied' ? userState[id] : 'none';
    }
    function setState(id, state) {
      if (state === 'applied') {
        if (!selectedPerson) {
          updateSelectedPersonHint(0);
          return;
        }
        setManualPersonApplied(id, true);
        if (userState[id] === 'applied') delete userState[id];
        saveState();
        updateSelectedPersonHint(countSelectedPersonApplied());
        return;
      }

      if (selectedPerson) setManualPersonApplied(id, false);
      if (state === 'none') delete userState[id];
      else userState[id] = state;
      saveState();
      updateSelectedPersonHint(countSelectedPersonApplied());
    }
    function cycleState(id) {
      const cur = getState(id);
      const idx = STATES.indexOf(cur);
      const next = STATES[(idx + 1) % STATES.length];
      setState(id, next);
      return next;
    }

    // ===== 데이터 파싱 =====
    let allItems = [];
    let detailMap = new Map(); // id -> detail content
    let mentorMap = new Map(); // 작성자 이름(공백제거) -> mentor 데이터
    const EXTENSION_DB_NAME = 'swmMentoringDB';
    const EXTENSION_DB_VERSION = 1;
    const EXTENSION_STORE_NAME = 'snapshots';
    const NOTION_BASE_URL = 'https://swmaestromain.notion.site';
    const NOTION_SPACE_ID = 'ccbd650f-9055-41eb-b9c0-6238b333a223';
    const NOTION_PAGE_ID = '32b91e40-1fdf-8026-a911-df1dc614d5a4';
    const NOTION_COLLECTION_ID = '32b91e40-1fdf-8139-907e-000b07db5b47';
    const NOTION_COLLECTION_VIEW_ID = '32b91e40-1fdf-818e-b7be-000c24886d6e';

    function openExtensionDb() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error('IndexedDB를 사용할 수 없습니다.'));
          return;
        }

        const request = indexedDB.open(EXTENSION_DB_NAME, EXTENSION_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(EXTENSION_STORE_NAME)) {
            db.createObjectStore(EXTENSION_STORE_NAME, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async function readSnapshot(key) {
      const db = await openExtensionDb();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(EXTENSION_STORE_NAME, 'readonly');
          const request = tx.objectStore(EXTENSION_STORE_NAME).get(key);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    }

    async function writeSnapshot(value) {
      const db = await openExtensionDb();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(EXTENSION_STORE_NAME, 'readwrite');
          tx.objectStore(EXTENSION_STORE_NAME).put(value);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }

    async function loadLatestMarkdownFromDb() {
      return readSnapshot('latest');
    }

    async function notionPost(path, payload) {
      const response = await fetch(`${NOTION_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'omit',
      });
      if (!response.ok) {
        throw new Error(`Notion API 응답 실패 (${response.status})`);
      }
      return response.json();
    }

    function mergeNotionRecordMap(target, recordMap) {
      if (!recordMap) return;
      for (const tableName of ['block', 'collection']) {
        const table = recordMap[tableName];
        if (!table) continue;
        if (!target[tableName]) target[tableName] = {};
        for (const [id, record] of Object.entries(table)) {
          target[tableName][id] = record;
        }
      }
    }

    function getNotionQueryBlockIds(queryResult) {
      const resultIds = queryResult?.result?.reducerResults?.results?.blockIds;
      if (Array.isArray(resultIds)) return Array.from(new Set(resultIds));

      const blockResults = queryResult?.result?.reducerResults?.gallery_groups?.blockResults || {};
      return Array.from(new Set(
        Object.values(blockResults).flatMap(group => Array.isArray(group?.blockIds) ? group.blockIds : [])
      ));
    }

    async function syncNotionBlocks(blockIds, recordMap) {
      const ids = Array.from(new Set(blockIds)).filter(Boolean);
      const chunkSize = 50;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const body = await notionPost('/api/v3/syncRecordValuesSpaceInitial', {
          requests: chunk.map(id => ({
            pointer: { table: 'block', id, spaceId: NOTION_SPACE_ID },
            version: -1,
          })),
        });
        mergeNotionRecordMap(recordMap, body.recordMap);
      }
    }

    function getNotionText(richText) {
      if (!Array.isArray(richText)) return '';
      return richText
        .map(segment => Array.isArray(segment) ? segment[0] : '')
        .join('')
        .trim();
    }

    function getNotionProperty(properties, key) {
      const value = properties?.[key];
      return Array.isArray(value)
        ? value.flat().filter(item => typeof item === 'string').join(' ').trim()
        : '';
    }

    function resolveNotionImageUrl(imageValue, blockId) {
      if (!imageValue) return null;
      const encoded = encodeURIComponent(imageValue);
      return `${NOTION_BASE_URL}/image/${encoded}?table=block&id=${blockId}&spaceId=${NOTION_SPACE_ID}&width=360&cache=v2`;
    }

    function resolveNotionImageFallbackUrl(imageValue) {
      return /^https?:\/\//.test(imageValue || '') ? imageValue : null;
    }

    function collectChildBlockIds(recordMap, parentIds) {
      const blockMap = recordMap.block || {};
      return parentIds.flatMap(id => {
        const block = blockMap[id]?.value?.value;
        return Array.isArray(block?.content) ? block.content : [];
      });
    }

    function getNotionBlockText(recordMap, blockId, depth = 0) {
      if (depth > 3) return '';
      const block = recordMap.block?.[blockId]?.value?.value;
      if (!block || !block.alive) return '';

      const parts = [];
      const main = getNotionText(block.properties?.title);
      if (main) parts.push(main);
      if (Array.isArray(block.content)) {
        for (const childId of block.content) {
          const child = getNotionBlockText(recordMap, childId, depth + 1);
          if (child) parts.push(child);
        }
      }
      return parts.join('\n');
    }

    function buildMentorsFromNotionRecordMap(recordMap) {
      const collectionRecord = Object.values(recordMap.collection || {}).find(record => {
        const schema = record?.value?.value?.schema || {};
        return Object.values(schema).some(field => field?.name === '멘토 구분');
      });
      const schema = collectionRecord?.value?.value?.schema || {};
      const schemaName = {};
      for (const key of Object.keys(schema)) schemaName[key] = schema[key].name;

      const mentors = [];
      for (const [id, record] of Object.entries(recordMap.block || {})) {
        const block = record?.value?.value;
        if (!block || block.type !== 'page' || block.parent_table !== 'collection' || !block.alive) continue;

        const properties = block.properties || {};
        const idNoDash = block.id.replace(/-/g, '');
        const cover = block.format?.page_cover || null;
        const imageUrl = resolveNotionImageUrl(cover, block.id);
        const mentor = {
          id: block.id,
          name: getNotionProperty(properties, 'title'),
          cover,
          notionUrl: `${NOTION_BASE_URL}/${idNoDash}`,
          imageUrl,
          imageLocal: imageUrl,
          imageFallbackUrl: resolveNotionImageFallbackUrl(cover),
        };

        for (const key of Object.keys(properties)) {
          if (key === 'title') continue;
          const humanName = schemaName[key];
          if (humanName) mentor[humanName] = getNotionProperty(properties, key);
        }

        if (!mentor['멘토 구분']) continue;
        if (!mentor.name || /\n/.test(mentor.name) || mentor.name.length > 60) continue;
        mentor.bio = getNotionBlockText(recordMap, block.id);
        mentors.push(mentor);
      }

      return mentors.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }

    async function fetchMentorsFromNotion() {
      const recordMap = { block: {}, collection: {} };
      const rootPage = await notionPost('/api/v3/loadCachedPageChunkV2', {
        page: { id: NOTION_PAGE_ID },
        cursor: { stack: [] },
        verticalColumns: false,
      });
      mergeNotionRecordMap(recordMap, rootPage.recordMap);

      const query = await notionPost('/api/v3/queryCollection', {
        collection: {
          id: NOTION_COLLECTION_ID,
          spaceId: NOTION_SPACE_ID,
        },
        collectionView: {
          id: NOTION_COLLECTION_VIEW_ID,
          spaceId: NOTION_SPACE_ID,
        },
        loader: {
          type: 'reducer',
          reducers: {
            results: {
              type: 'results',
              limit: 500,
              loadContentCover: true,
            },
          },
          searchQuery: '',
          userTimeZone: 'Asia/Seoul',
        },
      });
      mergeNotionRecordMap(recordMap, query.recordMap);

      const mentorIds = getNotionQueryBlockIds(query);
      await syncNotionBlocks(mentorIds, recordMap);
      await syncNotionBlocks(collectChildBlockIds(recordMap, mentorIds), recordMap);
      await syncNotionBlocks(collectChildBlockIds(recordMap, collectChildBlockIds(recordMap, mentorIds)), recordMap);

      return buildMentorsFromNotionRecordMap(recordMap);
    }

    async function loadMentors() {
      const cached = await readSnapshot('mentors');
      const hasCurrentImageShape = cached?.mentors?.some(mentor => 'imageFallbackUrl' in mentor);
      if (cached?.mentors && hasCurrentImageShape) {
        return cached.mentors;
      }

      const mentors = await fetchMentorsFromNotion();
      await writeSnapshot({ key: 'mentors', mentors, updatedAt: Date.now() });
      return mentors;
    }

    function indexMentors(mentors) {
      mentorMap = new Map();
      for (const mentor of mentors) {
        const cleanName = mentor.name.replace(/멘토|✨|✯|¸\.|•|´|¨|\*|✿|`|\.|\s/g, '').toLowerCase();
        const koreanName = mentor.name.match(/[가-힣]{2,4}/);
        if (koreanName) mentorMap.set(koreanName[0], mentor);
        mentorMap.set(cleanName, mentor);
      }
    }

    async function loadData() {
      let md = '';
      try {
        const latest = await loadLatestMarkdownFromDb();
        if (latest?.markdown) md = latest.markdown;
      } catch (e) {
        console.warn('IndexedDB 일정 데이터 로드 실패:', e.message);
      }

      if (!md) {
        throw new Error('아직 수집된 멘토링 데이터가 없습니다.');
      }
      parseMarkdown(md);
      buildSeriesMap();
      initMonthState();

      // 멘토 정보 (선택적)
      try {
        indexMentors(await loadMentors());
        migrateFavoriteKeys();
      } catch (e) {
        console.warn('Notion 멘토 정보 로드 실패:', e.message);
      }

      buildApplicantNameOptions();
      render();
    }

    function buildApplicantNameOptions() {
      updateSelectedPersonHint(countSelectedPersonApplied());
    }

    function updateSelectedPersonHint(count) {
      void count;
      updatePageTitle();
    }

    function updatePageTitle() {
      setText('pageTitle', selectedPerson
        ? `소마 17기 멘토링 일정 - ${selectedPerson}`
        : '소마 17기 멘토링 일정');
    }

    function setDetectedPerson(name) {
      selectedPerson = name.trim();

      updateSelectedPersonHint(countSelectedPersonApplied());
      render();
    }

    async function refreshFromStorage() {
      const prev = captureSnapshot();
      await loadData();
      presentDiff(computeDiff(prev, captureSnapshot()));
      setRefreshButtonState('데이터 갱신');
    }

    // 멘토 캐시를 우회하고 Notion에서 강제로 다시 받아온다(loadMentors는 캐시 우선).
    async function refreshMentors() {
      setMentorButtonState('멘토 갱신 중...', true);
      try {
        const mentors = await fetchMentorsFromNotion();
        await writeSnapshot({ key: 'mentors', mentors, updatedAt: Date.now() });
        indexMentors(mentors);
        migrateFavoriteKeys();
        render();
        showToast(`멘토 프로필 ${mentors.length}명 갱신됨`);
      } catch (err) {
        console.warn('멘토 프로필 갱신 실패:', err.message);
        showToast(`멘토 갱신 실패: ${err.message}`);
      } finally {
        setMentorButtonState('멘토 갱신');
      }
    }

    const BACKUP_TYPE = 'swm-mentoring-backup';

    function downloadJson(filename, data) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // 수집 스냅샷·멘토 캐시(IndexedDB)와 사용자 상태(chrome.storage.local)를 한 파일로 묶는다.
    // 확장 ID(폴더 경로)가 바뀌면 저장소가 비므로, 이 파일로 다른 환경에 그대로 복원한다.
    async function exportBackup() {
      setBackupButtonState('내보내는 중...', true);
      try {
        const [snapshot, mentors] = await Promise.all([
          readSnapshot('latest'),
          readSnapshot('mentors'),
        ]);
        const backup = {
          type: BACKUP_TYPE,
          version: 1,
          exportedAt: Date.now(),
          snapshot,
          mentors,
          storage: {
            [STORAGE_KEY]: asObject(await storage.get(STORAGE_KEY)),
            [PERSON_APPLIED_KEY]: asObject(await storage.get(PERSON_APPLIED_KEY)),
            [MENTOR_FAVORITES_KEY]: asObject(await storage.get(MENTOR_FAVORITES_KEY)),
          },
        };
        downloadJson(`swm-mentoring-backup-${todayIso()}.json`, backup);
        showToast('백업 파일을 내보냈습니다');
      } catch (err) {
        console.warn('백업 내보내기 실패:', err.message);
        showToast(`내보내기 실패: ${err.message}`);
      } finally {
        setBackupButtonState('백업 내보내기');
      }
    }

    // 백업 파일로 IndexedDB 스냅샷·멘토 캐시와 사용자 상태를 덮어쓴 뒤 다시 로드한다.
    async function importBackup(file) {
      let backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        showToast('가져오기 실패: 파일을 읽을 수 없습니다');
        return;
      }
      if (backup?.type !== BACKUP_TYPE) {
        showToast('가져오기 실패: 이 확장의 백업 파일이 아닙니다');
        return;
      }
      if (!confirm('현재 데이터를 이 백업으로 덮어씁니다. 계속할까요?')) return;

      try {
        if (backup.snapshot) await writeSnapshot({ ...backup.snapshot, key: 'latest' });
        if (backup.mentors) await writeSnapshot({ ...backup.mentors, key: 'mentors' });
        const saved = backup.storage || {};
        await Promise.all([
          storage.set(STORAGE_KEY, asObject(saved[STORAGE_KEY])),
          storage.set(PERSON_APPLIED_KEY, asObject(saved[PERSON_APPLIED_KEY])),
          storage.set(MENTOR_FAVORITES_KEY, asObject(saved[MENTOR_FAVORITES_KEY])),
        ]);
        await loadUserData();
        await loadData();
        showToast('백업을 가져왔습니다');
      } catch (err) {
        console.warn('백업 가져오기 실패:', err.message);
        showToast(`가져오기 실패: ${err.message}`);
      }
    }

    function findMentor(authorName) {
      if (!authorName) return null;
      const cleaned = authorName.replace(/\s/g, '');
      return mentorMap.get(cleaned) || mentorMap.get(authorName) || null;
    }

    function parseMarkdown(md) {
      detailMap = new Map();
      // 메타 정보
      const metaMatch = md.match(/생성일: (.+)/);
      const countMatch = md.match(/수집 건수: (\d+)/);
      setText('subtitle', `${metaMatch ? metaMatch[1] : ''} 기준 · 총 ${countMatch ? countMatch[1] : '?'}건`);

      // 테이블 파싱
      const lines = md.split('\n');
      const tableStart = lines.findIndex(l => /^\|\s*날짜\s*\|/.test(l));
      if (tableStart === -1) {
        throw new Error('테이블 헤더(날짜 | 시간 | ...)를 찾지 못했습니다.');
      }
      const tableEnd = lines.findIndex((l, i) => i > tableStart + 1 && !l.startsWith('|'));
      const tableLines = lines.slice(tableStart + 2, tableEnd === -1 ? lines.length : tableEnd);

      allItems = tableLines.map(line => {
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.length < 10) return null;
        // 11컬럼(신청자수 포함) 또는 10컬럼(이전 형식) 모두 지원
        let date, time, type, title, status, mode, location, capacity, appliedCountStr, author, id;
        if (cells.length >= 11) {
          [date, time, type, title, status, mode, location, capacity, appliedCountStr, author, id] = cells;
        } else {
          [date, time, type, title, status, mode, location, capacity, author, id] = cells;
          appliedCountStr = '-';
        }
        const [start = '', end = ''] = String(time || '').split('-');
        const appliedCount = /^\d+/.test(appliedCountStr) ? parseInt(appliedCountStr, 10) : null;
        const capNum = parseInt(capacity);
        return {
          id: parseInt(id),
          date,
          time,
          start,
          end,
          type,
          title: title.replace(/^\[.*?\]\s*/, '').replace(/&amp;/g, '&'),
          rawTitle: title,
          status: status.replace(/[\[\]]/g, ''),
          mode,
          location,
          capacity,
          capNum,
          appliedCount,
          author,
          startMin: timeToMin(start),
          endMin: timeToMin(end),
        };
      }).filter(Boolean);

      // 상세 내용 파싱
      const detailStart = md.indexOf('## 상세 내용');
      if (detailStart > -1) {
        const detailMd = md.slice(detailStart);
        const sections = detailMd.split(/^####\s+/m).slice(1);
        sections.forEach(section => {
          const idMatch = section.match(/- ID:\s*(\d+)/);
          const urlMatch = section.match(/- 상세 URL:\s*(\S+)/);

          // 신청자 명단 테이블 추출
          const applicants = [];
          const listMatch = section.match(/\*\*신청자 명단\*\*\s*\n\s*\n([\s\S]+?)\n\n/);
          if (listMatch) {
            const rows = listMatch[1].split('\n').slice(2); // 헤더 2줄 스킵
            for (const row of rows) {
              const cells = row.split('|').slice(1, -1).map(c => c.trim());
              if (cells.length >= 5 && cells[1]) {
                applicants.push({
                  no: cells[0],
                  name: cells[1],
                  applyAt: cells[2],
                  cancelAt: cells[3],
                  status: cells[4],
                });
              }
            }
          }

          // 본문 (신청자 명단 영역 이후 또는 상세 URL 이후)
          let content = '';
          if (listMatch) {
            const afterList = section.indexOf(listMatch[0]) + listMatch[0].length;
            content = section.slice(afterList).trim();
          } else {
            const m = section.match(/상세 URL:.*\n([\s\S]+?)(?=\n#### |\n### |$)/);
            content = m ? m[1].trim() : '';
          }
          if (content === '_상세 내용 없음_') content = '';

          if (idMatch) {
            const id = parseInt(idMatch[1]);
            detailMap.set(id, {
              content,
              url: urlMatch ? urlMatch[1] : null,
              applicants,
            });
          }
        });
      }
    }

    function timeToMin(t) {
      if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return Number.POSITIVE_INFINITY;
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    }

    // 제목 정규화 → 같은 회차 묶기 위함
    function normalizeTitle(title) {
      return title
        // [멘토 특강], [자유 멘토링], [멘토이름], [1차], [오프라인] 등 모든 대괄호 prefix 제거
        .replace(/\[[^\]]+\]/g, '')
        // 1차, 2차, (1), (2), (추가특강), (재개설) 등
        .replace(/\(\s*\d+\s*\)|\(\s*추가\s*\)|\(\s*재[^)]*\)|\(\s*[12]차[^)]*\)/g, '')
        .replace(/\d+차/g, '')
        // 공백 정리
        .replace(/\s+/g, ' ')
        .trim();
    }

    // 작성자 + 정규화 제목 → 회차 그룹
    let seriesMap = new Map(); // groupKey -> [items]
    function buildSeriesMap() {
      seriesMap.clear();
      for (const item of allItems) {
        const key = `${item.author}|${normalizeTitle(item.title)}`;
        if (!seriesMap.has(key)) seriesMap.set(key, []);
        seriesMap.get(key).push(item);
      }
    }

    function getSeriesItems(item) {
      const key = `${item.author}|${normalizeTitle(item.title)}`;
      const arr = seriesMap.get(key) || [];
      return arr.filter(x => x.id !== item.id);
    }

    // 다른 회차 중 신청한 게 있는지
    function hasAppliedSibling(item) {
      const others = getSeriesItems(item);
      return others.some(x => getState(x.id) === 'applied');
    }

    // ===== 충돌 감지 =====
    function findConflictPairs(items = allItems) {
      const appliedItems = items.filter(i => getState(i.id) === 'applied');
      const pairs = [];
      for (let i = 0; i < appliedItems.length; i++) {
        for (let j = i + 1; j < appliedItems.length; j++) {
          const a = appliedItems[i], b = appliedItems[j];
          if (a.date === b.date && a.startMin < b.endMin && b.startMin < a.endMin) {
            pairs.push({ a, b });
          }
        }
      }
      return pairs;
    }

    function conflictPairsToSet(pairs) {
      const conflicts = new Set();
      pairs.forEach(({ a, b }) => {
        conflicts.add(a.id);
        conflicts.add(b.id);
      });
      return conflicts;
    }

    function findConflicts() {
      return conflictPairsToSet(findConflictPairs());
    }

    function renderConflictWarning(pairs) {
      const warning = byId('conflictWarning');
      if (!warning) return;

      if (!pairs.length) {
        warning.classList.remove('show');
        warning.replaceChildren();
        return;
      }

      warning.classList.add('show');
      warning.innerHTML = `
        <div class="conflict-warning-title">시간 중복 경고 · ${pairs.length}건</div>
        <div class="conflict-warning-list">
          ${pairs.map(({ a, b }) => {
            const md = a.date.slice(5).replace('-', '/');
            const wd = WEEKDAYS[new Date(a.date + 'T00:00:00').getDay()];
            const start = Math.max(a.startMin, b.startMin);
            const end = Math.min(a.endMin, b.endMin);
            return `
              <button class="conflict-warning-item" type="button" data-conflict-id="${a.id}">
                <span class="conflict-warning-time">${md}(${wd}) ${formatMin(start)}-${formatMin(end)}</span>
                ${escape(a.author)} · ${escape(a.title)} / ${escape(b.author)} · ${escape(b.title)}
              </button>
            `;
          }).join('')}
        </div>
      `;
      warning.querySelectorAll('[data-conflict-id]').forEach(btn => {
        btn.onclick = () => showDetail(parseInt(btn.dataset.conflictId));
      });
    }

    function hideConflictWarning() {
      const warning = byId('conflictWarning');
      if (!warning) return;
      warning.classList.remove('show');
      warning.replaceChildren();
    }

    function formatMin(min) {
      const h = String(Math.floor(min / 60)).padStart(2, '0');
      const m = String(min % 60).padStart(2, '0');
      return `${h}:${m}`;
    }

    // 신청한 강의와 시간 겹치는 다른 강의 찾기 (못 듣게 되는 후보)
    function findOverlaps(items = allItems) {
      const appliedItems = items.filter(i => getState(i.id) === 'applied');
      const overlaps = new Set();
      for (const item of items) {
        if (getState(item.id) === 'applied') continue; // 신청한 건 제외
        for (const ap of appliedItems) {
          if (item.date === ap.date && item.startMin < ap.endMin && ap.startMin < item.endMin) {
            overlaps.add(item.id);
            break;
          }
        }
      }
      return overlaps;
    }

    // ===== 데이터 갱신 변경점(diff) =====
    // 갱신은 보통 뷰어가 열린 채 일어나므로, 직전 상태를 메모리에서 캡처해 새 수집본과 비교한다.
    const SNAPSHOT_FIELDS = ['title', 'author', 'date', 'start', 'end', 'location', 'mode'];

    function captureSnapshot() {
      const snapshot = new Map();
      for (const item of allItems) {
        const slim = { id: item.id };
        for (const field of SNAPSHOT_FIELDS) slim[field] = item[field];
        snapshot.set(item.id, slim);
      }
      return snapshot;
    }

    // 순수 함수: 직전/현재 스냅샷(Map<id, slim>)을 받아 변경을 분류해 반환한다.
    // 인원(신청자 수·마감) 변화는 제외하고 멘토링 정보 자체(일정·장소·존재)의 변화만 본다.
    function computeDiff(prev, next) {
      const diff = { hadPrev: !!(prev && prev.size), added: [], removed: [], changed: [], favoriteNew: [], mine: [] };
      if (diff.hadPrev) {
        for (const [id, now] of next) {
          const before = prev.get(id);
          if (!before) { diff.added.push(now); continue; }
          const types = [];
          if (before.date !== now.date || before.start !== now.start || before.end !== now.end) types.push('time');
          if (before.location !== now.location || before.mode !== now.mode) types.push('place');
          if (types.length) diff.changed.push({ id, item: now, prev: before, types });
        }
        for (const [id, before] of prev) {
          if (!next.has(id)) diff.removed.push(before);
        }
        diff.favoriteNew = diff.added.filter(item => {
          const mentor = findMentor(item.author);
          return mentor && isFavoriteMentor(mentor);
        });
        // 내가 신청(applied)한 멘토링의 변동 — 일정/장소 변경 또는 삭제 (인원 변동 제외)
        diff.mine = [
          ...diff.removed.filter(x => getState(x.id) === 'applied').map(x => ({ kind: 'removed', item: x })),
          ...diff.changed.filter(c => getState(c.id) === 'applied').map(c => ({ kind: 'changed', entry: c })),
        ];
      }
      const changedOf = (type) => diff.changed.filter(c => c.types.includes(type)).length;
      diff.counts = {
        mine: diff.mine.length,
        added: diff.added.length,
        removed: diff.removed.length,
        time: changedOf('time'),
        place: changedOf('place'),
        favoriteNew: diff.favoriteNew.length,
      };
      // total은 객관적 변경(중복 없는 added/removed/time/place)만 — mine은 그 부분집합이라 제외
      diff.counts.total = diff.counts.added + diff.counts.removed + diff.counts.time + diff.counts.place;
      return diff;
    }

    function isMyItem(id) {
      const state = getState(id);
      return state === 'applied' || state === 'interest';
    }

    const DIFF_TYPE_META = {
      mine: { label: '🔔 내 신청 변동', badge: '🔔' },
      added: { label: '🆕 신규', badge: '🆕' },
      removed: { label: '❌ 삭제', badge: '❌' },
      time: { label: '🕐 일정 변경', badge: '🕐' },
      place: { label: '📍 장소 변경', badge: '📍' },
    };

    function diffWhen(item) {
      if (!item.date) return '';
      const wd = WEEKDAYS[new Date(item.date + 'T00:00:00').getDay()];
      return `${item.date.slice(5).replace('-', '/')}(${wd}) ${escape(item.start || '')}`;
    }

    function placeLabel(slim) {
      return slim.mode === '온라인' ? '온라인' : (slim.location || '장소 미정');
    }

    function diffItemButton(item, badge, { removed = false, detail = '' } = {}) {
      const mineClass = !removed && isMyItem(item.id) ? ' mine' : '';
      const removedClass = removed ? ' removed' : '';
      const attrs = removed ? '' : ` data-update-id="${item.id}"`;
      return `
        <button class="update-banner-item${mineClass}${removedClass}"${attrs}>
          <span class="update-banner-when">${diffWhen(item)}</span>
          ${badge} ${escape(item.author)} · ${escape(item.title)}${detail ? `<span class="update-banner-detail"> ${detail}</span>` : ''}
        </button>
      `;
    }

    function typeHasMine(diff, type) {
      if (type === 'added') return diff.added.some(i => isMyItem(i.id));
      if (type === 'removed') return diff.removed.some(i => isMyItem(i.id));
      return diff.changed.some(c => c.types.includes(type) && isMyItem(c.id));
    }

    function changedDetail(c, type) {
      if (type === 'place' && c.types.includes('place')) return `${escape(placeLabel(c.prev))} → ${escape(placeLabel(c.item))}`;
      if (c.types.includes('time')) return `${diffWhen(c.prev)} → ${diffWhen(c.item)}`;
      if (c.types.includes('place')) return `${escape(placeLabel(c.prev))} → ${escape(placeLabel(c.item))}`;
      return '';
    }

    function changedBadge(c, type) {
      if (type === 'place') return DIFF_TYPE_META.place.badge;
      if (type === 'time') return DIFF_TYPE_META.time.badge;
      return c.types.includes('time') ? DIFF_TYPE_META.time.badge : DIFF_TYPE_META.place.badge;
    }

    function diffItemsByType(diff, type) {
      if (type === 'mine') {
        return diff.mine.map(entry => entry.kind === 'removed'
          ? diffItemButton(entry.item, DIFF_TYPE_META.removed.badge, { removed: true })
          : diffItemButton(entry.entry.item, changedBadge(entry.entry), { detail: changedDetail(entry.entry) }));
      }
      if (type === 'added') return diff.added.map(item => diffItemButton(item, DIFF_TYPE_META.added.badge));
      if (type === 'removed') return diff.removed.map(item => diffItemButton(item, DIFF_TYPE_META.removed.badge, { removed: true }));
      return diff.changed
        .filter(c => c.types.includes(type))
        .sort((a, b) => (isMyItem(b.id) ? 1 : 0) - (isMyItem(a.id) ? 1 : 0))
        .map(c => diffItemButton(c.item, changedBadge(c, type), { detail: changedDetail(c, type) }));
    }

    function bindDiffItemClicks(container) {
      container.querySelectorAll('[data-update-id]').forEach(btn => {
        btn.onclick = () => showDetail(parseInt(btn.dataset.updateId, 10));
      });
    }

    function renderUpdateSummary(diff) {
      const el = byId('updateSummary');
      if (!el) return;
      if (diff.counts.total === 0) { el.classList.remove('show'); el.replaceChildren(); return; }

      const types = ['mine', 'added', 'removed', 'time', 'place'].filter(t => diff.counts[t] > 0);
      const chips = types.map(t =>
        `<button class="update-chip" type="button" data-update-chip="${t}">${DIFF_TYPE_META[t].label} ${diff.counts[t]}</button>`
      ).join('');

      el.innerHTML = `
        <div class="update-banner-title">
          <span>갱신 완료 · 변경 ${diff.counts.total}건</span>
          <button class="update-banner-close" type="button" data-update-close title="닫기">✕</button>
        </div>
        <div class="update-banner-chips">${chips}</div>
        <div class="update-banner-list" id="updateSummaryList"></div>
      `;
      el.classList.add('show');

      const listEl = byId('updateSummaryList');
      const showType = (type) => {
        listEl.innerHTML = diffItemsByType(diff, type).join('');
        el.querySelectorAll('[data-update-chip]').forEach(chip =>
          chip.classList.toggle('active', chip.dataset.updateChip === type));
        bindDiffItemClicks(listEl);
      };
      el.querySelectorAll('[data-update-chip]').forEach(chip => {
        chip.onclick = () => showType(chip.dataset.updateChip);
      });
      el.querySelector('[data-update-close]').onclick = () => {
        el.classList.remove('show');
        el.replaceChildren();
      };
      // 내 신청 변동이 있으면 그 칩을, 없으면 내 항목이 걸린 유형을, 그것도 없으면 첫 유형을 펼친다.
      showType(diff.counts.mine > 0 ? 'mine' : (types.find(t => typeHasMine(diff, t)) || types[0]));
    }

    function renderFavoriteUpdate(diff) {
      const el = byId('favoriteUpdate');
      if (!el) return;
      if (!diff.favoriteNew.length) { el.classList.remove('show'); el.replaceChildren(); return; }

      const items = [...diff.favoriteNew].sort((a, b) =>
        (a.author || '').localeCompare(b.author || '', 'ko') || (a.date || '').localeCompare(b.date || ''));
      el.innerHTML = `
        <div class="update-banner-title">
          <span>⭐ 즐겨찾기 멘토 새 특강 ${diff.favoriteNew.length}건</span>
          <button class="update-banner-close" type="button" data-update-close title="닫기">✕</button>
        </div>
        <div class="update-banner-list">
          ${items.map(item => diffItemButton(item, '⭐')).join('')}
        </div>
      `;
      el.classList.add('show');
      el.querySelector('[data-update-close]').onclick = () => {
        el.classList.remove('show');
        el.replaceChildren();
      };
      bindDiffItemClicks(el);
    }

    function hideUpdateBanners() {
      for (const id of ['favoriteUpdate', 'updateSummary']) {
        const el = byId(id);
        if (el) { el.classList.remove('show'); el.replaceChildren(); }
      }
    }

    let toastTimer = null;
    function showToast(message) {
      const el = byId('toast');
      if (!el) return;
      el.textContent = message;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
    }

    function presentDiff(diff) {
      if (!diff.hadPrev) { hideUpdateBanners(); return; }
      renderFavoriteUpdate(diff);
      renderUpdateSummary(diff);
      showToast(diff.counts.total === 0
        ? `변경 없음 · ${allItems.length}건 유지`
        : `변경 ${diff.counts.total}건 반영됨`);
    }

    // ===== 필터 =====
    let filters = {
      search: '',
      status: 'all',
      mode: 'all',
      my: 'all',
    };
    let view = 'calendar'; // 'calendar' | 'scheduleCalendar' | 'schedule' | 'mentors' | 'myMentors' | 'peers'
    let availableMonths = [];
    let currentMonth = todayIso().slice(0, 7);

    function initMonthState() {
      const thisMonth = todayIso().slice(0, 7);
      const previousMonth = currentMonth;
      availableMonths = Array.from(new Set([
        thisMonth,
        ...allItems.map(item => item.date.slice(0, 7)),
      ])).sort();
      currentMonth = availableMonths.includes(previousMonth) ? previousMonth : thisMonth;
    }

    function monthLabel(month) {
      if (!month) return '-';
      const [year, mon] = month.split('-');
      return `${year}년 ${parseInt(mon, 10)}월`;
    }

    function monthIndex() {
      return availableMonths.indexOf(currentMonth);
    }

    function setCurrentMonth(month) {
      if (!availableMonths.includes(month)) return;
      currentMonth = month;
      render();
    }

    function shiftMonth(delta) {
      const idx = monthIndex();
      if (idx < 0) return;
      const next = availableMonths[idx + delta];
      if (next) setCurrentMonth(next);
    }

    function renderMonthSwitcher() {
      const title = byId('monthTitle');
      const meta = byId('monthMeta');
      const prev = byId('prevMonth');
      const next = byId('nextMonth');
      const today = byId('todayMonth');
      const switcher = byId('monthSwitcher');
      if (!title || !switcher || !currentMonth) return;

      // 일정 뷰는 월 전환을 미니 달력 헤더로 통합했으므로 전역 월 바를 숨긴다.
      const usesMonth = view === 'scheduleCalendar' || view === 'calendar';
      switcher.classList.toggle('hidden', !usesMonth);
      if (!usesMonth) return;

      const monthItems = allItems.filter(item => item.date.startsWith(currentMonth));
      const appliedCount = monthItems.filter(item => getState(item.id) === 'applied').length;
      const idx = monthIndex();
      const thisMonth = todayIso().slice(0, 7);

      title.textContent = monthLabel(currentMonth);
      meta.textContent = `${monthItems.length}건 · 신청 ${appliedCount}건`;
      prev.disabled = idx <= 0;
      next.disabled = idx < 0 || idx >= availableMonths.length - 1;
      today.disabled = !availableMonths.includes(thisMonth) || currentMonth === thisMonth;
    }

    function setToolbarControlVisible(id, visible) {
      const element = byId(id);
      if (!element) return;
      element.classList.toggle('toolbar-control-hidden', !visible);
    }

    function renderToolbarControls() {
      const searchInput = byId('search');
      const usesSearch = view === 'schedule' ||
        view === 'scheduleCalendar' ||
        view === 'mentors' ||
        view === 'peers';
      const usesLectureFilters = view === 'schedule' || view === 'scheduleCalendar';

      if (searchInput) {
        searchInput.classList.toggle('toolbar-control-hidden', !usesSearch);
        searchInput.placeholder = view === 'mentors'
          ? '멘토 이름이나 기술분야 검색...'
          : view === 'peers'
            ? '신청자 이름 검색...'
            : '멘토 이름이나 키워드 검색...';
      }

      setToolbarControlVisible('statusFilter', usesLectureFilters);
      setToolbarControlVisible('modeFilter', usesLectureFilters);
      setToolbarControlVisible('myFilter', view === 'schedule');
      setToolbarControlVisible('scheduleToggleGroup', view === 'schedule');
      updateToggleAllDaysButton();
    }

    // sticky 네비+필터 묶음의 실제 높이를 측정해 CSS 변수로 노출 → 미니 달력이 그 바로 아래에 붙는다.
    function updateStickyOffset() {
      const controls = document.querySelector('.sticky-controls');
      if (!controls) return;
      document.documentElement.style.setProperty('--sticky-controls-h', `${controls.offsetHeight}px`);
    }

    function applyFilters(options = {}) {
      const includeMyFilter = options.includeMyFilter !== false;
      return allItems.filter(item => {
        if (currentMonth && !item.date.startsWith(currentMonth)) return false;
        // 검색
        if (filters.search) {
          const q = filters.search.toLowerCase();
          if (!item.title.toLowerCase().includes(q) &&
              !item.author.toLowerCase().includes(q) &&
              !item.location.toLowerCase().includes(q)) return false;
        }
        // 상태
        if (filters.status === 'open' && item.status !== '접수중') return false;
        if (filters.status === 'closed' && item.status !== '마감') return false;
        if (filters.status === 'waiting' && item.status !== '대기') return false;
        // 방식
        if (filters.mode === 'online' && item.mode !== '온라인') return false;
        if (filters.mode === 'offline' && item.mode !== '오프라인') return false;
        // 내 표시
        if (includeMyFilter) {
          const s = getState(item.id);
          if (filters.my === 'applied' && s !== 'applied') return false;
          if (filters.my === 'marked' && s === 'none') return false;
        }
        return true;
      });
    }

    // ===== 렌더 =====
    const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
    const dayCollapsed = new Map();
    let pendingScheduleScrollDate = null;
    let scheduleCalCollapsed = false;

    function todayIso() {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    function isDayCollapsed(date) {
      if (dayCollapsed.has(date)) return dayCollapsed.get(date);
      return true;
    }

    function toggleDay(date) {
      dayCollapsed.set(date, !isDayCollapsed(date));
      render();
    }

    function getScheduleDates() {
      return Array.from(new Set(applyFilters().map(item => item.date))).sort();
    }

    function areAllScheduleDaysCollapsed() {
      const dates = getScheduleDates();
      return dates.length > 0 && dates.every(date => isDayCollapsed(date));
    }

    function setAllScheduleDaysCollapsed(collapsed) {
      getScheduleDates().forEach(date => {
        dayCollapsed.set(date, collapsed);
      });
      render();
    }

    function openTodayScheduleOnly() {
      const today = todayIso();
      getScheduleDates().forEach(date => {
        dayCollapsed.set(date, date !== today);
      });
      pendingScheduleScrollDate = today;
    }

    function updateToggleAllDaysButton() {
      const button = byId('toggleAllDays');
      if (!button) return;
      button.textContent = areAllScheduleDaysCollapsed() ? '전체 열기' : '전체 닫기';
    }

    function render() {
      renderToolbarControls();
      renderMonthSwitcher();
      updateStickyOffset();
      if (view === 'mentors') return renderMentors();
      if (view === 'myMentors') return renderMyMentors();
      if (view === 'peers') return renderPeers();
      if (view === 'scheduleCalendar') return renderScheduleCalendar();
      if (view === 'calendar') return renderAppliedCalendar();
      const filtered = applyFilters();
      const monthItems = allItems.filter(i => !currentMonth || i.date.startsWith(currentMonth));
      const conflictPairs = findConflictPairs(monthItems);
      const conflicts = conflictPairsToSet(conflictPairs);
      const overlaps = findOverlaps(monthItems);

      // 통계
      const allApplied = monthItems.filter(i => getState(i.id) === 'applied').length;
      const allInterest = monthItems.filter(i => getState(i.id) === 'interest').length;
      setHtml('stats', `
        <span class="stat applied">신청 <strong>${allApplied}</strong>건</span>
        <span class="stat">월 <strong>${escape(monthLabel(currentMonth))}</strong></span>
        <span class="stat">관심 <strong>${allInterest}</strong>건</span>
        <span class="stat">필터 결과 <strong>${filtered.length}</strong>건</span>
        ${conflicts.size > 0 ? `<span class="stat conflict">충돌 <strong>${conflicts.size}</strong>건</span>` : ''}
        ${overlaps.size > 0 ? `<span class="stat" style="background:var(--yellow-soft);color:var(--yellow)">시간 겹침 <strong>${overlaps.size}</strong>건</span>` : ''}
      `);

      renderConflictWarning(conflictPairs);

      // 날짜별 그룹
      const grouped = {};
      filtered.forEach(item => {
        if (!grouped[item.date]) grouped[item.date] = [];
        grouped[item.date].push(item);
      });
      const dates = Object.keys(grouped).sort();

      if (dates.length === 0) {
        setHtml('content', '<div class="empty">조건에 맞는 일정이 없습니다.</div>');
        return;
      }

      const listHtml = dates.map(date => {
        const items = grouped[date].sort((a, b) => a.startMin - b.startMin);
        const dt = new Date(date + 'T00:00:00');
        const wd = WEEKDAYS[dt.getDay()];
        const appliedCount = items.filter(i => getState(i.id) === 'applied').length;
        const collapsed = isDayCollapsed(date);

        return `
          <section class="day-group ${collapsed ? 'collapsed' : ''}" data-date="${date}">
            <div class="day-header" data-day-toggle="${date}" title="${collapsed ? '펼치기' : '접기'}">
              <div class="day-title">
                <span class="day-toggle">${collapsed ? '▶' : '▼'}</span>
                ${date.slice(5).replace('-', '/')} <span class="weekday">(${wd})</span>
              </div>
              <div class="day-meta">
                ${items.length}건${appliedCount > 0 ? ` · <span class="applied-count">신청 ${appliedCount}</span>` : ''}
              </div>
            </div>
            <div class="timeline">
              ${items.map(item => renderItem(item, conflicts, overlaps)).join('')}
            </div>
          </section>
        `;
      }).join('');

      setHtml('content', `
        <div class="schedule-layout ${scheduleCalCollapsed ? 'cal-collapsed' : ''}">
          ${renderScheduleMiniCalendar(grouped)}
          <div class="schedule-list">${listHtml}</div>
        </div>
      `);

      // 이벤트
      document.querySelectorAll('[data-day-toggle]').forEach(el => {
        el.onclick = () => toggleDay(el.dataset.dayToggle);
      });
      bindScheduleMiniCalendar();
      updateToggleAllDaysButton();
      if (pendingScheduleScrollDate) {
        const target = pendingScheduleScrollDate;
        pendingScheduleScrollDate = null;
        requestAnimationFrame(() => {
          document.querySelector(`.day-group[data-date="${target}"]`)
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      }
      document.querySelectorAll('.item').forEach(el => {
        el.onclick = e => {
          if (e.target.closest('.action-btn')) return;
          const mentorBadge = e.target.closest('[data-mentor-id]');
          if (mentorBadge) {
            e.stopPropagation();
            showMentor(mentorBadge.dataset.mentorId);
            return;
          }
          showDetail(parseInt(el.dataset.id));
        };
      });
      document.querySelectorAll('.action-btn[data-action]').forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          const id = parseInt(btn.dataset.id);
          const action = btn.dataset.action;
          const cur = getState(id);
          setState(id, cur === action ? 'none' : action);
          render();
        };
      });
    }

    // 일정 탭 미니 달력. 월 전환·통계를 헤더에 통합했다(전역 monthSwitcher는 이 뷰에서 숨김).
    // 그리드는 현재 리스트에 보이는 날짜(grouped)만 클릭 가능, 배지 숫자는 그날 '내 신청' 건수.
    function renderScheduleMiniCalendar(grouped) {
      const monthItems = currentMonth ? allItems.filter(item => item.date.startsWith(currentMonth)) : [];
      const monthApplied = monthItems.filter(item => getState(item.id) === 'applied').length;
      const idx = monthIndex();
      const thisMonth = todayIso().slice(0, 7);
      const prevDisabled = idx <= 0;
      const nextDisabled = idx < 0 || idx >= availableMonths.length - 1;
      const todayDisabled = !availableMonths.includes(thisMonth) || currentMonth === thisMonth;

      const head = `
        <div class="mini-cal-head">
          <div class="mini-cal-top">
            <span class="mini-cal-title">${escape(monthLabel(currentMonth))}</span>
            <button class="mini-cal-toggle" type="button" data-cal-toggle>달력 ${scheduleCalCollapsed ? '▸' : '▾'}</button>
          </div>
          <div class="mini-cal-meta">${monthItems.length}건 · 신청 ${monthApplied}건</div>
          <div class="mini-cal-nav">
            <button class="chip" type="button" data-cal-nav="prev" ${prevDisabled ? 'disabled' : ''}>‹ 이전</button>
            <button class="chip" type="button" data-cal-nav="today" ${todayDisabled ? 'disabled' : ''}>이번 달</button>
            <button class="chip" type="button" data-cal-nav="next" ${nextDisabled ? 'disabled' : ''}>다음 ›</button>
          </div>
        </div>
      `;

      if (!currentMonth) return `<aside class="mini-cal">${head}</aside>`;

      const [year, month] = currentMonth.split('-').map(Number);
      const lastDate = new Date(year, month, 0).getDate();
      const startOffset = new Date(year, month - 1, 1).getDay();
      const totalCells = Math.ceil((startOffset + lastDate) / 7) * 7;
      const today = todayIso();

      const cells = [];
      for (let i = 0; i < totalCells; i++) {
        const day = i - startOffset + 1;
        if (day < 1 || day > lastDate) {
          cells.push('<div class="mini-day blank"></div>');
          continue;
        }
        const date = `${currentMonth}-${String(day).padStart(2, '0')}`;
        const dayItems = grouped[date] || [];
        const hasSessions = dayItems.length > 0;
        const applied = dayItems.filter(item => getState(item.id) === 'applied').length;

        const classes = ['mini-day', hasSessions ? 'has-sessions' : 'muted'];
        if (date === today) classes.push('today');

        const badge = applied > 0
          ? `<span class="mini-day-count">${applied}</span>`
          : (hasSessions ? '<span class="mini-day-dot"></span>' : '');
        const title = hasSessions
          ? `${date.slice(5).replace('-', '/')} · ${dayItems.length}건${applied ? `, 신청 ${applied}` : ''}`
          : '';

        cells.push(`
          <button class="${classes.join(' ')}" type="button" title="${title}"
                  ${hasSessions ? `data-cal-date="${date}"` : 'disabled'}>
            ${day}${badge}
          </button>
        `);
      }

      return `
        <aside class="mini-cal">
          ${head}
          <div class="mini-cal-body">
            <div class="mini-cal-weekdays">
              ${WEEKDAYS.map(d => `<div class="mini-cal-weekday">${d}</div>`).join('')}
            </div>
            <div class="mini-cal-grid">${cells.join('')}</div>
          </div>
        </aside>
      `;
    }

    function bindScheduleMiniCalendar() {
      const toggle = document.querySelector('[data-cal-toggle]');
      if (toggle) toggle.onclick = () => {
        scheduleCalCollapsed = !scheduleCalCollapsed;
        render();
      };
      document.querySelectorAll('.mini-day[data-cal-date]').forEach(btn => {
        btn.onclick = () => {
          const date = btn.dataset.calDate;
          dayCollapsed.set(date, false); // 클릭한 날짜는 자동 펼침
          pendingScheduleScrollDate = date; // 렌더 후 그 날짜로 스크롤
          render();
        };
      });

      document.querySelectorAll('.mini-cal [data-cal-nav]').forEach(btn => {
        btn.onclick = () => {
          const nav = btn.dataset.calNav;
          if (nav === 'prev') shiftMonth(-1);
          else if (nav === 'next') shiftMonth(1);
          else {
            const thisMonth = todayIso().slice(0, 7);
            if (availableMonths.includes(thisMonth)) setCurrentMonth(thisMonth);
          }
        };
      });
    }

    function renderScheduleCalendar() {
      const monthItems = allItems.filter(item => currentMonth && item.date.startsWith(currentMonth));
      const filtered = applyFilters({ includeMyFilter: false })
        .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
      const appliedCount = monthItems.filter(item => getState(item.id) === 'applied').length;
      const conflictPairs = findConflictPairs(monthItems);
      const conflicts = conflictPairsToSet(conflictPairs);

      setHtml('stats', `
        <span class="stat">전체 일정 <strong>${monthItems.length}</strong>건</span>
        <span class="stat">필터 결과 <strong>${filtered.length}</strong>건</span>
        <span class="stat applied">신청 <strong>${appliedCount}</strong>건</span>
        <span class="stat">월 <strong>${escape(monthLabel(currentMonth))}</strong></span>
        ${conflicts.size > 0 ? `<span class="stat conflict">충돌 <strong>${conflicts.size}</strong>건</span>` : ''}
      `);

      renderConflictWarning(conflictPairs);
      renderCalendarGrid(filtered, '조건에 맞는 일정이 없습니다.');
    }

    function renderAppliedCalendar() {
      const monthItems = allItems.filter(item => currentMonth && item.date.startsWith(currentMonth));
      const applied = monthItems
        .filter(item => getState(item.id) === 'applied')
        .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
      const conflictPairs = findConflictPairs(monthItems);
      const conflicts = conflictPairsToSet(conflictPairs);

      setHtml('stats', `
        <span class="stat applied">내 신청 <strong>${applied.length}</strong>건</span>
        <span class="stat">월 <strong>${escape(monthLabel(currentMonth))}</strong></span>
        ${conflicts.size > 0 ? `<span class="stat conflict">충돌 <strong>${conflicts.size}</strong>건</span>` : ''}
      `);

      renderConflictWarning(conflictPairs);
      renderCalendarGrid(applied, '신청한 일정이 없습니다.');
    }

    function renderCalendarGrid(items, emptyMessage) {
      if (!currentMonth) {
        setHtml('content', '<div class="empty">표시할 월 데이터가 없습니다.</div>');
        return;
      }

      if (!items.length) {
        setHtml('content', `<div class="empty">${emptyMessage}</div>`);
        return;
      }

      const byDate = new Map();
      for (const item of items) {
        if (!byDate.has(item.date)) byDate.set(item.date, []);
        byDate.get(item.date).push(item);
      }

      const [year, month] = currentMonth.split('-').map(Number);
      const first = new Date(year, month - 1, 1);
      const last = new Date(year, month, 0);
      const startOffset = first.getDay();
      const totalCells = Math.ceil((startOffset + last.getDate()) / 7) * 7;
      const today = todayIso();

      const cells = [];
      for (let i = 0; i < totalCells; i++) {
        const day = i - startOffset + 1;
        if (day < 1 || day > last.getDate()) {
          cells.push('<div class="calendar-day muted"></div>');
          continue;
        }

        const date = `${currentMonth}-${String(day).padStart(2, '0')}`;
        const items = byDate.get(date) || [];
        cells.push(`
          <div class="calendar-day ${date === today ? 'today' : ''}">
            <div class="calendar-date">
              <span>${day}</span>
              ${items.length ? `<span class="calendar-count">${items.length}건</span>` : ''}
            </div>
            <div class="calendar-events">
              ${items.map(item => {
                const state = getState(item.id);
                const closedClass = item.status === '마감' && state !== 'applied' ? 'closed' : '';
                return `
                  <button class="calendar-event ${state} ${closedClass}" type="button" data-id="${item.id}">
                    <span class="calendar-event-time">${escape(item.start)}-${escape(item.end)} · ${escape(item.author)}</span>
                    <span class="calendar-event-title">${state !== 'none' ? STATE_LABELS[state] + ' ' : ''}${escape(item.title)}</span>
                  </button>
                `;
              }).join('')}
            </div>
          </div>
        `);
      }

      setHtml('content', `
        <div class="calendar-view">
          <div class="calendar-weekdays">
            ${WEEKDAYS.map(day => `<div class="calendar-weekday">${day}</div>`).join('')}
          </div>
          <div class="calendar-grid">
            ${cells.join('')}
          </div>
        </div>
      `);

      document.querySelectorAll('.calendar-event[data-id]').forEach(btn => {
        btn.onclick = () => showDetail(parseInt(btn.dataset.id));
      });
    }

    function renderItem(item, conflicts, overlaps) {
      const state = getState(item.id);
      const isConflict = conflicts.has(item.id);
      const isOverlap = overlaps && overlaps.has(item.id);
      const duration = item.endMin - item.startMin;
      const dur = duration >= 60
        ? `${Math.floor(duration/60)}h${duration%60 ? ' '+(duration%60)+'m' : ''}`
        : `${duration}m`;

      const classes = ['item', state];
      if (isConflict) classes.push('conflict');
      else if (isOverlap) classes.push('overlap');
      if (item.status === '마감') classes.push('closed');
      if (item.status === '대기') classes.push('waiting');
      if (state !== 'applied' && hasAppliedSibling(item)) classes.push('sibling-applied');

      return `
        <div class="${classes.join(' ')}" data-id="${item.id}">
          <div class="item-row">
            <div class="item-time">
              ${item.time}
              <span class="duration">${dur}</span>
            </div>
            <div class="item-main">
              <div class="item-title">
                ${escape(item.title)}
                ${isConflict ? '<span class="conflict-tag">충돌</span>' : ''}
                ${!isConflict && isOverlap ? '<span class="overlap-tag">시간 겹침</span>' : ''}
                ${(() => {
                  const others = getSeriesItems(item);
                  if (others.length === 0) return '';
                  const appliedCount = others.filter(x => getState(x.id) === 'applied').length;
                  const myState = getState(item.id);
                  // 이 강의는 신청 안 했는데 다른 회차를 신청한 경우 강조
                  if (myState !== 'applied' && appliedCount > 0) {
                    return `<span class="badge" style="background:var(--green);color:white;font-size:10px;font-weight:700">✓ 다른 회차 신청함</span><span class="badge" style="background:var(--purple-soft);color:var(--purple);font-size:10px;font-weight:600">🔄 ${others.length}</span>`;
                  }
                  return `<span class="badge" style="background:var(--purple-soft);color:var(--purple);font-size:10px;font-weight:600">🔄 다른 회차 ${others.length}${appliedCount > 0 ? ' (✓'+appliedCount+')' : ''}</span>`;
                })()}
              </div>
              <div class="item-meta">
                ${(() => {
                  const m = findMentor(item.author);
                  const clickable = m ? `data-mentor-id="${m.id}" style="cursor:pointer"` : '';
                  const avatar = m ? renderMentorImage(m, 'avatar', item.author) : '';
                  return `<span class="badge author" ${clickable} title="${m ? '멘토 상세 보기' : ''}">${avatar}${escape(item.author)}${m ? ' ›' : ''}</span>`;
                })()}
                <span class="badge ${item.type === '멘토 특강' ? 'lecture' : 'free'}">${item.type}</span>
                <span class="badge ${item.mode === '온라인' ? 'online' : 'offline'}">${item.mode === '온라인' ? '🌐' : '📍'} ${item.mode === '온라인' ? 'webex' : escape(item.location)}</span>
                ${(() => {
                  if (item.status === '마감') return `<span class="badge closed">마감 (${item.capacity})</span>`;
                  // 신청자 수 정보 있으면 70% 기준
                  if (item.appliedCount !== null && item.capNum > 0) {
                    const ratio = item.appliedCount / item.capNum;
                    const cls = ratio >= 0.7 ? 'tight' : (ratio >= 0.5 ? 'small' : '');
                    const icon = ratio >= 0.7 ? '⚠ ' : '';
                    return `<span class="badge ${cls}">${icon}${item.appliedCount}/${item.capNum}명${ratio >= 0.7 ? ' 마감 임박' : ''}</span>`;
                  }
                  // 신청자 수 없으면 정원만
                  return `<span>정원 ${item.capacity}</span>`;
                })()}
                ${item.status === '대기' ? `<span class="badge waiting">대기</span>` : ''}
              </div>
            </div>
            <div class="item-actions">
              ${renderActionButtons(item.id, state)}
            </div>
          </div>
        </div>
      `;
    }

    function renderActionButtons(id, state) {
      return ['applied', 'interest', 'meh', 'exclude'].map(s => `
        <button class="action-btn ${state === s ? 'active ' + s : ''}"
                data-id="${id}" data-action="${s}"
                title="${STATE_NAMES[s]}">
          ${STATE_LABELS[s]}
        </button>
      `).join('');
    }

    let peerFilterMode = 'shared'; // 'shared' | 'all'

    function renderPeers() {
      const myAppliedIds = new Set(
        allItems.filter(i => getState(i.id) === 'applied').map(i => i.id)
      );
      const myAppliedCount = myAppliedIds.size;

      // 모든 강의의 신청자 명단을 사람별로 모음
      const peerMap = new Map(); // name -> { all: [], shared: [] }
      for (const item of allItems) {
        const detail = detailMap.get(item.id) || {};
        const applicants = detail.applicants || [];
        for (const a of applicants) {
          if (a.status !== '신청완료') continue;
          if (!peerMap.has(a.name)) peerMap.set(a.name, { all: [], shared: [] });
          const rec = peerMap.get(a.name);
          rec.all.push({ item, applyAt: a.applyAt });
          if (myAppliedIds.has(item.id)) rec.shared.push({ item, applyAt: a.applyAt });
        }
      }

      // 본인: 이름이 지정되어 있으면 그 이름을 우선 사용하고, 없으면 기존 방식으로 추론
      let me = selectedPerson || null;
      if (!me) {
        for (const [name, rec] of peerMap) {
          if (rec.shared.length === myAppliedCount && myAppliedCount > 0) {
            me = name;
            break;
          }
        }
      }
      if (me) peerMap.delete(me);

      // 검색 필터
      const q = filters.search.toLowerCase();
      let entries = [...peerMap.entries()];
      if (q) entries = entries.filter(([name]) => name.toLowerCase().includes(q));

      // 모드별 필터
      if (peerFilterMode === 'shared') {
        entries = entries.filter(([, rec]) => rec.shared.length > 0);
      }

      // 정렬: 함께 듣는 수 → 전체 강의 수 → 이름
      entries.sort((a, b) =>
        b[1].shared.length - a[1].shared.length ||
        b[1].all.length - a[1].all.length ||
        a[0].localeCompare(b[0], 'ko')
      );

      const sharedCount = [...peerMap.values()].filter(r => r.shared.length > 0).length;

      setHtml('stats', `
        <span class="stat applied">내 신청 <strong>${myAppliedCount}</strong>건</span>
        ${me ? `<span class="stat">나: <strong>${escape(me)}</strong></span>` : ''}
        <span class="stat">전체 신청자 <strong>${peerMap.size}</strong>명</span>
        <span class="stat applied">함께 듣는 사람 <strong>${sharedCount}</strong>명</span>
      `);
      hideConflictWarning();

      if (peerMap.size === 0) {
        setHtml('content', `
          <div class="empty">
            아직 신청자 명단 데이터가 없습니다. 소마 페이지에서 멘토링 수집을 먼저 실행해주세요.
          </div>
        `);
        return;
      }

      setHtml('content', `
        <div class="toolbar" style="margin-bottom:12px">
          <div class="filter-group">
            <button class="chip ${peerFilterMode === 'shared' ? 'active' : ''}" data-peer-mode="shared">🤝 나와 함께 (${sharedCount})</button>
            <button class="chip ${peerFilterMode === 'all' ? 'active' : ''}" data-peer-mode="all">🌐 모든 사람 (${peerMap.size})</button>
          </div>
        </div>
        <section class="day-group">
          <div class="day-header">
            <div class="day-title">${peerFilterMode === 'shared' ? '🤝 함께 듣는 사람' : '🌐 모든 신청자'}</div>
            <div class="day-meta">${entries.length}명</div>
          </div>
          <div class="mentor-grid">
            ${entries.map(([name, rec]) => {
              const sharedN = rec.shared.length;
              const totalN = rec.all.length;
              const tileColor = sharedN >= 3 ? 'var(--red-soft)'
                : sharedN >= 2 ? 'var(--yellow-soft)'
                : sharedN >= 1 ? 'var(--green-soft)'
                : 'var(--bg-soft)';
              const sharedBadgeCls = sharedN >= 3 ? 'tight' : sharedN >= 2 ? 'small' : sharedN >= 1 ? 'online' : '';
              const recentLectures = [...rec.all].sort((a, b) =>
                a.item.date.localeCompare(b.item.date) || a.item.startMin - b.item.startMin
              );
              return `
                <div class="mentor-tile" data-peer="${escape(name)}">
                  <div class="mentor-tile-img" style="display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:var(--text-muted);background:${tileColor}">
                    ${escape(name.charAt(0))}
                  </div>
                  <div style="flex:1;min-width:0">
                    <div class="mentor-tile-name">${escape(name)}</div>
                    <div class="mentor-tile-meta" style="display:flex;gap:6px;flex-wrap:wrap">
                      ${sharedN > 0 ? `<span class="badge ${sharedBadgeCls}">🤝 ${sharedN}건 함께</span>` : ''}
                      <span class="badge">총 ${totalN}건 신청</span>
                    </div>
                    <div class="mentor-tile-tags" style="margin-top:6px">
                      ${recentLectures.slice(0, 3).map(({item}) => `
                        <span class="mentor-tile-tag">${item.date.slice(5).replace('-','/')} ${item.start}</span>
                      `).join('')}
                      ${recentLectures.length > 3 ? `<span class="mentor-tile-tag">+${recentLectures.length - 3}</span>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </section>
      `);

      document.querySelectorAll('[data-peer-mode]').forEach(el => {
        el.onclick = () => {
          peerFilterMode = el.dataset.peerMode;
          render();
        };
      });
      document.querySelectorAll('.mentor-tile[data-peer]').forEach(el => {
        el.onclick = () => showPeer(el.dataset.peer);
      });
    }

    function showPeer(name) {
      const myAppliedIds = new Set(
        allItems.filter(i => getState(i.id) === 'applied').map(i => i.id)
      );

      // 그 사람이 신청한 모든 강의
      const allLectures = [];
      for (const item of allItems) {
        const detail = detailMap.get(item.id) || {};
        const applicants = detail.applicants || [];
        const found = applicants.find(a => a.name === name && a.status === '신청완료');
        if (found) allLectures.push({ item, applyAt: found.applyAt });
      }
      allLectures.sort((a, b) =>
        a.item.date.localeCompare(b.item.date) || a.item.startMin - b.item.startMin
      );

      const shared = allLectures.filter(({item}) => myAppliedIds.has(item.id));
      const onlyTheirs = allLectures.filter(({item}) => !myAppliedIds.has(item.id));

      const renderLectureRow = ({item}) => {
        const wd = WEEKDAYS[new Date(item.date+'T00:00:00').getDay()];
        const myState = getState(item.id);
        return `
          <div class="mentor-lecture-item" style="cursor:pointer" data-modal-detail-id="${item.id}">
            <span class="mentor-lecture-date">${item.date.slice(5).replace('-','/')}(${wd}) ${item.start}</span>
            <span style="flex:1">${myState !== 'none' ? STATE_LABELS[myState]+' ' : ''}${escape(item.title)}</span>
            <span class="badge author">${escape(item.author)}</span>
          </div>
        `;
      };

      openModal(`
        <h2>
          👤 ${escape(name)}
          <button class="modal-close" type="button" data-modal-close>✕</button>
        </h2>
        <div class="modal-meta" style="display:flex;gap:12px;font-size:13px">
          <div><strong>${allLectures.length}</strong>건 신청</div>
          ${shared.length > 0 ? `<div style="color:var(--green)">✓ 나와 같이 <strong>${shared.length}</strong>건</div>` : ''}
        </div>
        ${shared.length > 0 ? `
          <div class="mentor-lectures" style="background:var(--green-soft);border-left:3px solid var(--green)">
            <div class="mentor-lectures-title" style="color:var(--green)">📚 나와 함께 듣는 강의 (${shared.length}건)</div>
            ${shared.map(renderLectureRow).join('')}
          </div>
        ` : ''}
        ${onlyTheirs.length > 0 ? `
          <div class="mentor-lectures">
            <div class="mentor-lectures-title">🔍 ${escape(name)}이 듣는 다른 강의 (${onlyTheirs.length}건)</div>
            ${onlyTheirs.map(renderLectureRow).join('')}
          </div>
        ` : ''}
      `);
    }

    function renderMyMentors() {
      // 신청한 강의를 멘토별로 그룹
      const applied = allItems.filter(i => getState(i.id) === 'applied');
      const byAuthor = new Map();
      for (const it of applied) {
        if (!byAuthor.has(it.author)) byAuthor.set(it.author, []);
        byAuthor.get(it.author).push(it);
      }

      setHtml('stats', `
        <span class="stat applied">신청 멘토 <strong>${byAuthor.size}</strong>명</span>
        <span class="stat applied">총 <strong>${applied.length}</strong>건</span>
        <span class="stat">즐겨찾기 <strong>${countFavoriteMentors()}</strong>명</span>
      `);
      hideConflictWarning();

      if (byAuthor.size === 0) {
        setHtml('content', '<div class="empty">신청한 강의가 없습니다.</div>');
        return;
      }

      // 강의 수 많은 멘토 우선
      const sorted = [...byAuthor.entries()].sort((a, b) => {
        const ma = findMentor(a[0]);
        const mb = findMentor(b[0]);
        const fa = isFavoriteMentor(ma) ? 1 : 0;
        const fb = isFavoriteMentor(mb) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        return b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko');
      });

      setHtml('content', sorted.map(([author, lectures]) => {
        const m = findMentor(author);
        lectures.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
        return `
          <section class="day-group">
              <div class="day-header" style="cursor:${m ? 'pointer' : 'default'}" ${m ? `data-mentor-id="${m.id}"` : ''}>
                <div class="day-title" style="display:flex;align-items:center;gap:10px">
                  ${m ? renderMentorImage(m, 'avatar', author, ' style="width:32px;height:32px"') : ''}
                  ${m ? renderFavoriteButton(m) : ''}
                  ${escape(author)}
                  ${m ? '<span style="font-size:11px;color:var(--accent);font-weight:400">› 상세</span>' : ''}
                </div>
              <div class="day-meta">
                <span class="applied-count">${lectures.length}건 신청</span>
              </div>
            </div>
            <div class="timeline">
              ${lectures.map(item => {
                const wd = WEEKDAYS[new Date(item.date+'T00:00:00').getDay()];
                return `
                  <div class="item applied" data-id="${item.id}">
                    <div class="item-row">
                      <div class="item-time">
                        ${item.date.slice(5).replace('-','/')}(${wd})
                        <span class="duration">${item.start}-${item.end}</span>
                      </div>
                      <div class="item-main">
                        <div class="item-title">${escape(item.title)}</div>
                        <div class="item-meta">
                          <span class="badge ${item.type === '멘토 특강' ? 'lecture' : 'free'}">${item.type}</span>
                          <span class="badge ${item.mode === '온라인' ? 'online' : 'offline'}">${item.mode === '온라인' ? '🌐' : '📍'} ${item.mode === '온라인' ? 'webex' : escape(item.location)}</span>
                        </div>
                      </div>
                      <div class="item-actions"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </section>
        `;
      }).join(''));

      document.querySelectorAll('.day-header[data-mentor-id]').forEach(el => {
        el.onclick = e => {
          if (e.target.closest('[data-mentor-favorite]')) return;
          showMentor(el.dataset.mentorId);
        };
      });
      document.querySelectorAll('.item[data-id]').forEach(el => {
        el.onclick = () => showDetail(parseInt(el.dataset.id));
      });
    }

    function renderMentors() {
      // 모든 멘토를 시간순/이름순으로 표시
      const mentorsArr = Array.from(new Set(mentorMap.values()));
      const q = filters.search.toLowerCase();
      const filtered = mentorsArr.filter(m => {
        if (!q) return true;
        return m.name.toLowerCase().includes(q)
          || (m['기술분야'] || '').toLowerCase().includes(q)
          || (m['주개발언어'] || '').toLowerCase().includes(q)
          || (m['거주지'] || '').toLowerCase().includes(q);
      });

      // 강의가 있는 멘토 우선, 그 다음 이름순
      const lecCount = new Map();
      for (const it of allItems) {
        const m = findMentor(it.author);
        if (m) lecCount.set(m.id, (lecCount.get(m.id) || 0) + 1);
      }
      filtered.sort((a, b) => {
        const fa = isFavoriteMentor(a) ? 1 : 0;
        const fb = isFavoriteMentor(b) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        const la = lecCount.get(a.id) || 0;
        const lb = lecCount.get(b.id) || 0;
        if (la !== lb) return lb - la;
        return a.name.localeCompare(b.name, 'ko');
      });

      setHtml('stats', `
        <span class="stat">전체 멘토 <strong>${mentorsArr.length}</strong>명</span>
        <span class="stat">강의 보유 <strong>${[...lecCount].length}</strong>명</span>
        <span class="stat">검색 결과 <strong>${filtered.length}</strong>명</span>
        <span class="stat">즐겨찾기 <strong>${countFavoriteMentors()}</strong>명</span>
      `);
      hideConflictWarning();

      if (filtered.length === 0) {
        setHtml('content', '<div class="empty">조건에 맞는 멘토가 없습니다.</div>');
        return;
      }

      setHtml('content', `
        <div class="mentor-grid">
          ${filtered.map(m => {
            const cnt = lecCount.get(m.id) || 0;
            const tags = (m['기술분야'] || '').split(',').slice(0, 4).map(t => t.trim()).filter(Boolean);
            return `
              <div class="mentor-tile ${isFavoriteMentor(m) ? 'favorite' : ''}" data-mentor-id="${m.id}">
                ${renderFavoriteButton(m)}
                ${renderMentorImage(m, 'mentor-tile-img', m.name) || '<div class="mentor-tile-img"></div>'}
                <div style="flex:1;min-width:0">
                  <div class="mentor-tile-name">${escape(m.name)}</div>
                  <div class="mentor-tile-meta">
                    ${m['거주지'] ? escape(m['거주지']) : '?'}
                    ${cnt > 0 ? ` · <span style="color:var(--accent);font-weight:600">강의 ${cnt}건</span>` : ''}
                  </div>
                  ${tags.length ? `<div class="mentor-tile-tags">${tags.map(t => `<span class="mentor-tile-tag">${escape(t)}</span>`).join('')}</div>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `);

      document.querySelectorAll('.mentor-tile').forEach(el => {
        el.onclick = e => {
          if (e.target.closest('[data-mentor-favorite]')) return;
          showMentor(el.dataset.mentorId);
        };
      });
    }

    function showMentor(mentorId) {
      const m = Array.from(mentorMap.values()).find(x => x.id === mentorId);
      if (!m) return;

      // 이 멘토의 강의 목록
      const lectures = allItems.filter(it => {
        const found = findMentor(it.author);
        return found && found.id === mentorId;
      }).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);

      openModal(`
        <h2>
          ${escape(m.name)}
          ${renderFavoriteButton(m)}
          <button class="modal-close" type="button" data-modal-close>✕</button>
        </h2>
        <div class="mentor-card">
          ${renderMentorImage(m, 'avatar-lg', m.name)}
          <div class="mentor-info">
            ${m['거주지'] ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${escape(m['거주지'])}${m['MBTI'] ? ' · '+escape(m['MBTI']) : ''}${m['취미'] ? ' · '+escape(m['취미']) : ''}</div>` : ''}
            ${m['멘토 구분'] ? `<div class="mentor-tags">${m['멘토 구분'].split(',').map(t => `<span class="mentor-tag region">${escape(t.trim())}</span>`).join('')}</div>` : ''}
            ${m['주개발언어'] ? `<div class="mentor-tags">${m['주개발언어'].split(',').map(t => `<span class="mentor-tag lang">${escape(t.trim())}</span>`).join('')}</div>` : ''}
            ${m['기술분야'] ? `<div class="mentor-tags">${m['기술분야'].split(',').map(t => `<span class="mentor-tag tech">${escape(t.trim())}</span>`).join('')}</div>` : ''}
            <div class="mentor-links">
              ${m.notionUrl ? `<a href="${m.notionUrl}" target="_blank" class="mentor-link" style="background:var(--accent-soft);color:var(--accent);font-weight:600">📋 Notion 원본</a>` : ''}
              ${m['Linked-In'] ? `<a href="${normalizeUrl(m['Linked-In'])}" target="_blank" class="mentor-link">LinkedIn</a>` : ''}
              ${m['GitHub'] ? `<a href="${normalizeUrl(m['GitHub'])}" target="_blank" class="mentor-link">GitHub</a>` : ''}
              ${m['Blog'] ? `<a href="${normalizeUrl(m['Blog'])}" target="_blank" class="mentor-link">Blog</a>` : ''}
              ${m['Google Scholar'] ? `<a href="${normalizeUrl(m['Google Scholar'])}" target="_blank" class="mentor-link">Scholar</a>` : ''}
              ${m['Facebook'] ? `<a href="${normalizeUrl(m['Facebook'])}" target="_blank" class="mentor-link">Facebook</a>` : ''}
              ${m['오픈카카오톡'] ? `<a href="${normalizeUrl(m['오픈카카오톡'])}" target="_blank" class="mentor-link">오픈카톡</a>` : ''}
              ${m['Webex Space'] ? `<a href="${normalizeUrl(m['Webex Space'])}" target="_blank" class="mentor-link">Webex</a>` : ''}
              ${m['이메일'] ? `<a href="mailto:${m['이메일']}" class="mentor-link">${escape(m['이메일'])}</a>` : ''}
              ${m['전화번호'] ? `<a href="tel:${m['전화번호']}" class="mentor-link">${escape(m['전화번호'])}</a>` : ''}
            </div>
          </div>
        </div>
        ${m.bio && m.bio.length > m.name.length + 5 ? `<div class="mentor-bio-full">${escape(m.bio)}</div>` : ''}
        ${lectures.length > 0 ? `
          <div class="mentor-lectures">
            <div class="mentor-lectures-title">📚 ${m.name}의 강의 ${lectures.length}건</div>
            ${lectures.map(it => {
              const wd = WEEKDAYS[new Date(it.date+'T00:00:00').getDay()];
              const state = getState(it.id);
              return `
                <div class="mentor-lecture-item" style="cursor:pointer" data-modal-detail-id="${it.id}">
                  <span class="mentor-lecture-date">${it.date.slice(5).replace('-','/')}(${wd}) ${it.start}</span>
                  <span style="flex:1">${state !== 'none' ? STATE_LABELS[state]+' ' : ''}${escape(it.title)}</span>
                  <span class="badge ${it.mode === '온라인' ? 'online' : 'offline'}" style="font-size:10px">${it.mode === '온라인' ? '🌐' : '📍'}</span>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
      `);
    }

    function escape(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function renderMentorImage(mentor, className, altText, extraAttrs = '') {
      const src = mentor?.imageUrl || mentor?.imageLocal;
      if (!src) return '';
      const fallback = mentor.imageFallbackUrl && mentor.imageFallbackUrl !== src
        ? ` data-fallback-src="${escape(mentor.imageFallbackUrl)}"`
        : '';
      return `<img class="${className}" src="${escape(src)}" alt="${escape(altText || mentor.name || '')}" loading="lazy"${fallback}${extraAttrs}/>`;
    }

    function normalizeUrl(u) {
      if (!u) return '#';
      if (/^https?:\/\//.test(u)) return u;
      return 'https://' + u;
    }

    // ===== 모달 =====
    function showDetail(id) {
      const item = allItems.find(i => i.id === id);
      if (!item) return;
      const detail = detailMap.get(id) || {};
      const state = getState(id);

      const mentor = findMentor(item.author);
      const mentorCard = mentor ? `
        <div class="mentor-card">
          ${renderMentorImage(mentor, 'avatar-lg', mentor.name)}
          <div class="mentor-info">
            <div class="mentor-name">${escape(mentor.name)} ${renderFavoriteButton(mentor)}</div>
            ${mentor['거주지'] ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${escape(mentor['거주지'])}${mentor['MBTI'] ? ' · '+escape(mentor['MBTI']) : ''}</div>` : ''}
            ${mentor['멘토 구분'] ? `<div class="mentor-tags">${mentor['멘토 구분'].split(',').map(t => `<span class="mentor-tag region">${escape(t.trim())}</span>`).join('')}</div>` : ''}
            ${mentor['주개발언어'] ? `<div class="mentor-tags">${mentor['주개발언어'].split(',').slice(0,8).map(t => `<span class="mentor-tag lang">${escape(t.trim())}</span>`).join('')}</div>` : ''}
            ${mentor['기술분야'] ? `<div class="mentor-tags">${mentor['기술분야'].split(',').slice(0,10).map(t => `<span class="mentor-tag tech">${escape(t.trim())}</span>`).join('')}</div>` : ''}
            <div class="mentor-links">
              ${mentor.notionUrl ? `<a href="${mentor.notionUrl}" target="_blank" class="mentor-link" style="background:var(--accent-soft);color:var(--accent);font-weight:600">📋 Notion 원본</a>` : ''}
              ${mentor['Linked-In'] ? `<a href="${normalizeUrl(mentor['Linked-In'])}" target="_blank" class="mentor-link">LinkedIn</a>` : ''}
              ${mentor['GitHub'] ? `<a href="${normalizeUrl(mentor['GitHub'])}" target="_blank" class="mentor-link">GitHub</a>` : ''}
              ${mentor['Blog'] ? `<a href="${normalizeUrl(mentor['Blog'])}" target="_blank" class="mentor-link">Blog</a>` : ''}
              ${mentor['오픈카카오톡'] ? `<a href="${normalizeUrl(mentor['오픈카카오톡'])}" target="_blank" class="mentor-link">오픈카톡</a>` : ''}
              ${mentor['이메일'] ? `<a href="mailto:${mentor['이메일']}" class="mentor-link">${escape(mentor['이메일'])}</a>` : ''}
            </div>
            ${mentor.bio && mentor.bio.length > mentor.name.length + 5 ? `<details style="margin-top:8px;font-size:12px;color:var(--text-soft)"><summary style="cursor:pointer;color:var(--accent)">자기소개 펼치기 (${mentor.bio.length}자)</summary><div style="margin-top:6px;white-space:pre-wrap;line-height:1.6;background:var(--bg-card);padding:10px;border-radius:6px">${escape(mentor.bio)}</div></details>` : ''}
          </div>
        </div>
      ` : '';

      openModal(`
        <h2>
          ${escape(item.title)}
          <button class="modal-close" type="button" data-modal-close>✕</button>
        </h2>
        ${mentorCard}
        <dl class="modal-meta">
          <dt>날짜</dt><dd>${item.date} (${WEEKDAYS[new Date(item.date+'T00:00:00').getDay()]}) ${item.time}</dd>
          <dt>멘토</dt><dd>${escape(item.author)}${mentor ? ' · 매칭 ✓' : ''}</dd>
          <dt>구분</dt><dd>${item.type}</dd>
          <dt>방식</dt><dd>${item.mode} · ${escape(item.location)}</dd>
          <dt>정원</dt><dd>${item.capacity}</dd>
          <dt>상태</dt><dd>${item.status}</dd>
          <dt>ID</dt><dd>${item.id}</dd>
        </dl>
        ${(() => {
          const others = getSeriesItems(item);
          if (others.length === 0) return '';
          others.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
          return `
            <div class="mentor-lectures" style="margin-bottom:12px;background:var(--purple-soft);border-left:3px solid var(--purple)">
              <div class="mentor-lectures-title" style="color:var(--purple)">🔄 같은 주제 다른 회차 ${others.length}건</div>
              ${others.map(it => {
                const wd = WEEKDAYS[new Date(it.date+'T00:00:00').getDay()];
                const st = getState(it.id);
                const isApplied = st === 'applied';
                return `
                  <div class="mentor-lecture-item" style="cursor:pointer;${isApplied ? 'background:var(--green);color:white;border-radius:4px;padding:6px 8px;font-weight:600' : ''}" data-modal-detail-id="${it.id}">
                    <span class="mentor-lecture-date" ${isApplied ? 'style="color:white"' : ''}>${it.date.slice(5).replace('-','/')}(${wd}) ${it.start}-${it.end}</span>
                    <span style="flex:1">${isApplied ? '✓ 이 회차로 신청 완료 ' : (st !== 'none' ? STATE_LABELS[st]+' ' : '')}${it.mode === '온라인' ? '🌐' : '📍'} ${it.status}</span>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        })()}
        ${detail.applicants && detail.applicants.length ? `
          <div class="mentor-lectures" style="margin-bottom:12px">
            <div class="mentor-lectures-title">📋 신청자 명단 (${detail.applicants.length}명) — 클릭 시 그 사람의 다른 강의 보기</div>
            ${detail.applicants.map(a => `
              <div class="mentor-lecture-item" style="cursor:pointer" data-modal-peer-name="${escape(a.name)}">
                <span class="mentor-lecture-date">${escape(a.applyAt)}</span>
                <span style="flex:1;font-weight:600">${escape(a.name)} ›</span>
                <span class="badge ${a.status === '신청완료' ? 'online' : 'closed'}" style="font-size:10px">${escape(a.status)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${detail.content ? `<div class="modal-content">${escape(detail.content)}</div>` : '<div class="empty">강의 상세 내용 없음</div>'}
        <div class="modal-actions">
          ${['applied', 'interest', 'meh', 'exclude'].map(s => `
            <button class="action-btn ${state === s ? 'active ' + s : ''}"
                    data-modal-action="${s}" data-modal-action-id="${id}">
              ${STATE_LABELS[s]} ${STATE_NAMES[s]}
            </button>
          `).join('')}
          ${detail.url ? `<a href="${detail.url}" target="_blank" class="link-btn">원본 보기 →</a>` : ''}
        </div>
      `);
    }

    function closeModal() {
      byId('modal').classList.remove('open');
    }

    function handleExtensionMessage(event) {
      if (!isTrustedMessage(event)) return;

      const { type, name } = event.data || {};
      if (type === MESSAGE_TYPES.selectedPerson) {
        const detectedName = String(name || '').trim();
        if (detectedName && detectedName !== selectedPerson) setDetectedPerson(detectedName);
        return;
      }

      if (type === MESSAGE_TYPES.collectorStarted) {
        setRefreshButtonState('수집 중...', true);
        return;
      }

      if (type === MESSAGE_TYPES.dataUpdated) {
        refreshFromStorage()
          .catch(err => {
            setRefreshButtonState('데이터 갱신');
            setHtml('content', `<div class="empty">데이터 갱신 후 로드 실패: ${err.message}</div>`);
          });
      }
    }

    document.addEventListener('error', e => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (!img.matches('.avatar, .avatar-lg, .mentor-tile-img')) return;
      const fallbackSrc = img.dataset.fallbackSrc;
      if (fallbackSrc && img.src !== fallbackSrc) {
        img.removeAttribute('data-fallback-src');
        img.src = fallbackSrc;
        return;
      }
      img.style.display = 'none';
    }, true);

    window.addEventListener('message', handleExtensionMessage);
    window.addEventListener('resize', updateStickyOffset);

    // ===== 이벤트 =====
    byId('search').oninput = e => {
      filters.search = e.target.value;
      render();
    };
    byId('prevMonth').onclick = () => shiftMonth(-1);
    byId('nextMonth').onclick = () => shiftMonth(1);
    byId('todayMonth').onclick = () => {
      const thisMonth = todayIso().slice(0, 7);
      if (availableMonths.includes(thisMonth)) setCurrentMonth(thisMonth);
    };
    byId('toggleAllDays').onclick = () => {
      setAllScheduleDaysCollapsed(!areAllScheduleDaysCollapsed());
    };
    bindFilterChip('#statusFilter', button => {
      filters.status = button.dataset.filter;
    });
    bindFilterChip('#modeFilter', button => {
      filters.mode = button.dataset.mode;
    });
    bindFilterChip('#myFilter', button => {
      filters.my = button.dataset.my;
    });
    bindFilterChip('#viewSwitch', button => {
      const nextView = button.dataset.view;
      const isEnteringSchedule = view !== 'schedule' && nextView === 'schedule';
      view = nextView;
      if (isEnteringSchedule) openTodayScheduleOnly();
    });

    byId('refreshData').onclick = () => {
      setRefreshButtonState('갱신 중...', true);
      window.parent.postMessage({ type: MESSAGE_TYPES.runCollector }, SWM_ORIGIN);
    };

    byId('refreshMentors').onclick = () => {
      refreshMentors();
    };

    byId('exportBackup').onclick = () => {
      exportBackup();
    };

    byId('importBackup').onclick = () => {
      byId('importBackupInput').click();
    };

    byId('importBackupInput').onchange = (event) => {
      const file = event.target.files?.[0];
      event.target.value = ''; // 같은 파일을 다시 선택할 수 있게 초기화
      if (file) importBackup(file);
    };

    document.addEventListener('click', e => {
      if (e.target === byId('modal')) {
        closeModal();
        return;
      }

      const closeBtn = e.target.closest('[data-modal-close]');
      if (closeBtn) {
        closeModal();
        return;
      }

      const favoriteBtn = e.target.closest('[data-mentor-favorite]');
      if (favoriteBtn) {
        e.preventDefault();
        e.stopPropagation();
        toggleFavoriteMentor(favoriteBtn.dataset.mentorFavorite);
        render();
        const modalMentorId = favoriteBtn.dataset.mentorModalId;
        if (byId('modal').classList.contains('open') && modalMentorId) showMentor(modalMentorId);
        return;
      }

      const detailEl = e.target.closest('[data-modal-detail-id]');
      if (detailEl) {
        const id = Number(detailEl.dataset.modalDetailId);
        if (Number.isFinite(id)) {
          closeModal();
          showDetail(id);
        }
        return;
      }

      const peerEl = e.target.closest('[data-modal-peer-name]');
      if (peerEl) {
        closeModal();
        showPeer(peerEl.dataset.modalPeerName || '');
        return;
      }

      const actionEl = e.target.closest('[data-modal-action]');
      if (actionEl) {
        const id = Number(actionEl.dataset.modalActionId);
        const state = actionEl.dataset.modalAction;
        if (Number.isFinite(id) && STATES.includes(state)) {
          setState(id, getState(id) === state ? 'none' : state);
          render();
          showDetail(id);
        }
        return;
      }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });

    // 시작 — 사용자 상태를 먼저 chrome.storage.local에서 불러온 뒤(구버전 localStorage는 1회 이전) 일정을 로드한다.
    (async () => {
      try {
        await migrateFromLocalStorage();
        await loadUserData();
      } catch (e) {
        console.warn('사용자 상태 로드 실패:', e.message);
      }
      await loadData();
    })().catch(err => {
      setHtml('content', `<div class="empty">데이터 로드 실패: ${err.message}<br><br>소마 부산 페이지에서 확장 아이콘을 누른 뒤 <strong>멘토링 수집</strong>을 먼저 실행해주세요.</div>`);
    });
  
