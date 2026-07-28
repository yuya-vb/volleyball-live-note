(() => {
  "use strict";

  const STORAGE_KEY = "youtubeLiveMemoApp.v1";
  const STORAGE_VERSION = 1;
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const API_LOAD_TIMEOUT_MS = 15000;
  const SEEK_VERIFY_DELAY_MS = 1100;
  const TOAST_DURATION_MS = 4200;

  const state = {
    player: null,
    apiReady: false,
    playerReady: false,
    activeVideoId: "",
    pendingVideoId: "",
    loadedVideoId: "",
    editingMemoId: "",
    apiTimeoutId: null,
    sharedMode: false,
    editUnlocked: false,
    editPassphrase: "",
    data: createEmptyData(),
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", initializeApp);

  function initializeApp() {
    cacheElements();
    bindEvents();
    state.data = loadStoredData();
    renderMemoList();
    updateMemoCharacterCount();
    updateDataActionButtons();
    loadYouTubeApi();
    detectSharedMode();
  }

  function cacheElements() {
    elements.videoInput = document.getElementById("video-input");
    elements.loadVideoButton = document.getElementById("load-video-button");
    elements.memoText = document.getElementById("memo-text");
    elements.memoCharacterCount = document.getElementById("memo-character-count");
    elements.saveOffset = document.getElementById("save-offset");
    elements.saveMemoButton = document.getElementById("save-memo-button");
    elements.memoSearch = document.getElementById("memo-search");
    elements.memoSort = document.getElementById("memo-sort");
    elements.exportCsvButton = document.getElementById("export-csv-button");
    elements.deleteAllButton = document.getElementById("delete-all-button");
    elements.memoList = document.getElementById("memo-list");
    elements.memoCount = document.getElementById("memo-count");
    elements.rewindButton = document.getElementById("rewind-button");
    elements.forwardButton = document.getElementById("forward-button");
    elements.liveEdgeButton = document.getElementById("live-edge-button");
    elements.playerStatus = document.getElementById("player-status");
    elements.playerStatusTitle = document.getElementById("player-status-title");
    elements.playerStatusDetail = document.getElementById("player-status-detail");
    elements.activeVideoLabel = document.getElementById("active-video-label");
    elements.sharingBlock = document.getElementById("sharing-block");
    elements.sharingStatus = document.getElementById("sharing-status");
    elements.editPassphrase = document.getElementById("edit-passphrase");
    elements.unlockEditButton = document.getElementById("unlock-edit-button");
    elements.toastRegion = document.getElementById("toast-region");
  }

  function bindEvents() {
    elements.loadVideoButton.addEventListener("click", handleVideoLoadRequest);
    elements.videoInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.ctrlKey) {
        event.preventDefault();
        handleVideoLoadRequest();
      }
    });
    elements.memoText.addEventListener("input", updateMemoCharacterCount);
    elements.saveMemoButton.addEventListener("click", saveMemoAtCurrentPosition);
    elements.memoSearch.addEventListener("input", renderMemoList);
    elements.memoSort.addEventListener("change", renderMemoList);
    elements.exportCsvButton.addEventListener("click", exportCurrentVideoCsv);
    elements.deleteAllButton.addEventListener("click", deleteAllCurrentVideoMemos);
    elements.rewindButton.addEventListener("click", () => movePlaybackBy(-5));
    elements.forwardButton.addEventListener("click", () => movePlaybackBy(5));
    elements.liveEdgeButton.addEventListener("click", seekToLiveEdge);
    elements.unlockEditButton.addEventListener("click", unlockSharedEditing);
    elements.editPassphrase.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        unlockSharedEditing();
      }
    });
    document.addEventListener("keydown", handleKeyboardShortcuts);
  }

  async function detectSharedMode() {
    try {
      const response = await fetch("/api/health", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
        return;
      }
      const result = await response.json();
      if (result.shared !== true) {
        return;
      }

      state.sharedMode = true;
      state.data = createEmptyData();
      elements.sharingBlock.hidden = false;
      updateSharingStatus(false);
      renderMemoList();
      updateDataActionButtons();

      const savedPassphrase = readSessionPassphrase();
      if (savedPassphrase) {
        elements.editPassphrase.value = savedPassphrase;
        await unlockSharedEditing({ silent: true });
      }
      if (state.activeVideoId) {
        await loadSharedMemos(state.activeVideoId);
      }
    } catch (error) {
      console.info("Shared API is not available; using local storage.", error);
    }
  }

  async function unlockSharedEditing(options = {}) {
    if (!state.sharedMode) {
      return;
    }

    const passphrase = elements.editPassphrase.value;
    if (!passphrase) {
      showToast("編集用の合言葉を入力してください。", "error");
      elements.editPassphrase.focus();
      return;
    }

    elements.unlockEditButton.disabled = true;
    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Edit-Passphrase": passphrase,
        },
        body: "{}",
      });
      if (!response.ok) {
        throw new Error(response.status === 401 ? "AUTH_FAILED" : "VERIFY_FAILED");
      }

      state.editPassphrase = passphrase;
      state.editUnlocked = true;
      writeSessionPassphrase(passphrase);
      updateSharingStatus(true);
      elements.editPassphrase.value = "";
      if (!options.silent) {
        showToast("共有メモの編集を有効にしました。", "success");
      }
    } catch (error) {
      state.editPassphrase = "";
      state.editUnlocked = false;
      clearSessionPassphrase();
      updateSharingStatus(false);
      if (!options.silent) {
        showToast(
          error.message === "AUTH_FAILED"
            ? "合言葉が正しくありません。"
            : "編集権限を確認できませんでした。",
          "error",
        );
      }
    } finally {
      elements.unlockEditButton.disabled = false;
    }
  }

  function updateSharingStatus(unlocked) {
    elements.sharingStatus.textContent = unlocked ? "編集可能" : "閲覧モード";
    elements.sharingStatus.classList.toggle("is-unlocked", unlocked);
    elements.sharingStatus.classList.toggle("is-locked", !unlocked);
  }

  function readSessionPassphrase() {
    try {
      return sessionStorage.getItem("youtubeLiveMemo.editPassphrase") || "";
    } catch {
      return "";
    }
  }

  function writeSessionPassphrase(passphrase) {
    try {
      sessionStorage.setItem("youtubeLiveMemo.editPassphrase", passphrase);
    } catch (error) {
      console.warn("Could not save edit session.", error);
    }
  }

  function clearSessionPassphrase() {
    try {
      sessionStorage.removeItem("youtubeLiveMemo.editPassphrase");
    } catch (error) {
      console.warn("Could not clear edit session.", error);
    }
  }

  function loadYouTubeApi() {
    if (window.YT && typeof window.YT.Player === "function") {
      handleYouTubeApiReady();
      return;
    }

    window.onYouTubeIframeAPIReady = handleYouTubeApiReady;

    const apiScript = document.createElement("script");
    apiScript.src = "https://www.youtube.com/iframe_api";
    apiScript.async = true;
    apiScript.addEventListener("error", () => {
      clearApiTimeout();
      setPlayerStatus(
        "YouTube APIを読み込めません",
        "ネットワーク接続やブラウザの追跡防止設定を確認してください",
        "error",
      );
      showToast("YouTube IFrame Player APIの読み込みに失敗しました。", "error");
    });
    document.head.appendChild(apiScript);

    state.apiTimeoutId = window.setTimeout(() => {
      if (!state.apiReady) {
        setPlayerStatus(
          "YouTube APIが応答しません",
          "ページを再読み込みするか、通信状態を確認してください",
          "error",
        );
        showToast("YouTube IFrame Player APIの読み込みがタイムアウトしました。", "error");
      }
    }, API_LOAD_TIMEOUT_MS);
  }

  function handleYouTubeApiReady() {
    clearApiTimeout();
    state.apiReady = true;
    setPlayerStatus(
      "プレイヤーAPIの準備ができました",
      "YouTube URLまたは動画IDを入力してください",
      "ready",
    );

    if (state.pendingVideoId) {
      createOrLoadPlayer(state.pendingVideoId);
    }
  }

  function clearApiTimeout() {
    if (state.apiTimeoutId !== null) {
      window.clearTimeout(state.apiTimeoutId);
      state.apiTimeoutId = null;
    }
  }

  function handleVideoLoadRequest() {
    const input = elements.videoInput.value.trim();
    if (!input) {
      showToast("YouTube URLまたは動画IDを入力してください。", "error");
      elements.videoInput.focus();
      return;
    }

    const videoId = extractVideoId(input);
    if (!videoId) {
      showToast("入力内容から有効なYouTube動画IDを取得できませんでした。", "error");
      elements.videoInput.focus();
      return;
    }

    state.activeVideoId = videoId;
    state.pendingVideoId = videoId;
    state.editingMemoId = "";
    elements.activeVideoLabel.textContent = `VIDEO ${videoId}`;
    renderMemoList();
    updateDataActionButtons();
    if (state.sharedMode) {
      loadSharedMemos(videoId);
    }

    if (!state.apiReady) {
      setPlayerStatus("動画を待機中", "YouTubeプレイヤーAPIの準備後に読み込みます", "");
      showToast("プレイヤーを準備中です。完了後に動画を読み込みます。", "warning");
      return;
    }

    createOrLoadPlayer(videoId);
  }

  function createOrLoadPlayer(videoId) {
    if (!state.apiReady || !window.YT || typeof window.YT.Player !== "function") {
      showToast("YouTubeプレイヤーがまだ準備できていません。", "error");
      return;
    }

    setPlayerStatus("動画を読み込んでいます", `VIDEO ${videoId}`, "");

    try {
      if (!state.player) {
        state.loadedVideoId = videoId;
        state.player = new window.YT.Player("youtube-player", {
          width: "100%",
          height: "100%",
          videoId,
          playerVars: {
            autoplay: 1,
            controls: 1,
            playsinline: 1,
            rel: 0,
          },
          events: {
            onReady: handlePlayerReady,
            onStateChange: handlePlayerStateChange,
            onError: handlePlayerError,
          },
        });
        return;
      }

      if (!state.playerReady) {
        return;
      }

      state.loadedVideoId = videoId;
      state.pendingVideoId = "";
      state.player.loadVideoById(videoId);
      showToast(`動画 ${videoId} を読み込みました。`, "success");
    } catch (error) {
      console.error("Player load failed:", error);
      setPlayerStatus("動画を読み込めません", "入力内容や通信状態を確認してください", "error");
      showToast("動画を読み込めませんでした。", "error");
    }
  }

  function handlePlayerReady(event) {
    state.playerReady = true;

    try {
      if (state.pendingVideoId && state.pendingVideoId !== state.loadedVideoId) {
        state.loadedVideoId = state.pendingVideoId;
        event.target.loadVideoById(state.pendingVideoId);
      } else {
        event.target.playVideo();
      }
      state.pendingVideoId = "";
      setPlayerStatus("プレイヤーの準備ができました", `VIDEO ${state.activeVideoId}`, "ready");
      showToast(`動画 ${state.activeVideoId} を読み込みました。`, "success");
    } catch (error) {
      console.error("Player ready handling failed:", error);
      showToast("動画の再生開始に失敗しました。再生ボタンを押してください。", "warning");
    }
  }

  function handlePlayerStateChange(event) {
    const playerState = window.YT && window.YT.PlayerState;
    if (!playerState) {
      return;
    }

    if (event.data === playerState.PLAYING) {
      setPlayerStatus("再生中", `VIDEO ${state.activeVideoId}`, "playing");
    } else if (event.data === playerState.BUFFERING) {
      setPlayerStatus("バッファリング中", "映像を読み込んでいます", "");
    } else if (event.data === playerState.PAUSED) {
      setPlayerStatus("一時停止中", "メモ保存時も現在の再生位置を記録できます", "ready");
    } else if (event.data === playerState.ENDED) {
      setPlayerStatus("再生が終了しました", "ライブ地点ボタンで終端付近へ移動できます", "ready");
    }
  }

  function handlePlayerError(event) {
    const messages = {
      2: "動画IDまたは再生パラメーターが正しくありません。",
      5: "HTML5プレイヤーで動画を再生できません。",
      100: "動画が見つからないか、削除されています。",
      101: "動画の所有者により埋め込み再生が許可されていません。",
      150: "動画の所有者により埋め込み再生が許可されていません。",
    };
    const message = messages[event.data] || "YouTube動画を読み込めませんでした。";
    setPlayerStatus("動画を再生できません", message, "error");
    showToast(message, "error");
  }

  function extractVideoId(rawInput) {
    const input = rawInput.trim();
    if (VIDEO_ID_PATTERN.test(input)) {
      return input;
    }

    let parsedUrl;
    try {
      const urlCandidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
      parsedUrl = new URL(urlCandidate);
    } catch {
      return "";
    }

    const hostname = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
    let candidate = "";

    if (hostname === "youtu.be") {
      candidate = parsedUrl.pathname.split("/").filter(Boolean)[0] || "";
    } else if (
      hostname === "youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname === "music.youtube.com"
    ) {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      if (pathParts[0] === "watch") {
        candidate = parsedUrl.searchParams.get("v") || "";
      } else if (["live", "embed", "shorts"].includes(pathParts[0])) {
        candidate = pathParts[1] || "";
      }
    }

    return VIDEO_ID_PATTERN.test(candidate) ? candidate : "";
  }

  async function saveMemoAtCurrentPosition() {
    const memoText = elements.memoText.value.trim();
    if (!memoText) {
      showToast("メモを入力してください。", "error");
      elements.memoText.focus();
      return;
    }

    if (!canUsePlayer()) {
      return;
    }
    if (state.sharedMode && !ensureSharedEditing()) {
      return;
    }

    try {
      const currentTime = Number(state.player.getCurrentTime());
      if (!Number.isFinite(currentTime) || currentTime < 0) {
        throw new Error("Invalid current time");
      }

      const offset = Number(elements.saveOffset.value);
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
      const memoTime = Math.max(0, currentTime - safeOffset);
      const memo = {
        id: createUniqueId(),
        videoId: state.activeVideoId,
        text: memoText,
        time: memoTime,
        savedAt: new Date().toISOString(),
      };

      let savedMemo = memo;
      if (state.sharedMode) {
        const result = await requestSharedApi("/api/notes", {
          method: "POST",
          body: {
            videoId: memo.videoId,
            text: memo.text,
            time: memo.time,
          },
        });
        savedMemo = result.note;
        state.data.videos[state.activeVideoId] = [...getCurrentVideoMemos(), savedMemo];
      } else {
        const nextMemos = [...getCurrentVideoMemos(), memo];
        if (!commitCurrentVideoMemos(nextMemos)) {
          return;
        }
      }

      elements.memoText.value = "";
      updateMemoCharacterCount();
      state.editingMemoId = "";
      renderMemoList();
      updateDataActionButtons();
      showToast(`${formatPlaybackTime(savedMemo.time)} にメモを保存しました。`, "success");
      elements.memoText.focus();
    } catch (error) {
      console.error("Memo save failed:", error);
      if (!error.handled) {
        showToast("現在の再生位置を取得できず、メモを保存できませんでした。", "error");
      }
    }
  }

  function seekToMemo(memo) {
    if (!isValidMemo(memo, state.activeVideoId) || !canUsePlayer()) {
      return;
    }

    try {
      state.player.seekTo(memo.time, true);
      state.player.playVideo();
      showToast(`${formatPlaybackTime(memo.time)} へ移動しました。`, "success");
      verifySeekPosition(memo.time);
    } catch (error) {
      console.error("Seek failed:", error);
      showToast("指定位置へ移動できません。DVRが有効か確認してください。", "error");
    }
  }

  function verifySeekPosition(targetTime) {
    window.setTimeout(() => {
      if (!state.playerReady || !state.player) {
        return;
      }

      try {
        const actualTime = Number(state.player.getCurrentTime());
        if (Number.isFinite(actualTime) && Math.abs(actualTime - targetTime) > 8) {
          showToast(
            "指定位置へ移動できなかった可能性があります。ライブのDVR範囲を確認してください。",
            "warning",
          );
        }
      } catch (error) {
        console.warn("Seek verification failed:", error);
      }
    }, SEEK_VERIFY_DELAY_MS);
  }

  function movePlaybackBy(seconds) {
    if (!canUsePlayer()) {
      return;
    }

    try {
      const currentTime = Number(state.player.getCurrentTime());
      const duration = Number(state.player.getDuration());
      if (!Number.isFinite(currentTime)) {
        throw new Error("Invalid current time");
      }

      let targetTime = Math.max(0, currentTime + seconds);
      if (seconds > 0 && Number.isFinite(duration) && duration > 0) {
        targetTime = Math.min(targetTime, duration);
      }

      state.player.seekTo(targetTime, true);
      showToast(`${formatPlaybackTime(targetTime)} へ移動しました。`, "success");
    } catch (error) {
      console.error("Relative seek failed:", error);
      showToast("再生位置を移動できませんでした。", "error");
    }
  }

  function seekToLiveEdge() {
    if (!canUsePlayer()) {
      return;
    }

    try {
      const duration = Number(state.player.getDuration());
      if (!Number.isFinite(duration) || duration <= 0) {
        showToast("ライブの最新地点を取得できません。DVR設定を確認してください。", "error");
        return;
      }

      const targetTime = Math.max(0, duration - 0.5);
      state.player.seekTo(targetTime, true);
      state.player.playVideo();
      showToast("取得可能なライブの最新地点へ移動しました。", "success");
    } catch (error) {
      console.error("Live edge seek failed:", error);
      showToast("ライブ地点へ移動できませんでした。DVR設定を確認してください。", "error");
    }
  }

  function togglePlayback() {
    if (!canUsePlayer()) {
      return;
    }

    try {
      const playerState = state.player.getPlayerState();
      const youtubePlayerState = window.YT && window.YT.PlayerState;
      if (youtubePlayerState && playerState === youtubePlayerState.PLAYING) {
        state.player.pauseVideo();
        showToast("動画を一時停止しました。", "success");
      } else {
        state.player.playVideo();
        showToast("動画を再生しました。", "success");
      }
    } catch (error) {
      console.error("Playback toggle failed:", error);
      showToast("再生状態を切り替えられませんでした。", "error");
    }
  }

  function canUsePlayer() {
    if (!state.apiReady || !state.player || !state.playerReady) {
      showToast("YouTubeプレイヤーが準備できていません。先に動画を読み込んでください。", "error");
      return false;
    }
    if (!state.activeVideoId) {
      showToast("先にYouTube動画を読み込んでください。", "error");
      return false;
    }
    return true;
  }

  function renderMemoList() {
    elements.memoList.replaceChildren();

    const allMemos = getCurrentVideoMemos();
    const searchQuery = elements.memoSearch.value.trim().toLocaleLowerCase();
    const filteredMemos = allMemos.filter((memo) =>
      memo.text.toLocaleLowerCase().includes(searchQuery),
    );
    const sortedMemos = sortMemos(filteredMemos);

    if (searchQuery) {
      elements.memoCount.textContent = `${sortedMemos.length} / ${allMemos.length}件`;
    } else {
      elements.memoCount.textContent = `${allMemos.length}件`;
    }

    if (!state.activeVideoId) {
      elements.memoList.appendChild(
        createEmptyState("動画が選択されていません", "動画を読み込むと、その動画専用のメモが表示されます。"),
      );
      return;
    }

    if (allMemos.length === 0) {
      elements.memoList.appendChild(
        createEmptyState("まだメモがありません", "映像を見ながら、気になった場面を記録してください。"),
      );
      return;
    }

    if (sortedMemos.length === 0) {
      elements.memoList.appendChild(
        createEmptyState("検索結果が0件です", "検索キーワードを変更するか、入力を消してください。"),
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    sortedMemos.forEach((memo) => fragment.appendChild(createMemoCard(memo)));
    elements.memoList.appendChild(fragment);
  }

  function createMemoCard(memo) {
    const card = document.createElement("article");
    card.className = "memo-card";
    card.dataset.memoId = memo.id;

    const header = document.createElement("div");
    header.className = "memo-card-header";

    const timeButton = document.createElement("button");
    timeButton.type = "button";
    timeButton.className = "time-jump-button";
    timeButton.textContent = formatPlaybackTime(memo.time);
    timeButton.title = "この再生位置へ移動";
    timeButton.addEventListener("click", () => seekToMemo(memo));

    const savedDate = document.createElement("time");
    savedDate.className = "saved-date";
    savedDate.dateTime = memo.savedAt;
    savedDate.textContent = formatSavedDate(memo.savedAt);

    header.append(timeButton, savedDate);
    card.appendChild(header);

    if (state.editingMemoId === memo.id) {
      card.appendChild(createMemoEditArea(memo));
    } else {
      const contentButton = document.createElement("button");
      contentButton.type = "button";
      contentButton.className = "memo-content-button";
      contentButton.textContent = memo.text;
      contentButton.title = "このメモの再生位置へ移動";
      contentButton.addEventListener("click", () => seekToMemo(memo));
      card.appendChild(contentButton);

      const actions = createMemoActions();
      actions.append(
        createActionButton("位置へ移動", "jump", () => seekToMemo(memo)),
        createActionButton("編集", "edit", () => beginMemoEdit(memo.id)),
        createActionButton("削除", "delete", () => deleteMemo(memo.id)),
      );
      card.appendChild(actions);
    }

    return card;
  }

  function createMemoEditArea(memo) {
    const wrapper = document.createElement("div");
    const textarea = document.createElement("textarea");
    textarea.className = "memo-edit-textarea";
    textarea.value = memo.text;
    textarea.setAttribute("aria-label", "メモ本文を編集");

    const actions = createMemoActions();
    actions.append(
      createActionButton("変更を保存", "commit", () => commitMemoEdit(memo.id, textarea.value)),
      createActionButton("キャンセル", "cancel", cancelMemoEdit),
    );

    wrapper.append(textarea, actions);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return wrapper;
  }

  function createMemoActions() {
    const actions = document.createElement("div");
    actions.className = "memo-actions";
    return actions;
  }

  function createActionButton(label, variant, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `memo-action-button ${variant}`;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function createEmptyState(title, description) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    const titleElement = document.createElement("strong");
    const descriptionElement = document.createElement("span");
    titleElement.textContent = title;
    descriptionElement.textContent = description;
    emptyState.append(titleElement, descriptionElement);
    return emptyState;
  }

  function beginMemoEdit(memoId) {
    state.editingMemoId = memoId;
    renderMemoList();
  }

  function cancelMemoEdit() {
    state.editingMemoId = "";
    renderMemoList();
    showToast("メモの編集をキャンセルしました。", "warning");
  }

  async function commitMemoEdit(memoId, newText) {
    const normalizedText = newText.trim();
    if (!normalizedText) {
      showToast("メモ本文を空にはできません。", "error");
      return;
    }
    if (state.sharedMode && !ensureSharedEditing()) {
      return;
    }

    const currentMemos = getCurrentVideoMemos();
    const targetExists = currentMemos.some((memo) => memo.id === memoId);
    if (!targetExists) {
      showToast("編集対象のメモが見つかりません。", "error");
      state.editingMemoId = "";
      renderMemoList();
      return;
    }

    try {
      let updatedMemo = currentMemos.find((memo) => memo.id === memoId);
      if (state.sharedMode) {
        const result = await requestSharedApi(`/api/notes/${encodeURIComponent(memoId)}`, {
          method: "PUT",
          body: { text: normalizedText },
        });
        updatedMemo = result.note;
      } else {
        updatedMemo = { ...updatedMemo, text: normalizedText };
      }

      const nextMemos = currentMemos.map((memo) => (memo.id === memoId ? updatedMemo : memo));
      if (!state.sharedMode && !commitCurrentVideoMemos(nextMemos)) {
        return;
      }
      if (state.sharedMode) {
        state.data.videos[state.activeVideoId] = nextMemos;
      }

      state.editingMemoId = "";
      renderMemoList();
      showToast("メモを更新しました。再生位置は変更していません。", "success");
    } catch (error) {
      console.error("Memo update failed:", error);
      if (!error.handled) {
        showToast("メモを更新できませんでした。", "error");
      }
    }
  }

  async function deleteMemo(memoId) {
    const currentMemos = getCurrentVideoMemos();
    const nextMemos = currentMemos.filter((memo) => memo.id !== memoId);
    if (nextMemos.length === currentMemos.length) {
      showToast("削除対象のメモが見つかりません。", "error");
      return;
    }
    if (state.sharedMode && !ensureSharedEditing()) {
      return;
    }

    try {
      if (state.sharedMode) {
        await requestSharedApi(`/api/notes/${encodeURIComponent(memoId)}`, {
          method: "DELETE",
        });
        state.data.videos[state.activeVideoId] = nextMemos;
      } else if (!commitCurrentVideoMemos(nextMemos)) {
        return;
      }

      if (state.editingMemoId === memoId) {
        state.editingMemoId = "";
      }
      renderMemoList();
      updateDataActionButtons();
      showToast("メモを削除しました。", "success");
    } catch (error) {
      console.error("Memo delete failed:", error);
      if (!error.handled) {
        showToast("メモを削除できませんでした。", "error");
      }
    }
  }

  async function deleteAllCurrentVideoMemos() {
    const currentMemos = getCurrentVideoMemos();
    if (!state.activeVideoId || currentMemos.length === 0) {
      showToast("削除できるメモがありません。", "error");
      return;
    }

    const confirmed = window.confirm(
      `動画 ${state.activeVideoId} のメモ ${currentMemos.length}件をすべて削除します。\nこの操作は元に戻せません。`,
    );
    if (!confirmed) {
      return;
    }
    if (state.sharedMode && !ensureSharedEditing()) {
      return;
    }

    try {
      if (state.sharedMode) {
        await requestSharedApi(`/api/notes?videoId=${encodeURIComponent(state.activeVideoId)}`, {
          method: "DELETE",
        });
        delete state.data.videos[state.activeVideoId];
      } else if (!commitCurrentVideoMemos([])) {
        return;
      }

      state.editingMemoId = "";
      renderMemoList();
      updateDataActionButtons();
      showToast("この動画のメモをすべて削除しました。", "success");
    } catch (error) {
      console.error("All memo delete failed:", error);
      if (!error.handled) {
        showToast("メモを全件削除できませんでした。", "error");
      }
    }
  }

  function exportCurrentVideoCsv() {
    const memos = sortMemos(getCurrentVideoMemos());
    if (!state.activeVideoId || memos.length === 0) {
      showToast("CSVに出力できるメモがありません。", "error");
      return;
    }

    try {
      const rows = [
        ["動画ID", "メモ本文", "再生時間（秒）", "表示用再生時間", "保存日時"],
        ...memos.map((memo) => [
          memo.videoId,
          memo.text,
          String(memo.time),
          formatPlaybackTime(memo.time),
          memo.savedAt,
        ]),
      ];
      const csvContent = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
      const blob = new Blob([`\uFEFF${csvContent}`], { type: "text/csv;charset=utf-8" });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      link.href = downloadUrl;
      link.download = `youtube-memos_${state.activeVideoId}_${timestamp}.csv`;
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      showToast(`${memos.length}件のメモをCSVに出力しました。`, "success");
    } catch (error) {
      console.error("CSV export failed:", error);
      showToast("CSV出力に失敗しました。", "error");
    }
  }

  function escapeCsvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  function sortMemos(memos) {
    const sortType = elements.memoSort.value;
    return [...memos].sort((first, second) => {
      if (sortType === "time-desc") {
        return second.time - first.time;
      }
      if (sortType === "date-desc") {
        return Date.parse(second.savedAt) - Date.parse(first.savedAt);
      }
      if (sortType === "date-asc") {
        return Date.parse(first.savedAt) - Date.parse(second.savedAt);
      }
      return first.time - second.time;
    });
  }

  function ensureSharedEditing() {
    if (state.editUnlocked && state.editPassphrase) {
      return true;
    }
    showToast("編集用の合言葉を入力して、編集を有効にしてください。", "error");
    elements.editPassphrase.focus();
    return false;
  }

  async function loadSharedMemos(videoId) {
    if (!state.sharedMode || !VIDEO_ID_PATTERN.test(videoId)) {
      return;
    }

    try {
      const result = await requestSharedApi(`/api/notes?videoId=${encodeURIComponent(videoId)}`);
      const validMemos = Array.isArray(result.notes)
        ? result.notes.filter((memo) => isValidMemo(memo, videoId))
        : [];
      if (validMemos.length > 0) {
        state.data.videos[videoId] = validMemos;
      } else {
        delete state.data.videos[videoId];
      }
      if (state.activeVideoId === videoId) {
        renderMemoList();
        updateDataActionButtons();
      }
    } catch (error) {
      console.error("Shared memo load failed:", error);
      if (!error.handled) {
        showToast("共有メモを読み込めませんでした。通信状態を確認してください。", "error");
      }
    }
  }

  async function requestSharedApi(path, options = {}) {
    const headers = { Accept: "application/json" };
    const requestOptions = {
      method: options.method || "GET",
      headers,
      cache: "no-store",
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestOptions.body = JSON.stringify(options.body);
    }
    if (requestOptions.method !== "GET") {
      headers["X-Edit-Passphrase"] = state.editPassphrase;
    }

    let response;
    try {
      response = await fetch(path, requestOptions);
    } catch (error) {
      throw error;
    }

    let result = {};
    try {
      result = await response.json();
    } catch {
      result = {};
    }

    if (response.status === 401) {
      state.editUnlocked = false;
      state.editPassphrase = "";
      clearSessionPassphrase();
      updateSharingStatus(false);
      showToast("編集権限がありません。合言葉をもう一度入力してください。", "error");
      const authError = new Error("AUTH_REQUIRED");
      authError.handled = true;
      throw authError;
    }
    if (!response.ok) {
      showToast(result.error || "共有データの処理に失敗しました。", "error");
      const requestError = new Error(`SHARED_REQUEST_FAILED_${response.status}`);
      requestError.handled = true;
      throw requestError;
    }

    return result;
  }

  function createEmptyData() {
    return {
      version: STORAGE_VERSION,
      videos: Object.create(null),
    };
  }

  function loadStoredData() {
    try {
      const serializedData = localStorage.getItem(STORAGE_KEY);
      if (!serializedData) {
        return createEmptyData();
      }

      const parsedData = JSON.parse(serializedData);
      if (
        !isPlainObject(parsedData) ||
        parsedData.version !== STORAGE_VERSION ||
        !isPlainObject(parsedData.videos)
      ) {
        showToast("保存データの形式が不正なため、安全に無視しました。", "warning");
        return createEmptyData();
      }

      const validData = createEmptyData();
      Object.entries(parsedData.videos).forEach(([videoId, memos]) => {
        if (!VIDEO_ID_PATTERN.test(videoId) || !Array.isArray(memos)) {
          return;
        }
        const validMemos = memos.filter((memo) => isValidMemo(memo, videoId)).map((memo) => ({
          id: memo.id,
          videoId: memo.videoId,
          text: memo.text,
          time: memo.time,
          savedAt: memo.savedAt,
        }));
        if (validMemos.length > 0) {
          validData.videos[videoId] = validMemos;
        }
      });
      return validData;
    } catch (error) {
      console.error("localStorage read failed:", error);
      showToast("localStorageから保存データを読み込めませんでした。", "error");
      return createEmptyData();
    }
  }

  function commitCurrentVideoMemos(nextMemos) {
    if (!state.activeVideoId || !Array.isArray(nextMemos)) {
      showToast("保存先の動画を特定できません。", "error");
      return false;
    }

    const previousMemos = state.data.videos[state.activeVideoId];
    if (nextMemos.length > 0) {
      state.data.videos[state.activeVideoId] = nextMemos;
    } else {
      delete state.data.videos[state.activeVideoId];
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
      return true;
    } catch (error) {
      console.error("localStorage write failed:", error);
      if (previousMemos) {
        state.data.videos[state.activeVideoId] = previousMemos;
      } else {
        delete state.data.videos[state.activeVideoId];
      }
      showToast("localStorageへの保存に失敗しました。空き容量や設定を確認してください。", "error");
      return false;
    }
  }

  function getCurrentVideoMemos() {
    if (!state.activeVideoId) {
      return [];
    }
    const memos = state.data.videos[state.activeVideoId];
    return Array.isArray(memos) ? memos : [];
  }

  function isValidMemo(memo, expectedVideoId) {
    return (
      isPlainObject(memo) &&
      typeof memo.id === "string" &&
      memo.id.length > 0 &&
      memo.id.length <= 200 &&
      memo.videoId === expectedVideoId &&
      typeof memo.text === "string" &&
      memo.text.trim().length > 0 &&
      Number.isFinite(memo.time) &&
      memo.time >= 0 &&
      typeof memo.savedAt === "string" &&
      Number.isFinite(Date.parse(memo.savedAt))
    );
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function createUniqueId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    const randomPart = Math.random().toString(36).slice(2);
    const timePart = Date.now().toString(36);
    const performancePart =
      window.performance && Number.isFinite(window.performance.now())
        ? Math.floor(window.performance.now() * 1000).toString(36)
        : "0";
    return `memo-${timePart}-${performancePart}-${randomPart}`;
  }

  function formatPlaybackTime(seconds) {
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : 0;
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainingSeconds = safeSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function formatSavedDate(isoDate) {
    const date = new Date(isoDate);
    if (!Number.isFinite(date.getTime())) {
      return "日時不明";
    }
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function updateMemoCharacterCount() {
    elements.memoCharacterCount.textContent = `${elements.memoText.value.length}文字`;
  }

  function updateDataActionButtons() {
    const hasMemos = getCurrentVideoMemos().length > 0;
    elements.exportCsvButton.disabled = !hasMemos;
    elements.deleteAllButton.disabled = !hasMemos;
  }

  function setPlayerStatus(title, detail, statusType) {
    elements.playerStatusTitle.textContent = title;
    elements.playerStatusDetail.textContent = detail;
    elements.playerStatus.classList.remove("is-ready", "is-playing", "is-error");
    if (statusType) {
      elements.playerStatus.classList.add(`is-${statusType}`);
    }
  }

  function handleKeyboardShortcuts(event) {
    if (event.ctrlKey && !event.altKey && event.key === "Enter") {
      event.preventDefault();
      saveMemoAtCurrentPosition();
      return;
    }

    if (isTextEntryTarget(event.target)) {
      return;
    }

    if (event.altKey && event.code === "KeyL") {
      event.preventDefault();
      seekToLiveEdge();
    } else if (
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !isActionTarget(event.target)
    ) {
      event.preventDefault();
      togglePlayback();
    } else if (
      event.key === "ArrowLeft" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      movePlaybackBy(-5);
    } else if (
      event.key === "ArrowRight" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      movePlaybackBy(5);
    }
  }

  function isTextEntryTarget(target) {
    return Boolean(
      target &&
        target.closest &&
        target.closest('input, textarea, select, [contenteditable="true"]'),
    );
  }

  function isActionTarget(target) {
    return Boolean(target && target.closest && target.closest("button, a"));
  }

  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.setAttribute("role", type === "error" ? "alert" : "status");

    const messageElement = document.createElement("div");
    messageElement.className = "toast-message";
    messageElement.textContent = message;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "toast-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "通知を閉じる");

    toast.append(messageElement, closeButton);
    elements.toastRegion.appendChild(toast);

    const removeToast = () => {
      if (!toast.isConnected || toast.classList.contains("is-leaving")) {
        return;
      }
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 200);
    };

    closeButton.addEventListener("click", removeToast);
    window.setTimeout(removeToast, TOAST_DURATION_MS);
  }
})();
