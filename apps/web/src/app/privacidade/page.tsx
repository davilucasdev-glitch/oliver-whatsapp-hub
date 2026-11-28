import type { Metadata } from 'next';
import { BrandMark } from '@/components/brand';

// Página pública (fora do grupo "(painel)", não pede login): link exigido pela Meta no app do WhatsApp.
export const metadata: Metadata = {
  title: 'Política de Privacidade',
  description: 'Como a Oliver Cosmetics trata os seus dados no atendimento pelo WhatsApp.',
  robots: { index: true, follow: true },
};

const ATUALIZADA_EM = '28 de novembro de 2026';

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-semibold tracking-tight">{titulo}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed opacity-90">{children}</div>
    </section>
  );
}

export default function PrivacidadePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
      <header className="mb-10 flex items-center gap-3">
        <BrandMark />
        <div>
          <p className="text-[11px] uppercase tracking-[0.14em] opacity-60">Oliver Cosmetics</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Política de Privacidade</h1>
        </div>
      </header>

      <div className="space-y-9">
        <p className="text-[15px] leading-relaxed opacity-90">
          Esta política explica como a <strong>Oliver Cosmetics</strong> coleta, usa e protege os seus dados quando você
          conversa com a gente pelo WhatsApp oficial da loja e recebe avisos de pedidos, cobranças e ofertas. Ela segue a
          Lei Geral de Proteção de Dados (Lei nº 13.709/2018 – LGPD).
        </p>

        <Secao titulo="1. Quais dados coletamos">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Contato:</strong> número de WhatsApp e o nome do seu perfil.
            </li>
            <li>
              <strong>Conversas:</strong> as mensagens, fotos, áudios e arquivos que você nos envia (por exemplo, um
              comprovante de pagamento) e as respostas que enviamos.
            </li>
            <li>
              <strong>Compras:</strong> pedidos, produtos, valores, situação da entrega e pagamentos, vindos do nosso
              sistema de gestão (Bling).
            </li>
            <li>
              <strong>Consentimento:</strong> quando e onde você autorizou receber ofertas (site, cadastro ou loja) e se
              pediu para sair.
            </li>
            <li>
              <strong>Dados técnicos de entrega:</strong> se a mensagem foi enviada, entregue ou lida, informados pelo
              WhatsApp.
            </li>
          </ul>
        </Secao>

        <Secao titulo="2. Para que usamos">
          <ul className="list-disc space-y-2 pl-5">
            <li>Responder às suas dúvidas e ajudar na escolha de produtos.</li>
            <li>Avisar sobre o seu pedido (recebido, separado, enviado, entregue) e sobre pagamentos e vencimentos.</li>
            <li>Enviar ofertas e novidades, <strong>somente se você autorizou</strong>.</li>
            <li>Cumprir obrigações legais e fiscais e nos defender em eventuais reclamações.</li>
          </ul>
          <p>
            As bases legais são a execução do contrato de compra, o nosso legítimo interesse em atender bem quem já é
            cliente, o cumprimento de obrigação legal e, para ofertas, o seu consentimento.
          </p>
        </Secao>

        <Secao titulo="3. Atendimento com inteligência artificial">
          <p>
            Parte das respostas é feita por um assistente virtual com inteligência artificial (Claude, da empresa
            Anthropic), que consulta o nosso catálogo e os seus pedidos para responder. O texto da conversa é enviado a
            esse serviço apenas para gerar a resposta. Sempre que precisar, ou se você pedir, a conversa passa para uma
            pessoa da nossa equipe.
          </p>
        </Secao>

        <Secao titulo="4. Com quem compartilhamos">
          <p>Não vendemos os seus dados. Eles são tratados apenas pelos fornecedores necessários para o atendimento:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Meta (WhatsApp Business Platform):</strong> para enviar e receber as mensagens.
            </li>
            <li>
              <strong>Bling:</strong> sistema de gestão onde ficam pedidos, clientes e notas fiscais.
            </li>
            <li>
              <strong>Anthropic:</strong> serviço de inteligência artificial do assistente virtual.
            </li>
            <li>
              <strong>Hospedagem:</strong> o servidor onde o nosso sistema funciona.
            </li>
          </ul>
          <p>Também podemos compartilhar dados quando a lei ou uma autoridade competente exigir.</p>
        </Secao>

        <Secao titulo="5. Ofertas e como parar de receber">
          <p>
            Você só recebe ofertas se tiver autorizado. Para parar a qualquer momento, responda <strong>SAIR</strong> (ou
            &quot;PARAR&quot;) no nosso WhatsApp, ou toque no botão <strong>Parar promoções</strong> da mensagem. O
            descadastro é automático. Avisos sobre os seus pedidos e pagamentos continuam chegando, porque fazem parte da
            compra. Para voltar a receber ofertas, responda <strong>VOLTAR</strong>.
          </p>
        </Secao>

        <Secao titulo="6. Por quanto tempo guardamos">
          <p>
            Guardamos conversas, pedidos e registros de consentimento enquanto você for nosso cliente e pelo prazo exigido
            pela legislação fiscal e de defesa do consumidor. Registros técnicos são apagados automaticamente: eventos de
            entrega do WhatsApp após 90 dias e registros do assistente virtual após 180 dias.
          </p>
        </Secao>

        <Secao titulo="7. Segurança">
          <p>
            O acesso ao sistema é restrito à nossa equipe, com senha forte e verificação em duas etapas. As chaves de
            acesso aos serviços ficam criptografadas, a comunicação usa conexão segura (HTTPS) e fazemos cópias de
            segurança diárias.
          </p>
        </Secao>

        <Secao titulo="8. Seus direitos">
          <p>
            Pela LGPD, você pode pedir a qualquer momento: confirmação de que tratamos os seus dados, acesso a eles,
            correção, exclusão, informação sobre com quem foram compartilhados e a revogação do consentimento. Basta pedir
            pelo nosso WhatsApp oficial. Respondemos em até 15 dias. Você também pode reclamar à Autoridade Nacional de
            Proteção de Dados (ANPD).
          </p>
        </Secao>

        <Secao titulo="9. Contato">
          <p>
            <strong>Oliver Cosmetics</strong>
            <br />
            WhatsApp: o mesmo número oficial em que você fala com a gente.
            <br />
            Instagram:{' '}
            <a
              className="underline underline-offset-2"
              href="https://instagram.com/olivercosmeticsoficial"
              target="_blank"
              rel="noopener noreferrer"
            >
              @olivercosmeticsoficial
            </a>
          </p>
        </Secao>

        <Secao titulo="10. Mudanças nesta política">
          <p>
            Podemos atualizar esta política. A versão em vigor é sempre a publicada nesta página, com a data da última
            atualização abaixo.
          </p>
        </Secao>

        <p className="border-t pt-6 text-sm opacity-60">Última atualização: {ATUALIZADA_EM}.</p>
      </div>
    </main>
  );
}
