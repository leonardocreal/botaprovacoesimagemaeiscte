import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';

// Node 20+ has global fetch / FormData / Blob (undici)
const app = express();
app.use(express.json({ limit: '8mb' }));

// ======= CONFIG =======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WABA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROUP_JID = process.env.GROUP_JID || ""; // e.g., 1203630xxxxxxxx@g.us

const APPROVERS = new Set((process.env.APPROVER_NUMBERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
);
const REQUIRED_HEARTS = Number(process.env.REQUIRED_HEARTS || 4);

// ======= DB =======
const db = new Database('./data.db');
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  message_id   TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  submitter    TEXT,
  submitter_name TEXT,
  group_jid    TEXT,
  event_name   TEXT,
  asset_type   TEXT,
  content_kind TEXT NOT NULL,  -- image | video | document | link
  link_url     TEXT,
  status       TEXT NOT NULL DEFAULT 'PENDING'
);
CREATE TABLE IF NOT EXISTS votes (
  message_id TEXT NOT NULL,
  approver   TEXT NOT NULL,
  UNIQUE(message_id, approver)
);
CREATE TABLE IF NOT EXISTS sessions (
  user           TEXT PRIMARY KEY,
  step           TEXT NOT NULL,
  content_kind   TEXT,     -- image | video | document | link
  media_id       TEXT,     -- for image/video/document
  media_mime     TEXT,
  link_url       TEXT,     -- for link
  event_name     TEXT,
  asset_type     TEXT
);
`);

const sql = {
  insertItem: db.prepare(`INSERT OR IGNORE INTO items
    (message_id, code, submitter, submitter_name, group_jid, event_name, asset_type, content_kind, link_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getItem:    db.prepare(`SELECT * FROM items WHERE message_id = ?`),
  setStatus:  db.prepare(`UPDATE items SET status = ? WHERE message_id = ?`),
  addVote:    db.prepare(`INSERT OR IGNORE INTO votes (message_id, approver) VALUES (?, ?)`),
  delVote:    db.prepare(`DELETE FROM votes WHERE message_id = ? AND approver = ?`),
  countVotes: db.prepare(`SELECT COUNT(*) AS c FROM votes WHERE message_id = ?`),
  listVoters: db.prepare(`SELECT approver FROM votes WHERE message_id = ?`),

  upsertSession: db.prepare(`
    INSERT INTO sessions (user, step, content_kind, media_id, media_mime, link_url, event_name, asset_type)
    VALUES (@user, @step, @content_kind, @media_id, @media_mime, @link_url, @event_name, @asset_type)
    ON CONFLICT(user) DO UPDATE SET
      step=excluded.step,
      content_kind=excluded.content_kind,
      media_id=excluded.media_id,
      media_mime=excluded.media_mime,
      link_url=excluded.link_url,
      event_name=excluded.event_name,
      asset_type=excluded.asset_type
  `),
  getSession: db.prepare(`SELECT * FROM sessions WHERE user = ?`),
  delSession: db.prepare(`DELETE FROM sessions WHERE user = ?`)
};

// ======= HELPERS =======
const g = (o, p, d=null) => p.split('.').reduce((r,k)=> (r && (k in r)) ? r[k] : d, o);

function stripAccents(s='') {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu,'');
}
function codeFromEvent(eventName) {
  const alpha = stripAccents(eventName).replace(/[^a-zA-Z]/g,'').toUpperCase();
  const prefix = (alpha.slice(0,3) || 'IMG').padEnd(3,'X');
  const num = Math.floor(1000 + Math.random()*9000);
  return `#${prefix}-${num}`;
}
function isUrl(text='') {
  return /(https?:\/\/[^\s]+)/i.test(text);
}

async function sendTextDM(to, text) {
  return fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WABA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
}

async function sendGroupText(text) {
  return fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WABA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: GROUP_JID, type: 'text', text: { body: text } })
  }).then(r=>r.json());
}

async function sendGroupMedia(kind, media_id, caption, filename=null) {
  const payload = { messaging_product: 'whatsapp', to: GROUP_JID, type: kind };
  if (kind === 'image') payload.image = { id: media_id, caption };
  if (kind === 'video') payload.video = { id: media_id, caption };
  if (kind === 'document') payload.document = { id: media_id, caption, filename: filename || 'file' };
  return fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WABA_TOKEN}` },
    body: JSON.stringify(payload)
  }).then(r=>r.json());
}

async function fetchMediaMeta(media_id) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${media_id}`, {
    headers: { 'Authorization': `Bearer ${WABA_TOKEN}` }
  });
  return res.json(); // { url, mime_type, file_size, ... }
}

