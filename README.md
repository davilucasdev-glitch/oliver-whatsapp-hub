# Oliver WhatsApp Hub

Sistema interno da **Oliver Cosmetics** para gerenciar números de WhatsApp, disparar campanhas sem arriscar bloqueio e atender clientes com um bot de IA (Claude) treinado nos produtos do Bling.

> **Status:** as 7 etapas estão concluídas.
> 1. Infra, banco, webhook oficial da Meta recebendo e respondendo uma mensagem de teste.
> 2. Painel com login, gestão de números (qualidade, tier, limites, ritmo, testar envio) e templates (sincronizar e criar).
> 3. Contatos (importação CSV, tags, segmentos, consentimento, LGPD) e Inbox de atendimento (bot/humano, mídia, respostas rápidas, templates).
> 4. Integração com o Bling: conexão OAuth, catálogo copiado a cada 30 min (descrições limpas para a IA, busca tolerante a erro), consulta de pedidos e vínculo de contatos.
> 5. Bot de IA (Claude com ferramentas): recomenda produtos do catálogo, envia fotos, consulta pedidos, transfere para a equipe; base de conhecimento editável, simulador e registros com tokens.
> 6. Campanhas: público por tags, variáveis personalizadas, pré-visualização com contato real, agendamento, janela de horário, envio no ritmo do número com pausa automática e relatório (entregues, lidos, respostas, falhas, opt-outs).
> 7. Verificação em duas etapas no login (app autenticador + códigos de recuperação), tela de Segurança (senha, sessões abertas), HTTPS automático opcional no Docker e o comando `npm run checklist`, que diz o que falta para ir para produção.
>
> **Para colocar no ar, siga o [Passo a passo](#passo-a-passo-para-colocar-no-ar) e confira o [Checklist final](#checklist-final).**

## Arquitetura

| Parte | Tecnologia | Por quê |
|---|---|---|
| API + webhook | Node 20 + TypeScript + **Fastify** | Leve, rápido para responder 200 à Meta em milissegundos, acesso direto ao corpo bruto (necessário para validar a assinatura) |
| Banco | PostgreSQL 16 + Prisma (migrations versionadas) + `pg_trgm` | Busca aproximada de produtos para o bot |
| Filas | Redis + BullMQ | Webhook → fila `inbound`; depois `outbound`, `campaign`, `bling` |
| WhatsApp | **API oficial (Meta Cloud API)** atrás da interface `WhatsAppProvider` | Nada de QR Code / WhatsApp Web (Baileys, WPPConnect etc.), que é o que causa banimento |
| Painel | Next.js 16 + Tailwind 4 + componentes shadcn/ui (Radix) | Responsivo; no celular vira navegação inferior. Fala com a API pela mesma origem (`/api/*` repassado), então o cookie de sessão é `SameSite=Strict` e não há CORS |
| IA | Claude (`claude-sonnet-5-5`) via SDK oficial da Anthropic, com tool use | Modelo e esforço no `.env`; regras e base de conhecimento no prompt com cache |

```
apps/web/              painel Next.js (login, visão geral, inbox, contatos, campanhas, números, templates, produtos, bot, segurança)
apps/api/
  prisma/              schema + migrations + seed
  src/auth/            login, sessão (cookie httpOnly, token só como hash no banco), primeiro acesso, 2FA (TOTP)
  src/http/            rotas do painel (/api/*)
  src/numbers/         serviço de números: cadastro validado na Meta, sync, importação da WABA, teste de envio
  src/templates/       sync e criação de templates (validação de variáveis/exemplos, botão "Parar promoções")
  src/contacts/        CSV (; ou , / UTF-8 ou Excel), importação, segmentos, consentimento, exportar/excluir (LGPD)
  src/inbox/           conversas, envio de texto/mídia/template, assumir/devolver ao bot, mídia autenticada
  src/campaigns/       campanhas: regras anti-bloqueio, variáveis, motor de envio (ritmo por número), relatório
  src/bot/             bot de IA: contexto (regras + base + horário + memória), ferramentas, laço com o Claude, simulador
  src/bling/           cliente da API v3 (OAuth + refresh, limite de 3/s, backoff), sync de produtos, busca, pedidos
  src/whatsapp/        WhatsAppProvider, MetaCloudProvider, assinatura, tipos do webhook
  src/webhook/         GET/POST /webhook, extração de eventos (idempotência por chave)
  src/inbound/         worker: mensagens, status, qualidade do número, status de template
  src/messaging/       envio (regra da janela de 24h), opt-out/opt-in por palavra-chave
  src/numbers/         política de qualidade (MÉDIA reduz ritmo, BAIXA pausa campanhas)
  src/queue/           BullMQ (produção) ou fila em memória (dev/testes)
  src/dev/             Meta, Bling e Claude simulados + geradores de payload (testes e teste local)
```

### Regras anti-bloqueio
- Assinatura `X-Hub-Signature-256` validada com o App Secret (corpo bruto, comparação em tempo constante).
- Idempotência: cada mensagem/status da Meta é gravado **uma vez** (`WebhookEvent.eventKey` único + `Message.waMessageId` único). Reenvios da Meta não geram resposta duplicada.
- Webhook responde 200 na hora; o processamento vai para a fila (com novas tentativas).
- **Janela de 24h**: texto livre e mídia são bloqueados fora da janela (`ServiceWindowClosedError`); só template passa.
- **Opt-out**: "SAIR", "PARAR", "CANCELAR", "STOP", "quero sair", "me tira da lista"… marcam `optOut`, registram o consentimento e confirmam. "Quero cancelar meu pedido" **não** conta como opt-out. "VOLTAR" reativa.
- Iniciar conversa **não** vira opt-in de marketing.
- Qualidade do número: evento da Meta → consulta a nota → MÉDIA reduz o ritmo pela metade, BAIXA pausa as campanhas do número e cria alerta crítico.
- Status das mensagens (enviada → entregue → lida / falhou) nunca regride.
- Templates de marketing criados pelo painel ganham o botão **"Parar promoções"** por padrão; quem toca nele é descadastrado automaticamente.
- Retomar campanhas de um número pausado é sempre manual, e bloqueado enquanto a qualidade estiver BAIXA.
- **Campanhas**: só opt-in; **1 campanha a cada 7 dias por cliente** (ajustável); janela de envio entre 8h e 21h (padrão 9h–20h, horário de Brasília); ritmo do número (20/min por padrão, metade com qualidade MÉDIA) dividido entre as campanhas dele; no máximo **90% do limite diário** do tier; telefone fora do padrão E.164 é pulado; um destinatário por contato (sem duplicados); personalização com o nome do cliente.
- Pausa automática: qualidade BAIXA, Meta acusando spam/bloqueio/pagamento/token (pausa **todas** as campanhas do número e trava novas), template pausado/desativado pela Meta, **mais de 30% de falhas** depois de 20 envios. "Desacelere" da Meta = espera 1 minuto sem perder ninguém. Cliente que bloqueou marketing no próprio WhatsApp (erro 131050) vira opt-out.
- Template de **marketing** só vai para contato com opt-in; quem pediu para sair nunca recebe. A importação de CSV **nunca** reativa quem pediu para sair, e todo opt-in precisa de origem registrada.

### Segurança do painel
- Senha forte obrigatória (mín. 10 caracteres, 3 tipos), guardada com **bcrypt** (custo 12).
- Sessão em cookie `httpOnly` + `SameSite=Strict` (+ `Secure` em produção); no banco fica só o hash SHA-256 do token.
- Cabeçalho anti-CSRF obrigatório em toda ação que altera dados.
- Login limitado a 10 tentativas por IP a cada 15 min; mesma mensagem para e-mail inexistente ou senha errada.
- Primeiro acesso só com o `SETUP_TOKEN` do `.env`, e só enquanto não existe usuário.
- Tokens da Meta por número e do Bling criptografados com AES-256-GCM; a API nunca os devolve ao painel.
- Painel não pode ser embutido em outro site (`X-Frame-Options: DENY`).
- **Verificação em duas etapas** (opcional, recomendada): código de 6 dígitos de app autenticador (padrão TOTP, como Google Authenticator) depois da senha. O segredo fica criptografado; o mesmo código não vale duas vezes; 5 erros derrubam a tentativa; 10 **códigos de recuperação** de uso único (guardados só como hash) para quando perder o celular. Ativar derruba as outras sessões.
- Tela **Segurança**: trocar senha (derruba as outras sessões), ativar/desativar a verificação em duas etapas, gerar novos códigos de recuperação e ver/encerrar as sessões abertas.

### Equipe (vários acessos)

- Quem fez o **Primeiro acesso** vira **Administrador**. Na tela **Equipe** (só aparece para administrador) ele adiciona as pessoas: nome, e-mail, papel e senha inicial (o botão **Gerar** cria uma senha forte para passar à pessoa).
- **Administrador** gerencia a equipe; **Atendente** usa todo o resto do painel.
- Cada pessoa troca a própria senha e ativa a verificação em duas etapas em **Segurança**.
- **Desativar** um acesso derruba as sessões dele na hora e devolve as conversas dele para a fila. Trocar a senha ou zerar a verificação em duas etapas pela tela Equipe também derruba as sessões.
- Sempre sobra pelo menos um administrador ativo, e ninguém desativa ou rebaixa o próprio acesso.
- **Inbox**: cada conversa tem um **responsável**. Quem assume ou responde primeiro vira o responsável (sem tirar de quem já está atendendo), e dá para trocar no seletor do topo da conversa. O filtro **Minhas** mostra só as suas. Cada mensagem enviada mostra o nome de quem enviou.

## Passo a passo para colocar no ar

> **Roteiro completo e atualizado: [ENTRAR-NO-AR.md](ENTRAR-NO-AR.md).** Instalação automática num servidor Ubuntu: `deploy/instalar.sh`; atualizar: `deploy/atualizar.sh`; conferir o que falta: `deploy/conferir.sh`; voltar um backup: `deploy/restaurar-backup.sh`. Backup diário do banco, alertas graves no WhatsApp dos administradores e limpeza automática dos registros técnicos já vêm ligados. Os passos abaixo são o detalhe manual.

Você vai precisar de: um servidor com Docker (ex.: VPS Linux com 2 GB de RAM), um domínio apontando para ele, acesso de administrador ao Gerenciador de Negócios da Meta, acesso ao Bling e uma conta na Anthropic.

1. **Meta**: crie o app, pegue os IDs, o App Secret e o token permanente ([Meta: app, token e webhook](#meta-app-token-e-webhook), passos 1 a 5).
2. **Bling**: crie o aplicativo e pegue Client ID e Client Secret ([Bling](#bling), "Criar o app").
3. **Anthropic**: console.anthropic.com → *API Keys* → crie uma chave (dá para colocar no `.env` ou depois pelo painel).
4. **`.env`**: no servidor, `cp .env.example .env` e preencha tudo que está marcado **[PREENCHER]**. Gere as chaves com os comandos que estão no próprio arquivo. Use `DOMAIN`, `ACME_EMAIL`, `PUBLIC_BASE_URL=https://DOMAIN`, `PANEL_URL=https://DOMAIN` e `COOKIE_SECURE=true`.
5. **Subir** com HTTPS automático:

   ```bash
   docker compose --profile https up -d --build
   ```

6. **Conferir**: o comando abaixo lista em português o que ainda falta (✘ obrigatório, ! atenção):

   ```bash
   docker compose run --rm api node dist/scripts/checklist.js
   ```

7. **Primeiro acesso**: abra `https://DOMAIN`, informe o `SETUP_TOKEN`, seu e-mail e uma senha forte. Em seguida vá em **Segurança → Verificação em duas etapas → Ativar** e guarde os códigos de recuperação. Depois, em **Equipe**, adicione as outras pessoas.
8. **Webhook da Meta**: URL `https://DOMAIN/webhook` + `META_VERIFY_TOKEN` e assine os campos ([Meta](#meta-app-token-e-webhook), passos 7 e 8). Depois, em **Números**, use **Importar da WABA** e **Testar envio** para o seu celular.
9. **Bling**: **Produtos → Conectar ao Bling**, autorize e espere a primeira cópia do catálogo.
10. **Bot**: em **Bot de IA → Base de conhecimento** preencha os itens **[DEFINIR]**; em **Configurações** ajuste o horário da equipe (e a chave, se não pôs no `.env`); converse pelo **Simulador** antes de ligar no WhatsApp (`BOT_MODE=ai`).
11. **Primeiro template**: **Templates → Novo template** (ver [abaixo](#primeiro-template)) e aguarde a aprovação da Meta (minutos a 1 dia).
12. **Contatos**: **Contatos → Importar CSV** com a **origem do consentimento** de quem autorizou receber mensagens.
13. **Primeira campanha**: **Campanhas → Nova campanha**, use **Enviar teste** para o seu número e só depois inicie, começando por um público pequeno ([Campanhas](#campanhas)).

## Rodar localmente SEM Docker (desenvolvimento)

**Jeito mais fácil (Windows):** dois cliques em **`Iniciar Oliver Hub.cmd`**, na pasta do projeto. Ele sobe o banco local, a Meta, o Bling e o Claude simulados, a API e o painel, e abre http://localhost:3000. Deixe a janela aberta; para desligar, feche-a (ou Ctrl+C). Os logs ficam em `.logs/`.

O passo a passo manual, terminal por terminal:

Usa Postgres embutido (PGlite com pg_trgm), fila em memória, uma **Meta simulada** e um **Bling simulado**. Nenhuma credencial real é necessária.

```bash
npm install
```

O arquivo `.env` de desenvolvimento já foi gerado com segredos aleatórios e aponta para o Bling e o Claude simulados (o "Claude simulado" segue regras simples, não é IA; serve para testar o circuito sem chave). Em terminais separados:

```bash
npm run dev:db -w apps/api
```

```bash
npm run mock:meta -w apps/api
```

```bash
npm run mock:bling
```

```bash
npm run mock:claude
```

```bash
npm run db:migrate && npm run db:seed && npm run dev:api
```

```bash
npm run dev -w apps/web
```

Abra http://localhost:3000. Na primeira vez aparece **Primeiro acesso**: informe o `SETUP_TOKEN` do `.env`, seu e-mail e uma senha forte. (No ambiente de desenvolvimento desta máquina já existe um acesso de teste; e-mail e senha estão em `DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD` no `.env`.)

Simule um cliente mandando mensagem (payload assinado igual ao da Meta):

```bash
npm run simulate:webhook -w apps/api -- "Oi, tem perfume árabe doce?" 5511988887777 "Maria Souza"
```

No terminal da Meta simulada aparece a resposta do bot. Mande `SAIR` para ver o opt-out.

A Meta simulada também devolve os recibos de entrega ao webhook (enviado → entregue → lido para parte dos números), então o relatório das campanhas funciona em dev. Telefones terminados em `0000` simulam "número sem WhatsApp" (erro 131026). Para desligar: `MOCK_META_STATUS=off`.

> Se a variável `ANTHROPIC_BASE_URL` já existir no ambiente do seu terminal, ela vale mais que a do `.env` (regra do Node). Para usar o Claude simulado nesse caso, rode a API com `ANTHROPIC_BASE_URL=http://localhost:4030`.

## Docker (produção)

```bash
cp .env.example .env
```

Preencha o `.env` (veja os itens `[PREENCHER]`), depois:

```bash
docker compose up -d --build
```

Sobe `postgres`, `redis`, `migrate` (aplica as migrations e encerra), `api` (porta 3001: webhook da Meta), `worker` e `web` (porta 3000: painel). Healthchecks em todos; `GET /health` informa banco e fila.

Depois, acesse o painel na porta 3000 e crie o primeiro acesso com o `SETUP_TOKEN`.

**HTTPS**: a Meta só chama webhook em https. O jeito mais simples é o perfil `https` do compose, que sobe um **Caddy** com certificado automático (Let's Encrypt) para `DOMAIN`: painel e `/webhook` no mesmo endereço. O DNS do domínio precisa apontar para o servidor e as portas 80 e 443 precisam estar abertas.

```bash
docker compose --profile https up -d --build
```

Com o Caddy, deixe as portas 3000 e 3001 fechadas no firewall do servidor (só 80/443 abertas).

**Comandos úteis no servidor**

```bash
docker compose run --rm api node dist/scripts/checklist.js
```

```bash
docker compose run --rm api node dist/prisma/seed.js
```

```bash
docker compose exec api node dist/scripts/sync-bling.js
```

```bash
docker compose logs -f api worker
```

**Atualizar** para uma versão nova do código: `docker compose --profile https up -d --build` (as migrations rodam sozinhas no serviço `migrate`).

**Backup**: o que importa está no volume `pgdata` (Postgres) e no `.env` (principalmente a `ENCRYPTION_KEY`: sem ela os tokens salvos no banco não podem ser lidos). Exemplo de cópia do banco:

```bash
docker compose exec -T postgres pg_dump -U oliver oliver_hub > backup-oliver-hub.sql
```

## Números e templates

**Números**
- *Importar da WABA* traz todos os números da conta (usa `META_WABA_ID`). *Adicionar número* cadastra pelo phone_number_id; os dados são validados na Meta antes de salvar, e dá para usar um token próprio por número.
- Cada número mostra: conexão, **qualidade** (alta/média/baixa), tier e limite diário de conversas, ritmo de envio, enviadas hoje/no mês, campanhas ativas.
- *Sincronizar* consulta a Meta e aplica a política de qualidade. *Testar envio* manda para o seu WhatsApp: texto se você escreveu para a empresa nas últimas 24h, senão o template `hello_world`.
- Função do número (atendimento, campanhas ou ambos) e chave do bot por número. A chave geral do bot fica na Visão geral.

**Templates**
- *Sincronizar com a Meta* traz todos os templates com o status de aprovação (aprovado, em análise, rejeitado + motivo). Templates excluídos na Meta ficam marcados como "Excluído".
- *Novo template*: categoria, cabeçalho, texto com variáveis `{{1}}`, `{{2}}`…, exemplos (exigidos pela Meta), rodapé e botões, com pré-visualização no formato do WhatsApp. Envia direto para aprovação.

### Primeiro template

Exemplo de template de **marketing** para campanha (Templates → Novo template):
- Nome: `novidades_arabes` (minúsculas e _), idioma pt_BR, categoria **Marketing**.
- Texto: `Oi {{1}}! Chegaram novidades de {{2}} na Oliver 💜 Quer que eu te mostre as opções?` com exemplos `Maria` e `Lattafa`.
- Botões: "Quero ver" (resposta rápida). O botão **"Parar promoções"** entra sozinho: quem toca nele sai da lista na hora.
- Dicas para aprovar e não ser denunciado: mensagem curta, com o nome da loja, sem tudo em maiúsculas, sem encurtador de link, e com motivo claro para o cliente receber. Templates de **utilidade** (pedido enviado, lembrete) não servem para promoção: a Meta reclassifica ou bloqueia.

## Contatos e Inbox

**Importar CSV** (Contatos → Importar CSV)
- Colunas reconhecidas pelo nome: `nome`, `telefone`/`celular`/`whatsapp` (obrigatória), `tags` (separe com `|` ou `,`), `opt_in` (sim/não), `email`. Separador `;` ou `,`. Arquivo salvo pelo Excel funciona (acentos inclusos). Há um botão para baixar um modelo.
- *Analisar* mostra novos, já existentes, rejeitados (telefone vazio/inválido, duplicado no arquivo, opt-in não reconhecido) e uma prévia, **sem gravar nada**. O relatório de rejeitados pode ser baixado em CSV. Depois clique em *Importar*.
- Para registrar opt-in é obrigatório informar a **origem do consentimento** (ex.: "cadastro no site"). Opcional: tags aplicadas a todos e "todos autorizaram".

**Ficha do contato**: dados (inclusive CPF, usado depois para o bot consultar pedidos), tags, histórico de consentimento com registro manual de opt-in/opt-out, conversas, *Iniciar conversa* (por template) e LGPD: *Exportar dados* (JSON com tudo) e *Excluir contato* (apaga tudo; pede para digitar o telefone).

**Inbox**
- Lista com busca e filtros: aguardando resposta, não lidas, com bot, com humano. Atualiza sozinha (lista a cada 5 s, conversa aberta a cada 3 s).
- **Assumir** pausa o bot só para aquele cliente; **Devolver ao bot** reativa. Responder pelo painel assume automaticamente.
- Enviar texto, foto (JPEG/PNG até 5 MB), PDF/documento, áudio ou vídeo (até 16 MB). Fotos, áudios e documentos recebidos aparecem no chat.
- Digite `/` para as **respostas rápidas** (cadastro em *Respostas rápidas*; `{nome}` vira o primeiro nome do cliente).
- Fora da janela de 24h a caixa de texto é trocada por *Enviar template*: só templates aprovados, e os de marketing só para quem tem opt-in.
- No celular, a lista e o chat se alternam (botão voltar).

Seed (opcional, cadastra o número principal e dados de exemplo):

```bash
docker compose run --rm api node dist/prisma/seed.js
```

## Bling

**Criar o app no Bling** (uma vez)
1. No Bling: *Central de Extensões → Área do Integrador → Criar aplicativo* (tipo aplicativo próprio/privado).
2. **Link de redirecionamento**: `PANEL_URL` + `/api/bling/callback` (ex.: `https://painel.seudominio.com.br/api/bling/callback`). A tela Produtos mostra o link exato quando o app ainda não está configurado.
3. Escopos (leitura): **Produtos**, **Categorias de produtos**, **Contatos**, **Pedidos de venda** e **Situações**.
4. Copie o *Client ID* e o *Client Secret* para `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET` no `.env`, apague as linhas do Bling simulado (`BLING_API_BASE_URL`/`BLING_OAUTH_BASE_URL` com localhost) e reinicie a API.
5. No painel, **Produtos → Conectar Bling** → autorize no Bling → você volta ao painel e o catálogo começa a ser copiado.

**Como funciona**
- O acesso dura ~6h e é **renovado sozinho** (o Bling troca o refresh_token a cada renovação; o novo é gravado criptografado). Se o Bling recusar a renovação (30 dias sem uso ou acesso revogado), a conexão é removida e aparece um **alerta crítico** na Visão geral pedindo para reconectar.
- **Sync a cada 30 min** (`BLING_SYNC_INTERVAL_MINUTES`) + botão *Sincronizar agora*. Lista todos os produtos ativos (preço e estoque sempre atualizados) e só abre o detalhe (categoria e descrição complementar) do que é novo, mudou ou não é revisto há 7 dias. Produto que sai da lista de ativos vira "inativo" aqui, mas só se a listagem inteira deu certo.
- Respeita o limite do Bling (3 chamadas/s) e repete com espera crescente em 429/5xx.
- Descrições: o HTML (a "Ficha Olfativa" e até HTML colado de outros sites) vira texto limpo, que é o que o bot vai ler. O gênero é deduzido da ficha, da categoria ou do nome (MASC/FEM).
- Busca da tela Produtos (a mesma que o bot vai usar): sem acento, por nome, código, nota ou família, e tolera erro de digitação ("lataffa" acha "Lattafa"). Filtros de categoria, gênero e estoque.

**Pedidos**: na ficha do contato, *Buscar pedidos* acha o cadastro no Bling pelo CPF/CNPJ ou telefone, vincula, completa nome/e-mail/CPF vazios e mostra os últimos pedidos (situação, itens, previsão, nota fiscal, transportadora e rastreio). O bot usa a mesma consulta segura: um pedido só é mostrado ao próprio cliente (mesmo CPF/CNPJ ou mesmo telefone); para outra pessoa ele pede o CPF.

**Sync pelo terminal**

```bash
npm run sync:bling
```

Use `npm run sync:bling -- --full` para reler o detalhe de todos os produtos. No Docker:

```bash
docker compose exec api node dist/scripts/sync-bling.js
```

## Bot de IA

**Ligar**: `BOT_MODE=ai` no `.env` e a chave da Anthropic (console.anthropic.com → API Keys) em `ANTHROPIC_API_KEY` **ou** em *Bot de IA → Configurações* (fica criptografada no banco e tem prioridade). Sem chave, o bot não fica mudo: passa a conversa para a equipe com um aviso educado e cria um alerta.

**Como ele atende**
- Cada mensagem do cliente espera `BOT_DEBOUNCE_MS` (2,5 s): se o cliente mandar várias seguidas, responde uma vez considerando todas.
- O Claude recebe: as regras fixas + a base de conhecimento (em cache, o que barateia as chamadas), a data/hora, se a equipe está atendendo agora e quando volta, as **20 últimas mensagens** e o **resumo** das anteriores (atualizado sozinho).
- Ferramentas: `buscar_produtos` (catálogo local, só com estoque, máx. 5), `detalhes_produto` (ficha completa), `consultar_pedido` (Bling; só pedidos do próprio cliente, pede CPF quando precisa), `transferir_para_humano` e `enviar_imagem_produto` (busca um link novo da foto no Bling na hora).
- Nunca informa produto, preço, estoque, prazo ou status que não veio das ferramentas. Perfume "inspirado em X" é dito como inspirado, nunca como o original. Suplementos sem promessa de saúde.
- **Transfere para a equipe** quando o cliente pede, em reclamação, troca/devolução, problema com pedido, pagamento, para fechar a compra enquanto o fechamento estiver como [DEFINIR], em erro técnico e após 2 buscas/consultas seguidas sem resultado (ajustável). A conversa vira "Humano" na Inbox, fica em "Aguardando" e aparece um alerta na Visão geral. Fora do horário, ele avisa quando a equipe volta.
- Liga/desliga geral e por número em *Bot de IA → Configurações* (números só de campanha nunca têm bot).

**Base de conhecimento** (*Bot de IA → Base de conhecimento*): começa com o conteúdo de `knowledge/oliver.md`. Cada salvamento vira uma versão (histórico das 30 últimas, com nota) e vale na próxima mensagem. A lateral lista os itens **[DEFINIR]** que faltam; enquanto existirem, o bot não inventa e chama a equipe quando o cliente precisa deles.

**Simulador** (*Bot de IA → Simulador*): converse como se fosse um cliente, sem WhatsApp. Usa o catálogo, a base, as regras e as consultas de pedido de verdade (informe o telefone ou CPF de um cliente em *Nova conversa*). Abaixo de cada resposta aparecem as ferramentas usadas e os tokens. Há uma chave para simular "fora do horário".

**Registros** (*Bot de IA → Registros*): cada resposta com data, cliente, ferramentas chamadas, tokens (entrada, cache, saída), tempo, erros e transferências; totais dos últimos 30 dias. Filtros: com erro/transferência, WhatsApp, simulador.

**Horário de atendimento humano**: *Bot de IA → Configurações*, por dia da semana, mais feriados.

## Campanhas

**Criar** (*Campanhas → Nova campanha*):
1. Nome e número de envio (só números com função "Campanhas" ou "Ambos").
2. Template aprovado. Para cada variável {{n}} escolha de onde vem: **primeiro nome** do cliente (com um texto padrão para quem não tem nome, ex.: "cliente"), nome completo, texto fixo, ou nome/preço de um **produto do catálogo** (preço atual do Bling). Template com imagem no cabeçalho pede o link público da imagem (https).
3. Público por tags (qualquer uma / todas / excluir) e "sem falar com a loja há X dias". Ao lado aparece **quantos vão receber** e quem fica de fora e por quê (sem opt-in, opt-out, campanha recente), mais o tempo estimado.
4. Começar ao iniciar ou **agendar** (horário de Brasília) e a janela de envio.
5. A **pré-visualização** mostra a mensagem com os dados de um contato real do público (dá para trocar o contato).

**Enviar teste** (na página da campanha): manda para o seu número do jeito que o cliente vai receber, sem contar no relatório.

**Acompanhar**: a página da campanha atualiza sozinha: enviados, entregues, lidos, responderam (até 3 dias depois), falhas (com o motivo em português), saíram (opt-out depois de receber), pulados (com o motivo) e na fila. Lista de destinatários com filtros e **CSV**. Se estiver esperando, diz por quê ("fora da janela, continua segunda às 09:00", "limite diário atingido", "a Meta pediu para desacelerar").

**Pausar / retomar / cancelar** a qualquer momento. Cancelar não envia para quem está na fila (o que já foi enviado fica no relatório). Campanha pausada automaticamente mostra o motivo; se foi problema do número, libere em *Números* antes de retomar.

**Frequência**: botão "1 a cada X dias" na lista de campanhas (vale para todas as campanhas e números).

**Boas práticas para não perder o número**: comece com públicos pequenos (algumas centenas) e ritmo baixo num número novo; mande só para quem autorizou; personalize; acompanhe "Saíram" e "Falhas" no relatório (opt-out acima de ~2% ou muitas falhas = pare e revise a lista ou a mensagem); não reaproveite listas compradas.

Como o envio funciona: a cada `CAMPAIGN_TICK_MS` (2 s) uma rodada na fila `campaign` confere cada número com campanha rodando (qualidade, pausa, template aprovado, janela, limite diário) e envia no ritmo do número. Cada envio "reserva" a vaga no banco, então rodar a API e o worker juntos não duplica nem acelera. O público é "congelado" ao iniciar; mesmo assim, opt-out, opt-in e frequência são conferidos de novo na hora de cada envio. Se o processo cair no meio de um envio, aquele contato fica como falha "interrompido" (não reenvia, para não mandar duas vezes).

## Avisos de pedido

Quando a situação de um pedido muda no Bling (pelo Kanban ou pela rotina da Duda), o hub manda o aviso certo para a cliente pelo número oficial. Tela: **Avisos de pedido** (alterar só administrador).

| Situação no Bling | Aviso | Variáveis do template |
| --- | --- | --- |
| Em aberto | Recebemos seu pedido (`pedido_recebido`) | nome, nº, total, forma de pagamento |
| Separando | Está sendo separado (`pedido_separando`) | nome, nº |
| Emitir Etiqueta (ou Enviado) com "Retirar na loja" nas observações | Pronto para retirar (`pedido_pronto_retirada`) | nome, nº, endereço e horário da loja |
| Enviado, com código de rastreio | Seu pedido saiu (`pedido_enviado`) | nome, nº, serviço (PAC/SEDEX), código, link |
| Atendido | Pedido entregue (`pedido_entregue`) | nome, nº |
| Cancelado | Pedido cancelado (`pedido_cancelado`) | nome, nº |

**Para ligar:**
1. Bling conectado (*Produtos*).
2. **Criar templates sugeridos**: manda os 6 templates para a Meta (categoria Utilidade) e espera a aprovação. Dá para trocar o nome do template de cada aviso.
3. Confira as **Situações do Bling** (já vêm pelo nome), preencha o **endereço e horário da loja** e, se quiser, um **número de teste**: com ele, todo aviso vai para esse número em vez da cliente.
4. Com o template aprovado, **Testar com um pedido** manda o aviso de um pedido real só para o número de teste.
5. Ligue **Mandar avisos de pedido**. Depois de conferir, apague o número de teste.

**Regras:**
- O hub lê o Bling a cada `ORDERS_POLL_SECONDS` (2 min) pedindo os pedidos alterados desde a última leitura.
- Na **primeira leitura** ele só registra a situação dos pedidos dos últimos 30 dias, sem mandar nada. Quem já estava no meio do fluxo não recebe aviso atrasado.
- **Um aviso de cada tipo por pedido**, nunca repetido. Pedido que volta de situação não reenvia, nem recebe aviso de uma etapa anterior à que já recebeu.
- **Telefone**: primeiro o WhatsApp que o site grava nas observações internas ("WhatsApp 63992142094"), senão o celular/telefone do contato do pedido no Bling. O **nome** é o do contato do pedido (primeiro nome).
- **Envio sem rastreio ainda** fica como "não enviado" e sai sozinho quando a etiqueta entrar no pedido.
- **Retirada** recebe "pronto para retirar" e nunca "saiu para entrega".
- **TikTok** (loja 206093178) nunca recebe aviso. Outras lojas podem ser tiradas em *Lojas sem aviso*.
- **Entregue e Cancelado** só vão para pedidos que já receberam algum aviso (pode desligar). Isso evita mensagem em venda de balcão, que já nasce Atendido.
- O **histórico** mostra cada aviso: enviado, não enviado (com o motivo: sem telefone, template não aprovado...) ou falhou (erro da Meta). A mensagem aparece também na Inbox, como "Sistema".

### Ficha da cliente na Inbox

Ao abrir uma conversa, aparece ao lado (em telas grandes) ou no botão **Cliente** (telas menores e celular) quem é a cliente no Bling:

- **Cadastro no Bling**, achado sozinho. O hub tenta, nesta ordem:
  1. o vínculo já salvo;
  2. o telefone das contas a receber já copiadas (sem chamar o Bling);
  3. a busca no Bling por CPF/CNPJ ou telefone.
  Ao achar, completa nome, e-mail e CPF vazios do contato.
- **Crediário**: saldo em aberto, quanto está em atraso e desde quando, e as próximas parcelas. Segue as mesmas regras da tela Cobrança (corte e TikTok fora) e mostra a última cobrança.
- **Pedido em andamento**, em destaque, e os **últimos pedidos**, com situação, itens e rastreio. Os pedidos ficam guardados 2 minutos por cliente, e o botão de atualizar busca de novo.
- **Abrir no Kanban**: informe uma vez o link do card do painel, com `{numero}` (ex.: `https://…/kanban.php?pedido={numero}`). Cada pedido ganha o botão. Criar um card novo pelo hub ainda não dá: o Kanban fica no painel PHP.

## Cobrança e crediário

Tela **Cobrança**. As parcelas vêm das **contas a receber do Bling**: o hub copia as em aberto e as parcialmente pagas a cada 15 min, ou na hora com **Atualizar do Bling**. **Nada sai sozinho**: cada mensagem é um clique de alguém da equipe, com a mensagem exata na tela antes de enviar. Também dá para marcar várias e enviar de uma vez, confirmando a lista.

| Aba | Quando | Template | Variáveis |
| --- | --- | --- | --- |
| Vence dd/mm | 2 dias antes do vencimento | `cobranca_lembrete` | nome, valor, data, chave Pix |
| Vence hoje | no dia do vencimento | `cobranca_vence_hoje` | nome, valor, chave Pix |
| Em atraso | vencidas | `cobranca_em_aberto` | nome, valor em atraso, tempo de atraso, saldo total |
| Pagamentos recebidos | depois da **baixa no Bling** (últimos 7 dias) | `cobranca_pagamento_recebido` | nome, valor pago, saldo que ficou |

**Configurações** (aba da própria tela; alterar só administrador):
- chave Pix;
- corte por **data de emissão** (padrão 01/10/2026);
- dias do lembrete;
- quem fica com as conversas de cobrança (a Ellen): quando a cliente responder com o comprovante, a conversa já está com ela;
- número que envia;
- **Criar templates sugeridos** (categoria Utilidade).

**Regras:**
- Contas **emitidas antes do corte** e contas de pedidos da **loja TikTok** não entram.
- **Uma cliente por linha.** Várias parcelas no mesmo dia somam. Em atraso soma as vencidas e mostra o maior atraso.
- **Saldo** = soma do que falta nas parcelas em aberto da cliente (a partir do corte).
  - Parcela paga em parte: o hub calcula o que falta pelas baixas (borderôs) do Bling.
  - Se o Bling não informar, a linha mostra "≈ … (confira)", e o envio **pede o saldo do crediário** antes de sair.
- **Não repete:** lembrete e vence hoje saem uma vez por parcela; em atraso, uma vez por cliente por dia; agradecimento, uma vez por pagamento.
- **Telefone:** primeiro o WhatsApp do pedido do site, senão o celular/telefone do cadastro no Bling. Sem telefone, a linha fica bloqueada com o motivo.
- **Comprovante:** a mensagem de cobrança sai como da equipe, então o bot não responde em cima. A resposta da cliente cai na Inbox com o nome dela, para conferir e dar baixa no Bling. Depois da baixa, o agradecimento aparece em **Pagamentos recebidos**.
- **Histórico:** cada cobrança fica registrada com quem enviou e quando.

Ainda não feito: o **extrato em PDF** com a logo.

## Avisos para a equipe

Na tela **Equipe**, em **Editar**, cada pessoa ganha o WhatsApp dela e escolhe quais avisos recebe. Os avisos mostram só o **nº do pedido e o nome da cliente**:

| Aviso | Quando | Template |
| --- | --- | --- |
| Pedido novo para separar | um pedido entra em Separando (todas as lojas, inclusive TikTok) | `equipe_pedidos_separar` |
| Pedidos parados | uma vez por dia, a partir das 9h: há mais de 1 dia em Separando ou Emitir etiqueta | `equipe_pedidos_parados` |
| Resumo do dia | a partir das 18h: quantos saíram (Enviado/Atendido hoje) e quantos ficaram em andamento | `equipe_resumo_dia` |

Funciona assim:
- Usa a mesma leitura do Bling dos avisos de pedido, a cada 2 min, e funciona **mesmo com os avisos às clientes desligados**.
- Se a tela Avisos de pedido nunca foi salva, as situações são achadas pelo nome no Bling.
- Na primeira leitura, a data da situação vira a **data do pedido**. Por isso, pedido antigo que já estava em Separando aparece como parado.
- Os horários e o botão **Criar templates dos avisos** (Utilidade) ficam no cartão "Avisos para a equipe".

## Relacionamento

Tela **Relacionamento**. Só para quem deu **opt-in** e nunca saiu. Os templates são de Marketing, com o botão "Parar promoções". Cada mensagem é um clique, ou dá para selecionar várias.

| Aba | Quem aparece | Template |
| --- | --- | --- |
| Avaliação | pedido que ficou Atendido há 2 a 7 dias (TikTok e lojas sem aviso ficam fora) | `rel_avaliacao` (nome, nº, link de avaliação) |
| Aniversário | dia e mês de hoje no campo **Data de nascimento** do cadastro no Bling | `rel_aniversario` (nome, presente) |
| Hora de repor | última compra entre 45 e 52 dias atrás (prazo configurável) | `rel_recompra` (nome, link da loja) |

- A data de nascimento e a última compra são lidas no Bling a cada 6 h, para quem tem opt-in (até 150 por vez, e cada contato é relido em 7 dias). Também dá para ler na hora pelo botão. Quem ainda não está vinculado ao Bling é procurado pelo telefone ou CPF.
- A leitura de pedidos também atualiza a última compra.
- Cada mensagem sai uma vez: avaliação por pedido, aniversário por ano, hora de repor por compra.
- **Configurações** (aba): link de avaliação, presente de aniversário, prazo e link da hora de repor, número que envia, **Criar templates sugeridos**.

## Fornecedores

Tela **Fornecedores**:
- **Pedidos de compra** dos últimos 45 dias no Bling, com o fornecedor e o celular do cadastro.
  - **PDF** gera o pedido com a **logo da Oliver** (`apps/api/assets/logo-oliver.png`), itens, totais e observações.
  - **Enviar** manda o PDF pelo template `compra_pedido` (nome do fornecedor, nº, total).
- **Enviar cotação**: escolha o fornecedor no Bling (ou digite nome e WhatsApp) e o PDF baixado do painel (`compras.php` / compra urgente). Vai pelo template `compra_cotacao`.
- O contato fica marcado como **fornecedor**, e a conversa fica com a responsável escolhida (a Ellen). A resposta cai na Inbox com o nome do fornecedor.
- Os 2 templates têm **PDF no cabeçalho**. Para criá-los, a Meta pede um PDF de exemplo, enviado pela API de upload dela: preencha **`META_APP_ID`** no `.env` (developers.facebook.com → seu app → Configurações → Básico).

## Integração com o site (API para o painel PHP)

Tela **Integração com o site** (só administrador). O site e o painel da Hostinger mandam WhatsApp pelo hub e recebem de volta as respostas.

**Chave:** clique em **Gerar chave**. Ela aparece uma vez só; guarde no site. Toda chamada leva o cabeçalho `Authorization: Bearer <chave>`, nunca na URL. Gerar outra chave invalida a anterior.

Endereço: `https://DOMAIN/api/site/v1`. As respostas vêm em JSON, e os erros como `{ "error": "motivo" }`.

| Chamada | Para quê |
| --- | --- |
| `GET /templates` | templates com status, quantidade de variáveis e se pedem anexo |
| `POST /messages` | envia um template (`phone`, `template`, `variables`, `ref` opcional e anexo `attachment.url`/`attachment.base64` para template com PDF/imagem). O mesmo `ref` não envia duas vezes. Marketing só com opt-in |
| `POST /opt-in` | consentimento vindo do site, guardando quando (`at`) e de onde (`source`). Quem mandou SAIR não volta pelo site |
| `GET /opt-outs?since=` | quem pediu para sair |
| `POST /campaigns` | arte de post do painel → campanha em **rascunho** (veja abaixo) |
| `POST /carts`, `POST /carts/{ref}/recovered` | carrinho parado e carrinho que virou pedido |
| `GET /media/{messageId}` | arquivo de uma mensagem recebida (comprovante) |

**Avisos para o site:** em "Avisos para o site", informe a URL do site. Os eventos são `message.received`, `message.status` (dos envios do site, com o `ref`) e `contact.opt_out`.
- O hub faz um POST `{ event, at, data }` com o cabeçalho `X-Oliver-Signature: sha256=<HMAC-SHA256 do corpo com o segredo>`.
- O segredo aparece uma vez, ao salvar a primeira URL.
- Se o site estiver fora do ar, o hub tenta de novo até 5 vezes.
- As últimas entregas aparecem na tela.

**Campanha do painel** (mais vendidos, novidades, Black Friday):
- O painel envia `name`, `text`, `segment` (`varejo` | `atacado` | `todos`), `phones` e `image` (`base64` JPEG/PNG ou `url` https).
- O hub guarda a arte num link público com id aleatório (`/api/public/art/...`), que é de onde a Meta baixa a imagem.
- O público da lista ganha uma etiqueta da campanha e a etiqueta **Varejo**/**Atacado**.
- A campanha é criada em **rascunho** com o template `campanha_arte`: imagem, "Oi, {{1}}! {{2}} Toque em Quero…", botões **Quero** e **Parar promoções**.
- **Só um administrador** inicia, retoma ou edita campanha do painel. A página da campanha mostra a arte e "aguardando aprovação".
- Opt-in, opt-out e frequência são conferidos como em qualquer campanha, e o resultado sai no relatório de sempre.
- O template se cria em Integração → **Criar template da campanha**. Precisa de `META_APP_ID`, porque a Meta pede uma imagem de exemplo; o hub usa a logo.

**Carrinho parado:** o site informa com `POST /carts`. Depois de 1 hora, a cliente com opt-in aparece em **Relacionamento → Carrinho parado** (template `rel_carrinho`: nome, produtos, link) por até 3 dias, ou até o site avisar que virou pedido. Para isso o site precisa guardar o telefone antes de fechar a compra (pergunta em aberto do documento).

## Meta: app, token e webhook

1. **Criar o App**: em developers.facebook.com → *Meus apps* → *Criar app* → tipo **Empresa** → adicione o produto **WhatsApp**.
2. **IDs**: em *WhatsApp → Configuração da API* copie o **Phone number ID** (`META_DEFAULT_PHONE_NUMBER_ID`) e o **WhatsApp Business Account ID** (`META_WABA_ID`).
3. **App Secret**: *Configurações do app → Básico → Chave secreta do app* → `META_APP_SECRET`.
4. **Token permanente**: business.facebook.com → *Configurações → Usuários do sistema* → crie um usuário do sistema (Admin), atribua o App e a conta do WhatsApp, gere um token com `whatsapp_business_messaging` e `whatsapp_business_management`, validade **Nunca** → `META_ACCESS_TOKEN`.
5. **Verify token**: invente um texto (mín. 8 caracteres) → `META_VERIFY_TOKEN`.
6. **Endereço público**: no servidor com o perfil `https`, é `https://DOMAIN`. Para testar no seu computador: com a API na porta 3001, `ngrok http 3001` e copie a URL `https://….ngrok-free.app` (vale até fechar o ngrok).
7. **Webhook**: em *WhatsApp → Configuração* → *Webhook* → URL de callback `https://SUA-URL/webhook`, token de verificação = `META_VERIFY_TOKEN` → *Verificar e salvar*. Depois em *Campos do webhook* assine **messages**, **message_template_status_update** e **phone_number_quality_update**.
8. No `.env`: `META_GRAPH_BASE_URL=https://graph.facebook.com` e reinicie a API.
9. Mande uma mensagem do seu celular para o número da empresa: ela aparece na **Inbox** e o bot responde (ou a resposta de teste, com `BOT_MODE=echo`).
10. **Número de verdade**: para sair do número de teste da Meta, adicione o número da empresa em *WhatsApp → Configuração da API → Adicionar número*, verifique por SMS/ligação e registre-o; depois **Números → Importar da WABA** no painel. O nome de exibição passa pela aprovação da Meta.

## Testes e qualidade

```bash
npm run test
```

```bash
npm run lint && npm run typecheck && npm run build
```

Segurança: vetores oficiais do TOTP (RFC 6238), tolerância de 30 s no relógio, código repetido recusado, desafio de uso único e com 5 tentativas, código de recuperação de uso único, ativar exige senha + código e derruba as outras sessões, desativar exige senha + código, novos códigos invalidam os antigos. Campanhas: estimativa e motivos de exclusão, pré-visualização com contato real, validações (número só de atendimento, janela de madrugada, variáveis), público congelado, ritmo de 1 a cada 3 s, conclusão, fora da janela, agendamento, pausar/retomar/cancelar, duas campanhas revezando no mesmo número, frequência entre campanhas, limite diário, envio de teste, recibos fora de ordem, respostas, opt-out pelo botão, 131050 → opt-out, spam → pausa o número, "desacelere" → espera 1 min, 30% de falhas → pausa, qualidade BAIXA, template pausado pela Meta. Os testes de integração sobem um Postgres real em memória com as migrations reais e Meta, Bling e Claude simulados (o bot é testado com o SDK oficial da Anthropic apontando para o simulado, que recusa o que a API real recusaria: thinking alterado, tool_result sem tool_use, tool_choice forçado). Bot: busca só com estoque, foto, pedido só para o dono, transferência e silêncio depois dela, fora do horário, mensagens seguidas → 1 resposta, 2 tentativas → equipe, erro da API, sem chave, resumo de conversa longa, simulador, base de conhecimento e chave criptografada. Bling: conexão OAuth (state de uso único), renovação de token (inclusive com chamadas simultâneas), 401, 429/5xx com backoff, refresh recusado → alerta, sync incremental, produto que saiu de linha, falha no meio do sync, busca com erro de digitação, pedido só para o dono. Meta: verificação do webhook, assinatura inválida, recebimento + resposta, idempotência (3 entregas → 1 resposta), status sem regressão, falha de entrega, opt-out, conversa com humano, bot desligado, qualidade BAIXA, janela de 24h.

## Checklist final

O comando `npm run checklist` (ou `docker compose run --rm api node dist/scripts/checklist.js` no servidor) confere quase tudo abaixo sozinho.

**`.env`**
- [ ] `ENCRYPTION_KEY` de produção (`openssl rand -base64 32`): **guarde uma cópia em local seguro**
- [ ] `POSTGRES_PASSWORD` (e a mesma senha na `DATABASE_URL`)
- [ ] `SETUP_TOKEN` (código do primeiro acesso ao painel)
- [ ] `DOMAIN` e `ACME_EMAIL` (HTTPS), `PUBLIC_BASE_URL` e `PANEL_URL` com https, `COOKIE_SECURE=true`
- [ ] `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN` (token permanente), `META_WABA_ID`, `META_DEFAULT_PHONE_NUMBER_ID`
- [ ] `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET`, e o link de redirecionamento `https://DOMAIN/api/bling/callback` cadastrado no app do Bling
- [ ] `ANTHROPIC_API_KEY` (ou salvar em Bot de IA → Configurações) e `BOT_MODE=ai`
- [ ] Nenhuma linha apontando para os simulados (`localhost:4010`, `localhost:4020`, `ANTHROPIC_BASE_URL`)

**Meta**
- [ ] Webhook verificado com os campos **messages**, **message_template_status_update** e **phone_number_quality_update**
- [ ] Número real registrado, com nome de exibição aprovado, importado em **Números** e com **Testar envio** funcionando
- [ ] Forma de pagamento cadastrada na conta do WhatsApp Business (conversas de marketing são cobradas pela Meta)
- [ ] Ritmo de cada número em **Números** (padrão 20 mensagens/min; comece baixo em número novo)
- [ ] Templates de marketing aprovados para as campanhas

**Painel**
- [ ] Primeiro acesso criado e **verificação em duas etapas ativada** (códigos de recuperação guardados)
- [ ] Bling conectado e catálogo copiado
- [ ] Contatos importados com **opt-in e origem do consentimento**, e tags para segmentar
- [ ] Frequência de campanhas por cliente (padrão 1 a cada 7 dias)

**Bot (base de conhecimento)**
- [ ] Nome do assistente ("Oli" é só sugestão)
- [ ] Link do site / loja, formas de pagamento, frete e prazo, retirada na loja, política de troca
- [ ] Site, Instagram e TikTok Shop
- [ ] Horário de atendimento humano e feriados (o seed usa seg–sex 9h–18h, sáb 9h–13h só como exemplo)
- [ ] Conversar pelo Simulador e revisar os Registros antes de ligar no WhatsApp
