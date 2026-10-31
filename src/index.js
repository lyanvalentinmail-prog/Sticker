import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import WebP from 'node-webpmux';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const execFileAsync = promisify(execFile);
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const TENOR_KEY = process.env.TENOR_API_KEY;
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const packSessions = new Map();
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const help = `*Sticker Bot — comandos*
.pack nombre.autor  Inicia un paquete
.pack add            Activa la captura de imágenes
.pack done           Envía los stickers reunidos
.pack cancel         Cancela el paquete
.sticker             Responde a una imagen o sticker para convertirlo
.toimg               Responde a un sticker para convertirlo a imagen
.tovid               Responde a un sticker animado para convertirlo a video
.ssearch texto       Busca stickers en Tenor
.spack texto         Busca stickers y envía hasta 8 como paquete
.help                Muestra esta ayuda

En un paquete, activa primero .pack add y luego envía las imágenes. También puedes responder a una imagen con .pack add.`;

const getMessageText = (message) => {
  const m = message.message;
  return m?.conversation || m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption || m?.videoMessage?.caption || '';
};
const getContent = (message) => {
  const m = message.message;
  const type = Object.keys(m || {}).find((key) => ['imageMessage', 'stickerMessage', 'videoMessage'].includes(key));
  return type ? { type, content: m[type] } : null;
};
const getQuotedMessage = (message) => message.message?.extendedTextMessage?.contextInfo?.quotedMessage;

async function mediaFrom(message, quoted = false) {
  let target = message;
  if (quoted) {
    const quotedMessage = getQuotedMessage(message);
    if (!quotedMessage) return null;
    const context = message.message?.extendedTextMessage?.contextInfo;
    target = {
      key: {
        remoteJid: message.key.remoteJid,
        id: context?.stanzaId,
        participant: context?.participant,
        fromMe: false,
      },
      message: quotedMessage,
    };
  }
  const media = getContent(target);
  if (!media || !['imageMessage', 'stickerMessage', 'videoMessage'].includes(media.type)) return null;
  const buffer = await downloadMediaMessage(target, 'buffer', {}, {
    logger,
    reuploadRequest: async () => undefined,
  });
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FILE_BYTES) throw new Error('El archivo es demasiado grande (máximo 20 MB).');
  return { ...media, buffer };
}

async function ffmpegConvert(buffer, outputName, makeArgs) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'wa-sticker-'));
  try {
    const input = path.join(workDir, 'input');
    const output = path.join(workDir, outputName);
    await writeFile(input, buffer);
    await execFileAsync('ffmpeg', makeArgs(input, output), { timeout: 60000 });
    return await readFile(output);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function toSticker(buffer) {
  for (const quality of [75, 60, 45, 30, 20]) {
    const sticker = await ffmpegConvert(buffer, 'sticker.webp', (input, output) => [
      '-y', '-i', input, '-frames:v', '1',
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-c:v', 'libwebp', '-quality', String(quality), '-preset', 'picture', output,
    ]);
    if (sticker.length <= 98 * 1024) return sticker;
  }
  throw new Error('La imagen no se pudo comprimir por debajo de 100 KB. Prueba con otra imagen.');
}

async function getIncomingMedia(message) {
  try { return await mediaFrom(message); } catch (error) {
    console.error('No se pudo descargar el medio:', error.message);
    return null;
  }
}

async function addPackMetadata(buffer, pack, author, packId = randomUUID()) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': packId,
    'sticker-pack-name': String(pack).slice(0, 64),
    'sticker-pack-publisher': String(author).slice(0, 64),
    emojis: [],
  }));
  const exif = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  exif.writeUIntLE(json.length, 14, 4);
  const image = new WebP.Image();
  await image.load(buffer);
  image.exif = Buffer.concat([exif, json]);
  return image.save(null);
}

async function sendSticker(sock, jid, buffer, pack = {}) {
  const sticker = await addPackMetadata(
    buffer,
    pack.name || 'Mis stickers',
    pack.author || 'Sticker Bot',
    pack.id,
  );
  await sock.sendMessage(jid, { sticker });
}

