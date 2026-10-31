import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  extractMessageContent,
  fetchLatestBaileysVersion,
  getContentType,
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
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const execFileAsync = promisify(execFile);
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const TENOR_KEY = process.env.TENOR_API_KEY;
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const packSessions = new Map();
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PACK_ITEMS = 30;

// Reacciones del bot: primero "espera", luego "listo".
const REACTION_WAITING = '🕘';
const REACTION_DONE = '⭐️';

const help = `*Sticker Bot — comandos*
.pack nombre.autor  Inicia un paquete
.pack add            Activa la captura de imágenes y videos
.pack done           Envía los stickers reunidos
.pack cancel         Cancela el paquete
.sticker             Responde a una imagen, video o sticker para convertirlo
.sticker texto       Busca un sticker en Tenor y lo envía
.toimg               Responde a un sticker para convertirlo a imagen
.tovid               Responde a un sticker animado para convertirlo a video
.ssearch texto       Busca stickers en Tenor
.spack texto         Busca stickers y envía hasta 8 como paquete
.help / .menu        Muestra esta ayuda

En un paquete, activa primero .pack add y luego envía las imágenes. También puedes responder a una imagen con .pack add.

El bot reacciona 🕘 mientras procesa cada comando y ⭐️ cuando termina.`;

const MEDIA_TYPES = ['imageMessage', 'stickerMessage', 'videoMessage'];

const messageContent = (message) => extractMessageContent(message?.message) || {};

const getMessageText = (message) => {
  const content = messageContent(message);
  return content.conversation || content.extendedTextMessage?.text ||
    content.imageMessage?.caption || content.videoMessage?.caption ||
    content.documentMessage?.caption || '';
};

const getContent = (message) => {
  const content = messageContent(message);
  const type = getContentType(content);
  if (!MEDIA_TYPES.includes(type)) return null;
  return { type, content: content[type] };
};

const getContextInfo = (message) => {
  const content = messageContent(message);
  // `contextInfo` va al mismo nivel que el tipo de medio (imageMessage, videoMessage, ...),
  // no dentro de cada valor del contenido.
  return content?.contextInfo;
};

async function mediaFrom(message, quoted = false) {
  let target = message;
  if (quoted) {
    const context = getContextInfo(message);
    if (!context?.quotedMessage) return null;
    target = {
      key: {
        remoteJid: message.key.remoteJid,
        id: context.stanzaId,
        participant: context.participant,
        fromMe: false,
      },
      message: context.quotedMessage,
    };
  }
  const media = getContent(target);
  if (!media) return null;
  const buffer = await downloadMediaMessage(target, 'buffer', {}, {
    logger,
    reuploadRequest: async (quotedMessage) => quotedMessage,
  });
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_FILE_BYTES) {
    throw new Error('El archivo es demasiado grande (máximo 20 MB).');
  }
  return { ...media, buffer };
}

const ffmpegError = (error) => {
  if (error?.code === 'ENOENT') {
    return new Error('No encuentro ffmpeg. Instálalo en Termux con: pkg install ffmpeg');
  }
  const detail = String(error?.stderr || '').trim().split('\n').filter(Boolean).pop();
  return new Error(detail
    ? `ffmpeg no pudo procesar el archivo (${detail}).`
    : 'ffmpeg no pudo procesar el archivo. Verifica que el formato sea compatible.');
};

async function ffmpegConvert(buffer, outputName, makeArgs) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'wa-sticker-'));
  try {
    const input = path.join(workDir, 'input');
    const output = path.join(workDir, outputName);
    await writeFile(input, buffer);
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...makeArgs(input, output)], {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return await readFile(output);
  } catch (error) {
    throw ffmpegError(error);
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
  try {
    return await mediaFrom(message);
  } catch (error) {
    console.error('No se pudo descargar el medio:', error.message);
    return null;
  }
}

