(() => {
  "use strict";

  const API_BASE = window.location.hostname.endsWith(".pages.dev")
    ? "https://youtube-live-memo-jp.junmari10221122.chatgpt.site"
    : "";
  const MATCH_ID_PATTERN = /^[A-Z0-9]{4,12}$/;
  const POSITIONS = [1, 2, 3, 4, 5, 6];
  const VISUAL_ORDER = { away: [1, 6, 5, 2, 3, 4], home: [4, 3, 2, 5, 6, 1] };
  const state = { matchId: "", match: null, polling: null, saving: false, scoreTimer: null, rotationTimer: null };
  const elements = {};

  document.addEventListener("DOMContentLoaded", initialize);

  function initialize() {
    cacheElements();
    createCourts();
    bindEvents();
    const queryMatch = new URLSearchParams(window.location.search).get("match");
    if (queryMatch) {
      elements.matchIdInput.value = queryMatch.toUpperCase();
      connectMatch();
    }
  }

  function cacheElements() {
    ["match-id-input", "connect-button", "create-button", "connection-status", "match-board", "set-number", "set-down", "set-up", "away-name", "home-name", "away-score", "home-score", "away-rotation-label", "home-rotation-label", "away-court", "home-court", "active-match-id", "copy-match-id", "reset-match", "toast-region"].forEach((id) => {
      elements[toCamel(id)] = document.getElementById(id);
    });
    elements.scoreButtons = Array.from(document.querySelectorAll("[data-score-team]"));
    elements.serveButtons = Array.from(document.querySelectorAll("[data-serve-team]"));
    elements.rotateButtons = Array.from(document.querySelectorAll("[data-rotate-team]"));
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function createCourts() {
    ["away", "home"].forEach((team) => {
      const court = elements[`${team}Court`];
      VISUAL_ORDER[team].forEach((position) => {
        const slot = document.createElement("div");
        slot.className = "position";
        slot.dataset.team = team;
        slot.dataset.position = String(position);
        const label = document.createElement("label");
        const input = document.createElement("input");
        const setter = document.createElement("button");
        input.id = `${team}-player-${position}`;
        input.inputMode = "numeric";
        input.maxLength = 2;
        input.placeholder = "番号";
        input.setAttribute("aria-label", `${team === "home" ? "自" : "相手"}チーム 位置${position}の背番号`);
        label.htmlFor = input.id;
        label.textContent = String(position);
        setter.type = "button";
        setter.textContent = "S";
        setter.setAttribute("aria-label", `位置${position}をセッターに指定`);
        input.addEventListener("input", handlePlayerInput);
        setter.addEventListener("click", handleSetter);
        slot.append(label, input, setter);
        court.appendChild(slot);
      });
    });
  }

  function bindEvents() {
    elements.matchIdInput.addEventListener("input", () => {
      elements.matchIdInput.value = elements.matchIdInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    elements.matchIdInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") connectMatch();
    });
    elements.connectButton.addEventListener("click", connectMatch);
    elements.createButton.addEventListener("click", createMatch);
    elements.scoreButtons.forEach((button) => button.addEventListener("click", handleScore));
    elements.serveButtons.forEach((button) => button.addEventListener("click", handleServe));
    elements.rotateButtons.forEach((button) => button.addEventListener("click", handleRotate));
    elements.setDown.addEventListener("click", () => changeSet(-1));
    elements.setUp.addEventListener("click", () => changeSet(1));
    elements.homeName.addEventListener("change", saveScoreState);
    elements.awayName.addEventListener("change", saveScoreState);
    elements.copyMatchId.addEventListener("click", copyMatchId);
    elements.resetMatch.addEventListener("click", resetScore);
  }

  async function createMatch() {
    setBusy(true);
    try {
      const result = await api("/api/matches", { method: "POST", body: {} });
      activateMatch(result.match);
      elements.matchIdInput.value = result.match.matchId;
      showToast("新しい試合を作成しました。試合IDをライブメモ側へ入力してください。");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function connectMatch() {
    const matchId = elements.matchIdInput.value.trim().toUpperCase();
    if (!MATCH_ID_PATTERN.test(matchId)) {
      showToast("試合IDは4〜12文字の英数字で入力してください。", true);
      return;
    }
    setBusy(true);
    try {
      const result = await api(`/api/matches/${encodeURIComponent(matchId)}`);
      activateMatch(result.match);
      showToast("試合に接続しました。");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  function activateMatch(match) {
    state.matchId = match.matchId;
    state.match = match;
    elements.matchBoard.hidden = false;
    elements.activeMatchId.textContent = match.matchId;
    elements.connectionStatus.textContent = `接続中：${match.matchId}（自動同期）`;
    elements.connectionStatus.classList.add("connected");
    history.replaceState(null, "", `${location.pathname}?match=${encodeURIComponent(match.matchId)}`);
    render();
    window.clearInterval(state.polling);
    state.polling = window.setInterval(pollMatch, 1500);
  }

  async function pollMatch() {
    if (!state.matchId || state.saving) return;
    try {
      const result = await api(`/api/matches/${encodeURIComponent(state.matchId)}`);
      if (!state.match || result.match.revision !== state.match.revision) {
        state.match = result.match;
        render();
      }
    } catch (error) {
      elements.connectionStatus.textContent = "再接続中…";
      elements.connectionStatus.classList.remove("connected");
    }
  }

  function render() {
    const match = state.match;
    if (!match) return;
    elements.homeName.value = match.homeName;
    elements.awayName.value = match.awayName;
    elements.homeScore.textContent = String(match.homeScore);
    elements.awayScore.textContent = String(match.awayScore);
    elements.setNumber.textContent = String(match.setNumber);
    elements.homeRotationLabel.textContent = `R${match.home.rotation}`;
    elements.awayRotationLabel.textContent = `R${match.away.rotation}`;
    elements.serveButtons.forEach((button) => button.classList.toggle("active", button.dataset.serveTeam === match.servingTeam));
    document.querySelectorAll(".position").forEach((slot) => {
      const team = slot.dataset.team;
      const position = Number(slot.dataset.position);
      const input = slot.querySelector("input");
      const button = slot.querySelector("button");
      input.value = match[team].players[position] || "";
      const isSetter = match[team].setterPosition === position;
      slot.classList.toggle("setter", isSetter);
      button.classList.toggle("active", isSetter);
      button.setAttribute("aria-pressed", String(isSetter));
    });
    elements.connectionStatus.textContent = `接続中：${match.matchId}（自動同期）`;
    elements.connectionStatus.classList.add("connected");
  }

  async function handleScore(event) {
    const team = event.currentTarget.dataset.scoreTeam;
    const delta = Number(event.currentTarget.dataset.scoreDelta);
    if (delta === 1 && state.match.servingTeam === "none") {
      showToast("先に映像アプリで最初のサーブ権を設定してください。", true);
      return;
    }
    const key = `${team}Score`;
    const sideOut = delta === 1 && state.match.servingTeam !== team;
    state.match[key] = Math.max(0, Math.min(99, state.match[key] + delta));
    if (sideOut) {
      rotateTeam(state.match[team], "next");
      state.match.servingTeam = team;
    }
    render();
    try {
      const result = await api(`/api/matches/${encodeURIComponent(state.matchId)}/point`, {
        method: "PUT",
        body: { team, delta },
      });
      if (!state.match || result.match.revision >= state.match.revision) {
        state.match = result.match;
        render();
      }
      if (result.sideOut) {
        showToast(`${result.match[team === "home" ? "homeName" : "awayName"]}がサイドアウト。ローテーションしました。`);
      }
    } catch (error) {
      showToast(error.message, true);
      pollMatch();
    }
  }

  function handleServe(event) {
    const team = event.currentTarget.dataset.serveTeam;
    state.match.servingTeam = state.match.servingTeam === team ? "none" : team;
    render();
    saveScoreState();
  }

  function changeSet(delta) {
    state.match.setNumber = Math.max(1, Math.min(9, state.match.setNumber + delta));
    render();
    saveScoreState();
  }

  function handlePlayerInput(event) {
    const slot = event.currentTarget.closest(".position");
    const value = event.currentTarget.value.replace(/\D/g, "").slice(0, 2);
    event.currentTarget.value = value;
    state.match[slot.dataset.team].players[slot.dataset.position] = value;
    saveRotationState();
  }

  function handleSetter(event) {
    const slot = event.currentTarget.closest(".position");
    const team = slot.dataset.team;
    const position = Number(slot.dataset.position);
    state.match[team].setterPosition = state.match[team].setterPosition === position ? null : position;
    render();
    saveRotationState();
  }

  function handleRotate(event) {
    const team = event.currentTarget.dataset.rotateTeam;
    const direction = event.currentTarget.dataset.direction;
    rotateTeam(state.match[team], direction);
    render();
    saveRotationState();
  }

  function rotateTeam(rotation, direction) {
    const previous = { ...rotation.players };
    const previousSetter = rotation.setterPosition;
    POSITIONS.forEach((position) => {
      const source = direction === "next" ? (position === 6 ? 1 : position + 1) : (position === 1 ? 6 : position - 1);
      rotation.players[position] = previous[source] || "";
    });
    rotation.rotation = direction === "next" ? (rotation.rotation % 6) + 1 : ((rotation.rotation + 4) % 6) + 1;
    if (previousSetter) {
      rotation.setterPosition = direction === "next" ? (previousSetter === 1 ? 6 : previousSetter - 1) : (previousSetter === 6 ? 1 : previousSetter + 1);
    }
  }

  function saveScoreState() {
    if (!state.matchId) return;
    state.match.homeName = elements.homeName.value.trim() || "自チーム";
    state.match.awayName = elements.awayName.value.trim() || "相手チーム";
    window.clearTimeout(state.scoreTimer);
    state.scoreTimer = window.setTimeout(() => {
      save("score", { homeName: state.match.homeName, awayName: state.match.awayName, homeScore: state.match.homeScore, awayScore: state.match.awayScore, setNumber: state.match.setNumber, servingTeam: state.match.servingTeam });
    }, 120);
  }

  function saveRotationState() {
    if (!state.matchId) return;
    window.clearTimeout(state.rotationTimer);
    state.rotationTimer = window.setTimeout(() => {
      save("rotation", { home: state.match.home, away: state.match.away });
    }, 120);
  }

  async function save(section, body) {
    state.saving = true;
    try {
      const result = await api(`/api/matches/${encodeURIComponent(state.matchId)}/${section}`, { method: "PUT", body });
      state.match.revision = result.match.revision;
      state.match.updatedAt = result.match.updatedAt;
      if (section === "score") {
        state.match.homeName = result.match.homeName;
        state.match.awayName = result.match.awayName;
      } else {
        state.match.home = result.match.home;
        state.match.away = result.match.away;
      }
      render();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      state.saving = false;
    }
  }

  function resetScore() {
    if (!state.match || !window.confirm("両チームの得点を0に戻しますか？")) return;
    state.match.homeScore = 0;
    state.match.awayScore = 0;
    state.match.servingTeam = "none";
    render();
    saveScoreState();
  }

  async function copyMatchId() {
    try {
      await navigator.clipboard.writeText(state.matchId);
      showToast("試合IDをコピーしました。");
    } catch {
      showToast(`試合ID：${state.matchId}`);
    }
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: options.method || "GET",
        headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
      });
    } catch {
      throw new Error("サーバーへ接続できません。通信状態を確認してください。");
    }
    let result = {};
    try { result = await response.json(); } catch { /* Use fallback below. */ }
    if (!response.ok) throw new Error(result.error || "同期処理に失敗しました。");
    return result;
  }

  function setBusy(busy) {
    elements.connectButton.disabled = busy;
    elements.createButton.disabled = busy;
  }

  function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }
})();
