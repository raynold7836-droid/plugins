/**
 * Zhuxin MD — Showroom ALL-IN-ONE
 * scraper + watcher + command (.showroom)
 * File: plugins/info/showroom.js
 */
import axios from "axios";
import fs from "fs";
import path from "path";

/**
 * Zhuxin MD — Showroom (ALL-IN-ONE)
 * scraper + watcher + plugin command
 * Path: plugins/info/showroom.js
 */
/*
 *
 * connection.js auto-start (opsional):
 *   import("../../plugins/info/showroom.js").then(m => m.startShowroomWatcher?.(sock))
 */
/* ===================== SCRAPER ===================== */
/**
 * Zhuxin MD — Showroom Live scraper
 * Developer: Raynold Kazama & Felicia Damaris
 * API: https://www.showroom-live.com
 */
const BASE = "https://www.showroom-live.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const client = axios.create({
  baseURL: BASE,
  timeout: 20000,
  headers: {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    Referer: `${BASE}/`,
  },
});

/** Extract room_url_key from URL or plain key */
function parseRoomKey(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  // https://www.showroom-live.com/r/JKT48_Nayla
  let m = s.match(/showroom-live\.com\/r\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  // https://www.showroom-live.com/JKT48_Nayla (old style)
  m = s.match(/showroom-live\.com\/([A-Za-z0-9_-]+)(?:\?|$)/i);
  if (m && !["r", "api", "room", "user", "event"].includes(m[1].toLowerCase()))
    return m[1];
  if (/^[A-Za-z0-9_-]{2,80}$/.test(s)) return s;
  return null;
}

function roomUrl(key) {
  return `${BASE}/r/${key}`;
}

function formatStarted(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + " WIB";
}

/**
 * Status room by room_url_key
 */
async function getRoomStatus(roomUrlKey) {
  const key = parseRoomKey(roomUrlKey);
  if (!key) throw new Error("Room key / URL tidak valid");

  const { data } = await client.get("/api/room/status", {
    params: { room_url_key: key },
  });

  const roomId = data.room_id || data.roomId;
  let profile = null;
  if (roomId) {
    try {
      const res = await client.get("/api/room/profile", {
        params: { room_id: roomId },
      });
      profile = res.data;
    } catch {}
  }

  const isLive = !!(data.is_live || data.is_onlive || profile?.is_onlive);
  const viewers =
    profile?.view_num ??
    profile?.viewer_num ??
    data.view_num ??
    data.viewer_num ??
    null;

  return {
    roomUrlKey: data.room_url_key || key,
    roomId: roomId || null,
    roomName: data.room_name || profile?.room_name || profile?.main_name || key,
    isLive,
    liveId: data.live_id || profile?.live_id || 0,
    startedAt: data.started_at || profile?.current_live_started_at || null,
    startedText: formatStarted(
      data.started_at || profile?.current_live_started_at,
    ),
    viewers: viewers != null ? Number(viewers) : null,
    image:
      data.image_l ||
      data.image_m ||
      data.image_s ||
      profile?.image_l ||
      profile?.image_m ||
      profile?.image_s ||
      null,
    isOfficial: !!(data.is_official || profile?.is_official),
    follower: profile?.follower_num ?? null,
    url: roomUrl(data.room_url_key || key),
    raw: { status: data, profile },
  };
}

/**
 * Semua yang sedang live (flatten)
 */
async function getOnlives() {
  const { data } = await client.get("/api/live/onlives");
  const list = [];
  for (const genre of data?.onlives || []) {
    for (const live of genre.lives || []) {
      list.push({
        genreId: genre.genre_id,
        genreName: genre.genre_name,
        roomUrlKey: live.room_url_key,
        roomId: live.room_id,
        roomName: live.room_name || live.main_name,
        viewers: live.view_num ?? live.viewer_num ?? 0,
        startedAt: live.started_at,
        startedText: formatStarted(live.started_at),
        image: live.image || live.image_m || live.image_s || null,
        telop: live.telop || null,
        url: roomUrl(live.room_url_key),
      });
    }
  }
  // dedupe by room key
  const seen = new Set();
  return list.filter((x) => {
    if (!x.roomUrlKey || seen.has(x.roomUrlKey)) return false;
    seen.add(x.roomUrlKey);
    return true;
  });
}

/** Cari live by keyword di nama / key */
async function searchOnlives(query) {
  const q = String(query || "").toLowerCase().trim();
  const all = await getOnlives();
  if (!q) return all.slice(0, 30);
  return all
    .filter(
      (x) =>
        (x.roomName || "").toLowerCase().includes(q) ||
        (x.roomUrlKey || "").toLowerCase().includes(q),
    )
    .slice(0, 30);
}

export default {
  parseRoomKey,
  roomUrl,
  getRoomStatus,
  getOnlives,
  searchOnlives,
};


/* ===================== WATCHER ===================== */
/**
 * Zhuxin MD — Showroom live watcher (auto notif)
 * Notif HANYA saat transisi offline → online (anti-spam)
 */
const DATA_DIR = path.join(process.cwd(), "src", "data");
const STATE_FILE = path.join(DATA_DIR, "showroom_watch.json");

const DEFAULT_STATE = {
  enabled: true,
  intervalMin: 2,
  /** roomKey -> { name, chats: string[], wasLive } */
  rooms: {},
  /** chatId[] — notif semua JKT48 */
  jkt48Chats: [],
  /**
   * State live JKT48 global (anti-spam):
   * roomKey -> { wasLive: boolean, lastNotifiedAt: number }
   */
  jkt48RoomState: {},
};

let timer = null;
let running = false;

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return structuredClone(DEFAULT_STATE);
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...structuredClone(DEFAULT_STATE), ...raw };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[showroom-watch] save", e.message);
  }
}

