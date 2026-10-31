import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import WebP from 'node-webpmux';
import {
  handleCommand,
  toSticker,
  getContextInfo,
  getMessageText,
  normalizePhoneNumber,
  isValidPhoneNumber,
  addToPack,
  tenorSearch,
  packSessions,
} from '../src/index.js';

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

const jid = '59899123456@s.us';
const baseMessage = { key: { remoteJid: jid, fromMe: false, id: 'msg1' } };
const key = `${jid}:${jid}`;

const sent = [];
const sock = {
  ev: new EventEmitter(),
  sendMessage: async (target, content, options) => {
    sent.push({ target, content, options });
  },
};

async function reset() {
  sent.length = 0;
  packSessions.delete(key);
}

// --- getContextInfo: contextInfo está al nivel superior del contenido ---
{
  const content = {
    imageMessage: {},
    contextInfo: { quotedMessage: {}, stanzaId: 'x', participant: 'p@s.us' },
  };
  assert.deepStrictEqual(getContextInfo({ message: content }), content.contextInfo);
  assert.strictEqual(getContextInfo({ message: { conversation: 'hola' } }), undefined);
  console.log('PASS getContextInfo lee contextInfo del nivel superior del mensaje');
  passed += 1;
}

// --- getMessageText ---
{
  assert.strictEqual(getMessageText({ message: { conversation: 'hola' } }), 'hola');
  assert.strictEqual(getMessageText({ message: { extendedTextMessage: { text: 'texto' } } }), 'texto');
  assert.strictEqual(getMessageText({ message: { imageMessage: { caption: 'cap' } } }), 'cap');
  assert.strictEqual(getMessageText({ message: {} }), '');
  console.log('PASS getMessageText extrae texto/captión');
  passed += 1;
}

// --- teléfonos ---
{
  assert.strictEqual(normalizePhoneNumber('+00 598 99 123-456'), '59899123456');
  assert.strictEqual(normalizePhoneNumber('59899123456'), '59899123456');
  assert.strictEqual(isValidPhoneNumber('59899123456'), true);
  assert.strictEqual(isValidPhoneNumber('59899123456789'), true); // 14 dígitos
  assert.strictEqual(isValidPhoneNumber('5989912345678901'), false); // 16 dígitos: fuera de rango
  assert.strictEqual(isValidPhoneNumber('1234'), false);
  assert.strictEqual(isValidPhoneNumber(normalizePhoneNumber('012345678')), true); // se quitan ceros a la izquierda
  console.log('PASS normalización y validación de teléfonos');
  passed += 1;
}

// --- addToPack (límite de 30) ---
{
  const session = { items: [] };
  assert.strictEqual(addToPack(session, { buffer: Buffer.from('a') }), null);
  assert.strictEqual(session.items.length, 1);
  const full = { items: Array(30).fill(Buffer.from('x')) };
  assert.strictEqual(addToPack(full, { buffer: Buffer.from('y') }), 'El paquete ya tiene 30 stickers. Usa .pack done para enviarlos.');
  assert.strictEqual(full.items.length, 30);
  console.log('PASS addToPack respeta el límite de 30');
  passed += 1;
}

// --- .help / .menu ---
await ok('.help y .menu responden la ayuda', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.help', [], key, jid);
  const reply = sent.find(s => s.content && typeof s.content.text === 'string');
  assert.ok(reply, 'no se envió respuesta');
  assert.ok(reply.content.text.includes('.pack nombre.autor'), 'respuesta sin ayuda');
  assert.ok(reply.options.quoted, 'respuesta sin citar el mensaje');
  await reset();
  await handleCommand(sock, baseMessage, '.menu', [], key, jid);
  const menu = sent.find(s => s.content && typeof s.content.text === 'string');
  assert.ok(menu, '.menu no respondió');
});

// --- .pack crear ---
await ok('.pack nombre.autor crea un paquete (último punto separa)', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.pack', ['mis stickers.Autor'], key, jid);
  const session = packSessions.get(key);
  assert.ok(session);
  assert.strictEqual(session.name, 'mis stickers');
  assert.strictEqual(session.author, 'Autor');
  assert.strictEqual(session.items.length, 0);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('Paquete *mis stickers*'), true);
});

// --- .pack formato inválido ---
await ok('.pack sin punto rechaza con formato', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.pack', ['nopunto'], key, jid);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('Formato:'), true);
  assert.strictEqual(packSessions.get(key), undefined);
});

// --- .pack add sin sesión ---
await ok('.pack add sin paquete avisa', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.pack', ['add'], key, jid);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('Primero crea un paquete'), true);
});

// --- .pack add activa captura ---
await ok('.pack add activa modo captura', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.pack', ['mi.pack', 'Autor'], key, jid);
  await handleCommand(sock, baseMessage, '.pack', ['add'], key, jid);
  const session = packSessions.get(key);
  assert.strictEqual(session.capturing, true);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('Modo de captura activado'), true);
});

// --- .pack cancel ---
await ok('.pack cancel descarta el paquete', async () => {
  await reset();
  packSessions.set(key, { id: 'id', name: 'x', author: 'y', items: [], capturing: false });
  await handleCommand(sock, baseMessage, '.pack', ['cancel'], key, jid);
  assert.strictEqual(packSessions.get(key), undefined);
  assert.strictEqual(sent[sent.length - 1].content.text, 'Paquete cancelado.');
});

// --- .pack done sin sesión ---
await ok('.pack done sin paquete avisa', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.pack', ['done'], key, jid);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('No tienes un paquete en curso'), true);
});

