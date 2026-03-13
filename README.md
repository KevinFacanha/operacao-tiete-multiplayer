# Operação Tietê - Fundacao MVP

multiplayer básico para 2 jogadores.

## Estrutura

- `client`: Vite + TypeScript + Three.js
- `server`: Node.js + ws

## Como rodar

### 1) Servidor

```bash
cd server
npm install
npm start
```

Esperado no terminal:

```txt
WS server on ws://localhost:8080
```

### 2) Cliente

Em outro terminal:

```bash
cd client
npm install
npm run dev
```

Abra a URL que o Vite mostrar (normalmente `http://localhost:5173`).

## Como testar o MVP

1. Abra 2 abas na URL do client.
2. Cada aba recebe um player (`id` 1 ou 2).
3. Use `WASD` ou setas em cada aba para mover seu cubo.
4. Abra uma 3a aba na mesma room (`default`): deve aparecer `Sala cheia`.

## Configurações

- Room no client: constante `ROOM` em `client/src/main.ts`.
- Porta do server: variavel de ambiente `PORT` (padrao `8080`).
- Room por querystring no server: `ws://localhost:8080/?room=abc`.
