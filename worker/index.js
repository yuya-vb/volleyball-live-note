const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_MEMO_LENGTH = 5000;
const MAX_REQUEST_BYTES = 20000;
const MATCH_ID_PATTERN = /^[A-Z0-9]{4,12}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
        return withCors(request, new Response(null, { status: 204 }));
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return withCors(request, jsonResponse({ shared: true }));
      }

      if (url.pathname === "/api/notes" && request.method === "GET") {
        return withCors(request, await listNotes(url, env));
      }

      if (url.pathname === "/api/notes" && request.method === "POST") {
        return withCors(request, await createNote(request, env));
      }

      if (url.pathname === "/api/notes" && request.method === "DELETE") {
        return withCors(request, await deleteVideoNotes(url, env));
      }

      if (url.pathname === "/api/matches" && request.method === "POST") {
        return withCors(request, await createMatch(request, env));
      }

      if (url.pathname.startsWith("/api/matches/")) {
        return withCors(request, await handleMatchRequest(request, url, env));
      }

      if (url.pathname.startsWith("/api/notes/")) {
        const noteId = decodeURIComponent(url.pathname.slice("/api/notes/".length));
        if (!noteId || noteId.length > 200) {
          return withCors(
            request,
            jsonResponse({ error: "メモIDが正しくありません。" }, 400),
          );
        }
        if (request.method === "PUT") {
          return withCors(request, await updateNote(request, env, noteId));
        }
        if (request.method === "DELETE") {
          return withCors(request, await deleteNote(env, noteId));
        }
      }

      if (url.pathname.startsWith("/api/")) {
        return withCors(request, jsonResponse({ error: "APIが見つかりません。" }, 404));
      }

      const assetResponse = await env.ASSETS.fetch(request);
      const response = new Response(assetResponse.body, assetResponse);
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      return response;
    } catch (error) {
      console.error("Worker request failed:", error);
      return withCors(
        request,
        jsonResponse({ error: "サーバー処理に失敗しました。" }, 500),
      );
    }
  },
};

async function listNotes(url, env) {
  const videoId = url.searchParams.get("videoId") || "";
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return jsonResponse({ error: "動画IDが正しくありません。" }, 400);
  }

  const result = await env.DB.prepare(
    `SELECT id, video_id, text, playback_time, saved_at
     FROM notes
     WHERE video_id = ?
     ORDER BY playback_time ASC, saved_at ASC`,
  )
    .bind(videoId)
    .all();

  return jsonResponse({ notes: (result.results || []).map(mapNoteRow) });
}

async function createNote(request, env) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }

  const validationError = validateNewNote(body.value);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  const id = crypto.randomUUID();
  const savedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO notes
      (id, video_id, text, playback_time, saved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.value.videoId, body.value.text.trim(), body.value.time, savedAt, savedAt)
    .run();

  return jsonResponse(
    {
      note: {
        id,
        videoId: body.value.videoId,
        text: body.value.text.trim(),
        time: body.value.time,
        savedAt,
      },
    },
    201,
  );
}

async function updateNote(request, env, noteId) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }

  const text = typeof body.value.text === "string" ? body.value.text.trim() : "";
  if (!text || text.length > MAX_MEMO_LENGTH) {
    return jsonResponse({ error: `メモ本文は1〜${MAX_MEMO_LENGTH}文字で入力してください。` }, 400);
  }

  const updateResult = await env.DB.prepare(
    "UPDATE notes SET text = ?, updated_at = ? WHERE id = ?",
  )
    .bind(text, new Date().toISOString(), noteId)
    .run();
  if (!updateResult.meta || updateResult.meta.changes < 1) {
    return jsonResponse({ error: "編集対象のメモが見つかりません。" }, 404);
  }

  const row = await env.DB.prepare(
    `SELECT id, video_id, text, playback_time, saved_at
     FROM notes
     WHERE id = ?`,
  )
    .bind(noteId)
    .first();
  return jsonResponse({ note: mapNoteRow(row) });
}

async function deleteNote(env, noteId) {
  const result = await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(noteId).run();
  if (!result.meta || result.meta.changes < 1) {
    return jsonResponse({ error: "削除対象のメモが見つかりません。" }, 404);
  }
  return jsonResponse({ deleted: true });
}

