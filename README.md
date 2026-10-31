# Sticker Bot para Termux

Bot de WhatsApp en Node.js para crear y administrar stickers. Se vincula mediante QR o código de emparejamiento y funciona en Termux con la sesión guardada localmente.

> Este proyecto usa WhatsApp Web mediante Baileys (no es una API oficial de WhatsApp). Úsalo respetando los términos de WhatsApp. La automatización puede implicar restricciones de la cuenta; nunca compartas la carpeta `auth_info`.

## Instalación en Termux

```sh
pkg update -y
pkg install -y nodejs-lts ffmpeg
cd ~/Sticker
# Elimina una configuración inválida anterior (el lockfile ya usa dependencias de npm, no Git)
npm config delete allow-git
npm install
```

Copia el proyecto al teléfono o clónalo en `~/Sticker`. Inicia con `npm start`.

### Vinculación por QR o pairing code

```sh
npm start
```

En la primera ejecución, el bot pregunta `qr` o `code` (también acepta `1` o `2`):

- **qr**: muestra un QR en la terminal. Escanéalo desde WhatsApp > Dispositivos vinculados > Vincular dispositivo.
- **code**: escribe el número completo con código de país, solo dígitos (por ejemplo, `59899123456`). El bot consulta la versión actual de WhatsApp Web, espera a que termine el handshake con WhatsApp y solo entonces pide el pairing code, que muestra agrupado como `ABCD-EFGH` (el guion es solo para leerlo). Introduce el código recién generado desde WhatsApp > Dispositivos vinculados > Vincular dispositivo > Vincular con número de teléfono. El código caduca: si tarda demasiado, el bot genera uno nuevo automáticamente y lo muestra en pantalla (solo sirve el último). Tras cinco intentos fallidos se detiene con un mensaje explicando el motivo; puedes ampliar el límite con `LINK_ATTEMPTS=10`.

La sesión queda guardada en `auth_info/`; si ya está vinculada (por QR o por código), `npm start` se conecta directamente sin volver a preguntar. No escanees el QR si elegiste `code` y no reutilices códigos anteriores. En una terminal no interactiva puedes omitir el menú con `PAIRING_NUMBER=59899123456 npm start`, sustituyendo el ejemplo por tu número real. Si el bot detecta credenciales de un vínculo que quedó a medias, las descarta y empieza de cero: reutilizarlas hace que WhatsApp rechace el emparejamiento. Las sesiones ya vinculadas nunca se borran; si WhatsApp revoca la sesión (`loggedOut` o `401`), se eliminan las credenciales y se reinicia el vínculo automáticamente. Si vas a cambiar una cuenta ya vinculada, desconéctala en WhatsApp y elimina `auth_info/`.

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
TENOR_API_KEY='tu_clave' PAIRING_NUMBER=59899123456 npm start
```

Sin la clave, las demás funciones (crear, convertir y enviar stickers) siguen disponibles.

## Almacenamiento y solución de problemas

- `auth_info/` contiene las credenciales de WhatsApp. No la publiques ni la compartas.
- Para vincular otra cuenta, desconecta el dispositivo desde WhatsApp y elimina `auth_info/` antes de reiniciar.
- Si `.tovid` informa que falta ffmpeg: `pkg install ffmpeg`.
- Si el pairing code no aparece: comprueba que el número incluya el código de país (sin `+` ni `00`) y que la terminal no esté cerrando la conexión. El bot reintenta solo y muestra el motivo de cada cierre.
- Si WhatsApp dice que el código no es válido, espera al que se muestra tras el mensaje `La vinculación no se completó…`; los códigos anteriores dejan de servir en cuanto se genera uno nuevo.
- Si el vínculo se queda colgado, elimina `auth_info/` y ejecuta `npm start` otra vez.
- Las imágenes de un paquete se mantienen temporalmente en memoria mientras el proceso está activo; un reinicio cancela el paquete pendiente.
- Requiere Node.js 20.9 o superior. En Termux, utiliza `nodejs-lts`.
