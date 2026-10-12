FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs setup-password.mjs start.mjs ./
COPY lib ./lib
COPY public ./public
COPY docker-entrypoint.sh ./
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
ENV HOST=0.0.0.0 PORT=3000 MY_REEF_DATA_DIR=/data
USER node
VOLUME /data
EXPOSE 3000
CMD ["sh", "docker-entrypoint.sh"]