async function deleteVideoNotes(url, env) {
  const videoId = url.searchParams.get("videoId") || "";
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return jsonResponse({ error: "動画IDが正しくありません。" }, 400);
  }
  const result = await env.DB.prepare("DELETE FROM notes WHERE video_id = ?").bind(videoId).run();
  return jsonResponse({ deleted: result.meta?.changes || 0 });
}

async function createMatch(request, env) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }
  const requestedId = String(body.value?.matchId || "").trim().toUpperCase();
  const matchId = requestedId || createMatchId();
  if (!MATCH_ID_PATTERN.test(matchId)) {
    return jsonResponse({ error: "試合IDは4〜12文字の英数字で入力してください。" }, 400);
  }

  const existing = await getMatchRow(env, matchId);
  if (existing) {
    return jsonResponse({ error: "その試合IDはすでに使用されています。" }, 409);
  }
  await ensureMatch(env, matchId);
  return jsonResponse({ match: mapMatchRow(await getMatchRow(env, matchId)) }, 201);
}

async function handleMatchRequest(request, url, env) {
  const parts = url.pathname.slice("/api/matches/".length).split("/").filter(Boolean);
  const matchId = decodeURIComponent(parts[0] || "").trim().toUpperCase();
  const section = parts[1] || "";
  if (!MATCH_ID_PATTERN.test(matchId)) {
    return jsonResponse({ error: "試合IDが正しくありません。" }, 400);
  }

  if (request.method === "GET" && !section) {
    const row = await getMatchRow(env, matchId);
    return row
      ? jsonResponse({ match: mapMatchRow(row) })
      : jsonResponse({ error: "試合が見つかりません。" }, 404);
  }
  if (request.method === "PUT" && section === "score") {
    return updateMatchScore(request, env, matchId);
  }
  if (request.method === "PUT" && section === "rotation") {
    return updateMatchRotation(request, env, matchId);
  }
  if (request.method === "PUT" && section === "serve") {
    return updateMatchServe(request, env, matchId);
  }
  if (request.method === "PUT" && section === "point") {
    return updateMatchPoint(request, env, matchId);
  }
  if (request.method === "PUT" && section === "set") {
    return updateMatchSet(request, env, matchId);
  }
  return jsonResponse({ error: "試合APIが見つかりません。" }, 404);
}

async function updateMatchScore(request, env, matchId) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }
  const value = body.value || {};
  const homeName = sanitizeTeamName(value.homeName, "自チーム");
  const awayName = sanitizeTeamName(value.awayName, "相手チーム");
  if (
    !Number.isInteger(value.homeScore) || value.homeScore < 0 || value.homeScore > 99 ||
    !Number.isInteger(value.awayScore) || value.awayScore < 0 || value.awayScore > 99 ||
    !Number.isInteger(value.setNumber) || value.setNumber < 1 || value.setNumber > 9 ||
    !["home", "away", "none"].includes(value.servingTeam)
  ) {
    return jsonResponse({ error: "得点データが正しくありません。" }, 400);
  }

  await ensureMatch(env, matchId);
  const currentMatch = mapMatchRow(await getMatchRow(env, matchId));
  const setScores = currentMatch.setScores;
  const pointHistory = currentMatch.pointHistory;
  const scoresChanged =
    currentMatch.homeScore !== value.homeScore || currentMatch.awayScore !== value.awayScore;
  setScores[value.setNumber] = {
    home: value.homeScore,
    away: value.awayScore,
  };
  if (scoresChanged) {
    pointHistory[String(value.setNumber)] = [];
  }
  await env.DB.prepare(
    `UPDATE matches
     SET home_name = ?, away_name = ?, home_score = ?, away_score = ?,
         set_number = ?, serving_team = ?, set_scores = ?, point_history = ?,
         revision = revision + 1, updated_at = ?
     WHERE match_id = ?`,
  )
    .bind(homeName, awayName, value.homeScore, value.awayScore, value.setNumber, value.servingTeam, JSON.stringify(setScores), JSON.stringify(pointHistory), new Date().toISOString(), matchId)
    .run();
  return jsonResponse({ match: mapMatchRow(await getMatchRow(env, matchId)) });
}

