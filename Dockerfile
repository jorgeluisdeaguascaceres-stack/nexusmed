# Imagen oficial de Puppeteer: ya trae Chrome instalado y configurado.
# Esto evita el error más común al desplegar en Render (Chromium no encontrado).
FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Carpeta de trabajo dentro del contenedor (escribible por el usuario pptruser).
WORKDIR /home/pptruser/app

# Instala dependencias. Chrome ya viene en la imagen, así que no se descarga otra vez.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY --chown=pptruser:pptruser package.json ./
RUN npm install --omit=dev

# Copia el resto del código.
COPY --chown=pptruser:pptruser . .

# Render inyecta PORT automáticamente; el server ya lee process.env.PORT.
CMD ["node", "crc_service.js"]
