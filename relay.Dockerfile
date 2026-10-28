FROM node:24-slim
WORKDIR /relay
RUN echo '{"private":true,"type":"module"}' > package.json \
  && npm install --omit=dev --no-audit --no-fund undici@7.30.1 ws@8.22.0
COPY dist/relay/Relay.js dist/relay/main.js ./
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "main.js"]