async function updateMatchRotation(request, env, matchId) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }
  const home = sanitizeRotation(body.value?.home);
  const away = sanitizeRotation(body.value?.away);
  if (!home || !away) {
    return jsonResponse({ error: "ローテーションデータが正しくありません。" }, 400);
  }

  await ensureMatch(env, matchId);
  const currentMatch = mapMatchRow(await getMatchRow(env, matchId));
  currentMatch.pointHistory[String(currentMatch.setNumber)] = [];
  await env.DB.prepare(
    `UPDATE matches
     SET home_rotation = ?, away_rotation = ?, point_history = ?,
         revision = revision + 1, updated_at = ?
     WHERE match_id = ?`,
  )
    .bind(JSON.stringify(home), JSON.stringify(away), JSON.stringify(currentMatch.pointHistory), new Date().toISOString(), matchId)
    .run();
  return jsonResponse({ match: mapMatchRow(await getMatchRow(env, matchId)) });
}

async function updateMatchServe(request, env, matchId) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }
  const servingTeam = body.value?.servingTeam;
  if (!["home", "away", "none"].includes(servingTeam)) {
    return jsonResponse({ error: "サーブ権の指定が正しくありません。" }, 400);
  }
  await ensureMatch(env, matchId);
  const currentMatch = mapMatchRow(await getMatchRow(env, matchId));
  currentMatch.pointHistory[String(currentMatch.setNumber)] = [];
  await env.DB.prepare(
    `UPDATE matches
     SET serving_team = ?, point_history = ?, revision = revision + 1, updated_at = ?
     WHERE match_id = ?`,
  )
    .bind(servingTeam, JSON.stringify(currentMatch.pointHistory), new Date().toISOString(), matchId)
    .run();
  return jsonResponse({ match: mapMatchRow(await getMatchRow(env, matchId)) });
}

async function updateMatchPoint(request, env, matchId) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }
  const team = body.value?.team;
  const delta = body.value?.delta;
  if (!["home", "away"].includes(team) || ![-1, 1].includes(delta)) {
    return jsonResponse({ error: "得点操作が正しくありません。" }, 400);
  }

  await ensureMatch(env, matchId);
  const match = mapMatchRow(await getMatchRow(env, matchId));
  if (delta === 1 && match.servingTeam === "none") {
    return jsonResponse({ error: "先に映像アプリで最初のサーブ権を設定してください。" }, 409);
  }

  const historyKey = String(match.setNumber);
  const history = match.pointHistory[historyKey] || [];
  let sideOut = false;
  let undone = false;

  if (delta === 1) {
    const scoreKey = team === "home" ? "homeScore" : "awayScore";
    if (match[scoreKey] >= 99) {
      return jsonResponse({ match, sideOut: false, undone: false });
    }
    history.push(createPointSnapshot(match, team));
    if (history.length > 500) {
      history.splice(0, history.length - 500);
    }
    match[scoreKey] += 1;
    sideOut = match.servingTeam !== team;
    if (sideOut) {
      rotateRotationNext(match[team]);
      match.servingTeam = team;
    }
  } else {
    const lastPoint = history[history.length - 1];
    if (!lastPoint) {
      return jsonResponse({ error: "このセットには取り消せる得点がありません。" }, 409);
    }
    if (lastPoint.team !== team) {
      return jsonResponse({ error: "直前に得点したチーム側の「−」を押してください。" }, 409);
    }
    history.pop();
    restorePointSnapshot(match, lastPoint);
    undone = true;
  }
  match.setScores[match.setNumber] = { home: match.homeScore, away: match.awayScore };
  match.pointHistory[historyKey] = history;

  await env.DB.prepare(
    `UPDATE matches
     SET home_score = ?, away_score = ?, serving_team = ?,
         home_rotation = ?, away_rotation = ?, set_scores = ?, point_history = ?,
         revision = revision + 1, updated_at = ?
     WHERE match_id = ?`,
  )
    .bind(
      match.homeScore,
      match.awayScore,
      match.servingTeam,
      JSON.stringify(match.home),
      JSON.stringify(match.away),
      JSON.stringify(match.setScores),
      JSON.stringify(match.pointHistory),
      new Date().toISOString(),
      matchId,
    )
    .run();
  return jsonResponse({
    match: mapMatchRow(await getMatchRow(env, matchId)),
    sideOut,
    undone,
  });
}