async function tenorSearch(query, limit = 8) {
  if (!TENOR_KEY) throw new Error('La búsqueda necesita TENOR_API_KEY. Configúrala siguiendo el README.');
  const url = new URL('https://tenor.googleapis.com/v2/search');
  url.searchParams.set('q', query);
  url.searchParams.set('key', TENOR_KEY);
  url.searchParams.set('client_key', 'termux_sticker_bot');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('media_filter', 'tinywebp,webp');
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Tenor respondió ${response.status}.`);
  const data = await response.json();
  return (data.results || []).map((result) => {
    const formats = result.media_formats || {};
    const media = formats.tinywebp || formats.webp;
    return media?.url ? { url: media.url, description: result.content_description || query } : null;
  }).filter(Boolean);
}

async function downloadWebp(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('No pude descargar uno de los stickers.');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_FILE_BYTES) throw new Error('El sticker encontrado excede el límite permitido.');
  return data;
}

async function reply(sock, jid, text, quoted) {
  await sock.sendMessage(jid, { text }, { quoted });
}

async function handleCommand(sock, message, command, args, key, jid) {
  const session = packSessions.get(key);

  if (command === '.help' || command === '.menu') return reply(sock, jid, help, message);

  if (command === '.pack') {
    const action = args[0]?.toLowerCase();
    if (action === 'add') {
      if (!session) return reply(sock, jid, 'Primero crea un paquete: .pack nombre.autor', message);
      session.capturing = true;
      const quoted = await getIncomingMediaFromQuote(message);
      if (quoted) {
        session.items.push(quoted.buffer);
        return reply(sock, jid, `Sticker agregado (${session.items.length}). Envía más imágenes o usa .pack done.`, message);
      }
      return reply(sock, jid, 'Modo de captura activado. Ahora envía las imágenes que quieras agregar; termina con .pack done.', message);
    }
    if (action === 'done') {
      if (!session) return reply(sock, jid, 'No tienes un paquete en curso.', message);
      if (!session.items.length) return reply(sock, jid, 'El paquete está vacío. Envía imágenes después de .pack add.', message);
      packSessions.delete(key);
      await reply(sock, jid, `Enviando *${session.name}* — ${session.author} (${session.items.length} stickers)…`, message);
      let sent = 0;
      for (const item of session.items) {
        try {
          await sendSticker(sock, jid, await toSticker(item), {
            id: session.id,
            name: session.name,
            author: session.author,
          });
          sent += 1;
        } catch (error) { console.error('Error preparando sticker:', error.message); }
      }
      if (sent < session.items.length) {
        await reply(sock, jid, `Se enviaron ${sent} de ${session.items.length}. Verifica que ffmpeg esté instalado y que las imágenes sean válidas.`, message);
      }
      return;
    }
    if (action === 'cancel') {
      if (!session) return reply(sock, jid, 'No tienes un paquete en curso.', message);
      packSessions.delete(key);
      return reply(sock, jid, 'Paquete cancelado.', message);
    }
    const label = args.join(' ').trim();
    const splitAt = label.lastIndexOf('.');
    if (!label || splitAt < 1 || splitAt === label.length - 1) {
      return reply(sock, jid, 'Formato: .pack nombre.autor (usa un punto para separar el nombre del autor).', message);
    }
    const name = label.slice(0, splitAt).trim();
    const author = label.slice(splitAt + 1).trim();
    packSessions.set(key, { id: randomUUID(), name, author, items: [], capturing: false });
    return reply(sock, jid, `Paquete *${name}* de *${author}* creado. Usa .pack add y envía tus imágenes.`, message);
  }

  if (command === '.sticker') {
    if (args.length) {
      const results = await tenorSearch(args.join(' '), 1);
      if (!results.length) return reply(sock, jid, 'No encontré stickers con esa búsqueda.', message);
      return sendSticker(sock, jid, await toSticker(await downloadWebp(results[0].url)));
    }
    const media = await getIncomingMedia(message) || await getIncomingMediaFromQuote(message);
    if (!media) return reply(sock, jid, 'Envía una imagen con .sticker en el texto o responde a una imagen con .sticker.', message);
    return sendSticker(sock, jid, await toSticker(media.buffer));
  }

  if (command === '.toimg') {
    const media = await getIncomingMedia(message) || await getIncomingMediaFromQuote(message);
    if (!media || media.type !== 'stickerMessage') return reply(sock, jid, 'Responde a un sticker con .toimg.', message);
    try {
      const png = await ffmpegConvert(media.buffer, 'image.png', (input, output) => [
        '-y', '-i', input, '-frames:v', '1', output,
      ]);
      return sock.sendMessage(jid, { image: png, caption: 'Sticker convertido a imagen.' }, { quoted: message });
    } catch (error) {
      if (error.code === 'ENOENT') return reply(sock, jid, 'No encuentro ffmpeg. Instálalo en Termux con: pkg install ffmpeg', message);
      throw error;
    }
  }

  if (command === '.tovid') {
    const media = await getIncomingMedia(message) || await getIncomingMediaFromQuote(message);
    if (!media || media.type !== 'stickerMessage') return reply(sock, jid, 'Responde a un sticker animado con .tovid.', message);
    try {
      const video = await ffmpegConvert(media.buffer, 'output.mp4', (input, output) => [
        '-y', '-i', input,
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white,fps=15',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output,
      ]);
      await sock.sendMessage(jid, { video, mimetype: 'video/mp4', caption: 'Sticker animado convertido a video.', gifPlayback: true }, { quoted: message });
    } catch (error) {
      if (error.code === 'ENOENT') return reply(sock, jid, 'No encuentro ffmpeg. Instálalo en Termux con: pkg install ffmpeg', message);
      return reply(sock, jid, 'No pude convertirlo. .tovid funciona con stickers animados; verifica que ffmpeg esté instalado.');
    }
    return;
  }

  if (command === '.ssearch' || command === '.spack') {
    if (!args.length) return reply(sock, jid, `Uso: ${command} texto de búsqueda`, message);
    const results = await tenorSearch(args.join(' '), command === '.spack' ? 8 : 1);
    if (!results.length) return reply(sock, jid, 'No encontré resultados. Prueba con otras palabras.', message);
    if (command === '.ssearch') return sendSticker(sock, jid, await toSticker(await downloadWebp(results[0].url)));
    await reply(sock, jid, `Encontré ${results.length} stickers para *${args.join(' ')}*. Enviando…`, message);
    const resultPack = { id: randomUUID(), name: args.join(' '), author: 'Tenor' };
    for (const result of results) {
      try {
        await sendSticker(sock, jid, await toSticker(await downloadWebp(result.url)), resultPack);
      } catch (error) { console.error('No se pudo enviar resultado:', error.message); }
    }
  }
}

async function getIncomingMediaFromQuote(message) {
  try { return await mediaFrom(message, true); } catch (error) {
    console.error('No se pudo descargar el medio citado:', error.message);
    return null;
  }
}

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '').replace(/^0+/, '');
}

async function chooseLinkingMethod(isRegistered) {
  if (isRegistered) return { method: 'saved-session' };

  const envNumber = normalizePhoneNumber(process.env.PAIRING_NUMBER);
  if (envNumber) {
    if (!/^[1-9]\d{7,14}$/.test(envNumber)) {
      throw new Error('PAIRING_NUMBER debe incluir código de país y tener entre 8 y 15 dígitos.');
    }
    return { method: 'pairing-code', phoneNumber: envNumber };
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    console.log('No hay terminal interactiva; se usará QR. Para pairing code ejecuta PAIRING_NUMBER=598XXXXXXXX npm start.');
    return { method: 'qr' };
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      console.log('\n¿Cómo quieres vincular WhatsApp?');
      console.log('  qr   — vincular escaneando un código QR');
      console.log('  code — vincular con un código de 8 caracteres');
      const choice = (await prompt.question('Escribe qr o code: ')).trim().toLowerCase();
      if (choice === 'qr' || choice === '1') return { method: 'qr' };
      if (choice === 'code' || choice === '2') {
        while (true) {
          const rawNumber = await prompt.question('Número con código de país (solo dígitos, ej. 59899123456): ');
          const phoneNumber = normalizePhoneNumber(rawNumber);
          if (/^[1-9]\d{7,14}$/.test(phoneNumber)) return { method: 'pairing-code', phoneNumber };
          console.log('Número no válido. Usa de 8 a 15 dígitos e incluye el código de país (por ejemplo 598); si escribes 00 al inicio, se quitará automáticamente.');
        }
      }
      console.log('Opción no válida; escribe qr o code.');
    }
  } finally {
    prompt.close();
  }
}

async function main(linkingOverride, versionOverride) {
  await mkdir(AUTH_DIR, { recursive: true });
  let auth = await useMultiFileAuthState(AUTH_DIR);
  const authFiles = await readdir(AUTH_DIR);
  if (!auth.state.creds.registered && authFiles.length > 0) {
    // Remove partial pairing keys/creds left by a failed or interrupted, unregistered link attempt.
    await rm(AUTH_DIR, { recursive: true, force: true });
    await mkdir(AUTH_DIR, { recursive: true });
    auth = await useMultiFileAuthState(AUTH_DIR);
    console.log(`Se detectó una sesión incompleta en ${AUTH_DIR}; se limpió automáticamente porque WhatsApp aún no está vinculado.`);
  }
  const { state, saveCreds } = auth;
  const linking = linkingOverride || await chooseLinkingMethod(state.creds.registered);
  let webVersion = versionOverride;
  if (!webVersion) {
    try {
      const latest = await fetchLatestBaileysVersion();
      webVersion = latest.version;
      console.log(`Baileys usará WhatsApp Web ${webVersion.join('.')}.`);
    } catch (error) {
      console.warn(`No pude consultar la versión actual de WhatsApp Web (${error.message}); usaré la versión incluida en Baileys.`);
    }
  }
  const sock = makeWASocket({
    ...(webVersion ? { version: webVersion } : {}),
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);
  let pairingCodeRequested = false;
  let connectionClosed = false;
  const requestPairingCode = async () => {
    if (pairingCodeRequested || linking.method !== 'pairing-code' || state.creds.registered) return;
    pairingCodeRequested = true;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (connectionClosed) return;
      try {
        if (!sock.ws?.isOpen) await sock.waitForSocketOpen();
        if (!sock.ws?.isOpen) throw new Error('El WebSocket todavía no está abierto.');
        const code = await sock.requestPairingCode(linking.phoneNumber);
        if (!/^[A-Z0-9]{8}$/.test(code)) {
          throw new Error(`Baileys devolvió un código inesperado (${String(code)}).`);
        }
        const formattedCode = `${code.slice(0, 4)}-${code.slice(4)}`;
        console.log(`\nTu pairing code es: ${formattedCode}\nEn WhatsApp: Dispositivos vinculados > Vincular dispositivo > Vincular con número de teléfono. Escríbelo enseguida tal como aparece.`);
        return;
      } catch (error) {
        if (connectionClosed) return;
        if (attempt === 5) {
          console.error(`No se pudo generar el pairing code: ${error.message}`);
          console.error('Comprueba el número con código de país y la conexión. Cierra y vuelve a ejecutar npm start para intentarlo otra vez.');
        } else {
          console.log(`Falló el intento ${attempt}/5; volveré a pedir el código cuando se recupere la conexión.`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  };
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && linking.method === 'qr') {
      console.log('\nEscanea el QR con WhatsApp > Dispositivos vinculados > Vincular dispositivo.');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('WhatsApp conectado. Envía .help para ver los comandos.');
    if (connection === 'close') {
      connectionClosed = true;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log(`WhatsApp indica que esta sesión ya no está vinculada. Eliminando credenciales de ${AUTH_DIR} y reiniciando el vínculo…`);
        void (async () => {
          await rm(AUTH_DIR, { recursive: true, force: true });
          await mkdir(AUTH_DIR, { recursive: true });
          await main();
        })().catch(console.error);
      } else {
        main(linking, webVersion).catch(console.error);
      }
    }
  });
  // Baileys recommends requesting the code immediately after creating the socket.
  if (linking.method === 'pairing-code' && !state.creds.registered) {
    void requestPairingCode();
  }
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      if (!message.message || message.key.fromMe || message.key.remoteJid === 'status@broadcast') continue;
      const jid = message.key.remoteJid;
      const sender = message.key.participant || jid;
      const key = `${jid}:${sender}`;
      const text = getMessageText(message).trim();
      const match = text.match(/^\.(pack|sticker|toimg|tovid|ssearch|spack|help|menu)\b\s*(.*)$/is);
      const session = packSessions.get(key);

      try {
        if (match) {
          await handleCommand(sock, message, `.${match[1].toLowerCase()}`, match[2].trim().split(/\s+/).filter(Boolean), key, jid);
          continue;
        }
        if (session?.capturing) {
          const media = await getIncomingMedia(message);
          if (media && ['imageMessage', 'stickerMessage'].includes(media.type)) {
            session.items.push(media.buffer);
            await reply(sock, jid, `Sticker agregado al paquete *${session.name}* (${session.items.length}).`, message);
          }
        }
      } catch (error) {
        console.error('Error procesando mensaje:', error);
        await reply(sock, jid, `No pude completar el comando: ${error.message || 'error inesperado'}`, message);
      }
    }
  });
  process.once('SIGINT', () => { console.log('Cerrando bot…'); process.exit(0); });
}

main().catch((error) => { console.error('No se pudo iniciar el bot:', error); process.exit(1); });