async function getIncomingMediaFromQuote(message) {
  try {
    return await mediaFrom(message, true);
  } catch (error) {
    console.error('No se pudo descargar el medio citado:', error.message);
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

async function react(sock, message, emoji) {
  if (!emoji || !message?.key?.remoteJid) return;
  try {
    await sock.sendMessage(message.key.remoteJid, { react: { text: emoji, key: message.key } });
  } catch (error) {
    console.error('No se pudo reaccionar al mensaje:', error.message);
  }
}

function addToPack(session, media) {
  if (session.items.length >= MAX_PACK_ITEMS) {
    return `El paquete ya tiene ${MAX_PACK_ITEMS} stickers. Usa .pack done para enviarlos.`;
  }
  session.items.push(media.buffer);
  return null;
}

async function handleCommand(sock, message, command, args, key, jid) {
  const session = packSessions.get(key);

  if (command === '.help' || command === '.menu') {
    await reply(sock, jid, help, message);
    return;
  }

  if (command === '.pack') {
    const action = (args[0] || '').toLowerCase();

    if (action === 'add') {
      if (!session) {
        await reply(sock, jid, 'Primero crea un paquete: .pack nombre.autor', message);
        return;
      }
      session.capturing = true;
      const quoted = await getIncomingMediaFromQuote(message);
      if (quoted) {
        const warning = addToPack(session, quoted);
        if (warning) {
          await reply(sock, jid, warning, message);
          return;
        }
        await reply(sock, jid, `Sticker agregado (${session.items.length}). Envía más imágenes o usa .pack done.`, message);
        return;
      }
      await reply(sock, jid, 'Modo de captura activado. Ahora envía las imágenes o videos que quieras agregar; termina con .pack done.', message);
      return;
    }

    if (action === 'done') {
      if (!session) {
        await reply(sock, jid, 'No tienes un paquete en curso.', message);
        return;
      }
      if (!session.items.length) {
        await reply(sock, jid, 'El paquete está vacío. Envía imágenes después de .pack add.', message);
        return;
      }
      packSessions.delete(key);
      await reply(sock, jid, `Enviando *${session.name}* — ${session.author} (${session.items.length} stickers)…`, message);
      let sent = 0;
      let firstError = null;
      for (const item of session.items) {
        try {
          await sendSticker(sock, jid, await toSticker(item), {
            id: session.id,
            name: session.name,
            author: session.author,
          });
          sent += 1;
        } catch (error) {
          firstError = firstError || error;
          console.error('Error preparando sticker:', error.message);
        }
      }
      if (sent === session.items.length) {
        await reply(sock, jid, `Paquete *${session.name}* enviado (${sent} ${sent === 1 ? 'sticker' : 'stickers'}).`, message);
      } else {
        await reply(sock, jid, `Se enviaron ${sent} de ${session.items.length}. ${firstError?.message || 'Revisa que las imágenes sean válidas.'}`, message);
      }
      return;
    }

    if (action === 'cancel') {
      if (!session) {
        await reply(sock, jid, 'No tienes un paquete en curso.', message);
        return;
      }
      packSessions.delete(key);
      await reply(sock, jid, 'Paquete cancelado.', message);
      return;
    }

    const label = args.join(' ').trim();
    const splitAt = label.lastIndexOf('.');
    if (!label || splitAt < 1 || splitAt === label.length - 1) {
      await reply(sock, jid, 'Formato: .pack nombre.autor (usa un punto para separar el nombre del autor).', message);
      return;
    }
    const name = label.slice(0, splitAt).trim();
    const author = label.slice(splitAt + 1).trim();
    packSessions.set(key, { id: randomUUID(), name, author, items: [], capturing: false });
    await reply(sock, jid, `Paquete *${name}* de *${author}* creado. Usa .pack add y envía tus imágenes.`, message);
    return;
  }

  if (command === '.sticker') {
    if (args.length) {
      const results = await tenorSearch(args.join(' '), 1);
      if (!results.length) {
        await reply(sock, jid, 'No encontré stickers con esa búsqueda.', message);
        return;
      }
      await sendSticker(sock, jid, await toSticker(await downloadWebp(results[0].url)));
      return;
    }
    const media = await getIncomingMedia(message) || await getIncomingMediaFromQuote(message);
    if (!media) {
      await reply(sock, jid, 'Envía una imagen con .sticker en el texto o responde a una imagen, video o sticker con .sticker.', message);
      return;
    }
    await sendSticker(sock, jid, await toSticker(media.buffer));
    return;
  }

  if (command === '.toimg') {
    const media = await getIncomingMedia(message) || await getIncomingMediaFromQuote(message);
    if (!media || media.type !== 'stickerMessage') {
      await reply(sock, jid, 'Responde a un sticker con .toimg.', message);
      return;
    }
    const png = await ffmpegConvert(media.buffer, 'image.png', (input, output) => [
      '-y', '-i', input, '-frames:v', '1', output,
    ]);
    await sock.sendMessage(jid, { image: png, caption: 'Sticker convertido a imagen.' }, { quoted: message });
    return;
  }

  if (command === '.tovid') {
    const media = await getIncomingMedia(message) || await getIncomingMediaFromQuote(message);
    if (!media || media.type !== 'stickerMessage') {
      await reply(sock, jid, 'Responde a un sticker animado con .tovid.', message);
      return;
    }
    const video = await ffmpegConvert(media.buffer, 'output.mp4', (input, output) => [
      '-y', '-i', input,
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white,fps=15',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', output,
    ]);
    await sock.sendMessage(jid, { video, mimetype: 'video/mp4', caption: 'Sticker animado convertido a video.', gifPlayback: true }, { quoted: message });
    return;
  }

  if (command === '.ssearch' || command === '.spack') {
    if (!args.length) {
      await reply(sock, jid, `Uso: ${command} texto de búsqueda`, message);
      return;
    }
    const query = args.join(' ');
    const results = await tenorSearch(query, command === '.spack' ? 8 : 1);
    if (!results.length) {
      await reply(sock, jid, 'No encontré resultados. Prueba con otras palabras.', message);
      return;
    }
    if (command === '.ssearch') {
      await sendSticker(sock, jid, await toSticker(await downloadWebp(results[0].url)));
      return;
    }
    await reply(sock, jid, `Encontré ${results.length} stickers para *${query}*. Enviando…`, message);
    const resultPack = { id: randomUUID(), name: query, author: 'Tenor' };
    let sent = 0;
    for (const result of results) {
      try {
        await sendSticker(sock, jid, await toSticker(await downloadWebp(result.url)), resultPack);
        sent += 1;
      } catch (error) {
        console.error('No se pudo enviar resultado:', error.message);
      }
    }
    if (!sent) {
      await reply(sock, jid, 'No pude enviar los stickers encontrados. Inténtalo de nuevo en un momento.', message);
    }
    return;
  }
}
function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '').replace(/^0+/, '');
}