// --- .pack done vacío ---
await ok('.pack done paquete vacío avisa', async () => {
  await reset();
  packSessions.set(key, { id: 'id', name: 'x', author: 'y', items: [], capturing: false });
  await handleCommand(sock, baseMessage, '.pack', ['done'], key, jid);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('está vacío'), true);
});

// --- .pack done envía stickers (ffmpeg simulado) ---
await ok('.pack done convierte y envía stickers con metadatos del pack', async () => {
  await reset();
  await WebP.Image.initLib();
  packSessions.set(key, {
    id: 'pack-id-1',
    name: 'Paquete prueba',
    author: 'Autor prueba',
    items: [Buffer.from('imagen-falsa-del-paquete')],
    capturing: false,
  });
  await handleCommand(sock, baseMessage, '.pack', ['done'], key, jid);
  const stickers = sent.filter(s => s.content && s.content.sticker);
  assert.strictEqual(stickers.length, 1, `se esperaba 1 sticker enviado, se enviaron ${stickers.length}`);
  const stickerBuf = stickers[0].content.sticker;
  assert.ok(Buffer.isBuffer(stickerBuf) && stickerBuf.length > 0);
  assert.strictEqual(stickers[0].target, jid);
  // El WebP resultante es válido y trae metadatos EXIF del pack
  assert.strictEqual(stickerBuf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(stickerBuf.toString('ascii', 8, 12), 'WEBP');
  const img = new WebP.Image();
  await img.load(stickerBuf);
  assert.ok(img.data.exif && img.data.exif.raw);
  const exifText = img.data.exif.raw.toString('utf8');
  assert.ok(exifText.includes('sticker-pack-id'), 'EXIF sin sticker-pack-id');
  assert.ok(exifText.includes('Paquete prueba'), 'EXIF sin nombre del pack');
  assert.ok(exifText.includes('Autor prueba'), 'EXIF sin autor del pack');
  const doneReply = sent.find(s => s.content && typeof s.content.text === 'string' && s.content.text.includes('enviado'));
  assert.ok(doneReply, 'no se envió confirmación de .pack done');
  assert.ok(doneReply.content.text.includes('Paquete prueba'), 'confirmación sin nombre del paquete');
});

// --- .sticker texto sin TENOR_API_KEY ---
await ok('.sticker texto sin clave de Tenor informa el error', async () => {
  await reset();
  await assert.rejects(
    () => handleCommand(sock, baseMessage, '.sticker', ['hola'], key, jid),
    /TENOR_API_KEY/
  );
});

// --- .sticker sin medio pide una imagen ---
await ok('.sticker sin medio pide una imagen', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.sticker', [], key, jid);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('Envía una imagen'), true);
});

// --- .toimg sin sticker ---
await ok('.toimg sin sticker avisa', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.toimg', [], key, jid);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('Responde a un sticker'), true);
});

// --- .ssearch sin texto ---
await ok('.ssearch sin texto muestra uso', async () => {
  await reset();
  await handleCommand(sock, baseMessage, '.ssearch', [], key, jid);
  assert.strictEqual(sent[sent.length - 1].content.text.includes('Uso:'), true);
});

// --- tenorSearch sin clave lanza error ---
await ok('tenorSearch sin TENOR_API_KEY lanza error', async () => {
  const old = process.env.TENOR_API_KEY;
  delete process.env.TENOR_API_KEY;
  // tenorSearch cierra su propia captura del módulo; re-require no aplica, comprobamos comportamiento vía variable de entorno leída al llamar
  await assert.rejects(() => tenorSearch('prueba'), /TENOR_API_KEY/);
  if (old) process.env.TENOR_API_KEY = old;
});

// --- shim de ffmpeg funciona ---
{
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', 'in.png', 'out.webp'], {
    cwd: '/tmp',
    env: { ...process.env, PATH: `/home/user/Sticker/test/bin:${process.env.PATH}` },
  });
  assert.strictEqual(res.status, 0);
  const out = await import('node:fs/promises').then(p => p.readFile('/tmp/out.webp'));
  assert.strictEqual(out.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(out.toString('ascii', 8, 12), 'WEBP');
  console.log('PASS shim de ffmpeg produce WebP válido');
  passed += 1;
}

// --- toSticker convierte PNG a WebP; addPackMetadata le inyecta EXIF ---
await ok('toSticker convierte y comprime bajo 100 KB, addPackMetadata inyecta EXIF', async () => {
  await WebP.Image.initLib();
  const png = await import('node:fs/promises').then(p => p.readFile('/home/user/Sticker/test/fixtures/tiny.png'));
  const mod = await import('../src/index.js');
  const oldPath = process.env.PATH;
  process.env.PATH = `/home/user/Sticker/test/bin:${process.env.PATH}`;
  try {
    const sticker = await mod.toSticker(png);
    assert.ok(Buffer.isBuffer(sticker) && sticker.length > 0);
    assert.ok(sticker.length <= 98 * 1024);
    assert.strictEqual(sticker.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(sticker.toString('ascii', 8, 12), 'WEBP');
    const withMeta = await mod.addPackMetadata(sticker, 'Pack prueba', 'Autor prueba');
    assert.ok(Buffer.isBuffer(withMeta) && withMeta.length > 0);
    const img = new WebP.Image();
    await img.load(withMeta);
    assert.ok(img.data.exif && img.data.exif.raw, 'no se inyectaron metadatos EXIF');
    const exifText = img.data.exif.raw.toString('utf8');
    assert.ok(exifText.includes('sticker-pack-id') && exifText.includes('Pack prueba') && exifText.includes('Autor prueba'));
  } finally {
    process.env.PATH = oldPath;
  }
});

console.log(`\n${passed} pruebas superadas`);
