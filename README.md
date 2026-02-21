# BOMZAO CALLS

App web com:

- Login com 2 usuários fixos
- Canal único de voz e vídeo em tempo real
- Sinalização WebRTC via Supabase Realtime
- Pronto para deploy na Vercel

## Usuários

- `kaziin` / `bomzao123`
- `gui` / `bomzao321` (também aceita `bomzao 321`)

## Configuração

1. Crie o arquivo `.env` na raiz:

```env
VITE_SUPABASE_URL=https://lvenwdskwvckwifanfmv.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_XjBCE_tR1Y4cQXSfKlbEew_0U_N4c5M
```

2. Instale e rode:

```bash
npm install
npm run dev
```

3. Acesse `http://localhost:5173`

## Supabase

No painel do Supabase, verifique que Realtime está habilitado no projeto.

## Deploy na Vercel

1. Suba este projeto para o GitHub.
2. Na Vercel, importe o repositório.
3. Defina as variáveis de ambiente:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Build command: `npm run build`
5. Output directory: `dist`

Depois do deploy, abra em dois navegadores/dispositivos diferentes, faça login com os dois usuários e conecte no canal para conversar com voz e vídeo.

## Conexão PostgreSQL direta

A string PostgreSQL com senha é para backend/serviços de servidor, nunca para frontend.

- Frontend usa apenas:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
- Backend (opcional, ex: API Node, scripts, Prisma) usa:
   - `DATABASE_URL=postgresql://postgres:SUA_SENHA@db.lvenwdskwvckwifanfmv.supabase.co:5432/postgres`

Se for usar backend na Vercel, adicione `DATABASE_URL` nas Environment Variables do projeto (sem prefixo `VITE_`).