const isValidPhoneNumber = (value) => /^[1-9]\d{7,14}$/.test(value);

// `registered` alone is not enough: linking through the pairing code sets it, but
// QR linking sometimes only stores the device identity (`me` + `account`).
const hasLinkedSession = (creds) => Boolean(
  creds?.registered || (creds?.me?.id && creds?.account?.details),
);

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function chooseLinkingMethod(alreadyLinked) {
  if (alreadyLinked) return { method: 'saved-session' };

  const envNumber = normalizePhoneNumber(process.env.PAIRING_NUMBER);
  if (envNumber) {
    if (!isValidPhoneNumber(envNumber)) {
      throw new Error('PAIRING_NUMBER debe incluir el código de país y tener entre 8 y 15 dígitos (solo números).');
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
          if (isValidPhoneNumber(phoneNumber)) return { method: 'pairing-code', phoneNumber };
          console.log('Número no válido. Usa de 8 a 15 dígitos e incluye el código de país (por ejemplo 598); si escribes 00 al inicio, se quitará automáticamente.');
        }
      }
      console.log('Opción no válida; escribe qr o code.');
    }
  } finally {
    prompt.close();
  }
}

async function fetchWebVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (!Array.isArray(version) || version.length !== 3) throw new Error('versión inválida');
    console.log(`Baileys usará WhatsApp Web ${version.join('.')}.`);
    return version;
  } catch (error) {
    console.warn(`No pude consultar la versión actual de WhatsApp Web (${error.message}); usaré la versión incluida en Baileys.`);
    return undefined;
  }
}

