# Oficina virtual en un contenedor Linux. Los modelos NO van dentro: se usan los de tu PC
# (Ollama y LM Studio) por la red, con host.docker.internal. Ver compose.yaml.
FROM node:22-slim

# git: copias aisladas (worktree) de las misiones que editan · openssh-client: modo Infra con servidores
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Claude Code (CLI `claude`): su sesión vive en el volumen claude-home (se inicia una vez con `docker exec -it oficina-virtual claude`).
RUN npm install -g @anthropic-ai/claude-code && claude --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Corre como el usuario normal `node` (no root): más seguro, y Claude Code lo exige para el modo «control total».
RUN mkdir -p /app/data /home/node/.claude && chown -R node:node /app /home/node/.claude
# Toda la config de Claude Code (sesión incluida) dentro del volumen, para que sobreviva al recrear el contenedor.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
USER node

# Dentro del contenedor escucha en todas las interfaces; compose publica el puerto solo en 127.0.0.1 del equipo.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
EXPOSE 4000
CMD ["node", "server/index.js"]