function listWatch(chatId) {
  const st = loadState();
  const out = [];
  for (const [key, info] of Object.entries(st.rooms || {})) {
    if (!chatId || (info.chats || []).includes(String(chatId))) {
      out.push({ key, ...info });
    }
  }
  return out;
}

function addWatch(chatId, roomKey, roomName = null) {
  const key = parseRoomKey(roomKey);
  if (!key) throw new Error("Room key tidak valid");
  const st = loadState();
  if (!st.rooms[key]) {
    st.rooms[key] = {
      name: roomName || key,
      chats: [],
      wasLive: false,
    };
  }
  const cid = String(chatId);
  if (!st.rooms[key].chats.includes(cid)) st.rooms[key].chats.push(cid);
  if (roomName) st.rooms[key].name = roomName;
  saveState(st);
  return st.rooms[key];
}

function removeWatch(chatId, roomKey) {
  const key = parseRoomKey(roomKey);
  if (!key) throw new Error("Room key tidak valid");
  const st = loadState();
  if (!st.rooms[key]) return false;
  st.rooms[key].chats = (st.rooms[key].chats || []).filter(
    (c) => c !== String(chatId),
  );
  if (!st.rooms[key].chats.length) delete st.rooms[key];
  saveState(st);
  return true;
}

function formatViewers(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("id-ID");
}

function buildLiveCaption(info) {
  return (
    `🔴 *SHOWROOM LIVE*\n\n` +
    `*${info.roomName || info.roomUrlKey}*\n` +
    `sedang LIVE (SHOWROOM)!\n\n` +
    (info.viewers != null ? `👥 Viewers: *${formatViewers(info.viewers)}*\n` : "") +
    (info.startedText ? `🕐 Mulai: ${info.startedText}\n` : "") +
    `\n🔗 ${info.url || `https://www.showroom-live.com/r/${info.roomUrlKey}`}`
  );
}

function enableJkt48Watch(chatId) {
  const st = loadState();
  const cid = String(chatId);
  if (!Array.isArray(st.jkt48Chats)) st.jkt48Chats = [];
  if (!st.jkt48Chats.includes(cid)) st.jkt48Chats.push(cid);
  saveState(st);
  return true;
}

function disableJkt48Watch(chatId) {
  const st = loadState();
  const cid = String(chatId);
  st.jkt48Chats = (st.jkt48Chats || []).filter((c) => c !== cid);
  saveState(st);
  return true;
}

