(() => {
  "use strict";

  const STORAGE_KEY = "youtubeLiveMemoApp.v1";
  const STORAGE_VERSION = 1;
  const ROTATION_STORAGE_KEY = "youtubeLiveRotationTracker.v1";
  const ROTATION_STORAGE_VERSION = 1;
  const ROTATION_TEAMS = ["home", "away"];
  const ROTATION_POSITIONS = [1, 2, 3, 4, 5, 6];
  const ROTATION_INPUT_MAX_LENGTH = 2;
  const ROTATION_MATCH_STORAGE_KEY = "youtubeLiveRotationMatchLinks.v1";
  const MATCH_ID_PATTERN = /^[A-Z0-9]{4,12}$/;
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const API_LOAD_TIMEOUT_MS = 15000;
  const SEEK_VERIFY_DELAY_MS = 1100;
  const SEEK_TOLERANCE_SECONDS = 3.5;
  const SEEK_MAX_ATTEMPTS = 2;
  const LIVE_EDGE_RETRY_DELAY_MS = 400;
  const LIVE_EDGE_MAX_ATTEMPTS = 5;
  const TOAST_DURATION_MS = 4200;
  const SHARED_API_BASE =
    window.location.hostname.endsWith(".pages.dev")
      ? "https://youtube-live-memo-jp.junmari10221122.chatgpt.site"
      : "";
  const SYNC_API_BASE = window.location.hostname.endsWith(".chatgpt.site")
    ? ""
    : "https://youtube-live-memo-jp.junmari10221122.chatgpt.site";

  const state = {
    player: null,
    apiReady: false,
    playerReady: false,
    activeVideoId: "",
    pendingVideoId: "",
    loadedVideoId: "",
    editingMemoId: "",
    apiTimeoutId: null,
    seekRequestId: 0,
    sharedMode: false,
    data: createEmptyData(),
    rotationData: createEmptyRotationData(),
    rotationMatchLinks: Object.create(null),
    syncMatchId: "",
    syncRevision: 0,
    syncPollTimer: null,
    syncPushTimer: null,
    syncApplying: false,
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", initializeApp);

  function initializeApp() {
    cacheElements();
    arrangeWorkspacePanels();
    bindEvents();
    state.data = loadStoredData();
    state.rotationData = loadRotationData();
    state.rotationMatchLinks = loadRotationMatchLinks();
    renderMemoList();
    renderRotationBoard();
    updateMemoCharacterCount();
    loadYouTubeApi();
    detectSharedMode();
  }

  function cacheElements() {
    elements.videoInput = document.getElementById("video-input");
    elements.loadVideoButton = document.getElementById("load-video-button");
    elements.loadBlock = document.querySelector(".load-block");
    elements.videoInputLabel = document.getElementById("video-input-label");
    elements.videoInputContent = document.getElementById("video-input-content");
    elements.videoInputToggleButton = document.getElementById("video-input-toggle-button");
    elements.memoText = document.getElementById("memo-text");
    elements.memoCharacterCount = document.getElementById("memo-character-count");
    elements.saveOffset = document.getElementById("save-offset");
    elements.saveMemoButton = document.getElementById("save-memo-button");
    elements.memoSearch = document.getElementById("memo-search");
    elements.memoSort = document.getElementById("memo-sort");
    elements.memoList = document.getElementById("memo-list");
    elements.rewindButton = document.getElementById("rewind-button");
    elements.forwardButton = document.getElementById("forward-button");
    elements.liveEdgeButton = document.getElementById("live-edge-button");
    elements.playerStatus = document.getElementById("player-status");
    elements.playerStatusTitle = document.getElementById("player-status-title");
    elements.playerStatusDetail = document.getElementById("player-status-detail");
    elements.activeVideoLabel = document.getElementById("active-video-label");
    elements.playerColumn = document.querySelector(".player-column");
    elements.controlColumn = document.querySelector(".control-column");
    elements.memoCompose = document.querySelector(".memo-compose");
    elements.notesBlock = document.querySelector(".notes-block");
    elements.desktopLayoutQuery = window.matchMedia("(min-width: 1121px)");
    elements.rotationPanel = document.getElementById("rotation-panel");
    elements.rotationContent = document.getElementById("rotation-content");
    elements.rotationVideoHint = document.getElementById("rotation-video-hint");
    elements.rotationToggleButton = document.getElementById("rotation-toggle-button");
    elements.rotationResetButton = document.getElementById("rotation-reset-button");
    elements.rotationMatchId = document.getElementById("rotation-match-id");
    elements.rotationSyncButton = document.getElementById("rotation-sync-button");
    elements.rotationSyncStatus = document.getElementById("rotation-sync-status");
    elements.scoreboardLink = document.getElementById("scoreboard-link");
    elements.homeRotationLabel = document.getElementById("home-rotation-label");
    elements.awayRotationLabel = document.getElementById("away-rotation-label");
    elements.rotationInputs = Array.from(
      document.querySelectorAll(".rotation-slot input[data-team][data-position]"),
    );
    elements.setterButtons = Array.from(
      document.querySelectorAll(".setter-button[data-team][data-position]"),
    );
    elements.rotationControlButtons = Array.from(
      document.querySelectorAll(".rotation-controls button[data-team][data-direction]"),
    );
    elements.toastRegion = document.getElementById("toast-region");
  }

  function bindEvents() {
    elements.loadVideoButton.addEventListener("click", handleVideoLoadRequest);
    elements.videoInputToggleButton.addEventListener("click", toggleVideoInput);
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
    elements.rewindButton.addEventListener("click", () => movePlaybackBy(-5));
    elements.forwardButton.addEventListener("click", () => movePlaybackBy(5));
    elements.liveEdgeButton.addEventListener("click", seekToLiveEdge);
    elements.rotationInputs.forEach((input) => {
      input.addEventListener("input", handleRotationInput);
    });
    elements.setterButtons.forEach((button) => {
      button.addEventListener("click", handleSetterSelection);
    });
    elements.rotationControlButtons.forEach((button) => {
      button.addEventListener("click", handleRotationControl);
    });
    elements.rotationToggleButton.addEventListener("click", toggleRotationPanel);
    elements.rotationResetButton.addEventListener("click", resetCurrentRotation);
    elements.rotationMatchId.addEventListener("input", () => {
      elements.rotationMatchId.value = elements.rotationMatchId.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    });
    elements.rotationMatchId.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        toggleRotationSync();
      }
    });
    elements.rotationSyncButton.addEventListener("click", toggleRotationSync);
    if (typeof elements.desktopLayoutQuery.addEventListener === "function") {
      elements.desktopLayoutQuery.addEventListener("change", arrangeWorkspacePanels);
    } else {
      elements.desktopLayoutQuery.addListener(arrangeWorkspacePanels);
    }
    document.addEventListener("keydown", handleKeyboardShortcuts);
  }

  function arrangeWorkspacePanels() {
    if (elements.desktopLayoutQuery.matches) {
      elements.playerStatus.before(elements.notesBlock);
      elements.controlColumn.append(elements.rotationPanel);
      return;
    }

    elements.memoCompose.after(elements.rotationPanel);
    elements.controlColumn.append(elements.notesBlock);
  }

  async function detectSharedMode() {
    try {
      const response = await fetch(`${SHARED_API_BASE}/api/health`, {
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
      renderMemoList();

      if (state.activeVideoId) {
        await loadSharedMemos(state.activeVideoId);
      }
    } catch (error) {
      console.info("Shared API is not available; using local storage.", error);
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

    state.seekRequestId += 1;
    state.activeVideoId = videoId;
    state.pendingVideoId = videoId;
    state.editingMemoId = "";
    elements.activeVideoLabel.textContent = `VIDEO ${videoId}`;
    setVideoInputCollapsed(true);
    renderMemoList();
    renderRotationBoard();
    restoreRotationSyncForVideo();
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
      setVideoInputCollapsed(false);
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
      setPlayerStatus("再生が終了しました", "Alt + Lで終端付近へ移動できます", "ready");
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
    setVideoInputCollapsed(false);
    setPlayerStatus("動画を再生できません", message, "error");
    showToast(message, "error");
  }

  function toggleVideoInput() {
    const isCollapsed = elements.loadBlock.classList.contains("is-collapsed");
    setVideoInputCollapsed(!isCollapsed);
    if (isCollapsed) {
      window.requestAnimationFrame(() => elements.videoInput.focus());
    }
  }

  function setVideoInputCollapsed(shouldCollapse) {
    const canCollapse = Boolean(state.activeVideoId);
    const isCollapsed = shouldCollapse && canCollapse;

    elements.loadBlock.classList.toggle("is-collapsed", isCollapsed);
    elements.videoInputContent.hidden = isCollapsed;
    elements.videoInputToggleButton.hidden = !canCollapse;
    elements.videoInputToggleButton.setAttribute("aria-expanded", String(!isCollapsed));
    elements.videoInputToggleButton.textContent = isCollapsed ? "動画を変更" : "閉じる";
    elements.videoInputLabel.textContent = isCollapsed
      ? `VIDEO ${state.activeVideoId}`
      : "YouTube URL / 動画ID";
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
      seekWithRetry(memo.time, {
        playAfterSeek: true,
        failureMessage:
          "指定位置へ移動できなかった可能性があります。ライブのDVR範囲を確認してください。",
      });
      showToast(`${formatPlaybackTime(memo.time)} へ移動しました。`, "success");
    } catch (error) {
      console.error("Seek failed:", error);
      showToast("指定位置へ移動できません。DVRが有効か確認してください。", "error");
    }
  }

  function seekWithRetry(targetTime, options = {}) {
    const requestId = options.requestId ?? ++state.seekRequestId;
    const tolerance = options.tolerance ?? SEEK_TOLERANCE_SECONDS;
    const failureMessage =
      options.failureMessage || "再生位置を移動できなかった可能性があります。";

    issueSeek(targetTime, options.playAfterSeek === true);
    verifySeekPosition(targetTime, requestId, 1, {
      failureMessage,
      playAfterSeek: options.playAfterSeek === true,
      tolerance,
    });
  }

  function issueSeek(targetTime, playAfterSeek) {
    state.player.seekTo(targetTime, true);
    if (playAfterSeek) {
      state.player.playVideo();
    }
  }

  function verifySeekPosition(targetTime, requestId, attempt, options) {
    window.setTimeout(() => {
      if (requestId !== state.seekRequestId || !state.playerReady || !state.player) {
        return;
      }

      try {
        const actualTime = Number(state.player.getCurrentTime());
        const reachedTarget =
          Number.isFinite(actualTime) &&
          Math.abs(actualTime - targetTime) <= options.tolerance;
        if (reachedTarget) {
          return;
        }

        if (attempt < SEEK_MAX_ATTEMPTS) {
          issueSeek(targetTime, options.playAfterSeek);
          verifySeekPosition(targetTime, requestId, attempt + 1, options);
          return;
        }

        showToast(options.failureMessage, "warning");
      } catch (error) {
        console.warn("Seek verification failed:", error);
        if (attempt < SEEK_MAX_ATTEMPTS) {
          try {
            issueSeek(targetTime, options.playAfterSeek);
            verifySeekPosition(targetTime, requestId, attempt + 1, options);
          } catch (retryError) {
            console.warn("Seek retry failed:", retryError);
            showToast(options.failureMessage, "warning");
          }
        } else {
          showToast(options.failureMessage, "warning");
        }
      }
    }, SEEK_VERIFY_DELAY_MS);
  }

  function movePlaybackBy(seconds) {
    if (!canUsePlayer()) {
      return;
    }

    const requestId = ++state.seekRequestId;
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

      if (seconds > 0 && targetTime - currentTime < 0.5) {
        showToast("すでに取得可能な最新地点付近です。", "info");
        return;
      }

      seekWithRetry(targetTime, {
        requestId,
        failureMessage: "再生位置を移動できませんでした。DVR範囲を確認してください。",
      });
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

    const requestId = ++state.seekRequestId;
    trySeekToLiveEdge(requestId, 1);
  }

  function trySeekToLiveEdge(requestId, attempt) {
    if (requestId !== state.seekRequestId || !state.playerReady || !state.player) {
      return;
    }

    try {
      const duration = Number(state.player.getDuration());
      if (!Number.isFinite(duration) || duration <= 0) {
        if (attempt < LIVE_EDGE_MAX_ATTEMPTS) {
          window.setTimeout(
            () => trySeekToLiveEdge(requestId, attempt + 1),
            LIVE_EDGE_RETRY_DELAY_MS,
          );
          return;
        }
        showToast("ライブの最新地点を取得できません。DVR設定を確認してください。", "error");
        return;
      }

      const targetTime = Math.max(0, duration - 0.5);
      seekWithRetry(targetTime, {
        requestId,
        playAfterSeek: true,
        tolerance: 5,
        failureMessage:
          "ライブ地点へ移動できなかった可能性があります。DVR設定を確認してください。",
      });
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

    state.seekRequestId += 1;
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

  function createEmptyRotationData() {
    return {
      version: ROTATION_STORAGE_VERSION,
      videos: Object.create(null),
    };
  }

  function createEmptyTeamRotation() {
    const players = Object.create(null);
    ROTATION_POSITIONS.forEach((position) => {
      players[position] = "";
    });
    return {
      rotation: 1,
      players,
      setterPosition: null,
    };
  }

  function createEmptyVideoRotation() {
    return {
      home: createEmptyTeamRotation(),
      away: createEmptyTeamRotation(),
    };
  }

  function loadRotationData() {
    try {
      const serializedData = localStorage.getItem(ROTATION_STORAGE_KEY);
      if (!serializedData) {
        return createEmptyRotationData();
      }

      const parsedData = JSON.parse(serializedData);
      if (
        !isPlainObject(parsedData) ||
        parsedData.version !== ROTATION_STORAGE_VERSION ||
        !isPlainObject(parsedData.videos)
      ) {
        showToast("ローテーション保存データの形式が不正なため、無視しました。", "warning");
        return createEmptyRotationData();
      }

      const validData = createEmptyRotationData();
      Object.entries(parsedData.videos).forEach(([videoId, videoRotation]) => {
        if (!VIDEO_ID_PATTERN.test(videoId) || !isPlainObject(videoRotation)) {
          return;
        }

        const sanitizedVideoRotation = createEmptyVideoRotation();
        let hasValidTeam = false;
        ROTATION_TEAMS.forEach((team) => {
          const sanitizedTeam = sanitizeTeamRotation(videoRotation[team]);
          if (sanitizedTeam) {
            sanitizedVideoRotation[team] = sanitizedTeam;
            hasValidTeam = true;
          }
        });
        if (hasValidTeam) {
          validData.videos[videoId] = sanitizedVideoRotation;
        }
      });
      return validData;
    } catch (error) {
      console.error("Rotation localStorage read failed:", error);
      showToast("ローテーションの保存データを読み込めませんでした。", "error");
      return createEmptyRotationData();
    }
  }

  function sanitizeTeamRotation(teamRotation) {
    if (
      !isPlainObject(teamRotation) ||
      !Number.isInteger(teamRotation.rotation) ||
      teamRotation.rotation < 1 ||
      teamRotation.rotation > 6 ||
      !isPlainObject(teamRotation.players)
    ) {
      return null;
    }

    const sanitizedTeam = createEmptyTeamRotation();
    sanitizedTeam.rotation = teamRotation.rotation;
    ROTATION_POSITIONS.forEach((position) => {
      const playerNumber = teamRotation.players[position];
      if (typeof playerNumber === "string") {
        sanitizedTeam.players[position] = sanitizePlayerNumber(playerNumber);
      }
    });
    if (ROTATION_POSITIONS.includes(teamRotation.setterPosition)) {
      sanitizedTeam.setterPosition = teamRotation.setterPosition;
    }
    return sanitizedTeam;
  }

  function sanitizePlayerNumber(value) {
    return String(value).replace(/\D/g, "").slice(0, ROTATION_INPUT_MAX_LENGTH);
  }

  function getCurrentVideoRotation(createIfMissing = false) {
    if (!state.activeVideoId || !VIDEO_ID_PATTERN.test(state.activeVideoId)) {
      return null;
    }

    let videoRotation = state.rotationData.videos[state.activeVideoId];
    if (!videoRotation && createIfMissing) {
      videoRotation = createEmptyVideoRotation();
      state.rotationData.videos[state.activeVideoId] = videoRotation;
    }
    return videoRotation || null;
  }

  function persistRotationData() {
    try {
      localStorage.setItem(ROTATION_STORAGE_KEY, JSON.stringify(state.rotationData));
      return true;
    } catch (error) {
      console.error("Rotation localStorage write failed:", error);
      showToast("ローテーションを保存できませんでした。", "error");
      return false;
    }
  }

  function renderRotationBoard() {
    const hasVideo = Boolean(
      state.activeVideoId && VIDEO_ID_PATTERN.test(state.activeVideoId),
    );
    const videoRotation = hasVideo ? getCurrentVideoRotation(false) : null;
    const displayRotation = videoRotation || createEmptyVideoRotation();

    elements.rotationPanel.classList.toggle("is-disabled", !hasVideo);
    elements.rotationVideoHint.classList.toggle("is-warning", !hasVideo);
    elements.rotationVideoHint.textContent = hasVideo
      ? state.syncMatchId
        ? `試合 ${state.syncMatchId} と共有`
        : `VIDEO ${state.activeVideoId} に端末保存`
      : "動画を読み込むと保存されます";
    elements.homeRotationLabel.textContent = `R${displayRotation.home.rotation}`;
    elements.awayRotationLabel.textContent = `R${displayRotation.away.rotation}`;

    elements.rotationInputs.forEach((input) => {
      const team = input.dataset.team;
      const position = Number(input.dataset.position);
      input.disabled = !hasVideo;
      input.value =
        ROTATION_TEAMS.includes(team) && ROTATION_POSITIONS.includes(position)
          ? displayRotation[team].players[position]
          : "";
    });
    elements.rotationControlButtons.forEach((button) => {
      button.disabled = !hasVideo;
    });
    elements.setterButtons.forEach((button) => {
      const team = button.dataset.team;
      const position = Number(button.dataset.position);
      const isSetter =
        ROTATION_TEAMS.includes(team) &&
        ROTATION_POSITIONS.includes(position) &&
        displayRotation[team].setterPosition === position;
      const teamLabel = team === "home" ? "自チーム" : "相手チーム";

      button.disabled = !hasVideo;
      button.setAttribute("aria-pressed", String(isSetter));
      button.setAttribute(
        "aria-label",
        `${teamLabel} P${position}のセッター指定を${isSetter ? "解除" : "設定"}`,
      );
      button.closest(".rotation-slot")?.classList.toggle("is-setter", isSetter);
    });
    elements.rotationResetButton.disabled = !videoRotation;
  }

  function handleRotationInput(event) {
    const input = event.currentTarget;
    const team = input.dataset.team;
    const position = Number(input.dataset.position);
    if (
      !ROTATION_TEAMS.includes(team) ||
      !ROTATION_POSITIONS.includes(position) ||
      !state.activeVideoId
    ) {
      return;
    }

    const videoRotation = getCurrentVideoRotation(true);
    const playerNumber = sanitizePlayerNumber(input.value);
    input.value = playerNumber;
    videoRotation[team].players[position] = playerNumber;
    elements.rotationResetButton.disabled = false;
    persistRotationData();
    queueRotationSync();
  }

  function handleSetterSelection(event) {
    const button = event.currentTarget;
    const team = button.dataset.team;
    const position = Number(button.dataset.position);
    if (
      !ROTATION_TEAMS.includes(team) ||
      !ROTATION_POSITIONS.includes(position) ||
      !state.activeVideoId
    ) {
      return;
    }

    const videoRotation = getCurrentVideoRotation(true);
    videoRotation[team].setterPosition =
      videoRotation[team].setterPosition === position ? null : position;
    elements.rotationResetButton.disabled = false;
    persistRotationData();
    renderRotationBoard();
    queueRotationSync();
  }

  function handleRotationControl(event) {
    const button = event.currentTarget;
    const team = button.dataset.team;
    const direction = button.dataset.direction;
    if (
      !ROTATION_TEAMS.includes(team) ||
      !["next", "previous"].includes(direction) ||
      !state.activeVideoId
    ) {
      return;
    }

    const videoRotation = getCurrentVideoRotation(true);
    const teamRotation = videoRotation[team];
    const previousPlayers = { ...teamRotation.players };
    const previousSetterPosition = teamRotation.setterPosition;
    ROTATION_POSITIONS.forEach((position) => {
      const sourcePosition =
        direction === "next"
          ? position === 6
            ? 1
            : position + 1
          : position === 1
            ? 6
            : position - 1;
      teamRotation.players[position] = previousPlayers[sourcePosition] || "";
    });
    teamRotation.rotation =
      direction === "next"
        ? (teamRotation.rotation % 6) + 1
        : ((teamRotation.rotation + 4) % 6) + 1;
    if (ROTATION_POSITIONS.includes(previousSetterPosition)) {
      teamRotation.setterPosition =
        direction === "next"
          ? previousSetterPosition === 1
            ? 6
            : previousSetterPosition - 1
          : previousSetterPosition === 6
            ? 1
            : previousSetterPosition + 1;
    }

    persistRotationData();
    renderRotationBoard();
    queueRotationSync();
  }

  function resetCurrentRotation() {
    if (!state.activeVideoId || !getCurrentVideoRotation(false)) {
      return;
    }
    const confirmed = window.confirm(
      "この動画の自チーム・相手チームのローテーションを初期化しますか？",
    );
    if (!confirmed) {
      return;
    }

    delete state.rotationData.videos[state.activeVideoId];
    if (persistRotationData()) {
      renderRotationBoard();
      queueRotationSync();
      showToast("ローテーションを初期化しました。", "success");
    }
  }

  function loadRotationMatchLinks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ROTATION_MATCH_STORAGE_KEY) || "{}");
      if (!isPlainObject(parsed)) {
        return Object.create(null);
      }
      const links = Object.create(null);
      Object.entries(parsed).forEach(([videoId, matchId]) => {
        if (VIDEO_ID_PATTERN.test(videoId) && MATCH_ID_PATTERN.test(matchId)) {
          links[videoId] = matchId;
        }
      });
      return links;
    } catch {
      return Object.create(null);
    }
  }

  function persistRotationMatchLinks() {
    try {
      localStorage.setItem(ROTATION_MATCH_STORAGE_KEY, JSON.stringify(state.rotationMatchLinks));
    } catch (error) {
      console.error("Rotation match link save failed:", error);
      showToast("試合IDの保存に失敗しました。", "error");
    }
  }

  function restoreRotationSyncForVideo() {
    stopRotationSync();
    const matchId = state.rotationMatchLinks[state.activeVideoId] || "";
    elements.rotationMatchId.value = matchId;
    updateRotationSyncUi();
    if (matchId) {
      connectRotationSync(matchId, true);
    }
  }

  function toggleRotationSync() {
    if (state.syncMatchId) {
      delete state.rotationMatchLinks[state.activeVideoId];
      persistRotationMatchLinks();
      stopRotationSync();
      elements.rotationMatchId.value = "";
      updateRotationSyncUi();
      renderRotationBoard();
      showToast("得点サイトとの同期を解除しました。", "success");
      return;
    }
    connectRotationSync(elements.rotationMatchId.value.trim().toUpperCase(), false);
  }

  async function connectRotationSync(matchId, silent) {
    if (!state.activeVideoId) {
      if (!silent) showToast("先にYouTube動画を読み込んでください。", "error");
      return;
    }
    if (!MATCH_ID_PATTERN.test(matchId)) {
      if (!silent) showToast("試合IDは4〜12文字の英数字で入力してください。", "error");
      return;
    }
    elements.rotationSyncButton.disabled = true;
    try {
      const result = await requestSyncApi(`/api/matches/${encodeURIComponent(matchId)}`);
      state.syncMatchId = matchId;
      state.rotationMatchLinks[state.activeVideoId] = matchId;
      persistRotationMatchLinks();
      const localRotation = getCurrentVideoRotation(false);
      if (hasRotationContent(localRotation) && !hasRotationContent(result.match)) {
        await pushRotationSync();
      } else {
        applySyncedRotation(result.match);
      }
      startRotationPolling();
      updateRotationSyncUi();
      if (!silent) showToast(`試合 ${matchId} と同期しました。`, "success");
    } catch (error) {
      if (!silent) showToast(error.message, "error");
      updateRotationSyncUi("接続できません");
    } finally {
      elements.rotationSyncButton.disabled = false;
    }
  }

  function stopRotationSync() {
    window.clearInterval(state.syncPollTimer);
    window.clearTimeout(state.syncPushTimer);
    state.syncPollTimer = null;
    state.syncPushTimer = null;
    state.syncMatchId = "";
    state.syncRevision = 0;
  }

  function startRotationPolling() {
    window.clearInterval(state.syncPollTimer);
    state.syncPollTimer = window.setInterval(pollRotationSync, 1500);
  }

  async function pollRotationSync() {
    if (!state.syncMatchId || state.syncApplying) return;
    try {
      const result = await requestSyncApi(`/api/matches/${encodeURIComponent(state.syncMatchId)}`);
      if (result.match.revision !== state.syncRevision) {
        applySyncedRotation(result.match);
      }
      updateRotationSyncUi();
    } catch (error) {
      updateRotationSyncUi("再接続中…");
    }
  }

  function applySyncedRotation(match) {
    const home = sanitizeTeamRotation(match?.home);
    const away = sanitizeTeamRotation(match?.away);
    if (!home || !away || !state.activeVideoId) return;
    state.syncApplying = true;
    state.rotationData.videos[state.activeVideoId] = { home, away };
    state.syncRevision = Number(match.revision) || 0;
    persistRotationData();
    renderRotationBoard();
    state.syncApplying = false;
  }

  function hasRotationContent(value) {
    if (!value) return false;
    return ROTATION_TEAMS.some((team) => {
      const rotation = value[team];
      return Boolean(
        rotation &&
        (rotation.rotation !== 1 ||
          rotation.setterPosition !== null ||
          ROTATION_POSITIONS.some((position) => rotation.players?.[position])),
      );
    });
  }

  function queueRotationSync() {
    if (!state.syncMatchId || state.syncApplying) return;
    window.clearTimeout(state.syncPushTimer);
    state.syncPushTimer = window.setTimeout(pushRotationSync, 250);
  }

  async function pushRotationSync() {
    const videoRotation = getCurrentVideoRotation(false) || createEmptyVideoRotation();
    if (!state.syncMatchId) return;
    try {
      const result = await requestSyncApi(
        `/api/matches/${encodeURIComponent(state.syncMatchId)}/rotation`,
        { method: "PUT", body: videoRotation },
      );
      state.syncRevision = Number(result.match.revision) || state.syncRevision;
      updateRotationSyncUi();
    } catch (error) {
      updateRotationSyncUi("送信に失敗");
      showToast(error.message, "error");
    }
  }

  function updateRotationSyncUi(statusText = "") {
    const connected = Boolean(state.syncMatchId);
    elements.rotationSyncButton.textContent = connected ? "解除" : "接続";
    elements.rotationMatchId.disabled = connected;
    elements.rotationSyncStatus.textContent = statusText || (connected ? `試合 ${state.syncMatchId} と同期中` : "未接続");
    elements.rotationSyncStatus.classList.toggle("is-connected", connected && !statusText);
    elements.scoreboardLink.href = connected
      ? `scoreboard.html?match=${encodeURIComponent(state.syncMatchId)}`
      : "scoreboard.html";
  }

  async function requestSyncApi(path, options = {}) {
    let response;
    try {
      response = await fetch(`${SYNC_API_BASE}${path}`, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new Error("同期サーバーへ接続できません。通信状態を確認してください。");
    }
    let result = {};
    try {
      result = await response.json();
    } catch {
      // Use the fallback error below.
    }
    if (!response.ok) {
      throw new Error(result.error || "ローテーションの同期に失敗しました。");
    }
    return result;
  }

  function toggleRotationPanel() {
    const shouldCollapse = !elements.rotationContent.hidden;
    elements.rotationContent.hidden = shouldCollapse;
    elements.rotationPanel.classList.toggle("is-collapsed", shouldCollapse);
    elements.playerColumn.classList.toggle("rotation-collapsed", shouldCollapse);
    elements.rotationToggleButton.setAttribute("aria-expanded", String(!shouldCollapse));
    elements.rotationToggleButton.textContent = shouldCollapse ? "表示する" : "折りたたむ";
  }

  function renderMemoList() {
    elements.memoList.replaceChildren();

    const allMemos = getCurrentVideoMemos();
    const searchQuery = elements.memoSearch.value.trim().toLocaleLowerCase();
    const filteredMemos = allMemos.filter((memo) =>
      memo.text.toLocaleLowerCase().includes(searchQuery),
    );
    const sortedMemos = sortMemos(filteredMemos);

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
    wrapper.className = "memo-edit-area";
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
      showToast("メモを削除しました。", "success");
    } catch (error) {
      console.error("Memo delete failed:", error);
      if (!error.handled) {
        showToast("メモを削除できませんでした。", "error");
      }
    }
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
    let response;
    try {
      response = await fetch(`${SHARED_API_BASE}${path}`, requestOptions);
    } catch (error) {
      throw error;
    }

    let result = {};
    try {
      result = await response.json();
    } catch {
      result = {};
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

    const isAltOnly =
      event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (isAltOnly && event.code === "KeyL") {
      event.preventDefault();
      seekToLiveEdge();
      return;
    }
    if (isAltOnly && event.key === "ArrowLeft") {
      event.preventDefault();
      movePlaybackBy(-5);
      return;
    }
    if (isAltOnly && event.key === "ArrowRight") {
      event.preventDefault();
      movePlaybackBy(5);
      return;
    }

    if (isTextEntryTarget(event.target)) {
      return;
    }

    if (
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !isActionTarget(event.target)
    ) {
      event.preventDefault();
      togglePlayback();
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