async function updateMatchSet(request, env, matchId) {
  const body = await readJsonBody(request);
  if (body.error) {
    return body.error;
  }
  const setNumber = body.value?.setNumber;
  if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 9) {
    return jsonResponse({ error: "セット番号が正しくありません。" }, 400);
  }
  await ensureMatch(env, matchId);
  const match = mapMatchRow(await getMatchRow(env, matchId));
  match.setScores[match.setNumber] = { home: match.homeScore, away: match.awayScore };
  const nextScores = match.setScores[setNumber] || { home: 0, away: 0 };
  match.setScores[setNumber] = nextScores;
  await env.DB.prepare(
    `UPDATE matches
     SET set_number = ?, home_score = ?, away_score = ?, set_scores = ?,
         revision = revision + 1, updated_at = ?
     WHERE match_id = ?`,
  )
    .bind(setNumber, nextScores.home, nextScores.away, JSON.stringify(match.setScores), new Date().toISOString(), matchId)
    .run();
  return jsonResponse({ match: mapMatchRow(await getMatchRow(env, matchId)) });
}

function createPointSnapshot(match, team) {
  return {
    team,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    servingTeam: match.servingTeam,
    home: sanitizeRotation(match.home),
    away: sanitizeRotation(match.away),
  };
}

function restorePointSnapshot(match, snapshot) {
  match.homeScore = snapshot.homeScore;
  match.awayScore = snapshot.awayScore;
  match.servingTeam = snapshot.servingTeam;
  match.home = sanitizeRotation(snapshot.home) || match.home;
  match.away = sanitizeRotation(snapshot.away) || match.away;
}

function rotateRotationNext(rotation) {
  const previousPlayers = { ...rotation.players };
  const previousSetterPosition = rotation.setterPosition;
  for (let position = 1; position <= 6; position += 1) {
    const sourcePosition = position === 6 ? 1 : position + 1;
    rotation.players[position] = previousPlayers[sourcePosition] || "";
  }
  rotation.rotation = (rotation.rotation % 6) + 1;
  if (previousSetterPosition !== null) {
    rotation.setterPosition = previousSetterPosition === 1 ? 6 : previousSetterPosition - 1;
  }
}

async function ensureMatch(env, matchId) {
  const now = new Date().toISOString();
  const emptyRotation = JSON.stringify(createEmptyRotation());
  await env.DB.prepare(
    `INSERT OR IGNORE INTO matches
      (match_id, home_name, away_name, home_score, away_score, set_number, serving_team,
       home_rotation, away_rotation, set_scores, point_history, revision, updated_at)
     VALUES (?, ?, ?, 0, 0, 1, 'none', ?, ?, '{"1":{"home":0,"away":0}}', '{}', 1, ?)`,
  )
    .bind(matchId, "自チーム", "相手チーム", emptyRotation, emptyRotation, now)
    .run();
}

function getMatchRow(env, matchId) {
  return env.DB.prepare(
    `SELECT match_id, home_name, away_name, home_score, away_score, set_number,
            serving_team, home_rotation, away_rotation, set_scores, point_history,
            revision, updated_at
     FROM matches WHERE match_id = ?`,
  )
    .bind(matchId)
    .first();
}

function createMatchId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function createEmptyRotation() {
  return {
    rotation: 1,
    players: { 1: "", 2: "", 3: "", 4: "", 5: "", 6: "" },
    setterPosition: null,
  };
}

function sanitizeRotation(value) {
  if (!value || typeof value !== "object" || !Number.isInteger(value.rotation) || value.rotation < 1 || value.rotation > 6) {
    return null;
  }
  const players = {};
  for (let position = 1; position <= 6; position += 1) {
    const player = String(value.players?.[position] ?? "");
    if (!/^\d{0,2}$/.test(player)) {
      return null;
    }
    players[position] = player;
  }
  const setterPosition = value.setterPosition === null ? null : Number(value.setterPosition);
  if (setterPosition !== null && (!Number.isInteger(setterPosition) || setterPosition < 1 || setterPosition > 6)) {
    return null;
  }
  return { rotation: value.rotation, players, setterPosition };
}

function sanitizeTeamName(value, fallback) {
  const name = typeof value === "string" ? value.trim().slice(0, 30) : "";
  return name || fallback;
}