async function downloadBuffer(url) {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${WABA_TOKEN}` } });
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function uploadMedia(buffer, mime) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), 'upload');
  form.append('type', mime);
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WABA_TOKEN}` },
    body: form
  });
  const data = await res.json();
  return data.id;
}

function approvalsCaption({event_name, asset_type, submitter, code}) {
  return [
    `📝 Evento: ${event_name}`,
    `🖼️ Tipo: ${asset_type}`,
    `👤 Submissor: ${submitter}`,
    `🔎 Tracking: ${code}`,
    ``,
    `Reagem com ❤️ (precisamos de ${REQUIRED_HEARTS}/${APPROVERS.size}).`
  ].join('\n');
}

// ======= WEBHOOK VERIFY =======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ======= WEBHOOK EVENTS =======
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack fast

  try {
    const change = g(req, 'body.entry.0.changes.0.value');
    if (!change) return;

    // --- incoming messages ---
    for (const msg of change.messages ?? []) {
      const from = msg.from;
      const name = g(msg, 'profile.name', from);
      const isGroup = !!msg.group_id;
      const type = msg.type;

      // We only handle DM intake; ignore group messages for intake
      if (isGroup) continue;

      // START: user sends image/video/document OR link (text containing URL)
      const hasSession = !!sql.getSession.get(from);

      if (!hasSession) {
        if (type === 'image' || type === 'video' || type === 'document') {
          const media = msg[type];
          const media_id = media?.id;
          const mime = media?.mime_type || (type === 'document' ? 'application/octet-stream' : 'image/jpeg');
          sql.upsertSession.run({
            user: from, step: 'ASK_EVENT', content_kind: type,
            media_id, media_mime: mime, link_url: null, event_name: null, asset_type: null
          });
          await sendTextDM(from, 'Qual é o evento?');
          continue;
        }
        if (type === 'text' && isUrl(msg.text?.body || '')) {
          const url = (msg.text.body.match(/https?:\/\/\S+/i)||[])[0];
          sql.upsertSession.run({
            user: from, step: 'ASK_EVENT', content_kind: 'link',
            media_id: null, media_mime: null, link_url: url, event_name: null, asset_type: null
          });
          await sendTextDM(from, 'Qual é o evento?');
          continue;
        }
        if (type === 'text') {
          await sendTextDM(from, 'Envia uma imagem/vídeo/PDF ou um link para começar a aprovação.');
          continue;
        }
      }

      // CONTINUE: wizard steps
      const sess = sql.getSession.get(from);

      if (type === 'text') {
        const body = (msg.text?.body || '').trim();

        // Status command (works anytime)
        const m = body.match(/status\s+(#\w{3}-\d{3,5})/i);
        if (m) {
          const code = m[1].toUpperCase();
          const itemRow = db.prepare(`SELECT * FROM items WHERE code = ?`).get(code);
          if (!itemRow) {
            await sendTextDM(from, `Não encontro ${code}. Exemplo: status #PAR-1234`);
          } else {
            const c = sql.countVotes.get(itemRow.message_id).c;
            const voters = sql.listVoters.all(itemRow.message_id).map(v => v.approver);
            const remaining = [...APPROVERS].filter(n => !voters.includes(n));
            await sendTextDM(from,
              `${code}: ${c}/${APPROVERS.size} ❤️\n` +
              (c >= REQUIRED_HEARTS ? '✅ APROVADO' : '⏳ PENDENTE') + '\n' +
              `Aprovadores: ${voters.join(', ') || '—'}\n` +
              `Em falta: ${remaining.join(', ') || '—'}`
            );
          }
          continue;
        }

        if (sess && sess.step === 'ASK_EVENT') {
          sql.upsertSession.run({ ...sess, step: 'ASK_TYPE', event_name: body });
          await sendTextDM(from, 'Que tipo de imagem é? (ex.: Instagram Story, Feed, Poster A3)');
          continue;
        }

        if (sess && sess.step === 'ASK_TYPE') {
          const assetType = body;
          // finalize and post to group
          const event_name = sess.event_name;
          const code = codeFromEvent(event_name);
          const caption = approvalsCaption({ event_name, asset_type: assetType, submitter: name, code });

          if (!GROUP_JID) {
            await sendTextDM(from, '⚠️ O bot ainda não está configurado com GROUP_JID no .env. Pede ao admin para definir.');
            sql.delSession.run(from);
            continue;
          }

          let groupResponse;
          if (sess.content_kind === 'link') {
            groupResponse = await sendGroupText(`${caption}\n🔗 ${sess.link_url}`);
          } else {
            // 1) get real media url
            const meta = await fetchMediaMeta(sess.media_id);
            const buf = await downloadBuffer(meta.url);
            // 2) upload to get a new media id usable by the bot
            const uploaded_id = await uploadMedia(buf, sess.media_mime || meta.mime_type || 'application/octet-stream');
            // 3) send to group
            const kind = (sess.content_kind === 'document') ? 'document' :
                         (sess.content_kind === 'video') ? 'video' : 'image';
            const filename = (sess.content_kind === 'document') ? (meta.filename || 'file.pdf') : null;
            groupResponse = await sendGroupMedia(kind, uploaded_id, caption, filename);
          }

          const groupMessageId = g(groupResponse, 'messages.0.id');
          if (groupMessageId) {
            sql.insertItem.run(
              groupMessageId, code, from, name || from, GROUP_JID,
              event_name, assetType, sess.content_kind, sess.link_url || null
            );
          }
          await sendTextDM(from, `A tua submissão foi enviada para aprovação. O teu número de acompanhamento é ${code}.`);
          sql.delSession.run(from);
          continue;
        }
      }

      // Allow replacing media mid-session: if they send another media, restart at ASK_EVENT
      if (sess && (type === 'image' || type === 'video' || type === 'document')) {
        const media = msg[type];
        sql.upsertSession.run({
          user: from,
          step: 'ASK_EVENT',
          content_kind: type,
          media_id: media?.id,
          media_mime: media?.mime_type || (type === 'document' ? 'application/octet-stream' : 'image/jpeg'),
          link_url: null,
          event_name: null,
          asset_type: null
        });
        await sendTextDM(from, 'Imagem/Vídeo/Documento recebido. Qual é o evento?');
      }
      if (sess && type === 'text' && isUrl(msg.text?.body || '')) {
        const url = (msg.text.body.match(/https?:\/\/\S+/i)||[])[0];
        sql.upsertSession.run({
          user: from,
          step: 'ASK_EVENT',
          content_kind: 'link',
          media_id: null,
          media_mime: null,
          link_url: url,
          event_name: null,
          asset_type: null
        });
        await sendTextDM(from, 'Link recebido. Qual é o evento?');
      }
    }

    // --- reactions (group) ---
    for (const r of change.reactions ?? []) {
      const emoji = (r?.emoji || '').replace('\uFE0F','');
      const messageId = r?.message_id;
      const approver = r?.from;
      const action = r?.action || 'added';
      const groupId = r?.group_id;

      if (!messageId || !approver) continue;
      if (emoji !== '❤' && emoji !== '❤️') continue;
      if (!APPROVERS.has(approver)) continue;

      const item = sql.getItem.get(messageId);
      if (!item) continue;
      if (GROUP_JID && groupId && groupId !== item.group_jid) continue;

      if (action === 'removed') sql.delVote.run(messageId, approver);
      else sql.addVote.run(messageId, approver);

      const c = sql.countVotes.get(messageId).c;

      if (c >= REQUIRED_HEARTS && item.status !== 'APPROVED') {
        sql.setStatus.run('APPROVED', messageId);
        // post short confirmation in group
        await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${WABA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            context: { message_id: messageId },
            type: 'text',
            text: { body: `✅ Aprovado (${item.code}) — ${c}/${APPROVERS.size} ❤️` }
          })
        });
        if (item.submitter) {
          await sendTextDM(item.submitter, `A tua submissão ${item.code} foi aprovada ✅ (${c}/${APPROVERS.size} ❤️).`);
        }
      } else {
        // progress update in thread
        await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${WABA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            context: { message_id: messageId },
            type: 'text',
            text: { body: `${item.code}: ${c}/${APPROVERS.size} ❤️` }
          })
        });
      }
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));