function isJkt48Watch(chatId) {
  const st = loadState();
  return (st.jkt48Chats || []).includes(String(chatId));
}

function isJkt48Room(live) {
  const key = String(live.roomUrlKey || live.room_url_key || "");
  const name = String(live.roomName || live.room_name || "");
  return (
    /^JKT48[_-]/i.test(key) ||
    /JKT48/i.test(name) ||
    /^jkt48/i.test(key)
  );
}

async function sendLiveNotif(sock, chat, status) {
  const caption = buildLiveCaption(status);
  try {
    if (status.image) {
      await sock.sendMessage(chat, {
        image: { url: status.image },
        caption,
      });
    } else {
      await sock.sendMessage(chat, { text: caption });
    }
    return true;
  } catch (e) {
    console.error("[showroom-watch] send", chat, e.message);
    return false;
  }
}

function startShowroomWatcher(sock, opts = {}) {
  if (timer) return timer;

  const st0 = loadState();
  const intervalMs = Math.max(
    60_000,
    (Number(opts.intervalMin || st0.intervalMin) || 2) * 60_000,
  );

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const st = loadState();
      if (st.enabled === false) return;

      let onliveMap = null;
      let allLives = [];
      try {
        allLives = await getOnlives();
        onliveMap = new Map(
          (allLives || []).map((l) => [l.roomUrlKey || l.room_url_key, l]),
        );
      } catch (e) {
        console.error("[showroom-watch] onlives", e.message);
        // Jangan ubah wasLive kalau API gagal — hindari spam saat recover
        return;
      }

      // —— Watch manual per room ——
      const keys = Object.keys(st.rooms || {});
      for (const key of keys) {
        const info = st.rooms[key];
        if (!info?.chats?.length) continue;

        let isLive = false;
        let status = null;

        if (onliveMap?.has(key)) {
          const live = onliveMap.get(key);
          isLive = true;
          status = {
            roomUrlKey: key,
            roomName: live.roomName || live.room_name || info.name || key,
            isLive: true,
            viewers: live.viewers ?? live.view_num,
            startedText: live.startedText,
            image: live.image || live.image_m || live.image_l,
            url: live.url || `https://www.showroom-live.com/r/${key}`,
          };
        } else {
          isLive = false;
        }

        const wasLive = !!info.wasLive;

        // HANYA notif saat offline → online
        if (isLive && !wasLive && status) {
          for (const chat of info.chats) {
            await sendLiveNotif(sock, chat, status);
          }
          if (status.roomName) info.name = status.roomName;
        }

        info.wasLive = isLive;
        st.rooms[key] = info;
      }

      // —— Mode JKT48 auto ——
      const jktChats = st.jkt48Chats || [];
      if (jktChats.length) {
        if (!st.jkt48RoomState) st.jkt48RoomState = {};
        const jktLives = (allLives || []).filter(isJkt48Room);
        const liveKeySet = new Set(
          jktLives.map((l) => l.roomUrlKey || l.room_url_key).filter(Boolean),
        );

        // Tandai offline untuk yang tidak ada di onlives
        for (const key of Object.keys(st.jkt48RoomState)) {
          if (!liveKeySet.has(key)) {
            st.jkt48RoomState[key] = {
              wasLive: false,
              lastNotifiedAt: st.jkt48RoomState[key]?.lastNotifiedAt || 0,
            };
          }
        }

        for (const live of jktLives) {
          const key = live.roomUrlKey || live.room_url_key;
          if (!key) continue;

          const prev = st.jkt48RoomState[key] || {
            wasLive: false,
            lastNotifiedAt: 0,
          };
          const wasLive = !!prev.wasLive;

          // HANYA notif transisi offline → online
          if (!wasLive) {
            const status = {
              roomUrlKey: key,
              roomName: live.roomName || live.room_name || key,
              isLive: true,
              viewers: live.viewers ?? live.view_num,
              startedText: live.startedText,
              image: live.image || live.image_m || live.image_l,
              url: live.url || `https://www.showroom-live.com/r/${key}`,
            };
            for (const chat of jktChats) {
              await sendLiveNotif(sock, chat, status);
            }
            st.jkt48RoomState[key] = {
              wasLive: true,
              lastNotifiedAt: Date.now(),
            };
          } else {
            // tetap live — jangan notif lagi
            st.jkt48RoomState[key] = {
              wasLive: true,
              lastNotifiedAt: prev.lastNotifiedAt || Date.now(),
            };
          }
        }
      }

      saveState(st);
    } catch (e) {
      console.error("[showroom-watch] tick", e.message);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  setTimeout(tick, 5_000);
  console.log(
    `[showroom-watch] started · interval ${Math.round(intervalMs / 60000)}m · notif only on live start`,
  );
  return timer;
}