async function loadAuthState({ reset = false } = {}) {
  await mkdir(AUTH_DIR, { recursive: true });
  if (reset) {
    await rm(AUTH_DIR, { recursive: true, force: true });
    await mkdir(AUTH_DIR, { recursive: true });
  }
  const auth = await useMultiFileAuthState(AUTH_DIR);
  if (hasLinkedSession(auth.state.creds)) return auth;

  const files = await readdir(AUTH_DIR);
  if (!files.length) return auth;
  // Keys left behind by an interrupted pairing attempt make WhatsApp reject the
  // next link (the stored identity no longer matches what the server expects).
  await rm(AUTH_DIR, { recursive: true, force: true });
  await mkdir(AUTH_DIR, { recursive: true });
  console.log(`Se descartó una vinculación incompleta en ${AUTH_DIR}.`);
  return useMultiFileAuthState(AUTH_DIR);
}

function describeDisconnect(statusCode) {
  switch (statusCode) {
    case DisconnectReason.restartRequired:
      return 'WhatsApp pidió reiniciar la conexión';
    case DisconnectReason.connectionClosed:
      return 'la conexión se cerró';
    case 408:
      return 'la conexión expiró';
    case DisconnectReason.connectionReplaced:
      return 'la sesión se abrió en otro dispositivo';
    case DisconnectReason.loggedOut:
      return 'la sesión ya no está vinculada';
    case DisconnectReason.forbidden:
      return 'WhatsApp rechazó la conexión (403)';
    case DisconnectReason.unavailableService:
      return 'el servicio de WhatsApp no está disponible';
    default:
      return statusCode ? `código ${statusCode}` : 'motivo desconocido';
  }
}

const MAX_PAIRING_ATTEMPTS = Math.max(1, Number.parseInt(process.env.LINK_ATTEMPTS || '', 10) || 5);
const MAX_RECONNECT_FAILURES = 10;
// If WhatsApp never sends a QR while linking (it normally does right after the
// registration handshake), request the code anyway once the socket is settled.
const PAIRING_CODE_FALLBACK_MS = 20000;

function printPairingInstructions(code, attempt) {
  const attemptLabel = attempt > 1 ? ` (intento ${attempt}/${MAX_PAIRING_ATTEMPTS})` : '';
  console.log('');
  console.log('══════════════════════════════════');
  console.log(`  Pairing code${attemptLabel}: ${code}`);
  console.log('══════════════════════════════════');
  console.log('En WhatsApp: Dispositivos vinculados > Vincular dispositivo >');
  console.log('Vincular con número de teléfono, y escribe el código de 8 caracteres');
  console.log('(el guion es solo para leerlo). Introdúcelo enseguida: si expira,');
  console.log('se generará un código nuevo automáticamente.');
  console.log('');
}

