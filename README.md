# Sticker Bot para Termux

Bot de WhatsApp en Node.js para crear y administrar stickers. Se vincula mediante QR o código de emparejamiento y funciona en Termux con la sesión guardada localmente.

> Este proyecto usa WhatsApp Web mediante Baileys (no es una API oficial de WhatsApp). Úsalo respetando los términos de WhatsApp. La automatización puede implicar restricciones de la cuenta; nunca compartas la carpeta `auth_info`.

## Instalación en Termux

```sh
pkg update -y
pkg install -y nodejs-lts ffmpeg
cd ~/Sticker
npm install
```

Copia el proyecto al teléfono o clónalo en `~/Sticker`. Inicia con `npm start`.

### Vinculación por QR

```sh
npm start
```

Escanea el QR desde WhatsApp: **Ajustes > Dispositivos vinculados > Vincular dispositivo**. La sesión queda en `auth_info/`; las próximas ejecuciones reutilizan el vínculo.

### Vinculación por código

Indica el número de WhatsApp que vas a vincular con código internacional, sin `+`, espacios ni guiones:

```sh
PAIRING_NUMBER=598XXXXXXXX npm start
```

Sigue la ruta **WhatsApp > Dispositivos vinculados > Vincular dispositivo con número de teléfono** e introduce el código que muestra Termux. Si la sesión anterior está vinculada, primero cierra esa sesión desde WhatsApp.

## Comandos

- `.pack nombre.autor` — crea un paquete (nombre y autor separados por el último punto).
- `.pack add` — activa la captura; luego envía imágenes una por una. También puedes responder a una imagen con `.pack add` para agregarla directamente.
- `.pack done` — convierte y envía todos los elementos acumulados como stickers.
- `.pack cancel` — descarta el paquete en curso.
- `.sticker` — convierte una imagen (o un sticker) a sticker. Puede acompañar una imagen o responder a ella.
- `.sticker texto` — busca y envía un sticker para esa búsqueda.
- `.toimg` — responde a un sticker para convertirlo a PNG.
- `.tovid` — responde a un sticker animado para convertirlo a MP4 (requiere `ffmpeg`).
- `.ssearch texto` — busca un sticker y envía el primer resultado.
- `.spack texto` — busca y envía hasta ocho resultados relacionados como un lote de stickers.
- `.help` — muestra la ayuda.

`.pack done` envía los stickers en secuencia usando Baileys y adjunta a cada uno los metadatos EXIF del mismo pack (nombre, autor e identificador), para que WhatsApp los reconozca como pertenecientes a ese conjunto. WhatsApp no ofrece un método de Baileys para enviar un paquete entero en un solo mensaje; el bot envía los stickers individualmente. `.spack` también agrupa los metadatos de los resultados encontrados.

## Búsquedas (Tenor)

`.ssearch` y `.spack` requieren una clave de API de Tenor. Crea una aplicación en el portal de desarrolladores de Google/Google Cloud para Tenor y exporta la clave antes de ejecutar el bot:

```sh
export TENOR_API_KEY='tu_clave_de_tenor'
npm start
```

Si usas pairing junto con búsqueda:

```sh
TENOR_API_KEY='tu_clave' PAIRING_NUMBER=598XXXXXXXX npm start
```

Sin la clave, las demás funciones (crear, convertir y enviar stickers) siguen disponibles.

## Almacenamiento y solución de problemas

- `auth_info/` contiene las credenciales de WhatsApp. No la publiques ni la compartas.
- Para vincular otra cuenta, desconecta el dispositivo desde WhatsApp y elimina `auth_info/` antes de reiniciar.
- Si `.tovid` informa que falta ffmpeg: `pkg install ffmpeg`.
- Las imágenes de un paquete se mantienen temporalmente en memoria mientras el proceso está activo; un reinicio cancela el paquete pendiente.
- Requiere Node.js 20.9 o superior. En Termux, utiliza `nodejs-lts`.
