const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_MEMO_LENGTH = 5000;
const MAX_REQUEST_BYTES = 20000;

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

      if (url.pathname === "/api/auth/verify" && request.method === "POST") {
        const response = (await isAuthorized(request, env))
          ? jsonResponse({ authorized: true })
          : jsonResponse({ error: "合言葉が正しくありません。" }, 401);
        return withCors(request, response);
      }

      if (url.pathname === "/api/notes" && request.method === "GET") {
        return withCors(request, await listNotes(url, env));
      }

      if (url.pathname === "/api/notes" && request.method === "POST") {
        if (!(await isAuthorized(request, env))) {
          return withCors(
            request,
            jsonResponse({ error: "編集用の合言葉が必要です。" }, 401),
          );
        }
        return withCors(request, await createNote(request, env));
      }

      if (url.pathname === "/api/notes" && request.method === "DELETE") {
        if (!(await isAuthorized(request, env))) {
          return withCors(
            request,
            jsonResponse({ error: "編集用の合言葉が必要です。" }, 401),
          );
        }
        return withCors(request, await deleteVideoNotes(url, env));
      }

      if (url.pathname.startsWith("/api/notes/")) {
        if (!(await isAuthorized(request, env))) {
          return withCors(
            request,
            jsonResponse({ error: "編集用の合言葉が必要です。" }, 401),
          );
        }
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

async function isAuthorized(request, env) {
  const expected = typeof env.EDIT_PASSPHRASE === "string" ? env.EDIT_PASSPHRASE : "";
  const supplied = request.headers.get("X-Edit-Passphrase") || "";
  if (!expected || !supplied) {
    return false;
  }

  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const first = new Uint8Array(expectedHash);
  const second = new Uint8Array(suppliedHash);
  let difference = first.length ^ second.length;
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    difference |= first[index] ^ second[index];
  }
  return difference === 0;
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
  if (origin !== "https://volleyball-live-note.pages.dev") {
    return response;
  }

  const corsResponse = new Response(response.body, response);
  corsResponse.headers.set("Access-Control-Allow-Origin", origin);
  corsResponse.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  corsResponse.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Edit-Passphrase",
  );
  corsResponse.headers.set("Vary", "Origin");
  return corsResponse;
}