function mapMatchRow(row) {
  let homeRotation = createEmptyRotation();
  let awayRotation = createEmptyRotation();
  try {
    homeRotation = sanitizeRotation(JSON.parse(row.home_rotation)) || homeRotation;
    awayRotation = sanitizeRotation(JSON.parse(row.away_rotation)) || awayRotation;
  } catch {
    // Keep safe defaults when persisted JSON is invalid.
  }
  const setScores = sanitizeSetScores(parseJsonObject(row.set_scores));
  if (!setScores[String(row.set_number)]) {
    setScores[String(row.set_number)] = {
      home: Number(row.home_score),
      away: Number(row.away_score),
    };
  }
  const pointHistory = sanitizePointHistory(parseJsonObject(row.point_history));
  const setWins = calculateSetWins(setScores);
  const match = {
    matchId: String(row.match_id),
    homeName: String(row.home_name),
    awayName: String(row.away_name),
    homeScore: Number(row.home_score),
    awayScore: Number(row.away_score),
    setNumber: Number(row.set_number),
    servingTeam: String(row.serving_team),
    home: homeRotation,
    away: awayRotation,
    homeSets: setWins.home,
    awaySets: setWins.away,
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
  };
  Object.defineProperties(match, {
    setScores: { value: setScores, enumerable: false },
    pointHistory: { value: pointHistory, enumerable: false },
  });
  return match;
}

function calculateSetWins(setScores) {
  const wins = { home: 0, away: 0 };
  Object.entries(setScores).forEach(([setNumberText, score]) => {
    const setNumber = Number(setNumberText);
    const target = setNumber === 5 ? 15 : 25;
    const difference = Math.abs(score.home - score.away);
    if (difference < 2 || Math.max(score.home, score.away) < target) return;
    if (score.home > score.away) wins.home += 1;
    if (score.away > score.home) wins.away += 1;
  });
  return wins;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeSetScores(value) {
  const result = {};
  for (let setNumber = 1; setNumber <= 9; setNumber += 1) {
    const score = value[String(setNumber)];
    if (
      score && Number.isInteger(score.home) && score.home >= 0 && score.home <= 99 &&
      Number.isInteger(score.away) && score.away >= 0 && score.away <= 99
    ) {
      result[String(setNumber)] = { home: score.home, away: score.away };
    }
  }
  return result;
}

function sanitizePointHistory(value) {
  const result = {};
  for (let setNumber = 1; setNumber <= 9; setNumber += 1) {
    const items = value[String(setNumber)];
    if (!Array.isArray(items)) continue;
    result[String(setNumber)] = items.slice(-500).filter((item) =>
      item && ["home", "away"].includes(item.team) &&
      Number.isInteger(item.homeScore) && Number.isInteger(item.awayScore) &&
      ["home", "away", "none"].includes(item.servingTeam) &&
      sanitizeRotation(item.home) && sanitizeRotation(item.away),
    );
  }
  return result;
}

function validateNewNote(value) {
  if (!value || typeof value !== "object") {
    return "送信データが正しくありません。";
  }
  if (!VIDEO_ID_PATTERN.test(value.videoId || "")) {
    return "動画IDが正しくありません。";
  }
  if (typeof value.text !== "string" || !value.text.trim() || value.text.trim().length > MAX_MEMO_LENGTH) {
    return `メモ本文は1〜${MAX_MEMO_LENGTH}文字で入力してください。`;
  }
  if (!Number.isFinite(value.time) || value.time < 0 || value.time > 1000000000) {
    return "再生時間が正しくありません。";
  }
  return "";
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return { error: jsonResponse({ error: "送信データが大きすぎます。" }, 413) };
  }
  try {
    return { value: await request.json() };
  } catch {
    return { error: jsonResponse({ error: "JSONデータを読み取れません。" }, 400) };
  }
}

function mapNoteRow(row) {
  return {
    id: String(row.id),
    videoId: String(row.video_id),
    text: String(row.text),
    time: Number(row.playback_time),
    savedAt: String(row.saved_at),
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function withCors(request, response) {
  const origin = request.headers.get("Origin") || "";
  const isAllowedOrigin =
    origin === "https://volleyball-live-note.pages.dev" ||
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  if (!isAllowedOrigin) {
    return response;
  }

  const corsResponse = new Response(response.body, response);
  corsResponse.headers.set("Access-Control-Allow-Origin", origin);
  corsResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  corsResponse.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type",
  );
  corsResponse.headers.set("Vary", "Origin");
  return corsResponse;
}
