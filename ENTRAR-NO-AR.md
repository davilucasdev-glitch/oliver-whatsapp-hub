# Colocar o Oliver Hub no ar (uso real)

Roteiro na ordem. Cada etapa diz **quem faz**. Nas etapas marcadas como suas, só você consegue fazer: elas envolvem contratar, fazer login e aceitar termos. O resto já está pronto no código.

**Tempo:** umas 2 horas de trabalho seu. Depois disso, a aprovação da Meta leva de horas a dias: verificação da empresa, número e templates.

---

## 1. Servidor e endereço (você, ~20 min)

1. **Contratar uma VPS**. Sugestão: Hostinger, plano **KVM 2** (2 núcleos, 8 GB), sistema **Ubuntu 24.04**. Anote o **IP**.
2. **Criar o endereço**. No hPanel → Domínios → `blackfridaydaoliver.com` → DNS, adicione:
   - Tipo **A** · Nome **hub** · Aponta para **o IP da VPS** · TTL padrão.

   O painel fica em `https://hub.blackfridaydaoliver.com`.

## 2. Instalar (você cola 2 comandos, ~15 min)

1. Abra o terminal da VPS. O hPanel → VPS → **Terminal do navegador** serve, ou SSH.
2. Rode:

```bash
curl -fsSL -o instalar.sh https://raw.githubusercontent.com/davilucasdev-glitch/oliver-whatsapp-hub/main/deploy/instalar.sh
```

O repositório é privado, então esse link pede login. Se não funcionar, copie o arquivo `deploy/instalar.sh` para a VPS. Depois:

```bash
sudo bash instalar.sh
```

O instalador:
- instala o Docker e liga o firewall;
- mostra uma chave para colar no GitHub: repositório → Settings → Deploy keys, **sem** acesso de escrita;
- pergunta o endereço (`hub.blackfridaydaoliver.com`) e um e-mail;
- **gera todas as senhas sozinho** e sobe tudo com HTTPS.

No fim, ele mostra:
- o **código de primeiro acesso**;
- a **URL e o token do webhook** da Meta. Guarde esses dois, vão na etapa 4.

## 3. Primeiro acesso e equipe (você, ~10 min)

1. Abra `https://hub.blackfridaydaoliver.com` e crie o acesso com o código do instalador.
2. Em **Segurança**, ligue a verificação em duas etapas.
3. Em **Equipe**, adicione a Ellen, a Duda e a Gabi, com o WhatsApp de cada uma e os avisos que cada uma quer. Ponha o **seu** WhatsApp com "Alertas do sistema" ligado.

## 4. Meta / WhatsApp oficial (você, com a minha ajuda, ~40 min + aprovação)