async function main({ linking: initialLinking, version: versionOverride } = {}) {
  let auth = await loadAuthState();
  let linking = initialLinking || await chooseLinkingMethod(hasLinkedSession(auth.state.creds));
  const webVersion = versionOverride || await fetchWebVersion();

  let pairingAttempts = 0;
  let reconnectFailures = 0;
  let sessionResets = 0;

  const start = () => {
    const { state, saveCreds } = auth;
    const sock = makeWASocket({
      ...(webVersion ? { version: webVersion } : {}),
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Keep the socket (and therefore the pairing code) alive long enough to
      // type it instead of letting the QR refs expire after ~20 seconds.
      qrTimeout: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    let finished = false;
    let pairingAttempted = false;
    let fallbackTimer = null;

    const requestPairingCode = async () => {
      // Baileys can only send this IQ once the Noise handshake is complete, which
      // is signalled by the first `qr` update. Requesting it earlier makes
      // WhatsApp drop the connection (428/401) and no code ever shows up.
      if (finished || pairingAttempted) return;
      if (linking.method !== 'pairing-code' || hasLinkedSession(state.creds)) return;
      pairingAttempted = true;
      pairingAttempts += 1;
      if (pairingAttempts > MAX_PAIRING_ATTEMPTS) {
        console.error(`\nSe agotaron los ${MAX_PAIRING_ATTEMPTS} intentos de vinculación con código.`);
        console.error('Verifica que el número incluya el código de país correcto (ej. 59899123456)');
        console.error('y que la cuenta de WhatsApp esté activa y actualizada.');
        console.error('Puedes intentarlo otra vez con npm start o ampliar el límite con LINK_ATTEMPTS=10.');
        process.exit(1);
      }
      try {
        const code = String(await sock.requestPairingCode(linking.phoneNumber) || '');
        if (!/^[A-Z0-9]{8}$/.test(code)) {
          throw new Error(`Baileys devolvió un código inesperado (${code || 'vacío'}).`);
        }
        console.log(`\nPairing code solicitado para el número ${linking.phoneNumber}.`);
        printPairingInstructions(`${code.slice(0, 4)}-${code.slice(4)}`, pairingAttempts);
      } catch (error) {
        if (finished) return;
        console.error(`No se pudo generar el pairing code: ${error.message}`);
        console.error('Se reiniciará la conexión para volver a intentarlo.');
        void sock.end(error);
      }
    };

    if (linking.method === 'pairing-code' && !hasLinkedSession(state.creds)) {
      fallbackTimer = setTimeout(() => { void requestPairingCode(); }, PAIRING_CODE_FALLBACK_MS);
    }

    const handleClose = async (lastDisconnect, attemptedPairing) => {
      if (finished) return;
      finished = true;
      clearTimeout(fallbackTimer);

      const status = lastDisconnect?.error?.output?.statusCode;
      const reason = describeDisconnect(status);
      const stillLinked = hasLinkedSession(state.creds);
      await Promise.resolve(saveCreds()).catch(() => {});

      if (status === DisconnectReason.loggedOut || status === DisconnectReason.forbidden || status === 419) {
        sessionResets += 1;
        console.log(stillLinked
          ? `\nWhatsApp cerró la sesión (${reason}).`
          : `\nWhatsApp rechazó la vinculación (${reason}). Revisa que el número sea correcto.`);
        if (sessionResets > 3) {
          console.error('La sesión se rechazó varias veces seguidas. Revisa el número y la cuenta,');
          console.error(`o elimina ${AUTH_DIR} y vuelve a ejecutar npm start.`);
          process.exit(1);
        }
        console.log(`Se eliminarán las credenciales de ${AUTH_DIR} y se iniciará un vínculo nuevo.`);
        auth = await loadAuthState({ reset: true });
        if (linking.method === 'saved-session') {
          linking = await chooseLinkingMethod(false);
        }
        reconnectFailures = 0;
        console.log(linking.method === 'pairing-code'
          ? `Se pedirá un pairing code nuevo para ${linking.phoneNumber}.`
          : 'Se mostrará un QR nuevo.');
        start();
        return;
      }

      if (stillLinked) {
        reconnectFailures += 1;
        if (reconnectFailures > MAX_RECONNECT_FAILURES) {
          console.error(`\nNo se pudo mantener la conexión con WhatsApp (${reason}).`);
          console.error('Revisa tu conexión a internet y vuelve a ejecutar npm start.');
          process.exit(1);
        }
        const wait = Math.min(1000 * reconnectFailures, 10000);
        console.log(`Conexión cerrada (${reason}). Reconectando en ${Math.round(wait / 1000)} s…`);
        await delay(wait);
        start();
        return;
      }

      reconnectFailures += 1;
      if (reconnectFailures > MAX_RECONNECT_FAILURES) {
        console.error(`\nNo se pudo abrir la conexión con WhatsApp tras ${MAX_RECONNECT_FAILURES} intentos (${reason}).`);
        console.error('Revisa tu conexión a internet y vuelve a ejecutar npm start.');
        process.exit(1);
      }

      if (attemptedPairing) {
        console.log(`\nLa vinculación no se completó (${reason}).`);
        console.log('Se generará un pairing code nuevo en unos segundos…');
        await delay(1500);
        auth = await loadAuthState({ reset: true });
      } else {
        console.log(`Conexión cerrada (${reason}). Reintentando…`);
        await delay(Math.min(1000 * reconnectFailures, 5000));
      }
      start();
    };

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (hasLinkedSession(state.creds)) return;
        if (linking.method === 'pairing-code') {
          // The handshake is done at this point: safe to ask for the code.
          void requestPairingCode();
        } else if (linking.method === 'qr') {
          console.log('\nEscanea este QR con WhatsApp > Dispositivos vinculados > Vincular dispositivo.');
          qrcode.generate(qr, { small: true });
        }
      }

      if (connection === 'open') {
        reconnectFailures = 0;
        pairingAttempts = 0;
        sessionResets = 0;
        clearTimeout(fallbackTimer);
        console.log('WhatsApp conectado. Envía .help para ver los comandos.');
      }

      if (connection === 'close') {
        void handleClose(lastDisconnect, pairingAttempted);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !Array.isArray(messages)) return;

      for (const message of messages) {
        const jid = message?.key?.remoteJid;
        if (!message?.message || message.key?.fromMe || !jid || jid === 'status@broadcast') continue;

        const sender = message.key.participant || jid;
        const key = `${jid}:${sender}`;
        const text = getMessageText(message).trim();
        const match = text.match(/^\.(pack|sticker|toimg|tovid|ssearch|spack|help|menu)\b\s*([\s\S]*)$/i);
        const session = packSessions.get(key);

        if (match) {
          const command = `.${match[1].toLowerCase()}`;
          const args = match[2].trim().split(/\s+/).filter(Boolean);
          await react(sock, message, REACTION_WAITING);
          try {
            await handleCommand(sock, message, command, args, key, jid);
          } catch (error) {
            console.error('Error procesando el comando:', error);
            await reply(sock, jid, `No pude completar el comando: ${error.message || 'error inesperado'}`, message);
          } finally {
            await react(sock, message, REACTION_DONE);
          }
          continue;
        }

        if (session?.capturing) {
          try {
            const media = await getIncomingMedia(message);
            if (!media) continue;
            await react(sock, message, REACTION_WAITING);
            try {
              const warning = addToPack(session, media);
              await reply(sock, jid, warning || `Sticker agregado al paquete *${session.name}* (${session.items.length}).`, message);
            } finally {
              await react(sock, message, REACTION_DONE);
            }
          } catch (error) {
            console.error('Error agregando medio al paquete:', error);
          }
        }
      }
    });
  };

  start();
}

process.on('unhandledRejection', (reason) => {
  console.error('Error no controlado:', reason?.message || reason);
});

process.once('SIGINT', () => {
  console.log('\nCerrando bot…');
  process.exit(0);
});

const isEntryPoint = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isEntryPoint) {
  main().catch((error) => {
    console.error('No se pudo iniciar el bot:', error.message || error);
    process.exit(1);
  });
}

export {
  addPackMetadata,
  addToPack,
  chooseLinkingMethod,
  downloadWebp,
  getContent,
  getContextInfo,
  getIncomingMedia,
  getIncomingMediaFromQuote,
  getMessageText,
  handleCommand,
  isValidPhoneNumber,
  mediaFrom,
  main,
  normalizePhoneNumber,
  packSessions,
  react,
  sendSticker,
  toSticker,
  tenorSearch,
};