function ensureShowroomWatcher(sock, opts = {}) {
  return startShowroomWatcher(sock, opts);
}

function stopShowroomWatcher() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}



/* ===================== PLUGIN ===================== */
/**
 * Zhuxin MD — Showroom Live cek + notif
 * - Fix double reply (return setelah subcommand)
 * - Mode JKT48 auto: notif semua member tanpa add satu-satu
 */
async function handler(m, { sock, text }) {
  const raw = (text || m.args?.join(" ") || "").trim();
  const args = raw.split(/\s+/).filter(Boolean);
  const sub = (args[0] || "").toLowerCase();
  const chat = m.chat;

  try {
    startShowroomWatcher(sock);
  } catch {}

  if (!raw || sub === "help") {
    return m.reply(
      `🔴 *SHOWROOM LIVE*\n\n` +
        `*Cek status*\n` +
        `\`${m.prefix}showroom <room_key|url>\`\n` +
        `Contoh: \`${m.prefix}showroom JKT48_Nayla\`\n\n` +
        `*Yang lagi live*\n` +
        `\`${m.prefix}showroom live\`\n` +
        `\`${m.prefix}showroom live jkt48\`\n\n` +
        `*Watch per room*\n` +
        `\`${m.prefix}showroom add <room_key>\`\n` +
        `\`${m.prefix}showroom del <room_key>\`\n` +
        `\`${m.prefix}showroom list\`\n\n` +
        `*Semua JKT48 (tanpa add satu-satu)*\n` +
        `\`${m.prefix}showroom jkt48 on\` — nyalakan notif semua JKT48\n` +
        `\`${m.prefix}showroom jkt48 off\` — matikan\n` +
        `\`${m.prefix}showroom jkt48\` — status mode\n\n` +
        `_Watcher auto saat bot online · cek ~2 menit · notif saat baru live_`,
    );
  }

  // —— JKT48 auto mode ——
  if (sub === "jkt48" || sub === "jkt" || sub === "alljkt") {
    const act = (args[1] || "status").toLowerCase();
    if (act === "on" || act === "enable" || act === "nyala") {
      enableJkt48Watch(chat);
      startShowroomWatcher(sock);
      return m.reply(
        `✅ *Mode JKT48 AUTO aktif* di chat ini.\n\n` +
          `Semua member JKT48 yang *baru live* akan dinotif otomatis.\n` +
          `Tidak perlu \`${m.prefix}showroom add\` satu-satu.\n\n` +
          `Matikan: \`${m.prefix}showroom jkt48 off\``,
      );
    }
    if (act === "off" || act === "disable" || act === "mati") {
      disableJkt48Watch(chat);
      return m.reply(`✅ Mode JKT48 AUTO *dimatikan* di chat ini.`);
    }
    const on = isJkt48Watch(chat);
    return m.reply(
      `📋 *Mode JKT48 AUTO:* ${on ? "🟢 ON" : "⚫ OFF"}\n\n` +
        (on
          ? `Notif semua live JKT48 aktif di chat ini.`
          : `Nyalakan: \`${m.prefix}showroom jkt48 on\``),
    );
  }

  if (sub === "list" || sub === "watchlist") {
    const list = listWatch(chat);
    const jkt = isJkt48Watch(chat);

    // Mode JKT48 ON → tampilkan member JKT48 yang sedang LIVE
    let jktLines = [];
    if (jkt) {
      await m.react("🔍").catch(() => {});
      try {
        const lives = await searchOnlives("jkt48");
        const jktLives = (lives || [])
          .filter((l) => {
            const key = String(l.roomUrlKey || "");
            const name = String(l.roomName || "");
            return /^JKT48[_-]/i.test(key) || /JKT48/i.test(name);
          })
          .sort((a, b) => (b.viewers || 0) - (a.viewers || 0));

        if (jktLives.length) {
          jktLines = jktLives.map(
            (l, i) =>
              `*${i + 1}. ${l.roomName || l.roomUrlKey}*\n` +
              `   🔴 LIVE · 👥 ${Number(l.viewers || 0).toLocaleString("id-ID")}\n` +
              `   Key: \`${l.roomUrlKey}\`\n` +
              `   ${l.url || roomUrl(l.roomUrlKey)}`,
          );
        }
      } catch (e) {
        jktLines = [`_Gagal ambil data live: ${e.message}_`];
      }
    }

    if (!list.length && !jkt) {
      return m.reply(
        `📋 *Watchlist kosong*\n\n` +
          `Tambah room: \`${m.prefix}showroom add JKT48_Nayla\`\n` +
          `Atau semua JKT48: \`${m.prefix}showroom jkt48 on\``,
      );
    }

    const manualLines = list.map(
      (r, i) =>
        `*${i + 1}. ${r.name || r.key}*\n` +
        `   Key: \`${r.key}\`\n` +
        `   Status: ${r.wasLive ? "🔴 LIVE" : "⚫ Offline"}`,
    );

    let out = `📋 *SHOWROOM WATCHLIST*\n\n`;
    if (jkt) {
      out += `🌐 *JKT48 AUTO:* 🟢 ON\n`;
      out += jktLines.length
        ? `🔴 *JKT48 sedang live (${jktLines.length})*\n\n${jktLines.join("\n\n")}\n\n`
        : `⚫ Tidak ada member JKT48 yang live saat ini.\n\n`;
    }
    if (manualLines.length) {
      out += `📌 *Room manual*\n\n${manualLines.join("\n\n")}`;
    }

    await m.react("✅").catch(() => {});
    return m.reply(out.trim());
  }

  if (sub === "add" || sub === "watch") {
    const keyIn = args.slice(1).join(" ");
    const key = parseRoomKey(keyIn);
    if (!key) {
      return m.reply(
        `❌ Masukkan room key / URL.\nContoh: \`${m.prefix}showroom add JKT48_Nayla\``,
      );
    }
    await m.react("🔍").catch(() => {});
    let name = key;
    try {
      const st = await getRoomStatus(key);
      name = st.roomName || key;
    } catch {}
    addWatch(chat, key, name);
    startShowroomWatcher(sock);

    let liveNow = null;
    try {
      liveNow = await getRoomStatus(key);
      if (liveNow?.roomName) name = liveNow.roomName;
    } catch {}

    await m.react("✅").catch(() => {});
    await m.reply(
      `✅ *Ditambahkan ke watchlist*\n\n` +
        `• Room: *${name}*\n` +
        `• Key: \`${key}\`\n` +
        `• Link: ${roomUrl(key)}\n\n` +
        `Notif otomatis ke chat ini saat live.` +
        (liveNow?.isLive ? `\n\n🔴 *Saat ini sedang LIVE!*` : "") +
        `\n\n_Tips: \`${m.prefix}showroom jkt48 on\` untuk semua JKT48_`,
    );

    if (liveNow?.isLive) {
      const caption = buildLiveCaption({
        ...liveNow,
        roomName: liveNow.roomName || name,
      });
      try {
        if (liveNow.image) {
          await sock.sendMessage(chat, {
            image: { url: liveNow.image },
            caption,
          });
        } else {
          await sock.sendMessage(chat, { text: caption });
        }
      } catch (e) {
        console.error("[showroom] send live-now", e.message);
      }
    }
    return; // PENTING: jangan jatuh ke parseRoomKey(raw)
  }

  if (sub === "del" || sub === "remove" || sub === "hapus") {
    const key = parseRoomKey(args.slice(1).join(" "));
    if (!key) {
      return m.reply(`❌ Contoh: \`${m.prefix}showroom del JKT48_Nayla\``);
    }
    const ok = removeWatch(chat, key);
    return m.reply(
      ok
        ? `✅ Dihapus dari watchlist: \`${key}\``
        : `❌ \`${key}\` tidak ada di watchlist chat ini.`,
    );
  }

  if (sub === "live" || sub === "onlive" || sub === "search") {
    const q = args.slice(1).join(" ");
    await m.react("🔍").catch(() => {});
    try {
      const lives = await searchOnlives(q);
      if (!lives.length) {
        await m.react("❌").catch(() => {});
        return m.reply(
          q
            ? `❌ Tidak ada yang live cocok *${q}*`
            : `❌ Tidak ada data live saat ini.`,
        );
      }
      const top = lives
        .sort((a, b) => (b.viewers || 0) - (a.viewers || 0))
        .slice(0, 12);
      const body = top
        .map(
          (l, i) =>
            `*${i + 1}. ${l.roomName || l.roomUrlKey}*\n` +
            `   👥 ${Number(l.viewers || 0).toLocaleString("id-ID")}` +
            (l.genreName ? ` · ${l.genreName}` : "") +
            `\n   \`${l.roomUrlKey}\`\n` +
            `   ${l.url}`,
        )
        .join("\n\n");
      await m.react("✅").catch(() => {});
      return m.reply(
        `🔴 *SHOWROOM ON LIVE*` +
          (q ? ` — _${q}_` : "") +
          `\n\n${body}\n\n` +
          `Notif semua JKT48: \`${m.prefix}showroom jkt48 on\``,
      );
    } catch (e) {
      await m.react("❌").catch(() => {});
      return m.reply(`❌ Gagal ambil onlive: ${e.message}`);
    }
  }

  // cek satu room
  const key = parseRoomKey(raw);
  if (!key) {
    return m.reply(
      `❌ Room key / URL tidak valid.\n\`${m.prefix}showroom help\``,
    );
  }

  await m.react("🔍").catch(() => {});
  try {
    const info = await getRoomStatus(key);
    const caption = info.isLive
      ? buildLiveCaption(info)
      : `⚫ *OFFLINE*\n\n` +
        `*${info.roomName}*\n` +
        `Key: \`${info.roomUrlKey}\`\n` +
        (info.follower != null
          ? `Followers: *${Number(info.follower).toLocaleString("id-ID")}*\n`
          : "") +
        `\n🔗 ${info.url}\n\n` +
        `Pantau:\n\`${m.prefix}showroom add ${info.roomUrlKey}\`\n` +
        `Semua JKT48: \`${m.prefix}showroom jkt48 on\``;

    if (info.image) {
      try {
        await sock.sendMessage(
          chat,
          { image: { url: info.image }, caption },
          { quoted: m },
        );
      } catch {
        await m.reply(caption);
      }
    } else {
      await m.reply(caption);
    }
    await m.react(info.isLive ? "🔴" : "✅").catch(() => {});
  } catch (e) {
    console.error("[showroom]", e);
    await m.react("❌").catch(() => {});
    return m.reply(`❌ Gagal cek room: ${e.message}`);
  }
}

handler.command = ["showroom", "srlive", "showroomlive", "srnotif"];
handler.category = "info";
handler.description = "Cek & notif Showroom Live (+ mode semua JKT48)";
handler.usage = ".showroom <key|jkt48 on|add|del|list|live>";
handler.example = ".showroom jkt48 on";
handler.owner = false;
handler.premium = false;
handler.group = false;
handler.private = false;
handler.cooldown = 5;
handler.limit = 0;

export default handler;



// export untuk connection.js / luar
export {
  parseRoomKey,
  roomUrl,
  getRoomStatus,
  getOnlives,
  searchOnlives,
  addWatch,
  removeWatch,
  listWatch,
  buildLiveCaption,
  startShowroomWatcher,
  stopShowroomWatcher,
  enableJkt48Watch,
  disableJkt48Watch,
  isJkt48Watch,
};