No [Gerenciador de Negócios](https://business.facebook.com) e em [developers.facebook.com](https://developers.facebook.com):

1. **Verificação da empresa** (CNPJ). Sem ela, o limite de mensagens é baixo.
2. Crie o **app** (tipo Empresa) e adicione o produto **WhatsApp**.
3. **Número**: o atual da loja (coexistência com o app WhatsApp Business, se a conta tiver essa opção) ou um número novo.
4. **Token permanente**: Usuários do sistema → Admin → gerar token com `whatsapp_business_messaging` e `whatsapp_business_management`, validade **Nunca**.
5. **Webhook**: URL e token mostrados pelo instalador. Assine os campos `messages`, `message_template_status_update`, `phone_number_quality_update` e `account_update`.
6. No servidor, preencha no `.env` (`nano /opt/oliver-hub/.env`):
   - `META_ACCESS_TOKEN`
   - `META_APP_SECRET`
   - `META_APP_ID`
   - `META_WABA_ID`
   - `META_DEFAULT_PHONE_NUMBER_ID`

   Depois rode `bash /opt/oliver-hub/deploy/atualizar.sh`.
7. No painel: **Números → Importar da WABA → Testar envio** para o seu celular.

Detalhes de cada tela da Meta: README, seção "Meta: app, token e webhook".

## 5. Bling e IA (você, ~15 min)

1. **Bling**: em developer.bling.com.br, crie um app com os escopos Produtos, Contatos, Pedidos de Venda, Contas a receber e Pedidos de compra. Link de redirecionamento: `https://hub.blackfridaydaoliver.com/api/bling/callback`.
   - Ponha `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET` no `.env` e rode `atualizar.sh`.
   - No painel: **Produtos → Conectar Bling**.
2. **Anthropic** (bot de IA): crie a chave em console.anthropic.com e cole em **Bot de IA → Configurações**, ou em `ANTHROPIC_API_KEY`.

## 6. Templates (você clica, a Meta aprova)

Em cada tela, clique em **Criar templates sugeridos** e espere a aprovação, que aparece sozinha na tela:

| Tela | Templates |
| --- | --- |
| Avisos de pedido | 6 (recebido, separando, retirada, enviado, entregue, cancelado) |
| Cobrança | 4 (lembrete, vence hoje, em aberto, pagamento recebido) |
| Equipe | 4 (pedido para separar, parados, resumo, alerta do sistema) |
| Relacionamento | 4 (avaliação, aniversário, hora de repor, carrinho) |
| Fornecedores | 2 (pedido de compra e cotação, com PDF) |
| Integração com o site | 1 (campanha com a arte) |

## 7. Preencher o que é da Oliver (você, ~20 min)

- **Bot de IA → Base de conhecimento**: os itens `[DEFINIR]` (frete, prazos, trocas, horários...).
- **Avisos de pedido**: endereço e horário da loja (retirada).
- **Cobrança → Configurações**: chave Pix e a Ellen como responsável.
- **Relacionamento → Configurações**: link de avaliação, presente de aniversário e link da loja.
- **Fornecedores**: a Ellen como responsável.

## 8. Testar com o seu número antes das clientes

1. **Avisos de pedido**: preencha o **número de teste**, ligue os avisos e use **Testar com um pedido** com pedidos reais.
2. **Cobrança**: envie um lembrete para você. Confira se o saldo bate com o crediário em 3 clientes, principalmente as que pagaram uma parte.
3. **Site**: siga `painel-hostinger/para-subir/COMO-SUBIR.md`. Ponha a chave do hub no `oliver-privado/config.php` e teste a sacola e a arte de post.
4. Rode `bash /opt/oliver-hub/deploy/conferir.sh`. Ele lista em português o que ainda falta.

## 9. Ligar de verdade

- Apague o **número de teste** dos Avisos de pedido. A partir daí os avisos vão para as clientes.
- Cadastre um monitor gratuito (ex.: UptimeRobot) em `https://hub.blackfridaydaoliver.com/health`, para receber um e-mail se o servidor inteiro cair. Os alertas no WhatsApp não chegam com o servidor fora do ar.

## Dia a dia

| Para | Comando no servidor |
| --- | --- |
| Atualizar (código novo do GitHub) | `bash /opt/oliver-hub/deploy/atualizar.sh` (faz backup antes) |
| Ver o que falta / saúde | `bash /opt/oliver-hub/deploy/conferir.sh` |
| Voltar um backup | `bash /opt/oliver-hub/deploy/restaurar-backup.sh backups/ARQUIVO.sql.gz` |
| Ver erros | `cd /opt/oliver-hub && docker compose logs --tail 100 api` |

- **Backup**: o banco é copiado todo dia para `/opt/oliver-hub/backups`, e cada cópia fica 14 dias.
  - O **`.env` não entra no backup**. Guarde uma cópia dele num lugar seguro: sem a `ENCRYPTION_KEY`, os tokens salvos não podem ser lidos.
  - Para ter cópia fora do servidor, ligue o backup da própria VPS no hPanel.
- **Alertas**: se o Bling desconectar, a leitura de pedidos parar ou o número tiver problema na Meta, os administradores com WhatsApp em Equipe recebem uma mensagem. O alerta também aparece na Visão geral.
- **Registros**: mensagens, avisos, cobranças e consentimentos ficam guardados. Registros técnicos são apagados sozinhos: eventos crus da Meta e entregas ao site após 90 dias, registros do bot após 180 dias.

## Custos mensais (aproximados, confira os preços atuais)

- **VPS**: plano da Hostinger.
- **Meta**: cobra por mensagem iniciada pela empresa (utilidade e marketing têm preços diferentes no Brasil). Respostas dentro de 24 h da mensagem da cliente não são cobradas.
- **Anthropic**: cobra pelo uso do bot de IA. Dá para pôr limite de gasto no console.
